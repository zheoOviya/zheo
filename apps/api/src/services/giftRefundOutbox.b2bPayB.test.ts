import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================
// EVT-B2B-PAY-B3 (G1) — gift mock-refund transactional outbox.
//
// Proves the mock-resolution local tail in submitGiftRefund() — payment ->
// REFUNDED + the gift markRefunded CAS + the single GiftRefunded outbox row —
// runs on ONE PaymentTransactionPort, replaces the former direct emit, and that
// every losing / duplicate / rejected branch commits ZERO outbox rows. The
// refund provider call must stay OUTSIDE the transaction.
//
// MEMORY_MODE = NON_DURABLE_TEST_PARITY: the passthrough port has no rollback
// and no concurrency guarantee, so this file proves control flow, branch
// isolation and direct-emit removal. Real rollback atomicity, the
// reservation-before-provider ordering and the provider-outside-transaction
// boundary are proven against PostgreSQL by
// apps/api/integration/realPgB2bPayBGiftRefund.ts.
// ============================================

import { onEvent } from "../lib/eventBus";
import { MemoryGiftRepository } from "../repositories/giftRepository";
import { memoryEventOutbox } from "../repositories/memoryEventOutbox";
import { MemoryOrderRepository } from "../repositories/orderRepository";
import { MemoryPaymentRepository } from "../repositories/paymentRepository";
import {
  MemoryPaymentTransactionPort,
  type PaymentTransactionPort,
  type PaymentTxRepos,
} from "../repositories/paymentAtomicityContracts";
import { razorpayService } from "./razorpay";
import { submitGiftRefund } from "./gift";

const directEmits: string[] = [];
onEvent("GiftRefunded", async (event) => {
  directEmits.push(event.event_name);
});

const refundRows = () =>
  memoryEventOutbox._all().filter((r) => r.event_name === "GiftRefunded");

/** Wraps the passthrough port purely to observe whether a callback is running. */
class TrackingTxPort implements PaymentTransactionPort {
  inTx = false;
  calls = 0;

  constructor(private readonly inner: PaymentTransactionPort) {}

  runInTransaction<T>(fn: (repos: PaymentTxRepos) => Promise<T>): Promise<T> {
    this.calls += 1;
    return this.inner.runInTransaction(async (repos) => {
      this.inTx = true;
      try {
        return await fn(repos);
      } finally {
        this.inTx = false;
      }
    });
  }
}

/** Throws as soon as a transaction is requested (simulated local-tail failure). */
class FailingTxPort implements PaymentTransactionPort {
  runInTransaction<T>(): Promise<T> {
    return Promise.reject(new Error("g1-force-local-failure"));
  }
}

describe("EVT-B2B-PAY-B3 G1 gift mock-refund transactional outbox", () => {
  let giftRepo: MemoryGiftRepository;
  let paymentRepo: MemoryPaymentRepository;

  beforeEach(() => {
    memoryEventOutbox._reset();
    directEmits.length = 0;
    giftRepo = new MemoryGiftRepository();
    paymentRepo = new MemoryPaymentRepository();
    vi.restoreAllMocks();
  });

  function trackingPort(): TrackingTxPort {
    return new TrackingTxPort(
      new MemoryPaymentTransactionPort(() => ({
        payments: paymentRepo,
        orders: new MemoryOrderRepository(),
        gifts: giftRepo,
        outbox: memoryEventOutbox,
      })),
    );
  }

  async function seedActiveCapturedGift(claimToken: string): Promise<string> {
    const gift = await giftRepo.create({
      sender_id: "11111111-1111-4111-8111-111111111111",
      restaurant_id: "22222222-2222-4222-8222-222222222222",
      menu_item_id: "33333333-3333-4333-8333-333333333333",
      item_snapshot: {
        name: "Samosa",
        price: 30,
        image_url: null,
        dietary_tags: {},
        spice_level: 1,
        customizations: [],
      },
      price_paid: 30,
      message: null,
      recipient_name: null,
      claim_token: claimToken,
      claim_code: "ABC12347",
      expires_at: new Date(Date.now() + 90 * 24 * 3600_000).toISOString(),
    });
    await giftRepo.markPaid(gift.id);
    const payment = await paymentRepo.create({
      gift_id: gift.id,
      razorpay_order_id: `order_${claimToken}`,
      amount: 30,
    });
    await paymentRepo.updateWebhookResult(payment.id, {
      razorpay_payment_id: `pay_${claimToken}`,
      status: "CAPTURED",
      method: "upi",
      webhook_event: "payment.captured",
      webhook_raw: null,
    });
    return gift.id;
  }

  // G1-B2B-1: the happy path commits the whole local tail, stops direct-emitting,
  // and the refund provider runs OUTSIDE the transaction.
  it("G1 success -> one GiftRefunded row, payment+gift REFUNDED, provider outside tx", async () => {
    const giftId = await seedActiveCapturedGift("tok-ok");
    const active = (await giftRepo.getById(giftId))!;
    const port = trackingPort();
    const inTxAtGateway: boolean[] = [];
    const refundSpy = vi.spyOn(razorpayService, "refund").mockImplementation(async () => {
      inTxAtGateway.push(port.inTx);
      return { id: "rfnd_g1", status: "processed" };
    });

    const result = await submitGiftRefund(active, giftRepo, paymentRepo, ["ACTIVE"], port);

    expect(result.status).toBe("REFUNDED");
    expect((await giftRepo.getById(giftId))!.status).toBe("REFUNDED");
    expect((await giftRepo.getById(giftId))!.refund_requested_at).not.toBeNull();
    expect((await paymentRepo.getByGiftId(giftId))!.status).toBe("REFUNDED");

    const rows = refundRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.aggregate_id).toBe(giftId);
    expect(rows[0]?.payload).toMatchObject({ gift_id: giftId, amount: 30 });
    expect(directEmits).toHaveLength(0);

    expect(port.calls).toBe(1);
    expect(refundSpy).toHaveBeenCalledTimes(1);
    expect(inTxAtGateway).toEqual([false]);
  });

  // G1-B2B-2: the expected-state CAS loser (claim wins) commits nothing and
  // never reaches the gateway.
  it("G1 CAS loser -> result CLAIMED, zero rows, provider never called, no direct emit", async () => {
    const giftId = await seedActiveCapturedGift("tok-lose");
    const staleActive = (await giftRepo.getById(giftId))!;
    await giftRepo.markClaimed(giftId, "user-recipient");
    const refundSpy = vi
      .spyOn(razorpayService, "refund")
      .mockResolvedValue({ id: "rfnd_g1", status: "processed" });

    const result = await submitGiftRefund(
      staleActive,
      giftRepo,
      paymentRepo,
      ["ACTIVE"],
      trackingPort(),
    );

    expect(result.status).toBe("CLAIMED");
    expect((await giftRepo.getById(giftId))!.refund_requested_at).toBeNull();
    expect(refundRows()).toHaveLength(0);
    expect(refundSpy).not.toHaveBeenCalled();
    expect(directEmits).toHaveLength(0);
  });

  // G1-B2B-3: an already-reserved submission enqueues nothing and never calls
  // the gateway again.
  it("G1 duplicate submission -> zero rows, provider never called", async () => {
    const giftId = await seedActiveCapturedGift("tok-dup");
    const active = (await giftRepo.getById(giftId))!;
    await giftRepo.markRefundSubmitted(giftId, ["ACTIVE"]);
    const refundSpy = vi
      .spyOn(razorpayService, "refund")
      .mockResolvedValue({ id: "rfnd_g1", status: "processed" });

    const result = await submitGiftRefund(active, giftRepo, paymentRepo, ["ACTIVE"], trackingPort());

    expect(result.status).toBe("REFUNDING");
    expect(refundRows()).toHaveLength(0);
    expect(refundSpy).not.toHaveBeenCalled();
    expect(directEmits).toHaveLength(0);
  });

  // G1-B2B-4: a local-tail failure clears the reservation so a later sweep can
  // retry, and commits no outbox row locally.
  it("G1 local-tail failure -> reservation cleared, zero rows, payment unchanged", async () => {
    const giftId = await seedActiveCapturedGift("tok-fail");
    const active = (await giftRepo.getById(giftId))!;
    vi.spyOn(razorpayService, "refund").mockResolvedValue({
      id: "rfnd_g1",
      status: "processed",
    });

    const result = await submitGiftRefund(
      active,
      giftRepo,
      paymentRepo,
      ["ACTIVE"],
      new FailingTxPort(),
    );

    expect(result.status).toBe("REFUNDING");
    const after = (await giftRepo.getById(giftId))!;
    expect(after.status).toBe("REFUNDING");
    expect(after.refund_requested_at).toBeNull();
    expect((await paymentRepo.getByGiftId(giftId))!.status).toBe("CAPTURED");
    expect(refundRows()).toHaveLength(0);
    expect(directEmits).toHaveLength(0);
  });
});

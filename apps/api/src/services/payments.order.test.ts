import { describe, expect, it, beforeEach, vi } from "vitest";
import { MemoryOrderRepository, type OrderDTO } from "../repositories/orderRepository";
import { MemoryPaymentRepository } from "../repositories/paymentRepository";
import { PaymentService } from "./payments";
import { razorpayService } from "./razorpay";
import type { PriceBreakdown } from "./pricing";

const OWNER_ID = "u00000000-0000-4000-8000-000000000001";
const ATTACKER_ID = "u00000000-0000-4000-8000-000000000099";
const REST_ID = "a0000000-0000-4000-8000-000000000001";

function breakdown(total: number): PriceBreakdown {
  return {
    items: [],
    food_subtotal: 0,
    packaging_fee: 0,
    packaging_fee_per_item: 10,
    gst_food: 0,
    gst_packaging: 0,
    total_amount: total,
    commission_rate: 0,
    commission_amount: 0,
  };
}

describe("PaymentService.createPaymentOrder ownership boundary (Task 3)", () => {
  let orderRepo: MemoryOrderRepository;
  let paymentRepo: MemoryPaymentRepository;
  let service: PaymentService;

  beforeEach(() => {
    orderRepo = new MemoryOrderRepository();
    paymentRepo = new MemoryPaymentRepository();
    service = new PaymentService(paymentRepo, orderRepo);
    orderRepo._reset();
    paymentRepo._reset();
    razorpayService._resetTestState();
  });

  async function seedDraftOrder(): Promise<OrderDTO> {
    return orderRepo.create({
      user_id: OWNER_ID,
      restaurant_id: REST_ID,
      items: [
        {
          menu_item_id: "b0000000-0000-4000-8000-000000000001",
          name: "Chicken Biryani",
          base_price: 220,
          quantity: 1,
          customizations: [],
          customization_total: 0,
          item_subtotal: 220,
          gift_id: null,
        },
      ],
      breakdown: breakdown(242.8),
    });
  }

  it("rejects a foreign caller before any side effect (online)", async () => {
    const order = await seedDraftOrder();
    const createOrderSpy = vi.spyOn(razorpayService, "createOrder");

    await expect(
      service.createPaymentOrder(order.id, ATTACKER_ID, "upi"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(createOrderSpy).not.toHaveBeenCalled();
    expect(await paymentRepo.getByOrderId(order.id)).toBeNull();
    expect((await orderRepo.getById(order.id))?.status).toBe("DRAFT");
    createOrderSpy.mockRestore();
  });

  it("rejects a foreign COD request before confirming the order", async () => {
    const order = await seedDraftOrder();

    await expect(
      service.createPaymentOrder(order.id, ATTACKER_ID, "cod"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(await paymentRepo.getByOrderId(order.id)).toBeNull();
    expect((await orderRepo.getById(order.id))?.status).toBe("DRAFT");
  });

  it("does not leak another user's order state to a foreign caller", async () => {
    const order = await seedDraftOrder();
    await orderRepo.updateStatus(order.id, "CONFIRMED");

    await expect(
      service.createPaymentOrder(order.id, ATTACKER_ID, "upi"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("owner online payment still succeeds", async () => {
    const order = await seedDraftOrder();
    const result = await service.createPaymentOrder(order.id, OWNER_ID, "upi");
    expect(result.razorpay_order_id).toMatch(/^order_mock_/);
    expect((await orderRepo.getById(order.id))?.status).toBe("PAYMENT_PENDING");
    expect(await paymentRepo.getByOrderId(order.id)).not.toBeNull();
  });

  it("owner COD still succeeds", async () => {
    const order = await seedDraftOrder();
    const result = await service.createPaymentOrder(order.id, OWNER_ID, "cod");
    expect(result.payment_method).toBe("cod");
    expect((await orderRepo.getById(order.id))?.status).toBe("CONFIRMED");
    expect(await paymentRepo.getByOrderId(order.id)).not.toBeNull();
  });

  it("nonexistent order remains 404", async () => {
    await expect(
      service.createPaymentOrder("00000000-0000-4000-8000-000000000099", OWNER_ID, "upi"),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
  });

  it("non-DRAFT own order keeps the existing 400 behavior", async () => {
    const order = await seedDraftOrder();
    await orderRepo.updateStatus(order.id, "CONFIRMED");
    await expect(service.createPaymentOrder(order.id, OWNER_ID, "upi")).rejects.toMatchObject({
      code: "ORDER_NOT_DRAFT",
    });
  });
});

describe("PaymentService.createPaymentOrder concurrency (Model A)", () => {
  let orderRepo: MemoryOrderRepository;
  let paymentRepo: MemoryPaymentRepository;
  let service: PaymentService;

  beforeEach(() => {
    orderRepo = new MemoryOrderRepository();
    paymentRepo = new MemoryPaymentRepository();
    service = new PaymentService(paymentRepo, orderRepo);
    orderRepo._reset();
    paymentRepo._reset();
    razorpayService._resetTestState();
  });

  async function seedDraftOrder(): Promise<OrderDTO> {
    return orderRepo.create({
      user_id: OWNER_ID,
      restaurant_id: REST_ID,
      items: [
        {
          menu_item_id: "b0000000-0000-4000-8000-000000000001",
          name: "Chicken Biryani",
          base_price: 220,
          quantity: 1,
          customizations: [],
          customization_total: 0,
          item_subtotal: 220,
          gift_id: null,
        },
      ],
      breakdown: breakdown(242.8),
    });
  }

  it("first-create race mints exactly ONE provider order and ONE intent", async () => {
    const order = await seedDraftOrder();
    const [a, b] = await Promise.allSettled([
      service.createPaymentOrder(order.id, OWNER_ID, "upi"),
      service.createPaymentOrder(order.id, OWNER_ID, "upi"),
    ]);

    const settled = [a, b].filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof service.createPaymentOrder>>> =>
        r.status === "fulfilled",
    );
    expect(settled.length).toBeGreaterThanOrEqual(1);
    expect(razorpayService.createOrderCount).toBe(1);
    const rows = (await paymentRepo.getAll()).filter((p) => p.order_id === order.id);
    expect(rows.length).toBe(1);
    const ids = new Set(
      settled.map((r) => r.value.razorpay_order_id).filter((x): x is string => Boolean(x)),
    );
    expect(ids.size).toBe(1);
    expect((await orderRepo.getById(order.id))?.status).toBe("PAYMENT_PENDING");
  });

  it("mixed ONLINE vs COD race: exactly one method wins, no double-confirm", async () => {
    const order = await seedDraftOrder();
    const [online, cod] = await Promise.allSettled([
      service.createPaymentOrder(order.id, OWNER_ID, "upi"),
      service.createPaymentOrder(order.id, OWNER_ID, "cod"),
    ]);

    const rows = (await paymentRepo.getAll()).filter((p) => p.order_id === order.id);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    const finalOrder = (await orderRepo.getById(order.id))!;

    if (online.status === "fulfilled" && online.value.razorpay_order_id) {
      // Online won: the COD callers must not have confirmed the order.
      expect(row.method).not.toBe("cod");
      expect(finalOrder.status).toBe("PAYMENT_PENDING");
      expect(razorpayService.createOrderCount).toBe(1);
    } else {
      // COD won: order confirmed, no online provider order may exist for it.
      expect(row.method).toBe("cod");
      expect(finalOrder.status).toBe("CONFIRMED");
      expect(razorpayService.createOrderCount).toBe(0);
    }
  });

  it("retry after a FAILED payment attempt reuses the same provider order (Model A)", async () => {
    const order = await seedDraftOrder();
    const first = await service.createPaymentOrder(order.id, OWNER_ID, "upi");
    const failed = razorpayService.buildMockWebhook(first.razorpay_order_id!, 24280, "payment.failed");
    await service.processWebhook(failed.rawBody, failed.signature);
    expect((await orderRepo.getById(order.id))?.status).toBe("PAYMENT_FAILED");

    const retry = await service.createPaymentOrder(order.id, OWNER_ID, "upi");
    expect(retry.razorpay_order_id).toBe(first.razorpay_order_id);
    expect(retry.payment_id).toBe(first.payment_id);
    expect(razorpayService.createOrderCount).toBe(1);
  });

  it("captures exactly-once: duplicate captured webhooks are idempotent", async () => {
    const order = await seedDraftOrder();
    const created = await service.createPaymentOrder(order.id, OWNER_ID, "upi");
    const webhook = razorpayService.buildMockWebhook(created.razorpay_order_id!, 24280, "payment.captured");

    const first = await service.processWebhook(webhook.rawBody, webhook.signature);
    expect(first.processed).toBe(true);
    expect(first.orderStatus).toBe("CONFIRMED");

    const dup = await service.processWebhook(webhook.rawBody, webhook.signature);
    expect(dup.idempotent).toBe(true);
    expect((await orderRepo.getById(order.id))?.status).toBe("CONFIRMED");
    const payment = await paymentRepo.getByOrderId(order.id);
    expect(payment?.attempts.filter((a) => a.razorpay_payment_id === webhook.payload.payload.payment.entity.id).length).toBe(1);
  });

  it("late payment.failed after capture never regresses the order (monotonic)", async () => {
    const order = await seedDraftOrder();
    const created = await service.createPaymentOrder(order.id, OWNER_ID, "upi");
    const captured = razorpayService.buildMockWebhook(created.razorpay_order_id!, 24280, "payment.captured");
    await service.processWebhook(captured.rawBody, captured.signature);

    const lateFailed = razorpayService.buildMockWebhook(created.razorpay_order_id!, 24280, "payment.failed");
    const late = await service.processWebhook(lateFailed.rawBody, lateFailed.signature);
    expect(late.idempotent).toBe(true);
    expect((await orderRepo.getById(order.id))?.status).toBe("CONFIRMED");
    const payment = await paymentRepo.getByOrderId(order.id);
    expect(payment?.status).toBe("CAPTURED");
  });

  it("rejects switching to COD when an online intent already exists", async () => {
    const order = await seedDraftOrder();
    // Crash-window simulation: an online intent was finalized but the order
    // never left DRAFT. COD must refuse rather than layer on top.
    await paymentRepo._seedFinalized({
      order_id: order.id,
      razorpay_order_id: "order_mock_existing_online",
      amount: 242.8,
    });
    await expect(service.createPaymentOrder(order.id, OWNER_ID, "cod")).rejects.toMatchObject({
      code: "PAYMENT_METHOD_CONFLICT",
    });
  });

  it("rejects an online intent layered on top of a COD-confirmed order", async () => {
    const order = await seedDraftOrder();
    const cod = await service.createPaymentOrder(order.id, OWNER_ID, "cod");
    // The order is claimed by COD: an online intent cannot be layered on top.
    await expect(service.createPaymentOrder(order.id, OWNER_ID, "upi")).rejects.toMatchObject({
      code: "PAYMENT_METHOD_CONFLICT",
    });
    // The COD intent is untouched — still the single canonical row, still COD.
    const payment = await paymentRepo.getByOrderId(order.id);
    expect(payment?.id).toBe(cod.payment_id);
    expect(payment?.method).toBe("cod");
    expect((await orderRepo.getById(order.id))?.status).toBe("CONFIRMED");
  });

  it("payment.authorized webhook never fails the order (classification fix)", async () => {
    const order = await seedDraftOrder();
    const created = await service.createPaymentOrder(order.id, OWNER_ID, "upi");
    const auth = razorpayService.buildMockWebhook(
      created.razorpay_order_id!,
      24280,
      "payment.authorized",
    );
    const result = await service.processWebhook(auth.rawBody, auth.signature);
    expect(result.idempotent).toBe(false);
    const payment = await paymentRepo.getByOrderId(order.id);
    expect(payment?.status).toBe("AUTHORIZED");
    expect(payment?.razorpay_payment_id).toBe(auth.payload.payload.payment.entity.id);
    // Order waits for the capture webhook; it must NOT be marked failed.
    expect((await orderRepo.getById(order.id))?.status).toBe("PAYMENT_PENDING");
  });

  it("recovery: captured webhook after a failed-first attempt confirms the order (unstrand)", async () => {
    const order = await seedDraftOrder();
    const created = await service.createPaymentOrder(order.id, OWNER_ID, "upi");
    const failed = razorpayService.buildMockWebhook(created.razorpay_order_id!, 24280, "payment.failed");
    await service.processWebhook(failed.rawBody, failed.signature);
    expect((await orderRepo.getById(order.id))?.status).toBe("PAYMENT_FAILED");

    // Late/retried capture of the same provider order must still confirm.
    const captured = razorpayService.buildMockWebhook(created.razorpay_order_id!, 24280, "payment.captured");
    await service.processWebhook(captured.rawBody, captured.signature);
    expect((await orderRepo.getById(order.id))?.status).toBe("CONFIRMED");
    const payment = await paymentRepo.getByOrderId(order.id);
    expect(payment?.status).toBe("CAPTURED");
  });

  it("blocks COD while an online initiation holds an EXPIRED lease", async () => {
    const order = await seedDraftOrder();
    // Active online initiation, lease expired but never finalized.
    await paymentRepo._seedFinalized({
      order_id: order.id,
      razorpay_order_id: null,
      amount: 242.8,
      status: "INITIATING",
      method: null,
      lease_owner: "other-instance-1",
      lease_expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    // COD must not take over a still-active online initiation even when its
    // lease has expired — the online process may be mid-gateway.
    await expect(service.createPaymentOrder(order.id, OWNER_ID, "cod")).rejects.toMatchObject({
      code: "PAYMENT_METHOD_CONFLICT",
    });
  });

  it("does not hand out a live razorpay_order_id on a settled CONFIRMED order (fast path)", async () => {
    const order = await seedDraftOrder();
    const created = await service.createPaymentOrder(order.id, OWNER_ID, "upi");
    const captured = razorpayService.buildMockWebhook(created.razorpay_order_id!, 24280, "payment.captured");
    await service.processWebhook(captured.rawBody, captured.signature);
    expect((await orderRepo.getById(order.id))?.status).toBe("CONFIRMED");

    // Re-initiation must be refused: returning the chargeable order id would
    // let a second gateway attempt double-charge the settled intent.
    await expect(service.createPaymentOrder(order.id, OWNER_ID, "upi")).rejects.toMatchObject({
      code: "ORDER_NOT_DRAFT",
    });
  });
});

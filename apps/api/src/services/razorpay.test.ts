import { beforeEach, describe, expect, it } from "vitest";
import {
  UNKNOWN_CURRENCY,
  isRazorpayMockMode,
  isRazorpayReadError,
  normalizePayment,
  normalizeRefund,
  RazorpayReadError,
  RazorpayService,
} from "./razorpay";

// PAYMENT_RECONCILIATION-B1: gateway truth reads must be coherent offline (mock
// mode) and must distinguish "unknown entity" (null) from "infrastructure
// failure" (RazorpayReadError). Tests never touch the network.
describe("RazorpayService gateway truth reads (PAYMENT_RECONCILIATION-B1)", () => {
  let service: RazorpayService;

  beforeEach(() => {
    service = new RazorpayService();
  });

  it("runs offline in tests and never touches the network", () => {
    expect(isRazorpayMockMode()).toBe(true);
  });

  it("fetchOrder returns created order truth and null for unknown", async () => {
    const order = await service.createOrder(10000, "rcpt-rc");

    expect(await service.fetchOrder(order.id)).toEqual({
      id: order.id,
      amount: 10000,
      amount_paid: 0,
      currency: "INR",
      status: "created",
    });
    expect(await service.fetchOrder("order_missing")).toBeNull();
  });

  it("fetchPayment/fetchPaymentsForOrder expose captured truth", async () => {
    const order = await service.createOrder(10000, "rcpt-rc");
    const { payload } = service.buildMockWebhook(order.id, 10000, "payment.captured");
    const paymentId = payload.payload.payment.entity.id;

    expect(await service.fetchPayment(paymentId)).toEqual({
      id: paymentId,
      order_id: order.id,
      amount: 10000,
      currency: "INR",
      status: "captured",
      captured: true,
      method: "upi",
    });
    expect(await service.fetchPaymentsForOrder(order.id)).toHaveLength(1);
    expect(await service.fetchPayment("pay_missing")).toBeNull();
    expect(await service.fetchPaymentsForOrder("order_missing")).toEqual([]);
  });

  it("refund() records a processed refund the read APIs can observe", async () => {
    const order = await service.createOrder(10000, "rcpt-rc");
    const { payload } = service.buildMockWebhook(order.id, 10000, "payment.captured");
    const paymentId = payload.payload.payment.entity.id;

    const refund = await service.refund(paymentId, 10000);

    expect(await service.fetchRefund(refund.id)).toMatchObject({
      id: refund.id,
      payment_id: paymentId,
      amount: 10000,
      currency: "INR",
      status: "processed",
    });
    expect(await service.fetchRefundsForPayment(paymentId)).toHaveLength(1);
    expect(await service.fetchRefund("refund_missing")).toBeNull();
    expect(await service.fetchRefundsForPayment("pay_missing")).toEqual([]);
  });

  it("distinguishes an unknown entity (null) from an infrastructure failure", () => {
    const err = new RazorpayReadError("provider", 502, "bad gateway");
    expect(isRazorpayReadError(err)).toBe(true);
    expect(err.failure).toBe("provider");
    expect(err.status).toBe(502);
    expect(isRazorpayReadError(new Error("x"))).toBe(false);
    expect(isRazorpayReadError(null)).toBe(false);

    const network = new RazorpayReadError("network", null, "timeout");
    expect(isRazorpayReadError(network)).toBe(true);
    expect(network.status).toBeNull();
  });
});

// PAYMENT_RECONCILIATION-B1R: a missing or invalid provider currency must never
// be defaulted to "INR" — that would let malformed payloads pass the PAY-4
// integrity predicate. Fail closed to an explicit non-valid sentinel.
describe("provider currency normalization fails closed (PAYMENT_RECONCILIATION-B1R)", () => {
  it("R25 missing payment currency is never normalized to INR", () => {
    const entity = normalizePayment({
      id: "pay_x",
      order_id: "order_x",
      amount: 10000,
      status: "captured",
      captured: true,
      method: "upi",
    });
    expect(entity.currency).toBe(UNKNOWN_CURRENCY);
    expect(entity.currency).not.toBe("INR");
  });

  it("R26 missing refund currency is never normalized to INR", () => {
    const entity = normalizeRefund({
      id: "refund_x",
      payment_id: "pay_x",
      amount: 10000,
      status: "processed",
    });
    expect(entity.currency).toBe(UNKNOWN_CURRENCY);
    expect(entity.currency).not.toBe("INR");
  });

  it("preserves a valid provider currency verbatim", () => {
    expect(normalizePayment({ currency: "USD" }).currency).toBe("USD");
    expect(normalizeRefund({ currency: "inr" }).currency).toBe("inr");
  });
});

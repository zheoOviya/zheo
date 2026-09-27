import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { onEvent } from "../lib/eventBus";
import { jwtService } from "../services/jwt";
import { razorpayService } from "../services/razorpay";
import { PaymentService } from "../services/payments";
import { sharedOrderRepo } from "../repositories/shared";
import { sharedPaymentRepo } from "../repositories/shared";
import { sharedGiftRepo } from "../repositories/shared";

const REST_ID = "a0000000-0000-4000-8000-000000000001";
const MENU_ITEM_1 = "b0000000-0000-4000-8000-000000000001";

function authHeaders(userId?: string) {
  return {
    Authorization: `Bearer ${jwtService.signAccessToken({
      sub: userId ?? "u00000000-0000-4000-8000-000000000001",
      phone: "+919876543210",
      role: "CONSUMER",
      device_fingerprint: "fp_test_device_abc1234",
    })}`,
  };
}

async function createDraftOrder(app: Express): Promise<{ orderId: string; totalAmount: number }> {
  const res = await request(app)
    .post("/api/v1/orders")
    .set(authHeaders())
    .send({
      restaurant_id: REST_ID,
      items: [{ menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [] }],
    })
    .expect(201);

  return { orderId: res.body.data.id, totalAmount: res.body.data.total_amount };
}

describe("Payments routes", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    sharedOrderRepo._reset();
    sharedPaymentRepo._reset();
    sharedGiftRepo._reset();
    app = createApp();
  });

  describe("POST /api/v1/payments/create-order", () => {
    it("creates a Razorpay order and transitions order to PAYMENT_PENDING", async () => {
      const { orderId } = await createDraftOrder(app);

      const res = await request(app)
        .post("/api/v1/payments/create-order")
        .set(authHeaders())
        .send({ order_id: orderId })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.razorpay_order_id).toMatch(/^order_mock_/);
      expect(res.body.data.amount).toBe(242.8);
      expect(res.body.data.currency).toBe("INR");

      const order = await sharedOrderRepo.getById(orderId);
      expect(order?.status).toBe("PAYMENT_PENDING");
    });

    it("returns 404 for nonexistent order", async () => {
      const res = await request(app)
        .post("/api/v1/payments/create-order")
        .set(authHeaders())
        .send({ order_id: "00000000-0000-4000-8000-000000000099" })
        .expect(404);

      expect(res.body.error.code).toBe("ORDER_NOT_FOUND");
    });

    it("returns 400 when order is not in DRAFT state", async () => {
      const { orderId } = await createDraftOrder(app);
      await sharedOrderRepo.updateStatus(orderId, "CONFIRMED");

      const res = await request(app)
        .post("/api/v1/payments/create-order")
        .set(authHeaders())
        .send({ order_id: orderId })
        .expect(400);

      expect(res.body.error.code).toBe("ORDER_NOT_DRAFT");
    });

    it("requires authentication", async () => {
      const res = await request(app)
        .post("/api/v1/payments/create-order")
        .send({ order_id: "00000000-0000-4000-8000-000000000099" })
        .expect(401);

      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });

    it("supports Cash on Pickup (COD): confirms order without a gateway", async () => {
      const { orderId } = await createDraftOrder(app);

      const res = await request(app)
        .post("/api/v1/payments/create-order")
        .set(authHeaders())
        .send({ order_id: orderId, method: "cod" })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.payment_method).toBe("cod");
      expect(res.body.data.razorpay_order_id).toBeUndefined();
      expect(res.body.data.amount).toBe(242.8);
      expect(res.body.data.currency).toBe("INR");

      const order = await sharedOrderRepo.getById(orderId);
      expect(order?.status).toBe("CONFIRMED");
    });

    it("records the selected online method while keeping the Razorpay order", async () => {
      const { orderId } = await createDraftOrder(app);

      const res = await request(app)
        .post("/api/v1/payments/create-order")
        .set(authHeaders())
        .send({ order_id: orderId, method: "netbanking" })
        .expect(200);

      expect(res.body.data.payment_method).toBe("netbanking");
      expect(res.body.data.razorpay_order_id).toMatch(/^order_mock_/);
    });

    it("rejects an unknown payment method", async () => {
      const { orderId } = await createDraftOrder(app);

      const res = await request(app)
        .post("/api/v1/payments/create-order")
        .set(authHeaders())
        .send({ order_id: orderId, method: "bitcoin" })
        .expect(400);

      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("POST /api/v1/payments/create-order (ownership / RISK-PAY-5)", () => {
    const FOREIGN_USER = "u00000000-0000-4000-8000-000000000002";

    it("P1: owner can create an online payment", async () => {
      const { orderId } = await createDraftOrder(app);

      const res = await request(app)
        .post("/api/v1/payments/create-order")
        .set(authHeaders())
        .send({ order_id: orderId })
        .expect(200);

      expect(res.body.data.razorpay_order_id).toMatch(/^order_mock_/);
      expect((await sharedOrderRepo.getById(orderId))?.status).toBe("PAYMENT_PENDING");
    });

    it("P2: foreign consumer cannot create an online payment for the owner's order", async () => {
      const { orderId } = await createDraftOrder(app);

      const res = await request(app)
        .post("/api/v1/payments/create-order")
        .set(authHeaders(FOREIGN_USER))
        .send({ order_id: orderId })
        .expect(404);

      expect(res.body.error.code).toBe("ORDER_NOT_FOUND");
    });

    it("P3: foreign consumer cannot select COD for the owner's order", async () => {
      const { orderId } = await createDraftOrder(app);

      const res = await request(app)
        .post("/api/v1/payments/create-order")
        .set(authHeaders(FOREIGN_USER))
        .send({ order_id: orderId, method: "cod" })
        .expect(404);

      expect(res.body.error.code).toBe("ORDER_NOT_FOUND");
    });

    it("P4: denied online attempt leaves order DRAFT and creates no payment record", async () => {
      const { orderId } = await createDraftOrder(app);

      await request(app)
        .post("/api/v1/payments/create-order")
        .set(authHeaders(FOREIGN_USER))
        .send({ order_id: orderId })
        .expect(404);

      expect(await sharedPaymentRepo.getByOrderId(orderId)).toBeNull();
      expect((await sharedOrderRepo.getById(orderId))?.status).toBe("DRAFT");
    });

    it("P5: denied COD attempt leaves order DRAFT, no payment, no CashOnPickupSelected event", async () => {
      const { orderId } = await createDraftOrder(app);
      const captured: string[] = [];
      onEvent("CashOnPickupSelected", async () => {
        captured.push("CashOnPickupSelected");
      });

      await request(app)
        .post("/api/v1/payments/create-order")
        .set(authHeaders(FOREIGN_USER))
        .send({ order_id: orderId, method: "cod" })
        .expect(404);

      expect(await sharedPaymentRepo.getByOrderId(orderId)).toBeNull();
      expect((await sharedOrderRepo.getById(orderId))?.status).toBe("DRAFT");
      expect(captured).toEqual([]);
    });

    it("P6: unauthenticated request remains 401", async () => {
      const { orderId } = await createDraftOrder(app);

      const res = await request(app)
        .post("/api/v1/payments/create-order")
        .send({ order_id: orderId })
        .expect(401);

      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });

    it("P7: foreign denial precedes the DRAFT check (foreign CONFIRMED order is 404, not 400)", async () => {
      const { orderId } = await createDraftOrder(app);
      await sharedOrderRepo.updateStatus(orderId, "CONFIRMED");

      const res = await request(app)
        .post("/api/v1/payments/create-order")
        .set(authHeaders(FOREIGN_USER))
        .send({ order_id: orderId })
        .expect(404);

      expect(res.body.error.code).toBe("ORDER_NOT_FOUND");
    });
  });

  describe("Amount integrity (RISK-PAY-4)", () => {
    const giftService = new PaymentService(sharedPaymentRepo, sharedOrderRepo, sharedGiftRepo);

    function postWebhook(payload: unknown, signature: string) {
      return request(app)
        .post("/api/v1/payments/webhook")
        .set("X-Razorpay-Signature", signature)
        .set("Content-Type", "application/json")
        .send(payload as object);
    }

    async function createOnlineOrderPayment(orderId: string, amountPaise: number) {
      const createRes = await request(app)
        .post("/api/v1/payments/create-order")
        .set(authHeaders())
        .send({ order_id: orderId })
        .expect(200);
      const rpOrderId = createRes.body.data.razorpay_order_id as string;
      const mock = razorpayService.buildMockWebhook(rpOrderId, amountPaise, "payment.captured");
      return { rpOrderId, mock };
    }

    async function createPendingGift(pricePaid: number) {
      return sharedGiftRepo.create({
        sender_id: "u00000000-0000-4000-8000-000000000001",
        restaurant_id: REST_ID,
        menu_item_id: MENU_ITEM_1,
        item_snapshot: {
          name: "Gift Item",
          price: pricePaid,
          image_url: null,
          dietary_tags: {},
          spice_level: 1,
          customizations: [],
        },
        price_paid: pricePaid,
        message: null,
        recipient_name: null,
        claim_token: `tok-${Math.random().toString(36).slice(2)}`,
        claim_code: "GIFT1234",
        expires_at: new Date(Date.now() + 90 * 24 * 3600_000).toISOString(),
      });
    }

    async function makeCapturedGift(pricePaid: number) {
      const gift = await createPendingGift(pricePaid);
      const pay = await giftService.createGiftPayment(gift.id);
      const captured = razorpayService.buildMockWebhook(
        pay.razorpay_order_id,
        pricePaid * 100,
        "payment.captured",
      );
      await giftService.processWebhook(captured.rawBody, captured.signature);
      return {
        gift,
        paymentId: captured.payload.payload.payment.entity.id,
        paidPaise: pricePaid * 100,
      };
    }

    it("C1: valid order capture amount + INR -> CAPTURED / CONFIRMED", async () => {
      const { orderId, totalAmount } = await createDraftOrder(app);
      const amountPaise = Math.round(totalAmount * 100);
      const { rpOrderId, mock } = await createOnlineOrderPayment(orderId, amountPaise);

      await postWebhook(mock.payload, mock.signature).expect(200);

      expect((await sharedOrderRepo.getById(orderId))?.status).toBe("CONFIRMED");
      expect((await sharedPaymentRepo.findByRazorpayOrderId(rpOrderId))?.status).toBe("CAPTURED");
    });

    it("C2: order under-capture -> FAILED / order PAYMENT_PENDING / no success event", async () => {
      const { orderId, totalAmount } = await createDraftOrder(app);
      const amountPaise = Math.round(totalAmount * 100);
      const events: string[] = [];
      onEvent("PaymentSucceeded", async () => {
        events.push("PaymentSucceeded");
      });
      const { rpOrderId, mock } = await createOnlineOrderPayment(orderId, amountPaise - 100);

      const res = await postWebhook(mock.payload, mock.signature).expect(200);
      expect(res.body.data.processed).toBe(false);

      const payment = await sharedPaymentRepo.findByRazorpayOrderId(rpOrderId);
      expect(payment?.status).toBe("FAILED");
      expect(payment?.razorpay_payment_id).not.toBeNull();
      expect(payment?.webhook_raw).not.toBeNull();
      expect((await sharedOrderRepo.getById(orderId))?.status).toBe("PAYMENT_PENDING");
      expect(events).toEqual([]);
    });

    it("C3: order over-capture -> FAILED / order PAYMENT_PENDING / no success event", async () => {
      const { orderId, totalAmount } = await createDraftOrder(app);
      const amountPaise = Math.round(totalAmount * 100);
      const events: string[] = [];
      onEvent("PaymentSucceeded", async () => {
        events.push("PaymentSucceeded");
      });
      const { rpOrderId, mock } = await createOnlineOrderPayment(orderId, amountPaise + 100);

      await postWebhook(mock.payload, mock.signature).expect(200);

      expect((await sharedPaymentRepo.findByRazorpayOrderId(rpOrderId))?.status).toBe("FAILED");
      expect((await sharedOrderRepo.getById(orderId))?.status).toBe("PAYMENT_PENDING");
      expect(events).toEqual([]);
    });

    it("C4: wrong currency -> FAILED / order PAYMENT_PENDING / no success event", async () => {
      const { orderId, totalAmount } = await createDraftOrder(app);
      const amountPaise = Math.round(totalAmount * 100);
      const events: string[] = [];
      onEvent("PaymentSucceeded", async () => {
        events.push("PaymentSucceeded");
      });
      const { rpOrderId, mock } = await createOnlineOrderPayment(orderId, amountPaise);
      mock.payload.payload.payment.entity.currency = "USD";

      await postWebhook(mock.payload, mock.signature).expect(200);

      expect((await sharedPaymentRepo.findByRazorpayOrderId(rpOrderId))?.status).toBe("FAILED");
      expect((await sharedOrderRepo.getById(orderId))?.status).toBe("PAYMENT_PENDING");
      expect(events).toEqual([]);
    });

    it("C5: persisted payment amount disagreeing with order total -> quarantined", async () => {
      const { orderId } = await createDraftOrder(app);
      await sharedPaymentRepo.create({
        order_id: orderId,
        razorpay_order_id: "order_manual_c5",
        amount: 100,
      });
      const mock = razorpayService.buildMockWebhook("order_manual_c5", 10000, "payment.captured");

      const res = await postWebhook(mock.payload, mock.signature).expect(200);

      expect(res.body.data.processed).toBe(false);
      expect((await sharedPaymentRepo.findByRazorpayOrderId("order_manual_c5"))?.status).toBe("FAILED");
      expect((await sharedOrderRepo.getById(orderId))?.status).toBe("DRAFT");
    });

    it("C6: later valid different payment_id after mismatched capture succeeds", async () => {
      const { orderId, totalAmount } = await createDraftOrder(app);
      const amountPaise = Math.round(totalAmount * 100);
      const { rpOrderId, mock: bad } = await createOnlineOrderPayment(orderId, amountPaise - 100);

      await postWebhook(bad.payload, bad.signature).expect(200);
      expect((await sharedOrderRepo.getById(orderId))?.status).toBe("PAYMENT_PENDING");

      const good = razorpayService.buildMockWebhook(rpOrderId, amountPaise, "payment.captured");
      expect(good.payload.payload.payment.entity.id).not.toBe(
        bad.payload.payload.payment.entity.id,
      );

      await postWebhook(good.payload, good.signature).expect(200);

      expect((await sharedOrderRepo.getById(orderId))?.status).toBe("CONFIRMED");
      const payment = await sharedPaymentRepo.findByRazorpayOrderId(rpOrderId);
      expect(payment?.status).toBe("CAPTURED");
      expect(payment?.razorpay_payment_id).toBe(good.payload.payload.payment.entity.id);
    });

    it("C7: gift under/over capture -> payment FAILED / gift unchanged / no GiftPaid", async () => {
      const gift = await createPendingGift(30);
      const pay = await giftService.createGiftPayment(gift.id);
      const events: string[] = [];
      onEvent("GiftPaid", async () => {
        events.push("GiftPaid");
      });

      const under = razorpayService.buildMockWebhook(pay.razorpay_order_id, 2900, "payment.captured");
      await postWebhook(under.payload, under.signature).expect(200);
      expect((await sharedGiftRepo.getById(gift.id))?.status).toBe("PENDING");
      expect((await sharedPaymentRepo.findByRazorpayOrderId(pay.razorpay_order_id))?.status).toBe(
        "FAILED",
      );

      const over = razorpayService.buildMockWebhook(pay.razorpay_order_id, 3100, "payment.captured");
      await postWebhook(over.payload, over.signature).expect(200);
      expect((await sharedGiftRepo.getById(gift.id))?.status).toBe("PENDING");
      expect((await sharedPaymentRepo.findByRazorpayOrderId(pay.razorpay_order_id))?.status).toBe(
        "FAILED",
      );
      expect(events).toEqual([]);
    });

    it("R1: full refund of CAPTURED payment with exact amount -> REFUNDED", async () => {
      const { orderId, totalAmount } = await createDraftOrder(app);
      const amountPaise = Math.round(totalAmount * 100);
      const { rpOrderId, mock } = await createOnlineOrderPayment(orderId, amountPaise);
      await postWebhook(mock.payload, mock.signature).expect(200);
      const paymentId = mock.payload.payload.payment.entity.id;

      const refund = razorpayService.buildMockRefundWebhook(paymentId, amountPaise);
      const res = await postWebhook(refund.payload, refund.signature).expect(200);

      expect(res.body.data.processed).toBe(true);
      expect((await sharedOrderRepo.getById(orderId))?.status).toBe("REFUNDED");
      expect((await sharedPaymentRepo.findByRazorpayOrderId(rpOrderId))?.status).toBe("REFUNDED");
    });

    it("R2: partial refund rejected (payment stays CAPTURED, gift unchanged)", async () => {
      const { gift, paymentId, paidPaise } = await makeCapturedGift(30);
      const events: string[] = [];
      onEvent("GiftRefunded", async () => {
        events.push("GiftRefunded");
      });

      const refund = razorpayService.buildMockRefundWebhook(paymentId, paidPaise - 100);
      const res = await postWebhook(refund.payload, refund.signature).expect(200);

      expect(res.body.data.processed).toBe(false);
      expect((await sharedPaymentRepo.findByRazorpayPaymentId(paymentId))?.status).toBe("CAPTURED");
      expect((await sharedGiftRepo.getById(gift.id))?.status).toBe("ACTIVE");
      expect(events).toEqual([]);
    });

    it("R3: over-refund rejected (payment stays CAPTURED, gift unchanged)", async () => {
      const { gift, paymentId, paidPaise } = await makeCapturedGift(30);

      const refund = razorpayService.buildMockRefundWebhook(paymentId, paidPaise + 100);
      const res = await postWebhook(refund.payload, refund.signature).expect(200);

      expect(res.body.data.processed).toBe(false);
      expect((await sharedPaymentRepo.findByRazorpayPaymentId(paymentId))?.status).toBe("CAPTURED");
      expect((await sharedGiftRepo.getById(gift.id))?.status).toBe("ACTIVE");
    });

    it("R4: refund for non-CAPTURED payment rejected", async () => {
      const { orderId, totalAmount } = await createDraftOrder(app);
      const amountPaise = Math.round(totalAmount * 100);
      const { rpOrderId } = await createOnlineOrderPayment(orderId, amountPaise);
      const failed = razorpayService.buildMockWebhook(rpOrderId, amountPaise, "payment.failed");
      await postWebhook(failed.payload, failed.signature).expect(200);
      const paymentId = failed.payload.payload.payment.entity.id;
      expect((await sharedPaymentRepo.findByRazorpayOrderId(rpOrderId))?.status).toBe("FAILED");

      const refund = razorpayService.buildMockRefundWebhook(paymentId, amountPaise);
      const res = await postWebhook(refund.payload, refund.signature).expect(200);

      expect(res.body.data.processed).toBe(false);
      expect((await sharedPaymentRepo.findByRazorpayOrderId(rpOrderId))?.status).toBe("FAILED");
    });

    it("R5: duplicate valid refund after REFUNDED -> idempotent", async () => {
      const { orderId, totalAmount } = await createDraftOrder(app);
      const amountPaise = Math.round(totalAmount * 100);
      const { rpOrderId, mock } = await createOnlineOrderPayment(orderId, amountPaise);
      await postWebhook(mock.payload, mock.signature).expect(200);
      const paymentId = mock.payload.payload.payment.entity.id;

      const first = razorpayService.buildMockRefundWebhook(paymentId, amountPaise);
      const r1 = await postWebhook(first.payload, first.signature).expect(200);
      expect(r1.body.data.processed).toBe(true);
      expect((await sharedOrderRepo.getById(orderId))?.status).toBe("REFUNDED");

      const second = razorpayService.buildMockRefundWebhook(paymentId, amountPaise);
      const r2 = await postWebhook(second.payload, second.signature).expect(200);
      expect(r2.body.data.processed).toBe(false);
      expect(r2.body.data.idempotent).toBe(true);
      expect((await sharedPaymentRepo.findByRazorpayOrderId(rpOrderId))?.status).toBe("REFUNDED");
    });
  });

  describe("POST /api/v1/payments/webhook", () => {
    it("processes payment.captured and transitions order to CONFIRMED", async () => {
      const { orderId, totalAmount } = await createDraftOrder(app);

      const createRes = await request(app)
        .post("/api/v1/payments/create-order")
        .set(authHeaders())
        .send({ order_id: orderId })
        .expect(200);

      const rpOrderId = createRes.body.data.razorpay_order_id;

      const mock = razorpayService.buildMockWebhook(
        rpOrderId,
        Math.round(totalAmount * 100),
        "payment.captured",
      );

      const res = await request(app)
        .post("/api/v1/payments/webhook")
        .set("X-Razorpay-Signature", mock.signature)
        .set("Content-Type", "application/json")
        .send(mock.payload)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.processed).toBe(true);
      expect(res.body.data.idempotent).toBe(false);
      expect(res.body.data.order_status).toBe("CONFIRMED");

      const order = await sharedOrderRepo.getById(orderId);
      expect(order?.status).toBe("CONFIRMED");
    });

    it("processes payment.failed and transitions order to PAYMENT_FAILED", async () => {
      const { orderId, totalAmount } = await createDraftOrder(app);

      const createRes = await request(app)
        .post("/api/v1/payments/create-order")
        .set(authHeaders())
        .send({ order_id: orderId })
        .expect(200);

      const rpOrderId = createRes.body.data.razorpay_order_id;

      const mock = razorpayService.buildMockWebhook(
        rpOrderId,
        Math.round(totalAmount * 100),
        "payment.failed",
        "Insufficient funds",
      );

      const res = await request(app)
        .post("/api/v1/payments/webhook")
        .set("X-Razorpay-Signature", mock.signature)
        .set("Content-Type", "application/json")
        .send(mock.payload)
        .expect(200);

      expect(res.body.data.processed).toBe(true);
      expect(res.body.data.order_status).toBe("PAYMENT_FAILED");

      const order = await sharedOrderRepo.getById(orderId);
      expect(order?.status).toBe("PAYMENT_FAILED");
    });

    it("CRITICAL: duplicate webhook is idempotent - returns 200 with no side effects", async () => {
      const { orderId, totalAmount } = await createDraftOrder(app);

      const createRes = await request(app)
        .post("/api/v1/payments/create-order")
        .set(authHeaders())
        .send({ order_id: orderId })
        .expect(200);

      const rpOrderId = createRes.body.data.razorpay_order_id;

      const mock = razorpayService.buildMockWebhook(
        rpOrderId,
        Math.round(totalAmount * 100),
        "payment.captured",
      );

      // First webhook delivery
      const first = await request(app)
        .post("/api/v1/payments/webhook")
        .set("X-Razorpay-Signature", mock.signature)
        .set("Content-Type", "application/json")
        .send(mock.payload)
        .expect(200);

      expect(first.body.data.processed).toBe(true);
      expect(first.body.data.idempotent).toBe(false);

      const orderAfterFirst = await sharedOrderRepo.getById(orderId);
      expect(orderAfterFirst?.status).toBe("CONFIRMED");

      // Second webhook delivery - exact same payload (simulates Razorpay retry)
      const second = await request(app)
        .post("/api/v1/payments/webhook")
        .set("X-Razorpay-Signature", mock.signature)
        .set("Content-Type", "application/json")
        .send(mock.payload)
        .expect(200);

      expect(second.body.success).toBe(true);
      expect(second.body.data.processed).toBe(false);
      expect(second.body.data.idempotent).toBe(true);

      // Order status must remain CONFIRMED - not double-processed
      const orderAfterSecond = await sharedOrderRepo.getById(orderId);
      expect(orderAfterSecond?.status).toBe("CONFIRMED");
    });

    it("rejects webhook with invalid signature", async () => {
      const { orderId, totalAmount } = await createDraftOrder(app);

      const createRes = await request(app)
        .post("/api/v1/payments/create-order")
        .set(authHeaders())
        .send({ order_id: orderId })
        .expect(200);

      const rpOrderId = createRes.body.data.razorpay_order_id;

      const mock = razorpayService.buildMockWebhook(
        rpOrderId,
        Math.round(totalAmount * 100),
        "payment.captured",
      );

      const res = await request(app)
        .post("/api/v1/payments/webhook")
        .set("X-Razorpay-Signature", "invalid_signature_12345")
        .set("Content-Type", "application/json")
        .send(mock.payload)
        .expect(401);

      expect(res.body.error.code).toBe("INVALID_WEBHOOK_SIGNATURE");
    });

    it("rejects webhook without signature header", async () => {
      const res = await request(app)
        .post("/api/v1/payments/webhook")
        .set("Content-Type", "application/json")
        .send({ event: "payment.captured" })
        .expect(401);

      expect(res.body.error.code).toBe("MISSING_SIGNATURE");
    });

    it("rejects malformed webhook payload", async () => {
      const res = await request(app)
        .post("/api/v1/payments/webhook")
        .set("X-Razorpay-Signature", "valid_sig_test")
        .set("Content-Type", "application/json")
        .send({ event: "payment.captured", payload: {} })
        .expect(400);

      expect(res.body.error.code).toBe("INVALID_WEBHOOK");
    });

    it("returns 404 for webhook with unknown Razorpay order ID", async () => {
      const mock = razorpayService.buildMockWebhook(
        "order_nonexistent_rp",
        24280,
        "payment.captured",
      );

      const res = await request(app)
        .post("/api/v1/payments/webhook")
        .set("X-Razorpay-Signature", mock.signature)
        .set("Content-Type", "application/json")
        .send(mock.payload)
        .expect(404);

      expect(res.body.error.code).toBe("PAYMENT_NOT_FOUND");
    });
  });
});

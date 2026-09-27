import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { onEvent } from "../lib/eventBus";
import { jwtService } from "../services/jwt";
import { razorpayService } from "../services/razorpay";
import { sharedOrderRepo } from "../repositories/shared";
import { sharedPaymentRepo } from "../repositories/shared";

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

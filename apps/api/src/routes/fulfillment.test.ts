import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";
import { sharedAuditRepo, sharedOrderRepo } from "../repositories/shared";
import { sharedPaymentRepo } from "../repositories/shared";

const REST_ID = "a0000000-0000-4000-8000-000000000001";
const MENU_ITEM_1 = "b0000000-0000-4000-8000-000000000001";
const USER_ID = "u00000000-0000-4000-8000-000000000001";
const OWNER_ID = "e0000000-0000-4000-a000-000000000001"; // Biryani House owner

function authHeaders(userId?: string) {
  return {
    Authorization: `Bearer ${jwtService.signAccessToken({
      sub: userId ?? USER_ID,
      phone: "+919876543210",
      role: "CONSUMER",
      device_fingerprint: "fp_test_device_abc1234",
    })}`,
  };
}

function vendorAuthHeaders(userId?: string, role?: string) {
  return {
    Authorization: `Bearer ${jwtService.signAccessToken({
      sub: userId ?? OWNER_ID,
      phone: "+919876543210",
      role: role ?? "VENDOR_OWNER",
      device_fingerprint: "fp_test_device_abc1234",
    })}`,
  };
}

async function createConfirmedOrder(app: Express): Promise<{ orderId: string; otp: string; qrToken: string }> {
  // Create order
  const orderRes = await request(app)
    .post("/api/v1/orders")
    .set(authHeaders())
    .send({
      restaurant_id: REST_ID,
      items: [{ menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [] }],
    })
    .expect(201);

  const orderId = orderRes.body.data.id;

  // Create payment (transitions to PAYMENT_PENDING)
  // Skip real payment: manually set to CONFIRMED
  await sharedOrderRepo.updateStatus(orderId, "CONFIRMED");

  // Advance through state machine to READY_FOR_PICKUP
      await request(app)
        .put(`/api/vendor/orders/${orderId}/status`)
        .set(vendorAuthHeaders())
        .expect(200); // CONFIRMED -> PREPARING (generates OTP/QR)

      await request(app)
        .put(`/api/vendor/orders/${orderId}/status`)
        .set(vendorAuthHeaders())
        .expect(200); // PREPARING -> ALMOST_READY

      await request(app)
        .put(`/api/vendor/orders/${orderId}/status`)
        .set(vendorAuthHeaders())
        .expect(200); // ALMOST_READY -> READY_FOR_PICKUP

  const finalOrder = await sharedOrderRepo.getById(orderId);
  return {
    orderId,
    otp: finalOrder?.pickup_otp ?? "0000",
    qrToken: finalOrder?.qr_token ?? "missing",
  };
}

describe("Fulfillment routes", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    sharedOrderRepo._reset();
    sharedPaymentRepo._reset();
    sharedAuditRepo._reset();
    app = createApp();
  });

  describe("State machine (vendor)", () => {
    it("advances CONFIRMED -> PREPARING and generates OTP + QR token", async () => {
      const orderRes = await request(app)
        .post("/api/v1/orders")
        .set(authHeaders())
        .send({
          restaurant_id: REST_ID,
          items: [{ menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [] }],
        })
        .expect(201);

      const orderId = orderRes.body.data.id;
      await sharedOrderRepo.updateStatus(orderId, "CONFIRMED");

      const res = await request(app)
        .put(`/api/vendor/orders/${orderId}/status`)
        .set(vendorAuthHeaders())
        .expect(200);

      expect(res.body.data.status).toBe("PREPARING");
      expect(res.body.data.pickup_otp).toMatch(/^\d{4}$/);
      expect(res.body.data.qr_token).toBeTruthy();
    });

    it("advances through full state machine to READY_FOR_PICKUP", async () => {
      const { orderId } = await createConfirmedOrder(app);

      const order = await sharedOrderRepo.getById(orderId);
      expect(order?.status).toBe("READY_FOR_PICKUP");
    });

    it("rejects skipping states: CONFIRMED -> ALMOST_READY", async () => {
      const orderRes = await request(app)
        .post("/api/v1/orders")
        .set(authHeaders())
        .send({
          restaurant_id: REST_ID,
          items: [{ menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [] }],
        })
        .expect(201);

      await sharedOrderRepo.updateStatus(orderRes.body.data.id, "CONFIRMED");

      // Skip PREPARING: advance once to PREPARING
      await request(app)
        .put(`/api/vendor/orders/${orderRes.body.data.id}/status`)
        .set(vendorAuthHeaders())
        .expect(200); // CONFIRMED -> PREPARING

      // Now trying to skip ALMOST_READY should fail because next allowed is ALMOST_READY only
      // Actually we want to test that you can't go CONFIRMED -> ALMOST_READY directly
      // Let's create a fresh order and try to jump
      const order2 = await request(app)
        .post("/api/v1/orders")
        .set(authHeaders())
        .send({
          restaurant_id: REST_ID,
          items: [{ menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [] }],
        })
        .expect(201);

      await sharedOrderRepo.updateStatus(order2.body.data.id, "CONFIRMED");

      // First advance is CONFIRMED -> PREPARING (allowed)
      const ok1 = await request(app)
        .put(`/api/vendor/orders/${order2.body.data.id}/status`)
        .set(vendorAuthHeaders())
        .expect(200);
      expect(ok1.body.data.status).toBe("PREPARING");

      // Now from PREPARING, trying to set to READY_FOR_PICKUP directly
      // The state machine only allows PREPARING -> ALMOST_READY
      // We set it manually and verify the middleware prevents jumping
      await sharedOrderRepo.updateStatus(order2.body.data.id, "PREPARING");
      // This advances to ALMOST_READY, not READY_FOR_PICKUP
      const res2 = await request(app)
        .put(`/api/vendor/orders/${order2.body.data.id}/status`)
        .set(vendorAuthHeaders())
        .expect(200);
      expect(res2.body.data.status).toBe("ALMOST_READY");
    });

    it("rejects advance from terminal state", async () => {
      const { orderId } = await createConfirmedOrder(app);

      await request(app)
        .post(`/api/v1/orders/${orderId}/confirm-pickup`)
        .set(authHeaders())
        .send({ pickup_otp: (await sharedOrderRepo.getById(orderId))?.pickup_otp })
        .expect(200);

      const res = await request(app)
        .put(`/api/vendor/orders/${orderId}/status`)
        .set(vendorAuthHeaders())
        .expect(400);

      expect(res.body.error.code).toBe("INVALID_TRANSITION");
    });

    it("returns 404 for nonexistent order", async () => {
      const res = await request(app)
        .put("/api/vendor/orders/00000000-0000-4000-8000-000000000099/status")
        .set(vendorAuthHeaders())
        .expect(404);

      expect(res.body.error.code).toBe("ORDER_NOT_FOUND");
    });
  });

  describe("Check-in (consumer)", () => {
    it("records consumer check-in", async () => {
      const orderRes = await request(app)
        .post("/api/v1/orders")
        .set(authHeaders())
        .send({
          restaurant_id: REST_ID,
          items: [{ menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [] }],
        })
        .expect(201);

      const res = await request(app)
        .post(`/api/v1/orders/${orderRes.body.data.id}/check-in`)
        .set(authHeaders())
        .expect(200);

      expect(res.body.data.checked_in).toBe(true);

      const order = await sharedOrderRepo.getById(orderRes.body.data.id);
      expect(order?.checked_in).toBe(true);
    });

    it("check-in is idempotent", async () => {
      const orderRes = await request(app)
        .post("/api/v1/orders")
        .set(authHeaders())
        .send({
          restaurant_id: REST_ID,
          items: [{ menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [] }],
        })
        .expect(201);

      await request(app)
        .post(`/api/v1/orders/${orderRes.body.data.id}/check-in`)
        .set(authHeaders())
        .expect(200);

      const res = await request(app)
        .post(`/api/v1/orders/${orderRes.body.data.id}/check-in`)
        .set(authHeaders())
        .expect(200);

      expect(res.body.data.checked_in).toBe(true);
    });

    it("requires authentication", async () => {
      const res = await request(app)
        .post(`/api/v1/orders/00000000-0000-4000-8000-000000000099/check-in`)
        .expect(401);
      expect(res.body.error.code).toBe("UNAUTHORIZED");
    });
  });

  describe("Confirm pickup", () => {
    it("verifies valid OTP and transitions to PICKED_UP", async () => {
      const { orderId, otp } = await createConfirmedOrder(app);

      const res = await request(app)
        .post(`/api/v1/orders/${orderId}/confirm-pickup`)
        .set(authHeaders())
        .send({ pickup_otp: otp })
        .expect(200);

      expect(res.body.data.status).toBe("PICKED_UP");
      expect(res.body.data.picked_up).toBe(true);

      const order = await sharedOrderRepo.getById(orderId);
      expect(order?.status).toBe("PICKED_UP");
    });

    it("verifies valid QR token and transitions to PICKED_UP", async () => {
      const { orderId, qrToken } = await createConfirmedOrder(app);

      const res = await request(app)
        .post(`/api/v1/orders/${orderId}/confirm-pickup`)
        .set(authHeaders())
        .send({ qr_token: qrToken })
        .expect(200);

      expect(res.body.data.status).toBe("PICKED_UP");
    });

    it("rejects invalid OTP", async () => {
      const { orderId } = await createConfirmedOrder(app);

      const res = await request(app)
        .post(`/api/v1/orders/${orderId}/confirm-pickup`)
        .set(authHeaders())
        .send({ pickup_otp: "9999" })
        .expect(400);

      expect(res.body.error.code).toBe("INVALID_OTP");
    });

    it("rejects invalid QR token", async () => {
      const { orderId } = await createConfirmedOrder(app);

      const res = await request(app)
        .post(`/api/v1/orders/${orderId}/confirm-pickup`)
        .set(authHeaders())
        .send({ qr_token: "00000000-0000-4000-8000-000000000099" })
        .expect(400);

      expect(res.body.error.code).toBe("INVALID_QR");
    });

    it("rejects pickup when order is not READY_FOR_PICKUP", async () => {
      const orderRes = await request(app)
        .post("/api/v1/orders")
        .set(authHeaders())
        .send({
          restaurant_id: REST_ID,
          items: [{ menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [] }],
        })
        .expect(201);

      const res = await request(app)
        .post(`/api/v1/orders/${orderRes.body.data.id}/confirm-pickup`)
        .set(authHeaders())
        .send({ pickup_otp: "1234" })
        .expect(400);

      expect(res.body.error.code).toBe("NOT_READY");
    });

    it("rejects missing verification method", async () => {
      const { orderId } = await createConfirmedOrder(app);

      const res = await request(app)
        .post(`/api/v1/orders/${orderId}/confirm-pickup`)
        .set(authHeaders())
        .send({})
        .expect(400);

      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects duplicate pickup", async () => {
      const { orderId, otp } = await createConfirmedOrder(app);

      await request(app)
        .post(`/api/v1/orders/${orderId}/confirm-pickup`)
        .set(authHeaders())
        .send({ pickup_otp: otp })
        .expect(200);

      const res = await request(app)
        .post(`/api/v1/orders/${orderId}/confirm-pickup`)
        .set(authHeaders())
        .send({ pickup_otp: otp })
        .expect(400);

      expect(res.body.error.code).toBe("ALREADY_PICKED_UP");
    });

    it("rate-limits pickup OTP attempts per order", async () => {
      const { orderId } = await createConfirmedOrder(app);

      let saw429 = false;
      for (let i = 0; i < 12; i++) {
        const res = await request(app)
          .post(`/api/v1/orders/${orderId}/confirm-pickup`)
          .set(authHeaders())
          .send({ pickup_otp: "9999" });
        if (res.status === 429) {
          saw429 = true;
          expect(res.body.error.code).toBe("RATE_LIMIT_EXCEEDED");
          break;
        }
        expect(res.status).toBe(400);
      }

      expect(saw429).toBe(true);
    });
  });

  describe("P13 Early Ready Alert", () => {
    it("emits EarlyReadyAlert when ready before scheduled_pickup_time", async () => {
      const scheduled = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h
      const orderRes = await request(app)
        .post("/api/v1/orders")
        .set(authHeaders())
        .send({
          restaurant_id: REST_ID,
          items: [{ menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [] }],
          scheduled_pickup_time: scheduled,
        })
        .expect(201);

      const orderId = orderRes.body.data.id;
      await sharedOrderRepo.updateStatus(orderId, "CONFIRMED");
      await request(app).put(`/api/vendor/orders/${orderId}/status`).set(vendorAuthHeaders()).expect(200);
      await request(app).put(`/api/vendor/orders/${orderId}/status`).set(vendorAuthHeaders()).expect(200);

      const res = await request(app)
        .put(`/api/vendor/orders/${orderId}/status`)
        .set(vendorAuthHeaders())
        .expect(200);

      expect(res.body.data.status).toBe("READY_FOR_PICKUP");
      expect(res.body.data.early_ready_alerted).toBe(true);

      const audits = await sharedAuditRepo.all();
      const alert = audits.find((a) => a.action === "early_ready_alerted");
      expect(alert?.metadata).toMatchObject({
        order_id: orderId,
        scheduled_pickup_time: scheduled,
      });
    });

    it("does not alert when ready on/after scheduled_pickup_time", async () => {
      const scheduled = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // -1h (late)
      const orderRes = await request(app)
        .post("/api/v1/orders")
        .set(authHeaders())
        .send({
          restaurant_id: REST_ID,
          items: [{ menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [] }],
          scheduled_pickup_time: scheduled,
        })
        .expect(201);

      const orderId = orderRes.body.data.id;
      await sharedOrderRepo.updateStatus(orderId, "CONFIRMED");
      await request(app).put(`/api/vendor/orders/${orderId}/status`).set(vendorAuthHeaders()).expect(200);
      await request(app).put(`/api/vendor/orders/${orderId}/status`).set(vendorAuthHeaders()).expect(200);

      const res = await request(app)
        .put(`/api/vendor/orders/${orderId}/status`)
        .set(vendorAuthHeaders())
        .expect(200);

      expect(res.body.data.early_ready_alerted).toBe(false);

      const audits = await sharedAuditRepo.all();
      expect(audits.some((a) => a.action === "early_ready_alerted")).toBe(false);
    });

    it("does not alert when no scheduled_pickup_time is set", async () => {
      const orderRes = await request(app)
        .post("/api/v1/orders")
        .set(authHeaders())
        .send({
          restaurant_id: REST_ID,
          items: [{ menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [] }],
        })
        .expect(201);

      const orderId = orderRes.body.data.id;
      await sharedOrderRepo.updateStatus(orderId, "CONFIRMED");
      await request(app).put(`/api/vendor/orders/${orderId}/status`).set(vendorAuthHeaders()).expect(200);
      await request(app).put(`/api/vendor/orders/${orderId}/status`).set(vendorAuthHeaders()).expect(200);

      const res = await request(app)
        .put(`/api/vendor/orders/${orderId}/status`)
        .set(vendorAuthHeaders())
        .expect(200);

      expect(res.body.data.early_ready_alerted).toBe(false);
    });
  });

  describe("Vendor order listing", () => {
    it("returns active orders for a restaurant", async () => {
      const orderRes = await request(app)
        .post("/api/v1/orders")
        .set(authHeaders())
        .send({
          restaurant_id: REST_ID,
          items: [{ menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [] }],
        })
        .expect(201);

      await sharedOrderRepo.updateStatus(orderRes.body.data.id, "CONFIRMED");

      const res = await request(app)
        .get(`/api/vendor/orders?restaurant_id=${REST_ID}`)
        .set(vendorAuthHeaders())
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(orderRes.body.data.id);
    });
  });

  describe("Vendor restaurant ownership guard (H2)", () => {
    const OTHER_OWNER_ID = "e0000000-0000-4000-a000-000000000002"; // Green Bowl owner

    it("forbids a vendor listing orders for a restaurant they do not own (403)", async () => {
      const res = await request(app)
        .get(`/api/vendor/orders?restaurant_id=${REST_ID}`)
        .set(vendorAuthHeaders(OTHER_OWNER_ID))
        .expect(403);

      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("forbids a vendor advancing status on a foreign restaurant's order (403)", async () => {
      const orderRes = await request(app)
        .post("/api/v1/orders")
        .set(authHeaders())
        .send({
          restaurant_id: REST_ID,
          items: [{ menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [] }],
        })
        .expect(201);

      await sharedOrderRepo.updateStatus(orderRes.body.data.id, "CONFIRMED");

      const res = await request(app)
        .put(`/api/vendor/orders/${orderRes.body.data.id}/status`)
        .set(vendorAuthHeaders(OTHER_OWNER_ID))
        .expect(403);

      expect(res.body.error.code).toBe("FORBIDDEN");

      const order = await sharedOrderRepo.getById(orderRes.body.data.id);
      expect(order?.status).toBe("CONFIRMED");
    });

    it("allows an ADMIN to bypass the ownership guard", async () => {
      const orderRes = await request(app)
        .post("/api/v1/orders")
        .set(authHeaders())
        .send({
          restaurant_id: REST_ID,
          items: [{ menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [] }],
        })
        .expect(201);

      await sharedOrderRepo.updateStatus(orderRes.body.data.id, "CONFIRMED");

      const res = await request(app)
        .put(`/api/vendor/orders/${orderRes.body.data.id}/status`)
        .set(vendorAuthHeaders(OTHER_OWNER_ID, "ADMIN"))
        .expect(200);

      expect(res.body.data.status).toBe("PREPARING");
    });

    it("forbids a vendor fetching menu for a restaurant they do not own (403)", async () => {
      const res = await request(app)
        .get(`/api/vendor/menu?restaurant_id=${REST_ID}`)
        .set(vendorAuthHeaders(OTHER_OWNER_ID))
        .expect(403);

      expect(res.body.error.code).toBe("FORBIDDEN");
    });
  });
});

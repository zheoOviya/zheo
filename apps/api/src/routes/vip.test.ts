import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";
import {
  sharedAuditRepo,
  sharedOrderRepo,
  sharedSupportRepo,
} from "../repositories/shared";
import { resetCatalogRepository } from "./catalog";
import type { OrderDTO } from "../repositories/orderRepository";

// ============================================
// L15 VIP Customer Support - GET /api/v1/support/vip-status, POST /ticket
// VIP = orders > 50 OR spend > Rs 5000 (eligible statuses only)
// ============================================

const REST_ID = "a0000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-0000000000f1";

function auth(userId: string) {
  return {
    Authorization: `Bearer ${jwtService.signAccessToken({
      sub: userId,
      phone: "+919876543210",
      role: "CONSUMER",
      device_fingerprint: "fp_vip_test_12345",
    })}`,
  };
}

let seq = 0;

function seedOrder(
  status: OrderDTO["status"],
  totalAmount = 100,
  id = `vip-${++seq}`,
): OrderDTO {
  return sharedOrderRepo._seed({
    id,
    user_id: USER,
    restaurant_id: REST_ID,
    items: [],
    total_amount: totalAmount,
    status,
    commission_rate: 0.08,
    commission_amount: 0,
    pickup_otp: null,
    qr_token: null,
    checked_in: false,
    scheduled_pickup_time: null,
    created_at: "2026-08-06T10:00:00.000Z",
    updated_at: "2026-08-06T10:00:00.000Z",
  });
}

describe("L15 VIP Customer Support", () => {
  let app: Express;

  beforeEach(() => {
    seq = 0;
    resetRedisForTests();
    resetCatalogRepository();
    sharedOrderRepo._reset();
    sharedSupportRepo._reset();
    sharedAuditRepo._reset();
    app = createApp();
  });

  it("rejects unauthenticated requests (401)", async () => {
    await request(app).get("/api/v1/support/vip-status").expect(401);
    await request(app).post("/api/v1/support/ticket").send({}).expect(401);
  });

  it("crossing the order-count threshold (51 eligible orders) makes the user VIP", async () => {
    for (let i = 0; i < 51; i += 1) seedOrder("PICKED_UP");

    const res = await request(app)
      .get("/api/v1/support/vip-status")
      .set(auth(USER))
      .expect(200);

    expect(res.body.data).toMatchObject({
      is_vip: true,
      order_count: 51,
      total_spend: 5100,
      order_threshold: 50,
      spend_threshold: 5000,
    });
  });

  it("crossing the spend threshold (Rs 5001) makes the user VIP even with few orders", async () => {
    // 26 orders of Rs 200 = Rs 5200 spend, 26 orders <= 50.
    for (let i = 0; i < 26; i += 1) seedOrder("CONFIRMED", 200);

    const res = await request(app)
      .get("/api/v1/support/vip-status")
      .set(auth(USER))
      .expect(200);
    expect(res.body.data.is_vip).toBe(true);
    expect(res.body.data.total_spend).toBe(5200);
  });

  it("ignores DRAFT / PAYMENT_FAILED / CANCELLED when counting VIP eligibility", async () => {
    // 50 eligible + 10 abandoned would be 60 total but only 50 count -> not VIP.
    for (let i = 0; i < 50; i += 1) seedOrder("PICKED_UP");
    for (let i = 0; i < 10; i += 1) seedOrder("DRAFT");
    seedOrder("PAYMENT_FAILED");
    seedOrder("CANCELLED");

    const res = await request(app)
      .get("/api/v1/support/vip-status")
      .set(auth(USER))
      .expect(200);
    expect(res.body.data.order_count).toBe(50);
    expect(res.body.data.is_vip).toBe(false);
  });

  it("non-VIP ticket gets MEDIUM priority and no assignee", async () => {
    for (let i = 0; i < 3; i += 1) seedOrder("PICKED_UP");

    const res = await request(app)
      .post("/api/v1/support/ticket")
      .set(auth(USER))
      .send({ subject: "Cold food", description: "Biryani arrived cold." })
      .expect(201);

    expect(res.body.data).toMatchObject({
      priority: "MEDIUM",
      assignee: null,
      is_vip: false,
    });
  });

  it("VIP ticket gets HIGH priority and is auto-assigned to a specialized OPS_AGENT", async () => {
    for (let i = 0; i < 51; i += 1) seedOrder("PICKED_UP");

    const res = await request(app)
      .post("/api/v1/support/ticket")
      .set(auth(USER))
      .send({ subject: "Delayed event order", description: "Catering arrived late." })
      .expect(201);

    expect(res.body.data).toMatchObject({
      priority: "HIGH",
      assignee: "OPS_AGENT",
      is_vip: true,
    });

    // The ticket is persisted in the support context and audited.
    const logs = await sharedAuditRepo.all();
    const log = logs.find((l) => l.action === "support_ticket_created");
    expect(log).toBeDefined();
    expect(log?.metadata).toMatchObject({
      priority: "HIGH",
      assignee: "OPS_AGENT",
      is_vip: true,
    });
  });

  it("validates the ticket payload (400 on empty subject)", async () => {
    const res = await request(app)
      .post("/api/v1/support/ticket")
      .set(auth(USER))
      .send({ subject: "", description: "x" })
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

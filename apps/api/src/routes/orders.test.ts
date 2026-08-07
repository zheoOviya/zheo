import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiEnvelopeSchema } from "@snakzap/types";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";
import { orderRepo } from "./orders";

const REST_ID = "a0000000-0000-4000-8000-000000000001";
const MENU_ITEM_1 = "b0000000-0000-4000-8000-000000000001"; // Chicken Biryani Rs 220
const MENU_ITEM_2 = "b0000000-0000-4000-8000-000000000002"; // Veg Biryani Rs 180

const TEST_USER_ID = "u00000000-0000-4000-8000-000000000001";

function authToken(userId = TEST_USER_ID): string {
  return jwtService.signAccessToken({
    sub: userId,
    phone: "+919876543210",
    role: "CONSUMER",
    device_fingerprint: "fp_test_device_abc1234",
  });
}

function authHeaders(userId?: string) {
  return { Authorization: `Bearer ${authToken(userId)}` };
}

describe("Ordering routes", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    orderRepo._reset();
    app = createApp();
  });

  it("POST /orders creates an order in DRAFT with price breakdown", async () => {
    const res = await request(app)
      .post("/api/v1/orders")
      .set(authHeaders())
      .send({
        restaurant_id: REST_ID,
        items: [
          {
            menu_item_id: MENU_ITEM_1,
            quantity: 1,
            customizations: [],
          },
        ],
      })
      .expect(201);

    expect(ApiEnvelopeSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.success).toBe(true);
    const order = res.body.data;
    expect(order.status).toBe("DRAFT");
    expect(order.restaurant_id).toBe(REST_ID);
    expect(order.items).toHaveLength(1);
    expect(order.items[0].name).toBe("Chicken Biryani");
    expect(order.items[0].base_price).toBe(220);
    expect(order.total_amount).toBe(242.8);
    expect(order.commission_rate).toBe(0.08);
    expect(order.commission_amount).toBe(19.42);
    expect(order.pickup_otp).toBeNull();
  });

  it("POST /orders uses user_id from JWT sub claim", async () => {
    const customUserId = "u99999999-0000-4000-8000-000000000099";
    const res = await request(app)
      .post("/api/v1/orders")
      .set(authHeaders(customUserId))
      .send({
        restaurant_id: REST_ID,
        items: [
          {
            menu_item_id: MENU_ITEM_1,
            quantity: 1,
            customizations: [],
          },
        ],
      })
      .expect(201);

    expect(res.body.data.user_id).toBe(customUserId);
  });

  it("POST /orders includes customization deltas in price", async () => {
    const res = await request(app)
      .post("/api/v1/orders")
      .set(authHeaders())
      .send({
        restaurant_id: REST_ID,
        items: [
          {
            menu_item_id: MENU_ITEM_2,
            quantity: 2,
            customizations: [
              { name: "Extra Spice", price_delta: 25 },
            ],
          },
        ],
      })
      .expect(201);

    const order = res.body.data;
    expect(order.items[0].customizations[0].price_delta).toBe(25);
    expect(order.total_amount).toBe(454.1);
    expect(order.commission_rate).toBe(0.08);
  });

  it("POST /orders rejects inactive restaurant", async () => {
    const res = await request(app)
      .post("/api/v1/orders")
      .set(authHeaders())
      .send({
        restaurant_id: "a0000000-0000-4000-8000-000000000003",
        items: [{ menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [] }],
      })
      .expect(404);
    expect(res.body.error.code).toBe("RESTAURANT_NOT_FOUND");
  });

  it("POST /orders rejects item from wrong restaurant", async () => {
    const res = await request(app)
      .post("/api/v1/orders")
      .set(authHeaders())
      .send({
        restaurant_id: REST_ID,
        items: [
          { menu_item_id: "b0000000-0000-4000-8000-000000000003", quantity: 1, customizations: [] },
        ],
      })
      .expect(400);
    expect(res.body.error.code).toBe("ITEM_RESTAURANT_MISMATCH");
  });

  it("POST /orders rejects empty items array", async () => {
    const res = await request(app)
      .post("/api/v1/orders")
      .set(authHeaders())
      .send({ restaurant_id: REST_ID, items: [] })
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("POST /orders/reorder clones items from a prior order", async () => {
    const first = await request(app)
      .post("/api/v1/orders")
      .set(authHeaders())
      .send({
        restaurant_id: REST_ID,
        items: [
          { menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [{ name: "Spicy", price_delta: 10 }] },
        ],
      });

    const firstId = first.body.data.id;

    const res = await request(app)
      .post("/api/v1/orders/reorder")
      .set(authHeaders())
      .send({ old_order_id: firstId })
      .expect(201);

    const reorder = res.body.data;
    expect(reorder.status).toBe("DRAFT");
    expect(reorder.restaurant_id).toBe(REST_ID);
    expect(reorder.items).toHaveLength(1);
    expect(reorder.items[0].menu_item_id).toBe(MENU_ITEM_1);
    expect(reorder.items[0].name).toBe("Chicken Biryani");
    expect(reorder.items[0].customizations).toEqual([{ name: "Spicy", price_delta: 10 }]);
    expect(reorder.id).not.toBe(firstId);
  });

  it("POST /orders/reorder with nonexistent order returns 404", async () => {
    const res = await request(app)
      .post("/api/v1/orders/reorder")
      .set(authHeaders())
      .send({ old_order_id: "00000000-0000-4000-8000-000000000099" })
      .expect(404);
    expect(res.body.error.code).toBe("ORDER_NOT_FOUND");
  });

  it("emits OrderCreated event when order is placed", async () => {
    const { onEvent } = await import("../lib/eventBus");
    const captured: unknown[] = [];
    onEvent("OrderCreated", async (evt) => {
      captured.push(evt);
    });

    await request(app)
      .post("/api/v1/orders")
      .set(authHeaders())
      .send({
        restaurant_id: REST_ID,
        items: [{ menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [] }],
      })
      .expect(201);

    expect(captured).toHaveLength(1);
    const event = captured[0] as Record<string, unknown>;
    expect(event.event_name).toBe("OrderCreated");
    expect(event.payload).toBeTruthy();
  });

  it("low-value order returns commission 0% and total under threshold", async () => {
    const GREEN_BOWL = "a0000000-0000-4000-8000-000000000002";
    const PANEER = "b0000000-0000-4000-8000-000000000003";

    const res = await request(app)
      .post("/api/v1/orders")
      .set(authHeaders())
      .send({
        restaurant_id: GREEN_BOWL,
        items: [{ menu_item_id: PANEER, quantity: 1, customizations: [] }],
      })
      .expect(201);

    const order = res.body.data;
    expect(order.total_amount).toBe(179.8);
    expect(order.commission_rate).toBe(0);
    expect(order.commission_amount).toBe(0);
  });

  it("GET /orders/:id returns the order for the owning user", async () => {
    const create = await request(app)
      .post("/api/v1/orders")
      .set(authHeaders())
      .send({
        restaurant_id: REST_ID,
        items: [{ menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [] }],
      })
      .expect(201);

    const orderId = create.body.data.id;

    const res = await request(app)
      .get(`/api/v1/orders/${orderId}`)
      .set(authHeaders())
      .expect(200);

    expect(res.body.data.id).toBe(orderId);
    expect(res.body.data.status).toBe("DRAFT");
  });

  it("GET /orders/:id returns 404 for nonexistent order", async () => {
    const res = await request(app)
      .get("/api/v1/orders/00000000-0000-4000-8000-000000000099")
      .set(authHeaders())
      .expect(404);
    expect(res.body.error.code).toBe("ORDER_NOT_FOUND");
  });

  it("GET /orders/:id forbids access to another user's order", async () => {
    const create = await request(app)
      .post("/api/v1/orders")
      .set(authHeaders())
      .send({
        restaurant_id: REST_ID,
        items: [{ menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [] }],
      })
      .expect(201);

    const orderId = create.body.data.id;
    const OTHER_USER = "u00000000-0000-4000-8000-000000000099";

    const res = await request(app)
      .get(`/api/v1/orders/${orderId}`)
      .set(authHeaders(OTHER_USER))
      .expect(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("GET /orders returns paginated history with restaurant_name", async () => {
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post("/api/v1/orders")
        .set(authHeaders())
        .send({
          restaurant_id: REST_ID,
          items: [{ menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [] }],
        })
        .expect(201);
    }

    const res = await request(app)
      .get("/api/v1/orders?page=1&limit=2")
      .set(authHeaders())
      .expect(200);

    expect(res.body.data.page).toBe(1);
    expect(res.body.data.limit).toBe(2);
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.pages).toBe(2);
    expect(res.body.data.orders).toHaveLength(2);
    for (const order of res.body.data.orders) {
      expect(order.restaurant_name).toBe("Biryani House");
      expect(order.user_id).toBe(TEST_USER_ID);
    }
    // Newest first.
    const dates = res.body.data.orders.map(
      (o: { created_at: string }) => new Date(o.created_at).getTime(),
    );
    expect(dates[0]).toBeGreaterThanOrEqual(dates[1]);
  });

  it("GET /orders pages forward through the history", async () => {
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post("/api/v1/orders")
        .set(authHeaders())
        .send({
          restaurant_id: REST_ID,
          items: [{ menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [] }],
        })
        .expect(201);
    }

    const page2 = await request(app)
      .get("/api/v1/orders?page=2&limit=2")
      .set(authHeaders())
      .expect(200);
    expect(page2.body.data.orders).toHaveLength(1);
    expect(page2.body.data.page).toBe(2);
  });

  it("GET /orders is empty for a user with no orders", async () => {
    const res = await request(app)
      .get("/api/v1/orders")
      .set(authHeaders())
      .expect(200);
    expect(res.body.data.orders).toEqual([]);
    expect(res.body.data.total).toBe(0);
    expect(res.body.data.pages).toBe(1);
  });

  it("GET /orders never leaks another user's orders", async () => {
    await request(app)
      .post("/api/v1/orders")
      .set(authHeaders())
      .send({
        restaurant_id: REST_ID,
        items: [{ menu_item_id: MENU_ITEM_1, quantity: 1, customizations: [] }],
      })
      .expect(201);

    const OTHER_USER = "u00000000-0000-4000-8000-000000000099";
    const res = await request(app)
      .get("/api/v1/orders")
      .set(authHeaders(OTHER_USER))
      .expect(200);
    expect(res.body.data.total).toBe(0);
  });

  it("GET /orders requires authentication", async () => {
    const res = await request(app).get("/api/v1/orders").expect(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("GET /orders validates pagination parameters", async () => {
    const res = await request(app)
      .get("/api/v1/orders?page=0&limit=999")
      .set(authHeaders())
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { resetRedisForTests } from "../lib/redis";
import { jwtService } from "../services/jwt";
import {
  sharedGroupCartRepo,
  sharedIdentityRepo,
  sharedOrderRepo,
} from "../repositories/shared";
import { resetCatalogRepository } from "./catalog";
import { calculatePriceBreakdown } from "../services/pricing";

// ============================================
// Group Order routes (O02) - /api/v1/orders/group
// Shareable token, ANY authenticated contributor adds to one DRAFT order,
// and per-token mutex serialization so concurrent adds never lose data.
// ============================================

const BIRYANI_HOUSE = "a0000000-0000-4000-8000-000000000001";
const GREEN_BOWL = "a0000000-0000-4000-8000-000000000002";

const CHICKEN_BIRYANI = "b0000000-0000-4000-8000-000000000001";
const VEG_BIRYANI = "b0000000-0000-4000-8000-000000000002";
const PANEER_WRAP = "b0000000-0000-4000-8000-000000000003";
const SHAWARMA = "b0000000-0000-4000-8000-000000000004";

const HOST = "00000000-0000-4000-8000-0000000000f1";
const CONTRIBUTOR_A = "00000000-0000-4000-8000-0000000000f2";
const CONTRIBUTOR_B = "00000000-0000-4000-8000-0000000000f3";

function auth(userId: string, suffix = "0") {
  return {
    Authorization: `Bearer ${jwtService.signAccessToken({
      sub: userId,
      phone: `+9198765432${suffix}`,
      role: "CONSUMER",
      device_fingerprint: `fp_group_${userId}`,
    })}`,
  };
}

async function createGroupCart(app: Express, userId = HOST) {
  const res = await request(app)
    .post("/api/v1/orders/group/create")
    .set(auth(userId, "1"))
    .send({ restaurant_id: BIRYANI_HOUSE })
    .expect(201);
  return res.body.data as {
    group_cart_token: string;
    order_id: string;
    restaurant_id: string;
    share_link: string;
  };
}

async function addToCart(
  app: Express,
  token: string,
  userId: string,
  menuItemId: string,
  quantity = 1,
) {
  return request(app)
    .post("/api/v1/orders/group/add")
    .set(auth(userId, "2"))
    .send({
      group_cart_token: token,
      items: [
        {
          menu_item_id: menuItemId,
          quantity,
          customizations: [],
        },
      ],
    });
}

describe("Group Order routes (O02)", () => {
  let app: Express;

  beforeEach(() => {
    resetRedisForTests();
    sharedOrderRepo._reset();
    sharedGroupCartRepo._reset();
    sharedIdentityRepo._reset();
    resetCatalogRepository();

    // Known identities so contributor display names exercise phone masking.
    for (const [id, phone] of [
      [HOST, "+91987654321"],
      [CONTRIBUTOR_A, "+91987654322"],
      [CONTRIBUTOR_B, "+91987654323"],
    ] as const) {
      sharedIdentityRepo._seed({
        id,
        phone,
        role: "CONSUMER",
        created_at: new Date().toISOString(),
      });
    }

    app = createApp();
  });

  describe("POST /api/v1/orders/group/create", () => {
    it("requires authentication", async () => {
      await request(app)
        .post("/api/v1/orders/group/create")
        .send({ restaurant_id: BIRYANI_HOUSE })
        .expect(401);
    });

    it("mints a shareable token and a DRAFT order for an active restaurant", async () => {
      const cart = await createGroupCart(app);
      expect(cart.group_cart_token).toMatch(/^gc_[0-9a-f]{24}$/);
      expect(cart.share_link).toContain(`token=${cart.group_cart_token}`);
      expect(cart.restaurant_id).toBe(BIRYANI_HOUSE);

      const order = await sharedOrderRepo.getById(cart.order_id);
      expect(order?.status).toBe("DRAFT");
      expect(order?.items).toHaveLength(0);
    });

    it("rejects unknown or inactive restaurants", async () => {
      const res = await request(app)
        .post("/api/v1/orders/group/create")
        .set(auth(HOST))
        .send({ restaurant_id: GREEN_BOWL }) // active, fine
        .expect(201);
      expect(res.body.data.group_cart_token).toBeDefined();

      const inactive = await request(app)
        .post("/api/v1/orders/group/create")
        .set(auth(HOST))
        .send({ restaurant_id: "a0000000-0000-4000-8000-000000000003" }) // Closed Kitchen
        .expect(404);
      expect(inactive.body.error.code).toBe("RESTAURANT_NOT_FOUND");
    });
  });

  describe("POST /api/v1/orders/group/add", () => {
    it("requires authentication", async () => {
      const cart = await createGroupCart(app);
      await request(app)
        .post("/api/v1/orders/group/add")
        .send({
          group_cart_token: cart.group_cart_token,
          items: [{ menu_item_id: CHICKEN_BIRYANI, quantity: 1, customizations: [] }],
        })
        .expect(401);
    });

    it("lets ANY authenticated user add to the shared DRAFT order", async () => {
      const cart = await createGroupCart(app);

      const resA = await addToCart(app, cart.group_cart_token, CONTRIBUTOR_A, CHICKEN_BIRYANI, 2);
      expect(resA.status).toBe(200);
      expect(resA.body.data.order.items).toHaveLength(1);

      const resB = await addToCart(app, cart.group_cart_token, CONTRIBUTOR_B, VEG_BIRYANI, 1);
      expect(resB.status).toBe(200);

      const final = resB.body.data;
      const itemNames = final.order.items.map((i: { name: string }) => i.name);
      expect(itemNames).toEqual(
        expect.arrayContaining(["Chicken Biryani", "Veg Biryani"]),
      );
      // One order, two contributions from two different users.
      expect(final.cart.item_count).toBe(3);
      const expectedTotal = calculatePriceBreakdown([
        { menu_item_id: CHICKEN_BIRYANI, name: "Chicken Biryani", base_price: 220, quantity: 2, customizations: [] },
        { menu_item_id: VEG_BIRYANI, name: "Veg Biryani", base_price: 180, quantity: 1, customizations: [] },
      ]).total_amount;
      expect(final.cart.total_amount).toBe(expectedTotal);
      expect(final.cart.contributors).toHaveLength(3); // host + A + B
      expect(
        final.cart.contributors.some(
          (c: { user_id: string }) => c.user_id === CONTRIBUTOR_A,
        ),
      ).toBe(true);
      expect(
        final.cart.contributors.some(
          (c: { user_id: string }) => c.user_id === CONTRIBUTOR_B,
        ),
      ).toBe(true);
      // Masked identity: display names are "Host" or ••••XXXX, never a phone.
      for (const c of final.cart.contributors as Array<{ display_name: string }>) {
        expect(c.display_name).toMatch(/^(Host|••••\d{4})$/);
      }
      const aContributor = final.cart.contributors.find(
        (c: { user_id: string }) => c.user_id === CONTRIBUTOR_A,
      );
      expect(aContributor.display_name).toBe("••••4322");
    });

    it("returns 404 for an unknown token", async () => {
      const res = await request(app)
        .post("/api/v1/orders/group/add")
        .set(auth(CONTRIBUTOR_A))
        .send({
          group_cart_token: "gc_000000000000000000000000",
          items: [{ menu_item_id: CHICKEN_BIRYANI, quantity: 1, customizations: [] }],
        })
        .expect(404);
      expect(res.body.error.code).toBe("GROUP_CART_NOT_FOUND");
    });

    it("rejects items from a different restaurant", async () => {
      const cart = await createGroupCart(app);
      const res = await addToCart(app, cart.group_cart_token, CONTRIBUTOR_A, PANEER_WRAP);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("ITEM_RESTAURANT_MISMATCH");
    });

    it("locks the cart once the order leaves DRAFT", async () => {
      const cart = await createGroupCart(app);
      await addToCart(app, cart.group_cart_token, CONTRIBUTOR_A, CHICKEN_BIRYANI, 1);
      await sharedOrderRepo.updateStatus(cart.order_id, "CONFIRMED");

      const res = await addToCart(app, cart.group_cart_token, CONTRIBUTOR_B, VEG_BIRYANI);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("GROUP_ORDER_LOCKED");
    });
  });

  describe("O02 concurrency: same-millisecond adds never lose data", () => {
    it("serializes 10 concurrent adds so every item and quantity persists", async () => {
      const cart = await createGroupCart(app);

      // 10 contributors hammer the same cart in the same millisecond,
      // each adding one Chicken Biryani. The per-token mutex must
      // serialize the read-modify-write so the final quantity is 10.
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          addToCart(
            app,
            cart.group_cart_token,
            CONTRIBUTOR_A,
            CHICKEN_BIRYANI,
            1,
          ).then((r) => {
            expect(r.status).toBe(200);
            return r;
          }),
        ),
      );
      expect(results).toHaveLength(10);

      const last = results[9]!.body.data;
      // Contributions are stored as per-contributor lines so the live cart
      // can attribute each item to an avatar/name.
      expect(last.order.items).toHaveLength(10);
      for (const line of last.order.items) {
        expect(line.quantity).toBe(1);
      }
      expect(last.cart.item_count).toBe(10);
      const expectedTotal = calculatePriceBreakdown(
        Array.from({ length: 10 }, () => ({
          menu_item_id: CHICKEN_BIRYANI,
          name: "Chicken Biryani",
          base_price: 220,
          quantity: 1,
          customizations: [],
        })),
      ).total_amount;
      expect(last.cart.total_amount).toBe(expectedTotal);

      // All 10 adds are attributed to a single merged contributor row
      // (one avatar per user) with every item recorded.
      const aContributions = last.cart.contributors.filter(
        (c: { user_id: string }) => c.user_id === CONTRIBUTOR_A,
      );
      expect(aContributions).toHaveLength(1);
      expect(aContributions[0]?.items).toHaveLength(10);
      expect(last.cart.contributors).toHaveLength(2); // host + A
    });

    it("concurrent adds of DISTINCT items all persist (no lost updates)", async () => {
      const cart = await createGroupCart(app);
      const distinct = [CHICKEN_BIRYANI, VEG_BIRYANI, CHICKEN_BIRYANI, VEG_BIRYANI, CHICKEN_BIRYANI];

      await Promise.all(
        distinct.map((menuItemId) =>
          addToCart(app, cart.group_cart_token, CONTRIBUTOR_A, menuItemId, 1).then(
            (r) => expect(r.status).toBe(200),
          ),
        ),
      );

      const snapshot = await request(app)
        .get(`/api/v1/orders/group/cart?token=${cart.group_cart_token}`)
        .expect(200);

      const items = snapshot.body.data.items;
      const chickenLines = items.filter(
        (i: { menu_item_id: string }) => i.menu_item_id === CHICKEN_BIRYANI,
      );
      const vegLines = items.filter(
        (i: { menu_item_id: string }) => i.menu_item_id === VEG_BIRYANI,
      );
      // No lost updates: all 3 chicken and 2 veg contributions persisted.
      expect(chickenLines).toHaveLength(3);
      expect(vegLines).toHaveLength(2);
      expect(snapshot.body.data.item_count).toBe(5);
    });
  });

  describe("GET /api/v1/orders/group/cart", () => {
    it("returns a live public snapshot for the share token", async () => {
      const cart = await createGroupCart(app);
      await addToCart(app, cart.group_cart_token, CONTRIBUTOR_A, CHICKEN_BIRYANI, 2);

      const res = await request(app)
        .get(`/api/v1/orders/group/cart?token=${cart.group_cart_token}`)
        .expect(200);

      expect(res.body.data.group_cart_token).toBe(cart.group_cart_token);
      expect(res.body.data.item_count).toBe(2);
      expect(res.body.data.status).toBe("DRAFT");
      expect(res.body.data.contributors.length).toBeGreaterThan(0);
    });

    it("404s for a bad token", async () => {
      const res = await request(app)
        .get("/api/v1/orders/group/cart?token=gc_bogus")
        .expect(404);
      expect(res.body.error.code).toBe("GROUP_CART_NOT_FOUND");
    });
  });
});

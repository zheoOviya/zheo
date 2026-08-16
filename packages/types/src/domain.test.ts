import { describe, expect, it } from "vitest";
import {
  MenuItemSchema,
  OrderItemSchema,
  OrderSchema,
  OrderStatusSchema,
  RestaurantSchema,
  UserRoleSchema,
  UserSchema,
} from "./domain";

describe("UserSchema", () => {
  it("accepts a valid consumer user", () => {
    const result = UserSchema.safeParse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      phone: "+919876543210",
      spice_tolerance: 3,
      role: "CONSUMER",
      created_at: new Date(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid phone number", () => {
    const result = UserSchema.safeParse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      phone: "abc",
    });
    expect(result.success).toBe(false);
  });

  it("defaults spice_tolerance to 3", () => {
    const result = UserSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      phone: "+919876543210",
      created_at: new Date(),
    });
    expect(result.spice_tolerance).toBe(3);
    expect(result.role).toBe("CONSUMER");
  });
});

describe("UserRoleSchema (RBAC)", () => {
  it("contains all 7 roles from the PRD", () => {
    const roles = UserRoleSchema.options;
    expect(roles).toEqual([
      "CONSUMER",
      "PENDING_VENDOR",
      "VENDOR_OWNER",
      "VENDOR_STAFF",
      "OPS_AGENT",
      "ADMIN",
      "SUPER_ADMIN",
    ]);
  });

  it("rejects unknown roles", () => {
    expect(UserRoleSchema.safeParse("INVADER").success).toBe(false);
  });
});

describe("OrderStatusSchema (13 SQL states)", () => {
  it("contains exactly the 13 PRD states in order", () => {
    expect(OrderStatusSchema.options).toEqual([
      "DRAFT",
      "PAYMENT_PENDING",
      "CONFIRMED",
      "PREPARING",
      "ALMOST_READY",
      "READY_FOR_PICKUP",
      "PICKED_UP",
      "CANCELLED",
      "REFUNDED",
      "PAYMENT_FAILED",
      "EXPIRED",
      "DISPUTED",
      "SETTLED",
    ]);
  });

  it("rejects an undefined state", () => {
    expect(OrderStatusSchema.safeParse("DELIVERING").success).toBe(false);
  });
});

describe("OrderSchema", () => {
  it("defaults status to DRAFT and pickup_otp to null", () => {
    const order = OrderSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      user_id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      restaurant_id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      total_amount: 245,
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(order.status).toBe("DRAFT");
    expect(order.pickup_otp).toBeNull();
  });

  it("enforces 6-digit pickup_otp", () => {
    const result = OrderSchema.safeParse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      user_id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      restaurant_id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      total_amount: 245,
      pickup_otp: "12345",
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(result.success).toBe(false);
  });
});

describe("OrderItemSchema", () => {
  const base = {
    id: "c0000000-0000-4000-8000-000000000001",
    order_id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    menu_item_id: "b0000000-0000-4000-8000-000000000001",
    name: "Chicken Biryani",
    base_price: 220,
    item_subtotal: 242.8,
    created_at: new Date(),
  };

  it("defaults quantity to 1 and customizations to empty array", () => {
    const item = OrderItemSchema.parse(base);
    expect(item.quantity).toBe(1);
    expect(item.customizations).toEqual([]);
    expect(item.customization_total).toBe(0);
  });

  it("accepts customizations with price deltas", () => {
    const item = OrderItemSchema.parse({
      ...base,
      quantity: 2,
      customizations: [
        { name: "Extra Spice", price_delta: 25 },
        { name: "No Onion", price_delta: 0 },
      ],
      customization_total: 25,
      item_subtotal: 490,
    });
    expect(item.customizations).toHaveLength(2);
    expect(item.customizations?.[0]?.price_delta).toBe(25);
    expect(item.quantity).toBe(2);
  });

  it("rejects negative base_price", () => {
    const result = OrderItemSchema.safeParse({ ...base, base_price: -5 });
    expect(result.success).toBe(false);
  });

  it("rejects zero quantity", () => {
    const result = OrderItemSchema.safeParse({ ...base, quantity: 0 });
    expect(result.success).toBe(false);
  });
});

describe("RestaurantSchema", () => {
  it("defaults commission_rate to 0.08 per pricing strategy", () => {
    const r = RestaurantSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      owner_id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      name: "Test",
      gst_number: "GST123",
      fssai_license: "FSSAI123",
      created_at: new Date(),
    });
    expect(r.commission_rate).toBe(0.08);
    expect(r.is_active).toBe(true);
  });
});

describe("MenuItemSchema", () => {
  it("accepts dietary_tags as a boolean record", () => {
    const item = MenuItemSchema.parse({
      id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      restaurant_id: "9b1deb4d-3b7d-4bad-9bdd-2b0b7b3dcb6d",
      name: "Veg Biryani",
      price: 150,
      dietary_tags: { vegan: true, spicy: false },
      customizations: [],
      created_at: new Date(),
    });
    expect(item.dietary_tags.vegan).toBe(true);
  });
});

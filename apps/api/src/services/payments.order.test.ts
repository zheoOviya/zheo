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

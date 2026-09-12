import { beforeEach, describe, expect, it } from "vitest";
import { MemoryOrderRepository } from "./orderRepository";
import type { OrderDTO } from "./orderRepository";
import type { OrderStatus } from "@snakzap/types";

// ============================================
// Memory CAS semantics for the fulfillment correctness primitives.
//
// MEMORY LIMITATION: these tests assert in-process control flow only. They do
// NOT claim locking, rollback or real concurrency; that is Postgres-only and
// proven by the real-PG harness.
// ============================================

const OID = "11111111-1111-4111-8111-111111111111";

function makeOrder(
  status: OrderStatus,
  pickupOtp: string | null = null,
  qrToken: string | null = null,
): OrderDTO {
  const now = new Date().toISOString();
  return {
    id: OID,
    user_id: "22222222-2222-4222-8222-222222222222",
    restaurant_id: "33333333-3333-4333-8333-333333333333",
    items: [],
    total_amount: 100,
    status,
    commission_rate: 0.08,
    commission_amount: 8,
    pickup_otp: pickupOtp,
    qr_token: qrToken,
    checked_in: false,
    scheduled_pickup_time: null,
    created_at: now,
    updated_at: now,
  };
}

describe("MemoryOrderRepository CAS primitives", () => {
  let repo: MemoryOrderRepository;

  beforeEach(() => {
    repo = new MemoryOrderRepository();
  });

  describe("transitionStatus", () => {
    it("R1 succeeds from the matching from-status", async () => {
      repo._seed(makeOrder("CONFIRMED"));
      const out = await repo.transitionStatus(OID, "CONFIRMED", "PREPARING");
      expect(out?.status).toBe("PREPARING");
    });

    it("R2 repeats the same transition as null", async () => {
      repo._seed(makeOrder("CONFIRMED"));
      await repo.transitionStatus(OID, "CONFIRMED", "PREPARING");
      expect(await repo.transitionStatus(OID, "CONFIRMED", "PREPARING")).toBeNull();
    });

    it("R3 wrong from-status is null and leaves state unchanged", async () => {
      repo._seed(makeOrder("CONFIRMED"));
      expect(await repo.transitionStatus(OID, "PREPARING", "ALMOST_READY")).toBeNull();
      expect((await repo.getById(OID))?.status).toBe("CONFIRMED");
    });

    it("R4 missing id is null", async () => {
      expect(await repo.transitionStatus(OID, "CONFIRMED", "PREPARING")).toBeNull();
    });
  });

  describe("claimPreparingWithOtp", () => {
    it("R5 sets PREPARING + OTP + QR in one logical mutation", async () => {
      repo._seed(makeOrder("CONFIRMED"));
      const out = await repo.claimPreparingWithOtp(OID, "CONFIRMED", "4321", "qr-token-abc");
      expect(out?.status).toBe("PREPARING");
      expect(out?.pickup_otp).toBe("4321");
      expect(out?.qr_token).toBe("qr-token-abc");
    });

    it("R6 repeat/wrong-state claim is null and does not overwrite OTP/QR", async () => {
      repo._seed(makeOrder("CONFIRMED"));
      await repo.claimPreparingWithOtp(OID, "CONFIRMED", "4321", "qr-1");
      expect(await repo.claimPreparingWithOtp(OID, "CONFIRMED", "9999", "qr-2")).toBeNull();
      const stored = await repo.getById(OID);
      expect(stored?.pickup_otp).toBe("4321");
      expect(stored?.qr_token).toBe("qr-1");
    });
  });

  describe("consumePickupOtp", () => {
    it("R7 correct OTP sets PICKED_UP and clears the OTP", async () => {
      repo._seed(makeOrder("READY_FOR_PICKUP", "1234"));
      const out = await repo.consumePickupOtp(OID, "READY_FOR_PICKUP", "1234");
      expect(out?.status).toBe("PICKED_UP");
      expect(out?.pickup_otp).toBeNull();
    });

    it("R8 wrong OTP is null and leaves state/OTP intact", async () => {
      repo._seed(makeOrder("READY_FOR_PICKUP", "1234"));
      expect(await repo.consumePickupOtp(OID, "READY_FOR_PICKUP", "9999")).toBeNull();
      const stored = await repo.getById(OID);
      expect(stored?.status).toBe("READY_FOR_PICKUP");
      expect(stored?.pickup_otp).toBe("1234");
    });

    it("R9 repeated correct OTP after success is null (single-use)", async () => {
      repo._seed(makeOrder("READY_FOR_PICKUP", "1234"));
      await repo.consumePickupOtp(OID, "READY_FOR_PICKUP", "1234");
      expect(await repo.consumePickupOtp(OID, "READY_FOR_PICKUP", "1234")).toBeNull();
    });
  });
});

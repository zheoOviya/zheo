import { beforeEach, describe, expect, it } from "vitest";
import { onEvent } from "../lib/eventBus";
import {
  LoyaltyService,
  REFERRAL_BONUS,
  STAMP_CARD_SIZE,
} from "./loyalty";
import { MemoryLoyaltyRepository } from "../repositories/loyaltyRepository";
import { MemoryOrderRepository } from "../repositories/orderRepository";
import type { OrderDTO, OrderItemDTO } from "../repositories/orderRepository";

// ============================================
// Loyalty context (L05 Refer & Earn + L01 Stamp Card) unit tests
// ============================================

const REFERRER_ID = "00000000-0000-4000-8000-0000000000a1";
const CLAIMANT_A = "00000000-0000-4000-8000-0000000000b1";
const CLAIMANT_B = "00000000-0000-4000-8000-0000000000b2";
const REST_ID = "a0000000-0000-4000-8000-000000000001";

let repo: MemoryLoyaltyRepository;
let orderRepo: MemoryOrderRepository;
let service: LoyaltyService;
let referralEvents: Array<{ referrer_user_id: string; claimant_user_id: string }>;
let stampRewardEvents: Array<{ stamp_count_before: number; rewards_earned: number }>;

function seedOrder(id: string): OrderDTO {
  const item: OrderItemDTO = {
    id: `itm-${id}`,
    menu_item_id: "b0000000-0000-4000-8000-000000000001",
    name: "Chicken Biryani",
    base_price: 220,
    quantity: 1,
    customizations: [],
    customization_total: 0,
    item_subtotal: 220,
    gift_id: null,
  };
  return orderRepo._seed({
    id,
    user_id: CLAIMANT_A,
    restaurant_id: REST_ID,
    items: [item],
    total_amount: 231,
    status: "PICKED_UP",
    commission_rate: 0.08,
    commission_amount: 0,
    pickup_otp: "1234",
    qr_token: null,
    checked_in: false,
    scheduled_pickup_time: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

describe("LoyaltyService", () => {
  beforeEach(() => {
    repo = new MemoryLoyaltyRepository();
    orderRepo = new MemoryOrderRepository();
    service = new LoyaltyService(repo, orderRepo);
    referralEvents = [];
    stampRewardEvents = [];
  });

  describe("L05 Refer & Earn", () => {
    it("issues a stable referral code per user", async () => {
      const code1 = await service.getReferralProfile(CLAIMANT_A);
      const code2 = await service.getReferralProfile(CLAIMANT_A);
      expect(code1.referral_code).toMatch(/^SNKZ-[A-Z0-9]{6}$/);
      expect(code2.referral_code).toBe(code1.referral_code);
      expect(code1.bonus_amount).toBe(REFERRAL_BONUS);
      expect(code1.balance).toBe(0);
    });

    it("credits Rs 50 to referrer AND claimant on a successful claim", async () => {
      const code = (await service.getReferralProfile(REFERRER_ID)).referral_code;

      const result = await service.applyReferral({
        claimantUserId: CLAIMANT_A,
        referralCode: code,
        ipAddress: "203.0.113.10",
        deviceFingerprint: "fp_claimant_a",
      });

      expect(result.claimed).toBe(true);
      expect(result.bonus_amount).toBe(REFERRAL_BONUS);
      expect(result.balance).toBe(REFERRAL_BONUS);

      const referrerWallet = await repo.getWallet(REFERRER_ID);
      expect(referrerWallet.balance).toBe(REFERRAL_BONUS);

      const claim = await repo.hasUserClaimed(CLAIMANT_A);
      expect(claim).toBe(true);
      expect(await repo.hasClaimedByIp("203.0.113.10")).toBe(true);
      expect(await repo.hasClaimedByDevice("fp_claimant_a")).toBe(true);
    });

    it("rejects an unknown referral code", async () => {
      await expect(
        service.applyReferral({
          claimantUserId: CLAIMANT_A,
          referralCode: "SNKZ-NOPE99",
          ipAddress: "203.0.113.10",
        }),
      ).rejects.toMatchObject({ code: "INVALID_REFERRAL_CODE", status: 400 });
    });

    it("rejects self-referral", async () => {
      const code = (await service.getReferralProfile(CLAIMANT_A)).referral_code;
      await expect(
        service.applyReferral({
          claimantUserId: CLAIMANT_A,
          referralCode: code,
          ipAddress: "203.0.113.10",
        }),
      ).rejects.toMatchObject({ code: "SELF_REFERRAL", status: 400 });
    });

    it("rejects a second use by the same account", async () => {
      const code = (await service.getReferralProfile(REFERRER_ID)).referral_code;
      await service.applyReferral({
        claimantUserId: CLAIMANT_A,
        referralCode: code,
        ipAddress: "203.0.113.10",
        deviceFingerprint: "fp_a",
      });
      await expect(
        service.applyReferral({
          claimantUserId: CLAIMANT_A,
          referralCode: code,
          ipAddress: "203.0.113.11",
          deviceFingerprint: "fp_b",
        }),
      ).rejects.toMatchObject({ code: "REFERRAL_ALREADY_USED", status: 400 });
    });

    it("FRAUD: a second claim from the same IP is rejected 403", async () => {
      const code = (await service.getReferralProfile(REFERRER_ID)).referral_code;

      const first = await service.applyReferral({
        claimantUserId: CLAIMANT_A,
        referralCode: code,
        ipAddress: "198.51.100.7",
        deviceFingerprint: "fp_a",
      });
      expect(first.claimed).toBe(true);

      // A different account on the same network must be blocked.
      await expect(
        service.applyReferral({
          claimantUserId: CLAIMANT_B,
          referralCode: code,
          ipAddress: "198.51.100.7",
          deviceFingerprint: "fp_b",
        }),
      ).rejects.toMatchObject({ code: "FRAUD_DETECTED", status: 403 });

      const blocked = await repo.hasClaimedByIp("198.51.100.7");
      expect(blocked).toBe(true);
      // The blocked claim must never have credited the bonus.
      const wallet = await repo.getWallet(CLAIMANT_B);
      expect(wallet.balance).toBe(0);
    });

    it("FRAUD: a second claim from the same device is rejected 403", async () => {
      const code = (await service.getReferralProfile(REFERRER_ID)).referral_code;

      await service.applyReferral({
        claimantUserId: CLAIMANT_A,
        referralCode: code,
        ipAddress: "198.51.100.10",
        deviceFingerprint: "fp_shared_device",
      });

      // Same device fingerprint, different IP - device gate catches it.
      await expect(
        service.applyReferral({
          claimantUserId: CLAIMANT_B,
          referralCode: code,
          ipAddress: "198.51.100.11",
          deviceFingerprint: "fp_shared_device",
        }),
      ).rejects.toMatchObject({ code: "FRAUD_DETECTED", status: 403 });
    });

    it("emits ReferralClaimed on success", async () => {
      onEvent("ReferralClaimed", async (event) => {
        const payload = event.payload as {
          referrer_user_id: string;
          claimant_user_id: string;
        };
        referralEvents.push(payload);
      });

      const code = (await service.getReferralProfile(REFERRER_ID)).referral_code;
      await service.applyReferral({
        claimantUserId: CLAIMANT_A,
        referralCode: code,
        ipAddress: "203.0.113.99",
        deviceFingerprint: "fp_emit",
      });

      expect(referralEvents).toHaveLength(1);
      expect(referralEvents[0]).toMatchObject({
        referrer_user_id: REFERRER_ID,
        claimant_user_id: CLAIMANT_A,
      });
    });
  });

  describe("L01 Stamp Card", () => {
    it("increments the card on OrderPickedUp", async () => {
      seedOrder("order-1");
      const card = await service.onOrderPickedUp("order-1");
      expect(card?.stamp_count).toBe(1);
      expect(card?.total_orders).toBe(1);
      expect(card?.rewards_earned).toBe(0);

      seedOrder("order-2");
      const card2 = await service.onOrderPickedUp("order-2");
      expect(card2?.stamp_count).toBe(2);
      expect(card2?.reward_type).toBe("FREE_ITEM");
    });

    it("is per-restaurant: a second restaurant gets its own card", async () => {
      seedOrder("order-1");
      await service.onOrderPickedUp("order-1");

      const otherOrder: OrderDTO = {
        ...(await orderRepo.getById("order-1"))!,
        id: "order-2",
        restaurant_id: "a0000000-0000-4000-8000-000000000002",
      };
      orderRepo._seed(otherOrder);
      const card = await service.onOrderPickedUp("order-2");

      expect(card?.restaurant_id).toBe("a0000000-0000-4000-8000-000000000002");
      expect(card?.stamp_count).toBe(1);
      expect(card?.stamp_count).not.toBe(2);
    });

    it("unlocks a free item exactly at 10 stamps, resets, and emits the event", async () => {
      onEvent("StampCardRewardUnlocked", async (event) => {
        const payload = event.payload as {
          stamp_count_before: number;
          rewards_earned: number;
        };
        stampRewardEvents.push(payload);
      });

      for (let i = 1; i <= STAMP_CARD_SIZE; i += 1) {
        const id = `order-${i}`;
        seedOrder(id);
        const result = await service.onOrderPickedUp(id);
        if (i < STAMP_CARD_SIZE) {
          expect(result?.stamp_count).toBe(i);
          expect(result?.rewards_earned).toBe(0);
        } else {
          // 10th pickup: reward unlocked, count resets to 0.
          expect(result?.stamp_count).toBe(0);
          expect(result?.rewards_earned).toBe(1);
        }
      }

      expect(stampRewardEvents).toHaveLength(1);
      expect(stampRewardEvents[0]).toMatchObject({
        stamp_count_before: STAMP_CARD_SIZE - 1,
        rewards_earned: 1,
      });

      // Next pickup starts a fresh cycle.
      seedOrder("order-11");
      const next = await service.onOrderPickedUp("order-11");
      expect(next?.stamp_count).toBe(1);
      expect(next?.rewards_earned).toBe(1);
    });
  });
});

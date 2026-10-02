import type { Express } from "express";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================
// EVT-B2B-NP2 — remaining scoped producer transactional outbox wiring.
//
// Proves the scoped producers (fulfillment advance, gift expiry, referral
// claim, VIP ticket, spice profile, POS menu sync) enqueue their events on the
// SAME commit boundary as the business write and no longer direct-emit.
//
// MEMORY_MODE = NON_DURABLE_TEST_PARITY: the passthrough port has no rollback
// and no concurrency guarantee, so this file proves enqueue/CAS/failure control
// flow and the removal of the direct emit path. Real rollback atomicity is
// proven against PostgreSQL by realPgB2bNp2Atomicity.ts.
// ============================================

import { createApp } from "../app";
import * as eventBus from "../lib/eventBus";
import { resetRedisForTests } from "../lib/redis";
import { sharedIdentityRepo } from "../repositories/shared";
import { jwtService } from "../services/jwt";
import { FulfillmentService } from "../services/fulfillment";
import { runGiftExpirySweep } from "../services/giftExpirySweep";
import { LoyaltyService, REFERRAL_BONUS } from "../services/loyalty";
import { VipSupportService } from "../services/vipSupport";
import { MenuSyncService, MockPosMenuClient } from "../services/menuSync";
import { EventOutboxRelay } from "../services/eventOutboxRelay";
import {
  MemoryFulfillmentTransactionPort,
  type FulfillmentTransactionPort,
  type FulfillmentTxRepos,
} from "../repositories/fulfillmentAtomicityContracts";
import {
  MemoryProducerTransactionPort,
  type GiftExpiryTxRepos,
  type MenuSyncTxRepos,
  type ReferralTxRepos,
  type VipTicketTxRepos,
} from "../repositories/producerRemainingAtomicityContracts";
import { memoryEventOutbox } from "../repositories/memoryEventOutbox";
import {
  outboxRowToEnvelope,
  type EventOutboxRepository,
  type EventOutboxRow,
} from "../repositories/eventOutboxRepository";
import { MemoryOrderRepository } from "../repositories/orderRepository";
import type { OrderDTO } from "../repositories/orderRepository";
import { MemoryGiftRepository, type GiftDTO } from "../repositories/giftRepository";
import { MemoryPaymentRepository } from "../repositories/paymentRepository";
import { MemoryLoyaltyRepository } from "../repositories/loyaltyRepository";
import { MemoryAuditRepository } from "../repositories/auditRepository";
import { MemorySupportRepository } from "../repositories/supportRepository";
import { MemoryCatalogRepository } from "../repositories/catalogRepository";
import { SEED_MENU, SEED_RESTAURANTS } from "../seed/catalogData";
import type { OrderStatus } from "@snakzap/types";

const OID = "11111111-1111-4111-8111-111111111111";
const UID = "22222222-2222-4222-8222-222222222222";
const REFERRER_ID = "00000000-0000-4000-8000-0000000000a1";
const CLAIMANT_A = "00000000-0000-4000-8000-0000000000b1";
const CLAIMANT_B = "00000000-0000-4000-8000-0000000000b2";
const REST_ID = "a0000000-0000-4000-8000-000000000001";

const rowsFor = (name: string): EventOutboxRow[] =>
  memoryEventOutbox._all().filter((r) => r.event_name === name);

function orderDto(
  id: string,
  status: OrderStatus,
  opts: { otp?: string; scheduled?: string } = {},
): OrderDTO {
  const now = new Date().toISOString();
  return {
    id,
    user_id: UID,
    restaurant_id: REST_ID,
    items: [],
    total_amount: 100,
    status,
    commission_rate: 0.08,
    commission_amount: 8,
    pickup_otp: opts.otp ?? null,
    checked_in: false,
    scheduled_pickup_time: opts.scheduled ?? null,
    created_at: now,
    updated_at: now,
  };
}

class RacingOrderRepository extends MemoryOrderRepository {
  loseNextClaim = false;

  override async claimPreparingWithOtp(
    orderId: string,
    fromStatus: OrderStatus,
    otp: string,
  ): Promise<OrderDTO | null> {
    if (this.loseNextClaim) {
      this.loseNextClaim = false;
      return null;
    }
    return super.claimPreparingWithOtp(orderId, fromStatus, otp);
  }
}

const throwingOutbox = (): Pick<EventOutboxRepository, "enqueue"> => ({
  enqueue: async () => {
    throw new Error("np2_outbox_failure");
  },
});

function fulfillmentHarness(
  orders: MemoryOrderRepository,
  outbox: Pick<EventOutboxRepository, "enqueue"> = memoryEventOutbox,
) {
  const gifts = new MemoryGiftRepository();
  const port: FulfillmentTransactionPort = new MemoryFulfillmentTransactionPort(
    (): FulfillmentTxRepos => ({ orders, gifts, outbox }),
  );
  return { service: new FulfillmentService(orders, gifts, port), gifts };
}

function referralHarness(
  audit: Pick<MemoryAuditRepository, "log"> = new MemoryAuditRepository(),
) {
  const loyalty = new MemoryLoyaltyRepository();
  const orders = new MemoryOrderRepository();
  const port = new MemoryProducerTransactionPort<ReferralTxRepos>(() => ({
    loyalty,
    audit,
    outbox: memoryEventOutbox,
  }));
  return {
    loyalty,
    service: new LoyaltyService(loyalty, orders, port),
  };
}

describe("EVT-B2B-NP2 remaining producer transactional outbox", () => {
  beforeEach(() => {
    memoryEventOutbox._reset();
    resetRedisForTests();
    vi.clearAllMocks();
  });

  // ---------------- Fulfillment advance ----------------

  describe("fulfillment advance", () => {
    it("NP2-F1 CONFIRMED->PREPARING enqueues exactly one OrderPreparationStarted", async () => {
      const orders = new MemoryOrderRepository();
      orders._seed(orderDto(OID, "CONFIRMED"));
      const { service } = fulfillmentHarness(orders);

      const res = await service.advanceOrderStatus(OID);
      expect(res.order.status).toBe("PREPARING");
      expect(res.order.pickup_otp).toMatch(/^\d{4}$/);

      const rows = rowsFor("OrderPreparationStarted");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.aggregate_id).toBe(OID);
      expect(rows[0]?.status).toBe("PENDING");
      expect(rows[0]?.payload).toEqual({ order_id: OID, restaurant_id: REST_ID });
    });

    it("NP2-F2 ALMOST_READY->READY_FOR_PICKUP enqueues OrderReadyForPickup", async () => {
      const orders = new MemoryOrderRepository();
      orders._seed(orderDto(OID, "ALMOST_READY"));
      const { service } = fulfillmentHarness(orders);

      await service.advanceOrderStatus(OID);
      const rows = rowsFor("OrderReadyForPickup");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.aggregate_id).toBe(OID);
      expect(rowsFor("EarlyReadyAlert")).toHaveLength(0);
    });

    it("NP2-F3 early ready shares the READY transaction (ReadyForPickup + EarlyReadyAlert together)", async () => {
      const orders = new MemoryOrderRepository();
      const future = new Date(Date.now() + 3_600_000).toISOString();
      orders._seed(orderDto(OID, "ALMOST_READY", { scheduled: future }));
      const { service } = fulfillmentHarness(orders);

      const res = await service.advanceOrderStatus(OID);
      expect(res.nextStatus).toBe("READY_FOR_PICKUP");
      expect(res.earlyReadyAlerted).toBe(true);
      expect(rowsFor("OrderReadyForPickup")).toHaveLength(1);
      const early = rowsFor("EarlyReadyAlert");
      expect(early).toHaveLength(1);
      expect(early[0]?.payload).toMatchObject({
        order_id: OID,
        restaurant_id: REST_ID,
        scheduled_pickup_time: future,
      });
      // Both rows belong to the same aggregate transition; no event landed in a
      // second post-commit window.
      expect(memoryEventOutbox._all()).toHaveLength(2);
    });

    it("NP2-F4 a lost CAS enqueues zero rows", async () => {
      const orders = new RacingOrderRepository();
      orders._seed(orderDto(OID, "CONFIRMED"));
      orders.loseNextClaim = true;
      const { service } = fulfillmentHarness(orders);

      await expect(service.advanceOrderStatus(OID)).rejects.toMatchObject({
        code: "CONCURRENT_MODIFICATION",
        status: 409,
      });
      expect(memoryEventOutbox._all()).toHaveLength(0);
    });

    it("NP2-F5 an enqueue failure rejects and persists no event row", async () => {
      const orders = new MemoryOrderRepository();
      orders._seed(orderDto(OID, "CONFIRMED"));
      const { service } = fulfillmentHarness(orders, throwingOutbox());

      await expect(service.advanceOrderStatus(OID)).rejects.toThrow(
        "np2_outbox_failure",
      );
      expect(memoryEventOutbox._all()).toHaveLength(0);
    });

    it("NP2-F6 a successful transition yields exactly one logical row", async () => {
      const orders = new MemoryOrderRepository();
      orders._seed(orderDto(OID, "PREPARING", { otp: "1234" }));
      const { service } = fulfillmentHarness(orders);

      await service.advanceOrderStatus(OID);
      expect(rowsFor("OrderPreparationStarted")).toHaveLength(0);
      expect(rowsFor("OrderReadyForPickup")).toHaveLength(0);
      expect(memoryEventOutbox._all()).toHaveLength(0);
    });
  });

  // ---------------- Gift expiry ----------------

  describe("gift expiry", () => {
    it("NP2-G1 a successful expiry enqueues exactly one GiftExpired", async () => {
      const gifts = new MemoryGiftRepository();
      await seedExpiredGiftInto(gifts, "ACTIVE");
      const port = new MemoryProducerTransactionPort<GiftExpiryTxRepos>(() => ({
        gifts,
        outbox: memoryEventOutbox,
      }));

      const result = await runGiftExpirySweep(
        gifts,
        new MemoryPaymentRepository(),
        new Date(),
        port,
      );
      expect(result.expired).toBe(1);
      const rows = rowsFor("GiftExpired");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toEqual({ gift_id: rows[0]?.aggregate_id });
    });

    it("NP2-G2 a CAS miss (bound gift) enqueues zero rows", async () => {
      const gifts = new MemoryGiftRepository();
      const gift = await seedExpiredGiftInto(gifts, "CLAIMED");
      await gifts.bindToOrder(gift.id, "order-in-flight");
      const port = new MemoryProducerTransactionPort<GiftExpiryTxRepos>(() => ({
        gifts,
        outbox: memoryEventOutbox,
      }));

      const result = await runGiftExpirySweep(
        gifts,
        new MemoryPaymentRepository(),
        new Date(),
        port,
      );
      expect(result.expired).toBe(0);
      expect(rowsFor("GiftExpired")).toHaveLength(0);
    });

    it("NP2-G3 an enqueue failure is isolated per item and persists no row", async () => {
      const gifts = new MemoryGiftRepository();
      await seedExpiredGiftInto(gifts, "ACTIVE");
      const port = new MemoryProducerTransactionPort<GiftExpiryTxRepos>(() => ({
        gifts,
        outbox: throwingOutbox(),
      }));

      const result = await runGiftExpirySweep(
        gifts,
        new MemoryPaymentRepository(),
        new Date(),
        port,
      );
      expect(result.failed).toBe(1);
      expect(rowsFor("GiftExpired")).toHaveLength(0);
    });
  });

  // ---------------- Referral claim ----------------

  describe("referral claim", () => {
    it("NP2-R1 one transaction records the claim, credits both wallets, audits and enqueues", async () => {
      const audit = new MemoryAuditRepository();
      const { service, loyalty } = referralHarness(audit);
      const code = (await service.getReferralProfile(REFERRER_ID)).referral_code;

      const result = await service.applyReferral({
        claimantUserId: CLAIMANT_A,
        referralCode: code,
        ipAddress: "203.0.113.10",
        deviceFingerprint: "fp_np2_a",
      });

      expect(result.claimed).toBe(true);
      expect(result.balance).toBe(REFERRAL_BONUS);
      expect((await loyalty.getWallet(REFERRER_ID)).balance).toBe(REFERRAL_BONUS);
      expect((await loyalty.getWallet(CLAIMANT_A)).balance).toBe(REFERRAL_BONUS);
      expect((await loyalty.hasUserClaimed(CLAIMANT_A))).toBe(true);
      expect((await audit.all()).some((a) => a.action === "referral_applied")).toBe(true);

      const rows = rowsFor("ReferralClaimed");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toMatchObject({
        referrer_user_id: REFERRER_ID,
        claimant_user_id: CLAIMANT_A,
        bonus_amount: REFERRAL_BONUS,
      });
    });

    it("NP2-R2 a failure after partial progress rejects and enqueues no ReferralClaimed row", async () => {
      // MEMORY rollback is NOT proven here: MEMORY_ATOMICITY_GUARANTEE = NONE
      // (the passthrough port cannot roll back partial business writes). This
      // case only proves control flow + zero outbox enqueue on the failure.
      // Authoritative full rollback proof (claim + both wallets + ledger +
      // audit + outbox) = NP2-PG-R2 in integration/realPgB2bNp2Atomicity.ts.
      const throwingAudit = {
        log: async () => {
          throw new Error("np2_audit_failure");
        },
      } as unknown as MemoryAuditRepository;
      const { service } = referralHarness(throwingAudit);
      const code = (await service.getReferralProfile(REFERRER_ID)).referral_code;

      await expect(
        service.applyReferral({
          claimantUserId: CLAIMANT_A,
          referralCode: code,
          ipAddress: "203.0.113.20",
          deviceFingerprint: "fp_np2_b",
        }),
      ).rejects.toThrow("np2_audit_failure");
      expect(rowsFor("ReferralClaimed")).toHaveLength(0);
    });

    it("NP2-R3 a fraud-blocked claim enqueues no event and credits nothing", async () => {
      const { service, loyalty } = referralHarness();
      const code = (await service.getReferralProfile(REFERRER_ID)).referral_code;

      await service.applyReferral({
        claimantUserId: CLAIMANT_A,
        referralCode: code,
        ipAddress: "198.51.100.7",
        deviceFingerprint: "fp_np2_c",
      });
      await expect(
        service.applyReferral({
          claimantUserId: CLAIMANT_B,
          referralCode: code,
          ipAddress: "198.51.100.7",
          deviceFingerprint: "fp_np2_d",
        }),
      ).rejects.toMatchObject({ code: "FRAUD_DETECTED", status: 403 });

      expect(rowsFor("ReferralClaimed")).toHaveLength(1);
      expect((await loyalty.getWallet(CLAIMANT_B)).balance).toBe(0);
    });
  });

  // ---------------- VIP ticket ----------------

  describe("VIP ticket", () => {
    it("NP2-V1 createTicket enqueues exactly one VipTicketCreated", async () => {
      const orders = new MemoryOrderRepository();
      const support = new MemorySupportRepository();
      const port = new MemoryProducerTransactionPort<VipTicketTxRepos>(() => ({
        support,
        outbox: memoryEventOutbox,
      }));
      const service = new VipSupportService(orders, support, port);

      const ticket = await service.createTicket(UID, "Cold food", "Arrived cold");
      const rows = rowsFor("VipTicketCreated");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.aggregate_id).toBe(ticket.id);
      expect(rows[0]?.payload).toMatchObject({ ticket_id: ticket.id, user_id: UID });
    });

    it("NP2-V2 a support-create failure rejects and persists no event row", async () => {
      const orders = new MemoryOrderRepository();
      const support = new MemorySupportRepository();
      support.create = async () => {
        throw new Error("np2_support_failure");
      };
      const port = new MemoryProducerTransactionPort<VipTicketTxRepos>(() => ({
        support,
        outbox: memoryEventOutbox,
      }));
      const service = new VipSupportService(orders, support, port);

      await expect(service.createTicket(UID, "Cold food", "x")).rejects.toThrow(
        "np2_support_failure",
      );
      expect(memoryEventOutbox._all()).toHaveLength(0);
    });
  });

  // ---------------- Spice profile (route) ----------------

  describe("spice profile", () => {
    let app: Express;

    function auth(userId: string) {
      return {
        Authorization: `Bearer ${jwtService.signAccessToken({
          sub: userId,
          phone: "+919876543210",
          role: "CONSUMER",
          device_fingerprint: "fp_np2_spice",
        })}`,
      };
    }

    beforeEach(() => {
      sharedIdentityRepo._reset();
      app = createApp();
    });

    it("NP2-U1 PUT /users/profile enqueues SpiceProfileUpdated", async () => {
      sharedIdentityRepo._seed({ id: UID, phone: "+919876500001", role: "CONSUMER" } as never);

      await request(app)
        .put("/api/v1/users/profile")
        .set(auth(UID))
        .send({ spice_tolerance: 4 })
        .expect(200);

      const rows = rowsFor("SpiceProfileUpdated");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.aggregate_id).toBe(UID);
      expect(rows[0]?.payload).toMatchObject({ user_id: UID, spice_tolerance: 4 });
    });

    it("NP2-U2 an unknown user returns 404 and enqueues nothing", async () => {
      await request(app)
        .put("/api/v1/users/profile")
        .set(auth(UID))
        .send({ spice_tolerance: 4 })
        .expect(404);
      expect(rowsFor("SpiceProfileUpdated")).toHaveLength(0);
    });
  });

  // ---------------- POS menu sync ----------------

  describe("POS menu sync", () => {
    function menuService(catalog: MemoryCatalogRepository) {
      const port = new MemoryProducerTransactionPort<MenuSyncTxRepos>(() => ({
        catalog,
        outbox: memoryEventOutbox,
      }));
      return new MenuSyncService(catalog, new MockPosMenuClient(), port);
    }

    it("NP2-M1 a successful sync enqueues exactly one PosMenuSynced", async () => {
      const catalog = new MemoryCatalogRepository(SEED_RESTAURANTS, SEED_MENU);
      const service = menuService(catalog);

      const result = await service.syncMenu(REST_ID);
      expect(result.synced).toBeGreaterThan(0);
      const rows = rowsFor("PosMenuSynced");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.aggregate_id).toBe(REST_ID);
      expect(rows[0]?.payload).toEqual({
        restaurant_id: REST_ID,
        synced_count: result.synced,
      });
    });

    it("NP2-M2 a mid-sync upsert failure rejects and enqueues nothing", async () => {
      const catalog = new MemoryCatalogRepository(SEED_RESTAURANTS, SEED_MENU);
      catalog.upsertPosMenuItems = async () => {
        throw new Error("np2_menu_failure");
      };
      const service = menuService(catalog);

      await expect(service.syncMenu(REST_ID)).rejects.toThrow("np2_menu_failure");
      expect(rowsFor("PosMenuSynced")).toHaveLength(0);
    });
  });

  // ---------------- direct emit removal + relaying ----------------

  describe("no direct emit / durable delivery", () => {
    it("NP2-D1 the scoped producers no longer call the direct emit path", async () => {
      const emitSpy = vi.spyOn(eventBus, "emit");
      const audit = new MemoryAuditRepository();
      const { service } = referralHarness(audit);
      const code = (await service.getReferralProfile(REFERRER_ID)).referral_code;
      await service.applyReferral({
        claimantUserId: CLAIMANT_A,
        referralCode: code,
        ipAddress: "203.0.113.30",
        deviceFingerprint: "fp_np2_d1",
      });
      expect(emitSpy).not.toHaveBeenCalled();
    });

    it("NP2-D2 / NP2-ID1 the relay delivers the persisted event_id intact", async () => {
      const audit = new MemoryAuditRepository();
      const { service } = referralHarness(audit);
      const code = (await service.getReferralProfile(REFERRER_ID)).referral_code;
      await service.applyReferral({
        claimantUserId: CLAIMANT_A,
        referralCode: code,
        ipAddress: "203.0.113.40",
        deviceFingerprint: "fp_np2_d2",
      });

      const row = rowsFor("ReferralClaimed")[0]!;
      expect(outboxRowToEnvelope(row).event_id).toBe(row.event_id);

      const published: string[] = [];
      const relay = new EventOutboxRelay({
        repo: memoryEventOutbox,
        now: () => new Date(),
        publish: async (env) => {
          published.push(env.event_id);
        },
      });
      await relay.tick();
      expect(published).toContain(row.event_id);
      expect(rowsFor("ReferralClaimed")).toHaveLength(0);
    });
  });
});

async function seedExpiredGiftInto(
  repo: MemoryGiftRepository,
  status: GiftDTO["status"],
): Promise<GiftDTO> {
  const gift = await repo.create({
    sender_id: "55555555-5555-4555-8555-555555555555",
    restaurant_id: REST_ID,
    menu_item_id: "44444444-4444-4444-8444-444444444444",
    item_snapshot: {
      name: "Gift Meal",
      price: 0,
      image_url: null,
      dietary_tags: {},
      spice_level: 0,
      customizations: [],
    },
    price_paid: 100,
    message: null,
    recipient_name: null,
    claim_token: randomUUID(),
    claim_code: "123456",
    expires_at: new Date(Date.now() - 86_400_000).toISOString(),
  });
  await repo.markPaid(gift.id);
  if (status === "CLAIMED") await repo.markClaimed(gift.id, "recipient");
  const row = await repo.getById(gift.id);
  if (!row) throw new Error("gift fixture failed");
  return row;
}

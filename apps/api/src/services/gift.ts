import { randomBytes } from "node:crypto";
import { AppError } from "../middleware/envelope";
import { createEventEnvelope, emit } from "../lib/eventBus";
import type { CatalogRepository } from "../repositories/catalogRepository";
import type { GiftRepository, GiftDTO } from "../repositories/giftRepository";
import type { PaymentRepository } from "../repositories/paymentRepository";
import type { CustomizationDelta } from "./pricing";
import { resolveCatalogCustomizations } from "./pricing";
import { isRazorpayMockMode, razorpayService } from "./razorpay";

export const GIFT_TTL_DAYS = 90;

export interface CreateGiftInput {
  sender_id: string;
  restaurant_id: string;
  menu_item_id: string;
  customizations: CustomizationDelta[];
  message?: string;
  recipient_name?: string;
}

export interface GiftLanding {
  gift: GiftDTO;
  restaurant: { name: string; image_url: string | null } | null;
  sender_display: string;
  claimable: boolean;
  claim_block_reason?: string;
}

export class GiftService {
  constructor(
    private readonly giftRepo: GiftRepository,
    private readonly paymentRepo: PaymentRepository,
    private readonly catalogRepo: CatalogRepository,
  ) {}

  private async ensureGift(id: string): Promise<GiftDTO> {
    const gift = await this.giftRepo.getById(id);
    if (!gift) throw new AppError("GIFT_NOT_FOUND", "Gift not found", 404);
    return gift;
  }

  private async ensureGiftByToken(token: string): Promise<GiftDTO> {
    const gift = await this.giftRepo.getByToken(token);
    if (!gift) throw new AppError("GIFT_NOT_FOUND", "Gift not found", 404);
    return gift;
  }

  /**
   * Price is always server-computed from the catalog: base price + the
   * customization prices resolved from the menu item's own catalog entry.
   * The sender-supplied `price_delta` is never a monetary input.
   */
  async create(input: CreateGiftInput): Promise<GiftDTO> {
    const restaurant = await this.catalogRepo.getRestaurantById(input.restaurant_id);
    if (!restaurant || !restaurant.is_active) {
      throw new AppError("RESTAURANT_NOT_FOUND", "Restaurant not found or inactive", 404);
    }
    const menuItem = await this.catalogRepo.getMenuItemById(input.menu_item_id);
    if (!menuItem || !menuItem.is_available) {
      throw new AppError("ITEM_NOT_FOUND", "Menu item not found or unavailable", 404);
    }
    if (menuItem.restaurant_id !== input.restaurant_id) {
      throw new AppError(
        "ITEM_RESTAURANT_MISMATCH",
        `Item ${input.menu_item_id} does not belong to restaurant ${input.restaurant_id}`,
        400,
      );
    }

    const resolvedCustomizations = resolveCatalogCustomizations(
      menuItem.customizations ?? [],
      input.customizations,
    );
    const customizationTotal = resolvedCustomizations.reduce((s, c) => s + c.price_delta, 0);
    const pricePaid = menuItem.price + customizationTotal;
    if (pricePaid <= 0) {
      throw new AppError("INVALID_PRICE", "Gift price must be positive", 400);
    }

    const claimToken = randomBytes(16).toString("hex");
    const claimCode = randomBytes(4).toString("hex").toUpperCase();

    return this.giftRepo.create({
      sender_id: input.sender_id,
      restaurant_id: input.restaurant_id,
      menu_item_id: input.menu_item_id,
      item_snapshot: {
        name: menuItem.name,
        price: menuItem.price,
        image_url: menuItem.image_url ?? null,
        dietary_tags: menuItem.dietary_tags ?? {},
        spice_level: menuItem.spice_level ?? 3,
        customizations: resolvedCustomizations.map((c) => ({
          name: c.name,
          price_delta: c.price_delta,
        })),
      },
      price_paid: pricePaid,
      message: input.message ?? null,
      recipient_name: input.recipient_name ?? null,
      claim_token: claimToken,
      claim_code: claimCode,
      expires_at: new Date(Date.now() + GIFT_TTL_DAYS * 24 * 3600_000).toISOString(),
    });
  }

  async getMine(senderId: string): Promise<GiftDTO[]> {
    return this.giftRepo.getBySender(senderId);
  }

  async getLanding(token: string, viewerId: string | null): Promise<GiftLanding> {
    const gift = await this.ensureGiftByToken(token);
    const restaurant = await this.catalogRepo.getRestaurantById(gift.restaurant_id);

    let claimable = false;
    let claimBlockReason: string | undefined;
    if (gift.status === "ACTIVE" && Date.parse(gift.expires_at) > Date.now()) {
      if (viewerId && viewerId === gift.sender_id) {
        claimBlockReason = "You cannot claim your own gift";
      } else if (gift.claimed_by && gift.claimed_by !== viewerId) {
        claimBlockReason = "This gift was already claimed";
      } else {
        claimable = true;
      }
    } else if (gift.status === "CLAIMED") {
      claimBlockReason = "This gift has already been claimed";
    } else if (gift.status === "FULFILLED") {
      claimBlockReason = "This gift has been fulfilled";
    } else if (gift.status === "EXPIRED") {
      claimBlockReason = "This gift has expired";
    } else if (gift.status === "REFUNDING" || gift.status === "REFUNDED") {
      claimBlockReason = "This gift has been refunded";
    } else if (gift.status === "CANCELLED") {
      claimBlockReason = "This gift was cancelled";
    } else if (Date.parse(gift.expires_at) <= Date.now()) {
      claimBlockReason = "This gift has expired";
    } else if (gift.status === "PENDING") {
      claimBlockReason = "This gift is still being sent";
    }

    return {
      gift,
      restaurant: restaurant
        ? { name: restaurant.name, image_url: restaurant.cover_image ?? null }
        : null,
      // Senders are anonymous (no name stored); surface the recipient's name
      // as the personalization instead of mislabelling it as the sender.
      sender_display: "Your friend",
      claimable,
      claim_block_reason: claimBlockReason,
    };
  }

  async claim(token: string, userId: string): Promise<GiftDTO> {
    const gift = await this.ensureGiftByToken(token);
    if (gift.sender_id === userId) {
      throw new AppError("SELF_GIFT", "You cannot claim your own gift", 400);
    }
    if (gift.status !== "ACTIVE") {
      throw new AppError("GIFT_NOT_CLAIMABLE", `Gift is ${gift.status}, not claimable`, 400);
    }
    if (Date.parse(gift.expires_at) <= Date.now()) {
      throw new AppError("GIFT_EXPIRED", "This gift has expired", 400);
    }
    // markClaimed is a CAS (WHERE status='ACTIVE' AND claimed_by IS NULL): a
    // concurrent claim wins exactly once; losers get null and a clean 409.
    const claimed = await this.giftRepo.markClaimed(gift.id, userId);
    if (!claimed) {
      throw new AppError("GIFT_ALREADY_CLAIMED", "This gift has already been claimed", 409);
    }
    return claimed;
  }

  async release(token: string, userId: string): Promise<GiftDTO> {
    const gift = await this.ensureGiftByToken(token);
    if (gift.status !== "CLAIMED" || gift.claimed_by !== userId) {
      throw new AppError("GIFT_NOT_RELEASABLE", "Gift is not claimed by this user", 400);
    }
    // CAS: only from CLAIMED and never when the gift is already bound to an order.
    const released = await this.giftRepo.release(gift.id);
    if (!released) {
      throw new AppError("GIFT_NOT_RELEASABLE", "Gift cannot be released once redeemed", 409);
    }
    return released;
  }

  async cancel(giftId: string, senderId: string): Promise<GiftDTO> {
    const gift = await this.ensureGift(giftId);
    if (gift.sender_id !== senderId) {
      throw new AppError("FORBIDDEN", "Not your gift", 403);
    }
    if (gift.status === "PENDING") {
      const updated = await this.giftRepo.updateStatus(gift.id, "CANCELLED");
      if (!updated) throw new AppError("CANCEL_FAILED", "Failed to cancel gift", 500);
      return updated;
    }
    if (gift.status === "ACTIVE") {
      return submitGiftRefund(gift, this.giftRepo, this.paymentRepo);
    }
    throw new AppError(
      "GIFT_NOT_CANCELLABLE",
      `Gift is ${gift.status}, not cancellable`,
      400,
    );
  }

  /**
   * Submits a Razorpay refund for a paid gift. Used by sender-cancel and the
   * expiry sweep. The refund submission is CAS-reserved (refund_requested_at)
   * so a gift is never refunded twice; the gift only reaches REFUNDED when the
   * refund webhook confirms — except in mock/preview mode where no webhook will
   * ever arrive, so it resolves immediately.
   */
  async requestRefund(gift: GiftDTO): Promise<GiftDTO> {
    return submitGiftRefund(gift, this.giftRepo, this.paymentRepo);
  }
}

/**
 * Shared refund pipeline used by both sender-cancel and the expiry sweep.
 *
 * Refund exactly once:
 *   1. A captured payment (razorpay_payment_id) is required.
 *   2. The submission is CAS-reserved via giftRepo.markRefundSubmitted() —
 *      only the first caller wins; concurrent/duplicate callers skip.
 *   3. After a successful gateway call the reservation stays set so later
 *      sweeps skip the gift (awaiting the webhook) instead of double-refunding.
 *   4. Mock mode (no real gateway) resolves straight to REFUNDED because no
 *      refund webhook is ever emitted in preview/test environments.
 */
export async function submitGiftRefund(
  gift: GiftDTO,
  giftRepo: GiftRepository,
  paymentRepo: PaymentRepository,
): Promise<GiftDTO> {
  const payment = await paymentRepo.getByGiftId(gift.id);
  if (!payment) {
    throw new AppError("PAYMENT_NOT_FOUND", "No payment record for this gift", 404);
  }
  if (payment.status === "REFUNDED") {
    const refunded = await giftRepo.markRefunded(gift.id);
    // Already REFUNDED is a success, not an error — a caller racing the
    // webhook should not see a 500 for a gift that is already settled.
    return refunded ?? (await giftRepo.getById(gift.id)) ?? gift;
  }
  if (!payment.razorpay_payment_id) {
    // Not yet captured: nothing to refund; stay REFUNDING so the expiry sweep
    // retries once a capture lands.
    const updated = await giftRepo.updateStatus(gift.id, "REFUNDING");
    if (!updated) throw new AppError("REFUND_FAILED", "Failed to start refund", 500);
    return updated;
  }
  if (gift.refund_requested_at) {
    // Refund already submitted; awaiting webhook confirmation.
    const updated = await giftRepo.updateStatus(gift.id, "REFUNDING");
    return updated ?? gift;
  }

  // CAS-reserve the submission so two concurrent refunds never both fire.
  const reserved = await giftRepo.markRefundSubmitted(gift.id);
  if (!reserved) {
    return (await giftRepo.getById(gift.id)) ?? gift;
  }

  try {
    await razorpayService.refund(payment.razorpay_payment_id, Math.round(gift.price_paid * 100));
  } catch {
    // Keep the reservation even when the call throws: the gateway may have
    // accepted the refund and lost the response, so clearing the marker and
    // retrying on the next sweep could fire a real duplicate refund. Stuck
    // REFUNDING gifts are resolved by the refund webhook / reconciliation.
    return (await giftRepo.getById(gift.id)) ?? reserved;
  }

  if (isRazorpayMockMode()) {
    // No refund webhook will ever arrive in mock/preview mode: resolve now.
    // If the local resolution fails, clear the reservation so the sweep can
    // retry — otherwise the gift would be stuck REFUNDING with no webhook
    // ever coming.
    try {
      await paymentRepo.updateWebhookResult(payment.id, {
        razorpay_payment_id: payment.razorpay_payment_id,
        status: "REFUNDED",
        method: payment.method ?? "unknown",
        webhook_event: "refund.processed",
        webhook_raw: null,
      });
      const refunded = await giftRepo.markRefunded(gift.id);
      if (refunded) {
        await emit(
          createEventEnvelope("GiftRefunded", gift.id, {
            gift_id: gift.id,
            sender_id: gift.sender_id,
            amount: gift.price_paid,
          }),
        );
      }
      return refunded ?? reserved;
    } catch {
      await giftRepo.clearRefundSubmitted(gift.id);
      return reserved;
    }
  }

  return reserved;
}

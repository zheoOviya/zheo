import { randomBytes } from "node:crypto";
import { AppError } from "../middleware/envelope";
import type { CatalogRepository } from "../repositories/catalogRepository";
import type { GiftRepository, GiftDTO } from "../repositories/giftRepository";
import type { PaymentRepository } from "../repositories/paymentRepository";
import type { CustomizationDelta } from "./pricing";
import { razorpayService } from "./razorpay";

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

  /** Price is always server-computed: base price + the sender's customization deltas. */
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

    const customizationTotal = input.customizations.reduce((s, c) => s + c.price_delta, 0);
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
        customizations: input.customizations.map((c) => ({ name: c.name, price_delta: c.price_delta })),
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
      sender_display: gift.recipient_name ? gift.recipient_name : "A friend",
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
    const claimed = await this.giftRepo.markClaimed(gift.id, userId);
    if (!claimed) throw new AppError("CLAIM_FAILED", "Failed to claim gift", 500);
    return claimed;
  }

  async release(token: string, userId: string): Promise<GiftDTO> {
    const gift = await this.ensureGiftByToken(token);
    if (gift.status !== "CLAIMED" || gift.claimed_by !== userId) {
      throw new AppError("GIFT_NOT_RELEASABLE", "Gift is not claimed by this user", 400);
    }
    const released = await this.giftRepo.release(gift.id);
    if (!released) throw new AppError("RELEASE_FAILED", "Failed to release gift", 500);
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
      return this.requestRefund(gift);
    }
    throw new AppError(
      "GIFT_NOT_CANCELLABLE",
      `Gift is ${gift.status}, not cancellable`,
      400,
    );
  }

  /**
   * Submits a Razorpay refund for a paid gift. Used by sender-cancel and the
   * expiry sweep. The gift moves to REFUNDING and only becomes REFUNDED when
   * the Razorpay refund webhook confirms (see PaymentService.processWebhook).
   */
  async requestRefund(gift: GiftDTO): Promise<GiftDTO> {
    const updated = await this.giftRepo.updateStatus(gift.id, "REFUNDING");
    if (!updated) throw new AppError("REFUND_FAILED", "Failed to start refund", 500);

    const payment = await this.paymentRepo.getByGiftId(gift.id);
    if (!payment) {
      throw new AppError("PAYMENT_NOT_FOUND", "No payment record for this gift", 404);
    }
    if (payment.status === "REFUNDED") {
      const refunded = await this.giftRepo.markRefunded(gift.id);
      return refunded ?? updated;
    }
    if (!payment.razorpay_payment_id) {
      // Not yet captured (PENDING payment): nothing to refund; stay CANCELLED/EXPIRED.
      return updated;
    }
    try {
      await razorpayService.refund(payment.razorpay_payment_id, Math.round(gift.price_paid * 100));
    } catch {
      // Refund submission failed; keep REFUNDING so the sweep retries.
    }
    return updated;
  }
}

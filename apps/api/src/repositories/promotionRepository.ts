import { randomUUID } from "node:crypto";

// ============================================
// Promotions context repository (promotions bounded context)
// V09 Promotions Builder - FLAT or PERCENTAGE discount with
// an expiry date. `listActive` never returns expired promos.
// ============================================

export type DiscountType = "FLAT" | "PERCENTAGE";

export interface PromotionDTO {
  id: string;
  title: string;
  discount_type: DiscountType;
  value: number;
  valid_until: string;
  is_active: boolean;
  created_at: string;
}

export interface CreatePromotionInput {
  title: string;
  discount_type: DiscountType;
  value: number;
  valid_until: string;
}

export interface PromotionRepository {
  create(input: CreatePromotionInput): Promise<PromotionDTO>;
  listActive(): Promise<PromotionDTO[]>;
  _reset(): void;
}

export class MemoryPromotionRepository implements PromotionRepository {
  private readonly promotions = new Map<string, PromotionDTO>();

  async create(input: CreatePromotionInput): Promise<PromotionDTO> {
    const now = new Date().toISOString();
    const promotion: PromotionDTO = {
      id: randomUUID(),
      title: input.title,
      discount_type: input.discount_type,
      value: input.value,
      valid_until: input.valid_until,
      is_active: true,
      created_at: now,
    };
    this.promotions.set(promotion.id, promotion);
    return promotion;
  }

  async listActive(): Promise<PromotionDTO[]> {
    const now = Date.now();
    return Array.from(this.promotions.values())
      .filter(
        (p) => p.is_active && Date.parse(p.valid_until) >= now,
      )
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
  }

  _reset(): void {
    this.promotions.clear();
  }
}

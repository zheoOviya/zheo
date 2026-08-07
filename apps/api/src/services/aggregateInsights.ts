import { AppError } from "../middleware/envelope";
import type { OrderRepository } from "../repositories/orderRepository";
import type { ChainRepository } from "../repositories/chainRepository";
import type { CatalogRepository } from "../repositories/catalogRepository";
import { ELIGIBLE_INSIGHT_STATUSES } from "./insights";

// ============================================
// Multi-outlet Aggregate Insights (V15, Phase 4)
// Vendor-ops context. Computes total orders / total revenue / combined AOV
// across every outlet under a chain, plus a per-outlet breakdown for the
// "Outlet A vs Outlet B" comparison UI.
//
// Aggregation semantics match the V08 Insights engine: only orders in real
// fulfillment states count (DRAFT / PAYMENT_PENDING / PAYMENT_FAILED /
// CANCELLED / EXPIRED / REFUNDED / DISPUTED are excluded), so abandoned
// carts never pollute the numbers. Catering revenue is genuine revenue and
// is therefore included.
// ============================================

function round2(amount: number): number {
  return Math.round(amount * 100) / 100;
}

export interface OutletAggregate {
  restaurant_id: string;
  name: string;
  order_count: number;
  revenue: number;
  aov: number;
  /** % of chain revenue, 0-100, 2dp. */
  share: number;
}

export interface ChainAggregateInsights {
  chain_id: string;
  chain_name: string;
  outlet_count: number;
  total_orders: number;
  total_revenue: number;
  combined_aov: number;
  outlets: OutletAggregate[];
}

export class AggregateInsightsService {
  constructor(
    private readonly orderRepo: OrderRepository,
    private readonly chainRepo: ChainRepository,
    private readonly catalogRepo: CatalogRepository,
  ) {}

  async computeForChain(chainId: string): Promise<ChainAggregateInsights> {
    const chain = await this.chainRepo.getById(chainId);
    if (!chain) {
      throw new AppError("CHAIN_NOT_FOUND", "Chain not found", 404);
    }

    const outletIds = await this.chainRepo.getOutletIdsByChain(chainId);

    const outlets: OutletAggregate[] = [];
    let totalOrders = 0;
    let totalRevenue = 0;

    for (const restaurantId of outletIds) {
      const orders = await this.orderRepo.getByRestaurant(restaurantId);
      const eligible = orders.filter((o) =>
        ELIGIBLE_INSIGHT_STATUSES.has(o.status),
      );
      const revenue = round2(
        eligible.reduce((sum, o) => sum + Number(o.total_amount), 0),
      );
      const orderCount = eligible.length;
      totalOrders += orderCount;
      totalRevenue = round2(totalRevenue + revenue);

      const restaurant = await this.catalogRepo.getRestaurantById(
        restaurantId,
      );
      outlets.push({
        restaurant_id: restaurantId,
        name: restaurant?.name ?? restaurantId,
        order_count: orderCount,
        revenue,
        aov: orderCount > 0 ? round2(revenue / orderCount) : 0,
        share: 0,
      });
    }

    for (const outlet of outlets) {
      outlet.share =
        totalRevenue > 0 ? round2((outlet.revenue / totalRevenue) * 100) : 0;
    }

    return {
      chain_id: chain.id,
      chain_name: chain.name,
      outlet_count: outlets.length,
      total_orders: totalOrders,
      total_revenue: totalRevenue,
      combined_aov: totalOrders > 0 ? round2(totalRevenue / totalOrders) : 0,
      outlets,
    };
  }
}

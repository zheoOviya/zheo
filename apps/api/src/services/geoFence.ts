import { createEventEnvelope, emit } from "../lib/eventBus";
import { AppError } from "../middleware/envelope";
import type { OrderRepository } from "../repositories/orderRepository";
import type { CatalogRepository } from "../repositories/catalogRepository";
import { getCatalogRepository } from "../routes/catalog";
import { haversineKm } from "./discovery";

// ============================================
// Fulfillment context service (geo-fence)
// P02 Geo-fence Detection:
// The consumer reports a live location (lat/lng) while an order is in
// transit. When the reported point is within GEO_FENCE_RADIUS_M of the
// restaurant AND the order is READY_FOR_PICKUP, the service treats this
// as arrival: it auto-check-ins (the P03 handoff hook) and emits
// `UserArrivedAtRestaurant` so the notification layer can alert the
// kitchen/staff.
// ============================================

export const GEO_FENCE_RADIUS_M = 100;

export interface GeoLocation {
  lat: number;
  lng: number;
}

export interface LocationUpdateResult {
  order_id: string;
  distance_m: number;
  within_fence: boolean;
  auto_checked_in: boolean;
  checked_in: boolean;
  status: string;
}

export class GeoFenceService {
  constructor(
    private readonly orderRepo: OrderRepository,
    private readonly catalogRepo: CatalogRepository = getCatalogRepository(),
    private readonly fenceRadiusM: number = GEO_FENCE_RADIUS_M,
  ) {}

  async handleLocationUpdate(
    orderId: string,
    location: GeoLocation,
  ): Promise<LocationUpdateResult> {
    const order = await this.orderRepo.getById(orderId);
    if (!order) {
      throw new AppError("ORDER_NOT_FOUND", "Order not found", 404);
    }

    const restaurant = await this.catalogRepo.getRestaurantById(order.restaurant_id);
    if (!restaurant || restaurant.lat === null || restaurant.lng === null) {
      throw new AppError(
        "RESTAURANT_LOCATION_UNAVAILABLE",
        "Restaurant location is not configured",
        400,
      );
    }

    const distanceKm = haversineKm(
      location,
      { lat: restaurant.lat, lng: restaurant.lng },
    );
    const distanceM = Math.round(distanceKm * 1000);
    const withinFence = distanceM <= this.fenceRadiusM;

    let autoCheckedIn = false;
    let checkedIn = order.checked_in;
    if (withinFence && order.status === "READY_FOR_PICKUP" && !order.checked_in) {
      const updated = await this.orderRepo.setCheckedIn(orderId);
      if (updated) {
        autoCheckedIn = true;
        checkedIn = true;
      }
    }

    // Emit the arrival report regardless of fence result; consumers of the
    // event (notifications, kitchen display) branch on `within_fence`.
    await emit(
      createEventEnvelope("UserArrivedAtRestaurant", order.id, {
        order_id: order.id,
        user_id: order.user_id,
        restaurant_id: order.restaurant_id,
        distance_m: distanceM,
        within_fence: withinFence,
        auto_checked_in: autoCheckedIn,
      }),
    );

    return {
      order_id: order.id,
      distance_m: distanceM,
      within_fence: withinFence,
      auto_checked_in: autoCheckedIn,
      checked_in: checkedIn,
      status: order.status,
    };
  }
}

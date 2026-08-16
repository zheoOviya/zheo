import { AppError } from "./envelope";
import { getCatalogRepository } from "../routes/catalog";
import { sharedChainRepo, sharedUserRoleRepo } from "../repositories/shared";

// ============================================
// Vendor Restaurant Ownership Guard (H2)
// Prevents a vendor from reading or mutating
// orders / menu / settlements for restaurants
// they do not own.
//   - ADMIN / SUPER_ADMIN bypass (platform scope)
//   - scoped user_roles membership (restaurant or
//     chain scope) — the multi-outlet source of truth
//   - owner_id match on the catalog restaurant
//   - chain outlet: restaurant attached to a
//     chain owned by the caller also passes
// Throws 403 FORBIDDEN on mismatch, 404 when the
// restaurant does not exist, 401 without auth.
// ============================================

export async function assertRestaurantAccess(
  res: { locals: Record<string, unknown> },
  restaurantId: string,
): Promise<void> {
  const userId = res.locals.userId;
  const role = String(res.locals.userRole ?? "");
  if (typeof userId !== "string" || userId.length === 0) {
    throw new AppError("UNAUTHORIZED", "Authentication required", 401);
  }

  if (role === "ADMIN" || role === "SUPER_ADMIN") return;

  const restaurant = await getCatalogRepository().getRestaurantById(restaurantId);
  if (!restaurant) {
    throw new AppError("NOT_FOUND", "Restaurant not found", 404);
  }
  if (restaurant.owner_id === userId) return;

  const chainId = await sharedChainRepo.getOutletChainId(restaurantId);

  // Scoped membership is the source of truth for multi-owner/staff access.
  if (await sharedUserRoleRepo.isMember(userId, "restaurant", restaurantId)) return;
  if (chainId && (await sharedUserRoleRepo.isMember(userId, "chain", chainId))) return;

  // Legacy back-compat: chain owner still passes while membership rolls out.
  if (chainId) {
    const chain = await sharedChainRepo.getById(chainId);
    if (chain?.owner_id === userId) return;
  }

  throw new AppError(
    "FORBIDDEN",
    "You do not have access to this restaurant",
    403,
  );
}

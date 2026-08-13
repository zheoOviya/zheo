import { randomUUID } from "node:crypto";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { menu_items, restaurants } from "@snakzap/db";

// ============================================
// Catalog context repository (catalog bounded context)
// Drizzle implementation uses the Postgres GIN index on
// menu_items.dietary_tags via the @> containment operator.
// ============================================

export interface RestaurantDTO {
  id: string;
  name: string;
  gst_number: string | null;
  owner_id: string;
  commission_rate: number;
  is_active: boolean;
  /** P04 traffic ETA uses the restaurant location as the pickup origin. */
  lat: number | null;
  lng: number | null;
  /** Estimated prep/pickup time in minutes shown on consumer cards. */
  pickup_eta_min: number;
}

export interface MenuItemDTO {
  id: string;
  restaurant_id: string;
  name: string;
  price: number;
  description: string | null;
  dietary_tags: Record<string, boolean>;
  customizations: unknown[];
  image_url: string | null;
  pos_item_id: string | null;
  is_available: boolean;
  /** D03 spice level (1 = mild, 5 = extreme). Defaults to 3. */
  spice_level: number;
}

export interface PosMenuInput {
  pos_item_id: string;
  name: string;
  price: number;
  dietary_tags: Record<string, boolean>;
  customizations: unknown[];
  is_available?: boolean;
  /** D03 spice level (1-5). Defaults to 3 when omitted. */
  spice_level?: number;
}

/** One row of a V14 bulk menu edit (Excel-like grid). */
export interface BulkMenuItemPatch {
  item_id: string;
  price?: number;
  is_available?: boolean;
  description?: string | null;
}

/**
 * Thrown by bulkUpdateMenuItems when an item_id is unknown or does not
 * belong to the target restaurant. Guarantees zero writes happened.
 */
export class MenuBulkUpdateError extends Error {
  constructor(public readonly itemId: string) {
    super(`Menu item ${itemId} not found or not owned by restaurant`);
    this.name = "MenuBulkUpdateError";
  }
}

export interface SearchResultDTO {
  type: "restaurant" | "dish";
  id: string;
  name: string;
  restaurant_id?: string;
}

export interface CatalogRepository {
  getActiveRestaurants(): Promise<RestaurantDTO[]>;
  getRestaurantById(id: string): Promise<RestaurantDTO | null>;
  getMenu(restaurantId: string): Promise<MenuItemDTO[]>;
  getMenuAll(restaurantId: string): Promise<MenuItemDTO[]>;
  getMenuItemById(id: string): Promise<MenuItemDTO | null>;
  getMenuItemByPosItemId(restaurantId: string, posItemId: string): Promise<MenuItemDTO | null>;
  updateImageUrl(itemId: string, url: string): Promise<MenuItemDTO | null>;
  updateMenuItem(
    itemId: string,
    patch: { price?: number; is_available?: boolean; description?: string | null },
  ): Promise<MenuItemDTO | null>;
  /** V14: atomic all-or-nothing bulk update. Throws MenuBulkUpdateError on any invalid row. */
  bulkUpdateMenuItems(restaurantId: string, items: BulkMenuItemPatch[]): Promise<MenuItemDTO[]>;
  autocomplete(query: string): Promise<SearchResultDTO[]>;
  filterByDietary(tags: string[]): Promise<MenuItemDTO[]>;
  /** V01 POS menu sync: upsert items keyed by (restaurant_id, pos_item_id). */
  upsertPosMenuItems(restaurantId: string, items: PosMenuInput[]): Promise<MenuItemDTO[]>;
  /** A-04 Admin: list all restaurants (active and inactive). */
  getAllRestaurants(): Promise<RestaurantDTO[]>;
  /** A-04 Admin: toggle restaurant active status. */
  updateRestaurantStatus(id: string, isActive: boolean): Promise<RestaurantDTO | null>;
}

// Allowed dietary tags (validated upstream via Zod enum)
export const ALLOWED_DIETARY_TAGS = ["VEG", "JAIN", "HALAL"] as const;
export type DietaryTag = (typeof ALLOWED_DIETARY_TAGS)[number];

// ============================================
// GIN index condition
// dietary_tags jsonb @> '{"VEG": true}' uses the
// jsonb_path_ops GIN index created in Task 2.
// ============================================

export function dietaryFilterCondition(tags: string[]): SQL<unknown> {
  const payload: Record<string, boolean> = {};
  for (const tag of tags) {
    payload[tag] = true;
  }
  return sql`${menu_items.dietary_tags} @> ${JSON.stringify(payload)}::jsonb`;
}

// ============================================
// Drizzle implementation (production, Postgres 16)
// ============================================

import type { DrizzleDb } from "../lib/dbType";

export class DrizzleCatalogRepository implements CatalogRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getActiveRestaurants(): Promise<RestaurantDTO[]> {
    const rows = (await this.db
      .select()
      .from(restaurants)
      .where(eq(restaurants.is_active, true))) as RestaurantDTO[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      gst_number: r.gst_number ?? null,
      owner_id: r.owner_id,
      commission_rate: Number(r.commission_rate),
      is_active: r.is_active,
      lat: r.lat ?? null,
      lng: r.lng ?? null,
      pickup_eta_min: r.pickup_eta_min,
    }));
  }

  async getRestaurantById(id: string): Promise<RestaurantDTO | null> {
    const rows = (await this.db
      .select()
      .from(restaurants)
      .where(eq(restaurants.id, id))) as RestaurantDTO[];
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      name: r.name,
      gst_number: r.gst_number ?? null,
      owner_id: r.owner_id,
      commission_rate: Number(r.commission_rate),
      is_active: r.is_active,
      lat: r.lat ?? null,
      lng: r.lng ?? null,
      pickup_eta_min: r.pickup_eta_min,
    };
  }

  async getMenu(restaurantId: string): Promise<MenuItemDTO[]> {
    const rows = (await this.db
      .select()
      .from(menu_items)
      .where(
        and(eq(menu_items.restaurant_id, restaurantId), eq(menu_items.is_available, true)),
      )) as MenuItemDTO[];
    return rows.map((m) => ({
      ...m,
      price: Number(m.price),
    }));
  }

  async getMenuAll(restaurantId: string): Promise<MenuItemDTO[]> {
    const rows = (await this.db
      .select()
      .from(menu_items)
      .where(eq(menu_items.restaurant_id, restaurantId))) as MenuItemDTO[];
    return rows.map((m) => ({
      ...m,
      price: Number(m.price),
    }));
  }

  async getMenuItemById(id: string): Promise<MenuItemDTO | null> {
    const rows = (await this.db
      .select()
      .from(menu_items)
      .where(eq(menu_items.id, id))) as MenuItemDTO[];
    const item = rows[0];
    return item ? { ...item, price: Number(item.price) } : null;
  }

  async getMenuItemByPosItemId(
    restaurantId: string,
    posItemId: string,
  ): Promise<MenuItemDTO | null> {
    const rows = (await this.db
      .select()
      .from(menu_items)
      .where(
        and(eq(menu_items.restaurant_id, restaurantId), eq(menu_items.pos_item_id, posItemId)),
      )) as MenuItemDTO[];
    const item = rows[0];
    return item ? { ...item, price: Number(item.price) } : null;
  }

  async updateImageUrl(itemId: string, url: string): Promise<MenuItemDTO | null> {
    await this.db.update(menu_items).set({ image_url: url }).where(eq(menu_items.id, itemId));
    return this.getMenuItemById(itemId);
  }

  async updateMenuItem(
    itemId: string,
    patch: {
      price?: number;
      is_available?: boolean;
      description?: string | null;
    },
  ): Promise<MenuItemDTO | null> {
    await this.db.update(menu_items).set(patch).where(eq(menu_items.id, itemId));
    return this.getMenuItemById(itemId);
  }

  async bulkUpdateMenuItems(
    restaurantId: string,
    items: BulkMenuItemPatch[],
  ): Promise<MenuItemDTO[]> {
    // All-or-nothing: run inside a Postgres transaction so a failing row
    // rolls back every statement written by this call.
    return this.db.transaction(async (tx) => {
      // Validate phase - no writes until every row resolves.
      const resolved: MenuItemDTO[] = [];
      for (const patch of items) {
        const rows = (await tx
          .select()
          .from(menu_items)
          .where(
            and(eq(menu_items.id, patch.item_id), eq(menu_items.restaurant_id, restaurantId)),
          )) as MenuItemDTO[];
        if (!rows[0]) {
          throw new MenuBulkUpdateError(patch.item_id);
        }
        resolved.push(rows[0]);
      }
      // Apply phase - validation passed, safe to write all rows.
      for (let i = 0; i < items.length; i += 1) {
        const patch = items[i]!;
        await tx
          .update(menu_items)
          .set({
            ...(patch.price !== undefined ? { price: patch.price } : {}),
            ...(patch.is_available !== undefined ? { is_available: patch.is_available } : {}),
            ...(patch.description !== undefined ? { description: patch.description } : {}),
          })
          .where(eq(menu_items.id, patch.item_id));
      }
      return resolved.map((item, i) => ({
        ...item,
        price: Number(item.price),
        ...(items[i]!.price !== undefined ? { price: items[i]!.price } : {}),
        ...(items[i]!.is_available !== undefined ? { is_available: items[i]!.is_available } : {}),
        ...(items[i]!.description !== undefined ? { description: items[i]!.description } : {}),
      }));
    });
  }

  async autocomplete(query: string): Promise<SearchResultDTO[]> {
    const pattern = `%${query.toLowerCase()}%`;
    const restRows = (await this.db
      .select()
      .from(restaurants)
      .where(
        and(eq(restaurants.is_active, true), sql`lower(${restaurants.name}) LIKE ${pattern}`),
      )) as RestaurantDTO[];

    const dishRows = (await this.db
      .select()
      .from(menu_items)
      .where(sql`lower(${menu_items.name}) LIKE ${pattern}`)) as MenuItemDTO[];

    return [
      ...restRows.map((r) => ({ type: "restaurant" as const, id: r.id, name: r.name })),
      ...dishRows.map((m) => ({
        type: "dish" as const,
        id: m.id,
        name: m.name,
        restaurant_id: m.restaurant_id,
      })),
    ].slice(0, 10);
  }

  async filterByDietary(tags: string[]): Promise<MenuItemDTO[]> {
    const rows = (await this.db
      .select()
      .from(menu_items)
      .where(
        and(dietaryFilterCondition(tags), eq(menu_items.is_available, true)),
      )) as MenuItemDTO[];
    return rows.map((m) => ({ ...m, price: Number(m.price) }));
  }

  async upsertPosMenuItems(restaurantId: string, items: PosMenuInput[]): Promise<MenuItemDTO[]> {
    const upserted: MenuItemDTO[] = [];
    for (const input of items) {
      const existingRows = (await this.db
        .select()
        .from(menu_items)
        .where(
          and(
            eq(menu_items.restaurant_id, restaurantId),
            eq(menu_items.pos_item_id, input.pos_item_id),
          ),
        )) as MenuItemDTO[];
      const existing = existingRows[0];
      if (existing) {
        await this.db
          .update(menu_items)
          .set({
            name: input.name,
            price: input.price,
            dietary_tags: input.dietary_tags,
            customizations: input.customizations,
            is_available: input.is_available ?? true,
            spice_level: input.spice_level ?? 3,
          })
          .where(eq(menu_items.id, existing.id));
        upserted.push({ ...existing, ...input, spice_level: input.spice_level ?? 3 });
      } else {
        await this.db.insert(menu_items).values({
          id: randomUUID(),
          restaurant_id: restaurantId,
          name: input.name,
          price: input.price,
          dietary_tags: input.dietary_tags,
          customizations: input.customizations,
          image_url: null,
          pos_item_id: input.pos_item_id,
          is_available: input.is_available ?? true,
          spice_level: input.spice_level ?? 3,
        });
        upserted.push({
          id: randomUUID(),
          restaurant_id: restaurantId,
          name: input.name,
          price: input.price,
          description: null,
          dietary_tags: input.dietary_tags,
          customizations: input.customizations,
          image_url: null,
          pos_item_id: input.pos_item_id,
          is_available: input.is_available ?? true,
          spice_level: input.spice_level ?? 3,
        });
      }
    }
    return upserted;
  }

  async getAllRestaurants(): Promise<RestaurantDTO[]> {
    const rows = (await this.db.select().from(restaurants).where(undefined!)) as RestaurantDTO[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      gst_number: r.gst_number ?? null,
      owner_id: r.owner_id,
      commission_rate: Number(r.commission_rate),
      is_active: r.is_active,
      lat: r.lat ?? null,
      lng: r.lng ?? null,
      pickup_eta_min: r.pickup_eta_min,
    }));
  }

  async updateRestaurantStatus(id: string, isActive: boolean): Promise<RestaurantDTO | null> {
    await this.db.update(restaurants).set({ is_active: isActive }).where(eq(restaurants.id, id));
    return this.getRestaurantById(id);
  }
}

// ============================================
// Memory implementation (tests / offline dev)
// ============================================

export class MemoryCatalogRepository implements CatalogRepository {
  private readonly originalMenu: MenuItemDTO[];

  constructor(
    private readonly restaurantsData: RestaurantDTO[],
    private readonly menuData: MenuItemDTO[],
  ) {
    this.originalMenu = menuData.map((m) => ({ ...m }));
  }

  async getActiveRestaurants(): Promise<RestaurantDTO[]> {
    return this.restaurantsData.filter((r) => r.is_active);
  }

  async getRestaurantById(id: string): Promise<RestaurantDTO | null> {
    return this.restaurantsData.find((r) => r.id === id) ?? null;
  }

  async getMenu(restaurantId: string): Promise<MenuItemDTO[]> {
    return this.menuData.filter((m) => m.restaurant_id === restaurantId && m.is_available);
  }

  async getMenuAll(restaurantId: string): Promise<MenuItemDTO[]> {
    return this.menuData.filter((m) => m.restaurant_id === restaurantId);
  }

  async getMenuItemById(id: string): Promise<MenuItemDTO | null> {
    return this.menuData.find((m) => m.id === id) ?? null;
  }

  async getMenuItemByPosItemId(
    restaurantId: string,
    posItemId: string,
  ): Promise<MenuItemDTO | null> {
    return (
      this.menuData.find((m) => m.restaurant_id === restaurantId && m.pos_item_id === posItemId) ??
      null
    );
  }

  async updateImageUrl(itemId: string, url: string): Promise<MenuItemDTO | null> {
    const item = this.menuData.find((m) => m.id === itemId);
    if (!item) return null;
    item.image_url = url;
    return item;
  }

  async updateMenuItem(
    itemId: string,
    patch: {
      price?: number;
      is_available?: boolean;
      description?: string | null;
    },
  ): Promise<MenuItemDTO | null> {
    const item = this.menuData.find((m) => m.id === itemId);
    if (!item) return null;
    if (patch.price !== undefined) item.price = patch.price;
    if (patch.is_available !== undefined) item.is_available = patch.is_available;
    if (patch.description !== undefined) item.description = patch.description;
    return item;
  }

  async bulkUpdateMenuItems(
    restaurantId: string,
    items: BulkMenuItemPatch[],
  ): Promise<MenuItemDTO[]> {
    // Validate phase - no writes until every row resolves.
    const resolved: MenuItemDTO[] = [];
    for (const patch of items) {
      const item = this.menuData.find(
        (m) => m.id === patch.item_id && m.restaurant_id === restaurantId,
      );
      if (!item) throw new MenuBulkUpdateError(patch.item_id);
      resolved.push(item);
    }
    // Apply phase - atomic: every row validated, now safe to write all.
    for (let i = 0; i < items.length; i += 1) {
      const item = resolved[i]!;
      const patch = items[i]!;
      if (patch.price !== undefined) item.price = patch.price;
      if (patch.is_available !== undefined) item.is_available = patch.is_available;
      if (patch.description !== undefined) item.description = patch.description;
    }
    return resolved;
  }

  /** Resets the seeded menu back to its original state (test helper). */
  _reset(): void {
    this.menuData.splice(0, this.menuData.length, ...this.originalMenu.map((m) => ({ ...m })));
  }

  async autocomplete(query: string): Promise<SearchResultDTO[]> {
    const q = query.toLowerCase();
    const rest = this.restaurantsData
      .filter((r) => r.is_active && r.name.toLowerCase().includes(q))
      .map((r) => ({ type: "restaurant" as const, id: r.id, name: r.name }));
    const dishes = this.menuData
      .filter((m) => m.name.toLowerCase().includes(q))
      .map((m) => ({
        type: "dish" as const,
        id: m.id,
        name: m.name,
        restaurant_id: m.restaurant_id,
      }));
    return [...rest, ...dishes].slice(0, 10);
  }

  async filterByDietary(tags: string[]): Promise<MenuItemDTO[]> {
    return this.menuData.filter(
      (m) => m.is_available && tags.every((tag) => m.dietary_tags[tag] === true),
    );
  }

  async upsertPosMenuItems(restaurantId: string, items: PosMenuInput[]): Promise<MenuItemDTO[]> {
    const upserted: MenuItemDTO[] = [];
    for (const input of items) {
      const existing = this.menuData.find(
        (m) => m.restaurant_id === restaurantId && m.pos_item_id === input.pos_item_id,
      );
      if (existing) {
        existing.name = input.name;
        existing.price = input.price;
        existing.dietary_tags = input.dietary_tags;
        existing.customizations = input.customizations;
        existing.is_available = input.is_available ?? true;
        existing.spice_level = input.spice_level ?? 3;
        upserted.push(existing);
      } else {
        const created: MenuItemDTO = {
          id: randomUUID(),
          restaurant_id: restaurantId,
          name: input.name,
          price: input.price,
          description: null,
          dietary_tags: input.dietary_tags,
          customizations: input.customizations,
          image_url: null,
          pos_item_id: input.pos_item_id,
          is_available: input.is_available ?? true,
          spice_level: input.spice_level ?? 3,
        };
        this.menuData.push(created);
        upserted.push(created);
      }
    }
    return upserted;
  }

  async getAllRestaurants(): Promise<RestaurantDTO[]> {
    return [...this.restaurantsData];
  }

  async updateRestaurantStatus(id: string, isActive: boolean): Promise<RestaurantDTO | null> {
    const rest = this.restaurantsData.find((x: RestaurantDTO) => x.id === id);
    if (!rest) return null;
    rest.is_active = isActive;
    return { ...rest };
  }
}

import { createEventEnvelope } from "../lib/eventBus";
import { logger } from "../lib/logger";
import { AppError } from "../middleware/envelope";
import type {
  CatalogRepository,
  MenuItemDTO,
  PosMenuInput,
} from "../repositories/catalogRepository";
import type { MenuSyncTransactionPort } from "../repositories/producerRemainingAtomicityContracts";
import { getMenuSyncTransactionPort } from "../repositories/drizzle/producerRemainingTransactionPort";

// ============================================
// Petpooja Menu Sync (PRD Phase 2, V01)
//
// Pulls the restaurant's menu from the POS and upserts it
// into the SnakZap catalog keyed on (restaurant_id, pos_item_id).
// Running the sync twice converges: existing items are updated
// in place, never duplicated. The POS stays the source of truth
// for what appears on the consumer menu.
//
// Mock client: real Petpooja API (auth token + REST) is behind
// the same interface, so the switch is invisible to the caller.
// ============================================

export interface PosMenuClient {
  getMenu(restaurantId: string): Promise<PosMenuInput[]>;
}

// Dietary tags returned by Petpooja (strings) mapped to our
// boolean tag map. Unknown tags are ignored.
const TAG_MAP: Record<string, "VEG" | "JAIN" | "NON_VEG"> = {
  VEG: "VEG",
  JAIN: "JAIN",
  NON_VEG: "NON_VEG",
};

export function mapPosDietaryTags(tags: string[]): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const tag of tags) {
    const mapped = TAG_MAP[tag.toUpperCase()];
    if (mapped) result[mapped] = true;
  }
  return result;
}

interface MockPosItem {
  pos_item_id: string;
  name: string;
  price: number;
  tags: string[];
}

// Canned Petpooja catalog used offline / in tests. These are the items
// the "Send Test Order" button on the vendor POS page orders from.
const MOCK_POS_MENU: MockPosItem[] = [
  { pos_item_id: "pp-3001", name: "Mutton Biryani", price: 260, tags: ["NON_VEG"] },
  { pos_item_id: "pp-3002", name: "Egg Biryani", price: 200, tags: ["NON_VEG"] },
  { pos_item_id: "pp-3003", name: "Chicken 65", price: 240, tags: ["NON_VEG"] },
  { pos_item_id: "pp-4001", name: "Gobi Manchurian", price: 150, tags: ["VEG", "JAIN"] },
];

export class MockPosMenuClient implements PosMenuClient {
  async getMenu(restaurantId: string): Promise<PosMenuInput[]> {
    // In a real integration this would call the Petpooja REST API.
    return MOCK_POS_MENU.map((item) => ({
      pos_item_id: item.pos_item_id,
      name: item.name,
      price: item.price,
      dietary_tags: mapPosDietaryTags(item.tags),
      customizations: [],
      is_available: true,
    }));
  }
}

export class MenuSyncService {
  constructor(
    private readonly catalogRepo: CatalogRepository,
    private readonly posMenuClient: PosMenuClient,
    private readonly txPort?: MenuSyncTransactionPort,
  ) {}

  /** Transaction port for the menu upsert + PosMenuSynced row (EVT-B2B-NP2). */
  private getTransactionPort(): MenuSyncTransactionPort {
    return this.txPort ?? getMenuSyncTransactionPort(this.catalogRepo);
  }

  async syncMenu(restaurantId: string): Promise<{
    synced: number;
    items: MenuItemDTO[];
  }> {
    const restaurant = await this.catalogRepo.getRestaurantById(restaurantId);
    if (!restaurant || !restaurant.is_active) {
      throw new AppError(
        "RESTAURANT_NOT_FOUND",
        "Restaurant not found or inactive",
        404,
      );
    }

    const posMenu = await this.posMenuClient.getMenu(restaurantId);
    // The upsert and its PosMenuSynced row share ONE transaction (EVT-B2B-NP2):
    // a mid-sync failure rolls the menu back and enqueues nothing, so no event
    // ever describes a menu state that was not committed. The old post-commit
    // emit is gone.
    const items = await this.getTransactionPort().runInTransaction(
      async ({ catalog, outbox }) => {
        const synced = await catalog.upsertPosMenuItems(restaurantId, posMenu);
        await outbox.enqueue(
          createEventEnvelope("PosMenuSynced", restaurantId, {
            restaurant_id: restaurantId,
            synced_count: synced.length,
          }),
        );
        return synced;
      },
    );

    logger.info({
      message: "pos_menu_synced",
      restaurant_id: restaurantId,
      synced_count: items.length,
    });

    return { synced: items.length, items };
  }
}

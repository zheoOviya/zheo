import type { SQL } from "drizzle-orm";

// ============================================
// Shared DrizzleDb type used by all Drizzle-backend
// repository implementations. Extracted from the
// original DrizzleCatalogRepository so every
// bounded-context repo uses the same facade.
// ============================================

export type DrizzleDb = {
  select: () => {
    from: (table: unknown) => {
      where: (cond: SQL<unknown> | undefined) => Promise<unknown[]>;
    };
  };
  update: (table: unknown) => {
    set: (values: Record<string, unknown>) => {
      where: (cond: SQL<unknown> | undefined) => Promise<unknown[]>;
    };
  };
  insert: (table: unknown) => {
    values: (values: Record<string, unknown>) => Promise<unknown[]>;
  };
  delete: (table: unknown) => {
    where: (cond: SQL<unknown> | undefined) => Promise<unknown[]>;
  };
  /** Postgres transaction scope for atomic multi-statement writes. */
  transaction: <T>(fn: (tx: DrizzleDb) => Promise<T>) => Promise<T>;
};

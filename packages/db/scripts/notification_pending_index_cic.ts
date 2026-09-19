/**
 * Production CREATE INDEX CONCURRENTLY runner for the notifications pending
 * ordered-read index.
 *
 * The generated Drizzle migration `0022_*.sql` creates the index with a plain
 * transactional `CREATE INDEX IF NOT EXISTS`, which is correct and sufficient
 * for fresh databases, bootstraps and CI. On a populated production outbox that
 * would hold a write lock for the whole build. Operators run this script first
 * instead:
 *
 *   DATABASE_URL=... pnpm --filter @snakzap/db db:notification-index:prepare
 *
 * It is non-transactional (CREATE INDEX CONCURRENTLY cannot run inside a
 * transaction), creates the index only when absent, never drops anything, and
 * fails closed when a same-name index already exists but does not structurally
 * match the expected contract. Once it reports SATISFIED, the ordinary
 * `drizzle-kit migrate` run applies migration 0022 as a bookkeeping no-op.
 *
 * A same-name index that is structurally wrong cannot be repaired in place.
 * The operator must stop, inspect it, and after explicit authorisation run
 * `DROP INDEX CONCURRENTLY "notifications_pending_created_id_idx"` and re-run
 * this script. That destructive step is intentionally not automated here.
 */
import { pathToFileURL } from "node:url";
import { Client } from "pg";

export const NOTIFICATION_PENDING_INDEX = {
  indexName: "notifications_pending_created_id_idx",
  tableName: "notifications",
  keyColumns: ["created_at", "id"],
  predicate: "(status = 'PENDING'::notification_status)",
} as const;

export interface IndexFacts {
  name: string;
  table: string;
  valid: boolean;
  ready: boolean;
  unique: boolean;
  keyCount: number;
  columnCount: number;
  columns: string[];
  indexDef: string;
  predicate: string | null;
}

export type IndexClassification =
  | { kind: "ABSENT" }
  | { kind: "SATISFIED"; facts: IndexFacts }
  | { kind: "MISMATCH"; facts: IndexFacts; reasons: string[] };

/**
 * `pg_get_expr` normalises the predicate to `status = 'PENDING'::notification_status`
 * (optionally schema-qualified). Accept only that equivalence, not arbitrary
 * predicates that merely mention PENDING.
 */
export function predicateMatches(predicate: string | null): boolean {
  if (predicate === null) return false;
  const normalized = predicate
    .toLowerCase()
    .replace(/::(public\.)?notification_status/g, "")
    .replace(/\s+/g, "");
  return normalized === "status='pending'" || normalized === "(status='pending')";
}

export function classifyIndex(facts: IndexFacts | null): IndexClassification {
  if (facts === null) return { kind: "ABSENT" };

  const reasons: string[] = [];

  if (facts.table !== NOTIFICATION_PENDING_INDEX.tableName) {
    reasons.push(
      `index is on table "${facts.table}", expected "${NOTIFICATION_PENDING_INDEX.tableName}"`,
    );
  }
  if (!facts.valid) reasons.push("indisvalid=false (index is not usable)");
  if (!facts.ready) reasons.push("indisready=false (index is still being built)");
  if (facts.unique) reasons.push("indisunique=true, expected a non-unique index");

  const expectedColumns = NOTIFICATION_PENDING_INDEX.keyColumns;
  if (facts.keyCount !== expectedColumns.length) {
    reasons.push(
      `key column count=${facts.keyCount}, expected ${expectedColumns.length}`,
    );
  } else {
    for (let i = 0; i < expectedColumns.length; i += 1) {
      const actual = facts.columns[i];
      if (actual !== expectedColumns[i]) {
        reasons.push(
          `key column ${i + 1}="${String(actual)}", expected "${String(expectedColumns[i])}"`,
        );
      }
    }
  }

  const includedColumns = facts.columnCount - facts.keyCount;
  if (includedColumns > 0) {
    reasons.push(`${includedColumns} INCLUDE column(s) present, expected none`);
  }

  if (!predicateMatches(facts.predicate)) {
    reasons.push(
      `partial predicate "${facts.predicate ?? "<none>"}", expected status = 'PENDING'`,
    );
  }

  if (reasons.length > 0) return { kind: "MISMATCH", facts, reasons };
  return { kind: "SATISFIED", facts };
}

const INDEX_FACTS_SQL = `
  SELECT
    c.relname AS name,
    t.relname AS "table",
    i.indisvalid AS valid,
    i.indisready AS ready,
    i.indisunique AS unique,
    i.indnkeyatts AS key_count,
    i.indnatts AS column_count,
    pg_get_indexdef(i.indexrelid) AS index_def,
    pg_get_expr(i.indpred, i.indrelid) AS predicate,
    (
      SELECT array_agg(a.attname::text ORDER BY k.ord)
      FROM unnest(i.indkey::int[]) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a
        ON a.attrelid = i.indrelid AND a.attnum = k.attnum
    ) AS columns
  FROM pg_class c
  JOIN pg_index i ON i.indexrelid = c.oid
  JOIN pg_class t ON t.oid = i.indrelid
  WHERE c.relname = $1 AND c.relkind = 'i'
  LIMIT 1
`;

interface IndexFactsRow {
  name: string;
  table: string;
  valid: boolean;
  ready: boolean;
  unique: boolean;
  key_count: number | string;
  column_count: number | string;
  index_def: string;
  predicate: string | null;
  columns: string[] | null;
}

export async function fetchIndexFacts(
  client: Client,
  indexName: string,
): Promise<IndexFacts | null> {
  const result = await client.query<IndexFactsRow>(INDEX_FACTS_SQL, [indexName]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    name: row.name,
    table: row.table,
    valid: row.valid,
    ready: row.ready,
    unique: row.unique,
    keyCount: Number(row.key_count),
    columnCount: Number(row.column_count),
    columns: row.columns ?? [],
    indexDef: row.index_def,
    predicate: row.predicate,
  };
}

export const CREATE_PENDING_INDEX_CIC_SQL =
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${NOTIFICATION_PENDING_INDEX.indexName}" ` +
  `ON "${NOTIFICATION_PENDING_INDEX.tableName}" USING btree ("created_at","id") ` +
  `WHERE "status" = 'PENDING'`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describe(facts: IndexFacts): string {
  return [
    `  table:      ${facts.table}`,
    `  columns:    ${facts.columns.join(", ")} (key=${facts.keyCount}, total=${facts.columnCount})`,
    `  unique:     ${facts.unique}`,
    `  valid:      ${facts.valid}`,
    `  ready:      ${facts.ready}`,
    `  predicate:  ${facts.predicate ?? "<none>"}`,
    `  indexdef:   ${facts.indexDef}`,
  ].join("\n");
}

export async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required (postgresql://...)");
    return 2;
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    console.error("DATABASE_URL must be a postgresql:// URL; refusing to run");
    return 2;
  }

  const client = new Client({ connectionString: url });
  try {
    await client.connect();
  } catch (error) {
    console.error(`failed to connect to database: ${errorMessage(error)}`);
    return 2;
  }

  try {
    const before = classifyIndex(
      await fetchIndexFacts(client, NOTIFICATION_PENDING_INDEX.indexName),
    );

    if (before.kind === "SATISFIED") {
      console.log(
        `SATISFIED: "${NOTIFICATION_PENDING_INDEX.indexName}" already exists and matches the expected contract.`,
      );
      return 0;
    }

    if (before.kind === "MISMATCH") {
      console.error(
        `MISMATCH: "${NOTIFICATION_PENDING_INDEX.indexName}" exists but does not match the expected contract:`,
      );
      console.error(describe(before.facts));
      for (const reason of before.reasons) console.error(`  - ${reason}`);
      console.error(
        "Refusing to continue. Stop: inspect the existing index, and after explicit authorisation run " +
          `DROP INDEX CONCURRENTLY "${NOTIFICATION_PENDING_INDEX.indexName}"`,
      );
      return 1;
    }

    console.log(
      `ABSENT: creating "${NOTIFICATION_PENDING_INDEX.indexName}" concurrently...`,
    );
    await client.query(CREATE_PENDING_INDEX_CIC_SQL);

    const after = classifyIndex(
      await fetchIndexFacts(client, NOTIFICATION_PENDING_INDEX.indexName),
    );

    if (after.kind === "SATISFIED") {
      console.log(
        `SATISFIED: "${NOTIFICATION_PENDING_INDEX.indexName}" created and verified.`,
      );
      console.log(describe(after.facts));
      return 0;
    }

    if (after.kind === "ABSENT") {
      console.error("VERIFY_FAILED: index is still absent after CREATE INDEX CONCURRENTLY");
      return 1;
    }

    console.error(
      "VERIFY_FAILED: index exists after creation but does not match the expected contract:",
    );
    console.error(describe(after.facts));
    for (const reason of after.reasons) console.error(`  - ${reason}`);
    return 1;
  } catch (error) {
    console.error(`CIC failed: ${errorMessage(error)}`);
    return 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(errorMessage(error));
      process.exitCode = 1;
    });
}

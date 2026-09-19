import { describe, expect, it } from "vitest";
import {
  classifyIndex,
  NOTIFICATION_PENDING_INDEX,
  predicateMatches,
  type IndexFacts,
} from "../scripts/notification_pending_index_cic";

function facts(overrides: Partial<IndexFacts> = {}): IndexFacts {
  return {
    name: NOTIFICATION_PENDING_INDEX.indexName,
    table: NOTIFICATION_PENDING_INDEX.tableName,
    valid: true,
    ready: true,
    unique: false,
    keyCount: 2,
    columnCount: 2,
    columns: ["created_at", "id"],
    indexDef:
      'CREATE INDEX notifications_pending_created_id_idx ON public.notifications USING btree (created_at, id) WHERE (status = \'PENDING\'::notification_status)',
    predicate: "(status = 'PENDING'::notification_status)",
    ...overrides,
  };
}

describe("notification pending index CIC contract", () => {
  it("reports ABSENT when the index does not exist", () => {
    expect(classifyIndex(null)).toEqual({ kind: "ABSENT" });
  });

  it("accepts the exact expected structure", () => {
    const result = classifyIndex(facts());
    expect(result.kind).toBe("SATISFIED");
  });

  it("accepts a schema-qualified or unquoted predicate equivalence", () => {
    expect(predicateMatches("(status = 'PENDING'::notification_status)")).toBe(true);
    expect(predicateMatches("(status = 'PENDING'::public.notification_status)")).toBe(true);
    expect(predicateMatches("(status = 'PENDING')")).toBe(true);
  });

  it("rejects missing or unrelated predicates", () => {
    expect(predicateMatches(null)).toBe(false);
    expect(predicateMatches("(status = 'SENT'::notification_status)")).toBe(false);
    expect(predicateMatches("(status <> 'PENDING'::notification_status)")).toBe(false);
  });

  it("fails closed on a wrong key column", () => {
    const result = classifyIndex(facts({ columns: ["status", "id"] }));
    expect(result.kind).toBe("MISMATCH");
  });

  it("fails closed on reversed key order", () => {
    const result = classifyIndex(facts({ columns: ["id", "created_at"] }));
    expect(result.kind).toBe("MISMATCH");
  });

  it("fails closed when the index is unique", () => {
    expect(classifyIndex(facts({ unique: true })).kind).toBe("MISMATCH");
  });

  it("fails closed when the index is not valid or not ready", () => {
    expect(classifyIndex(facts({ valid: false })).kind).toBe("MISMATCH");
    expect(classifyIndex(facts({ ready: false })).kind).toBe("MISMATCH");
  });

  it("fails closed on a full index without the partial predicate", () => {
    expect(classifyIndex(facts({ predicate: null })).kind).toBe("MISMATCH");
  });

  it("fails closed when an INCLUDE column is present", () => {
    const result = classifyIndex(
      facts({ columnCount: 3, columns: ["created_at", "id", "attempts"] }),
    );
    expect(result.kind).toBe("MISMATCH");
  });

  it("fails closed on key count mismatch", () => {
    expect(
      classifyIndex(facts({ keyCount: 1, columnCount: 1, columns: ["created_at"] })).kind,
    ).toBe("MISMATCH");
  });

  it("fails closed when the same-name index is on another table", () => {
    expect(classifyIndex(facts({ table: "orders" })).kind).toBe("MISMATCH");
  });

  it("freezes the expected contract constants", () => {
    expect(NOTIFICATION_PENDING_INDEX.indexName).toBe(
      "notifications_pending_created_id_idx",
    );
    expect(NOTIFICATION_PENDING_INDEX.tableName).toBe("notifications");
    expect(NOTIFICATION_PENDING_INDEX.keyColumns).toEqual(["created_at", "id"]);
  });

  it("never returns SATISFIED when any structural dimension differs", () => {
    const mutations: Array<Partial<IndexFacts>> = [
      { table: "orders" },
      { valid: false },
      { ready: false },
      { unique: true },
      { keyCount: 1, columnCount: 1, columns: ["created_at"] },
      { columnCount: 3, columns: ["created_at", "id", "attempts"] },
      { columns: ["created_at", "status"] },
      { predicate: null },
      { predicate: "(status = 'SENT'::notification_status)" },
    ];
    for (const mutation of mutations) {
      expect(classifyIndex(facts(mutation)).kind).toBe("MISMATCH");
    }
  });
});

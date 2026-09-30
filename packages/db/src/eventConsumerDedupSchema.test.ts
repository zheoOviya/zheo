import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { event_consumer_dedup } from "../index";

function readAllMigrations(): string {
  const dir = join(__dirname, "..", "drizzle");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  expect(files.length).toBeGreaterThan(0);
  return files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
}

const sql = readAllMigrations();

describe("event_consumer_dedup schema (EVT-C1 durable consumer inbox)", () => {
  it("creates the event_consumer_dedup table", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "event_consumer_dedup"/);
  });

  it("enforces NOT NULL on consumer_name, event_id and processed_at", () => {
    expect(sql).toMatch(/"consumer_name" text NOT NULL/);
    expect(sql).toMatch(/"event_id" uuid NOT NULL/);
    expect(sql).toMatch(/"processed_at" timestamp with time zone DEFAULT now\(\) NOT NULL/);
  });

  it("keys exactly on (consumer_name, event_id)", () => {
    expect(sql).toMatch(
      /CONSTRAINT "event_consumer_dedup_consumer_name_event_id_pk" PRIMARY KEY\("consumer_name","event_id"\)/,
    );
  });

  it("defaults processed_at to now()", () => {
    expect(sql).toMatch(/"processed_at" timestamp with time zone DEFAULT now\(\)/);
  });

  it("declares no business-key columns or foreign keys", () => {
    const block = sql.match(
      /CREATE TABLE IF NOT EXISTS "event_consumer_dedup" \(([\s\S]*?)\);/,
    );
    expect(block).not.toBeNull();
    expect(block![1]).not.toMatch(/FOREIGN KEY/);
    expect(block![1]).not.toMatch(/"order_id"/);
    expect(block![1]).not.toMatch(/"gift_id"/);
  });

  it("exports the table from the package barrel", () => {
    expect(event_consumer_dedup).toBeDefined();
  });
});

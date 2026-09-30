import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { eventOutboxStatusEnum, event_outbox } from "../index";

function readAllMigrations(): string {
  const dir = join(__dirname, "..", "drizzle");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  expect(files.length).toBeGreaterThan(0);
  return files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
}

const sql = readAllMigrations();

describe("event_outbox schema (EVT-A durable event outbox)", () => {
  it("defines the event_outbox_status enum with only PENDING/CLAIMED/DEAD", () => {
    expect(sql).toMatch(
      /CREATE TYPE "public"\."event_outbox_status" AS ENUM\('PENDING', 'CLAIMED', 'DEAD'\)/,
    );
    expect(eventOutboxStatusEnum.enumValues).toEqual([
      "PENDING",
      "CLAIMED",
      "DEAD",
    ]);
  });

  it("does not prematurely encode a successful-delivery state", () => {
    expect(eventOutboxStatusEnum.enumValues).not.toContain("SENT");
    expect(eventOutboxStatusEnum.enumValues).not.toContain("PUBLISHED");
  });

  it("creates the event_outbox table", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "event_outbox"/);
  });

  it("enforces NOT NULL on every required column", () => {
    for (const column of [
      "event_id",
      "event_name",
      "aggregate_id",
      "payload",
      "metadata",
      "status",
      "attempts",
      "next_attempt_at",
      "created_at",
    ]) {
      expect(sql).toMatch(new RegExp(`"${column}"[^,\\n]*NOT NULL`));
    }
  });

  it("stores payload and metadata as jsonb", () => {
    expect(sql).toMatch(/"payload" jsonb NOT NULL/);
    expect(sql).toMatch(/"metadata" jsonb NOT NULL/);
  });

  it("defaults status to PENDING and attempts to 0", () => {
    expect(sql).toMatch(
      /"status" "event_outbox_status" DEFAULT 'PENDING' NOT NULL/,
    );
    expect(sql).toMatch(/"attempts" integer DEFAULT 0 NOT NULL/);
  });

  it("makes event_id UNIQUE", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "event_outbox_event_id_uq" ON "event_outbox" USING btree \("event_id"\)/,
    );
  });

  it("creates the (status, next_attempt_at) retry scan index", () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "event_outbox_status_next_idx" ON "event_outbox" USING btree \("status","next_attempt_at"\)/,
    );
  });

  it("declares no single-aggregate foreign key", () => {
    const block = sql.match(
      /CREATE TABLE IF NOT EXISTS "event_outbox" \(([\s\S]*?)\);/,
    );
    expect(block).not.toBeNull();
    expect(block![1]).not.toMatch(/FOREIGN KEY/);
  });

  it("exports the table and enum from the package barrel", () => {
    expect(event_outbox).toBeDefined();
    expect(eventOutboxStatusEnum).toBeDefined();
  });
});

import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// @ts-expect-error - the guard library is intentionally plain Node ESM with no TS declarations
import * as guard from "../scripts/migration_monotonicity_guard.lib.mjs";

const {
  EXIT_USAGE,
  GuardError,
  MODE_GENERATE,
  acquireGuardLock,
  buildDrizzleConfigArgs,
  buildDrizzleInvocation,
  buildStagedConfigSource,
  computeGlobalMaxWhen,
  computeSafeWhen,
  deepEqualJson,
  evaluateJournalPresence,
  isDirtyMigrationStatus,
  isSafeTimestampInteger,
  parseJournalText,
  resolveMode,
  validateAppendedEntry,
  validateArtifactTopology,
  validateFrontier,
  validateHistoricalPrefix,
  validateJournal,
  validateJournalEntries,
  validateNewArtifactNames,
} = guard;

type JournalEntry = { idx: number; when: number; tag: string; breakpoints: boolean };

function entry(idx: number, when: number, tag = `mig_${idx}`): JournalEntry {
  return { idx, when, tag, breakpoints: true };
}

function journal(entries: JournalEntry[]) {
  return { version: "7", dialect: "postgresql", entries };
}

describe("migration monotonicity guard: pure journal validation", () => {
  it("MG-1 passes a normal monotonic journal", () => {
    const result = validateFrontier(journal([entry(0, 100), entry(1, 200), entry(2, 300)]));
    expect(result.ok).toBe(true);
    expect(result.globalMaxWhen).toBe(300);
    expect(result.frontierWhen).toBe(300);
  });

  it("MG-2 uses the global maximum across all entries, not the last arbitrary value", () => {
    const entries = [entry(0, 1000), entry(1, 500), entry(2, 900)];
    expect(computeGlobalMaxWhen(entries)).toBe(1000);
    const result = validateJournal(journal(entries));
    expect(result.ok).toBe(true);
    expect(result.globalMaxWhen).toBe(1000);
    expect(computeSafeWhen(800, result.globalMaxWhen!).safeWhen).toBe(1001);
  });

  it("MG-3 normalizes a raw when below the global maximum to max + 1", () => {
    const result = computeSafeWhen(500, 1000);
    expect(result.safeWhen).toBe(1001);
    expect(result.requiredFloor).toBe(1001);
    expect(result.normalized).toBe(true);
  });

  it("MG-4 normalizes a raw when equal to the global maximum to max + 1", () => {
    const result = computeSafeWhen(1000, 1000);
    expect(result.safeWhen).toBe(1001);
    expect(result.normalized).toBe(true);
  });

  it("MG-5 preserves a raw when above the global maximum", () => {
    const result = computeSafeWhen(2000, 1000);
    expect(result.safeWhen).toBe(2000);
    expect(result.normalized).toBe(false);
  });

  it("MG-6 keeps the final when strictly greater when raw equals the historical maximum", () => {
    const { safeWhen } = computeSafeWhen(1000, 1000);
    expect(safeWhen).toBeGreaterThan(1000);
  });

  it("MG-7 keeps the final when strictly greater when raw is below the historical maximum", () => {
    const { safeWhen } = computeSafeWhen(400, 1000);
    expect(safeWhen).toBeGreaterThan(1000);
  });

  it("MG-8 fails when the historical prefix is mutated", () => {
    const original = [entry(0, 100), entry(1, 200)];
    const staged = [entry(0, 999), entry(1, 200), entry(2, 300)];
    const result = validateHistoricalPrefix(original, staged);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("entry[0]");
  });

  it("MG-9 fails on a duplicate idx", () => {
    const result = validateJournalEntries([entry(0, 100), entry(0, 200)]);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("duplicate idx");
  });

  it("MG-10 fails on a duplicate tag", () => {
    const result = validateJournalEntries([entry(0, 100, "same"), entry(1, 200, "same")]);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("duplicate tag");
  });

  it("MG-11 fails on malformed JSON and on a missing when", () => {
    expect(() => parseJournalText("{ not json", "fixture")).toThrow(GuardError);
    const result = validateJournalEntries([{ idx: 0, tag: "a" } as unknown as JournalEntry]);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("when");
  });

  it("MG-12 fails on negative, non-integer, non-finite and unsafe when values", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(isSafeTimestampInteger(bad)).toBe(false);
      const result = validateJournalEntries([entry(0, bad)]);
      expect(result.ok).toBe(false);
      expect(() => computeSafeWhen(bad, 0)).toThrow(GuardError);
    }
  });

  it("MG-13 accepts a valid empty journal as fresh with a global max of zero", () => {
    const result = validateJournal(journal([]));
    expect(result.ok).toBe(true);
    expect(result.globalMaxWhen).toBe(0);
    expect(validateFrontier(journal([])).ok).toBe(true);
  });

  it("MG-14 fails when the journal is missing while the migration structure exists", () => {
    expect(() =>
      evaluateJournalPresence({
        journalExists: false,
        migrationDirectoryExists: true,
        journalPath: "/repo/packages/db/drizzle/meta/_journal.json",
      }),
    ).toThrow(GuardError);
    expect(() =>
      evaluateJournalPresence({
        journalExists: false,
        migrationDirectoryExists: false,
        journalPath: "/repo/packages/db/drizzle/meta/_journal.json",
      }),
    ).not.toThrow();
  });

  it("MG-15 fails when more than one entry is appended", () => {
    const original = [entry(0, 100)];
    const staged = [entry(0, 100), entry(1, 200), entry(2, 300)];
    const result = validateAppendedEntry({ originalEntries: original, stagedEntries: staged });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("exactly one appended");
  });

  it("MG-16 rejects append-contract violations including a mutated old entry", () => {
    const original = [entry(0, 100), entry(1, 200)];
    const staged = [entry(0, 100), entry(1, 200), entry(2, 300)];
    expect(validateAppendedEntry({ originalEntries: original, stagedEntries: staged }).ok).toBe(true);
    const mutated = [entry(0, 100), entry(1, 250), entry(2, 300)];
    expect(validateHistoricalPrefix(original, mutated).ok).toBe(false);
  });

  it("tolerates historical timestamp regression while enforcing a strict frontier", () => {
    const entries = [entry(0, 1000), entry(1, 500), entry(2, 400), entry(3, 2000)];
    const result = validateFrontier(journal(entries));
    expect(result.ok).toBe(true);
    expect(result.frontierWhen).toBe(2000);
    expect(result.globalMaxWhen).toBe(2000);
    expect(computeGlobalMaxWhen(entries)).toBe(2000);
  });

  it("fails when the frontier is not strictly above every other entry", () => {
    const result = validateFrontier(journal([entry(0, 300), entry(1, 1000), entry(2, 500)]));
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("strictly greater");
  });
});

describe("migration monotonicity guard: structural invariants", () => {
  it("fails on a duplicate when", () => {
    const result = validateJournalEntries([entry(0, 100), entry(1, 100)]);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("duplicate when");
  });

  it("fails when the last array entry does not hold the maximum idx", () => {
    const result = validateJournalEntries([entry(0, 100), entry(2, 200), entry(1, 300)]);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("maximum idx");
  });

  it("fails when idx order is not strictly increasing", () => {
    const result = validateJournalEntries([entry(2, 100), entry(1, 200)]);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("strictly increasing");
  });

  it("fails closed when global max is at Number.MAX_SAFE_INTEGER", () => {
    expect(() => computeSafeWhen(1, Number.MAX_SAFE_INTEGER)).toThrow(GuardError);
    const unsafe = validateJournalEntries([entry(0, Number.MAX_SAFE_INTEGER + 1)]);
    expect(unsafe.ok).toBe(false);
  });

  it("rejects unknown or missing command modes with a usage error", () => {
    expect(resolveMode(["generate"])).toBe("generate");
    expect(resolveMode(["check"])).toBe("check");
    for (const argv of [[], ["bogus"], ["--help"]] as string[][]) {
      let thrown: unknown;
      try {
        resolveMode(argv);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(GuardError);
      expect((thrown as InstanceType<typeof GuardError>).exitCode).toBe(EXIT_USAGE);
    }
  });

  it("detects a dirty migration directory from git porcelain output", () => {
    expect(isDirtyMigrationStatus("")).toBe(false);
    expect(isDirtyMigrationStatus("\n")).toBe(false);
    expect(isDirtyMigrationStatus(" M packages/db/drizzle/0000_demonic_nova.sql\n")).toBe(true);
    expect(isDirtyMigrationStatus("?? packages/db/drizzle/meta/0099_snapshot.json\n")).toBe(true);
  });

  it("fails closed when a guard lock already exists and releases its own lock", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mg-guard-lock-"));
    const lockPath = path.join(directory, ".migration-generation.guard.lock");
    const lock = acquireGuardLock({ lockPath, mode: MODE_GENERATE, pid: 1234, nowMs: 1_000 });
    try {
      expect(existsSync(lockPath)).toBe(true);
      let thrown: unknown;
      try {
        acquireGuardLock({ lockPath, mode: MODE_GENERATE, pid: 5678, nowMs: 2_000 });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(GuardError);
      expect((thrown as Error).message).toContain("already held");
      expect((thrown as Error).message).toContain("pid=1234");
    } finally {
      lock.release();
      rmSync(directory, { recursive: true, force: true });
    }
    expect(existsSync(lockPath)).toBe(false);
  });

  it("builds a shell-free drizzle invocation with a relative staged config", () => {
    const invocation = buildDrizzleInvocation({
      execPath: "/usr/bin/node",
      binPath: "/repo/node_modules/drizzle-kit/bin.cjs",
      configPath: ".migration-generation.guard.config.ts",
    });
    expect(invocation.command).toBe("/usr/bin/node");
    expect(invocation.args).toEqual([
      "/repo/node_modules/drizzle-kit/bin.cjs",
      "generate",
      "--config",
      ".migration-generation.guard.config.ts",
    ]);
    expect(invocation.options.shell).toBe(false);
  });

  it("builds a staged config that reuses the real config and overrides out", () => {
    const source = buildStagedConfigSource({
      importSpecifier: "./drizzle.config.ts",
      out: ".migration-generation-staging-abc",
    });
    expect(source).toContain('import base from "./drizzle.config.ts";');
    expect(source).toContain('out: ".migration-generation-staging-abc"');
  });

  it("rejects an absolute staged config path or out directory", () => {
    expect(() => buildDrizzleConfigArgs("/tmp/staged.config.ts")).toThrow(GuardError);
    expect(() => buildDrizzleConfigArgs("")).toThrow(GuardError);
    expect(() =>
      buildStagedConfigSource({ importSpecifier: "./drizzle.config.ts", out: "/tmp/staged" }),
    ).toThrow(GuardError);
  });

  it("validates the staged artifact topology", () => {
    const original = ["0000_a.sql", "meta/0000_snapshot.json"];
    const staged = [...original, "0001_b.sql", "meta/0001_snapshot.json"];
    const result = validateArtifactTopology({ originalPaths: original, stagedPaths: staged });
    expect(result.ok).toBe(true);
    expect(result.newSql).toEqual(["0001_b.sql"]);
    expect(result.newSnapshots).toEqual(["meta/0001_snapshot.json"]);

    const deleted = validateArtifactTopology({
      originalPaths: original,
      stagedPaths: ["meta/0000_snapshot.json", "0001_b.sql", "meta/0001_snapshot.json"],
    });
    expect(deleted.ok).toBe(false);

    const unexpected = validateArtifactTopology({
      originalPaths: original,
      stagedPaths: [...original, "0001_b.sql", "meta/0001_snapshot.json", "extra.txt"],
    });
    expect(unexpected.ok).toBe(false);
    expect(unexpected.errors.join(" ")).toContain("unexpected");
  });

  it("validates generated artifact names against the journal entry", () => {
    const ok = validateNewArtifactNames({
      newSql: ["0023_grey_lord.sql"],
      newSnapshots: ["meta/0023_snapshot.json"],
      tag: "0023_grey_lord",
      idx: 23,
    });
    expect(ok.ok).toBe(true);
    const bad = validateNewArtifactNames({
      newSql: ["0023_other.sql"],
      newSnapshots: ["meta/0023_snapshot.json"],
      tag: "0023_grey_lord",
      idx: 23,
    });
    expect(bad.ok).toBe(false);
  });

  it("compares journal entries structurally rather than textually", () => {
    expect(deepEqualJson({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 })).toBe(true);
    expect(deepEqualJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqualJson([entry(0, 1)], [{ tag: "mig_0", when: 1, idx: 0, breakpoints: true }])).toBe(
      true,
    );
  });
});

describe("migration monotonicity guard: committed journal invariant (CI defense in depth)", () => {
  const committedJournalPath = fileURLToPath(
    new URL("../drizzle/meta/_journal.json", import.meta.url),
  );

  it("passes the frontier invariant on the committed journal", () => {
    const journal = parseJournalText(readFileSync(committedJournalPath, "utf8"), committedJournalPath);
    const result = validateFrontier(journal, committedJournalPath);
    expect(result.ok).toBe(true);
    expect(result.globalMaxWhen).toBeGreaterThan(0);
    expect(result.frontierWhen).toBe(result.globalMaxWhen);
  });
});

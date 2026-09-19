// Pure, dependency-free helpers for the migration generation monotonicity guard.
//
// This module intentionally uses only the Node standard library so that the
// public `db:generate` command remains portable and auditable. All clock reads
// are injected by the caller, which keeps every function deterministic and
// unit-testable without sleeps or OS clock manipulation.

import { isAbsolute } from "node:path";
import * as nodeFs from "node:fs";

export const EXIT_OK = 0;
export const EXIT_POLICY = 1;
export const EXIT_USAGE = 2;

export const MODE_GENERATE = "generate";
export const MODE_CHECK = "check";

export const DRIZZLE_DIRECTORY_NAME = "drizzle";
export const JOURNAL_RELATIVE_PATH = "meta/_journal.json";

export class GuardError extends Error {
  constructor(message, exitCode = EXIT_POLICY) {
    super(message);
    this.name = "GuardError";
    this.exitCode = exitCode;
  }
}

export function resolveMode(argv) {
  const mode = Array.isArray(argv) ? argv[0] : undefined;
  if (mode === MODE_GENERATE || mode === MODE_CHECK) {
    return mode;
  }
  throw new GuardError(
    `unknown or missing mode ${JSON.stringify(mode ?? null)}; expected "${MODE_GENERATE}" or "${MODE_CHECK}"`,
    EXIT_USAGE,
  );
}

export function isSafeTimestampInteger(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

export function parseJournalText(text, source = "journal") {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new GuardError(`malformed journal JSON in ${source}: ${error.message}`, EXIT_POLICY);
  }
}

export function extractEntries(journal, source = "journal") {
  if (journal === null || typeof journal !== "object" || Array.isArray(journal)) {
    throw new GuardError(`${source} must be a JSON object`, EXIT_POLICY);
  }
  if (!Array.isArray(journal.entries)) {
    throw new GuardError(`${source}.entries must be an array`, EXIT_POLICY);
  }
  return journal.entries;
}

export function computeGlobalMaxWhen(entries) {
  let max = 0;
  for (const entry of entries) {
    if (isSafeTimestampInteger(entry?.when) && entry.when > max) {
      max = entry.when;
    }
  }
  return max;
}

export function validateJournalEntries(entries) {
  const errors = [];
  const idxSeen = new Set();
  const tagSeen = new Set();
  const whenSeen = new Set();
  let previousIdx = null;

  entries.forEach((entry, position) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`entry[${position}] must be an object`);
      return;
    }

    const { idx, tag, when } = entry;

    if (!isSafeTimestampInteger(idx)) {
      errors.push(`entry[${position}].idx must be a non-negative safe integer`);
    } else if (idxSeen.has(idx)) {
      errors.push(`duplicate idx ${idx} at entry[${position}]`);
    } else {
      idxSeen.add(idx);
    }

    if (typeof tag !== "string" || tag.length === 0) {
      errors.push(`entry[${position}].tag must be a non-empty string`);
    } else if (tagSeen.has(tag)) {
      errors.push(`duplicate tag "${tag}" at entry[${position}]`);
    } else {
      tagSeen.add(tag);
    }

    if (!isSafeTimestampInteger(when)) {
      errors.push(`entry[${position}].when must be a non-negative safe integer`);
    } else if (whenSeen.has(when)) {
      errors.push(`duplicate when ${when} at entry[${position}]`);
    } else {
      whenSeen.add(when);
    }

    if (isSafeTimestampInteger(idx)) {
      if (previousIdx !== null && !(idx > previousIdx)) {
        errors.push(
          `idx order must be strictly increasing at entry[${position}] (${previousIdx} -> ${idx})`,
        );
      }
      previousIdx = idx;
    }
  });

  if (entries.length > 0) {
    const last = entries[entries.length - 1];
    const idxValues = entries.filter((entry) => isSafeTimestampInteger(entry?.idx)).map((e) => e.idx);
    if (idxValues.length > 0 && isSafeTimestampInteger(last?.idx)) {
      const maxIdx = Math.max(...idxValues);
      if (last.idx !== maxIdx) {
        errors.push(`last array entry (idx ${last.idx}) must hold the maximum idx (${maxIdx})`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function validateJournal(journal, source = "journal") {
  const entries = extractEntries(journal, source);
  const result = validateJournalEntries(entries);
  return {
    ok: result.ok,
    errors: result.errors,
    entries,
    globalMaxWhen: result.ok ? computeGlobalMaxWhen(entries) : null,
  };
}

export function validateFrontier(journal, source = "journal") {
  const validation = validateJournal(journal, source);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors, globalMaxWhen: null, frontierWhen: null };
  }

  const { entries, globalMaxWhen } = validation;
  const errors = [];
  let frontierWhen = 0;

  if (entries.length > 0) {
    const last = entries[entries.length - 1];
    frontierWhen = last.when;
    const others = entries.slice(0, -1);
    const othersMax = others.reduce((max, entry) => Math.max(max, entry.when), 0);
    if (others.length > 0 && !(last.when > othersMax)) {
      errors.push(
        `frontier entry (idx ${last.idx}, when ${last.when}) must be strictly greater than every other entry (max ${othersMax})`,
      );
    }
  }

  return { ok: errors.length === 0, errors, globalMaxWhen, frontierWhen };
}

export function computeSafeWhen(rawWhen, globalMaxWhen) {
  if (!isSafeTimestampInteger(rawWhen)) {
    throw new GuardError(
      `raw generated when ${String(rawWhen)} is not a non-negative safe integer`,
      EXIT_POLICY,
    );
  }
  if (!isSafeTimestampInteger(globalMaxWhen)) {
    throw new GuardError(
      `global max when ${String(globalMaxWhen)} is not a non-negative safe integer`,
      EXIT_POLICY,
    );
  }
  if (globalMaxWhen >= Number.MAX_SAFE_INTEGER) {
    throw new GuardError(
      `global max when ${globalMaxWhen} is at or above Number.MAX_SAFE_INTEGER; refusing to compute an unsafe timestamp`,
      EXIT_POLICY,
    );
  }

  const requiredFloor = globalMaxWhen + 1;
  const safeWhen = Math.max(rawWhen, requiredFloor);
  return { safeWhen, requiredFloor, normalized: safeWhen !== rawWhen };
}

export function deepEqualJson(a, b) {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((value, index) => deepEqualJson(value, b[index]));
  }
  if (typeof a === "object") {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    return aKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqualJson(a[key], b[key]),
    );
  }
  return false;
}

export function validateHistoricalPrefix(originalEntries, stagedEntries) {
  const errors = [];
  if (stagedEntries.length < originalEntries.length) {
    errors.push(
      `staged journal lost entries (${originalEntries.length} -> ${stagedEntries.length})`,
    );
  }
  const limit = Math.min(originalEntries.length, stagedEntries.length);
  for (let index = 0; index < limit; index += 1) {
    if (!deepEqualJson(originalEntries[index], stagedEntries[index])) {
      errors.push(`historical journal entry[${index}] was mutated`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateAppendedEntry({ originalEntries, stagedEntries }) {
  const errors = [];
  const appendedCount = stagedEntries.length - originalEntries.length;

  if (appendedCount !== 1) {
    errors.push(`expected exactly one appended journal entry (found ${appendedCount})`);
    return { ok: false, errors, appended: null, priorLastIdx: null };
  }

  const appended = stagedEntries[stagedEntries.length - 1];
  const priorLastIdx =
    originalEntries.length === 0 ? -1 : originalEntries[originalEntries.length - 1].idx;
  const historicalMaxIdx = originalEntries.reduce(
    (max, entry) => Math.max(max, isSafeTimestampInteger(entry?.idx) ? entry.idx : max),
    -1,
  );

  if (appended.idx !== priorLastIdx + 1) {
    errors.push(
      `appended idx ${String(appended.idx)} must equal previous last idx + 1 (${priorLastIdx + 1})`,
    );
  }
  if (!(appended.idx > historicalMaxIdx)) {
    errors.push(
      `appended idx ${String(appended.idx)} must exceed every historical idx (max ${historicalMaxIdx})`,
    );
  }
  if (typeof appended.tag !== "string" || appended.tag.length === 0) {
    errors.push("appended tag must be a non-empty string");
  } else if (originalEntries.some((entry) => entry?.tag === appended.tag)) {
    errors.push(`appended tag "${appended.tag}" must be unique`);
  }
  if (!isSafeTimestampInteger(appended.when)) {
    errors.push(`appended when ${String(appended.when)} must be a non-negative safe integer`);
  }

  return { ok: errors.length === 0, errors, appended, priorLastIdx };
}

export function validateArtifactTopology({ originalPaths, stagedPaths }) {
  const originalSet = new Set(originalPaths);
  const stagedSet = new Set(stagedPaths);

  const newPaths = stagedPaths.filter((entry) => !originalSet.has(entry));
  const deletedPaths = originalPaths.filter((entry) => !stagedSet.has(entry));
  const errors = [];

  if (deletedPaths.length > 0) {
    errors.push(`staged output deleted historical migration files: ${deletedPaths.join(", ")}`);
  }

  const newSql = newPaths.filter((entry) => !entry.includes("/") && entry.endsWith(".sql"));
  const newSnapshots = newPaths.filter((entry) => /^meta\/\d+_snapshot\.json$/.test(entry));
  const unexpected = newPaths.filter(
    (entry) => !newSql.includes(entry) && !newSnapshots.includes(entry),
  );

  if (unexpected.length > 0) {
    errors.push(`unexpected staged artifacts: ${unexpected.join(", ")}`);
  }
  if (newSql.length !== 1) {
    errors.push(`expected exactly one new SQL migration (found ${newSql.length})`);
  }
  if (newSnapshots.length !== 1) {
    errors.push(`expected exactly one new snapshot (found ${newSnapshots.length})`);
  }

  return { ok: errors.length === 0, errors, newSql, newSnapshots, deletedPaths, unexpected };
}

export function validateNewArtifactNames({ newSql, newSnapshots, tag, idx }) {
  const errors = [];
  const expectedSql = `${tag}.sql`;
  const expectedSnapshot = `meta/${String(idx).padStart(4, "0")}_snapshot.json`;

  if (newSql.length === 1 && newSql[0] !== expectedSql) {
    errors.push(`generated SQL ${newSql[0]} does not match the generated tag (${expectedSql})`);
  }
  if (newSnapshots.length === 1 && newSnapshots[0] !== expectedSnapshot) {
    errors.push(
      `generated snapshot ${newSnapshots[0]} does not match the generated idx (${expectedSnapshot})`,
    );
  }

  return { ok: errors.length === 0, errors, expectedSql, expectedSnapshot };
}

export function buildDrizzleConfigArgs(configPath) {
  if (typeof configPath !== "string" || configPath.length === 0) {
    throw new GuardError("staged drizzle config path is required", EXIT_USAGE);
  }
  if (isAbsolute(configPath)) {
    throw new GuardError(
      `staged drizzle config path must be relative (received absolute path ${configPath})`,
      EXIT_USAGE,
    );
  }
  return [MODE_GENERATE, "--config", configPath];
}

export function buildDrizzleInvocation({ execPath, binPath, configPath }) {
  if (typeof execPath !== "string" || execPath.length === 0) {
    throw new GuardError("process.execPath could not be resolved", EXIT_USAGE);
  }
  if (typeof binPath !== "string" || binPath.length === 0) {
    throw new GuardError("drizzle-kit CLI bin path could not be resolved", EXIT_USAGE);
  }
  return {
    command: execPath,
    args: [binPath, ...buildDrizzleConfigArgs(configPath)],
    options: { shell: false },
  };
}

export function buildStagedConfigSource({ importSpecifier, out }) {
  if (typeof importSpecifier !== "string" || importSpecifier.length === 0) {
    throw new GuardError("staged config import specifier is required", EXIT_USAGE);
  }
  if (typeof out !== "string" || out.length === 0 || isAbsolute(out)) {
    throw new GuardError(
      `staged config out must be a non-empty relative path (received ${String(out)})`,
      EXIT_USAGE,
    );
  }
  return `import base from ${JSON.stringify(importSpecifier)};\nexport default { ...base, out: ${JSON.stringify(out)} };\n`;
}

export function buildLockContent({ pid, createdAtMs, mode }) {
  return JSON.stringify({ pid, createdAtMs, mode });
}

export function parseLockContent(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function acquireGuardLock({
  lockPath,
  mode,
  pid = process.pid,
  nowMs = Date.now(),
  fsModule = nodeFs,
}) {
  let fd;
  try {
    fd = fsModule.openSync(lockPath, "wx");
  } catch (error) {
    if (error && error.code === "EEXIST") {
      let existing = null;
      try {
        existing = parseLockContent(fsModule.readFileSync(lockPath, "utf8"));
      } catch {
        existing = null;
      }
      const detail = existing
        ? `pid=${String(existing.pid)} createdAt=${String(existing.createdAtMs)} ageMs=${nowMs - Number(existing.createdAtMs)}`
        : "contents unparseable";
      throw new GuardError(
        `guard lock already held at ${lockPath} (${detail}); refusing to run. Do not remove it unless you are certain no generation is active.`,
        EXIT_POLICY,
      );
    }
    throw new GuardError(
      `unable to create guard lock ${lockPath}: ${error?.message ?? String(error)}`,
      EXIT_USAGE,
    );
  }

  try {
    fsModule.writeSync(fd, buildLockContent({ pid, createdAtMs: nowMs, mode }));
  } finally {
    fsModule.closeSync(fd);
  }

  let released = false;
  return {
    path: lockPath,
    content: buildLockContent({ pid, createdAtMs: nowMs, mode }),
    release() {
      if (released) {
        return;
      }
      released = true;
      try {
        fsModule.unlinkSync(lockPath);
      } catch {
        // The lock is best-effort cleanup; a stale lock must never be auto-broken.
      }
    },
  };
}

export function isDirtyMigrationStatus(porcelainOutput) {
  return typeof porcelainOutput === "string" && porcelainOutput.trim().length > 0;
}

export function evaluateJournalPresence({
  journalExists,
  migrationDirectoryExists,
  journalPath,
}) {
  if (journalExists) {
    return;
  }
  if (migrationDirectoryExists) {
    throw new GuardError(
      `migration journal is missing at ${journalPath} while the migration directory exists; refusing to generate`,
      EXIT_POLICY,
    );
  }
}

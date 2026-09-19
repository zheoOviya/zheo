#!/usr/bin/env node
// Guarded replacement for `drizzle-kit generate`.
//
// The public `@snakzap/db` `db:generate` command routes through this wrapper so
// that a committed migration can never be generated with a `when` timestamp at
// or below the maximum timestamp already present in the migration journal.
//
// Strategy (A1 "Option F"):
//   1. refuse to run when the migration area is dirty or locked
//   2. seed a staged copy of the real drizzle directory
//   3. run the installed drizzle-kit CLI into the staged directory (relative --out)
//   4. validate the staged journal/artifacts and normalize only the new `when`
//   5. copy the new SQL, new snapshot, then the journal into the real directory
//   6. re-validate the real journal after the copy
//
// Node standard library only. No shell interpolation, no OS clock mutation.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  EXIT_OK,
  EXIT_POLICY,
  EXIT_USAGE,
  JOURNAL_RELATIVE_PATH,
  MODE_CHECK,
  MODE_GENERATE,
  GuardError,
  acquireGuardLock,
  buildDrizzleInvocation,
  buildStagedConfigSource,
  computeSafeWhen,
  evaluateJournalPresence,
  extractEntries,
  isDirtyMigrationStatus,
  parseJournalText,
  resolveMode,
  validateAppendedEntry,
  validateArtifactTopology,
  validateFrontier,
  validateHistoricalPrefix,
  validateJournal,
  validateNewArtifactNames,
} from "./migration_monotonicity_guard.lib.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(scriptDirectory, "..");
const drizzleDirectory = path.join(packageDirectory, "drizzle");
const journalPath = path.join(drizzleDirectory, "meta", "_journal.json");
const lockPath = path.join(packageDirectory, ".migration-generation.guard.lock");
const drizzleConfigPath = path.join(packageDirectory, "drizzle.config.ts");
const stagedConfigPath = path.join(packageDirectory, ".migration-generation.guard.config.ts");

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function readJournalFrom(filePath) {
  evaluateJournalPresence({
    journalExists: fs.existsSync(filePath),
    migrationDirectoryExists: fs.existsSync(drizzleDirectory),
    journalPath: filePath,
  });

  if (!fs.existsSync(filePath)) {
    return { journal: { version: "7", dialect: "postgresql", entries: [] } };
  }

  return { journal: parseJournalText(fs.readFileSync(filePath, "utf8"), filePath) };
}

function resolveDrizzleBin() {
  const require = createRequire(import.meta.url);
  let entry;
  try {
    entry = require.resolve("drizzle-kit");
  } catch (error) {
    throw new GuardError(
      `cannot resolve drizzle-kit from @snakzap/db (${error.message}); run "pnpm install" first`,
      EXIT_USAGE,
    );
  }

  let directory = path.dirname(entry);
  let packageJsonPath = null;
  for (;;) {
    const candidate = path.join(directory, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const candidatePackage = JSON.parse(fs.readFileSync(candidate, "utf8"));
        if (candidatePackage.name === "drizzle-kit") {
          packageJsonPath = candidate;
          break;
        }
      } catch {
        // keep walking
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  if (packageJsonPath === null) {
    throw new GuardError("unable to locate the installed drizzle-kit package root", EXIT_USAGE);
  }

  const drizzlePackage = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const binRelative =
    typeof drizzlePackage.bin === "string"
      ? drizzlePackage.bin
      : drizzlePackage.bin?.["drizzle-kit"];
  if (typeof binRelative !== "string" || binRelative.length === 0) {
    throw new GuardError("the installed drizzle-kit package declares no CLI bin", EXIT_USAGE);
  }

  const binPath = path.resolve(path.dirname(packageJsonPath), binRelative);
  if (!fs.existsSync(binPath)) {
    throw new GuardError(`resolved drizzle-kit CLI bin does not exist: ${binPath}`, EXIT_USAGE);
  }
  return binPath;
}

function assertMigrationAreaClean() {
  const root = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: packageDirectory,
    encoding: "utf8",
  });
  if (root.error || root.status !== 0) {
    throw new GuardError(
      "git is required to verify that the migration directory matches HEAD",
      EXIT_USAGE,
    );
  }

  const repoRoot = root.stdout.trim();
  const relativeDrizzle = toPosix(path.relative(repoRoot, drizzleDirectory));
  const status = spawnSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--", relativeDrizzle],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (status.error || status.status !== 0) {
    throw new GuardError(
      `unable to inspect the migration directory status: ${status.stderr?.trim() ?? status.error?.message}`,
      EXIT_USAGE,
    );
  }
  if (isDirtyMigrationStatus(status.stdout)) {
    throw new GuardError(
      `migration directory ${relativeDrizzle} has uncommitted changes; commit or stash them before generating:\n${status.stdout.trimEnd()}`,
      EXIT_POLICY,
    );
  }
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

function listRelativeFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) {
    return files;
  }
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        files.push(toPosix(path.relative(root, absolute)));
      }
    }
  };
  walk(root);
  return files.sort();
}

function atomicCopy(source, destination) {
  const temporary = `${destination}.guard-${process.pid}.tmp`;
  fs.copyFileSync(source, temporary);
  fs.renameSync(temporary, destination);
}

function assertBytesEqual(first, second, label) {
  if (!fs.readFileSync(first).equals(fs.readFileSync(second))) {
    throw new GuardError(`post-copy verification failed: ${label} is not byte-equal`, EXIT_POLICY);
  }
}

function validateStagedAndCopyBack({ stagedDirectory, stagedRelative, originalEntries, globalMaxWhen }) {
  const stagedJournalPath = path.join(stagedDirectory, "meta", "_journal.json");

  const originalPaths = listRelativeFiles(drizzleDirectory).filter(
    (entry) => entry !== JOURNAL_RELATIVE_PATH,
  );
  const stagedPaths = listRelativeFiles(stagedDirectory).filter(
    (entry) => entry !== JOURNAL_RELATIVE_PATH,
  );

  const topology = validateArtifactTopology({ originalPaths, stagedPaths });
  if (!topology.ok) {
    throw new GuardError(
      `staged artifact topology is invalid:\n- ${topology.errors.join("\n- ")}`,
      EXIT_POLICY,
    );
  }

  for (const relativePath of originalPaths) {
    const originalBytes = fs.readFileSync(path.join(drizzleDirectory, relativePath));
    const stagedBytes = fs.readFileSync(path.join(stagedDirectory, relativePath));
    if (!originalBytes.equals(stagedBytes)) {
      throw new GuardError(
        `generation mutated a historical migration artifact: ${relativePath}`,
        EXIT_POLICY,
      );
    }
  }

  const stagedJournal = parseJournalText(fs.readFileSync(stagedJournalPath, "utf8"), stagedJournalPath);
  const stagedValidation = validateJournal(stagedJournal, stagedJournalPath);
  if (!stagedValidation.ok) {
    throw new GuardError(
      `staged journal is invalid:\n- ${stagedValidation.errors.join("\n- ")}`,
      EXIT_POLICY,
    );
  }
  const stagedEntries = stagedValidation.entries;

  const prefixCheck = validateHistoricalPrefix(originalEntries, stagedEntries);
  if (!prefixCheck.ok) {
    throw new GuardError(
      `staged journal mutated the historical prefix:\n- ${prefixCheck.errors.join("\n- ")}`,
      EXIT_POLICY,
    );
  }

  const appendCheck = validateAppendedEntry({ originalEntries, stagedEntries });
  if (!appendCheck.ok) {
    throw new GuardError(
      `staged journal violated the exactly-one-append contract:\n- ${appendCheck.errors.join("\n- ")}`,
      EXIT_POLICY,
    );
  }

  const nameCheck = validateNewArtifactNames({
    newSql: topology.newSql,
    newSnapshots: topology.newSnapshots,
    tag: appendCheck.appended.tag,
    idx: appendCheck.appended.idx,
  });
  if (!nameCheck.ok) {
    throw new GuardError(
      `staged artifacts do not match the generated journal entry:\n- ${nameCheck.errors.join("\n- ")}`,
      EXIT_POLICY,
    );
  }

  const rawGeneratedWhen = appendCheck.appended.when;
  const { safeWhen, requiredFloor, normalized } = computeSafeWhen(rawGeneratedWhen, globalMaxWhen);
  process.stdout.write(
    `[migration-guard] raw generated when=${rawGeneratedWhen} prior global max=${globalMaxWhen} ` +
      `required minimum=${requiredFloor} final safe when=${safeWhen} normalized=${normalized}\n`,
  );

  if (normalized) {
    appendCheck.appended.when = safeWhen;
    fs.writeFileSync(stagedJournalPath, JSON.stringify(stagedJournal, null, 2), "utf8");
  }

  const newSqlRelative = topology.newSql[0];
  const newSnapshotRelative = topology.newSnapshots[0];
  const realSqlPath = path.join(drizzleDirectory, newSqlRelative);
  const realSnapshotPath = path.join(drizzleDirectory, newSnapshotRelative);

  atomicCopy(path.join(stagedDirectory, newSqlRelative), realSqlPath);
  atomicCopy(path.join(stagedDirectory, newSnapshotRelative), realSnapshotPath);
  atomicCopy(stagedJournalPath, journalPath);

  const finalJournal = parseJournalText(fs.readFileSync(journalPath, "utf8"), journalPath);
  const finalValidation = validateJournal(finalJournal, journalPath);
  if (!finalValidation.ok) {
    throw new GuardError(
      `post-copy journal is invalid:\n- ${finalValidation.errors.join("\n- ")}`,
      EXIT_POLICY,
    );
  }

  const finalAppend = validateAppendedEntry({
    originalEntries,
    stagedEntries: finalValidation.entries,
  });
  if (!finalAppend.ok) {
    throw new GuardError(
      `post-copy journal violated the append contract (inspect ${stagedRelative})`,
      EXIT_POLICY,
    );
  }

  const finalPrefix = validateHistoricalPrefix(originalEntries, finalValidation.entries);
  if (!finalPrefix.ok) {
    throw new GuardError(
      `post-copy journal mutated the historical prefix (inspect ${stagedRelative})`,
      EXIT_POLICY,
    );
  }

  if (!(finalAppend.appended.when > globalMaxWhen)) {
    throw new GuardError(
      `post-copy final when ${finalAppend.appended.when} is not greater than prior global max ${globalMaxWhen}`,
      EXIT_POLICY,
    );
  }

  assertBytesEqual(
    path.join(stagedDirectory, newSqlRelative),
    realSqlPath,
    `new SQL migration ${newSqlRelative}`,
  );
  assertBytesEqual(
    path.join(stagedDirectory, newSnapshotRelative),
    realSnapshotPath,
    `new snapshot ${newSnapshotRelative}`,
  );
}

function runGenerate() {
  assertMigrationAreaClean();

  const { journal: originalJournal } = readJournalFrom(journalPath);
  const originalValidation = validateJournal(originalJournal, journalPath);
  if (!originalValidation.ok) {
    throw new GuardError(
      `current journal is invalid:\n- ${originalValidation.errors.join("\n- ")}`,
      EXIT_POLICY,
    );
  }
  const originalEntries = originalValidation.entries;
  const globalMaxWhen = originalValidation.globalMaxWhen;

  const lock = acquireGuardLock({ lockPath, mode: MODE_GENERATE });
  try {
    if (!fs.existsSync(drizzleConfigPath)) {
      throw new GuardError(
        `cannot find the drizzle config at ${drizzleConfigPath}; the guard needs it to stage output`,
        EXIT_USAGE,
      );
    }

    const stagedDirectory = fs.mkdtempSync(
      path.join(packageDirectory, ".migration-generation-staging-"),
    );
    copyDirectory(drizzleDirectory, stagedDirectory);
    const stagedRelative = toPosix(path.relative(packageDirectory, stagedDirectory));

    const configImportSpecifier = (() => {
      const relative = toPosix(path.relative(packageDirectory, drizzleConfigPath));
      return relative.startsWith(".") ? relative : `./${relative}`;
    })();
    fs.writeFileSync(
      stagedConfigPath,
      buildStagedConfigSource({ importSpecifier: configImportSpecifier, out: stagedRelative }),
      "utf8",
    );

    const invocation = buildDrizzleInvocation({
      execPath: process.execPath,
      binPath: resolveDrizzleBin(),
      configPath: toPosix(path.relative(packageDirectory, stagedConfigPath)),
    });

    process.stdout.write(`[migration-guard] generating into staged output ${stagedRelative}\n`);
    const child = spawnSync(invocation.command, invocation.args, {
      ...invocation.options,
      cwd: packageDirectory,
      stdio: "inherit",
    });

    if (child.error) {
      throw new GuardError(
        `failed to launch drizzle-kit (staged output retained at ${stagedRelative}): ${child.error.message}`,
        EXIT_USAGE,
      );
    }
    if (child.status !== 0) {
      const childExitCode =
        Number.isInteger(child.status) && child.status > 0 ? child.status : EXIT_POLICY;
      throw new GuardError(
        `drizzle-kit generate failed with exit code ${child.status}; staged output retained at ${stagedRelative}`,
        childExitCode,
      );
    }

    try {
      validateStagedAndCopyBack({
        stagedDirectory,
        stagedRelative,
        originalEntries,
        globalMaxWhen,
      });
    } catch (error) {
      process.stderr.write(
        `[migration-guard] staged output retained for diagnosis at ${stagedRelative}\n`,
      );
      throw error;
    }

    fs.rmSync(stagedDirectory, { recursive: true, force: true });
    process.stdout.write("[migration-guard] migration generated and validated successfully\n");
  } finally {
    fs.rmSync(stagedConfigPath, { force: true });
    lock.release();
  }

  return EXIT_OK;
}

function runCheck() {
  const { journal } = readJournalFrom(journalPath);
  const result = validateFrontier(journal, journalPath);
  if (!result.ok) {
    throw new GuardError(
      `journal frontier invariant failed:\n- ${result.errors.join("\n- ")}`,
      EXIT_POLICY,
    );
  }
  const entryCount = extractEntries(journal, journalPath).length;
  process.stdout.write(
    `[migration-guard] journal invariant OK (${entryCount} entries, global max when ${result.globalMaxWhen}, ` +
      `frontier when ${result.frontierWhen})\n`,
  );
  return EXIT_OK;
}

function main(argv) {
  const mode = resolveMode(argv);
  if (mode === MODE_CHECK) {
    return runCheck();
  }
  return runGenerate();
}

const invokedDirectly =
  typeof process.argv[1] === "string" && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof GuardError) {
      process.stderr.write(`[migration-guard] ${error.message}\n`);
      process.exit(error.exitCode);
    }
    process.stderr.write(`[migration-guard] unexpected error: ${error?.stack ?? String(error)}\n`);
    process.exit(EXIT_POLICY);
  }
}

export { main, runCheck, runGenerate, resolveDrizzleBin };

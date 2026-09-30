#!/usr/bin/env node
/**
 * Create a stopped, consistent SQLite + artifact archive without third-party tools.
 * This intentionally requires an explicit --stopped acknowledgement. It never
 * stops a service or deletes an existing archive.
 */
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const usage = `Usage: node deploy/backup.mjs --stopped DATA_DIR ARCHIVE.tar.gz

DATA_DIR must contain bridge.db and the service must already be stopped. The
archive path must be absolute, outside DATA_DIR, and must not already exist.
The data tree must contain only regular files/directories (symlinks, devices,
FIFOs, and sockets are rejected). This command does not stop services or copy
configuration/secrets.`;

function fail(message) {
  throw new Error(message);
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}
function validateTree(root) {
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (/[\u0000-\u001f\u007f\\]/.test(entry.name)) fail(`unsupported control/backslash character in data path: ${join(dir, entry.name)}`);
      const child = join(dir, entry.name);
      const childStat = lstatSync(child);
      if (childStat.isDirectory()) pending.push(child);
      else if (!childStat.isFile()) fail(`data tree contains unsupported entry (links/special files are not archived): ${child}`);
    }
  }
}


function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(usage);
    return;
  }
  if (!args.includes("--stopped")) fail("refusing live-data backup: pass --stopped only after stopping the bridge");
  const positional = args.filter(arg => arg !== "--stopped");
  if (positional.length !== 2) fail(usage);

  const [dataArg, archiveArg] = positional;
  if (!isAbsolute(dataArg) || !isAbsolute(archiveArg)) fail("DATA_DIR and ARCHIVE must both be absolute paths");

  let dataDir;
  try {
    dataDir = realpathSync(dataArg);
  } catch {
    fail(`data directory does not exist: ${dataArg}`);
  }
  if (!statSync(dataDir).isDirectory()) fail(`data path is not a directory: ${dataDir}`);

  const dbPath = join(dataDir, "bridge.db");
  let dbStat;
  try {
    dbStat = lstatSync(dbPath);
  } catch {
    fail(`missing SQLite database: ${dbPath}`);
  }
  if (!dbStat.isFile() || dbStat.isSymbolicLink()) fail(`bridge.db must be a regular file, not a symlink: ${dbPath}`);
  validateTree(dataDir);

  const archiveInput = resolve(archiveArg);
  let archiveParent;
  try {
    archiveParent = realpathSync(dirname(archiveInput));
  } catch {
    fail(`archive parent does not exist: ${dirname(archiveInput)}`);
  }
  const archive = join(archiveParent, archiveInput.slice(archiveInput.lastIndexOf("/") + 1));
  if (existsSync(archive) || (() => { try { return lstatSync(archive).isSymbolicLink(); } catch { return false; } })()) {
    fail(`refusing to overwrite existing archive: ${archive}`);
  }
  if (isInside(dataDir, archive)) fail("archive must be outside DATA_DIR");

  // The process must be stopped before this checkpoint. The explicit flag is an
  // acknowledgement rather than an attempt to infer service state.
  let db;
  try {
    db = new DatabaseSync(dbPath);
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (Number(checkpoint?.busy ?? 0) !== 0) fail(`SQLite checkpoint is busy (${JSON.stringify(checkpoint)}); stop every writer and retry`);
    const row = db.prepare("PRAGMA integrity_check").get();
    const result = row && Object.values(row)[0];
    if (result !== "ok") fail(`SQLite integrity_check failed: ${String(result)}`);
  } catch (error) {
    fail(`could not checkpoint/check SQLite: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    db?.close();
  }

  const tempDir = mkdtempSync(join(archiveParent, `.omp-video-backup-${process.pid}-`));
  const tempArchive = join(tempDir, "archive.tar.gz");
  try {
    const tar = spawnSync("tar", ["--hard-dereference", "-czf", tempArchive, "-C", dataDir, "."], { stdio: "inherit" });
    if (tar.error) fail(`could not run tar: ${tar.error.message}`);
    if (tar.status !== 0) fail(`tar failed with exit ${String(tar.status)}`);
    if (!statSync(tempArchive).isFile() || statSync(tempArchive).size === 0) fail("tar produced an empty archive");
    chmodSync(tempArchive, 0o600);
    renameSync(tempArchive, archive);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(`backup: ${archive}`);
  console.log("backup: SQLite checkpoint and integrity_check=ok; archive contains the complete DATA_DIR tree (hardlinks copied independently)");
  console.log("backup: separate config/token/webhook-secret files are not added; keep them outside DATA_DIR and back them up privately");
}

try {
  main();
} catch (error) {
  console.error(`backup: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

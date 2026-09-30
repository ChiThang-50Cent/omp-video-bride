#!/usr/bin/env node
/**
 * Restore a backup archive into a new data directory without overwriting an
 * existing path. This intentionally requires an explicit --stopped
 * acknowledgement and performs archive/path/SQLite checks before the final
 * atomic directory rename.
 */
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const usage = `Usage: node deploy/restore.mjs --stopped ARCHIVE.tar.gz NEW_DATA_DIR

The bridge must already be stopped. NEW_DATA_DIR must be an absolute path that
does not exist; the tool refuses to overwrite any existing directory. The
archive must contain a regular bridge.db at its root and no unsafe paths or
special files.`;

function fail(message) {
  throw new Error(message);
}

function runTar(args, options = {}) {
  const result = spawnSync("tar", args, options);
  if (result.error) fail(`could not run tar: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString() : String(result.stderr ?? "");
    fail(`tar failed with exit ${String(result.status)}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
  }
  return result;
}

async function readTarListing(args, checkLine) {
  const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
  const done = Promise.withResolvers();
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  child.once("error", done.reject);
  child.once("close", code => {
    if (code === 0) done.resolve();
    else done.reject(new Error(`tar failed with exit ${String(code)}: ${stderr.trim()}`));
  });
  // Observe process failures immediately while the listing is consumed.
  void done.promise.catch(() => {});
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line) checkLine(line);
    }
    await done.promise;
  } catch (error) {
    child.kill("SIGTERM");
    await done.promise.catch(() => {});
    throw error;
  } finally {
    lines.close();
  }
}

async function validateArchive(archive) {
  // GNU tar's --null option applies to file-name inputs, not listings. Ask
  // tar to escape newline/control characters so a member cannot hide a
  // traversal component in a line-oriented listing; reject escaped names.
  const seen = new Set();
  let hasDatabase = false;
  await readTarListing(["--quoting-style=escape", "-tzf", archive], raw => {
    if (raw.includes("\\") || raw.includes("\r")) fail(`archive contains an escaped/control filename: ${raw}`);
    const withoutDot = raw.startsWith("./") ? raw.slice(2) : raw;
    if (!withoutDot) return;
    if (withoutDot.startsWith("/") || /^[A-Za-z]:[\\/]/.test(withoutDot)) fail(`archive contains an absolute path: ${raw}`);
    const normalized = posix.normalize(withoutDot);
    if (normalized === ".." || normalized.startsWith("../")) fail(`archive contains a traversal path: ${raw}`);
    if (seen.has(normalized)) fail(`archive contains a duplicate path: ${normalized}`);
    seen.add(normalized);
    if (normalized === "bridge.db") hasDatabase = true;
  });
  if (!hasDatabase) fail("archive does not contain bridge.db at its root");

  // Do not extract links, devices, FIFOs, or hard links. The backup tool only
  // emits regular files/directories; rejecting all other types avoids an
  // archive-created path from redirecting extraction outside the destination.
  await readTarListing(["-tvzf", archive], line => {
    const type = line[0];
    if (type !== "-" && type !== "d") fail(`archive contains unsupported tar entry type: ${line}`);
  });
}

function verifyDatabase(path) {
  let db;
  try {
    db = new DatabaseSync(path);
    const row = db.prepare("PRAGMA integrity_check").get();
    const result = row && Object.values(row)[0];
    if (result !== "ok") fail(`restored SQLite integrity_check failed: ${String(result)}`);
    const versionRow = db.prepare("PRAGMA user_version").get();
    return Number(Object.values(versionRow ?? {})[0] ?? 0);
  } finally {
    db?.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(usage);
    return;
  }
  if (!args.includes("--stopped")) fail("refusing restore into live data: pass --stopped only after stopping the bridge");
  const positional = args.filter(arg => arg !== "--stopped");
  if (positional.length !== 2) fail(usage);

  const [archiveArg, destinationArg] = positional;
  if (!isAbsolute(archiveArg) || !isAbsolute(destinationArg)) fail("ARCHIVE and NEW_DATA_DIR must both be absolute paths");

  const archiveInput = resolve(archiveArg);
  let archiveParent;
  try {
    archiveParent = realpathSync(dirname(archiveInput));
  } catch {
    fail(`archive parent does not exist: ${dirname(archiveInput)}`);
  }
  const archive = join(archiveParent, archiveInput.slice(archiveInput.lastIndexOf("/") + 1));
  let archiveStat;
  try {
    archiveStat = lstatSync(archive);
  } catch {
    fail(`archive does not exist: ${archive}`);
  }
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) fail(`archive must be a regular file, not a symlink: ${archive}`);
  if ((archiveStat.mode & 0o077) !== 0) fail(`archive must not be group/world-readable: ${archive}`);

  const destinationInput = resolve(destinationArg);
  if (existsSync(destinationInput) || (() => { try { return lstatSync(destinationInput).isSymbolicLink(); } catch { return false; } })()) {
    fail(`refusing to overwrite existing restore destination: ${destinationInput}; move it aside first`);
  }
  let destinationParent;
  try {
    destinationParent = realpathSync(dirname(destinationInput));
  } catch {
    fail(`restore parent does not exist: ${dirname(destinationInput)}`);
  }
  const destination = join(destinationParent, destinationInput.slice(destinationInput.lastIndexOf("/") + 1));

  await validateArchive(archive);
  const stage = mkdtempSync(join(destinationParent, `.omp-video-restore-${process.pid}-`));
  try {
    runTar(["--no-same-owner", "-xzf", archive, "-C", stage], { stdio: "inherit" });
    const dbPath = join(stage, "bridge.db");
    const dbStat = lstatSync(dbPath);
    if (!dbStat.isFile() || dbStat.isSymbolicLink()) fail("extracted bridge.db is not a regular file");
    const version = verifyDatabase(dbPath);
    renameSync(stage, destination);
    console.log(`restore: ${destination}`);
    console.log(`restore: SQLite integrity_check=ok; user_version=${version}`);
    console.log("restore: archive extracted without overwriting an existing path; restore configuration/secrets separately");
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

try {
  await main();
} catch (error) {
  console.error(`restore: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

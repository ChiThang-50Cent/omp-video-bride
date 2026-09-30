import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore } from "../src/adapters/store-sqlite/sqlite-store.ts";
import { newJob } from "../src/core/job.ts";

const dir = mkdtempSync(join(tmpdir(), "bridge-ops-smoke-"));
const root = new URL("../", import.meta.url);
function run(file: string, args: string[], success = true, env?: NodeJS.ProcessEnv) {
  const result = spawnSync(file, args, { cwd: root, env, encoding: "utf8", timeout: 20_000 });
  if (result.error) throw result.error;
  if (success) assert.equal(result.status, 0, result.stderr || result.stdout);
  else assert.notEqual(result.status, 0, "unsafe operation unexpectedly succeeded");
  return result;
}
try {
  const data = join(dir, "data");
  mkdirSync(data);
  const store = new SqliteStore(join(data, "bridge.db"));
  const job = newJob({ id: "ops-roundtrip", kind: "build", pipeline: "hyperframes-explainer", input: { topic: "backup proof" }, now: "2026-01-01T00:00:00.000Z" });
  store.insertJob(job);
  store.enqueueOutbox("dead-event", JSON.stringify({ metadata: { private: "must-not-be-printed" } }), job.createdAt);
  store.outboxRetry(1, 5, job.createdAt, true);
  store.close();
  mkdirSync(join(data, "projects", "retained"), { recursive: true });
  const artifact = join(data, "projects", "retained", "artifact.bin");
  writeFileSync(artifact, Buffer.from([0, 255, 128, 1]), { mode: 0o640 });
  // Both tar listings exceed the old spawnSync 1 MiB cap.
  const large = join(data, "large");
  mkdirSync(large);
  let lastLargeFile = "";
  for (let index = 0; index < 6000; index++) {
    lastLargeFile = `file-${String(index).padStart(5, "0")}-${"x".repeat(180)}`;
    writeFileSync(join(large, lastLargeFile), index === 5999 ? "large archive boundary" : "");
  }
  linkSync(artifact, join(data, "projects", "retained", "linked.bin"));
  const unsafeLink = join(data, "external-link");
  symlinkSync("../outside", unsafeLink);
  run(process.execPath, ["deploy/backup.mjs", "--stopped", data, join(dir, "unsafe-backup.tar.gz")], false);
  assert.equal(existsSync(join(dir, "unsafe-backup.tar.gz")), false);
  rmSync(unsafeLink);
  const archive = join(dir, "backup.tar.gz");
  const restored = join(dir, "restored");
  run(process.execPath, ["deploy/backup.mjs", data, archive], false);
  assert.equal(existsSync(archive), false);
  run(process.execPath, ["deploy/backup.mjs", "--stopped", data, archive]);
  assert.equal(statSync(archive).mode & 0o777, 0o600);
  run(process.execPath, ["deploy/backup.mjs", "--stopped", data, archive], false);
  run(process.execPath, ["deploy/restore.mjs", "--stopped", archive, restored]);
  assert.deepEqual(readFileSync(join(restored, "projects", "retained", "artifact.bin")), readFileSync(artifact));
  assert.equal(readFileSync(join(restored, "large", lastLargeFile), "utf8"), "large archive boundary");
  const copy = new SqliteStore(join(restored, "bridge.db"));
  assert.deepEqual(copy.getJob(job.id), job);
  assert.deepEqual(copy.outboxCounts(), { pending: 0, dead: 1 });
  copy.close();
  run(process.execPath, ["deploy/restore.mjs", "--stopped", archive, restored], false);
  const malicious = join(dir, "malicious");
  mkdirSync(malicious);
  copyFileSync(join(data, "bridge.db"), join(malicious, "bridge.db"));
  symlinkSync("../outside", join(malicious, "escape"));
  const maliciousArchive = join(dir, "malicious.tar.gz");
  run("tar", ["-czf", maliciousArchive, "-C", malicious, "."]);
  chmodSync(maliciousArchive, 0o600);
  const rejectedDestination = join(dir, "must-not-exist");
  const rejectedArchive = run(process.execPath, ["deploy/restore.mjs", "--stopped", maliciousArchive, rejectedDestination], false);
  assert.match(rejectedArchive.stderr, /unsupported tar entry type/);
  assert.equal(existsSync(rejectedDestination), false);
  const dead = run(process.execPath, ["--disable-warning=ExperimentalWarning", "tools/outbox.ts", "list", "--db", join(restored, "bridge.db")]);
  const deadEntries: unknown = JSON.parse(dead.stdout);
  assert(Array.isArray(deadEntries));
  const firstDead: unknown = deadEntries[0];
  assert(firstDead && typeof firstDead === "object" && "eventId" in firstDead);
  assert.equal(firstDead.eventId, "dead-event");
  assert(!dead.stdout.includes("must-not-be-printed"));
  run(process.execPath, ["--disable-warning=ExperimentalWarning", "tools/outbox.ts", "redrive", "--db", join(restored, "bridge.db"), "--ids", "1,999", "--stopped"], false);
  const unchanged = new DatabaseSync(join(restored, "bridge.db"), { readOnly: true });
  const unchangedRow = unchanged.prepare("SELECT state FROM outbox WHERE id=1").get();
  assert.equal(unchangedRow?.state, "dead");
  unchanged.close();
  run(process.execPath, ["--disable-warning=ExperimentalWarning", "tools/outbox.ts", "redrive", "--db", join(restored, "bridge.db"), "--ids", "1", "--stopped"]);
  const redriven = new DatabaseSync(join(restored, "bridge.db"), { readOnly: true });
  const redrivenRow = redriven.prepare("SELECT state,attempts,event_id FROM outbox WHERE id=1").get();
  assert(redrivenRow);
  assert.equal(redrivenRow.state, "pending");
  assert.equal(redrivenRow.attempts, 0);
  assert.equal(redrivenRow.event_id, "dead-event");
  redriven.close();

  const token = join(dir, "token");
  writeFileSync(token, "ops-smoke-private-token", { mode: 0o600 });
  const config = join(dir, "config%literal.json");
  writeFileSync(config, JSON.stringify({ dataDir: data, tokenFile: token, omp: { bin: process.execPath, skillDirs: [] }, env: { HYPERFRAMES_BROWSER_PATH: process.execPath, HYPERFRAMES_PYTHON: process.execPath } }), { mode: 0o600 });
  const preflight = ["deploy/install.sh", "--check-only", "--user", userInfo().username, "--node", process.execPath, "--config", config];
  run("sh", preflight);
  const rendered = run("sh", ["deploy/install.sh", "--print-unit", "--user", userInfo().username, "--node", process.execPath, "--config", config]);
  const unitFile = join(dir, "omp-video-smoke.service");
  writeFileSync(unitFile, rendered.stdout);
  const parser = spawnSync("systemd-analyze", ["verify", unitFile], { encoding: "utf8", timeout: 10_000 });
  if (parser.error && "code" in parser.error && parser.error.code === "ENOENT") {
    console.log("SKIP systemd unit parser: systemd-analyze unavailable");
  } else {
    if (parser.error) throw parser.error;
    assert.equal(parser.status, 0, parser.stderr);
  }
  const serviceEnv: NodeJS.ProcessEnv = {};
  for (const line of rendered.stdout.split("\n")) {
    const match = /^Environment=(".+")$/.exec(line);
    if (!match) continue;
    const decoded: unknown = JSON.parse(match[1]!);
    assert(typeof decoded === "string");
    const assignment = decoded.replaceAll("%%", "%");
    const separator = assignment.indexOf("=");
    serviceEnv[assignment.slice(0, separator)] = assignment.slice(separator + 1);
  }
  const selected = run(process.execPath, ["--input-type=module", "-e", 'import {loadConfig} from "./src/config.ts"; const c=loadConfig(); console.log(JSON.stringify({dataDir:c.dataDir,tokenFile:c.tokenFile}));'], true, serviceEnv);
  assert.deepEqual(JSON.parse(selected.stdout), { dataDir: data, tokenFile: token });
  writeFileSync(config, JSON.stringify({ dataDir: "data", tokenFile: token, omp: { bin: process.execPath, skillDirs: [] }, env: { HYPERFRAMES_BROWSER_PATH: process.execPath, HYPERFRAMES_PYTHON: process.execPath } }), { mode: 0o600 });
  const relative = run("sh", preflight, false);
  assert.match(relative.stderr, /absolute path/);
  writeFileSync(config, JSON.stringify({ dataDir: data, tokenFile: token, omp: { bin: process.execPath, skillDirs: [] }, env: { HYPERFRAMES_BROWSER_PATH: process.execPath, HYPERFRAMES_PYTHON: process.execPath } }), { mode: 0o600 });
  chmodSync(token, 0o644);
  run("sh", preflight, false);
  console.log("PASS operations smoke: large stopped backup/restore, link rejection and overwrite protection, atomic private redrive, parsed systemd unit selects the validated config, relative paths and exposed tokens rejected");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

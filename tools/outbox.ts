import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";

const { values, positionals } = parseArgs({ options: { db: { type: "string" }, limit: { type: "string", default: "50" }, ids: { type: "string" }, stopped: { type: "boolean", default: false } }, allowPositionals: true });
const command = positionals[0];
if (!values.db || positionals.length !== 1 || (command !== "list" && command !== "redrive")) {
  throw new Error("Usage: node tools/outbox.ts list --db /absolute/bridge.db [--limit 50] | redrive --db /absolute/bridge.db --ids 1,2 --stopped");
}
if (!isAbsolute(values.db)) throw new Error("db must be an absolute path");
const databaseFile = lstatSync(values.db);
if (!databaseFile.isFile() || databaseFile.isSymbolicLink()) throw new Error("db must be an existing regular file, not a symlink");
const limit = Number(values.limit);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be an integer between 1 and 500");
let ids: number[] = [];
if (command === "redrive") {
  if (!values.stopped) throw new Error("Stop the bridge dispatcher first, then acknowledge with --stopped");
  if (!values.ids || !/^[1-9]\d*(,[1-9]\d*)*$/.test(values.ids)) throw new Error("ids must be a comma-separated list of positive integers");
  ids = values.ids.split(",").map(Number);
  if (ids.length > 100 || ids.some(id => !Number.isSafeInteger(id)) || new Set(ids).size !== ids.length) throw new Error("Provide at most 100 distinct safe integer IDs");
} else if (values.ids || values.stopped) {
  throw new Error("ids/stopped are only valid for redrive");
}
// Never create/migrate a database or print webhook payloads (which may contain private metadata).
const db = new DatabaseSync(values.db, { readOnly: command === "list", open: false });
try {
  // A writable SQLite open would create a missing file; require an existing database first.
  const probe = new DatabaseSync(values.db, { readOnly: true });
  probe.close();
  db.open();
  db.exec("PRAGMA busy_timeout = 5000");
  if (command === "list") {
    console.log(JSON.stringify(db.prepare("SELECT id,event_id AS eventId,attempts,next_at AS nextAt FROM outbox WHERE state='dead' ORDER BY id LIMIT ?").all(limit), null, 2));
  } else {
    db.exec("BEGIN IMMEDIATE");
    try {
      const get = db.prepare("SELECT state FROM outbox WHERE id=?");
      for (const id of ids) {
        const row = get.get(id);
        if (row?.state !== "dead") throw new Error(`Outbox ${id} does not exist or is not dead; no rows changed`);
      }
      const update = db.prepare("UPDATE outbox SET state='pending',attempts=0,next_at=? WHERE id=? AND state='dead'");
      const now = new Date().toISOString();
      for (const id of ids) update.run(now, id);
      db.exec("COMMIT");
      console.log(JSON.stringify({ redriven: ids, nextAt: now }));
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
} finally {
  if (db.isOpen) db.close();
}

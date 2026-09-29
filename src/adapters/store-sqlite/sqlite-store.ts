import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { transition, type Job, type JobEvent, type JobState } from "../../core/job.ts";
import type { Asset, Project, Scene, Version } from "../../core/entities.ts";
import type { OutboxRow, Store, StoredEvent } from "../../ports/store.ts";
import { MIGRATIONS } from "./migrations.ts";

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw new Error(`migration ${v + 1} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn(); // nested: join the outer transaction
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }

  insertJob(job: Job): void {
    this.db
      .prepare("INSERT INTO jobs (id, state, kind, pipeline, created_at, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run(job.id, job.state, job.kind, job.pipeline, job.createdAt, JSON.stringify(job));
    this.log(job.id, "created", job.createdAt, { kind: job.kind, pipeline: job.pipeline });
  }

  getJob(id: string): Job | undefined {
    const row = this.db.prepare("SELECT data FROM jobs WHERE id = ?").get(id) as { data: string } | undefined;
    return row && (JSON.parse(row.data) as Job);
  }

  listJobs(filter: { state?: JobState; kind?: string; projectId?: string; limit?: number } = {}): Job[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.state) { where.push("state = ?"); args.push(filter.state); }
    if (filter.kind) { where.push("kind = ?"); args.push(filter.kind); }
    if (filter.projectId) { where.push("json_extract(data, '$.refs.projectId') = ?"); args.push(filter.projectId); }
    const sql = `SELECT data FROM jobs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at, id LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, filter.limit ?? 500) as { data: string }[];
    return rows.map(r => JSON.parse(r.data) as Job);
  }

  applyEvent(jobId: string, event: JobEvent, now: string): Job {
    return this.tx(() => {
      const current = this.getJob(jobId);
      if (!current) throw new Error(`job ${jobId} not found`);
      const next = transition(current, event, now);
      this.db.prepare("UPDATE jobs SET state = ?, data = ? WHERE id = ?").run(next.state, JSON.stringify(next), jobId);
      // usage ticks are frequent and already stored on the job itself
      if (event.type !== "usage") this.log(jobId, event.type, now, { from: current.state, to: next.state, ...("error" in event ? { error: event.error } : {}) });
      return next;
    });
  }

  private log(jobId: string, type: string, at: string, data: unknown): void {
    this.db.prepare("INSERT INTO events (job_id, type, at, data) VALUES (?, ?, ?, ?)").run(jobId, type, at, JSON.stringify(data));
  }

  listEvents(jobId: string, sinceId = 0): StoredEvent[] {
    const rows = this.db.prepare("SELECT id, job_id, type, at, data FROM events WHERE job_id = ? AND id > ? ORDER BY id").all(jobId, sinceId) as {
      id: number; job_id: string; type: string; at: string; data: string;
    }[];
    return rows.map(r => ({ id: r.id, jobId: r.job_id, type: r.type, at: r.at, data: JSON.parse(r.data) }));
  }

  // ---- document tables: one JSON blob per entity, indexed by its parent ----
  private put(table: string, cols: Record<string, string | number>, data: unknown): void {
    const names = [...Object.keys(cols), "data"];
    const sql = `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")}) ` +
      `ON CONFLICT(id) DO UPDATE SET ${names.filter(n => n !== "id").map(n => `${n} = excluded.${n}`).join(", ")}`;
    this.db.prepare(sql).run(...Object.values(cols), JSON.stringify(data));
  }
  private one<T>(table: string, id: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string } | undefined;
    return row && (JSON.parse(row.data) as T);
  }
  private many<T>(sql: string, ...args: (string | number)[]): T[] {
    return (this.db.prepare(sql).all(...args) as { data: string }[]).map(r => JSON.parse(r.data) as T);
  }

  putProject(p: Project): void { this.put("projects", { id: p.id, created_at: p.createdAt }, p); }
  getProject(id: string): Project | undefined { return this.one("projects", id); }
  listProjects(): Project[] { return this.many("SELECT data FROM projects ORDER BY created_at, id"); }
  deleteProject(id: string): void {
    this.tx(() => {
      for (const s of this.listScenes(id)) this.deleteScene(s.id);
      this.db.prepare("DELETE FROM assets WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    });
  }

  putScene(s: Scene): void { this.put("scenes", { id: s.id, project_id: s.projectId, n: s.n }, s); }
  getScene(id: string): Scene | undefined { return this.one("scenes", id); }
  listScenes(projectId: string): Scene[] { return this.many("SELECT data FROM scenes WHERE project_id = ? ORDER BY n", projectId); }
  deleteScene(id: string): void {
    this.db.prepare("DELETE FROM versions WHERE scene_id = ?").run(id);
    this.db.prepare("DELETE FROM scenes WHERE id = ?").run(id);
  }

  putVersion(v: Version): void { this.put("versions", { id: v.id, scene_id: v.sceneId, number: v.number }, v); }
  getVersion(id: string): Version | undefined { return this.one("versions", id); }
  listVersions(sceneId: string): Version[] { return this.many("SELECT data FROM versions WHERE scene_id = ? ORDER BY number", sceneId); }

  putAsset(a: Asset): void { this.put("assets", { id: a.id, project_id: a.projectId }, a); }
  getAsset(id: string): Asset | undefined { return this.one("assets", id); }
  listAssets(projectId: string): Asset[] { return this.many("SELECT data FROM assets WHERE project_id = ? ORDER BY id", projectId); }
  deleteAsset(id: string): void { this.db.prepare("DELETE FROM assets WHERE id = ?").run(id); }

  enqueueOutbox(eventId: string, payload: string, now: string): void {
    this.db.prepare("INSERT OR IGNORE INTO outbox (event_id, payload, next_at) VALUES (?, ?, ?)").run(eventId, payload, now);
  }
  dueOutbox(now: string, limit: number): OutboxRow[] {
    const rows = this.db.prepare("SELECT id, event_id, payload, attempts, next_at FROM outbox WHERE state = 'pending' AND next_at <= ? ORDER BY id LIMIT ?").all(now, limit) as
      { id: number; event_id: string; payload: string; attempts: number; next_at: string }[];
    return rows.map(r => ({ id: r.id, eventId: r.event_id, payload: r.payload, attempts: r.attempts, nextAt: r.next_at }));
  }
  outboxDelivered(id: number): void { this.db.prepare("UPDATE outbox SET state = 'delivered' WHERE id = ?").run(id); }
  outboxRetry(id: number, attempts: number, nextAt: string, dead: boolean): void {
    this.db.prepare("UPDATE outbox SET attempts = ?, next_at = ?, state = ? WHERE id = ?").run(attempts, nextAt, dead ? "dead" : "pending", id);
  }
  outboxCounts(): { pending: number; dead: number } {
    const r = this.db.prepare("SELECT SUM(state = 'pending') AS pending, SUM(state = 'dead') AS dead FROM outbox").get() as { pending: number | null; dead: number | null };
    return { pending: r.pending ?? 0, dead: r.dead ?? 0 };
  }

  close(): void {
    this.db.close();
  }
}

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { transition, type Job, type JobEvent, type JobState } from "../../core/job.ts";
import type { Store, StoredEvent } from "../../ports/store.ts";
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

  listJobs(filter: { state?: JobState; kind?: string; limit?: number } = {}): Job[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.state) { where.push("state = ?"); args.push(filter.state); }
    if (filter.kind) { where.push("kind = ?"); args.push(filter.kind); }
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

  close(): void {
    this.db.close();
  }
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IllegalTransition, newJob } from "../../src/core/job.ts";
import { SqliteStore } from "../../src/adapters/store-sqlite/sqlite-store.ts";

const now = "2026-01-01T00:00:00.000Z";
const job = (id: string, extra: Partial<Parameters<typeof newJob>[0]> = {}) => newJob({ id, kind: "build", pipeline: "p", input: { topic: id }, now, ...extra });
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("SqliteStore", () => {
  it("applyEvent persists the transition and logs it", () => {
    const s = new SqliteStore(":memory:");
    s.insertJob(job("a"));
    s.applyEvent("a", { type: "start" }, now);
    s.applyEvent("a", { type: "fail", error: { code: "boom", message: "x" } }, now);
    expect(s.getJob("a")).toMatchObject({ state: "failed", attempts: 1, error: { code: "boom" } });
    expect(s.listEvents("a").map(e => e.type)).toEqual(["created", "start", "fail"]);
  });

  it("an illegal event changes nothing and writes no event", () => {
    const s = new SqliteStore(":memory:");
    s.insertJob(job("a"));
    expect(() => s.applyEvent("a", { type: "succeed", result: 1 }, now)).toThrow(IllegalTransition);
    expect(s.getJob("a")?.state).toBe("queued");
    expect(s.listEvents("a")).toHaveLength(1);
  });

  it("tx rolls back everything on a throw, and nested tx joins the outer one", () => {
    const s = new SqliteStore(":memory:");
    expect(() => s.tx(() => { s.insertJob(job("a")); s.tx(() => s.insertJob(job("b"))); throw new Error("no"); })).toThrow("no");
    expect(s.listJobs()).toEqual([]);
    s.tx(() => { s.insertJob(job("a")); s.tx(() => s.insertJob(job("b"))); });
    expect(s.listJobs().map(j => j.id)).toEqual(["a", "b"]);
  });

  it("filters by state and lists oldest first", () => {
    const s = new SqliteStore(":memory:");
    s.insertJob(job("late", { now: "2026-01-02T00:00:00.000Z" }));
    s.insertJob(job("early"));
    s.applyEvent("early", { type: "start" }, now);
    expect(s.listJobs().map(j => j.id)).toEqual(["early", "late"]);
    expect(s.listJobs({ state: "queued" }).map(j => j.id)).toEqual(["late"]);
  });

  it("survives a reopen and does not re-run migrations", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-"));
    dirs.push(dir);
    const path = join(dir, "sub", "bridge.db");
    const a = new SqliteStore(path);
    a.insertJob(job("a"));
    a.close();
    const b = new SqliteStore(path);
    expect(b.getJob("a")?.input).toEqual({ topic: "a" });
    b.close();
  });

  it("lists events after a cursor", () => {
    const s = new SqliteStore(":memory:");
    s.insertJob(job("a"));
    s.applyEvent("a", { type: "start" }, now);
    const [first] = s.listEvents("a");
    expect(s.listEvents("a", first!.id).map(e => e.type)).toEqual(["start"]);
  });
});

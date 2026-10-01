import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OmpRunner } from "../../src/adapters/runner-omp/omp-runner.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omp-resume-session-"));
  roots.push(root);
  const workdir = join(root, "dữ-liệu");
  const sessions = join(workdir, "sessions");
  mkdirSync(sessions, { recursive: true });
  const runner = new OmpRunner({ bin: process.execPath, firstEventTimeoutSeconds: 120 });
  const header = { type: "session", version: 3, id: "main", timestamp: "2026-01-01T00:00:00.000Z", cwd: workdir };
  const message = { type: "message", id: "user", parentId: null, timestamp: header.timestamp, message: { role: "user", content: [{ type: "text", text: "Continue the existing video" }] } };
  return { root, workdir, sessions, runner, header, message };
}

describe("persisted main-session selection", () => {
  it("selects the newest nonempty main session without following workers or links", () => {
    const f = fixture();
    const old = join(f.sessions, "old.jsonl"), recent = join(f.sessions, "recent.jsonl");
    const data = [f.header, f.message].map(entry => JSON.stringify(entry)).join("\n") + "\n";
    writeFileSync(old, data);
    writeFileSync(recent, data);
    utimesSync(old, 100, 100);
    utimesSync(recent, 200, 200);
    writeFileSync(join(f.sessions, "worker.jsonl"), [ { ...f.header, parentSession: recent }, f.message ].map(entry => JSON.stringify(entry)).join("\n"));
    mkdirSync(join(f.sessions, "workers"));
    writeFileSync(join(f.sessions, "workers", "nested.jsonl"), data);
    const outside = join(f.root, "outside.jsonl");
    writeFileSync(outside, data);
    symlinkSync(outside, join(f.sessions, "linked.jsonl"));
    expect(f.runner.sessionToResume(f.workdir)).toBe(recent);
  });

  it.each(["empty", "header-only", "wrong-cwd", "malformed", "subagent-init"])("refuses %s history rather than authorizing a fresh session", kind => {
    const f = fixture();
    const data: Record<string, string> = {
      empty: "",
      "header-only": JSON.stringify(f.header) + "\n",
      "wrong-cwd": [ { ...f.header, cwd: f.root }, f.message ].map(entry => JSON.stringify(entry)).join("\n"),
      malformed: '{"type":"session",',
      "subagent-init": [ f.header, { type: "session_init", agent: "task" }, f.message ].map(entry => JSON.stringify(entry)).join("\n"),
    };
    writeFileSync(join(f.sessions, "main.jsonl"), data[kind]!);
    expect(f.runner.sessionToResume(f.workdir)).toBeNull();
  });

  it("handles a title slot and a message spanning read chunks without reading a partial tail", () => {
    const f = fixture();
    const path = join(f.sessions, "main.jsonl");
    const message = { ...f.message, message: { role: "user", content: [{ type: "text", text: "video 🌏 ".repeat(5000) }] } };
    writeFileSync(path, [ { type: "title", title: "Video" }, f.header, message ].map(entry => JSON.stringify(entry)).join("\n") + '\n{"type":"message",');
    expect(f.runner.sessionToResume(f.workdir)).toBe(path);
  });

  it("never substitutes another session when a pinned file is missing or corrupt", () => {
    const f = fixture();
    const other = join(f.sessions, "other.jsonl");
    writeFileSync(other, [ f.header, f.message ].map(entry => JSON.stringify(entry)).join("\n"));
    const pinned = join(f.sessions, "pinned.jsonl");
    expect(f.runner.sessionToResume(f.workdir, pinned)).toBeNull();
    writeFileSync(pinned, '{"type":"session",');
    expect(f.runner.sessionToResume(f.workdir, pinned)).toBeNull();
    expect(f.runner.sessionToResume(f.workdir, other)).toBe(other);
    expect(f.runner.sessionToResume(f.workdir, join(f.root, "outside.jsonl"))).toBeNull();
  });

  it("rejects lost pinned history at dispatch before starting a new model process", () => {
    const f = fixture();
    const pinned = join(f.sessions, "lost.jsonl");
    expect(() => f.runner.start({
      workdir: f.workdir, prompt: "Continue", resume: true, sessionFile: pinned,
      model: "m", thinking: "high", workerModel: "m", workerThinking: "medium",
      skillDirs: [], env: {},
    })).toThrow("the pinned main session is missing or no longer valid");
  });

  it("refuses a linked session directory", () => {
    const f = fixture();
    const outside = join(f.root, "other-sessions");
    mkdirSync(outside);
    writeFileSync(join(outside, "main.jsonl"), [ f.header, f.message ].map(entry => JSON.stringify(entry)).join("\n"));
    rmSync(f.sessions, { recursive: true });
    symlinkSync(outside, f.sessions);
    expect(f.runner.sessionToResume(f.workdir)).toBeNull();
  });
});

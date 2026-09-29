import { describe, expect, it } from "vitest";
import { IllegalTransition, JOB_STATES, MAX_RESUMES, TERMINAL_STATES, limitExceeded, newJob, transition, type Job, type JobEvent } from "../../src/core/job.ts";

const t0 = "2026-01-01T00:00:00.000Z";
const t1 = "2026-01-01T00:10:00.000Z";
const mk = () => newJob({ id: "j1", kind: "build", pipeline: "p", input: {}, now: t0 });
const run = (job: Job, ...events: JobEvent[]) => events.reduce((j, e) => transition(j, e, t1), job);
const err = { code: "x", message: "boom" };

describe("job state machine", () => {
  it("runs the happy path and stamps times", () => {
    const j = run(mk(), { type: "start" }, { type: "succeed", result: { video: "v.mp4" } });
    expect(j.state).toBe("succeeded");
    expect(j.attempts).toBe(1);
    expect(j.startedAt).toBe(t1);
    expect(j.finishedAt).toBe(t1);
    expect(j.result).toEqual({ video: "v.mp4" });
  });

  it("does not mutate its input", () => {
    const j = mk();
    transition(j, { type: "start" }, t1);
    expect(j.state).toBe("queued");
  });

  it("rejects every event that is not allowed, including anything after a terminal state", () => {
    const j = run(mk(), { type: "start" }, { type: "cancel" });
    for (const type of ["start", "succeed", "cancel", "resume", "approve"] as const) {
      const ev = (type === "succeed" ? { type, result: 1 } : { type }) as JobEvent;
      expect(() => transition(j, ev, t1)).toThrow(IllegalTransition);
    }
    expect(() => transition(mk(), { type: "succeed", result: 1 }, t1)).toThrow(/not allowed in state "queued"/);
  });

  it("cancel works from every non-terminal state", () => {
    const from: Record<string, Job> = {
      queued: mk(),
      running: run(mk(), { type: "start" }),
      awaiting_approval: run(mk(), { type: "start" }, { type: "need_approval" }),
      interrupted: run(mk(), { type: "start" }, { type: "interrupt" }),
    };
    for (const [state, job] of Object.entries(from)) {
      expect(job.state).toBe(state);
      const c = transition(job, { type: "cancel" }, t1);
      expect(c.state).toBe("cancelled");
      expect(c.error?.code).toBe("cancelled");
    }
  });

  it("approval gate: the same job continues in phase after-approval with resume=true", () => {
    const waiting = run(mk(), { type: "start" }, { type: "need_approval" });
    expect(waiting.state).toBe("awaiting_approval");
    const again = transition(waiting, { type: "approve" }, t1);
    expect(again).toMatchObject({ state: "queued", resume: true, phase: "after-approval" });
    const done = run(again, { type: "start" }, { type: "succeed", result: 1 });
    expect(done.attempts).toBe(2);
    expect(done.resumes).toBe(0); // approval is not a crash resume
  });

  it("interruption resumes up to MAX_RESUMES times, then fails with resume_exhausted", () => {
    let j = run(mk(), { type: "start" });
    for (let i = 1; i <= MAX_RESUMES; i++) {
      j = run(j, { type: "interrupt" }, { type: "resume" });
      expect(j).toMatchObject({ state: "queued", resume: true, resumes: i });
      j = run(j, { type: "start" });
    }
    j = run(j, { type: "interrupt" }, { type: "resume" });
    expect(j.state).toBe("failed");
    expect(j.error?.code).toBe("resume_exhausted");
    expect(j.finishedAt).toBe(t1);
  });

  it("records usage only while running", () => {
    const usage = { usd: 1.5, inputTokens: 10, outputTokens: 20 };
    expect(run(mk(), { type: "start" }, { type: "usage", usage }).usage).toEqual(usage);
    expect(() => transition(mk(), { type: "usage", usage }, t1)).toThrow(IllegalTransition);
  });

  it("marks exactly the four end states terminal", () => {
    expect(JOB_STATES.filter(s => TERMINAL_STATES[s]).sort()).toEqual(["cancelled", "failed", "rejected", "succeeded"]);
  });

  it("fail and reject carry their error", () => {
    expect(run(mk(), { type: "start" }, { type: "fail", error: err }).error).toEqual(err);
    expect(run(mk(), { type: "start" }, { type: "reject", error: err })).toMatchObject({ state: "rejected", error: err });
  });
});

describe("limitExceeded", () => {
  const running = run(newJob({ id: "j", kind: "build", pipeline: "p", input: {}, limits: { maxMinutes: 10, maxUsd: 2 }, now: t0 }), { type: "start" });
  const at = (min: number) => new Date(Date.parse(t1) + min * 60_000).toISOString();

  it("is null within both limits", () => {
    expect(limitExceeded({ ...running, usage: { usd: 2, inputTokens: 0, outputTokens: 0 } }, at(10))).toBeNull();
  });
  it("trips on cost, strictly above the limit", () => {
    expect(limitExceeded({ ...running, usage: { usd: 2.01, inputTokens: 0, outputTokens: 0 } }, at(1))?.code).toBe("limit_exceeded");
  });
  it("trips on runtime measured from startedAt", () => {
    expect(limitExceeded(running, at(10.5))?.message).toMatch(/10 min/);
  });
});

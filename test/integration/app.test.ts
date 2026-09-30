import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { App } from "../../src/app/app.ts";
import { newJob, transition } from "../../src/core/job.ts";
import { harness, okScenario } from "./harness.ts";

describe("build", () => {
  it("runs a build to success and records the version, cost and files", async () => {
    const h = harness();
    h.scenario(okScenario());
    const { job, version, scene } = h.app.createVideo({ topic: "How DNS works" });
    await h.app.idle();
    const done = h.app.job(job.id);
    expect(done.state).toBe("succeeded");
    expect(done.usage.usd).toBeCloseTo(0.1);
    const v = h.app.version(version.id);
    expect(v.state).toBe("ready");
    expect(v.durationSec).toBe(31.5);
    expect(existsSync(v.outputs.video!)).toBe(true);
    expect(v.outputs.contactSheets).toHaveLength(1);
    expect(h.app.scene(scene.id).currentVersionId).toBe(version.id);
    const argv = JSON.parse(readFileSync(h.logFile, "utf8").trim().split("\n")[0]!).argv as string[];
    expect(argv.at(-1)).toContain("How DNS works");
    expect(argv).not.toContain("--continue");
  });

  it("publishes media readable by a different container UID without exposing private files", async () => {
    const h = harness();
    const scenario = okScenario();
    h.scenario({ ...scenario, writeMode: 0o600, writeFiles: { ...scenario.writeFiles, "private.txt": "private" } });
    const { job, version } = h.app.createVideo({ topic: "Shared read-only video mount" });
    await h.app.idle();
    expect(h.app.job(job.id).state).toBe("succeeded");
    const v = h.app.version(version.id);
    for (const path of [v.outputs.video!, ...v.outputs.contactSheets, v.outputs.captionsGroups!]) {
      expect(statSync(path).mode & 0o777).toBe(0o644);
    }
    expect(statSync(`${v.workdir}/private.txt`).mode & 0o777).toBe(0o600);
  });

  it("fails the job when the reported video is not on disk", async () => {
    const h = harness();
    h.scenario({ steps: [], final: '```json\n{"video":"{{cwd}}/nope.mp4","project_dir":"{{cwd}}/videos/demo"}\n```' });
    const { job, version } = h.app.createVideo({ topic: "Nothing produced" });
    await h.app.idle();
    expect(h.app.job(job.id).error?.code).toBe("bad_result");
    expect(h.app.version(version.id).state).toBe("failed");
  });

  it("kills the run when the cost limit is exceeded", async () => {
    const h = harness();
    h.scenario({ steps: [{ text: "a", usd: 0.6 }, { sleepMs: 30_000 }], final: "x" });
    const { job } = h.app.createVideo({ topic: "Too expensive" }, { limits: { maxUsd: 0.5 } });
    await h.app.idle();
    expect(h.app.job(job.id).error?.code).toBe("limit_exceeded");
  });

  it("rejects a second job on a busy scene", async () => {
    const h = harness();
    h.scenario({ steps: [{ sleepMs: 5_000 }], final: "x" });
    const { scene, job } = h.app.createVideo({ topic: "Busy scene" });
    expect(() => h.app.buildScene(scene.id)).toThrow(/active job/);
    h.app.cancel(job.id);
    await h.app.idle();
    expect(h.app.job(job.id).state).toBe("cancelled");
  });
});

describe("approval gate", () => {
  it("stops after the storyboard, then continues the same session with notes", async () => {
    const h = harness();
    h.scenario({
      writeFiles: { "videos/demo/STORYBOARD.md": "sb" },
      final: '```json\n{"status":"awaiting_approval","storyboard":"{{cwd}}/videos/demo/STORYBOARD.md","project_dir":"{{cwd}}/videos/demo"}\n```',
      continued: okScenario(),
    });
    const { job } = h.app.createVideo({ topic: "Gate me" }, { approve: "storyboard" });
    await h.app.idle();
    expect(h.app.job(job.id).state).toBe("awaiting_approval");
    h.app.approve(job.id, "make scene 2 shorter");
    await h.app.idle();
    expect(h.app.job(job.id).state).toBe("succeeded");
    const calls = readFileSync(h.logFile, "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(calls[1].continued).toBe(true);
    expect(calls[1].argv.at(-1)).toContain("make scene 2 shorter");
  });
});

describe("crash recovery", () => {
  it("resumes a job left running by a stopped process with --continue", async () => {
    const h = harness();
    h.scenario({ steps: [{ sleepMs: 10_000 }], final: "x" });
    const { job } = h.app.createVideo({ topic: "Survive restart" });
    await new Promise(r => setTimeout(r, 300));
    await h.app.stop(); // process going down: job stays `running` in the database
    expect(h.store.getJob(job.id)!.state).toBe("running");

    h.scenario(okScenario());
    const app2 = new App({ ...h.app.d });
    app2.recover();
    await app2.idle();
    expect(app2.job(job.id).state).toBe("succeeded");
    expect(app2.job(job.id).resumes).toBe(1);
    const calls = readFileSync(h.logFile, "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(calls.at(-1).continued).toBe(true);
    expect(calls.at(-1).argv.at(-1)).toContain("interrupted");
  });
});

describe("deletion lifecycle", () => {
  it("treats more-than-500 queued jobs as active project work", () => {
    const h = harness();
    const p = h.app.createProject({ name: "Many jobs" });
    for (let i = 0; i < 501; i++) {
      h.store.insertJob(newJob({
        id: `job_many_${i}`,
        kind: "build",
        pipeline: p.pipeline,
        input: { topic: "busy" },
        refs: { projectId: p.id },
        now: "2026-01-01T00:00:00.000Z",
      }));
    }
    expect(() => h.app.deleteProject(p.id)).toThrow(/active job/);
  });

  it("treats an interrupted project job as active", () => {
    const h = harness();
    const p = h.app.createProject({ name: "Interrupted project" });
    const job = newJob({
      id: "job_project_interrupted",
      kind: "stitch",
      pipeline: p.pipeline,
      input: {},
      refs: { projectId: p.id },
      now: "2026-01-01T00:00:00.000Z",
    });
    h.store.insertJob(transition(transition(job, { type: "start" }, "2026-01-01T00:00:00.000Z"), { type: "interrupt" }, "2026-01-01T00:00:00.000Z"));
    expect(() => h.app.deleteProject(p.id)).toThrow(/active job/);
  });

  it.each(["queued", "running", "interrupted"] as const)("preserves scene inputs while a project stitch is %s", state => {
    const h = harness();
    const project = h.app.createProject({ name: "Stitch input protection" });
    const scene = h.app.addScene(project.id, { topic: "Input for a project stitch" });
    const now = "2026-01-01T00:00:00.000Z";
    const workdir = join(h.app.projectDir(project.id), "scenes", scene.id, "v1");
    mkdirSync(workdir, { recursive: true });
    const video = join(workdir, "video.mp4");
    writeFileSync(video, "retained input");
    const build = newJob({ id: "completed_build", kind: "build", pipeline: project.pipeline, input: {}, refs: { projectId: project.id, sceneId: scene.id }, now });
    h.store.insertJob(transition(transition(build, { type: "start" }, now), { type: "succeed", result: {} }, now));
    h.store.putVersion({ id: "input_version", sceneId: scene.id, number: 1, parentVersionId: null, jobId: build.id, workdir, projectDir: workdir, state: "ready", outputs: { video, contactSheets: [], captionsGroups: null }, durationSec: 1, notes: null, createdAt: now });
    h.store.putScene({ ...scene, currentVersionId: "input_version" });
    let stitch = newJob({ id: "active_stitch", kind: "stitch", pipeline: project.pipeline, input: {}, refs: { projectId: project.id }, now });
    if (state !== "queued") stitch = transition(stitch, { type: "start" }, now);
    if (state === "interrupted") stitch = transition(stitch, { type: "interrupt" }, now);
    h.store.insertJob(stitch);

    expect(() => h.app.deleteScene(scene.id)).toThrowError(expect.objectContaining({ code: "scene_busy", status: 409 }));
    expect(h.app.scene(scene.id).currentVersionId).toBe("input_version");
    expect(readFileSync(video, "utf8")).toBe("retained input");
  });

  it("blocks interrupted scene work, then deletes owned versions without touching imported paths or event history", () => {
    const h = harness();
    const p = h.app.createProject({ name: "Delete scene" });
    const s = h.app.addScene(p.id, { topic: "Scene to delete" });
    const ownedDir = join(h.app.projectDir(p.id), "scenes", s.id, "v1");
    const externalDir = join(h.dir, "imported-v1");
    mkdirSync(ownedDir, { recursive: true });
    mkdirSync(externalDir, { recursive: true });
    writeFileSync(join(ownedDir, "session.jsonl"), "owned");
    writeFileSync(join(externalDir, "session.jsonl"), "external");

    const interrupted = newJob({
      id: "job_interrupted",
      kind: "build",
      pipeline: p.pipeline,
      input: { topic: "busy" },
      refs: { projectId: p.id, sceneId: s.id },
      now: "2026-01-01T00:00:00.000Z",
    });
    h.store.insertJob(transition(transition(interrupted, { type: "start" }, "2026-01-01T00:00:00.000Z"), { type: "interrupt" }, "2026-01-01T00:00:00.000Z"));
    expect(() => h.app.deleteScene(s.id)).toThrow(/active job/);
    h.store.applyEvent(interrupted.id, { type: "cancel", reason: "test cleanup" }, "2026-01-01T00:00:00.000Z");

    const terminal = newJob({
      id: "job_terminal",
      kind: "build",
      pipeline: p.pipeline,
      input: { topic: "history" },
      refs: { projectId: p.id, sceneId: s.id, versionId: "ver_terminal" },
      now: "2026-01-01T00:00:00.000Z",
    });
    h.store.insertJob(terminal);
    h.store.applyEvent(terminal.id, { type: "start" }, "2026-01-01T00:00:00.000Z");
    h.store.applyEvent(terminal.id, { type: "succeed", result: { versionId: "ver_terminal" } }, "2026-01-01T00:00:00.000Z");
    const importedJob = newJob({
      id: "job_imported",
      kind: "build",
      pipeline: p.pipeline,
      input: { imported: true },
      refs: { projectId: p.id, sceneId: s.id },
      now: "2026-01-01T00:00:00.000Z",
    });
    h.store.insertJob(transition(transition(importedJob, { type: "start" }, "2026-01-01T00:00:00.000Z"), { type: "succeed", result: { imported: true } }, "2026-01-01T00:00:00.000Z"));
    h.store.putVersion({
      id: "ver_owned", sceneId: s.id, number: 1, parentVersionId: null, jobId: terminal.id,
      workdir: ownedDir, projectDir: null, state: "failed",
      outputs: { video: null, contactSheets: [], captionsGroups: null }, durationSec: null, notes: null, createdAt: "2026-01-01T00:00:00.000Z",
    });
    h.store.putVersion({
      id: "ver_imported", sceneId: s.id, number: 2, parentVersionId: "ver_owned", jobId: importedJob.id,
      workdir: externalDir, projectDir: externalDir, state: "ready",
      outputs: { video: join(externalDir, "video.mp4"), contactSheets: [], captionsGroups: null }, durationSec: 1, notes: null, createdAt: "2026-01-01T00:00:00.000Z",
    });
    h.store.putProject({
      ...h.app.project(p.id),
      timeline: { order: [s.id], transitions: { [s.id]: "fade" } },
      final: { state: "done", jobId: terminal.id, scenes: [s.id], versions: { [s.id]: "ver_imported" }, at: "2026-01-01T00:00:00.000Z", video: join(externalDir, "video.mp4") },
    });

    h.app.deleteScene(s.id);
    expect(existsSync(ownedDir)).toBe(false);
    expect(existsSync(externalDir)).toBe(true);
    expect(h.store.getVersion("ver_owned")).toBeUndefined();
    expect(h.store.getVersion("ver_imported")).toBeUndefined();
    expect(h.store.getJob(terminal.id)?.state).toBe("succeeded");
    expect(h.store.listEvents(terminal.id).map(e => e.type)).toEqual(["created", "start", "succeed"]);
    expect(h.app.project(p.id).timeline).toEqual({ order: [], transitions: {} });
    expect(h.app.project(p.id).final).toBeNull();
  });
});

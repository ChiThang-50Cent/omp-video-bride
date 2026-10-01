import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    expect(() => h.app.resume(job.id)).toThrowError(expect.objectContaining({ code: "not_resumable", status: 409 }));
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

describe("manual resume", () => {
  it("resumes a failed build with the same job/version and cumulative usage", async () => {
    const h = harness();
    h.scenario({ final: "not-json" });
    const created = h.app.createVideo({ topic: "Manual continuation" });
    await h.app.idle();
    const failed = h.app.job(created.job.id);
    const failedVersion = h.app.version(created.version.id);
    expect(failed.state).toBe("failed");
    expect(failedVersion.state).toBe("failed");
    expect(existsSync(join(failedVersion.workdir, "sessions", "main.jsonl"))).toBe(true);

    h.scenario(okScenario());
    const queued = h.app.resume(failed.id, { maxMinutes: 20, maxUsd: 4 });
    expect(queued.id).toBe(failed.id);
    expect(queued.refs).toEqual(failed.refs);
    expect(queued.resumes).toBe(failed.resumes);
    expect(queued.startedAt).toBeNull();
    expect(h.app.version(created.version.id).state).toBe("pending");
    await h.app.idle();

    const done = h.app.job(failed.id);
    expect(done.state).toBe("succeeded");
    expect(done.refs).toEqual(failed.refs);
    expect(done.result).toMatchObject({ versionId: created.version.id });
    expect(done.usage.usd).toBeGreaterThanOrEqual(failed.usage.usd);
    expect(h.app.version(created.version.id).jobId).toBe(failedVersion.jobId);
    expect(h.store.listEvents(failed.id).map(e => e.type)).toContain("manual_resume");
  });

  it("rejects a missing pinned session without mutating the job, version, or history", async () => {
    const h = harness();
    h.scenario({ final: "not-json" });
    const created = h.app.createVideo({ topic: "Missing continuation" });
    await h.app.idle();
    const beforeJob = h.app.job(created.job.id);
    const beforeVersion = h.app.version(created.version.id);
    const beforeEvents = h.store.listEvents(created.job.id);
    rmSync(join(beforeVersion.workdir, "sessions", "main.jsonl"));

    expect(() => h.app.resume(created.job.id)).toThrowError(expect.objectContaining({ code: "resume_unavailable", status: 409 }));
    expect(h.app.job(created.job.id)).toEqual(beforeJob);
    expect(h.app.version(created.version.id)).toEqual(beforeVersion);
    expect(h.store.listEvents(created.job.id)).toEqual(beforeEvents);
  });

  it("refuses to resume a revision whose copied project directory was lost", async () => {
    const h = harness();
    h.scenario(okScenario());
    const original = h.app.createVideo({ topic: "Preserve revision progress" });
    await h.app.idle();
    h.scenario({ final: "not-json" });
    const revision = h.app.reviseScene(original.scene.id, { instructions: "Change the existing scene" });
    await h.app.idle();
    const beforeJob = h.app.job(revision.job.id);
    const beforeVersion = h.app.version(revision.version.id);
    const beforeEvents = h.store.listEvents(revision.job.id);
    rmSync(beforeVersion.projectDir!, { recursive: true });

    expect(() => h.app.resume(revision.job.id)).toThrowError(expect.objectContaining({ code: "resume_unavailable", status: 409 }));
    expect(h.app.job(revision.job.id)).toEqual(beforeJob);
    expect(h.app.version(revision.version.id)).toEqual(beforeVersion);
    expect(h.store.listEvents(revision.job.id)).toEqual(beforeEvents);
  });

  it("rejects a session with incomplete persisted usage history", async () => {
    const h = harness();
    h.scenario({ steps: [{ text: "spent", usd: 0.2 }], final: "not-json" });
    const created = h.app.createVideo({ topic: "Incomplete usage history" });
    await h.app.idle();
    const failedVersion = h.app.version(created.version.id);
    const session = join(failedVersion.workdir, "sessions", "main.jsonl");
    writeFileSync(session, readFileSync(session, "utf8").split("\n").filter(line => !line.includes('"usage"')).join("\n"));
    const before = h.store.listEvents(created.job.id);

    expect(() => h.app.resume(created.job.id)).toThrowError(expect.objectContaining({ code: "resume_unavailable", status: 409 }));
    expect(h.store.listEvents(created.job.id)).toEqual(before);
    expect(h.app.job(created.job.id).state).toBe("failed");
  });

  it("requires a higher total budget after cumulative cost reaches the old limit", async () => {
    const h = harness();
    h.scenario({ steps: [{ text: "spent", usd: 0.25 }], final: "not-json" });
    const created = h.app.createVideo({ topic: "Budget continuation" }, { limits: { maxUsd: 0.25 } });
    await h.app.idle();
    expect(h.app.job(created.job.id).usage.usd).toBeCloseTo(0.25);
    expect(() => h.app.resume(created.job.id)).toThrowError(expect.objectContaining({ code: "budget_exhausted", status: 409 }));

    h.scenario(okScenario());
    const resumed = h.app.resume(created.job.id, { maxUsd: 1 });
    expect(resumed.limits.maxUsd).toBe(1);
    await h.app.idle();
    expect(h.app.job(created.job.id).usage.usd).toBeGreaterThanOrEqual(0.25);
  });

  it("manually resumes a failed native render without allowing USD edits", async () => {
    const h = harness();
    h.scenario({ writeFiles: { "videos/demo/caption_groups.json": "[]" }, final: '```json\n{"video":"","project_dir":"{{cwd}}/videos/demo","duration_s":20}\n```' });
    const created = h.app.createVideo({ topic: "Native render continuation" }, { render: false });
    await h.app.idle();
    const pipe = h.app.d.pipelines["hyperframes-explainer"]!;
    pipe.render = async () => { throw new Error("first render failure"); };
    const render = h.app.renderVersion(created.version.id);
    await h.app.idle();
    expect(h.app.job(render.id).state).toBe("failed");
    expect(() => h.app.resume(render.id, { maxUsd: 1 })).toThrowError(expect.objectContaining({ code: "invalid_request", status: 400 }));

    pipe.render = async projectDir => {
      const video = join(projectDir, "renders/video.mp4");
      mkdirSync(join(projectDir, "renders"), { recursive: true });
      writeFileSync(video, "rendered");
      return { video, durationSec: 20 };
    };
    const resumed = h.app.resume(render.id);
    expect(resumed.limits.maxUsd).toBe(0);
    await h.app.idle();
    expect(h.app.job(render.id).state).toBe("succeeded");
    expect(h.app.version(created.version.id).outputs.video).toMatch(/video\.mp4$/);
  });

  it("manually resumes a failed stitch against the current timeline", async () => {
    let fail = true;
    const order: string[][] = [];
    const h = harness({
      stitch: async (_project, scenes, outDir) => {
        if (fail) {
          fail = false;
          throw new Error("first stitch failure");
        }
        order.push(scenes.map(s => s.scene.title));
        const video = join(outDir, "final.mp4");
        writeFileSync(video, "stitched");
        return { video, durationSec: 40 };
      },
    });
    const project = h.app.createProject({ name: "Resume stitch" });
    const first = h.app.addScene(project.id, { title: "First", topic: "First scene" });
    const second = h.app.addScene(project.id, { title: "Second", topic: "Second scene" });
    h.scenario(okScenario());
    h.app.buildScene(first.id);
    await h.app.idle();
    h.scenario(okScenario());
    h.app.buildScene(second.id);
    await h.app.idle();
    const stitch = h.app.stitch(project.id);
    await h.app.idle();
    expect(h.app.job(stitch.id).state).toBe("failed");
    h.app.setTimeline(project.id, { order: [second.id, first.id] });
    const resumed = h.app.resume(stitch.id);
    expect(resumed.limits.maxUsd).toBe(0);
    await h.app.idle();
    expect(h.app.job(stitch.id).state).toBe("succeeded");
    expect(order).toEqual([["Second", "First"]]);
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

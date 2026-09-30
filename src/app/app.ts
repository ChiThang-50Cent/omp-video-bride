import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Asset, type Project, type Scene, type Version, type VersionOutputs, assetKind, slug } from "../core/entities.ts";
import { type Job, type JobEvent, type JobKind, limitExceeded, newJob } from "../core/job.ts";
import type { Pipeline, PromptCtx } from "../ports/pipeline.ts";
import type { RunHandle, Runner } from "../ports/runner.ts";
import type { Store } from "../ports/store.ts";
import { AppError, conflict, invalid, notFound } from "./errors.ts";

export interface AppConfig {
  dataDir: string;
  concurrency: number;
  model: string;
  thinking: string;
  workerModel: string;
  workerThinking: string;
  maxMinutes: number;
  maxUsd: number;
  env: Record<string, string>;
  /** Extra skill dirs (host skills) in addition to the pipeline's own. */
  skillDirs: string[];
  usagePollMs?: number;
}

export interface Deps {
  store: Store;
  runner: Runner;
  pipelines: Record<string, Pipeline>;
  config: AppConfig;
  now?: () => string;
  /** Called after every persisted job event, inside the same transaction (used for the webhook outbox). */
  onJobEvent?: (job: Job, event: JobEvent) => void;
  stitch?: (project: Project, scenes: { scene: Scene; video: string }[], outDir: string, signal: AbortSignal) => Promise<{ video: string; durationSec: number | null }>;
}

export interface Limits { maxMinutes?: number; maxUsd?: number }
export interface JobOptions { metadata?: Record<string, unknown>; limits?: Limits; approve?: "storyboard" | null; render?: boolean }

interface BuildInput { versionId: string; instructions?: string; frames?: number[]; durationSec?: number | null; flags: { approve: "storyboard" | null; render: boolean } }

const id = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

export class App {
  readonly d: Deps;
  private readonly running = new Map<string, { handle?: RunHandle; abort: AbortController; cancelled?: string }>();
  private pumping = false;
  private stopping = false;

  constructor(deps: Deps) {
    this.d = deps;
  }

  private now(): string { return (this.d.now ?? (() => new Date().toISOString()))(); }
  private pipeline(idv: string): Pipeline {
    const p = this.d.pipelines[idv];
    if (!p) throw invalid(`unknown pipeline "${idv}"`);
    return p;
  }

  // ------------------------------------------------------------------ events
  private apply(jobId: string, event: JobEvent): Job {
    return this.d.store.tx(() => {
      const job = this.d.store.applyEvent(jobId, event, this.now());
      this.d.onJobEvent?.(job, event);
      return job;
    });
  }

  // ------------------------------------------------------------- projects
  createProject(i: { name: string; pipeline?: string; spec?: unknown; brief?: string; brand?: Project["brand"] }): Project {
    const pipeline = this.pipeline(i.pipeline ?? "hyperframes-explainer");
    const spec = this.parseSpec(pipeline, i.spec ?? {});
    const p: Project = {
      id: `${slug(i.name)}-${randomBytes(2).toString("hex")}`, name: i.name, pipeline: pipeline.id, spec, brief: i.brief ?? "",
      brand: i.brand ?? {}, timeline: { order: [], transitions: {} }, final: null, createdAt: this.now(),
    };
    this.d.store.putProject(p);
    mkdirSync(this.assetsDir(p.id), { recursive: true });
    return p;
  }

  private parseSpec(pipeline: Pipeline, raw: unknown): Record<string, unknown> {
    const r = pipeline.specSchema.safeParse(raw);
    if (!r.success) throw invalid(`spec: ${r.error.issues.map(x => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
    return r.data;
  }

  updateProject(pid: string, patch: { name?: string; spec?: unknown; brief?: string; brand?: Project["brand"] }): Project {
    const p = this.project(pid);
    const next: Project = { ...p };
    if (patch.name) next.name = patch.name;
    if (patch.brief !== undefined) next.brief = patch.brief;
    if (patch.brand) next.brand = patch.brand;
    if (patch.spec) next.spec = this.parseSpec(this.pipeline(p.pipeline), { ...p.spec, ...(patch.spec as object) });
    this.d.store.putProject(next);
    return next;
  }

  project(pid: string): Project {
    const p = this.d.store.getProject(pid);
    if (!p) throw notFound("project", pid);
    return p;
  }
  scene(sid: string): Scene {
    const s = this.d.store.getScene(sid);
    if (!s) throw notFound("scene", sid);
    return s;
  }
  version(vid: string): Version {
    const v = this.d.store.getVersion(vid);
    if (!v) throw notFound("version", vid);
    return v;
  }
  job(jid: string): Job {
    const j = this.d.store.getJob(jid);
    if (!j) throw notFound("job", jid);
    return j;
  }

  projectDir(pid: string): string { return join(this.d.config.dataDir, "projects", pid); }
  assetsDir(pid: string): string { return join(this.projectDir(pid), "assets"); }

  deleteProject(pid: string): void {
    const p = this.project(pid);
    const active = this.d.store.listJobs({ projectId: pid }).filter(j => j.state === "queued" || j.state === "running" || j.state === "awaiting_approval");
    if (active.length) throw conflict("project_busy", `project has ${active.length} active job(s); cancel them first`);
    this.d.store.deleteProject(p.id);
    rmSync(this.projectDir(pid), { recursive: true, force: true });
  }

  // --------------------------------------------------------------- scenes
  addScene(pid: string, i: { title?: string; topic: string; brief?: string; durationSec?: number; assets?: string[]; findAssets?: boolean }): Scene {
    const p = this.project(pid);
    const existing = this.d.store.listScenes(pid);
    const n = existing.length + 1;
    for (const a of i.assets ?? []) if (!this.assetOf(pid, a)) throw invalid(`asset "${a}" not found in this project`);
    const s: Scene = {
      id: id("scn"), projectId: p.id, n, title: i.title ?? `Scene ${n}`, topic: i.topic, brief: i.brief ?? "",
      durationSec: i.durationSec ?? 50, assetRefs: i.assets ?? [], findAssets: i.findAssets ?? false, currentVersionId: null, createdAt: this.now(),
    };
    this.d.store.tx(() => {
      this.d.store.putScene(s);
      const cur = this.project(pid);
      this.d.store.putProject({ ...cur, timeline: { ...cur.timeline, order: [...cur.timeline.order, s.id] } });
    });
    return s;
  }

  private assetOf(pid: string, ref: string): Asset | undefined {
    return this.d.store.listAssets(pid).find(a => a.id === ref || a.name === ref);
  }

  deleteScene(sid: string): void {
    const s = this.scene(sid);
    if (this.d.store.listJobs({ projectId: s.projectId }).some(j => j.refs.sceneId === sid && (j.state === "queued" || j.state === "running" || j.state === "awaiting_approval"))) {
      throw conflict("scene_busy", "scene has an active job");
    }
    this.d.store.tx(() => {
      this.d.store.deleteScene(sid);
      const cur = this.project(s.projectId);
      this.d.store.putProject({ ...cur, timeline: { ...cur.timeline, order: cur.timeline.order.filter(x => x !== sid) } });
    });
  }

  // ------------------------------------------------- build / revise jobs
  private newVersion(scene: Scene, parent: Version | null, jobId: string): Version {
    const versions = this.d.store.listVersions(scene.id);
    const number = (versions.at(-1)?.number ?? 0) + 1;
    const vid = id("ver");
    return {
      id: vid, sceneId: scene.id, number, parentVersionId: parent?.id ?? null, jobId,
      workdir: join(this.projectDir(scene.projectId), "scenes", scene.id, `v${number}`), projectDir: null, state: "pending",
      outputs: { video: null, contactSheets: [], captionsGroups: null }, durationSec: null, notes: null, createdAt: this.now(),
    };
  }

  private busyScene(scene: Scene): void {
    const busy = this.d.store.listJobs({ projectId: scene.projectId }).find(j => j.refs.sceneId === scene.id && ["queued", "running", "awaiting_approval", "interrupted"].includes(j.state));
    if (busy) throw conflict("scene_busy", `scene has active job ${busy.id} (${busy.state})`);
  }

  private enqueue(kind: JobKind, scene: Scene, project: Project, parent: Version | null, input: Omit<BuildInput, "versionId">, o: JobOptions): { job: Job; version: Version } {
    this.busyScene(scene);
    const jobId = id("job");
    const version = this.newVersion(scene, parent, jobId);
    const job = newJob({
      id: jobId, kind, pipeline: project.pipeline, input: { ...input, versionId: version.id }, metadata: o.metadata,
      limits: { maxMinutes: o.limits?.maxMinutes ?? this.d.config.maxMinutes, maxUsd: o.limits?.maxUsd ?? this.d.config.maxUsd },
      refs: { projectId: project.id, sceneId: scene.id, versionId: version.id }, now: this.now(),
    });
    this.d.store.tx(() => {
      this.d.store.putVersion(version);
      this.d.store.insertJob(job);
    });
    void this.pump();
    return { job, version };
  }

  buildScene(sid: string, o: JobOptions = {}): { job: Job; version: Version } {
    const scene = this.scene(sid);
    const project = this.project(scene.projectId);
    return this.enqueue("build", scene, project, null, { flags: { approve: o.approve ?? null, render: o.render ?? true }, durationSec: scene.durationSec }, o);
  }

  reviseScene(sid: string, i: { instructions: string; frames?: number[]; durationSec?: number; fromVersionId?: string }, o: JobOptions = {}): { job: Job; version: Version } {
    const scene = this.scene(sid);
    const project = this.project(scene.projectId);
    const parentId = i.fromVersionId ?? scene.currentVersionId;
    if (!parentId) throw conflict("no_base_version", "scene has no version to revise; build it first");
    const parent = this.version(parentId);
    if (parent.sceneId !== sid) throw invalid("fromVersionId belongs to another scene");
    if (parent.state !== "ready" || !parent.projectDir) throw conflict("version_not_ready", "the base version is not ready");
    return this.enqueue("revise", scene, project, parent, { instructions: i.instructions, frames: i.frames ?? [], durationSec: i.durationSec ?? null, flags: { approve: null, render: o.render ?? true } }, o);
  }

  /** Scene version becomes the one used by stitch. */
  useVersion(sid: string, vid: string): Scene {
    const scene = this.scene(sid);
    const v = this.version(vid);
    if (v.sceneId !== sid) throw invalid("version belongs to another scene");
    if (v.state !== "ready") throw conflict("version_not_ready", "only ready versions can be selected");
    const next = { ...scene, currentVersionId: vid };
    this.d.store.putScene(next);
    return next;
  }

  /** Renders a previewed version natively (no LLM). */
  renderVersion(vid: string, o: JobOptions = {}): Job {
    const v = this.version(vid);
    const scene = this.scene(v.sceneId);
    const project = this.project(scene.projectId);
    if (v.state !== "ready" || !v.projectDir) throw conflict("version_not_ready", "version is not ready");
    if (v.outputs.video) throw conflict("already_rendered", "version already has a video");
    this.busyScene(scene);
    const job = newJob({ id: id("job"), kind: "render", pipeline: project.pipeline, input: { versionId: vid }, metadata: o.metadata, limits: { maxMinutes: 30, maxUsd: 0 }, refs: { projectId: project.id, sceneId: scene.id, versionId: vid }, now: this.now() });
    this.d.store.tx(() => { this.d.store.insertJob(job); });
    void this.pump();
    return job;
  }

  /** Convenience: one video = auto project with one scene. */
  createVideo(i: { topic: string; title?: string; spec?: unknown; brief?: string; durationSec?: number; assets?: string[]; findAssets?: boolean }, o: JobOptions = {}) {
    const project = this.createProject({ name: i.title ?? i.topic, spec: i.spec, brief: i.brief });
    const scene = this.addScene(project.id, { topic: i.topic, title: i.title, durationSec: i.durationSec, assets: i.assets, findAssets: i.findAssets });
    const r = this.buildScene(scene.id, o);
    return { project, scene, ...r };
  }

  approve(jid: string, notes?: string): Job {
    const job = this.job(jid);
    if (job.state !== "awaiting_approval") throw conflict("not_awaiting_approval", `job is ${job.state}`);
    const j = this.apply(jid, { type: "approve", notes });
    void this.pump();
    return j;
  }

  cancel(jid: string, reason?: string): Job {
    const job = this.job(jid);
    if (["succeeded", "failed", "rejected", "cancelled"].includes(job.state)) throw conflict("job_finished", `job is already ${job.state}`);
    const r = this.running.get(jid);
    if (r && job.state === "running") {
      r.cancelled = reason ?? "cancelled by request";
      r.abort.abort();
      r.handle?.kill();
      return job; // finish() writes the cancel event once the process group is gone
    }
    const j = this.apply(jid, { type: "cancel", reason });
    this.markVersionFailed(j);
    return j;
  }

  private markVersionFailed(job: Job): void {
    if (job.kind !== "build" && job.kind !== "revise") return;
    const vid = job.refs.versionId;
    const v = vid && this.d.store.getVersion(vid);
    if (v && v.state === "pending") this.d.store.putVersion({ ...v, state: "failed", notes: job.error?.message ?? null });
  }

  // -------------------------------------------------------------- lifecycle
  /** Turns jobs left `running` by a previous process into resumable ones, then starts the queue. */
  recover(): void {
    for (const j of this.d.store.listJobs({ state: "running" })) {
      this.apply(j.id, { type: "interrupt" });
      const r = this.apply(j.id, { type: "resume" });
      if (r.state === "failed") this.markVersionFailed(r);
    }
    for (const j of this.d.store.listJobs({ state: "interrupted" })) {
      const r = this.apply(j.id, { type: "resume" });
      if (r.state === "failed") this.markVersionFailed(r);
    }
    void this.pump();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const r of this.running.values()) r.handle?.kill(2000);
    await Promise.all([...this.running.values()].map(r => r.handle?.done.catch(() => undefined)));
  }

  /** Resolves when nothing is running or queued (tests, graceful drain). */
  async idle(): Promise<void> {
    while (this.running.size || this.d.store.listJobs({ state: "queued" }).length) await new Promise(r => setTimeout(r, 20));
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopping) return;
    this.pumping = true;
    try {
      while (!this.stopping && this.running.size < this.d.config.concurrency) {
        const next = this.d.store.listJobs({ state: "queued", limit: 100 }).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).find(j => !this.running.has(j.id));
        if (!next) break;
        const started = this.apply(next.id, { type: "start" });
        const entry = { abort: new AbortController() } as { handle?: RunHandle; abort: AbortController; cancelled?: string };
        this.running.set(next.id, entry);
        void this.execute(next, started, entry).catch(e => this.crash(next.id, e)).finally(() => { this.running.delete(next.id); void this.pump(); });
      }
    } finally {
      this.pumping = false;
    }
  }

  private crash(jid: string, e: unknown): void {
    const job = this.d.store.getJob(jid);
    if (!job || job.state !== "running") return;
    const j = this.apply(jid, { type: "fail", error: { code: "internal_error", message: e instanceof Error ? e.message : String(e) } });
    this.markVersionFailed(j);
  }

  // ---------------------------------------------------------- execution
  /** `queued` is the job as it was before `start` cleared its resume flags. */
  private async execute(queued: Job, job: Job, entry: { handle?: RunHandle; abort: AbortController; cancelled?: string }): Promise<void> {
    if (job.kind === "render") return this.executeRender(job, entry);
    if (job.kind === "stitch") return this.executeStitch(job, entry);
    const input = job.input as BuildInput;
    const version = this.version(input.versionId);
    const scene = this.scene(version.sceneId);
    const project = this.project(scene.projectId);
    const pipeline = this.pipeline(job.pipeline);

    let projectDir = version.projectDir;
    if (job.kind === "revise" && !queued.resume) {
      const parent = this.version(version.parentVersionId!);
      mkdirSync(version.workdir, { recursive: true });
      projectDir = pipeline.prepareRevision(parent.projectDir!, version.workdir);
      this.d.store.putVersion({ ...version, projectDir });
    }
    const kind: PromptCtx["kind"] = queued.resume ? (queued.resumeReason === "approval" ? "approve-continue" : "resume") : job.kind === "revise" ? "revise" : "build";
    const parent = version.parentVersionId ? this.version(version.parentVersionId) : null;
    const assets = this.d.store.listAssets(project.id);
    const selected = assets.filter(a => scene.assetRefs.includes(a.id) || scene.assetRefs.includes(a.name));
    const ctx: PromptCtx = {
      kind, job, project, scene, workdir: version.workdir, projectDir,
      assets: { dir: this.assetsDir(project.id), foundDir: join(this.assetsDir(project.id), "found"), selected, others: assets.filter(a => !selected.includes(a)) },
      revise: job.kind === "revise" ? { instructions: input.instructions ?? "", frames: input.frames ?? [], durationSec: input.durationSec ?? null, currentDurationSec: parent?.durationSec ?? null } : undefined,
      flags: input.flags, approvalNotes: queued.approvalNotes,
    };
    mkdirSync(join(this.assetsDir(project.id), "found"), { recursive: true });
    const om = pipeline.omp();
    const handle = this.d.runner.start({
      workdir: version.workdir, prompt: pipeline.prompt(ctx), resume: queued.resume,
      model: this.d.config.model, thinking: this.d.config.thinking, workerModel: this.d.config.workerModel, workerThinking: this.d.config.workerThinking,
      skillDirs: [...om.skillDirs, ...this.d.config.skillDirs], env: { ...this.d.config.env, ...om.env },
    });
    entry.handle = handle;

    let limitError: ReturnType<typeof limitExceeded> = null;
    const poll = setInterval(() => {
      try {
        const cur = this.apply(job.id, { type: "usage", usage: this.d.runner.usage(version.workdir) });
        limitError = limitExceeded(cur, this.now());
        if (limitError) handle.kill();
      } catch { /* job already left running */ }
    }, this.d.config.usagePollMs ?? 15_000);
    const exit = await handle.done;
    clearInterval(poll);

    const usage = this.d.runner.usage(version.workdir);
    let cur = this.job(job.id);
    if (cur.state === "running") cur = this.apply(job.id, { type: "usage", usage });
    if (this.stopping) return; // stays `running`; recover() interrupts and resumes it on the next start
    if (entry.cancelled !== undefined) {
      const j = this.apply(job.id, { type: "cancel", reason: entry.cancelled });
      this.markVersionFailed(j);
      return;
    }
    if (limitError) { this.markVersionFailed(this.apply(job.id, { type: "fail", error: limitError })); return; }

    const requireVideo = input.flags.render;
    const parsed = pipeline.parseResult(exit.finalText, version.workdir, { requireVideo });
    const fail = (code: string, message: string) => this.markVersionFailed(this.apply(job.id, { type: "fail", error: { code, message } }));
    if (parsed.kind === "invalid") return fail(exit.code === 0 ? "bad_result" : "omp_failed", exit.code === 0 ? parsed.message : `omp exited ${exit.code ?? exit.signal}; ${parsed.message}`);
    if (parsed.kind === "rejected") {
      this.markVersionFailed(this.apply(job.id, { type: "reject", error: { code: "rejected", message: parsed.reason } }));
      return;
    }
    if (parsed.kind === "awaiting_approval") {
      this.d.store.tx(() => {
        // Approval documents are shared through the read-only Hermes mount.
        chmodSync(parsed.storyboard, 0o644);
        if (parsed.script) chmodSync(parsed.script, 0o644);
        this.d.store.putVersion({ ...this.version(version.id), projectDir: parsed.projectDir, notes: null });
        this.apply(job.id, { type: "need_approval" });
      });
      return;
    }
    const done: Version = {
      ...this.version(version.id), state: "ready", projectDir: parsed.projectDir,
      outputs: { video: parsed.video, contactSheets: parsed.contactSheets, captionsGroups: parsed.captionsGroups }, durationSec: parsed.durationSec, notes: parsed.note,
    };
    this.makeOutputsReadable(done.outputs);
    this.d.store.tx(() => {
      this.d.store.putVersion(done);
      this.registerFoundAssets(project.id);
      if (parsed.video) this.d.store.putScene({ ...this.scene(scene.id), currentVersionId: done.id });
      this.apply(job.id, { type: "succeed", result: { versionId: done.id, video: done.outputs.video, contactSheets: done.outputs.contactSheets, durationSec: done.durationSec, notes: done.notes, framesChanged: parsed.changed } });
    });
  }

  private makeOutputsReadable(outputs: VersionOutputs): void {
    // Snapshot writers may use 0600. Hermes has a different UID; publish only
    // the intentional delivery artifacts, never sessions, overlays or sources.
    for (const path of [outputs.video, ...outputs.contactSheets, outputs.captionsGroups]) {
      if (path) chmodSync(path, 0o644);
    }
  }

  private async executeRender(job: Job, entry: { abort: AbortController; cancelled?: string }): Promise<void> {
    const v = this.version((job.input as { versionId: string }).versionId);
    const pipeline = this.pipeline(job.pipeline);
    try {
      const r = await pipeline.render(v.projectDir!, entry.abort.signal);
      if (entry.cancelled !== undefined) { this.apply(job.id, { type: "cancel", reason: entry.cancelled }); return; }
      this.makeOutputsReadable({ ...v.outputs, video: r.video });
      this.d.store.tx(() => {
        this.d.store.putVersion({ ...this.version(v.id), outputs: { ...v.outputs, video: r.video }, durationSec: r.durationSec ?? v.durationSec });
        this.d.store.putScene({ ...this.scene(v.sceneId), currentVersionId: v.id });
        this.apply(job.id, { type: "succeed", result: { versionId: v.id, video: r.video, durationSec: r.durationSec } });
      });
    } catch (e) {
      if (entry.cancelled !== undefined) { this.apply(job.id, { type: "cancel", reason: entry.cancelled }); return; }
      this.apply(job.id, { type: "fail", error: { code: "render_failed", message: e instanceof Error ? e.message : String(e) } });
    }
  }

  // ------------------------------------------------------------- stitch
  stitch(pid: string, o: JobOptions = {}): Job {
    const project = this.project(pid);
    const missing = project.timeline.order.map(sid => this.scene(sid)).filter(s => !s.currentVersionId || !this.version(s.currentVersionId).outputs.video);
    if (!project.timeline.order.length) throw conflict("empty_timeline", "project has no scenes");
    if (missing.length) throw conflict("scenes_not_ready", `scenes without a rendered video: ${missing.map(s => s.n).join(", ")}`);
    if (!this.d.stitch) throw new AppError(501, "not_supported", "stitch is not configured");
    const job = newJob({ id: id("job"), kind: "stitch", pipeline: project.pipeline, input: {}, metadata: o.metadata, limits: { maxMinutes: 30, maxUsd: 0 }, refs: { projectId: pid }, now: this.now() });
    this.d.store.tx(() => { this.d.store.insertJob(job); });
    void this.pump();
    return job;
  }

  private async executeStitch(job: Job, entry: { abort: AbortController; cancelled?: string }): Promise<void> {
    const project = this.project(job.refs.projectId!);
    const scenes = project.timeline.order.map(sid => { const scene = this.scene(sid); return { scene, version: this.version(scene.currentVersionId!) }; });
    const versions = Object.fromEntries(scenes.map(s => [s.scene.id, s.version.id]));
    const outDir = join(this.projectDir(project.id), "final");
    mkdirSync(outDir, { recursive: true });
    try {
      const r = await this.d.stitch!(project, scenes.map(s => ({ scene: s.scene, video: s.version.outputs.video! })), outDir, entry.abort.signal);
      if (entry.cancelled !== undefined) { this.apply(job.id, { type: "cancel", reason: entry.cancelled }); return; }
      this.d.store.tx(() => {
        this.d.store.putProject({ ...this.project(project.id), final: { state: "done", jobId: job.id, video: r.video, durationSec: r.durationSec ?? undefined, scenes: scenes.map(s => s.scene.id), versions, at: this.now() } });
        this.apply(job.id, { type: "succeed", result: { video: r.video, durationSec: r.durationSec, scenes: scenes.length } });
      });
    } catch (e) {
      if (entry.cancelled !== undefined) { this.apply(job.id, { type: "cancel", reason: entry.cancelled }); return; }
      this.apply(job.id, { type: "fail", error: { code: "stitch_failed", message: e instanceof Error ? e.message : String(e) } });
    }
  }

  // ------------------------------------------------------------- assets
  addAsset(pid: string, i: { name: string; data: Buffer; tags?: string[]; origin?: Asset["origin"]; source?: string; license?: string; dir?: string }): { asset: Asset; duplicate: boolean } {
    this.project(pid);
    const safe = i.name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
    if (!safe) throw invalid("asset name is empty after sanitizing");
    const sha256 = createHash("sha256").update(i.data).digest("hex");
    const dup = this.d.store.listAssets(pid).find(a => a.sha256 === sha256);
    if (dup) return { asset: dup, duplicate: true };
    const dir = i.dir ?? this.assetsDir(pid);
    mkdirSync(dir, { recursive: true });
    let name = safe;
    let n = 1;
    while (existsSync(join(dir, name)) || this.d.store.listAssets(pid).some(a => a.name === name)) name = safe.replace(/(\.[^.]*)?$/, `-${++n}$1`);
    const path = join(dir, name);
    writeFileSync(path, i.data);
    const asset: Asset = { id: id("ast"), projectId: pid, name, kind: assetKind(name), bytes: i.data.length, sha256, origin: i.origin ?? "upload", source: i.source ?? null, license: i.license ?? null, tags: i.tags ?? [], path, createdAt: this.now() };
    this.d.store.putAsset(asset);
    return { asset, duplicate: false };
  }

  deleteAsset(pid: string, aid: string): void {
    const a = this.d.store.getAsset(aid);
    if (!a || a.projectId !== pid) throw notFound("asset", aid);
    this.d.store.tx(() => {
      this.d.store.deleteAsset(aid);
      for (const s of this.d.store.listScenes(pid)) {
        if (s.assetRefs.some(r => r === aid || r === a.name)) this.d.store.putScene({ ...s, assetRefs: s.assetRefs.filter(r => r !== aid && r !== a.name) });
      }
    });
    rmSync(a.path, { force: true });
  }

  /** Images a worker saved under assets/found become project assets (origin ai-found). */
  private registerFoundAssets(pid: string): void {
    const dir = join(this.assetsDir(pid), "found");
    if (!existsSync(dir)) return;
    const sources = existsSync(join(dir, "SOURCES.md")) ? readFileSync(join(dir, "SOURCES.md"), "utf8") : "";
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (f === "SOURCES.md" || !statSync(p).isFile() || assetKind(f) === "other") continue;
      const sha256 = createHash("sha256").update(readFileSync(p)).digest("hex");
      if (this.d.store.listAssets(pid).some(a => a.sha256 === sha256 || a.path === p)) continue;
      const line = sources.split("\n").find(l => l.includes(f)) ?? null;
      this.d.store.putAsset({ id: id("ast"), projectId: pid, name: f, kind: assetKind(f), bytes: statSync(p).size, sha256, origin: "ai-found", source: line, license: null, tags: [], path: p, createdAt: this.now() });
    }
  }

  // ---------------------------------------------------------- timeline
  setTimeline(pid: string, t: { order?: string[]; transitions?: Record<string, "cut" | "fade"> }): Project {
    const p = this.project(pid);
    if (t.order) {
      const cur = [...p.timeline.order].sort().join();
      if ([...t.order].sort().join() !== cur) throw invalid("order must contain exactly the project's scene ids");
    }
    const next = { ...p, timeline: { ...p.timeline, order: t.order ?? p.timeline.order, transitions: t.transitions ?? p.timeline.transitions } };
    this.d.store.putProject(next);
    return next;
  }

  exists(path: string): boolean { return existsSync(path); }
}

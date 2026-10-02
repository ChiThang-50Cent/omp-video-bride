import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRouter, harness, okScenario, serve } from "./harness.ts";

const servers: { close(): void }[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

async function boot(h = harness(), over: { stitch?: any } = {}) {
  const router = buildRouter(h.app, h.store, () => ({}));
  const server = serve(router, { token: "secret-token", publicPaths: ["/v1/health"] });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, raw?: Buffer) => {
    const res = await fetch(base + path, { method, headers: { authorization: "Bearer secret-token", ...(raw ? {} : { "content-type": "application/json" }) }, body: raw ? new Uint8Array(raw) : (body === undefined ? undefined : JSON.stringify(body)) });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
  };
  void over;
  return { h, base, call };
}

describe("http", () => {
  it("requires the bearer token except on health", async () => {
    const { base } = await boot();
    expect((await fetch(`${base}/v1/jobs`)).status).toBe(401);
    expect((await fetch(`${base}/v1/jobs`, { headers: { authorization: "secret-token" } })).status).toBe(401);
    expect((await fetch(`${base}/v1/jobs`, { headers: { authorization: "bearer secret-token" } })).status).toBe(401);
    const health = await fetch(`${base}/v1/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects an empty server token before accepting requests", () => {
    const h = harness();
    const router = buildRouter(h.app, h.store, () => ({}));
    expect(() => serve(router, { token: " \t\n", publicPaths: ["/v1/health"] })).toThrow(/token must not be empty/);
  });

  it("validates input with a structured error", async () => {
    const { call } = await boot();
    const r = await call("POST", "/v1/videos", { topic: "x" });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("invalid_request");
    const bad = await call("POST", "/v1/videos", { topic: "Valid topic", spec: { voice: "vi_hoa" } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toContain("voice");
  });

  it("validates job list query state and limit at the HTTP boundary", async () => {
    const { call } = await boot();
    expect((await call("GET", "/v1/jobs")).status).toBe(200);
    for (const query of ["limit=0", "limit=501", "limit=1.5", "limit=abc", "state=unknown"]) {
      const r = await call("GET", `/v1/jobs?${query}`);
      expect(r.status, query).toBe(400);
      expect(r.json.error.code).toBe("invalid_request");
    }
    expect((await call("GET", "/v1/jobs?state=queued&limit=1")).status).toBe(200);
  });

  it("creates a video, exposes catalog, and returns the finished job with its version", async () => {
    const { h, call } = await boot();
    h.scenario(okScenario());
    const cat = await call("GET", "/v1/catalog");
    const explainer = cat.json.pipelines.find((p: { pipeline: string; options: { voice?: string[] } }) => p.pipeline === "hyperframes-explainer");
    const storybook = cat.json.pipelines.find((p: { pipeline: string; options: Record<string, unknown> }) => p.pipeline === "hyperframes-storybook");
    expect(explainer?.options.voice).toContain("am_michael");
    expect(storybook?.pipeline).toBe("hyperframes-storybook");
    const c = await call("POST", "/v1/videos", { topic: "How TCP works", metadata: { chat: 42 } });
    expect(c.status).toBe(201);
    await h.app.idle();
    const j = await call("GET", `/v1/jobs/${c.json.job.id}?events=1`);
    expect(j.json.job.state).toBe("succeeded");
    expect(j.json.job.metadata).toEqual({ chat: 42 });
    expect(j.json.version.outputs.video).toMatch(/video\.mp4$/);
    expect(j.json.events.map((event: { type: string }) => event.type)).toEqual(expect.arrayContaining(["start", "succeed"]));
    expect(c.json.project.pipeline).toBe("hyperframes-explainer");
  });

  it("routes an explicit storybook video by pipeline ID and preserves its profile", async () => {
    const { h, call } = await boot();
    h.scenario({ steps: [{ sleepMs: 5_000 }], final: "" });
    const c = await call("POST", "/v1/videos", {
      pipeline: "hyperframes-storybook",
      title: "A seed grows",
      topic: "Show a seed growing into a young plant",
      brief: "A gentle story about patience and growth.",
      durationSec: 30,
      spec: {
        style: "storybook-flat",
        format: "landscape",
        voice: "am_michael",
        audience: "young children",
        tone: "warm and calm",
        narrationMode: "verbatim",
        music: "none",
      },
      assets: [],
      render: false,
    });
    expect(c.status).toBe(201);
    expect(c.json.project.pipeline).toBe("hyperframes-storybook");
    expect(c.json.project.brief).toBe("A gentle story about patience and growth.");
    expect(c.json.project.spec).toMatchObject({
      style: "storybook-flat",
      narrationMode: "verbatim",
      music: "none",
    });
    expect(c.json.job.pipeline).toBe("hyperframes-storybook");
    const inspected = await call("GET", `/v1/projects/${c.json.project.id}`);
    expect(inspected.json.project.pipeline).toBe("hyperframes-storybook");
    expect(inspected.json.project.spec).toMatchObject({ style: "storybook-flat", narrationMode: "verbatim", music: "none" });
    h.app.cancel(c.json.job.id);
    await h.app.idle();
  });

  it("rejects an explainer-only style for storybook before starting a worker", async () => {
    const { h, call } = await boot();
    const response = await call("POST", "/v1/videos", {
      pipeline: "hyperframes-storybook",
      topic: "An incompatible style",
      spec: { style: "creative-mode" },
    });
    expect(response.status).toBe(400);
    expect(response.json.error.code).toBe("invalid_request");
    expect(h.store.listJobs({ limit: -1 })).toHaveLength(0);
  });

  it("preserves storybook project profile and uploaded asset refs through build routing", async () => {
    const { h, call } = await boot();
    const projectResponse = await call("POST", "/v1/projects", {
      name: "Seed asset story",
      pipeline: "hyperframes-storybook",
      brief: "A supplied character learns to wait for spring.",
      spec: {
        style: "storybook-flat",
        format: "landscape",
        voice: "am_michael",
        audience: "young children",
        tone: "warm and calm",
        narrationMode: "verbatim",
        music: "required",
      },
    });
    expect(projectResponse.status).toBe(201);
    const projectId = projectResponse.json.project.id;
    const assetResponse = await call("POST", `/v1/projects/${projectId}/assets?name=character.png&tags=character`, undefined, Buffer.from("character"));
    expect(assetResponse.status).toBe(201);

    const sceneResponse = await call("POST", `/v1/projects/${projectId}/scenes`, {
      title: "Waiting",
      topic: "The character waits for spring",
      brief: "Keep the supplied character recognizable.",
      durationSec: 30,
      assets: [assetResponse.json.asset.id],
      findAssets: false,
    });
    expect(sceneResponse.status).toBe(201);

    h.scenario({ steps: [{ sleepMs: 5_000 }], final: "" });
    const buildResponse = await call("POST", `/v1/scenes/${sceneResponse.json.scene.id}/build`, { render: false });
    expect(buildResponse.status).toBe(201);
    expect(buildResponse.json.job.pipeline).toBe("hyperframes-storybook");

    const inspected = await call("GET", `/v1/projects/${projectId}`);
    expect(inspected.json.project.pipeline).toBe("hyperframes-storybook");
    expect(inspected.json.project.brief).toBe("A supplied character learns to wait for spring.");
    expect(inspected.json.project.spec).toMatchObject({ narrationMode: "verbatim", music: "required" });
    expect(inspected.json.assets.map((asset: { id: string }) => asset.id)).toContain(assetResponse.json.asset.id);
    expect(inspected.json.scenes[0].assetRefs).toEqual([assetResponse.json.asset.id]);

    h.app.cancel(buildResponse.json.job.id);
    await h.app.idle();
  });

  it("keeps same-name assets distinct and deletes the file with its record", async () => {
    const { h, call } = await boot();
    const p = h.app.createProject({ name: "Asset names" });
    const first = await call("POST", `/v1/projects/${p.id}/assets?name=logo.png`, undefined, Buffer.from("first"));
    const second = await call("POST", `/v1/projects/${p.id}/assets?name=logo.png`, undefined, Buffer.from("second"));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.json.asset.name).toBe("logo-2.png");
    expect(readFileSync(first.json.asset.path, "utf8")).toBe("first");
    expect(readFileSync(second.json.asset.path, "utf8")).toBe("second");
    expect((await call("DELETE", `/v1/projects/${p.id}/assets/${first.json.asset.id}`)).status).toBe(200);
    expect(existsSync(first.json.asset.path)).toBe(false);
    expect((await call("GET", `/v1/projects/${p.id}/assets`)).json.assets.map((a: { id: string }) => a.id)).toEqual([second.json.asset.id]);
  });

  it("dedupes assets by content and lists them", async () => {
    const { h, call } = await boot();
    const p = h.app.createProject({ name: "Assets" });
    const a = await call("POST", `/v1/projects/${p.id}/assets?name=logo.png&tags=logo`, undefined, Buffer.from("png-bytes"));
    expect(a.status).toBe(201);
    const b = await call("POST", `/v1/projects/${p.id}/assets?name=other.png`, undefined, Buffer.from("png-bytes"));
    expect(b.json.duplicate).toBe(true);
    expect(b.json.asset.id).toBe(a.json.asset.id);
    expect((await call("GET", `/v1/projects/${p.id}/assets`)).json.assets).toHaveLength(1);
  });
});

describe("manual resume endpoint", () => {
  it("accepts a bounded resume request and returns the existing job", async () => {
    const h = harness();
    const { call } = await boot(h);
    h.scenario({ final: "not-json" });
    const created = await call("POST", "/v1/videos", { topic: "HTTP continuation" });
    await h.app.idle();
    expect(h.app.job(created.json.job.id).state).toBe("failed");

    h.scenario(okScenario());
    const resumed = await call("POST", `/v1/jobs/${created.json.job.id}/resume`, { limits: { maxMinutes: 20 } });
    expect(resumed.status).toBe(200);
    expect(resumed.json.job.id).toBe(created.json.job.id);
    await h.app.idle();
    expect(h.app.job(created.json.job.id).state).toBe("succeeded");
  });

  it("validates resume limits before dispatching", async () => {
    const h = harness();
    const { call } = await boot(h);
    h.scenario({ final: "not-json" });
    const created = await call("POST", "/v1/videos", { topic: "Invalid continuation limit" });
    await h.app.idle();
    const bad = await call("POST", `/v1/jobs/${created.json.job.id}/resume`, { limits: { maxMinutes: 241 } });
    expect(bad.status).toBe(400);
    expect(h.app.job(created.json.job.id).state).toBe("failed");
    expect(h.store.listEvents(created.json.job.id).map(e => e.type)).not.toContain("manual_resume");
  });
});

describe("revise and versions", () => {
  it("revises from the current version into a new workdir, keeps the old one, and can roll back", async () => {
    const h = harness();
    const { call } = await boot(h);
    h.scenario(okScenario());
    const c = await call("POST", "/v1/videos", { topic: "Versioned video" });
    await h.app.idle();
    const sceneId = c.json.scene.id;
    const v1 = c.json.version.id;

    h.scenario({ ...okScenario(), final: '```json\n{"video":"{{cwd}}/videos/demo/renders/video.mp4","project_dir":"{{cwd}}/videos/demo","change_class":"visual","frames_changed":[3],"notes":"tint"}\n```' });
    const r = await call("POST", `/v1/scenes/${sceneId}/revise`, { instructions: "make frame 3 darker", frames: [3] });
    expect(r.status).toBe(201);
    await h.app.idle();
    const job = h.app.job(r.json.job.id);
    expect(job.state).toBe("succeeded");
    const v2 = h.app.version(r.json.version.id);
    expect(v2.parentVersionId).toBe(v1);
    expect(v2.workdir).not.toBe(h.app.version(v1).workdir);
    expect(h.app.scene(sceneId).currentVersionId).toBe(v2.id);
    expect(h.app.version(v1).outputs.video).toBeTruthy();
    const back = await call("POST", `/v1/scenes/${sceneId}/use`, { versionId: v1 });
    expect(back.json.scene.currentVersionId).toBe(v1);
  });

  it("marks a restructure request as rejected instead of failing", async () => {
    const h = harness();
    const { call } = await boot(h);
    h.scenario(okScenario());
    const c = await call("POST", "/v1/videos", { topic: "Restructure me" });
    await h.app.idle();
    h.scenario({ steps: [], final: '```json\n{"change_class":"restructure","project_dir":"{{cwd}}/videos/demo","notes":"needs a new video"}\n```' });
    const r = await call("POST", `/v1/scenes/${c.json.scene.id}/revise`, { instructions: "rewrite everything" });
    await h.app.idle();
    expect(h.app.job(r.json.job.id).state).toBe("rejected");
    expect(h.app.scene(c.json.scene.id).currentVersionId).toBe(c.json.version.id);
  });

  it("preview job (render:false) leaves no video; render job finishes it natively", async () => {
    const h = harness();
    h.scenario({ writeFiles: { "videos/demo/caption_groups.json": "[]" }, final: '```json\n{"video":"","project_dir":"{{cwd}}/videos/demo","duration_s":20}\n```' });
    const { app } = h;
    const { job, version } = app.createVideo({ topic: "Preview only" }, { render: false });
    await app.idle();
    expect(app.job(job.id).state).toBe("succeeded");
    expect(app.version(version.id).outputs.video).toBeNull();
    const pipe = app.d.pipelines["hyperframes-explainer"]!;
    pipe.render = async pd => { const v = join(pd, "renders/video.mp4"); mkdirSync(join(pd, "renders"), { recursive: true }); writeFileSync(v, "v"); return { video: v, durationSec: 20 }; };
    const rj = app.renderVersion(version.id);
    await app.idle();
    expect(app.job(rj.id).state).toBe("succeeded");
    expect(app.version(version.id).outputs.video).toMatch(/video\.mp4$/);
  });
});

describe("project stitch", () => {
  it("stitches scenes in timeline order and refuses when a scene has no video", async () => {
    const stitched: string[][] = [];
    const h = harness({ stitch: async (_p, scenes, outDir) => { stitched.push(scenes.map(s => s.scene.title)); return { video: join(outDir, "final.mp4"), durationSec: 61 }; } });
    const { app } = h;
    const p = app.createProject({ name: "Two parts" });
    const s1 = app.addScene(p.id, { title: "Intro", topic: "Intro scene" });
    const s2 = app.addScene(p.id, { title: "Body", topic: "Body scene" });
    expect(() => app.stitch(p.id)).toThrow(/without a rendered video/);
    h.scenario(okScenario());
    app.buildScene(s1.id); await app.idle();
    app.buildScene(s2.id); await app.idle();
    app.setTimeline(p.id, { order: [s2.id, s1.id], transitions: { [s1.id]: "fade" } });
    const job = app.stitch(p.id);
    await app.idle();
    expect(app.job(job.id).state).toBe("succeeded");
    expect(stitched).toEqual([["Body", "Intro"]]);
    expect(app.project(p.id).final?.state).toBe("done");
    expect(() => app.setTimeline(p.id, { order: [s1.id] })).toThrow(/exactly/);
  });
});

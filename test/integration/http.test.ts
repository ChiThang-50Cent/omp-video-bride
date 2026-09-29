import { mkdirSync, writeFileSync } from "node:fs";
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
    expect((await fetch(`${base}/v1/health`)).status).toBe(200);
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

  it("creates a video, exposes catalog, and returns the finished job with its version", async () => {
    const { h, call } = await boot();
    h.scenario(okScenario());
    const cat = await call("GET", "/v1/catalog");
    expect(cat.json.pipelines[0].options.voice).toContain("am_michael");
    const c = await call("POST", "/v1/videos", { topic: "How TCP works", metadata: { chat: 42 } });
    expect(c.status).toBe(201);
    await h.app.idle();
    const j = await call("GET", `/v1/jobs/${c.json.job.id}?events=1`);
    expect(j.json.job.state).toBe("succeeded");
    expect(j.json.job.metadata).toEqual({ chat: 42 });
    expect(j.json.version.outputs.video).toMatch(/video\.mp4$/);
    expect(j.json.events.map((e: any) => e.type)).toEqual(expect.arrayContaining(["start", "succeed"]));
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

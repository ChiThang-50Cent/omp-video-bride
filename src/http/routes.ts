import { z } from "zod";
import type { App } from "../app/app.ts";
import { invalid } from "../app/errors.ts";
import { JOB_STATES, type Job } from "../core/job.ts";
import type { Store } from "../ports/store.ts";
import { Router } from "./router.ts";

const created = (o: Record<string, unknown>) => ({ __status: 201, ...o });
const Meta = z.record(z.string(), z.unknown()).optional();
const Limits = z.object({ maxMinutes: z.number().positive().max(240).optional(), maxUsd: z.number().positive().max(50).optional() }).optional();
const JobOpts = { metadata: Meta, limits: Limits, approve: z.literal("storyboard").optional(), render: z.boolean().optional() };
const SceneIn = { title: z.string().max(120).optional(), topic: z.string().min(3).max(1000), brief: z.string().max(4000).optional(), durationSec: z.number().min(10).max(300).optional(), assets: z.array(z.string()).optional(), findAssets: z.boolean().optional() };

export function buildRouter(app: App, store: Store, health: () => Record<string, unknown>): Router {
  const r = new Router();

  r.route("GET", "/v1/health", () => ({ ok: true, ...health() }));
  r.route("GET", "/v1/catalog", async () => ({ pipelines: await Promise.all(Object.values(app.d.pipelines).map(p => p.catalog())) }));

  // --- one-shot video
  r.route("POST", "/v1/videos", ({ body }) => {
    const { metadata, limits, approve, render, ...rest } = body;
    return created(app.createVideo(rest, { metadata, limits, approve, render }));
  }, { schema: z.object({ ...SceneIn, spec: z.unknown().optional(), ...JobOpts }) });

  // --- projects
  r.route("POST", "/v1/projects", ({ body }) => created({ project: app.createProject(body) }), {
    schema: z.object({ name: z.string().min(1).max(120), pipeline: z.string().optional(), spec: z.unknown().optional(), brief: z.string().max(4000).optional(), brand: z.object({ logoAsset: z.string().optional(), colors: z.array(z.string()).optional(), fonts: z.array(z.string()).optional() }).optional() }),
  });
  r.route("GET", "/v1/projects", () => ({ projects: store.listProjects() }));
  r.route("GET", "/v1/projects/:id", ({ params }) => {
    const project = app.project(params.id!);
    const scenes = store.listScenes(project.id).map(s => ({ ...s, versions: store.listVersions(s.id) }));
    return { project, scenes, assets: store.listAssets(project.id) };
  });
  r.route("PATCH", "/v1/projects/:id", ({ params, body }) => ({ project: app.updateProject(params.id!, body) }), {
    schema: z.object({ name: z.string().optional(), spec: z.record(z.string(), z.unknown()).optional(), brief: z.string().optional(), brand: z.object({ logoAsset: z.string().optional(), colors: z.array(z.string()).optional(), fonts: z.array(z.string()).optional() }).optional() }),
  });
  r.route("DELETE", "/v1/projects/:id", ({ params }) => { app.deleteProject(params.id!); });

  // --- scenes
  r.route("POST", "/v1/projects/:id/scenes", ({ params, body }) => created({ scene: app.addScene(params.id!, body) }), { schema: z.object(SceneIn) });
  r.route("GET", "/v1/scenes/:id", ({ params }) => ({ scene: app.scene(params.id!), versions: store.listVersions(params.id!) }));
  r.route("DELETE", "/v1/scenes/:id", ({ params }) => { app.deleteScene(params.id!); });
  r.route("POST", "/v1/scenes/:id/build", ({ params, body }) => created(app.buildScene(params.id!, body)), { schema: z.object(JobOpts) });
  r.route("POST", "/v1/scenes/:id/revise", ({ params, body }) => {
    const { metadata, limits, render, ...i } = body;
    return created(app.reviseScene(params.id!, i, { metadata, limits, render }));
  }, { schema: z.object({ instructions: z.string().min(3).max(4000), frames: z.array(z.number().int()).optional(), durationSec: z.number().min(10).max(300).optional(), fromVersionId: z.string().optional(), metadata: Meta, limits: Limits, render: z.boolean().optional() }) });
  r.route("POST", "/v1/scenes/:id/use", ({ params, body }) => ({ scene: app.useVersion(params.id!, body.versionId) }), { schema: z.object({ versionId: z.string() }) });

  r.route("GET", "/v1/versions/:id", ({ params }) => ({ version: app.version(params.id!) }));
  r.route("POST", "/v1/versions/:id/render", ({ params, body }) => created({ job: app.renderVersion(params.id!, body) }), { schema: z.object({ metadata: Meta }) });

  // --- assets (raw body)
  r.route("POST", "/v1/projects/:id/assets", async ({ params, query, raw }) => {
    const name = query.get("name");
    if (!name) throw invalid("query parameter name is required");
    const data = await raw();
    if (!data.length) throw invalid("empty body");
    const res = app.addAsset(params.id!, { name, data, tags: query.get("tags")?.split(",").filter(Boolean), source: query.get("source") ?? undefined, license: query.get("license") ?? undefined });
    return res.duplicate ? { asset: res.asset, duplicate: true } : created({ asset: res.asset, duplicate: false });
  }, { raw: true });
  r.route("GET", "/v1/projects/:id/assets", ({ params }) => ({ assets: store.listAssets(app.project(params.id!).id) }));
  r.route("DELETE", "/v1/projects/:id/assets/:aid", ({ params }) => { app.deleteAsset(params.id!, params.aid!); });

  // --- timeline / stitch
  r.route("PUT", "/v1/projects/:id/timeline", ({ params, body }) => ({ project: app.setTimeline(params.id!, body) }), {
    schema: z.object({ order: z.array(z.string()).optional(), transitions: z.record(z.string(), z.enum(["cut", "fade"])).optional() }),
  });
  r.route("POST", "/v1/projects/:id/stitch", ({ params, body }) => created({ job: app.stitch(params.id!, body) }), { schema: z.object({ metadata: Meta }) });

  // --- jobs
  r.route("GET", "/v1/jobs", ({ query }) => {
    const rawState = query.get("state");
    let state: Job["state"] | undefined;
    if (rawState !== null) {
      if (!(JOB_STATES as readonly string[]).includes(rawState)) throw invalid(`state must be one of: ${JOB_STATES.join(", ")}`);
      state = rawState as Job["state"];
    }
    const rawLimit = query.get("limit");
    let limit = 50;
    if (rawLimit !== null) {
      const parsed = Number(rawLimit);
      if (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) throw invalid("limit must be an integer from 1 to 500");
      limit = parsed;
    }
    return { jobs: store.listJobs({ state, projectId: query.get("project") ?? undefined, limit }) };
  });
  r.route("GET", "/v1/jobs/:id", ({ params, query }) => {
    const job = app.job(params.id!);
    const version = job.refs.versionId ? store.getVersion(job.refs.versionId) : undefined;
    return { job, version, events: query.get("events") ? store.listEvents(job.id) : undefined };
  });
  r.route("POST", "/v1/jobs/:id/approve", ({ params, body }) => ({ job: app.approve(params.id!, body.notes) }), { schema: z.object({ notes: z.string().max(4000).optional() }) });
  r.route("POST", "/v1/jobs/:id/cancel", ({ params, body }) => ({ job: app.cancel(params.id!, body.reason) }), { schema: z.object({ reason: z.string().optional() }) });
  return r;
}

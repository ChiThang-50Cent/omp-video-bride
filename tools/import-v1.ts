// Imports finished v1 jobs (<dir>/<date>-<id>/job.json) into the v2 database so they can be listed, revised and stitched.
// Files stay where they are. Usage: node tools/import-v1.ts <v1-jobs-dir> [--dry-run]
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SqliteStore } from "../src/adapters/store-sqlite/sqlite-store.ts";
import { loadConfig } from "../src/config.ts";
import { slug } from "../src/core/entities.ts";
import { newJob, transition } from "../src/core/job.ts";

const [src, flag] = process.argv.slice(2);
if (!src) { console.error("usage: node tools/import-v1.ts <v1-jobs-dir> [--dry-run]"); process.exit(2); }
const cfg = loadConfig();
const store = new SqliteStore(join(cfg.dataDir, "bridge.db"));
const dry = flag === "--dry-run";

interface V1 { id: string; status: string; parentId?: string; rootId?: string; topic: string; style?: string; format?: string; voice?: string; instructions?: string; createdAt: string; finishedAt?: string; result?: { video?: string; project_dir?: string; duration_s?: number; notes?: string } }
const jobs: V1[] = readdirSync(src).map(d => join(src, d, "job.json")).filter(existsSync).map(f => JSON.parse(readFileSync(f, "utf8")) as V1)
  .filter(j => j.status === "done" && j.result?.video && existsSync(j.result.video)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const roots = new Map<string, V1[]>();
for (const j of jobs) roots.set(j.rootId ?? j.id, [...(roots.get(j.rootId ?? j.id) ?? []), j]);

let n = 0;
for (const [root, chain] of roots) {
  const first = chain[0]!;
  const pid = `v1-${slug(first.topic)}-${root.slice(-4)}`;
  if (store.getProject(pid)) continue;
  const sid = `scn_v1${root.slice(-6)}`;
  const spec = { style: first.style ?? "auto", format: first.format ?? "landscape", voice: first.voice ?? "am_michael" };
  if (dry) { console.log(`would import ${pid}: ${chain.length} version(s)`); continue; }
  store.tx(() => {
    store.putProject({ id: pid, name: first.topic, pipeline: "hyperframes-explainer", spec, brief: "", brand: {}, timeline: { order: [sid], transitions: {} }, final: null, createdAt: first.createdAt });
    const scene = { id: sid, projectId: pid, n: 1, title: first.topic, topic: first.topic, brief: "", durationSec: 50, assetRefs: [], findAssets: false, currentVersionId: null, createdAt: first.createdAt };
    store.putScene(scene);
    let parent: string | null = null;
    chain.forEach((j, i) => {
      const jobId = `job_v1${j.id.slice(-6)}`;
      const vid = `ver_v1${j.id.slice(-6)}`;
      const at = j.finishedAt ?? j.createdAt;
      let job = newJob({ id: jobId, kind: i === 0 ? "build" : "revise", pipeline: "hyperframes-explainer", input: { imported: true, instructions: j.instructions }, refs: { projectId: pid, sceneId: sid, versionId: vid }, now: j.createdAt });
      job = transition(transition(job, { type: "start" }, j.createdAt), { type: "succeed", result: { versionId: vid, video: j.result!.video, durationSec: j.result!.duration_s ?? null, notes: j.result!.notes ?? null } }, at);
      store.insertJob(job);
      const projectDir = j.result!.project_dir ?? null;
      store.putVersion({ id: vid, sceneId: sid, number: i + 1, parentVersionId: parent, jobId, workdir: join(src, j.id), projectDir, state: "ready", outputs: { video: j.result!.video!, contactSheets: [], captionsGroups: null }, durationSec: j.result!.duration_s ?? null, notes: j.result!.notes ?? j.instructions ?? null, createdAt: j.createdAt });
      parent = vid;
    });
    store.putScene({ ...scene, currentVersionId: parent });
  });
  n++;
}
console.log(dry ? "dry run" : `imported ${n} project(s) from ${jobs.length} finished job(s)`);
store.close();

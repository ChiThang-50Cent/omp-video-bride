// Projects: one video made of several scenes. Each scene is an ordinary omp job (so queueing,
// resume, cancel and revise all apply); the project fixes the look (style/format/voice/audience/
// tone) for every scene, holds shared assets, and stitches the finished scenes into final.mp4.
//
// Layout (under JOBS_DIR so Hermes sees it read-only at /videos/projects/…):
//   projects/<id>/project.json
//   projects/<id>/assets/            user uploads (via API) + assets/found/ (AI-sourced, SOURCES.md)
//   projects/<id>/scenes/<NN>-<slug>/video.mp4, contact-sheet.jpg, scene.json   (latest version)
//   projects/<id>/final.mp4
import { spawn } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_UPLOAD = 200 * 1024 * 1024;
const ASSET_NAME = /^[\w][\w.\-]{0,120}$/;
const slug = s => String(s).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d")
  .replace(/[^a-z0-9\s-]/g, "").trim().replace(/[\s-]+/g, "-").slice(0, 48) || "untitled";

export function createProjects({ jobsDir, send, readBody, newJob, jobs, queue }) {
  const root = join(jobsDir, "projects");
  mkdirSync(root, { recursive: true });
  const projects = new Map();
  for (const id of readdirSync(root)) {
    const f = join(root, id, "project.json");
    if (existsSync(f)) projects.set(id, JSON.parse(readFileSync(f, "utf8")));
  }
  const dirOf = p => join(root, p.id);
  const save = p => writeFileSync(join(dirOf(p), "project.json"), JSON.stringify(p, null, 2));
  const sceneDir = (p, s) => join(dirOf(p), "scenes", `${String(s.n).padStart(2, "0")}-${s.slug}`);
  const listAssets = p => {
    const out = [];
    const walk = (d, rel) => {
      if (!existsSync(d)) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name), rel + e.name + "/");
        else if (e.name !== "SOURCES.md") out.push({ name: rel + e.name, bytes: statSync(join(d, e.name)).size });
      }
    };
    walk(join(dirOf(p), "assets"), "");
    return out;
  };
  // A stitch while the project has a stitch in flight would race on final.mp4.
  const stitching = new Set();

  const view = p => ({
    ...p,
    dir: dirOf(p),
    assets: listAssets(p),
    scenes: p.order.map(n => p.scenes.find(s => s.n === n)).filter(Boolean).map(s => ({
      ...s,
      dir: sceneDir(p, s),
      video: s.status === "done" ? join(sceneDir(p, s), "video.mp4") : null,
      contact_sheet: s.status === "done" ? join(sceneDir(p, s), "contact-sheet.jpg") : null,
    })),
  });

  // Prompt block telling omp which project assets exist and whether it may source its own.
  function assetsPrompt(job) {
    const p = job.projectId && projects.get(job.projectId);
    if (!p) return "none (no project). You may still draw visuals in code (SVG/CSS/canvas).";
    const dir = join(dirOf(p), "assets");
    const all = listAssets(p).map(a => a.name);
    const picked = job.assets === "all" ? all : (job.assets ?? []).filter(a => all.includes(a));
    const lines = [`Project assets dir: ${dir}`];
    lines.push(picked.length ? `Use these project assets where they fit (required if the brief mentions them): ${picked.join(", ")}` : "No project assets were selected for this scene.");
    const others = all.filter(a => !picked.includes(a));
    if (others.length) lines.push(`Other project assets (use only if clearly useful): ${others.join(", ")}`);
    lines.push(job.findAssets
      ? `You MAY source extra images: follow the skill's Assets section; save them to ${dir}/found/ and log each in ${dir}/found/SOURCES.md.`
      : "Do NOT download images from the internet. Missing visuals must be drawn in code (SVG/CSS/canvas).");
    return lines.join("\n");
  }

  // Called when any job ends. Publishes a scene job's output into the project's scene dir.
  function onJobFinished(job) {
    const p = job.projectId && projects.get(job.projectId);
    if (!p) return;
    const s = p.scenes.find(x => x.n === job.scene);
    if (!s) return;
    // An older revision finishing late must not overwrite a newer one.
    if (s.jobId !== job.id && Date.parse(jobs.get(s.jobId)?.createdAt ?? 0) > Date.parse(job.createdAt)) return;
    if (job.status === "done") {
      const d = sceneDir(p, s);
      mkdirSync(d, { recursive: true });
      copyFileSync(job.result.video, join(d, "video.mp4"));
      if (job.result.contact_sheet && existsSync(job.result.contact_sheet)) copyFileSync(job.result.contact_sheet, join(d, "contact-sheet.jpg"));
      writeFileSync(join(d, "scene.json"), JSON.stringify({ jobId: job.id, topic: s.topic, duration_s: job.result.duration_s, publishedAt: new Date().toISOString() }, null, 2));
      Object.assign(s, { jobId: job.id, status: "done", duration_s: job.result.duration_s, error: null });
      // style "auto" is decided by the first finished scene, then locked for the rest.
      if (p.style === "auto" && job.result.style) p.style = job.result.style;
      p.final = { ...p.final, stale: true };
    } else if (s.jobId === job.id && s.status !== "done") {
      Object.assign(s, { status: job.status, error: job.error ?? null });
    } else if (s.jobId === job.id) {
      // A failed revision leaves the published scene as is.
      s.lastRevisionError = `${job.id}: ${job.status}${job.error ? ` (${job.error})` : ""}`;
    }
    save(p);
  }

  function stitch(p, order) {
    const scenes = order.map(n => p.scenes.find(s => s.n === n));
    const inputs = scenes.map(s => join(sceneDir(p, s), "video.mp4"));
    const dir = dirOf(p);
    const list = join(dir, ".concat.txt");
    writeFileSync(list, inputs.map(f => `file '${f.replaceAll("'", "'\\''")}'`).join("\n") + "\n");
    const tmp = join(dir, ".final.tmp.mp4");
    const log = createWriteStream(join(dir, "stitch.log"));
    const ff = args => new Promise(r => {
      const c = spawn("ffmpeg", ["-hide_banner", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
      c.stderr.pipe(log, { end: false });
      c.on("close", r);
    });
    stitching.add(p.id);
    p.final = { status: "running", scenes: order, startedAt: new Date().toISOString() };
    save(p);
    (async () => {
      // Scenes come from the same renderer and format, so a stream copy normally works;
      // re-encode only when codec parameters differ.
      let code = await ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", tmp]);
      if (code !== 0) {
        const n = inputs.length;
        const filter = inputs.map((_, i) => `[${i}:v][${i}:a]`).join("") + `concat=n=${n}:v=1:a=1[v][a]`;
        code = await ff([...inputs.flatMap(f => ["-i", f]), "-filter_complex", filter, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", tmp]);
      }
      log.end();
      stitching.delete(p.id);
      rmSync(list, { force: true });
      if (code === 0) {
        renameSync(tmp, join(dir, "final.mp4"));
        const duration = scenes.reduce((a, s) => a + (s.duration_s ?? 0), 0);
        p.final = { status: "done", path: join(dir, "final.mp4"), scenes: order, duration_s: Math.round(duration * 10) / 10, finishedAt: new Date().toISOString(), stale: false };
      } else {
        rmSync(tmp, { force: true });
        p.final = { status: "failed", scenes: order, error: `ffmpeg exited ${code}; see ${join(dir, "stitch.log")}`, finishedAt: new Date().toISOString() };
      }
      save(p);
    })();
  }

  async function handle(req, res, url) {
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); // ["projects", id?, sub?, key?]
    if (parts[0] !== "projects") return false;
    const [, id, sub, key] = parts;

    if (!id) {
      if (req.method === "GET") {
        send(res, 200, [...projects.values()].map(p => ({ id: p.id, name: p.name, style: p.style, format: p.format, scenes: p.order.length, final: p.final?.status ?? null, createdAt: p.createdAt })));
        return true;
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        const name = String(body.name ?? "").trim();
        if (!name || name.length > 200) return send(res, 400, { error: "name required (<=200 chars)" }), true;
        // Validate the shared spec by building a throwaway job spec (no job is created).
        const check = newJob({ topic: "spec check", ...body }, {}, { dryRun: true });
        if (check.error) return send(res, 400, check), true;
        let pid = slug(name);
        for (let i = 2; projects.has(pid); i++) pid = `${slug(name)}-${i}`;
        const { style, format, voice, audience, tone } = check.job;
        const p = { id: pid, name, style, format, voice, audience, tone, brief: String(body.brief ?? "").slice(0, 8000), scenes: [], order: [], nextN: 1, final: null, createdAt: new Date().toISOString() };
        mkdirSync(join(root, pid, "assets"), { recursive: true });
        mkdirSync(join(root, pid, "scenes"), { recursive: true });
        projects.set(pid, p);
        save(p);
        send(res, 201, view(p));
        return true;
      }
    }

    const p = projects.get(id);
    if (!p) return send(res, 404, { error: "project not found" }), true;

    if (!sub && req.method === "GET") return send(res, 200, view(p)), true;
    if (!sub && req.method === "PATCH") {
      // Only name/brief/audience/tone are editable: style/format/voice changes would break stitching of existing scenes.
      const body = await readBody(req);
      for (const k of ["name", "brief", "audience", "tone"]) if (body[k] != null) p[k] = String(body[k]).slice(0, k === "brief" ? 8000 : 200);
      save(p);
      return send(res, 200, view(p)), true;
    }

    if (sub === "assets") {
      if (req.method === "POST" && !key) {
        // Raw upload: POST /projects/<id>/assets?name=logo.png  (body = file bytes)
        const name = String(url.searchParams.get("name") ?? "");
        if (!ASSET_NAME.test(name) || name.includes("..")) return send(res, 400, { error: "?name= must be a plain file name ([A-Za-z0-9_.-])" }), true;
        const dest = join(dirOf(p), "assets", name);
        const tmp = dest + ".part";
        let size = 0, aborted = false;
        const out = createWriteStream(tmp);
        await new Promise((resolve, reject) => {
          req.on("data", c => {
            size += c.length;
            if (size > MAX_UPLOAD && !aborted) { aborted = true; out.destroy(); req.destroy(); resolve(); }
          });
          req.pipe(out);
          out.on("finish", resolve);
          out.on("error", reject);
        });
        if (aborted || !size) {
          rmSync(tmp, { force: true });
          return send(res, 400, { error: aborted ? `file too large (> ${MAX_UPLOAD} bytes)` : "empty body" }), true;
        }
        renameSync(tmp, dest);
        return send(res, 201, { name, bytes: size, path: dest }), true;
      }
      if (req.method === "GET" && !key) return send(res, 200, listAssets(p)), true;
      if (req.method === "DELETE" && key) {
        const rel = parts.slice(3).join("/");
        if (rel.includes("..")) return send(res, 400, { error: "bad name" }), true;
        const f = join(dirOf(p), "assets", rel);
        if (!existsSync(f)) return send(res, 404, { error: "asset not found" }), true;
        rmSync(f);
        return send(res, 200, { deleted: rel }), true;
      }
    }

    if (sub === "scenes") {
      if (req.method === "POST" && !key) {
        const body = await readBody(req);
        const n = p.nextN;
        const assets = body.assets === "all" ? "all" : Array.isArray(body.assets) ? body.assets.map(String) : [];
        // The project fixes the look; the scene brings topic, brief and length.
        const r = newJob({
          ...body,
          style: p.style, format: p.format, voice: p.voice, audience: p.audience, tone: p.tone,
          brief: [p.brief && `Project context: ${p.brief}`, `This is scene ${n} of the multi-scene video "${p.name}". Keep it self-contained but consistent with the other scenes; no generic intro/outro unless the brief asks for one.`, body.brief].filter(Boolean).join("\n"),
        }, { projectId: p.id, scene: n, assets, findAssets: Boolean(body.findAssets) });
        if (r.error) return send(res, 400, r), true;
        const s = { n, slug: slug(body.title ?? body.topic), title: String(body.title ?? body.topic).slice(0, 200), topic: r.job.topic, jobId: r.job.id, status: "queued", duration_s: null };
        p.scenes.push(s);
        const at = Number.isInteger(body.position) ? Math.max(0, Math.min(p.order.length, body.position - 1)) : p.order.length;
        p.order.splice(at, 0, n);
        p.nextN++;
        save(p);
        return send(res, 202, { project: p.id, scene: n, position: at + 1, jobId: r.job.id, queuePosition: queue.indexOf(r.job) + 1 }), true;
      }
      if (req.method === "DELETE" && key) {
        const n = Number(key);
        const s = p.scenes.find(x => x.n === n);
        if (!s) return send(res, 404, { error: "scene not found" }), true;
        const j = jobs.get(s.jobId);
        if (j && (j.status === "running" || j.status === "queued")) return send(res, 409, { error: `scene job ${j.id} is ${j.status}; cancel it first` }), true;
        rmSync(sceneDir(p, s), { recursive: true, force: true });
        p.scenes = p.scenes.filter(x => x.n !== n);
        p.order = p.order.filter(x => x !== n);
        p.final = p.final && { ...p.final, stale: true };
        save(p);
        return send(res, 200, view(p)), true;
      }
    }

    if (sub === "order" && req.method === "POST") {
      const body = await readBody(req);
      const order = Array.isArray(body.scenes) ? body.scenes.map(Number) : [];
      const known = p.scenes.map(s => s.n).sort((a, b) => a - b);
      if ([...order].sort((a, b) => a - b).join() !== known.join()) return send(res, 400, { error: `scenes must be a permutation of ${known}` }), true;
      p.order = order;
      p.final = p.final && { ...p.final, stale: true };
      save(p);
      return send(res, 200, view(p)), true;
    }

    if (sub === "stitch" && req.method === "POST") {
      const body = await readBody(req);
      if (stitching.has(p.id)) return send(res, 409, { error: "a stitch is already running" }), true;
      const order = Array.isArray(body.scenes) ? body.scenes.map(Number) : p.order;
      const missing = order.filter(n => p.scenes.find(s => s.n === n)?.status !== "done");
      if (!order.length) return send(res, 400, { error: "no scenes" }), true;
      if (missing.length) return send(res, 409, { error: `scenes not finished: ${missing}` }), true;
      stitch(p, order);
      return send(res, 202, { project: p.id, final: p.final }), true;
    }

    send(res, 404, { error: "not found" });
    return true;
  }

  return { handle, onJobFinished, assetsPrompt };
}

// HTTP bridge: Hermes (docker) -> omp (host) video jobs.
// Jobs:     POST /jobs, GET /jobs, GET /jobs/:id, POST /jobs/:id/revise, POST /jobs/:id/cancel, GET /styles
// Projects: POST|GET /projects, GET|PATCH /projects/:id, POST /projects/:id/scenes, DELETE /projects/:id/scenes/:n,
//           POST /projects/:id/order, POST /projects/:id/stitch, POST|GET /projects/:id/assets, DELETE /projects/:id/assets/:name
// Auth: "Authorization: Bearer <token>". One job runs at a time; the rest queue.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { cpSync, createWriteStream, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { createProjects } from "./projects.mjs";

const HOST = process.env.BRIDGE_HOST ?? "172.22.0.1";
const PORT = Number(process.env.BRIDGE_PORT ?? 8765);
const TOKEN = readFileSync(process.env.BRIDGE_TOKEN_FILE ?? new URL("./.token", import.meta.url), "utf8").trim();
const JOBS_DIR = process.env.BRIDGE_JOBS_DIR ?? "/home/thangnc/general/omp-videos";
const OMP = process.env.OMP_BIN ?? "/home/thangnc/.local/bin/omp";
const DEFAULT_MODEL = process.env.BRIDGE_DEFAULT_MODEL ?? "openai-codex/gpt-5.6-luna";
const DEFAULT_THINKING = process.env.BRIDGE_DEFAULT_THINKING ?? "high";
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);
const MODEL_RE = /^[\w.\-/:]{1,100}$/;
const PROMPT_TEMPLATE = readFileSync(new URL("./prompt.md", import.meta.url), "utf8");
const RESUME_PROMPT = "The job was interrupted: the bridge restarted and killed this session's processes, including background audio, workers, snapshots and render. Continue the SAME job from where it stopped. Inspect PROJECT_DIR first and reuse everything already on disk that is complete: do not redo finished phases, do not overwrite finished frame files, and rerun only steps whose outputs are missing or partial. Background processes are gone; restart any you still need. Finish with the same final JSON block as originally requested.";
const REVISE_TEMPLATE = readFileSync(new URL("./revise.md", import.meta.url), "utf8");
const PRESETS_DIR = join(homedir(), ".pi/agent/skills/hyperframes-creative/frame-presets");
// Read per request so `skills update` adding presets needs no bridge restart.
const presets = () => readdirSync(PRESETS_DIR, { withFileTypes: true }).filter(d => d.isDirectory() && existsSync(join(PRESETS_DIR, d.name, "FRAME.md"))).map(d => d.name).sort();
const FORMATS = { landscape: "1920x1080", portrait: "1080x1920", square: "1080x1080" };
// Narration is English: Kokoro American (a*) and British (b*) voices.
const ENGLISH_VOICES = new Set(["af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis"]);
// Our pipeline skill (skill://omp-video-pipeline). Kept outside ~/.agents/skills, which `skills update` overwrites.
const SKILLS_DIR = new URL("./skills", import.meta.url).pathname;

mkdirSync(JOBS_DIR, { recursive: true });
const jobs = new Map();
const queue = [];
let running = null;
let runningChild = null;

// Restore job records; queued/running ones are resumed below.
for (const id of readdirSync(JOBS_DIR)) {
  const f = join(JOBS_DIR, id, "job.json");
  if (!existsSync(f)) continue;
  const job = JSON.parse(readFileSync(f, "utf8"));
  jobs.set(id, job);
}

// Resume interrupted work after a bridge restart/crash. Queued jobs keep their place (by createdAt);
// a job that was running continues its own omp session (`--continue`) instead of starting over.
// Capped so a job that keeps killing the bridge cannot loop forever.
const MAX_RESUMES = 2;
for (const job of [...jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
  if (job.status !== "running" && job.status !== "queued") continue;
  if (job.status === "running") {
    job.resumes = (job.resumes ?? 0) + 1;
    if (job.cancelRequested || job.resumes > MAX_RESUMES) {
      Object.assign(job, job.cancelRequested ? { status: "cancelled", error: "cancelled by request" } : { status: "failed", error: `bridge restarted ${job.resumes} times during this job` });
      writeFileSync(join(JOBS_DIR, job.id, "job.json"), JSON.stringify(job, null, 2));
      continue;
    }
    job.resume = existsSync(join(JOBS_DIR, job.id, "sessions")) && readdirSync(join(JOBS_DIR, job.id, "sessions")).some(f => f.endsWith(".jsonl"));
  }
  job.status = "queued";
  queue.push(job);
}

// Validate a new-video request and queue it. `extra` carries project/scene links; dryRun only validates.
function newJob(body, extra = {}, { dryRun = false } = {}) {
  const topic = String(body.topic ?? "").trim();
  const model = String(body.model ?? DEFAULT_MODEL);
  const thinking = String(body.thinking ?? DEFAULT_THINKING);
  const workerModel = String(body.workerModel ?? model);
  const workerThinking = String(body.workerThinking ?? thinking);
  if (!topic || topic.length > 2000) return { error: "topic required (<=2000 chars)" };
  if (!MODEL_RE.test(model) || !MODEL_RE.test(workerModel)) return { error: "invalid model" };
  if (!THINKING.has(thinking) || !THINKING.has(workerThinking)) return { error: `thinking must be one of ${[...THINKING]}` };
  const spec = {
    style: String(body.style ?? "auto"),
    format: String(body.format ?? "landscape"),
    voice: String(body.voice ?? "am_michael"),
    durationSec: Number(body.durationSec ?? 50),
    audience: String(body.audience ?? "developers").slice(0, 200),
    tone: String(body.tone ?? "clear, friendly, technical").slice(0, 200),
  };
  const styles = presets();
  if (spec.style !== "auto" && !styles.includes(spec.style)) return { error: `style must be "auto" or one of ${styles}` };
  if (!FORMATS[spec.format]) return { error: `format must be one of ${Object.keys(FORMATS)}` };
  if (!ENGLISH_VOICES.has(spec.voice)) return { error: `voice must be one of ${[...ENGLISH_VOICES]}` };
  if (!(spec.durationSec >= 15 && spec.durationSec <= 180)) return { error: "durationSec must be 15–180" };
  const job = { id: new Date().toISOString().slice(0, 10) + "-" + randomUUID().slice(0, 8), status: "queued", topic, brief: String(body.brief ?? "").slice(0, 20000), ...spec, ...extra, model, thinking, workerModel, workerThinking, createdAt: new Date().toISOString() };
  if (dryRun) return { job };
  mkdirSync(join(JOBS_DIR, job.id));
  jobs.set(job.id, job);
  save(job);
  queue.push(job);
  pump();
  return { job };
}

const save = job => writeFileSync(join(JOBS_DIR, job.id, "job.json"), JSON.stringify(job, null, 2));

function authorized(req) {
  const got = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, ""));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

function send(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 64_000) reject(new Error("body too large")); });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch (e) { reject(e); } });
  });
}

function pump() {
  if (running || !queue.length) return;
  const job = queue.shift();
  running = job;
  const dir = join(JOBS_DIR, job.id);
  const prompt = job.parentId
    ? REVISE_TEMPLATE.replaceAll("{{PROJECT_DIR}}", job.projectDir)
        .replaceAll("{{PARENT}}", job.parentId)
        .replaceAll("{{INSTRUCTIONS}}", job.instructions)
        .replaceAll("{{FRAMES}}", job.frames?.length ? job.frames.join(", ") : "(not specified — infer from the instructions)")
        .replaceAll("{{ASSETS}}", projectsApi.assetsPrompt(job))
        .replaceAll("{{DURATION}}", job.durationSec ? `change to ~${job.durationSec}s (currently ${job.currentDurationSec ?? "?"}s)` : `keep (currently ${job.currentDurationSec ?? "?"}s)`)
    : PROMPT_TEMPLATE.replaceAll("{{TOPIC}}", job.topic)
        .replaceAll("{{BRIEF}}", job.brief || "(none — derive from topic)")
        .replaceAll("{{STYLE}}", job.style ?? "auto")
        .replaceAll("{{FORMAT}}", `${job.format ?? "landscape"} ${FORMATS[job.format ?? "landscape"]}`)
        .replaceAll("{{VOICE}}", job.voice ?? "am_michael")
        .replaceAll("{{DURATION}}", String(job.durationSec ?? 50))
        .replaceAll("{{AUDIENCE}}", job.audience ?? "developers")
        .replaceAll("{{TONE}}", job.tone ?? "clear, friendly, technical")
        .replaceAll("{{ASSETS}}", projectsApi.assetsPrompt(job));
  const resuming = job.resume;
  job.resume = false;
  Object.assign(job, { status: "running", startedAt: resuming && job.startedAt ? job.startedAt : new Date().toISOString() });
  save(job);

  // Frame workers are `task` subagents; without this overlay they use the host's modelRoles.task
  // (luna:max) regardless of the job's thinking level, which dominated wall time.
  // First-event timeout: provider stalls of 12–19 min before the first token were observed;
  // abort and let omp's retry resend instead of waiting.
  const overlay = join(dir, "omp-overlay.yml");
  writeFileSync(overlay, JSON.stringify({
    modelRoles: { default: `${job.model}:${job.thinking}`, task: `${job.workerModel}:${job.workerThinking}` },
    providers: { streamFirstEventTimeoutSeconds: 120 },
    skills: { customDirectories: [join(homedir(), ".pi/agent/skills"), SKILLS_DIR] },
  }));
  const log = createWriteStream(join(dir, "omp.jsonl"), { flags: resuming ? "a" : "w" });
  // Sessions (incl. subagents) are kept in the job dir so token usage can be audited per job.
  const args = ["-p", "--session-dir", join(dir, "sessions"), "--mode", "json", "--model", job.model, "--thinking", job.thinking, "--config", overlay, "--cwd", dir];
  if (resuming) args.push("--continue", RESUME_PROMPT);
  else args.push(prompt);
  const child = spawn(OMP, args, {
    cwd: dir,
    // Own process group, so cancel can kill omp together with its render/TTS/browser children.
    detached: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let lastText = "";
  let buf = "";
  child.stdout.on("data", chunk => {
    log.write(chunk);
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.startsWith('{"type":"message_end"')) continue;
      try {
        const msg = JSON.parse(line).message;
        if (msg?.role === "assistant") lastText = msg.content.filter(c => c.type === "text").map(c => c.text).join("\n") || lastText;
      } catch {}
    }
  });
  child.stderr.pipe(createWriteStream(join(dir, "omp.stderr.log"), { flags: resuming ? "a" : "w" }));
  runningChild = child;
  child.on("close", code => {
    runningChild = null;
    log.end();
    const result = extractResult(lastText);
    Object.assign(job, {
      // Revise mode refuses restructure requests (new style/format/frames) — the caller should submit a new job.
      status: job.cancelRequested ? "cancelled" : code === 0 && result?.change_class === "restructure" ? "rejected" : code === 0 && result?.video ? "done" : "failed",
      exitCode: code,
      finishedAt: new Date().toISOString(),
      elapsedSec: Math.round((Date.now() - Date.parse(job.startedAt)) / 1000),
      result,
      finalMessage: lastText.slice(-4000),
    });
    if (job.status === "cancelled") job.error = "cancelled by request";
    if (job.status === "failed" && !job.error) job.error = code === 0 ? "omp finished without a video path" : `omp exited ${code}`;
    save(job);
    try { projectsApi.onJobFinished(job); } catch (e) { console.error(`project publish failed for ${job.id}:`, e); }
    running = null;
    pump();
  });
}

// The prompt asks omp to end with a fenced ```json block; take the last one.
function extractResult(text) {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!blocks.length) return null;
  try { return JSON.parse(blocks.at(-1)[1]); } catch { return null; }
}

const projectsApi = createProjects({ jobsDir: JOBS_DIR, send, readBody, newJob, jobs, queue });

createServer(async (req, res) => {
  if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "POST" && url.pathname === "/jobs") {
      const r = newJob(await readBody(req));
      if (r.error) return send(res, 400, r);
      return send(res, 202, { id: r.job.id, status: r.job.status, queuePosition: queue.indexOf(r.job) + 1 });
    }
    const cx = url.pathname.match(/^\/jobs\/([\w-]+)\/cancel$/);
    if (req.method === "POST" && cx) {
      const job = jobs.get(cx[1]);
      if (!job) return send(res, 404, { error: "not found" });
      if (job.status === "queued") {
        queue.splice(queue.indexOf(job), 1);
        Object.assign(job, { status: "cancelled", error: "cancelled by request", finishedAt: new Date().toISOString() });
        save(job);
        return send(res, 200, { id: job.id, status: job.status });
      }
      if (job.status !== "running" || running !== job || !runningChild) return send(res, 409, { error: `job is ${job.status}` });
      job.cancelRequested = true;
      save(job);
      const pgid = runningChild.pid;
      try { process.kill(-pgid, "SIGTERM"); } catch {}
      // Escalate if omp or a child ignores SIGTERM; the close handler records "cancelled".
      setTimeout(() => { try { process.kill(-pgid, "SIGKILL"); } catch {} }, 10_000).unref();
      return send(res, 202, { id: job.id, status: "cancelling" });
    }
    const rv = url.pathname.match(/^\/jobs\/([\w-]+)\/revise$/);
    if (req.method === "POST" && rv) {
      const parent = jobs.get(rv[1]);
      if (!parent) return send(res, 404, { error: "not found" });
      const src = parent.result?.project_dir;
      if (parent.status !== "done" || !src || !existsSync(src)) return send(res, 409, { error: "parent job has no finished project to revise" });
      const body = await readBody(req);
      const instructions = String(body.instructions ?? "").trim();
      if (instructions.length > 8000 || (!instructions && body.durationSec == null)) return send(res, 400, { error: "instructions (<=8000 chars) or durationSec required" });
      const durationSec = body.durationSec == null ? null : Number(body.durationSec);
      if (durationSec != null && !(durationSec >= 15 && durationSec <= 180)) return send(res, 400, { error: "durationSec must be 15–180" });
      const frames = Array.isArray(body.frames) ? body.frames.map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
      const model = String(body.model ?? parent.model), thinking = String(body.thinking ?? parent.thinking);
      const workerModel = String(body.workerModel ?? parent.workerModel ?? model), workerThinking = String(body.workerThinking ?? parent.workerThinking ?? thinking);
      if (!MODEL_RE.test(model) || !MODEL_RE.test(workerModel)) return send(res, 400, { error: "invalid model" });
      if (!THINKING.has(thinking) || !THINKING.has(workerThinking)) return send(res, 400, { error: `thinking must be one of ${[...THINKING]}` });
      const id = new Date().toISOString().slice(0, 10) + "-" + randomUUID().slice(0, 8);
      // Revise a copy: the parent's video stays intact. Old renders/snapshots are not copied.
      const projectDir = join(JOBS_DIR, id, "videos", basename(src));
      cpSync(src, projectDir, { recursive: true, filter: p => !/\/(renders|snapshots)(\/|$)/.test(p.slice(src.length)) });
      // Frame packets embed absolute paths to the parent project; point them at the copy.
      const packets = join(projectDir, ".hyperframes/frame-packets");
      if (existsSync(packets)) for (const f of readdirSync(packets, { withFileTypes: true })) {
        if (!f.isFile()) continue;
        const p = join(packets, f.name);
        writeFileSync(p, readFileSync(p, "utf8").replaceAll(src, projectDir));
      }
      const root = parent.rootId ?? parent.id;
      const job = { id, status: "queued", parentId: parent.id, rootId: root, projectId: parent.projectId, scene: parent.scene, assets: parent.assets, findAssets: parent.findAssets, topic: parent.topic, style: parent.style, format: parent.format, voice: parent.voice, instructions: instructions || `Change the length to ~${durationSec}s.`, frames, durationSec, currentDurationSec: parent.result?.duration_s == null ? null : Math.round(parent.result.duration_s * 10) / 10, projectDir, model, thinking, workerModel, workerThinking, createdAt: new Date().toISOString() };
      jobs.set(id, job);
      save(job);
      queue.push(job);
      pump();
      return send(res, 202, { id, parentId: parent.id, status: job.status, queuePosition: queue.indexOf(job) + 1 });
    }
    const m = url.pathname.match(/^\/jobs\/([\w-]+)$/);
    if (req.method === "GET" && m) {
      const job = jobs.get(m[1]);
      if (!job) return send(res, 404, { error: "not found" });
      const root = job.rootId ?? job.id;
      const revisions = [...jobs.values()].filter(j => j.rootId === root).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(({ id, status, instructions, createdAt }) => ({ id, status, instructions: instructions.slice(0, 200), createdAt }));
      return send(res, 200, { ...job, rootId: root, revisions, latest: [root, ...revisions.filter(r => r.status === "done").map(r => r.id)].at(-1) });
    }
    if (req.method === "GET" && url.pathname === "/jobs") {
      // latest = newest done job in the same revision chain; revise that one, not an older link.
      const latestOf = new Map();
      for (const j of [...jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
        if (j.status === "done") latestOf.set(j.rootId ?? j.id, j.id);
      return send(res, 200, [...jobs.values()].map(({ id, status, topic, style, format, parentId, rootId, instructions, createdAt, elapsedSec, result }) => ({ id, status, topic, style, format, parentId, latest: latestOf.get(rootId ?? id) ?? null, instructions: instructions?.slice(0, 120), createdAt, elapsedSec, duration_s: result?.duration_s, contact_sheet: result?.contact_sheet })));
    }
    if (req.method === "GET" && url.pathname === "/styles") {
      return send(res, 200, { styles: presets(), formats: FORMATS, voices: [...ENGLISH_VOICES] });
    }
    if (await projectsApi.handle(req, res, url)) return;
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 400, { error: String(e.message ?? e) });
  }
}).listen(PORT, HOST, () => {
  console.log(`omp-video-bridge listening on ${HOST}:${PORT}, jobs in ${JOBS_DIR}; resumed queue: ${queue.map(j => j.id + (j.resume ? "(continue)" : "")).join(", ") || "empty"}`);
  pump();
});

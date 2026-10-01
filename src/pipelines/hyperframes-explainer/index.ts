import { spawn } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Catalog, ParsedResult, Pipeline, PromptCtx } from "../../ports/pipeline.ts";
import { renderTemplate } from "../template.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(here, "prompts", name), "utf8");

export const FORMATS = { landscape: "1920x1080", portrait: "1080x1920", square: "1080x1080" } as const;
// Kokoro English voices (American a*, British b*). Narration is English only for now.
export const VOICES = [
  "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
] as const;

export interface HyperframesOptions {
  /** Where the hyperframes-creative skill keeps its frame presets. */
  presetsDir?: string;
  /** Upstream faceless-explainer scripts. */
  upstreamScripts?: string;
  hyperframesVersion?: string;
  /** Extra env for native (non-LLM) steps such as render. */
  env?: Record<string, string>;
}

const listPresets = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && existsSync(join(dir, d.name, "FRAME.md"))).map(d => d.name).sort()
    : [];

export function hyperframesExplainer(opts: HyperframesOptions = {}): Pipeline {
  const presetsDir = opts.presetsDir ?? join(homedir(), ".pi/agent/skills/hyperframes-creative/frame-presets");
  const upstreamScripts = opts.upstreamScripts ?? join(homedir(), ".agents/skills/faceless-explainer/scripts");
  const ourSkills = join(here, "skills");
  const ourScripts = join(ourSkills, "omp-video-pipeline/scripts");
  const hf = opts.hyperframesVersion ?? "0.8.82";
  const version = readFileSync(join(ourSkills, "omp-video-pipeline/SKILL.md"), "utf8").match(/^version:\s*(\S+)/m)?.[1] ?? "0";

  const specSchema = z.object({
    style: z.string().default("auto").refine(s => s === "auto" || listPresets(presetsDir).includes(s), { message: "unknown style preset (see GET /v1/catalog)" }),
    format: z.enum(Object.keys(FORMATS) as [keyof typeof FORMATS, ...(keyof typeof FORMATS)[]]).default("landscape"),
    voice: z.enum(VOICES).default("am_michael"),
    audience: z.string().max(200).default("developers"),
    tone: z.string().max(200).default("clear, friendly, technical"),
  });
  const sceneOptionsSchema = z.object({}).strict();

  const paths = () => renderTemplate(read("common-paths.md"), { upstreamScripts, ourScripts, presetsDir });

  const assetsBlock = (ctx: PromptCtx): string => {
    const { dir, foundDir, selected, others } = ctx.assets;
    const list = (a: typeof selected) => a.map(x => `${x.path} (${x.kind}${x.tags.length ? `, ${x.tags.join("/")}` : ""})`).join("; ");
    const lines = [`Project assets dir: ${dir}`];
    lines.push(selected.length ? `Use these where they fit (required if the brief mentions them): ${list(selected)}` : "No project assets were selected for this scene.");
    if (others.length) lines.push(`Other project assets (use only if clearly useful): ${list(others)}`);
    lines.push(ctx.scene.findAssets
      ? `You MAY source extra images: follow the skill's Assets section; save them to ${foundDir}/ and log each in ${foundDir}/SOURCES.md.`
      : "Do NOT download images from the internet. Missing visuals must be drawn in code (SVG/CSS/canvas).");
    return lines.join("\n");
  };

  return {
    id: "hyperframes-explainer",
    version,
    specSchema,
    sceneOptionsSchema,

    async catalog(): Promise<Catalog> {
      return { pipeline: "hyperframes-explainer", version, options: { style: ["auto", ...listPresets(presetsDir)], format: FORMATS, voice: VOICES, language: ["en"], durationSec: { min: 15, max: 180, default: 50 } } };
    },

    prompt(ctx: PromptCtx): string {
      if (ctx.kind === "resume") {
        return renderTemplate(read("resume.md"), {
          phase: ctx.job.phase,
          approve: ctx.flags.approve ?? "none",
          render: String(ctx.flags.render),
          projectDir: ctx.projectDir ?? "(discover from the existing workdir)",
          notes: ctx.approvalNotes?.trim() || "(none)",
        });
      }
      if (ctx.kind === "approve-continue") return renderTemplate(read("approve-continue.md"), { notes: ctx.approvalNotes?.trim() || "(none)" });
      const spec = specSchema.parse(ctx.project.spec);
      const brief = [
        ctx.project.brief && `Project context: ${ctx.project.brief}`,
        `This is scene ${ctx.scene.n} of the video "${ctx.project.name}".`,
        ctx.scene.brief,
      ].filter(Boolean).join("\n");
      if (ctx.kind === "build") {
        return renderTemplate(read("build.md"), {
          topic: ctx.scene.topic, style: spec.style, format: `${spec.format} ${FORMATS[spec.format]}`, voice: spec.voice,
          durationSec: String(ctx.scene.durationSec), audience: spec.audience, tone: spec.tone,
          approve: ctx.flags.approve ?? "none", render: String(ctx.flags.render),
          paths: paths(), assets: assetsBlock(ctx), brief: brief || "(none: derive from topic)",
        });
      }
      const r = ctx.revise!;
      return renderTemplate(read("revise.md"), {
        projectDir: ctx.projectDir!,
        instructions: r.instructions,
        frames: r.frames.length ? r.frames.join(", ") : "(not specified: infer from the instructions)",
        duration: r.durationSec ? `change to ~${r.durationSec}s (currently ${r.currentDurationSec ?? "?"}s)` : `keep (currently ${r.currentDurationSec ?? "?"}s)`,
        paths: paths(), assets: assetsBlock(ctx),
      });
    },

    parseResult(text: string, workdir: string, { requireVideo }): ParsedResult {
      const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
      if (!blocks.length) return { kind: "invalid", message: "final message has no ```json block" };
      let raw: unknown;
      try { raw = JSON.parse(blocks.at(-1)![1]!); } catch { return { kind: "invalid", message: "final json block is not valid JSON" }; }
      const r = z.looseObject({
        status: z.string().optional(), video: z.string().optional(), project_dir: z.string().optional(),
        contact_sheet: z.string().optional(), duration_s: z.number().optional(), change_class: z.string().optional(),
        frames_changed: z.array(z.number()).optional(), notes: z.string().optional(),
        storyboard: z.string().optional(), script: z.string().optional(),
      }).safeParse(raw);
      if (!r.success) return { kind: "invalid", message: `final json: ${r.error.message}` };
      const j = r.data;
      if (j.change_class === "restructure") return { kind: "rejected", reason: j.notes ?? "restructure requested: submit a new video instead" };
      if (!j.project_dir) return { kind: "invalid", message: "final json has no project_dir" };
      if (!j.project_dir.startsWith(workdir)) return { kind: "invalid", message: `project_dir ${j.project_dir} is outside the job workdir` };
      if (j.status === "awaiting_approval") {
        if (!j.storyboard || !existsSync(j.storyboard)) return { kind: "invalid", message: "awaiting_approval without an existing storyboard file" };
        return { kind: "awaiting_approval", projectDir: j.project_dir, storyboard: j.storyboard, script: j.script ?? null };
      }
      const video = j.video && j.video.length ? j.video : null;
      if (requireVideo && (!video || !existsSync(video))) return { kind: "invalid", message: `video missing on disk: ${video ?? "(none reported)"}` };
      const snaps = join(j.project_dir, "snapshots");
      const contactSheets = existsSync(snaps) ? readdirSync(snaps).filter(f => /^contact-sheet(-\d+)?\.jpg$/.test(f)).sort().map(f => join(snaps, f)) : [];
      const groups = join(j.project_dir, "caption_groups.json");
      return { kind: "ok", video, projectDir: j.project_dir, contactSheets, captionsGroups: existsSync(groups) ? groups : null, durationSec: j.duration_s ?? null, note: j.notes ?? null, changed: j.frames_changed ?? [] };
    },

    omp() {
      return { skillDirs: [ourSkills], env: { UPSTREAM_SCRIPTS: upstreamScripts, PRESETS_DIR: presetsDir, ...opts.env } };
    },

    prepareRevision(fromProjectDir: string, toWorkdir: string): string {
      const to = join(toWorkdir, "videos", basename(fromProjectDir));
      cpSync(fromProjectDir, to, { recursive: true, filter: p => !/\/(renders|snapshots)(\/|$)/.test(p.slice(fromProjectDir.length)) });
      // Frame packets embed absolute paths of the source project.
      const packets = join(to, ".hyperframes/frame-packets");
      if (existsSync(packets)) {
        for (const f of readdirSync(packets, { withFileTypes: true })) {
          if (f.isFile()) {
            const p = join(packets, f.name);
            writeFileSync(p, readFileSync(p, "utf8").replaceAll(fromProjectDir, to));
          }
        }
      }
      return to;
    },

    async render(projectDir: string, signal?: AbortSignal) {
      const run = (cmd: string, args: string[]) =>
        new Promise<{ code: number | null; out: string }>(resolve => {
          const c = spawn(cmd, args, { cwd: projectDir, env: { ...process.env, ...opts.env }, signal });
          let out = "";
          c.stdout.on("data", d => (out += d));
          c.stderr.on("data", d => (out += d));
          c.on("error", () => resolve({ code: -1, out }));
          c.on("close", code => resolve({ code, out }));
        });
      const r = await run("npx", ["--yes", `hyperframes@${hf}`, "render", "--skill=faceless-explainer", "--quality", "high", "--output", "renders/video.mp4"]);
      const video = join(projectDir, "renders/video.mp4");
      if (r.code !== 0 || !existsSync(video)) throw new Error(`render failed (exit ${r.code}): ${r.out.slice(-1500)}`);
      const p = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video]);
      const d = Number.parseFloat(p.out.trim());
      return { video, durationSec: Number.isFinite(d) ? Math.round(d * 100) / 100 : null };
    },
  };
}

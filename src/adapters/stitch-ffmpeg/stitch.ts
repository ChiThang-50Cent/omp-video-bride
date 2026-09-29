import { spawn } from "node:child_process";
import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "../../app/app.ts";

const FADE = 0.5;

function run(cmd: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { signal });
    let out = "";
    c.stdout.on("data", d => (out += d));
    c.stderr.on("data", d => (out += d));
    c.on("error", reject);
    c.on("close", code => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${out.slice(-800)}`))));
  });
}

const probe = async (file: string, signal: AbortSignal) => {
  const size = (await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], signal)).trim();
  const dur = Number.parseFloat((await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], signal)).trim());
  const [w, h] = size.split(",").map(Number);
  return { w: w!, h: h!, dur };
};

const enc = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart"];

/** Folds the clips left to right. Hard cut by default; a `fade` transition on the incoming scene crossfades video and audio. */
export const stitchFfmpeg: NonNullable<Deps["stitch"]> = async (project, scenes, outDir, signal) => {
  const out = join(outDir, "final.mp4");
  if (scenes.length === 1) {
    await run("ffmpeg", ["-y", "-i", scenes[0]!.video, ...enc, out], signal);
    return { video: out, durationSec: (await probe(out, signal)).dur };
  }
  const { w, h } = await probe(scenes[0]!.video, signal);
  const norm = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p`;
  let acc = scenes[0]!.video;
  const temps: string[] = [];
  try {
    for (let i = 1; i < scenes.length; i++) {
      const next = scenes[i]!;
      const step = join(outDir, `.step-${i}.mp4`);
      temps.push(step);
      const fade = project.timeline.transitions[next.scene.id] === "fade";
      const a = await probe(acc, signal);
      const b = await probe(next.video, signal);
      const f = Math.min(FADE, a.dur / 2, b.dur / 2);
      const filter = fade
        ? `[0:v]${norm}[a];[1:v]${norm}[b];[a][b]xfade=transition=fade:duration=${f}:offset=${(a.dur - f).toFixed(3)}[v];[0:a]aresample=48000,aformat=channel_layouts=stereo[x];[1:a]aresample=48000,aformat=channel_layouts=stereo[y];[x][y]acrossfade=d=${f}[au]`
        : `[0:v]${norm}[a];[1:v]${norm}[b];[a][b]concat=n=2:v=1:a=0[v];[0:a]aresample=48000,aformat=channel_layouts=stereo[x];[1:a]aresample=48000,aformat=channel_layouts=stereo[y];[x][y]concat=n=2:v=0:a=1[au]`;
      await run("ffmpeg", ["-y", "-i", acc, "-i", next.video, "-filter_complex", filter, "-map", "[v]", "-map", "[au]", ...enc, step], signal);
      acc = step;
    }
    renameSync(acc, out);
  } finally {
    for (const t of temps) rmSync(t, { force: true });
  }
  return { video: out, durationSec: (await probe(out, signal)).dur };
};

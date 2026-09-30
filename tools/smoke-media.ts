import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stitchFfmpeg } from "../src/adapters/stitch-ffmpeg/stitch.ts";
import type { Project, Scene } from "../src/core/entities.ts";
import { z } from "zod";

// Real encoding/decoding, no model calls, browser, provider credentials or external delivery.
const dir = mkdtempSync(join(tmpdir(), "bridge-media-smoke-"));
const signal = AbortSignal.timeout(60_000);
try {
  const scenes: { scene: Scene; versionId: string; video: string }[] = [];
  for (const [index, color] of ["red", "blue"].entries()) {
    const video = join(dir, `scene-${index}.mp4`);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=320x180:r=30:d=1.2`, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video], { timeout: 15_000 });
    scenes.push({ scene: { id: `s${index}`, projectId: "smoke", n: index + 1, title: color, topic: color, brief: "", durationSec: 1.2, assetRefs: [], findAssets: false, currentVersionId: `v${index}`, createdAt: "2026-01-01T00:00:00.000Z" }, versionId: `v${index}`, video });
  }
  for (const transition of ["cut", "fade"] as const) {
    const project: Project = { id: "smoke", name: "media smoke", pipeline: "hyperframes-explainer", spec: {}, brief: "", brand: {}, timeline: { order: ["s0", "s1"], transitions: { s1: transition } }, final: null, createdAt: "2026-01-01T00:00:00.000Z" };
    const outDir = join(dir, transition);
    mkdirSync(outDir);
    const result = await stitchFfmpeg(project, scenes, outDir, signal);
    assert(typeof result.durationSec === "number", "encoded output must report its duration");
    const expected = transition === "cut" ? 2.4 : 1.9;
    assert(Math.abs(result.durationSec - expected) < 0.15, `${transition}: ${result.durationSec}s != ${expected}s`);
    const probe = z.object({ streams: z.array(z.object({ codec_type: z.string(), codec_name: z.string(), width: z.number().optional(), height: z.number().optional() })) }).parse(JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", result.video], { encoding: "utf8", timeout: 5000 })));
    const video = probe.streams.find(stream => stream.codec_type === "video");
    assert(video, "encoded output has no video stream");
    assert.equal(video.codec_name, "h264");
    assert.equal(video.width, 320);
    assert.equal(video.height, 180);
    assert.equal(probe.streams.find(stream => stream.codec_type === "audio")?.codec_name, "aac");
    // Decode the complete output rather than trusting container metadata alone.
    execFileSync("ffmpeg", ["-v", "error", "-i", result.video, "-f", "null", "-"], { timeout: 15_000 });
    console.log(`PASS real FFmpeg ${transition}: H.264/AAC 320x180, ${result.durationSec.toFixed(3)}s, full decode`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

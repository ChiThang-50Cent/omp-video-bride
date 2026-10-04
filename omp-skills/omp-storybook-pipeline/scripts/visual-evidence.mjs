import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { projectPath, readJson, sha256Bytes, sha256File, stableStringify } from "./storybook-schema.mjs";

export function evidenceDigest(audit) {
  return sha256Bytes(Buffer.from(stableStringify({ compiledHash: audit.compiled.sha256, sourceDigest: audit.source.digest, manifestHash: audit.manifest.sha256, compositionHash: audit.composition.sha256, indexHash: audit.index.sha256, captionGroupsHash: audit.captions?.sha256 ?? null, captionFiles: audit.captions?.files ?? null, screenshotHashes: audit.evidence.screenshotHashes, contactSheets: audit.evidence.contactSheets, samples: audit.samples, captionSamples: audit.captions?.samples ?? [], videoFrames: audit.evidence.videoFrames, video: audit.video }), "utf8"));
}

export function verifyVisualEvidence(root, audit) {
  const evidence = audit.evidence;
  if (!Array.isArray(evidence?.screenshotHashes) || !evidence.screenshotHashes.length || !Array.isArray(evidence.contactSheets) || !evidence.contactSheets.length) throw new Error("visual evidence hash lists are missing");
  if (stableStringify(evidence.screenshots) !== stableStringify(evidence.screenshotHashes.map(item => item.path))) throw new Error("visual screenshot hash list does not match evidence");
  for (const item of [...evidence.screenshotHashes, ...evidence.contactSheets]) {
    const path = projectPath(root, item.path, "visual evidence");
    if (!existsSync(path) || sha256File(path) !== item.sha256) throw new Error(`visual evidence missing or overwritten: ${item.path}`);
  }
  if (evidence.digest !== evidenceDigest(audit)) throw new Error("visual evidence digest is stale");
  const contact = readJson(projectPath(root, evidence.contact, "visual contact metadata"), "visual contact metadata");
  if (contact.kind !== "hyperframes-storybook-visual-review" || contact.status !== "review-required" || contact.sourceDigest !== evidence.digest || contact.report !== evidence.report || stableStringify(contact.screenshots) !== stableStringify(evidence.screenshots) || stableStringify(contact.contactSheets) !== stableStringify(evidence.contactSheets)) throw new Error("visual contact metadata is stale");
}

function pixels(path, frameIndex = null) {
  const filter = `${frameIndex === null ? "" : `select=eq(n\\,${frameIndex}),`}scale=320:180:flags=area,format=rgb24`;
  const result = spawnSync("ffmpeg", ["-v", "error", "-threads", "1", "-filter_threads", "1", "-i", path, "-vf", filter, "-frames:v", "1", "-f", "rawvideo", "pipe:1"], { maxBuffer: 4 * 1024 * 1024, timeout: 120_000 });
  if (result.status !== 0 || result.stdout?.length !== 320 * 180 * 3) throw new Error(`cannot decode visual evidence: ${path}: ${String(result.stderr ?? "")}`);
  return result.stdout;
}

// Spatial tile errors prevent a changed character or caption being diluted by a large background.
export function compareVisualPixels(expected, actual) {
  if (expected.length !== 320 * 180 * 3 || actual.length !== expected.length) throw new Error("invalid visual pixel dimensions");
  let total = 0;
  const tiles = new Array(80).fill(0);
  for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) {
    const offset = (y * 320 + x) * 3;
    const error = (Math.abs(expected[offset] - actual[offset]) + Math.abs(expected[offset + 1] - actual[offset + 1]) + Math.abs(expected[offset + 2] - actual[offset + 2])) / 3;
    total += error;
    tiles[Math.floor(y / 18) * 8 + Math.floor(x / 40)] += error;
  }
  const meanError = total / (320 * 180);
  const maxTileError = Math.max(...tiles) / (40 * 18);
  if (meanError > 8 || maxTileError > 18) throw new Error(`encoded video visual mismatch (mean ${meanError.toFixed(3)}, tile ${maxTileError.toFixed(3)})`);
  return { meanError, maxTileError };
}

export function verifyRenderedVisuals(root, audit) {
  const frames = audit.evidence?.videoFrames;
  if (!Array.isArray(frames) || !frames.length || !audit.video?.sha256) throw new Error("encoded video frame evidence is missing");
  const videoPath = projectPath(root, audit.video.path, "encoded video");
  if (sha256File(videoPath) !== audit.video.sha256) throw new Error("encoded video hash is stale");
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate,r_frame_rate", "-of", "json", videoPath], { encoding: "utf8", timeout: 30_000 });
  if (probe.status !== 0) throw new Error("cannot probe encoded frame rate");
  const stream = JSON.parse(probe.stdout).streams?.[0];
  const rate = value => { const [a, b] = String(value).split("/").map(Number); return a / b; };
  const fps = rate(stream?.avg_frame_rate);
  if (!Number.isFinite(fps) || fps <= 0 || Math.abs(fps - rate(stream?.r_frame_rate)) > 0.0001 || fps !== audit.video.fps) throw new Error("encoded frame rate evidence is stale");
  const times = [...audit.samples.flatMap(shot => shot.samples.map(sample => sample.timeSec)), ...(audit.captions?.samples ?? []).map(sample => sample.timeSec)];
  if (frames.length !== times.length || frames.some((frame, index) => frame.frameIndex !== Math.floor(times[index] * fps))) throw new Error("encoded frame sample coverage is stale");
  const screenshots = new Map(audit.evidence.screenshotHashes.map(item => [item.path, item.sha256]));
  const samples = frames.map(frame => {
    if (!Number.isInteger(frame.frameIndex) || frame.frameIndex < 0 || !Number.isFinite(frame.timeSec) || Math.abs(frame.timeSec - frame.frameIndex / audit.video.fps) > 1e-8 || screenshots.get(frame.path) !== frame.sha256) throw new Error("encoded frame screenshot binding is invalid");
    const path = projectPath(root, frame.path, "encoded reference screenshot");
    if (sha256File(path) !== frame.sha256) throw new Error("encoded reference screenshot hash is stale");
    return { ...frame, ...compareVisualPixels(pixels(path), pixels(videoPath, frame.frameIndex)) };
  });
  return { videoSha256: audit.video.sha256, evidenceDigest: audit.evidence.digest, samples };
}

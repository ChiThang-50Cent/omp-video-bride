import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, relative, isAbsolute, join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const RATE = 48000;
const fail = message => { throw new Error(`storybook audio: ${message}`); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function local(projectDir, path) {
  if (typeof path !== "string" || !path || isAbsolute(path)) fail("audio source must be project-relative");
  const root = realpathSync(projectDir), absolute = realpathSync(resolve(root, path));
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith("../")) fail("audio source escapes project");
  return absolute;
}
function run(command, args) {
  try { return execFileSync(command, args, { maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) { fail(`${command} failed: ${String(error.stderr ?? error.message)}`); }
}
function pcm(path, duration = null) {
  const bytes = run("ffmpeg", ["-v", "error", "-i", path, "-map", "0:a:0", ...(duration == null ? [] : ["-t", String(duration)]), "-ac", "2", "-ar", String(RATE), "-f", "f32le", "pipe:1"]);
  const values = new Float32Array(bytes.length / 4);
  for (let i = 0; i < values.length; i++) { values[i] = bytes.readFloatLE(i * 4); if (!Number.isFinite(values[i])) fail("nonfinite audio samples"); }
  if (!values.length) fail("empty decoded audio");
  return values;
}
function energy(values) { let sum = 0; for (const x of values) sum += x * x; return sum / values.length; }
function probe(path) {
  const value = JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path]));
  const stream = value.streams?.find(s => s.codec_type === "audio");
  const duration = Number(stream?.duration ?? value.format?.duration);
  if (!stream || !Number.isFinite(duration) || duration <= 0) fail("source has no positive measured audio duration");
  return { duration, codec: stream.codec_name, sampleRate: Number(stream.sample_rate), channels: stream.channels };
}
export function buildAudioPlan(projectDir, manifest) {
  const required = manifest.requirements.narration === "required" || manifest.requirements.music === "required";
  const metadataPath = resolve(projectDir, existsSync(resolve(projectDir, "audio_meta.json")) ? "audio_meta.json" : "audio_engine_meta.json");
  if (!required && !existsSync(metadataPath)) return { version: 1, durationSec: manifest.durationSec, metadataSha256: null, tracks: [] };
  const metadataBytes = readFileSync(metadataPath);
  const metadata = JSON.parse(metadataBytes);
  const tracks = [];
  function add(kind, source, start, duration, volume, frame = null) {
    if (![start, duration, volume].every(Number.isFinite) || start < 0 || duration <= 0 || volume <= 0 || volume > 10 ** (12 / 20)) fail(`invalid ${kind} timing/gain`);
    const absolute = local(projectDir, source), measured = probe(absolute), samples = pcm(absolute, duration);
    const rms = Math.sqrt(energy(samples)) * volume;
    // Below -80 dBFS after mounting is not usable required audio, rather than a metadata-only stream.
    if (rms < 0.0001) fail(`${kind} source is silent or inaudible`);
    tracks.push({ kind, frame, path: source, sha256: hash(readFileSync(absolute)), start, duration, volume, measured, rms });
  }
  if (manifest.requirements.narration === "required") {
    if (!Array.isArray(metadata.voices) || metadata.voices.length !== manifest.narration.lines.length) fail("narration metadata does not cover authored lines");
    const seen = new Set();
    for (const voice of metadata.voices) {
      const frame = Number(voice.frame), shot = manifest.shots[frame - 1];
      if (!Number.isInteger(frame) || !shot || seen.has(frame) || !manifest.narration.lines.some(line => line.shotId === shot.id)) fail("invalid narration frame");
      seen.add(frame);
      add("narration", voice.path, manifest.shots.slice(0, frame - 1).reduce((sum, item) => sum + item.durationSec, 0), shot.durationSec, 1, frame);
    }
  }
  if (manifest.requirements.music === "required") {
    if (!metadata.bgm) fail("required music metadata missing");
    add("music", metadata.bgm.path, 0, manifest.durationSec, metadata.bgm.volume ?? 0.12);
  }
  for (const cue of metadata.sfx ?? []) {
    const frame = Number(cue.frame ?? cue.id), shot = manifest.shots[frame - 1];
    const offset = Number(cue.offset_s ?? 0);
    if (!Number.isInteger(frame) || !shot || !Number.isFinite(offset) || offset < 0 || offset >= shot.durationSec) fail("invalid sound effect frame/offset");
    const start = manifest.shots.slice(0, frame - 1).reduce((sum, item) => sum + item.durationSec, 0) + offset;
    add("sound effect", cue.file, start, Math.min(Number(cue.duration_s), manifest.durationSec - start), Number(cue.volume ?? 0.35), frame);
  }
  return { version: 1, durationSec: manifest.durationSec, metadataSha256: hash(metadataBytes), tracks };
}
export function inspectAudioMounts(plan, mounts, projectDir) {
  if (!Array.isArray(mounts) || mounts.length !== plan.tracks.length) fail("mounted audio count differs from source plan");
  const remaining = mounts.map((mount, index) => ({ ...mount, index }));
  const mixOrder = [];
  const evidence = plan.tracks.map((track, trackIndex) => {
    const index = remaining.findIndex(m => m.srcAttribute === track.path);
    if (index < 0) fail(`required ${track.kind} source is not mounted: ${track.path}`);
    const mount = remaining.splice(index, 1)[0];
    mixOrder[mount.index] = trackIndex;
    if (!mount.clip || mount.muted || mount.unsupported || !Number.isFinite(mount.readyState) || mount.readyState < 1 || !Number.isFinite(mount.naturalDuration) || mount.naturalDuration <= 0) fail("required audio mount is muted/unready/unsupported/not a clip");
    const expected = pathToFileURL(local(projectDir, track.path)).href;
    if (mount.src !== mount.currentSrc || ![mount.src, mount.currentSrc].every(src => {
      try { return new URL(src).protocol === "file:" && pathToFileURL(realpathSync(fileURLToPath(src))).href === expected; }
      catch { return false; }
    })) fail("mounted audio source substituted");
    for (const key of ["start", "duration", "volume"]) if (!Number.isFinite(mount[key]) || Math.abs(mount[key] - track[key]) > 1e-6) fail(`mounted audio ${key} differs from source plan`);
    if (Math.abs(mount.naturalDuration - track.measured.duration) > 0.05) fail("mounted audio duration differs from measured source");
    return { path: track.path, start: mount.start, duration: mount.duration, volume: mount.volume, naturalDuration: mount.naturalDuration };
  });
  return { tracks: evidence, mixOrder };
}

function renderReference(plan, prepared, output, omit, mixOrder) {
  const ordered = mixOrder.map(index => ({ track: plan.tracks[index], index }));
  const inputs = mixOrder.flatMap(index => ["-i", prepared[index]]);
  // HyperFrames 0.8.82 pads every input to the full timeline, normalizes amix by N,
  // then compensates by N (default master audioGain=1). Keep muted omitted inputs
  // in the graph so sample-rate negotiation and encoder framing remain identical.
  const filters = ordered.map(({ track, index }, i) =>
    `[${i}:a]atrim=0:${track.duration},volume=${index === omit ? 0 : track.volume},adelay=${Math.round(track.start * 1000)}|${Math.round(track.start * 1000)},apad,asetpts=N/SR/TB,atrim=0:${plan.durationSec}[a${i}]`);
  filters.push(`${plan.tracks.map((_, i) => `[a${i}]`).join("")}amix=inputs=${plan.tracks.length}:duration=longest:dropout_transition=0[mixed]`);
  filters.push(`[mixed]volume=${plan.tracks.length}[out]`);
  run("ffmpeg", ["-v", "error", ...inputs, "-filter_complex", filters.join(";"), "-map", "[out]", "-acodec", "aac", "-b:a", "192k", "-t", String(plan.durationSec), "-y", output]);
}
function distance(a, b, length) {
  let sum = 0;
  for (let i = 0; i < length; i++) { const delta = (a[i] ?? 0) - (b[i] ?? 0); sum += delta * delta; }
  return sum / length;
}
export function verifyRenderedAudio(projectDir, manifest, plan, videoPath, mixOrder = plan.tracks.map((_, i) => i)) {
  const fresh = buildAudioPlan(projectDir, manifest);
  if (JSON.stringify(fresh) !== JSON.stringify(plan)) fail("audio plan is stale or fabricated");
  if (!Array.isArray(mixOrder) || mixOrder.length !== plan.tracks.length || new Set(mixOrder).size !== plan.tracks.length || mixOrder.some(i => !Number.isInteger(i) || i < 0 || i >= plan.tracks.length)) fail("invalid native audio mix order");
  if (!plan.tracks.length) return { required: false, tracks: [] };
  const video = isAbsolute(videoPath) ? videoPath : resolve(projectDir, videoPath);
  const actual = pcm(video, plan.durationSec);
  const length = Math.round(plan.durationSec * RATE) * 2;
  // AAC can pad the last frame, but may not omit authored timeline samples.
  if (actual.length < length - 2048) fail("rendered audio is shorter than the required timeline");
  const work = mkdtempSync(join(tmpdir(), "storybook-audio-evidence-"));
  try {
    // Native HyperFrames first resamples each clip to 48kHz PCM16 stereo.
    // Mono is duplicated at unity, not FFmpeg's attenuated default upmix.
    const prepared = plan.tracks.map((track, index) => {
      const path = join(work, `source-${index}.wav`);
      run("ffmpeg", ["-v", "error", "-ss", "0", "-t", String(track.duration), "-i", local(projectDir, track.path), "-acodec", "pcm_s16le", "-ar", String(RATE), ...(track.measured.channels === 1 ? ["-af", "pan=stereo|FL=FL+FC|FR=FR+FC"] : ["-ac", "2"]), "-y", path]);
      return path;
    });
    const referencePath = join(work, "expected.m4a");
    renderReference(plan, prepared, referencePath, -1, mixOrder);
    const expected = pcm(referencePath, plan.durationSec);
    const error = distance(actual, expected, length);
    // A 20 dB reconstruction SNR permits ordinary AAC changes, not substituted
    // content. This is NOT the component-presence gate: each required clip below
    // must be demonstrably closer to the full mix than its own omission.
    if (error > energy(expected) * 0.01) fail("rendered audio content differs from required source mix");
    const tracks = plan.tracks.map((track, index) => {
      const omittedPath = join(work, `without-${index}.m4a`);
      renderReference(plan, prepared, omittedPath, index, mixOrder);
      const omitted = pcm(omittedPath, plan.durationSec);
      const componentDistance = distance(expected, omitted, length);
      const omittedError = distance(actual, omitted, length);
      // (omittedError - error) / componentDistance = 2 * projectedGain - 1.
      // Require >75% of each expected component along its source direction.
      // Orthogonal codec error in loud speech must not hide quiet music.
      if (!(componentDistance > 0) || omittedError - error <= componentDistance / 2)
        fail(`rendered audio cannot establish required ${track.kind} content: ${track.path}`);
      return { path: track.path, sha256: track.sha256, componentDistance, omittedError, reconstructionError: error };
    });
    return { required: true, videoSha256: hash(readFileSync(video)), metadataSha256: plan.metadataSha256, sampleRate: RATE, channels: 2, reconstructionError: error, tracks };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "vitest";

// Standalone pipeline helpers are shipped as JavaScript, without TypeScript declarations.
// @ts-expect-error no declaration for the standalone .mjs helper
import * as api from "../../src/pipelines/hyperframes-explainer/skills/omp-storybook-pipeline/scripts/audio-evidence.mjs";
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function ffmpeg(args: string[]) { execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "pipe" }); }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "storybook-audio-test-")); temporary.push(dir);
  for (const [name, frequency] of [["voice", 443], ["music", 719], ["other", 991]] as const)
    ffmpeg(["-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=1.5`, "-ac", "2", join(dir, `${name}.wav`)]);
  const metadata = { voices: [{ frame: 1, path: "voice.wav" }], bgm: { path: "music.wav", volume: 0.12 } };
  writeFileSync(join(dir, "audio_meta.json"), JSON.stringify(metadata));
  const manifest = { durationSec: 1.5, requirements: { narration: "required", music: "required" }, narration: { lines: [{ shotId: "one", text: "A test." }] }, shots: [{ id: "one", durationSec: 1.5 }] };
  return { dir, metadata, manifest };
}
function output(dir: string, mode: string) {
  const file = join(dir, `${mode}.m4a`);
  if (mode === "silence") ffmpeg(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "1.5", "-c:a", "aac", "-b:a", "192k", file]);
  else if (mode === "voice" || mode === "music") ffmpeg(["-i", join(dir, `${mode}.wav`), "-af", `volume=${mode === "music" ? 0.12 : 1}`, "-c:a", "aac", "-b:a", "192k", file]);
  else ffmpeg(["-i", join(dir, mode === "substitution" ? "other.wav" : "voice.wav"), "-i", join(dir, "music.wav"), "-filter_complex", "[0:a]volume=1[a];[1:a]volume=0.12[b];[a][b]amix=inputs=2:normalize=0[out]", "-map", "[out]", "-c:a", "aac", "-b:a", "192k", file]);
  return file;
}
describe("source-bound storybook audio evidence", () => {
  it("accepts a real AAC mix and rejects each missing or substituted required component", async () => {
    const { dir, manifest } = fixture(); const plan = api.buildAudioPlan(dir, manifest);
    const evidence = api.verifyRenderedAudio(dir, manifest, plan, output(dir, "correct"));
    assert.equal(evidence.tracks.length, 2);
    for (const mode of ["voice", "music", "silence", "substitution"])
      assert.throws(() => api.verifyRenderedAudio(dir, manifest, plan, output(dir, mode)), /rendered audio/);
  }, 20_000); // Several real FFmpeg encodes/decodes exceed Vitest's 5s default on CI.
  it("detects quiet music independently of unrelated reconstruction error", () => {
    const { dir, manifest, metadata } = fixture();
    metadata.bgm.volume = 0.003;
    writeFileSync(join(dir, "audio_meta.json"), JSON.stringify(metadata));
    const plan = api.buildAudioPlan(dir, manifest);
    const encode = (name: string, musicGain: number) => {
      const base = join(dir, `${name}.m4a`);
      const file = join(dir, `${name}.wav`);
      ffmpeg(["-i", join(dir, "voice.wav"), "-i", join(dir, "music.wav"), "-filter_complex", `[0:a]volume=1[a];[1:a]volume=${musicGain}[b];[a][b]amix=inputs=2:duration=longest:dropout_transition=0,volume=2[out]`, "-map", "[out]", "-c:a", "aac", "-b:a", "192k", base]);
      ffmpeg(["-i", base, "-f", "lavfi", "-i", "aevalsrc=0.001*sin(2*PI*1103*t):s=48000:d=1.5", "-filter_complex", "[1:a]pan=stereo|FL=c0|FR=c0[c];[0:a][c]amix=inputs=2:normalize=0[out]", "-map", "[out]", "-c:a", "pcm_f32le", file]);
      return file;
    };
    const evidence = api.verifyRenderedAudio(dir, manifest, plan, encode("quiet-music", 0.003));
    const music = evidence.tracks.find((track: { path: string }) => track.path === "music.wav");
    assert(music.reconstructionError > music.componentDistance / 4);
    assert.throws(() => api.verifyRenderedAudio(dir, manifest, plan, encode("missing-quiet-music", 0)), /required music content/);
    assert.throws(() => api.verifyRenderedAudio(dir, manifest, plan, encode("under-gain-quiet-music", 0.0015)), /required music content/);
  });
  it("reconstructs native mono duplication and resampling before mixing", () => {
    const { dir, manifest } = fixture();
    ffmpeg(["-f", "lavfi", "-i", "sine=frequency=443:sample_rate=24000:duration=1.5", "-ac", "1", join(dir, "voice.wav")]);
    const plan = api.buildAudioPlan(dir, manifest);
    const mounts = [plan.tracks[1], plan.tracks[0]].map((track: { path: string; start: number; duration: number; volume: number; measured: { duration: number } }) => ({ srcAttribute: track.path, src: pathToFileURL(join(dir, track.path)).href, currentSrc: pathToFileURL(join(dir, track.path)).href, clip: true, start: track.start, duration: track.duration, volume: track.volume, muted: false, readyState: 4, naturalDuration: track.measured.duration }));
    const mounted = api.inspectAudioMounts(plan, mounts, dir);
    const file = join(dir, "native-order.m4a");
    const preparedVoice = join(dir, "prepared-voice.wav");
    ffmpeg(["-i", join(dir, "voice.wav"), "-af", "pan=stereo|FL=FL+FC|FR=FR+FC", "-ar", "48000", "-c:a", "pcm_s16le", preparedVoice]);
    ffmpeg(["-i", join(dir, "music.wav"), "-i", preparedVoice, "-filter_complex", "[0:a]volume=0.12[a];[1:a]volume=1[b];[a][b]amix=inputs=2:duration=longest:dropout_transition=0,volume=2[out]", "-map", "[out]", "-c:a", "aac", "-b:a", "192k", file]);
    const evidence = api.verifyRenderedAudio(dir, manifest, plan, file, mounted.mixOrder);
    assert.deepEqual(evidence.tracks.map((track: { path: string }) => track.path), ["voice.wav", "music.wav"]);
    assert.throws(() => api.verifyRenderedAudio(dir, manifest, plan, output(dir, "music"), mounted.mixOrder), /rendered audio/);
  });
  it("rejects mounting timing, gain, URL substitution, and stale or fabricated plans", async () => {
    const { dir, manifest, metadata } = fixture(); const plan = api.buildAudioPlan(dir, manifest);
    const mounts = plan.tracks.map((track: { path: string; start: number; duration: number; volume: number; measured: { duration: number } }) => ({ srcAttribute: track.path, src: pathToFileURL(join(dir, track.path)).href, currentSrc: pathToFileURL(join(dir, track.path)).href, clip: true, start: track.start, duration: track.duration, volume: track.volume, muted: false, readyState: 4, naturalDuration: track.measured.duration }));
    api.inspectAudioMounts(plan, mounts, dir);
    for (const update of [{ start: 0.1 }, { duration: 1 }, { volume: 0 }, { currentSrc: "http://localhost/other/voice.wav" }, { muted: true }, { unsupported: true }])
      assert.throws(() => api.inspectAudioMounts(plan, [{ ...mounts[0], ...update }, mounts[1]], dir), /audio/);
    const file = output(dir, "correct");
    assert.throws(() => api.verifyRenderedAudio(dir, manifest, { ...plan, metadataSha256: "fabricated" }, file), /stale or fabricated/);
    metadata.bgm.volume = 0.2; writeFileSync(join(dir, "audio_meta.json"), JSON.stringify(metadata));
    assert.throws(() => api.verifyRenderedAudio(dir, manifest, plan, file), /stale or fabricated/);
  });
  it("preserves timed sound effects when narration and music are disabled", () => {
    const { dir, manifest } = fixture();
    const silent = { ...manifest, requirements: { narration: "none", music: "none" } };
    writeFileSync(join(dir, "audio_meta.json"), JSON.stringify({ sfx: [{ id: "01", file: "other.wav", offset_s: 0.25, duration_s: 1, volume: 0.35 }] }));
    const plan = api.buildAudioPlan(dir, silent);
    assert.equal(plan.tracks[0].start, 0.25);
    const file = join(dir, "sfx.m4a");
    ffmpeg(["-i", join(dir, "other.wav"), "-af", "atrim=0:1,volume=0.35,adelay=250|250,apad,atrim=0:1.5", "-c:a", "aac", "-b:a", "192k", file]);
    const evidence = api.verifyRenderedAudio(dir, silent, plan, file);
    assert.equal(evidence.tracks[0].path, "other.wav");
    assert.throws(() => api.verifyRenderedAudio(dir, silent, plan, output(dir, "silence")), /rendered audio/);
  });
  it("rejects silent required sources but preserves projects with no required audio", async () => {
    const { dir, manifest } = fixture();
    ffmpeg(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "1.5", join(dir, "voice.wav")]);
    assert.throws(() => api.buildAudioPlan(dir, manifest), /silent or inaudible/);
    const silent = { ...manifest, requirements: { narration: "none", music: "none" } };
    const plan = api.buildAudioPlan(dir, silent);
    assert.deepEqual(api.inspectAudioMounts(plan, [], dir), { tracks: [], mixOrder: [] });
    assert.deepEqual(api.verifyRenderedAudio(dir, silent, plan, "not-needed.mp4"), { required: false, tracks: [] });
  });
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "vitest";

const script = resolve("omp-skills/omp-video-pipeline/scripts/audio.mjs");
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
function fixture(durations = [1, 1, 1, 1, 1]) {
  const dir = mkdtempSync(join(tmpdir(), "audio-generation-")); temporary.push(dir);
  writeFileSync(join(dir, "STORYBOARD.md"), durations.map((duration, index) => `## Frame ${index + 1}\n- duration: ${duration}s`).join("\n"));
  const synth = join(dir, "fixture-synthesis.mjs");
  // Fixture synthesizer produces real measured PCM WAVs; no models or network.
  writeFileSync(synth, `#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('--resolve-assets')) {
 console.log(JSON.stringify({schema:'kokoro-wav-v2',model:{path:'fixture',sha256:'a'.repeat(64)},voices:{path:'fixture',sha256:'b'.repeat(64)}}));
} else {
 const lines = JSON.parse(readFileSync(args[args.indexOf('--input')+1], 'utf8')).lines;
 for (let i = 0; i < lines.length; i++) {
  if (i > 0 && existsSync(${JSON.stringify(join(dir, "fail-batch"))})) process.exit(7);
  mkdirSync(dirname(lines[i].output), {recursive:true});
  execFileSync('ffmpeg', ['-v','error','-y','-f','lavfi','-i','sine=frequency=443:sample_rate=24000:duration=0.4','-ac','1',lines[i].output]);
 }
 writeFileSync(args[args.indexOf('--result')+1], JSON.stringify({ok:true,model_loads:1,lines}));
}
`);
  chmodSync(synth, 0o755);
  const transcribe = join(dir, "fixture-transcribe.mjs");
  writeFileSync(transcribe, `import {writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const args=process.argv.slice(2);
const input=args[args.indexOf('--input')+1];
const duration=Number(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',input],{encoding:'utf8'}));
if (Math.abs(duration-5)>0.005) throw Error('combined WAV lost silent beats');
writeFileSync(args[args.indexOf('--out')+1],JSON.stringify({words:[{text:'Hello',start:1.1,end:1.3},{text:'Again',start:3.1,end:3.3}]}));`);
  const run = (music = "none") => spawnSync(process.execPath, [script, dir, "--music", music, "--batch-python", synth, "--transcribe", transcribe, "--out", join(dir, "result.json")], { encoding: "utf8" });
  return { dir, run };
}
function narration(dir: string) {
  writeFileSync(join(dir, "SCRIPT.md"), "## Line 1 (Frame 2)\n    Hello\n## Line 2 (Frame 4)\n    Again\n");
}
describe("storybook audio generation", () => {
  it("preserves leading, intervening and trailing silent beats in combined ASR and music", () => {
    const { dir, run } = fixture(); narration(dir);
    const result = run("required"); assert.equal(result.status, 0, result.stderr);
    const meta = json(join(dir, "result.json"));
    assert.equal(meta.total_duration_s, 5);
    assert.equal(meta.bgm.duration_s, 5);
    assert.deepEqual(meta.voices.map((voice: { frame: number }) => voice.frame), [2, 4]);
    assert.deepEqual(meta.voices.map((voice: { words: unknown }) => voice.words), [
      [{ id: "w0", text: "Hello", start: 0.1, end: 0.3 }],
      [{ id: "w0", text: "Again", start: 0.1, end: 0.3 }],
    ]);
    assert.deepEqual(json(join(dir, "audio_engine_meta.json")).voices.map((voice: { id: string }) => voice.id), ["02", "04"]);
  });
  it("supports silent and music-only projects without SCRIPT or synthesis assets", () => {
    const { dir } = fixture([0.5, 0.5]);
    for (const music of ["none", "required"]) {
      const result = spawnSync(process.execPath, [script, dir, "--music", music, "--batch-python", "unavailable-kokoro", "--transcribe", "unavailable-whisper"], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const meta = json(join(dir, "audio_meta.json"));
      assert.deepEqual(meta.voices, []); assert.equal(meta.total_duration_s, 1);
      assert.equal(meta.bgm?.duration_s ?? null, music === "required" ? 1 : null);
    }
  });
  it("checkpoints synthesis before fitting failure and reuses unchanged measured WAVs", () => {
    const { dir, run } = fixture([1, 0.2, 1, 1, 1]); narration(dir);
    const result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /speech overflow/);
    const cache = json(join(dir, "audio_cache.json"));
    assert.equal(Object.keys(cache.synthesis).length, 2);
    const sources = Object.values(cache.synthesis) as { source_path: string; sha256: string }[];
    writeFileSync(join(dir, "fail-batch"), "fail if synthesis reloads");
    writeFileSync(join(dir, "STORYBOARD.md"), [1, 1, 1, 1, 1].map((duration, index) => `## Frame ${index + 1}\n- duration: ${duration}s`).join("\n"));
    const rerun = run(); assert.equal(rerun.status, 0, rerun.stderr);
    assert.match(rerun.stdout, /0 Kokoro model loads/);
    for (const source of sources) assert(existsSync(join(dir, source.source_path)));
    assert.deepEqual(json(join(dir, "audio_cache.json")).synthesis, cache.synthesis);
  });
  it("preserves an earlier completed synthesis when a later batch item fails", () => {
    const { dir, run } = fixture(); narration(dir); writeFileSync(join(dir, "fail-batch"), "fail");
    assert.notEqual(run().status, 0);
    const cache = json(join(dir, "audio_cache.json"));
    assert.equal(Object.keys(cache.synthesis).length, 1);
    const retained = Object.entries(cache.synthesis)[0];
    assert(retained);
    rmSync(join(dir, "fail-batch"));
    const rerun = run(); assert.equal(rerun.status, 0, rerun.stderr);
    assert.match(rerun.stdout, /1 synthesis cache miss/);
    assert.deepEqual(json(join(dir, "audio_cache.json")).synthesis[retained[0]], retained[1]);
  });
  it("rejects unmapped, unknown and duplicate authored narration", () => {
    const { dir, run } = fixture();
    for (const [source, expected] of [
      ["## Unmapped\n    Hello", /no \(Frame N\) mapping/],
      ["## Frame 9\n    Hello", /unknown frame 9/],
      ["## Frame 2\n    Hello\n## Frame 2\n    Again", /multiple narration lines/],
    ] as const) {
      writeFileSync(join(dir, "SCRIPT.md"), source);
      const result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, expected);
    }
  });
});

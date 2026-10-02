import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "vitest";

const adapter = resolve("src/pipelines/hyperframes-explainer/skills/omp-video-pipeline/scripts/audio.mjs");
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const assetEnv = ["KOKORO_MODEL", "KOKORO_MODEL_PATH", "HYPERFRAMES_KOKORO_MODEL", "HYPERFRAMES_TTS_MODEL", "KOKORO_VOICES", "KOKORO_VOICES_PATH", "HYPERFRAMES_KOKORO_VOICES", "HYPERFRAMES_TTS_VOICES"];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "storybook-synthesis-cache-"));
  temporary.push(dir);
  const model = join(dir, "model.onnx"), voices = join(dir, "voices.bin");
  // These are resolver fixtures, deliberately not loadable models. The real
  // Python query must resolve and fingerprint them without constructing Kokoro.
  writeFileSync(model, "model revision one");
  writeFileSync(voices, "voice revision one");
  return { dir, model, voices };
}
function query(options: Record<string, string>, overrides: Record<string, string> = {}) {
  const env = { ...process.env };
  for (const key of assetEnv) delete env[key];
  Object.assign(env, overrides);
  const program = `import {resolveSynthesisIdentity,makeSynthesisKey} from ${JSON.stringify(adapter)};const identity=resolveSynthesisIdentity(JSON.parse(process.argv[1]));console.log(JSON.stringify({model:identity.model,voices:identity.voices,key:makeSynthesisKey('Approved narration','am_michael',1,identity)}));`;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", program, JSON.stringify(options)], { env, encoding: "utf8" }));
}

describe("storybook synthesis cache identity", () => {
  it("reuses identical bytes and invalidates same-path model and voice replacements", () => {
    const { model, voices } = fixture();
    const first = query({ model, voices });
    assert.equal(query({ model, voices }).key, first.key);
    writeFileSync(model, "model revision two");
    const second = query({ model, voices });
    assert.notEqual(second.key, first.key);
    assert.notEqual(second.model.sha256, first.model.sha256);
    writeFileSync(voices, "voice revision two");
    const third = query({ model, voices });
    assert.notEqual(third.key, second.key);
    assert.notEqual(third.voices.sha256, second.voices.sha256);
  }, 60_000);

  it("uses the Python resolver's CLI, environment candidate and directory precedence", () => {
    const { dir, model, voices } = fixture();
    const root = join(dir, "environment-assets");
    mkdirSync(root);
    const envModel = join(root, "kokoro-v1.0.onnx"), envVoices = join(root, "voices-v1.0.bin");
    writeFileSync(envModel, "environment model");
    writeFileSync(envVoices, "environment voices");
    writeFileSync(join(root, "kokoro-v0_19.onnx"), "older model");
    writeFileSync(join(root, "voices.bin"), "older voices");
    const env = { KOKORO_MODEL: root, KOKORO_MODEL_PATH: model, KOKORO_VOICES: root, KOKORO_VOICES_PATH: voices };
    const selected = query({}, env);
    assert.equal(selected.model.path, envModel);
    assert.equal(selected.voices.path, envVoices);
    const explicit = query({ model, voices }, env);
    assert.equal(explicit.model.path, model);
    assert.equal(explicit.voices.path, voices);
    const nextCandidate = query({}, { ...env, KOKORO_MODEL: join(dir, "missing"), KOKORO_VOICES: join(dir, "missing") });
    assert.equal(nextCandidate.model.path, model);
    assert.equal(nextCandidate.voices.path, voices);
  }, 60_000);

  it("uses the ordered pinned/default roots when no override is supplied", () => {
    const { dir } = fixture();
    const root = join(dir, ".cache/hyperframes/tts");
    mkdirSync(join(root, "models"), { recursive: true });
    mkdirSync(join(root, "voices"), { recursive: true });
    writeFileSync(join(root, "models/kokoro-v1.0.onnx"), "default model");
    writeFileSync(join(root, "voices/voices-v1.0.bin"), "default voices");
    // Existing globally pinned assets legitimately precede the isolated HOME.
    const roots = ["/assets/tts/models", "/assets/tts/voices", join(root, "models"), join(root, "voices"), root];
    const expectedModel = roots.flatMap((candidate) => ["kokoro-v1.0.onnx", "kokoro-v0_19.onnx"].map((name) => join(candidate, name))).find(existsSync);
    const expectedVoices = roots.flatMap((candidate) => ["voices-v1.0.bin", "voices.bin"].map((name) => join(candidate, name))).find(existsSync);
    const selected = query({}, { HOME: dir });
    assert.equal(selected.model.path, expectedModel && realpathSync(expectedModel));
    assert.equal(selected.voices.path, expectedVoices && realpathSync(expectedVoices));
  }, 60_000);

  it("rejects missing explicit assets and rejects legacy keys without resolved identity", () => {
    const { dir, model, voices } = fixture();
    assert.throws(() => query({ model: join(dir, "missing.onnx"), voices }, { KOKORO_MODEL: model }), /model not found/);
    assert.throws(() => query({ model, voices: join(dir, "missing.bin") }, { KOKORO_VOICES: voices }), /voice pack not found/);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import {makeSynthesisKey} from ${JSON.stringify(adapter)};makeSynthesisKey('Approved narration','am_michael',1);`], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /resolved Kokoro synthesis identity is required/);
  });
});

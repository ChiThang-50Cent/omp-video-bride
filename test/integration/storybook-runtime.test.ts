import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, it } from "vitest";
import { hyperframesStorybook } from "../../src/pipelines/hyperframes-explainer/index.ts";

const compiler = resolve("src/pipelines/hyperframes-explainer/skills/omp-storybook-pipeline/scripts/compile-scene.mjs");
const captions = resolve("src/pipelines/hyperframes-explainer/skills/omp-storybook-pipeline/scripts/captions.mjs");
const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const heroSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="260" viewBox="0 0 160 260" role="img" aria-label="Hero">
  <g stroke="#2d2a36" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M62 170v67M98 170v67" fill="none"/>
    <path d="M45 236h32v12H45zM83 236h32v12H83z" fill="#34445d"/>
    <path d="M40 100h80v83H40z" fill="#efbd56"/>
    <circle cx="80" cy="62" r="35" fill="#f4c9a7"/>
    <path d="M46 63q2-42 34-42t34 42q-15-15-34-2-19-13-34 2z" fill="#3c354b"/>
    <circle cx="67" cy="62" r="4" fill="#2d2a36" stroke="none"/><circle cx="93" cy="62" r="4" fill="#2d2a36" stroke="none"/>
    <path d="M70 84q10 7 20 0" fill="none"/>
  </g>
</svg>`;
const listenerSvg = heroSvg.replaceAll("Hero", "Listener").replaceAll("#efbd56", "#4678a6");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "storybook-runtime-test-"));
  temporary.push(dir);
  mkdirSync(join(dir, "assets/characters"), { recursive: true });
  mkdirSync(join(dir, "assets/backgrounds"), { recursive: true });
  writeFileSync(join(dir, "assets/characters/hero.svg"), `${heroSvg}\n`);
  writeFileSync(join(dir, "assets/characters/listener.svg"), `${listenerSvg}\n`);
  writeFileSync(join(dir, "assets/backgrounds/room.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><rect width="1920" height="1080" fill="#f4e2c5"/><path d="M700 700h520V400H700z" fill="#5a4549"/></svg>\n`);
  writeFileSync(join(dir, "storybook.json"), JSON.stringify({
    schemaVersion: 1,
    kind: "hyperframes-storybook",
    style: "storybook-flat",
    format: "landscape",
    canvas: { width: 1920, height: 1080 },
    durationSec: 1,
    requirements: { narration: "none", narrationMode: "verbatim", music: "none" },
    characters: [
      { id: "hero", path: "assets/characters/hero.svg", width: 160, height: 260 },
      { id: "listener", path: "assets/characters/listener.svg", width: 160, height: 260 },
    ],
    backgrounds: [{ id: "room", path: "assets/backgrounds/room.svg" }],
    assets: [],
    narration: { scriptPath: "SCRIPT.md", lines: [] },
    shots: [{
      id: "one",
      durationSec: 1,
      background: "room",
      cast: [
        { id: "hero", character: "hero", x: 800, y: 900 },
        { id: "listener", character: "listener", x: 1100, y: 900 },
      ],
    }],
  }, null, 2));
  return dir;
}

function rejectsCompilation(dir: string, previousOutput = false) {
  const result = spawnSync(process.execPath, [compiler, dir], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  if (!previousOutput) {
    assert.equal(existsSync(join(dir, ".hyperframes/storybook-assets-manifest.json")), false);
    assert.equal(existsSync(join(dir, "compositions/storybook-characters.html")), false);
  }
}

function runModule(dir: string, source: string) {
  return execFileSync(process.execPath, ["--input-type=module", "-e", source, dir], { encoding: "utf8" });
}

describe("storybook whole-character runtime contract", () => {
  it("rejects a cast reference to an unknown character", () => {
    const dir = fixture();
    const manifestPath = join(dir, "storybook.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.shots[0].cast[0].character = "missing";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    rejectsCompilation(dir);
  });

  it("rejects character assets escaping the project directory", () => {
    const outside = fixture();
    const dir = fixture();
    const manifestPath = join(dir, "storybook.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.characters[0].path = relative(dir, join(outside, "assets/characters/hero.svg"));
    writeFileSync(manifestPath, JSON.stringify(manifest));
    rejectsCompilation(dir);
  });

  it("rejects character content differing from its pinned hash", () => {
    const dir = fixture();
    const sourcePath = join(dir, "assets/characters/hero.svg");
    const manifestPath = join(dir, "storybook.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.characters[0].sha256 = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    execFileSync(process.execPath, [compiler, dir], { encoding: "utf8" });
    writeFileSync(sourcePath, readFileSync(sourcePath, "utf8").replace("#efbd56", "#8b609b"));
    rejectsCompilation(dir, true);
  });

  it("rejects the old articulated cast fields instead of accepting a rig alias", () => {
    const dir = fixture();
    const manifestPath = join(dir, "storybook.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.shots[0].cast[0].rig = "hero";
    manifest.shots[0].cast[0].variant = "default";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    rejectsCompilation(dir);
  });

  it("builds empty silent subtitles without requiring narration metadata", () => {
    const dir = fixture();
    const result = JSON.parse(runModule(dir, `import {buildCaptions} from ${JSON.stringify(captions)}; const plan=buildCaptions(process.argv[1]); console.log(JSON.stringify({groups:plan.data.groups,files:plan.paths}));`));
    assert.deepEqual(result.groups, []);
    assert.equal(readFileSync(result.files.transcript, "utf8"), "");
    assert.equal(readFileSync(result.files.srt, "utf8"), "");
    assert.equal(readFileSync(result.files.vtt, "utf8"), "WEBVTT\n\n");
    assert.equal(existsSync(join(dir, "audio_meta.json")), false);
  });

  it("rejects narration metadata in a silent subtitle project", () => {
    const dir = fixture();
    writeFileSync(join(dir, "audio_meta.json"), JSON.stringify({ voices: [{ frame: 1, text: "Unexpected narration" }] }));
    const result = spawnSync(process.execPath, [captions, dir], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /voices must be empty/);
  });

  it("rejects delivery of a different existing file than the audited video", () => {
    const dir = fixture();
    execFileSync(process.execPath, [compiler, dir], { encoding: "utf8" });
    writeFileSync(join(dir, "index.html"), readFileSync(join(dir, "compositions/storybook-characters.html")));
    writeFileSync(join(dir, "production-contract.json"), "{}");
    // Byte fixtures are sufficient: path binding must fail before decoding media.
    writeFileSync(join(dir, "audited.bin"), "audited artifact");
    writeFileSync(join(dir, "unrelated.bin"), "unrelated artifact");
    writeFileSync(join(dir, ".hyperframes/storybook-audit.json"), JSON.stringify({ video: { path: "audited.bin" } }));
    const pipeline = hyperframesStorybook();
    const result = pipeline.parseResult("```json\n" + JSON.stringify({
      project_dir: dir, video: join(dir, "unrelated.bin"),
    }) + "\n```", dir, { requireVideo: true });
    assert.deepEqual(result, { kind: "invalid", message: "reported video path does not match audited final video" });
  });
});

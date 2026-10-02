import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "vitest";

const captions = resolve("src/pipelines/hyperframes-explainer/skills/omp-storybook-pipeline/scripts/captions.mjs");
const temporary: string[] = [];
const narration = "The quick fox jumps.";

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(phrases: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "storybook-caption-coverage-"));
  temporary.push(dir);
  writeFileSync(join(dir, "storybook.json"), JSON.stringify({
    schemaVersion: 1,
    kind: "hyperframes-storybook",
    durationSec: 2,
    requirements: { narration: "required", narrationMode: "verbatim", music: "none" },
    characters: [{ id: "fox", path: "fox.svg", width: 100, height: 100 }],
    backgrounds: [{ id: "field", path: "field.svg" }],
    narration: { lines: [{ shotId: "one", text: narration }] },
    shots: [{ id: "one", durationSec: 2, background: "field", cast: [{ id: "fox", character: "fox", x: 800, y: 900 }] }],
  }));
  const words = phrases.map((text, index) => ({ text, start: index * 0.3 + 0.1, end: index * 0.3 + 0.3 }));
  writeFileSync(join(dir, "audio_meta.json"), JSON.stringify({
    voices: [{ frame: 1, text: narration, voice: "measured", path: "voice.wav", duration_s: 2, words }],
  }));
  return { dir, words };
}

describe("storybook measured caption narration coverage", () => {
  it.each([
    ["wrong word", ["The quick", "wolf jumps."]],
    ["missing word", ["The", "fox jumps."]],
    ["duplicated word", ["The quick", "fox fox jumps."]],
    ["reordered words", ["The fox", "quick jumps."]],
    ["joined words", ["Thequick", "fox jumps."]],
  ])("rejects %s despite an exact voice text", (_label, phrases) => {
    const { dir } = fixture(phrases as string[]);
    const result = spawnSync(process.execPath, [captions, dir], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /measured words do not match manifest narration in order/);
    assert.equal(existsSync(join(dir, "caption_groups.json")), false);
    assert.equal(existsSync(join(dir, "captions.srt")), false);
  });

  it("accepts ordered measured phrases with established case/punctuation normalization and preserves spans", () => {
    const { dir, words } = fixture(["THE QUICK", "fox jumps!"]);
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
      `import { buildCaptions } from ${JSON.stringify(captions)}; console.log(JSON.stringify(buildCaptions(process.argv[1]).data));`, dir], { encoding: "utf8" }));
    assert.deepEqual(result.groups.flatMap((group: { words: unknown[] }) => group.words), words);
    assert.equal(result.groups[0].text, "THE QUICK fox jumps!");
    assert.equal(result.groups[0].start, 0.1);
    assert.equal(result.groups[0].end, 0.6);
  });
});

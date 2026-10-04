import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "vitest";

const helper = resolve("omp-skills/omp-video-pipeline/scripts/production-contract.mjs");
const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "contract-test-"));
  temporary.push(dir);
  const briefFile = join(dir, "brief.json");
  const briefData = {
    pipeline: "hyperframes-storybook",
    spec: {
      style: "storybook-flat",
      format: "landscape",
      voice: "am_michael",
      narrationMode: "verbatim",
      music: "required",
    },
    durationSec: 6.0,
    brief: "A test storybook film about two friends.",
    permissions: {
      createAssets: true,
      generateAudio: true,
      renderVideo: true,
    },
  };
  writeFileSync(briefFile, JSON.stringify(briefData, null, 2));
  return { dir, briefFile, briefData };
}

describe("production contract helper CLI and boundaries", () => {
  it("refuses to overwrite an existing contract without --update and preserves it byte-for-byte", () => {
    const { dir, briefFile } = fixture();
    execFileSync(process.execPath, [helper, dir, "--input", briefFile], { encoding: "utf8" });

    const contractPath = join(dir, "production-contract.json");
    const originalBytes = readFileSync(contractPath);

    const result = spawnSync(process.execPath, [helper, dir, "--input", briefFile], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.deepEqual(readFileSync(contractPath), originalBytes);
  });

  it("rejects unsupported pipelines and invalid spec enums/types without creating a contract", () => {
    const { briefData } = fixture();

    // 1. Unsupported pipeline
    const badPipelineDir = mkdtempSync(join(tmpdir(), "bad-pipeline-"));
    temporary.push(badPipelineDir);
    const badPipelineFile = join(badPipelineDir, "bad-pipeline.json");
    writeFileSync(badPipelineFile, JSON.stringify({ ...briefData, pipeline: "unsupported-pipeline" }));
    const res1 = spawnSync(process.execPath, [helper, badPipelineDir, "--input", badPipelineFile], { encoding: "utf8" });
    assert.equal(res1.status, 1);
    assert.equal(existsSync(join(badPipelineDir, "production-contract.json")), false);

    // 2. Invalid format enum
    const badFormatDir = mkdtempSync(join(tmpdir(), "bad-format-"));
    temporary.push(badFormatDir);
    const badFormatFile = join(badFormatDir, "bad-format.json");
    writeFileSync(badFormatFile, JSON.stringify({ ...briefData, spec: { ...briefData.spec, format: "ultrawide" } }));
    const res2 = spawnSync(process.execPath, [helper, badFormatDir, "--input", badFormatFile], { encoding: "utf8" });
    assert.equal(res2.status, 1);
    assert.equal(existsSync(join(badFormatDir, "production-contract.json")), false);

    // 3. Invalid storybook style
    const badStyleDir = mkdtempSync(join(tmpdir(), "bad-style-"));
    temporary.push(badStyleDir);
    const badStyleFile = join(badStyleDir, "bad-style.json");
    writeFileSync(badStyleFile, JSON.stringify({ ...briefData, spec: { ...briefData.spec, style: "cartoon-3d" } }));
    const res3 = spawnSync(process.execPath, [helper, badStyleDir, "--input", badStyleFile], { encoding: "utf8" });
    assert.equal(res3.status, 1);
    assert.equal(existsSync(join(badStyleDir, "production-contract.json")), false);

    // 4. Invalid Kokoro voice
    const badVoiceDir = mkdtempSync(join(tmpdir(), "bad-voice-"));
    temporary.push(badVoiceDir);
    const badVoiceFile = join(badVoiceDir, "bad-voice.json");
    writeFileSync(badVoiceFile, JSON.stringify({ ...briefData, spec: { ...briefData.spec, voice: "unknown_voice" } }));
    const res4 = spawnSync(process.execPath, [helper, badVoiceDir, "--input", badVoiceFile], { encoding: "utf8" });
    assert.equal(res4.status, 1);
    assert.equal(existsSync(join(badVoiceDir, "production-contract.json")), false);

    // 5. Invalid narrationMode
    const badModeDir = mkdtempSync(join(tmpdir(), "bad-mode-"));
    temporary.push(badModeDir);
    const badModeFile = join(badModeDir, "bad-mode.json");
    writeFileSync(badModeFile, JSON.stringify({ ...briefData, spec: { ...briefData.spec, narrationMode: "improvised" } }));
    const res5 = spawnSync(process.execPath, [helper, badModeDir, "--input", badModeFile], { encoding: "utf8" });
    assert.equal(res5.status, 1);
    assert.equal(existsSync(join(badModeDir, "production-contract.json")), false);

    // 6. Invalid music
    const badMusicDir = mkdtempSync(join(tmpdir(), "bad-music-"));
    temporary.push(badMusicDir);
    const badMusicFile = join(badMusicDir, "bad-music.json");
    writeFileSync(badMusicFile, JSON.stringify({ ...briefData, spec: { ...briefData.spec, music: "heavy-metal" } }));
    const res6 = spawnSync(process.execPath, [helper, badMusicDir, "--input", badMusicFile], { encoding: "utf8" });
    assert.equal(res6.status, 1);
    assert.equal(existsSync(join(badMusicDir, "production-contract.json")), false);

    // 7. Malformed changedFrames (not array of numbers/strings)
    const badFramesDir = mkdtempSync(join(tmpdir(), "bad-frames-"));
    temporary.push(badFramesDir);
    const badFramesFile = join(badFramesDir, "bad-frames.json");
    writeFileSync(badFramesFile, JSON.stringify({ ...briefData, changedFrames: "not-an-array" }));
    const res7 = spawnSync(process.execPath, [helper, badFramesDir, "--input", badFramesFile], { encoding: "utf8" });
    assert.equal(res7.status, 1);
    assert.equal(existsSync(join(badFramesDir, "production-contract.json")), false);
  });

  it("fails when permissions are missing or non-boolean before modifying the contract", () => {
    // Missing permissions
    const missingPermDir = mkdtempSync(join(tmpdir(), "missing-perm-"));
    temporary.push(missingPermDir);
    const missingPermFile = join(missingPermDir, "bad-permissions.json");
    writeFileSync(missingPermFile, JSON.stringify({
      pipeline: "hyperframes-storybook",
      spec: {},
      durationSec: 5.0,
      brief: "Test",
    }));
    const res1 = spawnSync(process.execPath, [helper, missingPermDir, "--input", missingPermFile], { encoding: "utf8" });
    assert.equal(res1.status, 1);
    assert.equal(existsSync(join(missingPermDir, "production-contract.json")), false);

    // Non-boolean permissions
    const nonBoolPermDir = mkdtempSync(join(tmpdir(), "non-bool-perm-"));
    temporary.push(nonBoolPermDir);
    const nonBoolPermFile = join(nonBoolPermDir, "bad-permissions.json");
    writeFileSync(nonBoolPermFile, JSON.stringify({
      pipeline: "hyperframes-storybook",
      spec: {},
      durationSec: 5.0,
      brief: "Test",
      permissions: { createAssets: "yes", generateAudio: true, renderVideo: true },
    }));
    const res2 = spawnSync(process.execPath, [helper, nonBoolPermDir, "--input", nonBoolPermFile], { encoding: "utf8" });
    assert.equal(res2.status, 1);
    assert.equal(existsSync(join(nonBoolPermDir, "production-contract.json")), false);
  });

  it("preserves unchanged approved narration baseline during --update when no explicit replacement is provided", () => {
    const { dir, briefFile, briefData } = fixture();
    execFileSync(process.execPath, [helper, dir, "--input", briefFile], { encoding: "utf8" });

    // Simulate an approved baseline in existing contract
    const contractPath = join(dir, "production-contract.json");
    const existing = JSON.parse(readFileSync(contractPath, "utf8"));
    existing.narrationSource = "[NARRATION]\none: Approved baseline line.\n[/NARRATION]";
    writeFileSync(contractPath, JSON.stringify(existing, null, 2));

    // Also simulate a SCRIPT.md that might have different text
    writeFileSync(join(dir, "SCRIPT.md"), "## Frame 1 (shot one)\n    Different unapproved text.\n");

    const updateBriefFile = join(dir, "update-brief.json");
    const updatedBriefData = {
      ...briefData,
      durationSec: 7.0,
      revisionInstructions: "Refine timing",
      changedFrames: [1],
    };
    writeFileSync(updateBriefFile, JSON.stringify(updatedBriefData, null, 2));

    execFileSync(process.execPath, [helper, dir, "--input", updateBriefFile, "--update"], { encoding: "utf8" });

    const updatedContract = JSON.parse(readFileSync(contractPath, "utf8"));
    assert.equal(updatedContract.durationSec, 7.0);
    assert.equal(updatedContract.revisionInstructions, "Refine timing");
    assert.deepEqual(updatedContract.changedFrames, [1]);
    // Must preserve the existing approved narrationSource baseline!
    assert.equal(updatedContract.narrationSource, "[NARRATION]\none: Approved baseline line.\n[/NARRATION]");
  });

  it("replaces narration baseline when an explicit new narrationSource is provided on --update", () => {
    const { dir, briefFile, briefData } = fixture();
    execFileSync(process.execPath, [helper, dir, "--input", briefFile], { encoding: "utf8" });

    const contractPath = join(dir, "production-contract.json");
    const existing = JSON.parse(readFileSync(contractPath, "utf8"));
    existing.narrationSource = "[NARRATION]\none: Old baseline line.\n[/NARRATION]";
    writeFileSync(contractPath, JSON.stringify(existing, null, 2));

    // Brief with explicit replacement narration
    const updateBriefFile = join(dir, "explicit-narration-brief.json");
    const explicitNarration = "[NARRATION]\none: Replaced approved line.\n[/NARRATION]";
    const updatedBriefData = {
      ...briefData,
      narrationSource: explicitNarration,
      revisionInstructions: "Update script",
    };
    writeFileSync(updateBriefFile, JSON.stringify(updatedBriefData, null, 2));

    execFileSync(process.execPath, [helper, dir, "--input", updateBriefFile, "--update"], { encoding: "utf8" });

    const updatedContract = JSON.parse(readFileSync(contractPath, "utf8"));
    // Explicit replacement narration must win!
    assert.equal(updatedContract.narrationSource, explicitNarration);
    assert.equal(updatedContract.revisionInstructions, "Update script");
  });

  it("fails on --update if the existing contract is invalid and preserves existing file byte-for-byte", () => {
    const { dir, briefFile, briefData } = fixture();
    execFileSync(process.execPath, [helper, dir, "--input", briefFile], { encoding: "utf8" });

    // Corrupt existing contract
    const contractPath = join(dir, "production-contract.json");
    const corrupted = JSON.stringify({ pipeline: "corrupted", spec: null }) + "\n";
    writeFileSync(contractPath, corrupted);

    const updateBriefFile = join(dir, "update.json");
    writeFileSync(updateBriefFile, JSON.stringify(briefData));

    const result = spawnSync(process.execPath, [helper, dir, "--input", updateBriefFile, "--update"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(readFileSync(contractPath, "utf8"), corrupted);
  });
});

#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseScript } from "../../omp-storybook-pipeline/scripts/acceptance.mjs";

export const SUPPORTED_PIPELINES = ["hyperframes-explainer", "hyperframes-storybook"];

export const FORMATS = {
  landscape: "1920x1080",
  portrait: "1080x1920",
  square: "1080x1080",
};

export const VOICES = [
  "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
];

export const NARRATION_MODES = ["verbatim", "restructured"];
export const MUSIC_OPTIONS = ["required", "none"];

export function validateBriefInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("brief input must be an object");
  }

  if (typeof input.pipeline !== "string" || !SUPPORTED_PIPELINES.includes(input.pipeline)) {
    throw new Error(`unsupported or missing pipeline: "${input?.pipeline}"; must be one of: ${SUPPORTED_PIPELINES.join(", ")}`);
  }

  if (!input.spec || typeof input.spec !== "object" || Array.isArray(input.spec)) {
    throw new Error("spec must be an object");
  }

  const { spec } = input;
  if (spec.format !== undefined && !Object.keys(FORMATS).includes(spec.format)) {
    throw new Error(`invalid format "${spec.format}"; must be one of: ${Object.keys(FORMATS).join(", ")}`);
  }

  if (input.pipeline === "hyperframes-storybook") {
    if (spec.style !== undefined && spec.style !== "storybook-flat") {
      throw new Error(`invalid style "${spec.style}" for hyperframes-storybook; must be "storybook-flat"`);
    }
  } else if (spec.style !== undefined && (typeof spec.style !== "string" || !spec.style.trim())) {
    throw new Error("spec.style for hyperframes-explainer must be a non-empty string");
  }

  if (spec.voice !== undefined && !VOICES.includes(spec.voice)) {
    throw new Error(`invalid voice "${spec.voice}"; must be one of Kokoro English voices`);
  }

  if (spec.narrationMode !== undefined && !NARRATION_MODES.includes(spec.narrationMode)) {
    throw new Error(`invalid narrationMode "${spec.narrationMode}"; must be one of: ${NARRATION_MODES.join(", ")}`);
  }

  if (spec.music !== undefined && !MUSIC_OPTIONS.includes(spec.music)) {
    throw new Error(`invalid music option "${spec.music}"; must be one of: ${MUSIC_OPTIONS.join(", ")}`);
  }

  if (spec.audience !== undefined && (typeof spec.audience !== "string" || spec.audience.length > 200)) {
    throw new Error("spec.audience must be a string up to 200 characters");
  }

  if (spec.tone !== undefined && (typeof spec.tone !== "string" || spec.tone.length > 200)) {
    throw new Error("spec.tone must be a string up to 200 characters");
  }

  if (typeof input.durationSec !== "number" || !Number.isFinite(input.durationSec) || input.durationSec <= 0) {
    throw new Error("durationSec must be a positive finite number");
  }

  if (typeof input.brief !== "string" || !input.brief.trim()) {
    throw new Error("brief must be a non-empty string");
  }

  if (!input.permissions || typeof input.permissions !== "object" || Array.isArray(input.permissions)) {
    throw new Error("permissions must be an object with {createAssets, generateAudio, renderVideo}");
  }

  const { createAssets, generateAudio, renderVideo } = input.permissions;
  if (typeof createAssets !== "boolean" || typeof generateAudio !== "boolean" || typeof renderVideo !== "boolean") {
    throw new Error("permissions must specify boolean values for createAssets, generateAudio, and renderVideo");
  }

  if (input.revisionInstructions !== undefined && typeof input.revisionInstructions !== "string") {
    throw new Error("revisionInstructions must be a string when provided");
  }

  if (input.approvalNotes !== undefined && typeof input.approvalNotes !== "string") {
    throw new Error("approvalNotes must be a string when provided");
  }

  if (input.narrationSource !== undefined && typeof input.narrationSource !== "string") {
    throw new Error("narrationSource must be a string when provided");
  }

  if (input.changedFrames !== undefined) {
    if (!Array.isArray(input.changedFrames) || !input.changedFrames.every(f => typeof f === "number" || typeof f === "string")) {
      throw new Error("changedFrames must be an array of numbers or strings when provided");
    }
  }
}

export function normalizeSpec(pipeline, spec) {
  const isStorybook = pipeline === "hyperframes-storybook";
  return {
    ...spec,
    style: spec.style ?? (isStorybook ? "storybook-flat" : "auto"),
    format: spec.format ?? "landscape",
    voice: spec.voice ?? "am_michael",
    audience: spec.audience ?? (isStorybook ? "families" : "developers"),
    tone: spec.tone ?? (isStorybook ? "warm, gentle, character-led" : "clear, friendly, technical"),
    narrationMode: spec.narrationMode ?? (isStorybook ? "verbatim" : "restructured"),
    music: spec.music ?? (isStorybook ? "required" : "none"),
  };
}

export function createProductionContract(projectDir, briefInput, options = {}) {
  if (!projectDir || typeof projectDir !== "string") {
    throw new Error("PROJECT_DIR must be specified");
  }
  if (!isAbsolute(projectDir)) {
    throw new Error(`PROJECT_DIR must be an absolute path: ${projectDir}`);
  }

  validateBriefInput(briefInput);

  const contractPath = join(projectDir, "production-contract.json");
  const contractExists = existsSync(contractPath);

  if (contractExists && !options.update) {
    throw new Error(`production-contract.json already exists at ${contractPath}; pass --update to modify`);
  }

  let existing = null;
  if (contractExists && options.update) {
    try {
      existing = JSON.parse(readFileSync(contractPath, "utf8"));
    } catch (err) {
      throw new Error(`failed to parse existing contract at ${contractPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Validate existing contract structure before update to prevent invalid silent fallback
    try {
      validateBriefInput(existing);
    } catch (err) {
      throw new Error(`existing contract at ${contractPath} is invalid: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const normalizedSpec = normalizeSpec(briefInput.pipeline, briefInput.spec);

  const revisionInstructions = briefInput.revisionInstructions !== undefined
    ? briefInput.revisionInstructions
    : (existing?.revisionInstructions !== undefined ? existing.revisionInstructions : "");

  const changedFrames = briefInput.changedFrames !== undefined
    ? briefInput.changedFrames
    : (existing?.changedFrames !== undefined ? existing.changedFrames : []);

  const approvalNotes = briefInput.approvalNotes !== undefined
    ? briefInput.approvalNotes
    : (existing?.approvalNotes !== undefined ? existing.approvalNotes : "");

  // Explicit new narrationSource wins; otherwise preserve old approved baseline; otherwise capture SCRIPT.md without swallowing errors.
  let narrationSource;
  if (briefInput.narrationSource !== undefined) {
    narrationSource = briefInput.narrationSource;
  } else if (existing?.narrationSource !== undefined) {
    narrationSource = existing.narrationSource;
  } else if (normalizedSpec.narrationMode === "verbatim") {
    const scriptPath = join(projectDir, "SCRIPT.md");
    if (existsSync(scriptPath)) {
      const baseline = parseScript(scriptPath);
      if (baseline.length > 0) {
        narrationSource = "[NARRATION]\n" + baseline.map(line => `${line.shotId}: ${line.text}`).join("\n") + "\n[/NARRATION]";
      }
    }
  }

  const contract = {
    pipeline: briefInput.pipeline,
    spec: normalizedSpec,
    durationSec: briefInput.durationSec,
    brief: briefInput.brief,
    permissions: {
      createAssets: briefInput.permissions.createAssets,
      generateAudio: briefInput.permissions.generateAudio,
      renderVideo: briefInput.permissions.renderVideo,
    },
    revisionInstructions,
    changedFrames,
    approvalNotes,
    ...(narrationSource !== undefined ? { narrationSource } : {}),
  };

  mkdirSync(projectDir, { recursive: true });
  writeFileSync(contractPath, JSON.stringify(contract, null, 2) + "\n");
  return contract;
}

function printUsageAndExit(exitCode = 0) {
  console.log("Usage: node production-contract.mjs <absolute PROJECT_DIR> --input <absolute brief.json> [--update]");
  process.exit(exitCode);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    printUsageAndExit(args.includes("--help") ? 0 : 2);
  }

  let projectDir = null;
  let inputPath = null;
  let update = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help") {
      printUsageAndExit(0);
    } else if (arg === "--update") {
      update = true;
    } else if (arg === "--input") {
      i++;
      if (i >= args.length) {
        console.error("Error: --input requires a path argument");
        process.exit(1);
      }
      inputPath = args[i];
    } else if (!arg.startsWith("-") && !projectDir) {
      projectDir = arg;
    } else {
      console.error(`Error: unexpected argument "${arg}"`);
      process.exit(1);
    }
  }

  if (!projectDir) {
    console.error("Error: absolute PROJECT_DIR argument is required");
    process.exit(1);
  }
  if (!isAbsolute(projectDir)) {
    console.error(`Error: PROJECT_DIR must be an absolute path: ${projectDir}`);
    process.exit(1);
  }

  if (!inputPath) {
    console.error("Error: --input <absolute brief.json> is required");
    process.exit(1);
  }
  if (!isAbsolute(inputPath)) {
    console.error(`Error: --input path must be an absolute path: ${inputPath}`);
    process.exit(1);
  }
  if (!existsSync(inputPath)) {
    console.error(`Error: input brief file does not exist: ${inputPath}`);
    process.exit(1);
  }

  let briefData;
  try {
    briefData = JSON.parse(readFileSync(inputPath, "utf8"));
  } catch (err) {
    console.error(`Error: failed to parse JSON from ${inputPath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  try {
    const contract = createProductionContract(projectDir, briefData, { update });
    const contractPath = join(projectDir, "production-contract.json");
    console.log(`PASS production contract written: ${contractPath}`);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

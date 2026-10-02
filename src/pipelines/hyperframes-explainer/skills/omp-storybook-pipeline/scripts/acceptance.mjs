#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import {
  COMPILED_FILENAME,
  COMPOSITION_FILENAME,
  loadManifest,
  manifestHash,
  projectPath,
  readJson,
  sha256Bytes,
  sha256File,
  stableStringify,
} from "./storybook-schema.mjs";
import { prepareCaptions } from "./captions.mjs";
import { buildAudioPlan, inspectAudioMounts, verifyRenderedAudio } from "./audio-evidence.mjs";
import { inspectMotionTiming } from "./motion-timing.mjs";
import { verifyVisualEvidence, verifyRenderedVisuals } from "./visual-evidence.mjs";

const ACCEPTANCE_FILENAME = "acceptance.json";

function fail(message) {
  throw new Error(message);
}

function readOptionalJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (error) { fail(`invalid JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`); }
}

function number(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be a finite number`);
  return value;
}

function audioProbe(projectDir, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.startsWith("/")) fail(`audio path must be project-relative: ${relativePath ?? "(missing)"}`);
  const absolute = projectPath(projectDir, relativePath, "audio path");
  if (!existsSync(absolute)) fail(`audio file missing at ${absolute}`);
  const result = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", absolute], { encoding: "utf8" });
  if (result.status !== 0) fail(`ffprobe failed for audio ${relativePath}`);
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { fail(`ffprobe returned invalid JSON for audio ${relativePath}`); }
  const durationSec = Number(parsed.format?.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) fail(`audio ${relativePath} has no measured positive duration`);
  if (!(parsed.streams ?? []).some(stream => stream.codec_type === "audio")) fail(`audio ${relativePath} has no audio stream`);
  return { path: relativePath, sha256: sha256File(absolute), durationSec };
}

function normaliseNarrationText(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

export function parseScript(scriptPath) {
  const source = readFileSync(scriptPath, "utf8");
  const lines = source.split(/\r?\n/);
  const result = [];
  let current = null;
  const flush = () => {
    if (current && current.text.trim()) result.push({ shotId: current.shotId, text: current.text.trim() });
    current = null;
  };
  for (const line of lines) {
    const heading = line.match(/^#{2,3}\s+.*?\((?:shot|frame)\s+([^\)]+)\)/i) ?? line.match(/^#{2,3}\s+(?:shot|frame)\s*[:#-]?\s*([A-Za-z0-9_-]+)/i);
    if (heading) {
      flush();
      current = { shotId: heading[1].trim(), text: "" };
      continue;
    }
    if (!current || /^\s*\*\*/.test(line) || /^\s*[-*]\s+(?:duration|visual|beat|voiceover)\s*:/i.test(line)) continue;
    const indented = line.match(/^(?: {2,}|\t)(.+)$/);
    if (indented) current.text += `${current.text ? " " : ""}${indented[1].trim()}`;
  }
  flush();
  return result;
}

function explicitContractNarration(contract) {
  for (const source of [contract?.approvalNotes, contract?.revisionInstructions, contract?.narrationSource, contract?.brief]) {
    if (!source) continue;
    const block = String(source).match(/\[NARRATION\]([\s\S]*?)\[\/NARRATION\]/i);
    if (block) {
      const lines = block[1].split(/\r?\n/).filter(line => line.trim()).map(line => {
        const match = line.match(/^\s*(?:shot|frame)?\s*([A-Za-z0-9_-]+)\s*:\s*(.+)$/i);
        if (!match) fail("explicit [NARRATION] source must use `shot-id: exact text` lines");
        return { shotId: match[1], text: match[2].trim() };
      });
      if (!lines.length) fail("explicit [NARRATION] source is empty");
      return lines;
    }
    const lines = [...String(source).matchAll(/^\s*VO:\s*(.+)$/gim)].map(match => ({ shotId: null, text: match[1].trim() }));
    if (lines.length) return lines;
  }
  if (/\b(?:exact|verbatim)\s+(?:approved\s+)?(?:narration|voiceover)\b/i.test(String(contract?.brief ?? ""))) {
    fail("exact narration needs ordered `VO: text` lines or a [NARRATION] source block in the brief");
  }
  return [];
}

function authoredNarration(projectDir, manifest, contract) {
  if (manifest.requirements.narration === "none") {
    if (explicitContractNarration(contract).length) fail("explicit contract narration cannot be omitted");
    return { scriptPath: null, lines: [] };
  }
  const scriptPath = projectPath(projectDir, manifest.narration.scriptPath, "narration script");
  if (!existsSync(scriptPath)) fail(`verbatim narration requires ${manifest.narration.scriptPath}`);
  const scriptLines = parseScript(scriptPath);
  if (!scriptLines.length) fail(`narration script ${manifest.narration.scriptPath} has no authored shot lines`);
  const manifestLines = manifest.narration.lines;
  if (manifestLines.length !== scriptLines.length) fail(`manifest narration has ${manifestLines.length} lines but SCRIPT.md has ${scriptLines.length}`);
  for (const [index, line] of manifestLines.entries()) {
    const scriptLine = scriptLines[index];
    if (line.shotId !== scriptLine.shotId || line.text !== scriptLine.text) fail(`manifest narration line ${index + 1} is not verbatim SCRIPT.md (${line.shotId} != ${scriptLine.shotId} or text differs)`);
  }
  const explicitSource = explicitContractNarration(contract);
  if (explicitSource.length) {
    if (explicitSource.length !== manifestLines.length) fail("manifest narration does not contain every explicit source line");
    for (const [index, line] of explicitSource.entries()) {
      const candidate = manifestLines[index];
      const pattern = new RegExp(`(?:voiceover|narration)\\s+(?:for\\s+)?(?:shot|frame)?\\s*${candidate.shotId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(.+)$`, "im");
      const replacement = [contract?.approvalNotes, contract?.revisionInstructions].map(source => String(source ?? "").match(pattern)).find(Boolean);
      const expected = replacement ? replacement[1].trim() : line.text;
      if ((line.shotId && candidate.shotId !== line.shotId) || candidate.text !== expected) fail(`manifest narration for ${candidate.shotId} does not match explicit contract narration`);
    }
  }
  const revision = contract?.revisionInstructions;
  const changed = Array.isArray(contract?.changedFrames) ? contract.changedFrames.map(value => String(value)) : [];
  if (revision && changed.length) {
    const explicit = new Map();
    const pattern = /(?:voiceover|narration)\s+(?:for\s+)?(?:shot|frame)?\s*([A-Za-z0-9_-]+)\s*:\s*(.+)$/gim;
    for (const match of String(revision).matchAll(pattern)) explicit.set(match[1], match[2].trim());
    for (const frame of changed) {
      if (!explicit.has(frame)) continue;
      const candidate = manifestLines.find(line => line.shotId === frame || line.shotId === `shot-${frame}` || line.shotId === `frame-${frame}`);
      if (!candidate) fail(`revision instruction names voiceover ${frame}, but manifest has no matching narration line`);
      if (candidate.text !== explicit.get(frame)) fail(`revision voiceover ${frame} does not exactly match manifest narration`);
    }
  }
  return { scriptPath: manifest.narration.scriptPath, lines: manifestLines };
}

function inspectAudio(projectDir, manifest, contract) {
  const path = join(projectDir, "audio_meta.json");
  const enginePath = join(projectDir, "audio_engine_meta.json");
  const metadata = readOptionalJson(path);
  const engineMetadata = readOptionalJson(enginePath);
  const required = manifest.requirements.narration === "required" || manifest.requirements.music === "required";
  if (!metadata && !engineMetadata) {
    if (required) fail("audio_meta.json or audio_engine_meta.json is required by the manifest requirements");
    return { metadataPath: null, narration: [], music: null };
  }
  const narration = [];
  const voiceMetadata = Array.isArray(metadata?.voices) && metadata.voices.length ? metadata.voices : (engineMetadata?.voices ?? []);
  if (manifest.requirements.narration === "required") {
    if (!Array.isArray(voiceMetadata) || voiceMetadata.length === 0) fail("audio metadata has no measured narration voices");
    if (voiceMetadata.length !== manifest.narration.lines.length) fail("measured narration must cover every authored shot");
    for (const voice of voiceMetadata) {
      if (!voice || typeof voice !== "object") fail("audio metadata has an invalid narration entry");
      const index = narration.length;
      if (voice.text !== manifest.narration.lines[index].text || voice.voice !== contract.spec.voice) fail(`measured narration ${index + 1} does not match the approved text/voice`);
      const words = Array.isArray(voice.words) ? voice.words : [];
      if (!words.length) fail(`narration frame ${voice.frame ?? voice.id ?? "?"} has no word timestamps from the combined ASR pass`);
      let previousEnd = 0;
      for (const word of words) {
        const start = number(word.start, "word.start");
        const end = number(word.end, "word.end");
        if (end <= start || start < previousEnd) fail("word timestamps must be positive and monotonic");
        previousEnd = end;
      }
      const measured = audioProbe(projectDir, voice.path);
      const duration = Number(voice.duration_s);
      const shot = manifest.shots.find(item => item.id === manifest.narration.lines[index].shotId);
      if (!shot || Math.abs(measured.durationSec - shot.durationSec) > 0.04) fail(`narration ${index + 1} does not fit its approved beat`);
      if (!Number.isFinite(duration) || duration <= 0) fail(`narration ${voice.path} has no measured duration_s`);
      if (voice.sha256 && voice.sha256 !== measured.sha256) fail(`narration ${voice.path} hash does not match measured audio`);
      narration.push({ frame: voice.frame ?? voice.id ?? null, ...measured, metadataDurationSec: duration, wordCount: words.length });
    }
  } else if (voiceMetadata.length) {
    fail("audio metadata contains narration although requirements.narration is none");
  }
  let music = null;
  const bedMetadata = metadata?.bgm ?? engineMetadata?.bgm ?? null;
  if (manifest.requirements.music === "required") {
    if (!bedMetadata || typeof bedMetadata !== "object" || !bedMetadata.path) fail("audio metadata has no measured required music bed");
    const provenance = bedMetadata.provenance;
    if (!provenance || typeof provenance !== "object" || !provenance.generator || !provenance.source || !provenance.license) fail("required music must include generator/source/license provenance");
    if (metadata?.bgm?.path && engineMetadata?.bgm?.path && metadata.bgm.path !== engineMetadata.bgm.path) fail("audio_meta.json and audio_engine_meta.json disagree on the music path");
    music = { ...audioProbe(projectDir, bedMetadata.path), metadataDurationSec: Number(bedMetadata.duration_s), provenance };
    if (music.durationSec < manifest.durationSec - 0.04) fail("required music does not cover the complete story");
    if (!Number.isFinite(music.metadataDurationSec) || music.metadataDurationSec <= 0) fail("required music has no measured duration_s");
    if (bedMetadata.sha256 && bedMetadata.sha256 !== music.sha256) fail("required music hash does not match measured audio");
    if (metadata?.bgm_pending || engineMetadata?.bgm_pending) fail("audio metadata still marks music pending");
  } else if (metadata?.bgm || metadata?.bgm_pending || engineMetadata?.bgm || engineMetadata?.bgm_pending) {
    fail("audio metadata contains music although requirements.music is none");
  }
  return {
    metadataPath: metadata ? "audio_meta.json" : "audio_engine_meta.json",
    metadataSha256: metadata ? sha256File(path) : null,
    engineMetadataPath: engineMetadata ? "audio_engine_meta.json" : null,
    engineMetadataSha256: engineMetadata ? sha256File(enginePath) : null,
    narration,
    music,
  };
}

function inspectCaptions(projectDir, manifest, audit) {
  const plan = prepareCaptions(projectDir);
  const dataPath = join(projectDir, "caption_groups.json");
  if (manifest.requirements.narration === "none") {
    if (audit.captions != null) fail("browser caption evidence must be absent when narration is none");
    if (existsSync(dataPath) && JSON.stringify(readJson(dataPath, "caption groups")) !== JSON.stringify(plan.data)) fail("silent storybook caption groups must be empty and current");
    for (const [name, text] of [["transcript.txt", ""], ["captions.srt", ""], ["captions.vtt", plan.vtt]]) {
      const path = join(projectDir, name);
      if (existsSync(path) && readFileSync(path, "utf8") !== text) fail(`${name} must be empty when narration is none`);
    }
    return null;
  }
  const data = readJson(dataPath, "caption groups");
  if (JSON.stringify(data) !== JSON.stringify(plan.data)) fail("caption groups differ from current measured narration");
  if (audit.captions?.path !== "caption_groups.json" || audit.captions.sha256 !== sha256File(dataPath)) fail("browser caption evidence is missing or stale");
  const artifacts = [];
  for (const [name, text] of [["transcript.txt", plan.transcript ? `${plan.transcript}\n` : ""], ["captions.srt", plan.srt], ["captions.vtt", plan.vtt]]) {
    const path = join(projectDir, name);
    if (!existsSync(path) || readFileSync(path, "utf8") !== text) fail(`${name} differs from current measured captions`);
    artifacts.push({ path: name, sha256: sha256File(path) });
  }
  return { path: "caption_groups.json", sha256: sha256File(dataPath), artifacts };
}

function visualReview(projectDir, manifest, audit) {
  verifyVisualEvidence(projectDir, audit);
  const name = ".hyperframes/storybook-audit/visual-review.json";
  const path = join(projectDir, name);
  if (!existsSync(path)) fail(`${name} is required after inspecting the real-browser contact artifacts`);
  const review = readOptionalJson(path);
  if (!review || review.kind !== "hyperframes-storybook-visual-review") fail(`${name} has the wrong kind`);
  if (review.verdict !== "approved") fail(`${name} must record a human/agent visual verdict of approved`);
  if (!review.sourceDigest || review.sourceDigest !== audit.evidence?.digest) fail(`${name} sourceDigest does not match the current browser evidence digest`);
  if (!Array.isArray(review.evidence) || review.evidence.length === 0) fail(`${name} must list inspected screenshot evidence`);
  const auditEvidence = new Set(audit.evidence?.screenshots ?? []);
  for (const evidencePath of review.evidence) {
    if (!auditEvidence.has(evidencePath)) fail(`${name} references evidence not emitted by the current audit: ${evidencePath}`);
    if (!existsSync(join(projectDir, evidencePath))) fail(`${name} references missing evidence file ${evidencePath}`);
  }
  if (!Array.isArray(review.shots) || review.shots.length !== manifest.shots.length) fail(`${name} must contain one observation for every manifest shot`);
  for (const shot of manifest.shots) {
    const observed = review.shots.find(candidate => candidate.shotId === shot.id);
    if (!observed) fail(`${name} is missing observations for shot ${shot.id}`);
    for (const key of ["style", "continuity", "acting", "captions"]) {
      if (typeof observed[key] !== "string" || observed[key].trim().length < 10) fail(`${name} shot ${shot.id} needs a substantive ${key} observation`);
    }
  }
  return { path: name, sha256: sha256File(path), sourceDigest: review.sourceDigest, verdict: review.verdict };
}

function compiledSourceProof(root, manifest, compiled) {
  if (!Array.isArray(compiled.characters) || !Array.isArray(compiled.backgrounds) || !Array.isArray(compiled.assets)) fail("compiled asset manifest is missing character/background/asset source lists");
  const verify = (items, label) => items.map(item => {
    const file = projectPath(root, item.path, `${label} path`);
    if (!existsSync(file)) fail(`${label} missing at ${file}`);
    const sha256 = sha256File(file);
    if (sha256 !== item.sha256) fail(`stale asset hash for ${item.path}: ${item.sha256} != ${sha256}`);
    return { ...item, sha256 };
  });
  const characters = verify(compiled.characters, "compiled character");
  const backgrounds = verify(compiled.backgrounds, "compiled background");
  const assets = verify(compiled.assets, "compiled asset");
  for (const character of manifest.characters) {
    const actual = characters.find(item => item.id === character.id);
    if (!actual || actual.path !== character.path || actual.width !== character.width || actual.height !== character.height) fail(`compiled character ${character.id} is not bound to the current manifest`);
  }
  for (const background of manifest.backgrounds) {
    const actual = backgrounds.find(item => item.id === background.id);
    if (!actual || actual.path !== background.path) fail(`compiled background ${background.id} is not bound to the current manifest`);
  }
  const digest = sha256Bytes(Buffer.from(stableStringify({ characters, backgrounds, assets }), "utf8"));
  if (digest !== compiled.sourceDigest) fail(`stale asset source digest: ${compiled.sourceDigest} != ${digest}`);
  return { characters, backgrounds, assets, digest };
}

function buildReport(projectDir, requireVideo, reportedVideo) {
  const root = resolve(projectDir);
  const { manifest } = loadManifest(root);
  const compiledPath = projectPath(root, COMPILED_FILENAME, "compiled asset manifest");
  if (!existsSync(compiledPath)) fail(`compiled asset manifest missing at ${compiledPath}`);
  const compiled = readJson(compiledPath, "compiled asset manifest");
  if (compiled.schemaVersion !== 1 || compiled.kind !== "hyperframes-storybook-assets-manifest") fail("compiled asset manifest has the wrong schema kind");
  const actualManifestHash = manifestHash(manifest);
  if (actualManifestHash !== compiled.manifestSha256) fail(`stale storybook manifest hash: ${compiled.manifestSha256} != ${actualManifestHash}`);
  if (compiled.style !== manifest.style || stableStringify(compiled.canvas) !== stableStringify(manifest.canvas) || Math.abs(Number(compiled.durationSec) - manifest.durationSec) > 0.001 || stableStringify(compiled.requirements) !== stableStringify(manifest.requirements)) {
    fail("compiled asset manifest duration/canvas/style/requirements are stale");
  }
  const source = compiledSourceProof(root, manifest, compiled);
  if (compiled.composition?.path !== COMPOSITION_FILENAME) fail(`compiled composition must be ${COMPOSITION_FILENAME}`);
  const compositionPath = projectPath(root, compiled.composition?.path, "compiled composition");
  if (!existsSync(compositionPath)) fail("compiled composition is missing");
  const compositionSha256 = sha256File(compositionPath);
  if (compositionSha256 !== compiled.composition.sha256) fail(`stale compiled composition hash: ${compiled.composition.sha256} != ${compositionSha256}`);
  const indexPath = join(root, "index.html");
  if (!existsSync(indexPath)) fail("index.html is missing");
  const auditPath = join(root, ".hyperframes/storybook-audit.json");
  if (!existsSync(auditPath)) fail("real-browser storybook audit report is missing; run audit-storybook.mjs");
  const audit = readJson(auditPath, "storybook audit report");
  const video = audit.video;
  if (reportedVideo !== undefined && (!requireVideo || !video?.path || !existsSync(resolve(root, reportedVideo)) || !existsSync(resolve(root, video.path)) || realpathSync(resolve(root, reportedVideo)) !== realpathSync(resolve(root, video.path)))) fail("reported video path does not match audited final video");
  if (audit.status !== "pass") fail(`storybook browser audit status is ${audit.status}`);
  if (audit.nativeLint?.ok !== true || audit.nativeLint.errorCount !== 0) fail("native HyperFrames lint proof is missing or failed");
  if (audit.source?.digest !== source.digest || audit.manifest?.sha256 !== actualManifestHash || audit.composition?.sha256 !== compositionSha256) fail("storybook browser audit source evidence is stale");
  if (audit.compiled?.sha256 !== sha256File(compiledPath)) fail("storybook browser audit compiled evidence is stale");
  const indexSha256 = sha256File(indexPath);
  if (audit.index?.sha256 !== indexSha256) fail("storybook browser audit index evidence is stale");
  if (JSON.stringify(audit.requirements) !== JSON.stringify(manifest.requirements)) fail("storybook browser audit requirements do not match manifest requirements");
  const contractPath = join(root, "production-contract.json");
  if (!existsSync(contractPath)) fail("production-contract.json is required");
  const contract = readOptionalJson(contractPath);
  if (!contract || contract.pipeline !== "hyperframes-storybook") fail("production-contract.json has the wrong pipeline");
  if (!contract.spec || typeof contract.spec !== "object") fail("production-contract.json has no spec");
  if (contract.spec.style !== manifest.style || contract.spec.format !== manifest.format) fail("storybook style/format does not match production contract");
  if (contract.spec.music !== manifest.requirements.music) fail(`music requirement ${manifest.requirements.music} does not match production contract ${contract.spec.music ?? "(missing)"}`);
  if (contract.spec.narrationMode !== manifest.requirements.narrationMode) fail(`narrationMode ${manifest.requirements.narrationMode} does not match production contract ${contract.spec.narrationMode ?? "(missing)"}`);
  const contractDuration = number(contract.durationSec, "production-contract.durationSec");
  if (Math.abs(contractDuration - manifest.durationSec) > 1e-6) fail(`manifest duration ${manifest.durationSec} does not exactly match production contract ${contractDuration}`);
  const authored = authoredNarration(root, manifest, contract);
  const audio = inspectAudio(root, manifest, contract);
  const captions = inspectCaptions(root, manifest, audit);
  const audioPlan = buildAudioPlan(root, manifest);
  if (JSON.stringify(audit.audio?.plan) !== JSON.stringify(audioPlan)) fail("browser audio plan is missing or stale");
  const mountedAudio = inspectAudioMounts(audioPlan, audit.audio?.mounts, root);
  if (JSON.stringify(audit.audio.mounted) !== JSON.stringify(mountedAudio)) fail("browser audio mount evidence is stale");
  const motionPath = join(root, existsSync(join(root, "audio_meta.json")) ? "audio_meta.json" : "audio_engine_meta.json");
  const motionTiming = { metadataSha256: existsSync(motionPath) ? sha256File(motionPath) : null, evidence: inspectMotionTiming(manifest, readOptionalJson(motionPath)) };
  if (JSON.stringify(audit.motionTiming) !== JSON.stringify(motionTiming)) fail("motion timing evidence is missing or stale");
  let renderedAudio = null;
  const review = visualReview(root, manifest, audit);
  if (!existsSync(join(root, ".hyperframes/storybook-audit/contact.json"))) fail("storybook contact artifact is missing");
  let renderedVisuals = null;
  if (requireVideo) {
    if (!video || !video.path) fail("final video proof is missing; run audit-storybook.mjs --video renders/video.mp4");
    const videoPath = projectPath(root, video.path, "final video");
    if (!existsSync(videoPath)) fail(`final video missing at ${videoPath}`);
    if (sha256File(videoPath) !== video.sha256) fail("final video hash differs from browser audit proof");
    if (Math.abs(Number(video.durationSec) - contractDuration) > 0.08) fail(`final video duration ${video.durationSec} does not match production contract ${contractDuration}`);
    renderedAudio = verifyRenderedAudio(root, manifest, audioPlan, videoPath, mountedAudio.mixOrder);
    if (JSON.stringify(audit.audio.rendered) !== JSON.stringify(renderedAudio)) fail("rendered audio evidence is missing or stale");
    renderedVisuals = verifyRenderedVisuals(root, audit);
    if (stableStringify(audit.visuals) !== stableStringify(renderedVisuals)) fail("rendered visual evidence is missing or stale");
  } else if (video) {
    fail("preview acceptance must not contain final video proof");
  }
  return {
    schemaVersion: 1,
    kind: "hyperframes-storybook-acceptance",
    status: "accepted",
    requireVideo,
    productionContract: { path: "production-contract.json", sha256: sha256File(contractPath), durationSec: contractDuration },
    manifest: { path: "storybook.json", sha256: actualManifestHash, durationSec: manifest.durationSec, requirements: manifest.requirements },
    source: { digest: source.digest, characters: source.characters, backgrounds: source.backgrounds, assets: source.assets },
    composition: { path: compiled.composition.path, sha256: compositionSha256 },
    index: { path: "index.html", sha256: indexSha256 },
    authoredNarration: authored,
    audio,
    audioEvidence: { plan: audioPlan, mounted: mountedAudio, rendered: renderedAudio },
    motionTiming,
    captions,
    browserAudit: { path: ".hyperframes/storybook-audit.json", sha256: sha256File(auditPath), evidence: audit.evidence },
    video,
    visualEvidence: renderedVisuals,
    visualReview: review,
  };
}

export function validateAcceptance(projectDir, requireVideo, reportedVideo = undefined) {
  const root = resolve(projectDir);
  const acceptancePath = join(root, ACCEPTANCE_FILENAME);
  try {
    const report = buildReport(root, Boolean(requireVideo), reportedVideo);
    mkdirSync(root, { recursive: true });
    writeFileSync(acceptancePath, `${JSON.stringify(report, null, 2)}\n`);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(acceptancePath, `${JSON.stringify({ schemaVersion: 1, kind: "hyperframes-storybook-acceptance", status: "rejected", requireVideo: Boolean(requireVideo), error: message }, null, 2)}\n`);
    } catch {
      // The caller still receives the useful validation error if the project path is not writable.
    }
    return message;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.length === 0) {
    console.log("Usage: node acceptance.mjs <PROJECT_DIR> [--require-video]");
    process.exit(argv.includes("--help") ? 0 : 2);
  }
  const error = validateAcceptance(argv[0], argv.includes("--require-video"));
  if (error) {
    console.error(`✗ ${error}`);
    process.exit(1);
  }
  console.log(`PASS storybook acceptance: ${join(resolve(argv[0]), ACCEPTANCE_FILENAME)}`);
}

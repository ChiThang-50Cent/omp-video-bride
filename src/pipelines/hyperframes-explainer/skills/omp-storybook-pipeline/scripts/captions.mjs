#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { loadManifest } from "./storybook-schema.mjs";

const AUDIO_META_FILENAME = "audio_meta.json";
const DATA_FILENAME = "caption_groups.json";
const TRANSCRIPT_FILENAME = "transcript.txt";
const SRT_FILENAME = "captions.srt";
const VTT_FILENAME = "captions.vtt";
const MAX_WORDS_PER_GROUP = 8;
const MAX_LINE_CHARS = 42;
const DURATION_EPSILON = 0.04;
const MILLIS_EPSILON = 0.001;

function fail(message) {
  throw new Error(`storybook captions: ${message}`);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail(`${label} must be a finite number`);
  return number;
}

function positive(value, label) {
  const number = finite(value, label);
  if (number <= 0) fail(`${label} must be greater than zero`);
  return number;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function htmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function captionWord(raw, index, voiceFrame) {
  if (!raw || typeof raw !== "object") fail(`voice frame ${voiceFrame} word ${index + 1} is not an object`);
  if (typeof raw.text !== "string" || !raw.text.trim()) fail(`voice frame ${voiceFrame} word ${index + 1} has no text`);
  if (raw.text !== raw.text.trim()) fail(`voice frame ${voiceFrame} word ${index + 1} has surrounding whitespace`);
  const text = raw.text;
  const start = finite(raw.start, `voice frame ${voiceFrame} word ${index + 1}.start`);
  const end = finite(raw.end, `voice frame ${voiceFrame} word ${index + 1}.end`);
  if (start < 0) fail(`voice frame ${voiceFrame} word ${index + 1}.start must not be negative`);
  if (end <= start) fail(`voice frame ${voiceFrame} word ${index + 1}.end must be after start`);
  return { text, start, end };
}

function narrationTokens(text) {
  // Match the upstream audio/fix-captions token convention without changing
  // measured phrase text or splitting its timestamp span.
  return text.split(/[\s()[\]{}]+/)
    .map(token => token.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""))
    .filter(Boolean);
}

function lineLayout(words) {
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word.text}` : word.text;
    if (current && next.length > MAX_LINE_CHARS) {
      lines.push(current);
      current = word.text;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length <= 2 ? lines.join("\n") : null;
}

function makeGroups(words, shotId) {
  const groups = [];
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    const text = lineLayout(pending);
    if (!text) fail(`shot ${shotId} could not fit a caption into two lines without inventing timing`);
    groups.push({
      shotId,
      start: pending[0].start,
      end: pending.at(-1).end,
      text,
      words: pending.map(word => ({ ...word })),
    });
    pending = [];
  };
  for (const word of words) {
    const candidate = [...pending, word];
    if (candidate.reduce((count, item) => count + item.text.split(/\s+/).length, 0) > MAX_WORDS_PER_GROUP || (pending.length > 0 && !lineLayout(candidate))) flush();
    pending.push(word);
  }
  flush();
  return groups;
}

function timestamp(seconds, separator) {
  const milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secondsPart = Math.floor((milliseconds % 60_000) / 1000);
  const millisPart = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secondsPart).padStart(2, "0")}${separator}${String(millisPart).padStart(3, "0")}`;
}

function ensureRepresentableTiming(group) {
  if (Math.round(group.end * 1000) <= Math.round(group.start * 1000)) {
    fail(`caption for shot ${group.shotId} is shorter than one millisecond after timestamp rounding`);
  }
  for (const word of group.words) {
    if (Math.round(word.end * 1000) <= Math.round(word.start * 1000)) {
      fail(`word "${word.text}" in shot ${group.shotId} is shorter than one millisecond after timestamp rounding`);
    }
  }
}

function buildSrt(groups) {
  return groups.map((group, index) => {
    ensureRepresentableTiming(group);
    return `${index + 1}\n${timestamp(group.start, ",")} --> ${timestamp(group.end, ",")}\n${group.text}\n`;
  }).join("\n");
}

function buildVtt(groups) {
  const body = groups.map((group, index) => {
    ensureRepresentableTiming(group);
    return `${index + 1}\n${timestamp(group.start, ".")} --> ${timestamp(group.end, ".")}\n${group.text}\n`;
  }).join("\n");
  return `WEBVTT\n\n${body}`;
}

function buildTranscript(groups) {
  return groups.map(group => group.text.replaceAll("\n", " ")).join("\n");
}

function captionHtml(groups) {
  const style = `
.storybook-caption-layer {
  position: absolute;
  inset: 0;
  z-index: 2147483647;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  padding: 0 8% 5vh;
  pointer-events: none;
  isolation: isolate;
}
.storybook-caption {
  box-sizing: border-box;
  width: min(84%, 1600px);
  max-width: 84%;
  margin: 0;
  padding: 0.28em 0.72em 0.34em;
  border: 2px solid rgba(255, 255, 255, 0.78);
  border-radius: 0.28em;
  background: rgba(17, 24, 23, 0.84);
  color: #fffdf4;
  font-family: Arial, Helvetica, sans-serif;
  font-size: clamp(26px, 3.2vw, 42px);
  font-weight: 700;
  line-height: 1.16;
  text-align: center;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.82);
  white-space: pre-line;
  overflow-wrap: anywhere;
}
.storybook-caption[hidden] {
  display: none;
}
`.trim();
  const markup = groups.map(group => `<div class="storybook-caption" hidden data-caption-id="${htmlEscape(group.id)}" data-caption-shot="${htmlEscape(group.shotId)}" data-caption-start="${group.start}" data-caption-end="${group.end}">${htmlEscape(group.text)}</div>`).join("");
  const script = `<script>(function(){var layer=document.querySelector('[data-storybook-captions="true"]');if(!layer)return;var cues=Array.prototype.slice.call(layer.querySelectorAll('[data-caption-start]'));function render(seconds){var value=Number(seconds);if(!Number.isFinite(value))return;cues.forEach(function(cue){var visible=value>=Number(cue.getAttribute('data-caption-start'))&&value<Number(cue.getAttribute('data-caption-end'));cue.hidden=!visible;});}var previous=typeof window.__storybookSeek==='function'?window.__storybookSeek:null;function seek(seconds){var value=Number(seconds);if(!Number.isFinite(value))return;if(previous)previous(value);render(value);}window.__storybookSeek=seek;window.addEventListener('hf-seek',function(event){var value=Number(event&&event.detail&&event.detail.time);if(!Number.isFinite(value))return;var prior=document.documentElement.dataset.storybookSeek;if(prior!==String(value))seek(value);else render(value);});seek(Number(document.documentElement.dataset.storybookSeek||0));})();</script>`;
  return `<style id="storybook-caption-styles">${style}</style><div class="storybook-caption-layer" data-storybook-captions="true" aria-live="off">${markup}</div>${script}`;
}

function frameNumber(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) fail(`${label} must be a positive integer`);
  return number;
}

function makeShotTimeline(manifest) {
  let start = 0;
  return manifest.shots.map(shot => {
    const item = { ...shot, start, end: start + shot.durationSec };
    start += shot.durationSec;
    return item;
  });
}

function buildCaptionGroups(manifest, metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) fail(`${AUDIO_META_FILENAME} must contain an object`);
  if (!Array.isArray(metadata.voices)) fail(`${AUDIO_META_FILENAME}.voices must be an array`);
  const timeline = makeShotTimeline(manifest);
  const shotById = new Map(timeline.map(shot => [shot.id, shot]));
  const narrationLines = manifest.narration.lines;
  const lineByShot = new Map();
  for (const line of narrationLines) {
    if (lineByShot.has(line.shotId)) fail(`manifest narration repeats shot ${line.shotId}`);
    lineByShot.set(line.shotId, line.text);
  }
  if (manifest.requirements.narration === "none") {
    if (metadata.voices.length) fail(`${AUDIO_META_FILENAME}.voices must be empty when narration is none`);
    return [];
  }
  if (metadata.voices.length !== narrationLines.length) {
    fail(`${AUDIO_META_FILENAME}.voices must cover every authored narration line (${narrationLines.length} expected, got ${metadata.voices.length})`);
  }
  const seenShots = new Set();
  const groups = [];
  for (const rawVoice of metadata.voices) {
    if (!rawVoice || typeof rawVoice !== "object" || Array.isArray(rawVoice)) fail("each narration voice entry must be an object");
    const frame = frameNumber(rawVoice.frame, "narration voice frame");
    const shot = timeline[frame - 1];
    if (!shot) fail(`narration voice frame ${frame} has no corresponding shot in storybook.json`);
    if (seenShots.has(shot.id)) fail(`audio metadata repeats narration for shot ${shot.id}`);
    seenShots.add(shot.id);
    if (typeof rawVoice.text !== "string") fail(`narration voice frame ${frame} has no text`);
    const authoredText = lineByShot.get(shot.id);
    if (authoredText == null) fail(`audio metadata voice frame ${frame} has no authored narration line for shot ${shot.id}`);
    if (rawVoice.text !== authoredText) fail(`narration voice frame ${frame} text does not exactly match manifest narration for shot ${shot.id}`);
    if (typeof rawVoice.voice !== "string" || !rawVoice.voice) fail(`narration voice frame ${frame} has no voice id`);
    if (typeof rawVoice.path !== "string" || !rawVoice.path) fail(`narration voice frame ${frame} has no measured audio path`);
    const voiceDuration = positive(rawVoice.duration_s, `narration voice frame ${frame}.duration_s`);
    if (Math.abs(voiceDuration - shot.durationSec) > DURATION_EPSILON) fail(`narration voice frame ${frame} duration ${voiceDuration} does not fit shot ${shot.id} duration ${shot.durationSec}`);
    if (!Array.isArray(rawVoice.words) || rawVoice.words.length === 0) fail(`narration voice frame ${frame} has no measured word timestamps`);
    const localWords = [];
    let previousEnd = 0;
    for (const [index, rawWord] of rawVoice.words.entries()) {
      const word = captionWord(rawWord, index, frame);
      if (word.start < previousEnd) fail(`narration voice frame ${frame} word timestamps are not monotonic`);
      if (word.end > voiceDuration + MILLIS_EPSILON) fail(`narration voice frame ${frame} word ${index + 1} ends after measured audio`);
      if (word.end > shot.durationSec + MILLIS_EPSILON) fail(`narration voice frame ${frame} word ${index + 1} ends after shot ${shot.id}`);
      previousEnd = word.end;
      localWords.push({ ...word, start: shot.start + word.start, end: shot.start + word.end });
    }
    const authoredTokens = narrationTokens(authoredText);
    const measuredTokens = localWords.flatMap(word => narrationTokens(word.text));
    if (measuredTokens.length !== authoredTokens.length || measuredTokens.some((token, index) => token !== authoredTokens[index])) {
      fail(`narration voice frame ${frame} measured words do not match manifest narration in order for shot ${shot.id}`);
    }
    groups.push(...makeGroups(localWords, shot.id));
  }
  for (const line of narrationLines) {
    if (!seenShots.has(line.shotId)) fail(`audio metadata has no narration voice for shot ${line.shotId}`);
    if (!shotById.has(line.shotId)) fail(`manifest narration references unknown shot ${line.shotId}`);
  }
  return groups.sort((a, b) => a.start - b.start);
}

function normalizeGroups(groups, durationSec) {
  return groups.map((group, index) => {
    const words = group.words.map(word => ({ text: word.text, start: round3(word.start), end: round3(word.end) }));
    const start = round3(group.start);
    const end = round3(group.end);
    if (start < 0 || end > durationSec || end <= start) fail(`caption ${index + 1} lies outside the story duration`);
    if (words.reduce((count, item) => count + item.text.split(/\s+/).length, 0) > MAX_WORDS_PER_GROUP) fail(`caption ${index + 1} exceeds ${MAX_WORDS_PER_GROUP} words`);
    return {
      id: `caption-${String(index + 1).padStart(4, "0")}`,
      shotId: group.shotId,
      start,
      end,
      text: group.text,
      words,
    };
  });
}

export function prepareCaptions(projectDir) {
  const root = resolve(projectDir);
  if (!existsSync(root)) fail(`project directory not found: ${root}`);
  const { manifest } = loadManifest(root);
  const metadataPath = join(root, AUDIO_META_FILENAME);
  if (manifest.requirements.narration === "required" && !existsSync(metadataPath)) fail(`${AUDIO_META_FILENAME} not found at ${metadataPath}`);
  const metadata = existsSync(metadataPath) ? readJson(metadataPath, AUDIO_META_FILENAME) : { voices: [] };
  const groups = normalizeGroups(buildCaptionGroups(manifest, metadata), manifest.durationSec);
  const transcript = buildTranscript(groups);
  const srt = buildSrt(groups);
  const vtt = buildVtt(groups);
  const data = {
    schemaVersion: 1,
    kind: "hyperframes-storybook-caption-groups",
    durationSec: manifest.durationSec,
    groups,
    files: {
      transcript: TRANSCRIPT_FILENAME,
      srt: SRT_FILENAME,
      vtt: VTT_FILENAME,
    },
  };
  return { root, data, transcript, srt, vtt, html: captionHtml(groups) };
}

export function buildCaptions(projectDir) {
  const { root, data, transcript, srt, vtt, html } = prepareCaptions(projectDir);
  const dataPath = join(root, DATA_FILENAME);
  const transcriptPath = join(root, TRANSCRIPT_FILENAME);
  const srtPath = join(root, SRT_FILENAME);
  const vttPath = join(root, VTT_FILENAME);
  writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`);
  writeFileSync(transcriptPath, transcript ? `${transcript}\n` : "");
  writeFileSync(srtPath, srt);
  writeFileSync(vttPath, vtt);
  return {
    html,
    data,
    paths: {
      data: dataPath,
      transcript: transcriptPath,
      srt: srtPath,
      vtt: vttPath,
    },
  };
}

function usage() {
  console.log("Usage: node captions.mjs <PROJECT_DIR>");
  console.log(`Reads storybook.json and ${AUDIO_META_FILENAME}; writes ${DATA_FILENAME}, ${TRANSCRIPT_FILENAME}, ${SRT_FILENAME}, and ${VTT_FILENAME}.`);
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    return 0;
  }
  if (argv.length !== 1 || !argv[0] || argv[0].startsWith("-")) fail("exactly one project directory is required (use --help for usage)");
  const result = buildCaptions(argv[0]);
  console.log(JSON.stringify({
    data: result.paths.data,
    transcript: result.paths.transcript,
    srt: result.paths.srt,
    vtt: result.paths.vtt,
    groups: result.data.groups.length,
  }, null, 2));
  return 0;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
const own = resolve(fileURLToPath(import.meta.url));
if (invoked === own) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

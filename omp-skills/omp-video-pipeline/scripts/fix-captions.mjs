#!/usr/bin/env node
// Correct legacy transcription typos in audio_meta.json against SCRIPT.md without changing measured
// timings. Source-guided-v2 metadata is validated as exact authored phrase coverage instead.
// Usage: fix-captions.mjs <project-dir> (then rebuild captions)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const project = process.argv[2];
if (!project) {
  console.error("usage: fix-captions.mjs <project-dir>");
  process.exit(2);
}
const metaPath = join(project, "audio_meta.json");
const meta = JSON.parse(readFileSync(metaPath, "utf8"));
const script = readFileSync(join(project, "SCRIPT.md"), "utf8");

// SCRIPT.md uses a level-2/3 line heading followed by an indented narration block.
const narration = new Map();
let current = null;
const flushNarration = () => {
  if (!current) return;
  const text = current.lines.join(" ").trim();
  if (text) narration.set(current.frame, text);
  current = null;
};
for (const line of script.split(/\r?\n/)) {
  const heading = line.match(/^#{2,3}\s+(.+?)\s*$/);
  if (heading) {
    flushNarration();
    const headingText = heading[1];
    const explicit = headingText.match(/\((?:frame|beat|scene)\s+(\d+)\)/i);
    const leading = headingText.match(/^(?:line|frame|beat|scene)\s+(\d+)/i);
    const frame = Number(explicit?.[1] ?? leading?.[1]);
    if (Number.isFinite(frame) && frame > 0) current = { frame, lines: [] };
    continue;
  }
  if (!current || /^\s*\*\*[^*]+\*\*\s*:/.test(line)) continue;
  const indented = line.match(/^(?: {4,}|\t)(.*)$/);
  if (indented && indented[1].trim()) current.lines.push(indented[1].trim());
}
flushNarration();

const norm = w => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const displayTokens = text => String(text).split(/[\s()[\]{}]+/).filter(t => norm(t));
if (meta.word_alignment === "source-guided-v2") {
  const errors = [];
  for (const voice of meta.voices ?? []) {
    const expected = narration.get(voice.frame);
    const want = displayTokens(expected ?? "").map(norm);
    const got = (Array.isArray(voice.words) ? voice.words : []).flatMap(word => displayTokens(word.text)).map(norm);
    if (!expected) errors.push(`frame ${voice.frame}: SCRIPT.md narration is missing`);
    else if (!got.length) errors.push(`frame ${voice.frame}: source-guided ASR has no measured caption span`);
    else if (got.length !== want.length || got.some((word, index) => word !== want[index]))
      errors.push(`frame ${voice.frame}: measured ASR spans do not cover authored words exactly`);
  }
  if (errors.length) {
    console.error(`source-guided caption validation failed:\n  ${errors.join("\n  ")}`);
    process.exit(1);
  }
  console.log("source-guided captions match SCRIPT.md; preserving measured ASR spans");
  process.exit(0);
}
const changes = [];
for (const voice of meta.voices ?? []) {
  const text = narration.get(voice.frame);
  if (!text || !Array.isArray(voice.words)) continue;
  // Script tokens as display words; brackets split too, since TTS reads "hash(key)" as "hash key".
  const want = text.split(/[\s()[\]{}]+/).filter(t => norm(t));
  const got = voice.words;
  const a = got.map(w => norm(w.text)), b = want.map(norm);
  // LCS table for alignment
  const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  // Walk the alignment; between two matches, a gap of equal length on both sides is a substitution run.
  let i = 0, j = 0, gi = 0, gj = 0;
  const flush = () => {
    if (i - gi === j - gj) {
      for (let k = 0; k < i - gi; k++) {
        const w = got[gi + k], t = want[gj + k];
        // Only fix misheard words (letters on both sides, script word ≥ 4 letters). Number ↔ word
        // swaps ("one" vs "1", "oh" vs "O") are spoken-form differences, not transcription errors.
        if (!/^\p{L}{4,}$/u.test(norm(t)) || !/^\p{L}+$/u.test(norm(w.text))) continue;
        // Keep the transcript's trailing punctuation style; replace only the word itself.
        const trail = w.text.match(/[^\p{L}\p{N}]*$/u)[0];
        const next = t.replace(/[^\p{L}\p{N}'’-]+$/u, "") + trail;
        if (norm(next) !== norm(w.text)) { changes.push(`frame ${voice.frame}: "${w.text}" → "${next}"`); w.text = next; }
      }
    }
  };
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { flush(); i++; j++; gi = i; gj = j; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  i = a.length; j = b.length; flush();
}

if (changes.length) writeFileSync(metaPath, JSON.stringify(meta, null, 2));
console.log(changes.length ? `fixed ${changes.length} caption word(s):\n  ${changes.join("\n  ")}` : "captions match SCRIPT.md");

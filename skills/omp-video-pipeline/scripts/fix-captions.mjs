#!/usr/bin/env node
// Correct transcription typos in audio_meta.json word timings against SCRIPT.md, the text the
// voice actually read. Only 1:1 word substitutions inside an aligned run are replaced, so timings
// stay intact. Usage: fix-captions.mjs <project-dir>   (then rebuild captions)
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

// SCRIPT.md: "## Line k — title (Frame N)" followed by an indented narration block.
const narration = new Map();
for (const block of script.split(/^## /m).slice(1)) {
  const frame = Number(block.match(/\(Frame (\d+)\)/)?.[1]);
  if (!frame) continue;
  const text = block.split("\n").filter(l => /^( {4}|\t)\S/.test(l)).map(l => l.trim()).join(" ");
  if (text) narration.set(frame, text);
}

const norm = w => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
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

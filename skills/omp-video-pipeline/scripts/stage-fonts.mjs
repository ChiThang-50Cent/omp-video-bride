#!/usr/bin/env node
// Stage every font family/weight that the project's frame.md uses into <project>/assets/fonts, then
// print the exact @font-face lines frame workers must use. Works for any preset:
//   1. the preset's shipped fonts/<Family>-<weight>.woff2 are used when present;
//   2. otherwise the face is fetched once from Google Fonts (latin subset) into a shared cache
//      (~/.cache/omp-video-fonts) and reused offline afterwards.
// Usage: stage-fonts.mjs <project-dir> <preset>   (run after build-frame; frame.md is the source of truth)
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [project, preset] = process.argv.slice(2);
if (!project || !preset) {
  console.error("usage: stage-fonts.mjs <project-dir> <preset>");
  process.exit(2);
}
const frameMd = join(project, "frame.md");
if (!existsSync(frameMd)) {
  console.error(`no frame.md in ${project}; run build-frame first`);
  process.exit(1);
}
const presetFonts = join(homedir(), ".pi/agent/skills/hyperframes-creative/frame-presets", preset, "fonts");
const cache = join(homedir(), ".cache/omp-video-fonts");
const dest = join(project, "assets/fonts");
mkdirSync(cache, { recursive: true });
mkdirSync(dest, { recursive: true });

// family → weights used anywhere in frame.md ("{ fontFamily: "Inter", …, weight: 600 }"; default 400).
const faces = new Map();
for (const line of readFileSync(frameMd, "utf8").split("\n")) {
  for (const m of line.matchAll(/fontFamily:\s*"([^"]+)"/g)) {
    const w = Number(line.match(/weight:\s*(\d{3})/)?.[1] ?? 400);
    if (!faces.has(m[1])) faces.set(m[1], new Set([400]));
    faces.get(m[1]).add(w);
  }
}
if (!faces.size) {
  console.error("frame.md declares no fontFamily tokens");
  process.exit(1);
}

// Google serves woff2 only to modern user agents. The latin block covers English narration and code.
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
async function fetchFace(family, weight, file) {
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@${weight}&display=swap`;
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) return false;
  const css = await res.text();
  const block = css.match(/\/\*\s*latin\s*\*\/\s*@font-face\s*\{[^}]*\}/)?.[0] ?? css.match(/@font-face\s*\{[^}]*\}/)?.[0];
  const src = block?.match(/url\((https:[^)]+\.woff2)\)/)?.[1];
  if (!src) return false;
  const font = await fetch(src);
  if (!font.ok) return false;
  writeFileSync(file, Buffer.from(await font.arrayBuffer()));
  return true;
}

const lines = [];
const missing = [];
for (const [family, weights] of faces) {
  const compact = family.replace(/\s+/g, "");
  for (const weight of [...weights].sort()) {
    const name = `${compact}-${weight}.woff2`;
    const shipped = join(presetFonts, name);
    const cached = join(cache, name);
    let from = existsSync(shipped) ? shipped : existsSync(cached) ? cached : null;
    // Single-weight families (e.g. Fredoka One) have no 600/700 face; Google returns 400 for them.
    if (!from && (await fetchFace(family, weight, cached))) from = cached;
    if (!from) { missing.push(`${family} ${weight}`); continue; }
    copyFileSync(from, join(dest, name));
    lines.push(`@font-face { font-family: "${family}"; font-weight: ${weight}; src: url("assets/fonts/${name}") format("woff2"); }`);
  }
}

console.log(`Staged ${lines.length} font files into ${dest}. These are the ONLY fonts/weights available:`);
for (const l of lines) console.log(`  ${l}`);
if (missing.length) console.log(`Unavailable (do not use; fall back to a listed weight/family): ${missing.join(", ")}`);
if (!lines.length) process.exit(1);

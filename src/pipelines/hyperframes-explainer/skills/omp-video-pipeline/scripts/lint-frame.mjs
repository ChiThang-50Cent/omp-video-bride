#!/usr/bin/env node
// Per-frame lint for faceless-explainer frame workers. Run it on your own frame file before you return:
//   lint-frame.mjs <project-dir> compositions/frames/NN-name.html
// Fails (exit 1) on everything that otherwise costs an orchestrator fix round:
//  - assemble-index guard ②: timed elements without class="clip", same-track window overlap
//  - ids that need CSS escaping (leading digit etc.)
//  - fonts: @font-face src must be a relative assets/fonts/<file> that exists; no absolute /assets paths
//  - `hyperframes lint` errors attributed to this file
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const [projectArg, frameArg] = process.argv.slice(2);
if (!projectArg || !frameArg) {
  console.error("usage: lint-frame.mjs <project-dir> <frame-file>");
  process.exit(2);
}
const project = resolve(projectArg);
const framePath = resolve(project, frameArg);
const html = readFileSync(framePath, "utf8");
const problems = [];

// Same string-level scan as assemble-index.mjs guard ②: blank comments/scripts/styles first.
const scan = html
  .replace(/<!--[\s\S]*?-->/g, " ")
  .replace(/<script\b[\s\S]*?<\/script[^>]*>/gi, " ")
  .replace(/<style\b[\s\S]*?<\/style[^>]*>/gi, " ");
const OPEN_TAG = /<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const attr = (attrs, name) => attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`))?.slice(1).find(v => v != null) ?? null;
const rootish = attrs => /(?:^|\s)id\s*=\s*["']root["']/.test(attrs) || /data-composition-(id|src)/.test(attrs);

const tracks = new Map();
for (const m of scan.matchAll(OPEN_TAG)) {
  const [, tag, attrs] = m;
  const id = attr(attrs, "id");
  if (id && !/^[A-Za-z_][\w-]*$/.test(id)) problems.push(`id "${id}" needs CSS escaping (must start with a letter; use letters, digits, - and _ only)`);
  const start = attr(attrs, "data-start"), dur = attr(attrs, "data-duration"), track = attr(attrs, "data-track-index");
  if (start == null || dur == null || track == null || rootish(attrs)) continue;
  if (!/\bclip\b/.test(attr(attrs, "class") ?? "")) problems.push(`<${tag}${id ? ` id="${id}"` : ""}> has data-start/duration/track-index but no class="clip"`);
  const s = Number(start), e = s + Number(dur);
  const list = tracks.get(track) ?? [];
  list.push({ s, e, label: `<${tag}${id ? `#${id}` : ""}> ${s}–${+e.toFixed(3)}s` });
  tracks.set(track, list);
}
for (const [track, list] of tracks) {
  list.sort((a, b) => a.s - b.s);
  for (let i = 1; i < list.length; i++) {
    if (list[i].s < list[i - 1].e - 1e-3) problems.push(`track ${track}: ${list[i - 1].label} overlaps ${list[i].label}. Give every concurrently visible clip its own data-track-index`);
  }
}

for (const m of html.matchAll(/url\(\s*["']?([^"')]+\.(?:woff2?|ttf|otf))["']?\s*\)/g)) {
  const url = m[1];
  if (url.startsWith("/")) problems.push(`font url "${url}" is absolute; use "assets/fonts/<file>"`);
  else if (!url.startsWith("assets/fonts/")) problems.push(`font url "${url}" must be "assets/fonts/<file>"`);
  else if (!existsSync(join(project, url))) problems.push(`font file "${url}" does not exist; only use the lines printed by stage-fonts.mjs`);
}
if (/(?:src|href)\s*=\s*["']\/assets\//.test(html)) problems.push(`absolute "/assets/..." path; use a relative "assets/..." path`);

// Dry-run every inline <script> against stub DOM/GSAP so undeclared variables and syntax errors fail
// here instead of as "composition script error" in the orchestrator's check (costs a whole fix round).
{
  const stub = new Proxy(function () {}, {
    get: (_, k) => (k === Symbol.toPrimitive ? () => 0 : k === Symbol.iterator ? function* () {} : k === "length" ? 0 : stub),
    set: () => true,
    apply: () => stub,
    construct: () => stub,
  });
  const browserGlobals = new Set(["window", "document", "gsap", "self", "globalThis", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "matchMedia", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "CustomEvent", "Event", "HTMLElement", "Element", "Node", "NodeList", "SVGElement", "DOMParser", "ResizeObserver", "MutationObserver", "IntersectionObserver", "CSS", "location", "navigator", "fetch", "Image", "Audio", "FontFace", "HyperFrames", "__hf", "__timelines", "SplitText", "CustomEase", "MotionPathPlugin", "DrawSVGPlugin", "MorphSVGPlugin", "ScrollTrigger", "TextPlugin", "Flip", "anime", "THREE", "lottie", "d3", "katex", "Prism", "hljs"]);
  const sandbox = new Proxy({}, {
    has: (_, k) => typeof k === "string" && (browserGlobals.has(k) || /^(__|hf|HF)/.test(k)),
    get: (_, k) => (k === Symbol.unscopables ? undefined : stub),
    set: () => true,
  });
  let n = 0;
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    n++;
    if (/\bsrc\s*=|type\s*=\s*["'](?!text\/javascript|module)[^"']*["']/i.test(m[1]) || !m[2].trim()) continue;
    try {
      new Function("sandbox", `with (sandbox) {\n${m[2]}\n}`)(sandbox);
    } catch (e) {
      if (e instanceof ReferenceError || e instanceof SyntaxError) problems.push(`inline <script> #${n}: ${e.name}: ${e.message}. Declare every variable you use`);
    }
  }
}

try {
  const out = execFileSync("npx", ["--yes", "hyperframes@0.8.82", "lint", "--json", project], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 << 20 });
  for (const f of JSON.parse(out).findings ?? []) {
    if (!(f.file ?? "").endsWith(basename(framePath))) continue;
    if (f.severity === "error" || /^timeline_|^id_requires_css_escape$/.test(f.code)) problems.push(`hyperframes lint ${f.severity} ${f.code}: ${f.message}${f.line ? ` (line ${f.line})` : ""}`);
  }
} catch (e) {
  const out = e.stdout?.toString();
  if (!out) problems.push(`hyperframes lint failed to run: ${e.message}`);
  else for (const f of JSON.parse(out).findings ?? []) {
    if ((f.file ?? "").endsWith(basename(framePath)) && f.severity === "error") problems.push(`hyperframes lint error ${f.code}: ${f.message}${f.line ? ` (line ${f.line})` : ""}`);
  }
}

const unique = [...new Set(problems)];
if (!unique.length) {
  console.log(`PASS ${frameArg}`);
  process.exit(0);
}
console.log(`FAIL ${frameArg} — ${unique.length} problem(s):`);
for (const p of unique) console.log(`  - ${p}`);
process.exit(1);

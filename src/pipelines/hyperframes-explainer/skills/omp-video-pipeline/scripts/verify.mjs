#!/usr/bin/env node
// One-shot faceless-explainer verification: fix caption typos against SCRIPT.md → captions build →
// assemble → transitions inject/verify → check --json with frame-check (lint + runtime + layout +
// off-canvas) → midpoint snapshot of every storyboard frame → compact per-frame defect list.
// Usage: verify.mjs <project-dir> [--focus 5,6]   (run after audio + frames exist; safe to re-run after fixes)
// --focus: also snapshot those frames at 20/40/60/80/95% so late-appearing elements are visible.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const project = process.argv[2];
const fi = process.argv.indexOf("--focus");
const focus = new Set(fi > 0 ? String(process.argv[fi + 1] ?? "").split(",").map(Number) : []);
if (!project) {
  console.error("usage: verify.mjs <project-dir> [--focus 5,6]");
  process.exit(2);
}
// realpath: upstream CLIs have a main guard that silently no-ops when invoked through the ~/.pi symlink.
const scripts = realpathSync(process.env.UPSTREAM_SCRIPTS ?? join(homedir(), ".pi/agent/skills/faceless-explainer/scripts"));
const own = new URL(".", import.meta.url).pathname;
const run = (cmd, args, { allowFail = false } = {}) => {
  try {
    return execFileSync(cmd, args, { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
  } catch (e) {
    if (allowFail) return e.stdout ?? "";
    console.log(`FAILED: ${cmd} ${args.join(" ")}\n${(e.stderr || e.stdout || e.message).slice(-3000)}`);
    process.exit(1);
  }
};

// Frame list + midpoints from STORYBOARD.md ("## Frame N — title" followed by "- duration: Xs").
const frames = [];
let cursor = 0;
for (const block of readFileSync(join(project, "STORYBOARD.md"), "utf8").split(/^## Frame /m).slice(1)) {
  const n = Number(block.match(/^(\d+)/)?.[1]);
  const title = block.match(/^\d+\s*[—-]\s*(.+)$/m)?.[1]?.trim() ?? "";
  const dur = Number(block.match(/^- duration:\s*([\d.]+)s/m)?.[1]);
  if (!n || !dur) continue;
  frames.push({ n, id: String(n).padStart(2, "0"), title, start: cursor, end: cursor + dur, mid: +(cursor + dur / 2).toFixed(3) });
  cursor += dur;
}
if (!frames.length) {
  console.log("FAILED: no '## Frame N' blocks with '- duration: Xs' in STORYBOARD.md");
  process.exit(1);
}

const captionFix = run("node", [join(own, "fix-captions.mjs"), "."]).trim();
run("node", [join(scripts, "captions.mjs"), "build", "--storyboard", "./STORYBOARD.md", "--audio-meta", "./audio_meta.json", "--hyperframes", ".", "--out", "./caption_groups.json"]);
run("node", [join(scripts, "assemble-index.mjs"), "--storyboard", "./STORYBOARD.md", "--hyperframes", "."]);
run("node", [join(scripts, "transitions.mjs"), "inject", "--storyboard", "./STORYBOARD.md", "--hyperframes", "."]);
const tv = run("node", [join(scripts, "transitions.mjs"), "verify", "--storyboard", "./STORYBOARD.md", "--index", "./index.html"], { allowFail: true });

const check = JSON.parse(run("npx", ["--yes", "hyperframes@0.8.82", "check", "--json"], { allowFail: true }) || "{}");
writeFileSync(join(project, "snapshots-check.json"), JSON.stringify(check, null, 2));
const times = frames.flatMap(f => focus.has(f.n) ? [0.2, 0.4, 0.6, 0.8, 0.95].map(k => +(f.start + (f.end - f.start) * k).toFixed(3)) : [f.mid]);
run("npx", ["--yes", "hyperframes@0.8.82", "snapshot", "--no-end", "--at", times.join(",")]);

// Attribute each finding to a frame via el-NN ids, frames/NN- source files, a composition id named in
// the message ("composition script error: 05-walk-the-chain …"), or its timestamp.
const frameOf = f => {
  const hay = [f.selector, f.elementId, f.sourceFile, f.file, f.containerSelector].filter(Boolean).join(" ");
  const m = hay.match(/el-(\d{2})\b|frames\/(\d{2})-/) ?? String(f.message ?? "").match(/composition[^:]*:\s*(\d{2})-[a-z]/);
  if (m) return m[1] ?? m[2];
  if (typeof f.time === "number") return [...frames].reverse().find(fr => f.time >= fr.start)?.id;
  return "index";
};
const isCaptionNoise = f => f.code === "text_box_overflow" && /caption-word|caption-line/.test(f.selector ?? "");
const buckets = new Map();
let contrastWarnings = 0;
for (const [section, res] of Object.entries(check)) {
  for (const f of res?.findings ?? []) {
    if (isCaptionNoise(f)) continue;
    if (section === "contrast") { contrastWarnings++; continue; }
    // Keep errors everywhere and layout warnings (clipping/overlap). check reports content leaving the
    // canvas only as info; treat > 24px off-canvas as a defect unless marked data-layout-allow-overflow.
    // Same for content that escapes its container, is occluded, or overlaps other text while the frame is settled.
    const off = (/^(canvas_overflow|panel_out_of_canvas)$/.test(f.code) && Math.max(0, ...Object.values(f.overflow ?? {})) > 24) ||
      /^(escaped_container|text_occluded|content_overlap)$/.test(f.code);
    if (!(f.severity === "error" || (section === "layout" && f.severity === "warning") || off)) continue;
    const key = frameOf(f);
    if (off && f.severity === "info") {
      // Skip samples inside transitions: the element's frame must be on screen, not entering/leaving.
      const fr = frames.find(x => x.id === key);
      if (!fr || f.time < fr.start + 0.5 || f.time > fr.end - 0.5) continue;
    }
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(`${section}/${f.severity}: ${f.code} ${f.selector ?? f.elementId ?? ""}${typeof f.time === "number" ? ` @${f.time}s` : ""} — ${String(f.message).slice(0, 140)}`);
  }
}

console.log(`check ok=${check.ok}  lint errors=${check.lint?.errorCount ?? "?"}  runtime errors=${check.runtime?.errorCount ?? "?"}  layout errors=${check.layout?.errorCount ?? "?"}  contrast warnings=${contrastWarnings} (not listed)`);
console.log(`captions: ${captionFix.replace(/\n/g, "; ")}`);
if (!/pass|ok|✓/i.test(tv) || /fail|error/i.test(tv)) console.log(`transitions verify:\n${tv.trim().slice(-1500)}`);
const sheets = readdirSync(join(project, "snapshots")).filter(f => /^contact-sheet(-\d+)?\.jpg$/.test(f)).sort().map(f => join(project, "snapshots", f));
console.log(`contact sheet(s): ${sheets.join(", ")}  (${focus.size ? `focus frames ${[...focus]} sampled at 20/40/60/80/95%; ` : ""}full check JSON: snapshots-check.json)`);
for (const fr of frames) {
  const items = buckets.get(fr.id) ?? [];
  console.log(`\nframe ${fr.id} "${fr.title}" midpoint ${fr.mid}s — ${items.length ? `${items.length} machine findings` : "no machine findings"}`);
  for (const line of items.slice(0, 8)) console.log(`  - ${line}`);
  if (items.length > 8) console.log(`  … ${items.length - 8} more in snapshots-check.json`);
}
const idx = buckets.get("index") ?? [];
if (idx.length) {
  console.log("\nindex / unattributed:");
  for (const line of idx.slice(0, 8)) console.log(`  - ${line}`);
}
console.log("\nMachine checks catch off-canvas and overflowing content, but not frames that look empty, crowded or faded. Inspect the contact sheet before deciding on fixes.");

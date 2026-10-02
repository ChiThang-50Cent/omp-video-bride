#!/usr/bin/env node
// One-shot HyperFrames verification: central per-frame source recovery/lint →
// fix caption typos against SCRIPT.md → captions build → assemble → transitions
// inject/verify → check --json → midpoint snapshots → compact defect list.
// Hard-gate failures return non-zero, while snapshots-check.json/contact sheets
// are retained for review whenever assembly reaches those steps.
// Usage: verify.mjs <project-dir> [--focus 5,6]
// --focus: also snapshot those frames at 20/40/60/80/95% so late elements are visible.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

const projectArg = process.argv[2];
const fi = process.argv.indexOf("--focus");
const focus = new Set(fi > 0 ? String(process.argv[fi + 1] ?? "").split(",").map(Number) : []);
if (!projectArg) {
  console.error("usage: verify.mjs <project-dir> [--focus 5,6]");
  process.exit(2);
}
const project = resolve(projectArg);
// Resolve upstream scripts before invoking them. Their published main guards
// compare import.meta.url to process.argv[1], so a symlinked ~/.pi path can
// otherwise silently no-op.
const scriptArg = process.env.UPSTREAM_SCRIPTS ?? join(homedir(), ".pi/agent/skills/faceless-explainer/scripts");
if (!existsSync(scriptArg)) {
  console.error(`FAILED: upstream scripts directory not found: ${scriptArg}`);
  process.exit(1);
}
const scripts = realpathSync(scriptArg);
const own = dirname(realpathSync(new URL(import.meta.url).pathname));
const failures = [];
const capture = (cmd, args) => {
  try {
    return {
      status: 0,
      stdout: execFileSync(cmd, args, {
        cwd: project,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 << 20,
      }),
      stderr: "",
    };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "" };
  }
};
const run = (cmd, args) => {
  const result = capture(cmd, args);
  if (result.status !== 0) {
    console.log(`FAILED: ${cmd} ${args.join(" ")}\n${(result.stderr || result.stdout).slice(-3000)}`);
    process.exit(1);
  }
  return result.stdout;
};

// Frame list + midpoints from STORYBOARD.md. Keep the exact source path so
// worker output can be gated before any assembler mutates index.html.
const frames = [];
let cursor = 0;
let current = null;
const storyboard = readFileSync(join(project, "STORYBOARD.md"), "utf8");
const flushFrame = () => {
  if (!current) return;
  const dur = Number(current.duration);
  if (!current.n || !Number.isFinite(dur) || dur <= 0) {
    current = null;
    return;
  }
  frames.push({
    ...current,
    id: String(current.n).padStart(2, "0"),
    start: cursor,
    end: cursor + dur,
    mid: +(cursor + dur / 2).toFixed(3),
  });
  cursor += dur;
  current = null;
};
for (const line of storyboard.split(/\r?\n/)) {
  const heading = line.match(/^#{2,3}\s+(?:Frame|Beat|Scene)\s+(\d+)\s*[—–:-]?\s*(.*)$/i);
  if (heading) {
    flushFrame();
    current = { n: Number(heading[1]), title: heading[2]?.trim() ?? "", duration: NaN, src: null, status: "outline" };
    continue;
  }
  if (!current) continue;
  const meta = line.match(/^\s*[-*]?\s*(duration|src|status)\s*:\s*(.*?)\s*$/i);
  if (!meta) continue;
  if (meta[1].toLowerCase() === "duration") current.duration = Number(meta[2].match(/[\d.]+/)?.[0]);
  else if (meta[1].toLowerCase() === "src") current.src = meta[2].replace(/^['"]|['"]$/g, "");
  else current.status = meta[2].trim().toLowerCase();
}
flushFrame();
if (!frames.length) {
  console.log("FAILED: no '## Frame/Beat/Scene N' blocks with '- duration: Xs' in STORYBOARD.md");
  process.exit(1);
}

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const recoverFrameSource = (frame) => {
  const expectedHint = frame.src
    ? resolve(project, frame.src)
    : join(project, "compositions", "frames", `${frame.id}.html`);
  const src = String(frame.src ?? "");
  if (!/^compositions\/frames\/[A-Za-z0-9._-]+\.html$/i.test(src) || src.includes("..") || src.includes("\\")) {
    failures.push(`frame ${frame.id}: unsafe or missing src; expected a relative compositions/frames/*.html path (expected ${expectedHint})`);
    return null;
  }
  const expected = resolve(project, src);
  let actual = expected;
  if (!existsSync(actual)) {
    // Workers occasionally receive the repository root as their workdir while
    // PROJECT_DIR is videos/<project>. Recover only this job's exact
    // workdir/src path; never search sibling projects or guess by basename.
    const jobWorkdir = resolve(project, "../..");
    const misplaced = resolve(jobWorkdir, src);
    if (misplaced !== expected && existsSync(misplaced)) {
      mkdirSync(dirname(expected), { recursive: true });
      copyFileSync(misplaced, expected);
      actual = expected;
      console.log(`recovered frame ${frame.id}: ${misplaced} → ${expected}`);
    } else {
      failures.push(`frame ${frame.id}: expected source missing at ${expected} (checked exact recovery path ${misplaced})`);
      return null;
    }
  }
  let html;
  try {
    html = readFileSync(actual, "utf8");
  } catch (error) {
    failures.push(`frame ${frame.id}: cannot read expected source ${expected}: ${error.message}`);
    return null;
  }
  const compositionId = basename(src).replace(/\.html?$/i, "");
  const idPattern = new RegExp(`data-composition-id\\s*=\\s*[\"']${escapeRegExp(compositionId)}[\"']`);
  if (!idPattern.test(html)) {
    failures.push(`frame ${frame.id}: ${expected} has no data-composition-id="${compositionId}" matching its basename`);
    return null;
  }
  return src;
};

for (const frame of frames) {
  const source = recoverFrameSource(frame);
  if (!source) continue;
  const gate = capture("node", [join(own, "lint-frame.mjs"), project, source]);
  if (gate.status !== 0) {
    const detail = String(gate.stderr || gate.stdout).trim().slice(-1800);
    failures.push(`frame ${frame.id}: lint-frame failed for ${resolve(project, source)}${detail ? `\n${detail}` : ""}`);
  }
}
if (failures.length) {
  console.error("FAILED: frame gates:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const captionFix = run("node", [join(own, "fix-captions.mjs"), "."]).trim();
run("node", [join(scripts, "captions.mjs"), "build", "--storyboard", "./STORYBOARD.md", "--audio-meta", "./audio_meta.json", "--hyperframes", ".", "--out", "./caption_groups.json"]);
run("node", [join(scripts, "assemble-index.mjs"), "--storyboard", "./STORYBOARD.md", "--hyperframes", "."]);
run("node", [join(scripts, "transitions.mjs"), "inject", "--storyboard", "./STORYBOARD.md", "--hyperframes", "."]);
const tvResult = capture("node", [join(scripts, "transitions.mjs"), "verify", "--storyboard", "./STORYBOARD.md", "--index", "./index.html"]);
const tv = String(tvResult.stdout ?? "");
if (tvResult.status !== 0 || /(?:^|\b)(?:fail|error)\b/i.test(tv)) {
  failures.push(`transitions verify failed${tv.trim() ? `: ${tv.trim().slice(-1800)}` : ""}`);
}

const checkResult = capture("npx", ["--yes", "hyperframes@0.8.82", "check", "--json"]);
const parseJsonOutput = output => {
  const text = String(output ?? "").trim();
  try { return JSON.parse(text); } catch {}
  for (const line of text.split(/\r?\n/).reverse()) {
    try { return JSON.parse(line); } catch {}
  }
  return {};
};
const check = parseJsonOutput(checkResult.stdout);
writeFileSync(join(project, "snapshots-check.json"), JSON.stringify(check, null, 2));
const checkFindings = Object.values(check).flatMap(section => section?.findings ?? []);
const hardCheckErrors = checkFindings.filter(f => f.severity === "error").length +
  Object.values(check).reduce((sum, section) => sum + Number(section?.errorCount ?? 0), 0);
if (checkResult.status !== 0 || !Object.keys(check).length || check.ok === false || hardCheckErrors > 0) {
  failures.push(
    `hyperframes check failed (status ${checkResult.status}, ok=${check.ok ?? "unknown"}, hard errors=${hardCheckErrors}); ` +
    "see snapshots-check.json",
  );
}
const times = frames.flatMap(f => focus.has(f.n) ? [0.2, 0.4, 0.6, 0.8, 0.95].map(k => +(f.start + (f.end - f.start) * k).toFixed(3)) : [f.mid]);
const snapshotResult = capture("npx", ["--yes", "hyperframes@0.8.82", "snapshot", "--no-end", "--at", times.join(",")]);
if (snapshotResult.status !== 0) {
  failures.push(`snapshot generation failed: ${String(snapshotResult.stderr || snapshotResult.stdout).trim().slice(-1800)}`);
}

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

console.log(`check ok=${check.ok ?? "?"}  lint errors=${check.lint?.errorCount ?? "?"}  runtime errors=${check.runtime?.errorCount ?? "?"}  layout errors=${check.layout?.errorCount ?? "?"}  contrast warnings=${contrastWarnings} (not listed)`);
console.log(`captions: ${captionFix.replace(/\n/g, "; ")}`);
if (failures.some(failure => failure.startsWith("transitions verify"))) {
  console.log(`transitions verify:\n${`${tv}\n${tvResult.stderr ?? ""}`.trim().slice(-1500)}`);
}
let sheets = [];
try {
  sheets = readdirSync(join(project, "snapshots"))
    .filter(f => /^contact-sheet(-\d+)?\.jpg$/.test(f))
    .sort()
    .map(f => join(project, "snapshots", f));
} catch (error) {
  failures.push(`snapshot review directory missing at ${join(project, "snapshots")}: ${error.message}`);
}
console.log(`contact sheet(s): ${sheets.join(", ") || "(none)"}  (${focus.size ? `focus frames ${[...focus]} sampled at 20/40/60/80/95%; ` : ""}full check JSON: snapshots-check.json)`);
for (const fr of frames) {
  const items = buckets.get(fr.id) ?? [];
  console.log(`\nframe ${fr.id} "${fr.title}" midpoint ${fr.mid}s — ${items.length ? `${items.length} machine findings` : "no machine findings"}`);
  for (const line of items.slice(0, 8)) console.log(`  - ${line}`);
  if (items.length > 8) console.log(`  … ${items.length - 8} more in snapshots-check.json`);
}
if (failures.length) {
  console.error("\nFAILED: verification hard gate(s):");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
}
const idx = buckets.get("index") ?? [];
if (idx.length) {
  console.log("\nindex / unattributed:");
  for (const line of idx.slice(0, 8)) console.log(`  - ${line}`);
}
console.log("\nMachine checks catch off-canvas and overflowing content, but not frames that look empty, crowded or faded. Inspect the contact sheet before deciding on fixes.");

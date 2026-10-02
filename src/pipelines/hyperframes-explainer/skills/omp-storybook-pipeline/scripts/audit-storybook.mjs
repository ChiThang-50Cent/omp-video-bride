#!/usr/bin/env node
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
import { buildAudioPlan, inspectAudioMounts, verifyRenderedAudio } from "./audio-evidence.mjs";
import { inspectMotionTiming } from "./motion-timing.mjs";
import { evidenceDigest, verifyRenderedVisuals } from "./visual-evidence.mjs";

const AUDIT_DIR = ".hyperframes/storybook-audit";
const REPORT_FILENAME = ".hyperframes/storybook-audit.json";
const CAPTION_GROUPS_FILENAME = "caption_groups.json";
const CONTACT_SHEET_DIR = "snapshots";
const HYPERFRAMES_VERSION = "0.8.82";

function usage() {
  console.log("Usage: node audit-storybook.mjs <PROJECT_DIR> [--video <path>] [--out <path>]");
}

function die(message) {
  throw new Error(`storybook audit: ${message}`);
}

async function resolvePuppeteer(projectDir) {
  const candidates = [];
  if (process.env.HYPERFRAMES_PUPPETEER_CORE) candidates.push({ value: process.env.HYPERFRAMES_PUPPETEER_CORE, direct: true });
  if (process.env.HYPERFRAMES_PACKAGE_ROOT) candidates.push({ value: join(process.env.HYPERFRAMES_PACKAGE_ROOT, "package.json"), direct: false });
  if (process.env.HYPERFRAMES_NODE_MODULES) candidates.push({ value: join(process.env.HYPERFRAMES_NODE_MODULES, "package.json"), direct: false });
  candidates.push({ value: join(projectDir, "package.json"), direct: false }, { value: "/opt/hyperframes/package.json", direct: false });
  for (const candidate of candidates) {
    try {
      let resolved = candidate.value;
      if (!candidate.direct || !/\.(?:c?js|mjs)$/i.test(resolved)) {
        const req = createRequire(resolved.endsWith("package.json") ? resolved : join(resolved, "package.json"));
        resolved = req.resolve("puppeteer-core");
      }
      const module = await import(pathToFileURL(resolved).href);
      return module.default ?? module;
    } catch {
      // Try the next package root. HyperFrames keeps puppeteer-core with its pinned runtime.
    }
  }
  die("puppeteer-core is unavailable; resolve it from the HyperFrames package or set HYPERFRAMES_PUPPETEER_CORE");
}

function readCompiled(projectDir) {
  const path = projectPath(projectDir, COMPILED_FILENAME, "compiled asset manifest");
  if (!existsSync(path)) die(`compiled asset manifest missing at ${path}; run compile-scene.mjs first`);
  const value = readJson(path, "compiled asset manifest");
  if (value.schemaVersion !== 1 || value.kind !== "hyperframes-storybook-assets-manifest") die("compiled asset manifest has the wrong schema kind");
  return { path, value };
}

function invalidateEvidence(auditDir, reportFile, snapshotDir) {
  if (existsSync(reportFile)) unlinkSync(reportFile);
  if (existsSync(auditDir)) {
    for (const entry of readdirSync(auditDir, { withFileTypes: true })) {
      if (entry.isFile() && (entry.name === "contact.json" || entry.name.endsWith(".png"))) unlinkSync(join(auditDir, entry.name));
    }
  }
  if (existsSync(snapshotDir)) {
    for (const entry of readdirSync(snapshotDir, { withFileTypes: true })) {
      if (entry.isFile() && /^contact-sheet(?:-\d+)?\.jpg$/i.test(entry.name)) unlinkSync(join(snapshotDir, entry.name));
    }
  }
}

function captionText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function readCaptionEvidence(projectDir, manifest) {
  if (manifest.requirements.narration !== "required") return null;
  const path = projectPath(projectDir, CAPTION_GROUPS_FILENAME, "caption groups");
  if (!existsSync(path)) die(`required caption groups missing at ${path}`);
  const value = readJson(path, "caption groups");
  if (value.schemaVersion !== 1 || value.kind !== "hyperframes-storybook-caption-groups" || !Array.isArray(value.groups) || value.groups.length === 0) {
    die("caption_groups.json must be a non-empty hyperframes-storybook-caption-groups object");
  }
  const groups = value.groups;
  const ids = new Set();
  const shotWindows = new Map();
  let shotStart = 0;
  for (const shot of manifest.shots) {
    shotWindows.set(shot.id, { start: shotStart, end: shotStart + shot.durationSec });
    shotStart += shot.durationSec;
  }
  for (const [index, group] of groups.entries()) {
    if (!group || typeof group !== "object" || !group.id || !group.shotId || !captionText(group.text)) die(`caption group ${index + 1} is missing id, shotId, or text`);
    if (ids.has(group.id)) die(`caption groups contain duplicate id ${group.id}`);
    ids.add(group.id);
    const start = Number(group.start);
    const end = Number(group.end);
    const window = shotWindows.get(group.shotId);
    if (!window || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < window.start - 0.001 || end > window.end + 0.001) {
      die(`caption group ${group.id} has invalid timing for shot ${group.shotId}`);
    }
  }
  for (const line of manifest.narration.lines) {
    if (!groups.some(group => group.shotId === line.shotId)) die(`caption groups have no cue for narrated shot ${line.shotId}`);
  }
  const fileNames = { transcript: value.files?.transcript, srt: value.files?.srt, vtt: value.files?.vtt };
  const files = {};
  for (const [key, fileName] of Object.entries(fileNames)) {
    if (typeof fileName !== "string" || !fileName.trim()) die(`caption groups are missing files.${key}`);
    const filePath = projectPath(projectDir, fileName, `caption ${key}`);
    if (!existsSync(filePath)) die(`caption ${key} missing at ${filePath}`);
    files[key] = { path: fileName, sha256: sha256File(filePath) };
  }
  return { path, sha256: sha256File(path), value, groups, files };
}

function probeVideo(projectDir, videoPath, canvas, requirements) {
  const absolute = resolve(projectDir, videoPath);
  if (!existsSync(absolute)) die(`video missing at ${absolute}`);
  const result = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate", "-of", "json", absolute], { encoding: "utf8" });
  if (result.status !== 0) die(`ffprobe failed for ${absolute}: ${String(result.stderr || result.stdout).trim()}`);
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { die(`ffprobe did not return JSON for ${absolute}`); }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find(stream => stream.codec_type === "video");
  const audio = streams.find(stream => stream.codec_type === "audio");
  if (!video) die("final video has no video stream");
  if (Number(video.width) !== canvas.width || Number(video.height) !== canvas.height) die(`final video dimensions ${video.width}x${video.height} do not match ${canvas.width}x${canvas.height}`);
  if ((requirements.narration === "required" || requirements.music === "required") && !audio) die("final video has no audio stream although narration or music is required");
  const duration = Number(parsed.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) die("final video has no measured positive duration");
  const rate = value => { const [a, b] = String(value).split("/").map(Number); return a / b; };
  const fps = rate(video.avg_frame_rate);
  if (!Number.isFinite(fps) || fps <= 0 || Math.abs(fps - rate(video.r_frame_rate)) > 0.0001) die("encoded visual verification requires constant frame rate");
  return { path: relative(projectDir, absolute), sha256: sha256File(absolute), durationSec: duration, width: Number(video.width), height: Number(video.height), videoCodec: video.codec_name ?? null, audioCodec: audio?.codec_name ?? null, fps };
}

async function waitPaint(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function delta(values, axis) {
  const numbers = values.map(value => Number(value[axis])).filter(Number.isFinite);
  if (numbers.length < 2) return 0;
  return Math.max(...numbers) - Math.min(...numbers);
}

function smooth(progress) {
  return 0.5 - Math.cos(Math.PI * progress) * 0.5;
}

function expectedFrame(motion, seconds) {
  const frames = Array.isArray(motion?.keyframes) ? motion.keyframes : [];
  if (!frames.length) return { x: 0, y: 0, rotation: 0 };
  if (seconds <= Number(frames[0].timeSec)) return frames[0];
  const last = frames[frames.length - 1];
  if (seconds >= Number(last.timeSec)) return last;
  let index = 1;
  while (index < frames.length && Number(frames[index].timeSec) < seconds) index += 1;
  const from = frames[index - 1];
  const to = frames[index];
  const progress = smooth((seconds - Number(from.timeSec)) / Math.max(0.000001, Number(to.timeSec) - Number(from.timeSec)));
  return {
    x: Number(from.x) + (Number(to.x) - Number(from.x)) * progress,
    y: Number(from.y) + (Number(to.y) - Number(from.y)) * progress,
    rotation: Number(from.rotation) + (Number(to.rotation) - Number(from.rotation)) * progress,
  };
}

function parseTransform(value) {
  const match = String(value ?? "").match(/translate\(\s*([-+\d.eE]+)(?:px)?[,\s]+([-+\d.eE]+)(?:px)?\s*\)\s*rotate\(\s*([-+\d.eE]+)(?:deg)?\s*\)\s*scale\(\s*([-+\d.eE]+)\s*\)/);
  if (!match) return null;
  const parsed = match.slice(1).map(Number);
  return parsed.every(Number.isFinite) ? { x: parsed[0], y: parsed[1], rotation: parsed[2], scale: parsed[3] } : null;
}

function parseComputedTransform(value) {
  const match = String(value ?? "").match(/^matrix\(\s*([-+\d.eE]+)[,\s]+([-+\d.eE]+)[,\s]+([-+\d.eE]+)[,\s]+([-+\d.eE]+)[,\s]+([-+\d.eE]+)[,\s]+([-+\d.eE]+)\s*\)$/);
  if (!match) return null;
  const [a, b, c, d, x, y] = match.slice(1).map(Number);
  const scale = Math.hypot(a, b);
  if (![a, b, c, d, x, y, scale].every(Number.isFinite) || scale <= 0) return null;
  return { x, y, rotation: Math.atan2(b, a) * 180 / Math.PI, scale };
}

function angleClose(actual, expected, tolerance = 0.9) {
  if (!finite(actual) || !finite(expected)) return false;
  const delta = Math.abs((((actual - expected) % 360) + 540) % 360 - 180);
  return delta <= tolerance;
}

function closeEnough(actual, expected, tolerance = 0.75) {
  return finite(actual) && finite(expected) && Math.abs(actual - expected) <= tolerance;
}
async function waitAssets(page) {
  await page.evaluate(() => {
    const assets = [...document.querySelectorAll("[data-storybook-asset-path]")];
    return Promise.race([
      Promise.all(assets.map(asset => asset.complete && asset.naturalWidth > 0
        ? Promise.resolve()
        : new Promise((resolve, reject) => {
          asset.addEventListener("load", resolve, { once: true });
          asset.addEventListener("error", () => reject(new Error(`asset failed to load: ${asset.getAttribute("data-storybook-asset-path")}`)), { once: true });
        }))),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for storybook image assets")), 10000)),
    ]);
  });
}

async function collectSample(page, shotId, timeSec, startSec) {
  await page.evaluate(seconds => {
    if (typeof window.__storybookSeek !== "function") throw new Error("index.html does not expose __storybookSeek");
    window.__storybookSeek(seconds);
  }, timeSec);
  await waitPaint(page);
  return page.evaluate(({ id, time, start }) => {
    const shot = [...document.querySelectorAll("[data-storybook-shot]")].find(node => node.getAttribute("data-storybook-shot") === id);
    if (!shot) return { shotId: id, timeSec: time, localTimeSec: time - start, error: `shot ${id} is missing from index.html` };
    const style = getComputedStyle(shot);
    if (style.display === "none" || style.visibility === "hidden") return { shotId: id, timeSec: time, localTimeSec: time - start, error: `shot ${id} is not visible at ${time}s` };
    const rect = node => {
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    };
    const root = document.querySelector("[data-storybook-root]");
    const rootRect = root ? rect(root) : { x: 0, y: 0, right: 0, bottom: 0, width: 0, height: 0 };
    const background = shot.querySelector(":scope [data-storybook-background]");
    const cast = [...shot.querySelectorAll(":scope [data-storybook-instance]")].map(node => {
      const image = node.querySelector(":scope [data-storybook-character-image]");
      return {
        id: node.getAttribute("data-storybook-instance"),
        domId: node.id,
        character: node.getAttribute("data-storybook-character"),
        path: node.getAttribute("data-storybook-character-path"),
        authoredWidth: Number(node.getAttribute("data-storybook-character-width")),
        authoredHeight: Number(node.getAttribute("data-storybook-character-height")),
        anchor: { x: Number(node.getAttribute("data-storybook-instance-x")), y: Number(node.getAttribute("data-storybook-instance-y")) },
        scale: Number(node.getAttribute("data-storybook-instance-scale")),
        motion: node.getAttribute("data-storybook-motion") === "true",
        transform: node.style.transform,
        computedTransform: getComputedStyle(node).transform,
        rect: image ? rect(image) : rect(node),
        image: image ? {
          path: image.getAttribute("data-storybook-character-path"),
          assetPath: image.getAttribute("data-storybook-asset-path"),
          src: image.getAttribute("src") ?? image.getAttribute("href") ?? image.getAttribute("xlink:href"),
          complete: image.complete === true,
          naturalWidth: Number(image.naturalWidth),
          naturalHeight: Number(image.naturalHeight),
          rect: rect(image),
        } : null,
      };
    });
    return {
      shotId: id,
      timeSec: time,
      localTimeSec: time - start,
      rootRect,
      background: background ? {
        id: background.getAttribute("data-storybook-background"),
        path: background.getAttribute("data-storybook-background-path"),
        assetPath: background.getAttribute("data-storybook-asset-path"),
        src: background.getAttribute("src") ?? background.getAttribute("href") ?? background.getAttribute("xlink:href"),
        complete: background.complete === true,
        naturalWidth: Number(background.naturalWidth),
        naturalHeight: Number(background.naturalHeight),
        rect: rect(background),
      } : null,
      cast,
    };
  }, { id: shotId, time: timeSec, start: startSec });
}

async function collectCaptionSample(page, group) {
  const timeSec = (Number(group.start) + Number(group.end)) / 2;
  await page.evaluate(seconds => {
    if (typeof window.__storybookSeek !== "function") throw new Error("index.html does not expose __storybookSeek");
    window.__storybookSeek(seconds);
  }, timeSec);
  await waitPaint(page);
  return page.evaluate(({ id, shotId, time }) => {
    const layer = document.querySelector('[data-storybook-captions="true"]');
    const cue = [...(layer?.querySelectorAll("[data-caption-id]") ?? [])].find(node => node.getAttribute("data-caption-id") === id);
    const shot = [...document.querySelectorAll("[data-storybook-shot]")].find(node => node.getAttribute("data-storybook-shot") === shotId);
    if (!layer || !cue || !shot) return { id, shotId, timeSec: time, error: `caption ${id} is not mounted for shot ${shotId}` };
    const rectOf = node => {
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    };
    const cueRect = rectOf(cue);
    const root = document.querySelector("[data-storybook-root]");
    const rootRect = root ? rectOf(root) : { x: 0, y: 0, right: 0, bottom: 0, width: 0, height: 0 };
    const range = document.createRange();
    range.selectNodeContents(cue);
    const lineTops = [...range.getClientRects()].filter(box => box.width > 0 && box.height > 0).map(box => Math.round(box.top * 10) / 10);
    const overlap = (left, right) => left.x < right.right && left.right > right.x && left.y < right.bottom && left.bottom > right.y;
    const characterRects = [...shot.querySelectorAll("[data-storybook-character-image]")].map(rectOf);
    const style = getComputedStyle(cue);
    return {
      id,
      shotId,
      timeSec: time,
      text: cue.textContent,
      start: Number(cue.getAttribute("data-caption-start")),
      end: Number(cue.getAttribute("data-caption-end")),
      visible: !cue.hidden && style.display !== "none" && style.visibility !== "hidden",
      lineCount: new Set(lineTops).size,
      insideSafeMargins: cueRect.x >= rootRect.x + rootRect.width * 0.04 && cueRect.right <= rootRect.right - rootRect.width * 0.04 && cueRect.y >= rootRect.y + rootRect.height * 0.04 && cueRect.bottom <= rootRect.bottom - rootRect.height * 0.04,
      characterOverlap: characterRects.some(character => overlap(cueRect, character)),
    };
  }, { id: group.id, shotId: group.shotId, time: timeSec });
}

function verifyCaptionSample(sample, expected) {
  if (sample.error) return [sample.error];
  const errors = [];
  if (captionText(sample.text) !== captionText(expected.text)) errors.push(`caption ${expected.id} text does not match caption_groups.json`);
  if (Math.abs(Number(sample.start) - Number(expected.start)) > 0.001 || Math.abs(Number(sample.end) - Number(expected.end)) > 0.001) errors.push(`caption ${expected.id} timing does not match caption_groups.json`);
  if (!sample.visible) errors.push(`caption ${expected.id} is hidden at its midpoint`);
  if (!Number.isInteger(sample.lineCount) || sample.lineCount < 1 || sample.lineCount > 2) errors.push(`caption ${expected.id} renders ${sample.lineCount} lines; expected 1-2`);
  if (!sample.insideSafeMargins) errors.push(`caption ${expected.id} overflows safe canvas margins`);
  if (sample.characterOverlap) errors.push(`caption ${expected.id} overlaps an intended full-character image`);
  return errors;
}

function verifySamples(samples, expectedShot, canvas) {
  const errors = [];
  const expectedCast = expectedShot.cast.map(character => ({ ...character, motion: character.motion && Array.isArray(character.motion.keyframes) ? character.motion : null }));
  const byId = new Map();
  for (const sample of samples) {
    if (sample.error) { errors.push(sample.error); continue; }
    if (!sample.background) errors.push(`${expectedShot.id} at ${sample.timeSec}s is missing its background image`);
    else {
      if (sample.background.id !== expectedShot.background) errors.push(`${expectedShot.id} mounted background ${sample.background.id}, expected ${expectedShot.background}`);
      if (!sample.background.complete || sample.background.naturalWidth <= 0 || sample.background.naturalHeight <= 0) errors.push(`${expectedShot.id} background image did not load a real asset`);
      if (!finite(sample.background.rect.width) || !finite(sample.background.rect.height) || sample.background.rect.width < canvas.width - 1 || sample.background.rect.height < canvas.height - 1) errors.push(`${expectedShot.id} background does not cover the full canvas`);
      if (sample.background.path !== expectedShot.backgroundPath || !String(sample.background.src ?? "").endsWith(expectedShot.backgroundPath)) errors.push(`${expectedShot.id} background asset path is not the compiled source`);
    }
    const ids = sample.cast.map(item => item.id);
    if (ids.length !== expectedCast.length) errors.push(`${expectedShot.id} at ${sample.timeSec}s has cast count ${ids.length}, expected ${expectedCast.length}`);
    for (const expected of expectedCast) {
      const actual = sample.cast.find(item => item.id === expected.id);
      if (!actual) { errors.push(`${expectedShot.id} at ${sample.timeSec}s is missing cast ${expected.id}`); continue; }
      if (!finite(actual.rect.width) || !finite(actual.rect.height) || actual.rect.width <= 0 || actual.rect.height <= 0) errors.push(`${expectedShot.id}/${expected.id} has no visible full-character geometry`);
      if (!actual.image || !actual.image.complete || actual.image.naturalWidth <= 0 || actual.image.naturalHeight <= 0) errors.push(`${expectedShot.id}/${expected.id} character image did not load a real asset`);
      if (actual.character !== expected.character || actual.path !== expected.characterPath || actual.image?.path !== expected.characterPath || !String(actual.image?.src ?? "").endsWith(expected.characterPath)) errors.push(`${expectedShot.id}/${expected.id} does not reuse compiled character asset ${expected.characterPath}`);
      if (!closeEnough(actual.authoredWidth, expected.width) || !closeEnough(actual.authoredHeight, expected.height)) errors.push(`${expectedShot.id}/${expected.id} authored character dimensions changed`);
      if (actual.rect.x < sample.rootRect.x - 1 || actual.rect.y < sample.rootRect.y - 1 || actual.rect.right > sample.rootRect.right + 1 || actual.rect.bottom > sample.rootRect.bottom + 1) errors.push(`${expectedShot.id}/${expected.id} full-character bounds leave the canvas`);
      const frame = expectedFrame(expected.motion, Math.max(0, Math.min(expectedShot.durationSec, Number(sample.localTimeSec))));
      const authored = parseTransform(actual.transform);
      const computed = parseComputedTransform(actual.computedTransform);
      if (!authored || !computed
        || !closeEnough(authored.x, expected.x + Number(frame.x), 0.9)
        || !closeEnough(authored.y, expected.y + Number(frame.y), 0.9)
        || !angleClose(authored.rotation, Number(frame.rotation))
        || !closeEnough(authored.scale, Number(expected.scale), 0.01)
        || !closeEnough(computed.x, expected.x + Number(frame.x), 0.9)
        || !closeEnough(computed.y, expected.y + Number(frame.y), 0.9)
        || !angleClose(computed.rotation, Number(frame.rotation))
        || !closeEnough(computed.scale, Number(expected.scale), 0.01)) {
        errors.push(`${expectedShot.id}/${expected.id} authored root position/rotation does not match deterministic CSS seek at ${sample.localTimeSec}s`);
      }
      const observations = byId.get(expected.id) ?? [];
      observations.push({ actual, frame });
      byId.set(expected.id, observations);
    }
  }
  for (const expected of expectedCast) {
    const observations = byId.get(expected.id) ?? [];
    if (!expected.moving) continue;
    const positions = observations.map(item => parseComputedTransform(item.actual.computedTransform)).filter(Boolean);
    if (positions.length < 2 || (delta(positions, "x") < 0.5 && delta(positions, "y") < 0.5 && delta(positions, "rotation") < 0.5)) errors.push(`${expectedShot.id}/${expected.id} is a frozen moving character`);
  }
  return errors;
}

function buildContactSheets(projectDir, evidence) {
  if (!evidence.length) die("storybook audit emitted no screenshot evidence for contact sheets");
  const outputDir = join(projectDir, CONTACT_SHEET_DIR);
  mkdirSync(outputDir, { recursive: true });
  const results = [];
  const batchSize = 12;
  for (let offset = 0, batch = 0; offset < evidence.length; offset += batchSize, batch += 1) {
    const paths = evidence.slice(offset, offset + batchSize).map(path => join(projectDir, path));
    const columns = 3;
    const labels = paths.map((_, index) => `[${index}:v]scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2:color=white[s${index}]`).join(";");
    const inputs = paths.map((path, index) => `[s${index}]`).join("");
    const layout = paths.map((_, index) => `${(index % columns) * 488}_${Math.floor(index / columns) * 278}`).join("|");
    const filter = paths.length === 1
      ? `${labels};[s0]pad=496:286:8:8:color=white[out]`
      : `${labels};${inputs}xstack=inputs=${paths.length}:layout=${layout}:fill=white[out]`;
    const output = join(outputDir, batch === 0 ? "contact-sheet.jpg" : `contact-sheet-${batch + 1}.jpg`);
    const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...paths.flatMap(path => ["-i", path]), "-filter_complex", filter, "-map", "[out]", "-frames:v", "1", "-q:v", "2", output], { encoding: "utf8" });
    if (result.status !== 0 || !existsSync(output)) die(`ffmpeg failed to build ${relative(projectDir, output)}: ${String(result.stderr || result.stdout || "").trim()}`);
    results.push({ path: relative(projectDir, output), sha256: sha256File(output) });
  }
  return results;
}

function verifyCompiledSources(root, manifest, compiled) {
  if (!Array.isArray(compiled.characters) || !Array.isArray(compiled.backgrounds) || !Array.isArray(compiled.assets)) die("compiled asset manifest is missing character/background/asset source lists");
  const hashList = (items, label) => items.map(item => {
    const path = projectPath(root, item.path, `${label} path`);
    if (!existsSync(path)) die(`${label} missing at ${path}`);
    const sha256 = sha256File(path);
    if (sha256 !== item.sha256) die(`${label} hash is stale: ${item.sha256} != ${sha256}`);
    return { ...item, sha256 };
  });
  const characters = hashList(compiled.characters, "compiled character");
  const backgrounds = hashList(compiled.backgrounds, "compiled background");
  const assets = hashList(compiled.assets, "compiled asset");
  const expectedCharacters = manifest.characters.map(item => ({ id: item.id, path: item.path, width: item.width, height: item.height }));
  for (const expected of expectedCharacters) {
    const actual = characters.find(item => item.id === expected.id);
    if (!actual || actual.path !== expected.path || actual.width !== expected.width || actual.height !== expected.height) die(`compiled character ${expected.id} is not bound to the current manifest`);
  }
  for (const expected of manifest.backgrounds) {
    const actual = backgrounds.find(item => item.id === expected.id);
    if (!actual || actual.path !== expected.path) die(`compiled background ${expected.id} is not bound to the current manifest`);
  }
  const digest = sha256Bytes(Buffer.from(stableStringify({ characters, backgrounds, assets }), "utf8"));
  if (digest !== compiled.sourceDigest) die(`compiled source digest is stale: ${compiled.sourceDigest} != ${digest}`);
  return { characters, backgrounds, assets, digest };
}

export async function auditStorybook(projectDir, { video = null, outputPath = REPORT_FILENAME } = {}) {
  const root = resolve(projectDir);
  const reportFile = projectPath(root, outputPath, "audit report");
  const auditDir = join(root, AUDIT_DIR);
  const contactSheetDir = join(root, CONTACT_SHEET_DIR);
  invalidateEvidence(auditDir, reportFile, contactSheetDir);
  const { manifest } = loadManifest(root);
  const captionEvidence = readCaptionEvidence(root, manifest);
  const audioPlan = buildAudioPlan(root, manifest);
  const metadataPath = join(root, existsSync(join(root, "audio_meta.json")) ? "audio_meta.json" : "audio_engine_meta.json");
  const motionTiming = inspectMotionTiming(manifest, existsSync(metadataPath) ? readJson(metadataPath, "audio metadata") : null);
  let audioMounts = [];
  let mountedAudio;
  const compiledInfo = readCompiled(root);
  const compiled = compiledInfo.value;
  if (compiled.manifestSha256 !== manifestHash(manifest)) die(`compiled storybook manifest hash is stale: ${compiled.manifestSha256} != ${manifestHash(manifest)}`);
  if (compiled.style !== manifest.style || stableStringify(compiled.canvas) !== stableStringify(manifest.canvas) || Math.abs(Number(compiled.durationSec) - manifest.durationSec) > 0.001 || stableStringify(compiled.requirements) !== stableStringify(manifest.requirements)) {
    die("compiled asset manifest duration/canvas/style/requirements are stale");
  }
  const sourceProof = verifyCompiledSources(root, manifest, compiled);
  const compositionPath = projectPath(root, compiled.composition?.path, "compiled composition");
  if (!existsSync(compositionPath)) die(`compiled composition missing at ${compositionPath}`);
  const compositionHash = sha256File(compositionPath);
  if (compositionHash !== compiled.composition.sha256) die(`compiled composition hash is stale: ${compiled.composition.sha256} != ${compositionHash}`);
  if (compiled.composition.path !== COMPOSITION_FILENAME) die(`compiled composition must be ${COMPOSITION_FILENAME}`);
  const compiledHash = sha256File(compiledInfo.path);
  const indexPath = join(root, "index.html");
  if (!existsSync(indexPath)) die(`index.html missing at ${indexPath}`);
  const indexHash = sha256File(indexPath);
  const lintResult = spawnSync("npx", ["--yes", `hyperframes@${HYPERFRAMES_VERSION}`, "lint", "--json", root], { encoding: "utf8", timeout: 60_000 });
  let nativeLint;
  try { nativeLint = JSON.parse(lintResult.stdout); } catch { die(`native HyperFrames lint failed: ${lintResult.stderr || lintResult.error?.message || "invalid JSON"}`); }
  if (lintResult.status !== 0 || !nativeLint.ok || nativeLint.errorCount !== 0) die(`native HyperFrames lint errors: ${(nativeLint.findings ?? []).filter(item => item.severity === "error").map(item => `${item.code}: ${item.message}`).join("; ")}`);
  mkdirSync(auditDir, { recursive: true });
  const puppeteer = await resolvePuppeteer(root);
  if (!process.env.HYPERFRAMES_BROWSER_PATH) die("HYPERFRAMES_BROWSER_PATH is required for the real-browser audit");
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.HYPERFRAMES_BROWSER_PATH, args: ["--no-sandbox", "--disable-setuid-sandbox"], defaultViewport: { width: manifest.canvas.width, height: manifest.canvas.height, deviceScaleFactor: 1 } });
  const samples = [];
  const captionSamples = [];
  const evidence = [];
  const videoProof = video ? probeVideo(root, video, manifest.canvas, manifest.requirements) : null;
  const videoFrames = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: manifest.canvas.width, height: manifest.canvas.height, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(indexPath).href, { waitUntil: "load" });
    await waitAssets(page);
    await waitPaint(page);
    await page.waitForFunction(() => [...document.querySelectorAll("audio")].every(audio => audio.readyState >= 1 || audio.error), { timeout: 15_000 });
    audioMounts = await page.evaluate(() => {
      if (document.querySelector('video[data-has-audio="true"], hf-audio-group')) throw new Error("storybook audio groups/video audio are unsupported");
      const modifiers = ["data-playback-start", "data-media-start", "data-playback-rate", "data-fade-in", "data-fade-out", "data-automation", "data-fx-chain", "data-audio-group", "data-hf-group-render-id", "data-end"];
      return [...document.querySelectorAll("audio")].map(audio => ({
        src: audio.src, currentSrc: audio.currentSrc, srcAttribute: audio.getAttribute("src"),
        clip: audio.classList.contains("clip"), start: Number(audio.getAttribute("data-start")),
        duration: Number(audio.getAttribute("data-duration")), volume: Number(audio.getAttribute("data-volume") ?? 1),
        muted: audio.muted, readyState: audio.readyState, naturalDuration: audio.duration,
        unsupported: !audio.id || modifiers.some(name => audio.hasAttribute(name)) || Boolean(audio.closest("[data-hidden]")),
      }));
    });
    mountedAudio = inspectAudioMounts(audioPlan, audioMounts, root);
    const mount = await page.evaluate(() => {
      const root = document.querySelector("[data-storybook-root]");
      const images = [...document.querySelectorAll("[data-storybook-asset-path]")];
      return {
        manifestSha256: root?.getAttribute("data-storybook-manifest-sha256") ?? null,
        compositionPath: root?.getAttribute("data-storybook-composition-path") ?? null,
        sourceDigest: root?.getAttribute("data-storybook-source-digest") ?? null,
        shots: document.querySelectorAll("[data-storybook-shot]").length,
        seek: typeof window.__storybookSeek === "function",
        timeline: Boolean(window.__timelines?.storybook),
        timelinePaused: Boolean(window.__timelines?.storybook?.paused?.()),
        timelineDuration: Number(window.__timelines?.storybook?.duration?.()),
        captionLayer: Boolean(document.querySelector('[data-storybook-captions="true"]')),
        captionCueCount: document.querySelectorAll('[data-storybook-captions="true"] [data-caption-id][data-caption-start][data-caption-end]').length,
        assetCount: images.length,
        loadedAssets: images.every(image => image.complete === true && image.naturalWidth > 0 && image.naturalHeight > 0),
      };
    });
    if (mount.manifestSha256 !== compiled.manifestSha256) die("final index does not mount the current compiled storybook asset manifest");
    if (mount.compositionPath !== compiled.composition.path) die(`final index mounts ${mount.compositionPath ?? "(none)"}, expected ${compiled.composition.path}`);
    if (mount.sourceDigest !== compiled.sourceDigest) die("final index does not mount the current compiled source digest");
    if (mount.shots !== manifest.shots.length) die(`final index mounts ${mount.shots} storybook shots, expected ${manifest.shots.length}`);
    if (!mount.seek) die("final index does not expose the storybook seek interface");
    if (!mount.timeline || !mount.timelinePaused) die("final index did not register a paused seekable storybook GSAP timeline");
    if (Math.abs(mount.timelineDuration - manifest.durationSec) > 0.01) die(`storybook GSAP timeline duration ${mount.timelineDuration} does not match ${manifest.durationSec}`);
    if (!mount.loadedAssets) die("final index has unloaded or zero-dimension character/background assets");
    if (captionEvidence && !mount.captionLayer) die("final index omits the required storybook caption layer");
    if (captionEvidence && mount.captionCueCount !== captionEvidence.groups.length) die(`final index mounts ${mount.captionCueCount} caption cues, expected ${captionEvidence.groups.length}`);
    if (!captionEvidence && mount.captionCueCount !== 0) die("silent storybook must not mount narration caption cues");
    let start = 0;
    for (const shot of manifest.shots) {
      const compiledShot = compiled.shots.find(candidate => candidate.id === shot.id);
      if (!compiledShot) die(`compiled asset manifest is missing shot ${shot.id}`);
      const authoredTimes = compiledShot.cast.flatMap(character => character.motion?.keyframes?.map(frame => Number(frame.timeSec)) ?? []).filter(time => Number.isFinite(time) && time >= 0 && time <= shot.durationSec);
      const interiorTimes = [];
      for (const character of compiledShot.cast) {
        const frames = character.motion?.keyframes ?? [];
        for (let index = 0; index < frames.length - 1; index += 1) interiorTimes.push((Number(frames[index].timeSec) + Number(frames[index + 1].timeSec)) / 2);
      }
      const lastVisibleTime = shot.durationSec - Math.min(0.01, shot.durationSec / 100);
      const localTimes = [...new Set([0, shot.durationSec * 0.5, lastVisibleTime, ...authoredTimes.map(time => Math.min(time, lastVisibleTime)), ...interiorTimes.map(time => Math.min(time, lastVisibleTime))])].filter(time => time >= 0 && time < shot.durationSec).sort((left, right) => left - right);
      const shotSamples = [];
      for (const [sampleIndex, localTime] of localTimes.entries()) {
        const time = start + localTime;
        const sample = await collectSample(page, shot.id, time, start);
        const repeat = await collectSample(page, shot.id, time, start);
        if (stableStringify({ background: sample.background, cast: sample.cast }) !== stableStringify({ background: repeat.background, cast: repeat.cast })) die(`${shot.id} at ${time}s is not deterministic across repeated seeks`);
        shotSamples.push(sample);
        const screenshotPath = join(auditDir, `${shot.id}-${sampleIndex}.png`);
        await page.screenshot({ path: screenshotPath });
        evidence.push(relative(root, screenshotPath));
        if (videoProof) {
          const frameIndex = Math.floor(time * videoProof.fps);
          const timeSec = frameIndex / videoProof.fps;
          await page.evaluate(seconds => window.__storybookSeek(seconds), timeSec);
          await waitPaint(page);
          const path = join(auditDir, `encoded-${shot.id}-${sampleIndex}.png`);
          await page.screenshot({ path });
          evidence.push(relative(root, path));
          videoFrames.push({ path: relative(root, path), sha256: sha256File(path), frameIndex, timeSec });
        }
      }
      samples.push({ shotId: shot.id, samples: shotSamples });
      const errors = verifySamples(shotSamples, compiledShot, manifest.canvas);
      if (errors.length) die(errors.join("; "));
      start += shot.durationSec;
    }
    if (captionEvidence) {
      for (const [captionIndex, group] of captionEvidence.groups.entries()) {
        const sample = await collectCaptionSample(page, group);
        captionSamples.push(sample);
        const errors = verifyCaptionSample(sample, group);
        if (errors.length) die(errors.join("; "));
        const screenshotPath = join(auditDir, `caption-${captionIndex}.png`);
        await page.screenshot({ path: screenshotPath });
        evidence.push(relative(root, screenshotPath));
        if (videoProof) {
          const frameIndex = Math.floor(sample.timeSec * videoProof.fps);
          const timeSec = frameIndex / videoProof.fps;
          await page.evaluate(seconds => window.__storybookSeek(seconds), timeSec);
          await waitPaint(page);
          const path = join(auditDir, `encoded-caption-${captionIndex}.png`);
          await page.screenshot({ path });
          evidence.push(relative(root, path));
          videoFrames.push({ path: relative(root, path), sha256: sha256File(path), frameIndex, timeSec });
        }
      }
    }
    await page.close();
  } finally {
    await browser.close();
  }
  const renderedAudio = video ? verifyRenderedAudio(root, manifest, audioPlan, video, mountedAudio.mixOrder) : null;
  const contactSheets = buildContactSheets(root, evidence);
  const screenshotHashes = evidence.map(path => ({ path, sha256: sha256File(join(root, path)) }));
  const report = {
    schemaVersion: 1,
    kind: "hyperframes-storybook-audit",
    status: "pass",
    projectDir: root,
    manifest: { path: relative(root, join(root, "storybook.json")), sha256: compiled.manifestSha256 },
    compiled: { path: relative(root, compiledInfo.path), sha256: compiledHash },
    source: { digest: sourceProof.digest, characters: sourceProof.characters, backgrounds: sourceProof.backgrounds, assets: sourceProof.assets },
    composition: { path: compiled.composition.path, sha256: compositionHash },
    index: { path: "index.html", sha256: indexHash },
    nativeLint,
    requirements: manifest.requirements,
    captions: captionEvidence ? { path: relative(root, captionEvidence.path), sha256: captionEvidence.sha256, files: captionEvidence.files, samples: captionSamples } : null,
    audio: { plan: audioPlan, mounts: audioMounts, mounted: mountedAudio, rendered: renderedAudio },
    motionTiming: { metadataSha256: existsSync(metadataPath) ? sha256File(metadataPath) : null, evidence: motionTiming },
    samples,
    evidence: { directory: AUDIT_DIR, screenshots: evidence, screenshotHashes, contactSheets, contact: `${AUDIT_DIR}/contact.json`, report: relative(root, reportFile), videoFrames, digest: null },
    video: videoProof,
  };
  report.evidence.digest = evidenceDigest(report);
  report.visuals = video ? verifyRenderedVisuals(root, report) : null;
  mkdirSync(dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  const contact = { kind: "hyperframes-storybook-visual-review", status: "review-required", report: relative(root, reportFile), sourceDigest: report.evidence.digest, screenshots: evidence, contactSheets, notes: "Review every screenshot and contact sheet for style, continuity, acting, caption readability, and aesthetic quality." };
  writeFileSync(join(auditDir, "contact.json"), `${JSON.stringify(contact, null, 2)}\n`);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.length === 0) {
    usage();
    process.exit(argv.includes("--help") ? 0 : 2);
  }
  const project = argv[0];
  const videoIndex = argv.indexOf("--video");
  const outIndex = argv.indexOf("--out");
  auditStorybook(project, { video: videoIndex >= 0 ? argv[videoIndex + 1] : null, outputPath: outIndex >= 0 ? argv[outIndex + 1] : REPORT_FILENAME })
    .then(report => console.log(JSON.stringify({ status: report.status, report: join(resolve(project), outIndex >= 0 ? argv[outIndex + 1] : REPORT_FILENAME), evidence: report.evidence })))
    .catch(error => { console.error(`✗ ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
}

#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import {
  COMPILED_FILENAME,
  COMPOSITION_FILENAME,
  loadManifest,
  manifestHash,
  projectPath,
  safeId,
  sha256Bytes,
  sha256File,
  stableStringify,
} from "./storybook-schema.mjs";

function die(message) {
  throw new Error(`scene compiler: ${message}`);
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function number(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normaliseHref(path) {
  return path.replaceAll("\\", "/");
}

function parsePng(buffer, path) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) die(`${path} is not a complete PNG image`);
  if (buffer.toString("ascii", 12, 16) !== "IHDR") die(`${path} is missing a PNG IHDR chunk`);
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) die(`${path} has invalid PNG dimensions`);
  return { type: "png", mime: "image/png", width, height };
}

function parseWebp(buffer, path) {
  if (buffer.length < 16 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") die(`${path} is not a complete WebP image`);
  let width = 0;
  let height = 0;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunk = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunk === "VP8X" && body + 10 <= buffer.length) {
      width = 1 + buffer[body + 4] + (buffer[body + 5] << 8) + (buffer[body + 6] << 16);
      height = 1 + buffer[body + 7] + (buffer[body + 8] << 8) + (buffer[body + 9] << 16);
      break;
    }
    if (chunk === "VP8L" && body + 5 <= buffer.length && buffer[body] === 0x2f) {
      width = 1 + buffer[body + 1] + ((buffer[body + 2] & 0x3f) << 8);
      height = 1 + ((buffer[body + 2] >> 6) | (buffer[body + 3] << 2) | ((buffer[body + 4] & 0x0f) << 10));
      break;
    }
    if (chunk === "VP8 " && body + 10 <= buffer.length) {
      const frame = buffer.indexOf(Buffer.from([0x9d, 0x01, 0x2a]), body);
      if (frame >= 0 && frame + 7 <= buffer.length) {
        width = buffer.readUInt16LE(frame + 3) & 0x3fff;
        height = buffer.readUInt16LE(frame + 5) & 0x3fff;
      }
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!width || !height) die(`${path} has unsupported or invalid WebP dimensions`);
  return { type: "webp", mime: "image/webp", width, height };
}

function svgNumber(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(?:px|pt|pc|cm|mm|in)?$/i);
  const numberValue = match ? Number(match[1]) : NaN;
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}

function parseSvg(buffer, path) {
  const text = buffer.toString("utf8");
  const rootMatch = text.match(/<svg\b([^>]*)>/i);
  if (!rootMatch) die(`${path} is not an SVG image with an <svg> root`);
  const attrs = rootMatch[1] ?? "";
  const readAttr = name => attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1] ?? null;
  const viewBox = readAttr("viewBox")?.trim().split(/[\s,]+/).map(Number) ?? [];
  const width = svgNumber(readAttr("width")) ?? (viewBox.length === 4 && Number.isFinite(viewBox[2]) && viewBox[2] > 0 ? viewBox[2] : null);
  const height = svgNumber(readAttr("height")) ?? (viewBox.length === 4 && Number.isFinite(viewBox[3]) && viewBox[3] > 0 ? viewBox[3] : null);
  if (!width || !height) die(`${path} must declare positive SVG width/height or viewBox dimensions`);
  if (/<(?:script|foreignObject)\b/i.test(text)) die(`${path} contains unsupported executable SVG content`);
  for (const match of text.matchAll(/(?:href|xlink:href)\s*=\s*["']([^"']+)["']/gi)) {
    if (/^(?:https?:|data:|file:|\/)/i.test(match[1])) die(`${path} contains a non-local SVG image reference`);
  }
  return { type: "svg", mime: "image/svg+xml", width, height };
}

function inspectImage(file, path) {
  let buffer;
  try { buffer = readFileSync(file); } catch (error) { die(`cannot read image ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  const extension = extname(path).toLowerCase();
  if (![".png", ".webp", ".svg"].includes(extension)) die(`${path} must be a local PNG, WebP, or SVG image`);
  if (extension === ".png") return parsePng(buffer, path);
  if (extension === ".webp") return parseWebp(buffer, path);
  return parseSvg(buffer, path);
}

function imageEntry(projectDir, asset, label, { character = false } = {}) {
  const file = projectPath(projectDir, asset.path, label);
  if (!existsSync(file)) die(`${label} not found at ${file}`);
  const image = inspectImage(file, asset.path);
  if (character && (!(asset.width > 0) || !(asset.height > 0))) die(`${label} must have positive authored width and height`);
  const sha256 = sha256File(file);
  if (asset.sha256 && asset.sha256 !== sha256) die(`${label} hash mismatch: manifest ${asset.sha256}, actual ${sha256}`);
  return {
    id: asset.id,
    path: asset.path,
    sha256,
    type: image.type,
    mime: image.mime,
    assetWidth: image.width,
    assetHeight: image.height,
    ...(character ? { width: asset.width, height: asset.height } : {}),
  };
}

function genericAssetEntry(projectDir, asset) {
  const file = projectPath(projectDir, asset.path, `asset ${asset.path}`);
  if (!existsSync(file)) die(`asset not found: ${asset.path}`);
  const sha256 = sha256File(file);
  if (asset.sha256 && asset.sha256 !== sha256) die(`asset hash mismatch for ${asset.path}: manifest ${asset.sha256}, actual ${sha256}`);
  return { path: asset.path, sha256 };
}

function sourceDigest(characters, backgrounds, assets) {
  return sha256Bytes(Buffer.from(stableStringify({ characters, backgrounds, assets }), "utf8"));
}

function frameTransform(x, y, scale, frame) {
  return `translate(${number(x) + number(frame?.x)}px, ${number(y) + number(frame?.y)}px) rotate(${number(frame?.rotation)}deg) scale(${scale})`;
}

function initialFrame(motion) {
  return motion?.keyframes?.[0] ?? { x: 0, y: 0, rotation: 0 };
}

function motionMoves(motion) {
  if (!motion || !Array.isArray(motion.keyframes) || motion.keyframes.length < 2) return false;
  const first = motion.keyframes[0];
  return motion.keyframes.some(frame => frame.x !== first.x || frame.y !== first.y || frame.rotation !== first.rotation);
}

function characterMarkup(shot, character, cast) {
  const logicalId = safeId(cast.id, "character");
  const instanceId = safeId(`${shot.id}-${logicalId}`, "character");
  const initial = initialFrame(cast.motion);
  const transform = frameTransform(cast.x, cast.y, cast.scale, initial);
  const motionJson = cast.motion ? esc(JSON.stringify(cast.motion)) : "";
  const attrs = [
    `id="${esc(instanceId)}"`,
    `data-storybook-instance="${esc(logicalId)}"`,
    `data-storybook-instance-id="${esc(instanceId)}"`,
    `data-storybook-character="${esc(character.id)}"`,
    `data-storybook-character-path="${esc(character.path)}"`,
    `data-storybook-character-width="${character.width}"`,
    `data-storybook-character-height="${character.height}"`,
    `data-storybook-instance-x="${cast.x}"`,
    `data-storybook-instance-y="${cast.y}"`,
    `data-storybook-instance-scale="${cast.scale}"`,
    `data-storybook-motion="${cast.motion ? "true" : "false"}"`,
    ...(cast.motion ? [`data-storybook-motion-keyframes="${motionJson}"`] : []),
    `style="position:absolute;width:0;height:0;left:0;top:0;transform-origin:0 0;transform:${transform}"`,
  ].join(" ");
  const imageAttrs = [
    `data-storybook-character-image="true"`,
    `data-storybook-character="${esc(character.id)}"`,
    `data-storybook-character-path="${esc(character.path)}"`,
    `data-storybook-asset-path="${esc(normaliseHref(character.path))}"`,
    `alt=""`,
    `loading="eager"`,
    `decoding="sync"`,
    `style="position:absolute;left:${-character.width / 2}px;top:${-character.height}px;width:${character.width}px;height:${character.height}px;display:block;object-fit:fill"`,
  ].join(" ");
  return {
    id: logicalId,
    domId: instanceId,
    markup: `<div ${attrs}><img ${imageAttrs}></div>`,
    motion: cast.motion,
    moving: motionMoves(cast.motion),
  };
}

function backgroundMarkup(background, canvas) {
  return `<img data-storybook-background="${esc(background.id)}" data-storybook-background-path="${esc(background.path)}" data-storybook-asset-path="${esc(normaliseHref(background.path))}" alt="" loading="eager" decoding="sync" style="position:absolute;inset:0;width:${canvas.width}px;height:${canvas.height}px;object-fit:cover;display:block">`;
}

function shotMarkup(shot, characters, backgrounds, start, canvas) {
  const background = backgrounds.find(item => item.id === shot.background);
  if (!background) die(`shot ${shot.id} references missing background ${shot.background}`);
  const cast = [];
  const seen = new Set();
  for (const instance of shot.cast) {
    const character = characters.find(item => item.id === instance.character);
    if (!character) die(`shot ${shot.id} cast ${instance.id} references missing character ${instance.character}`);
    const rendered = characterMarkup(shot, character, instance);
    if (seen.has(rendered.id)) die(`safe instance id collision in shot ${shot.id}: ${rendered.id}`);
    seen.add(rendered.id);
    cast.push({ ...rendered, character, authored: instance });
  }
  const markup = `<section id="storybook-shot-${esc(safeId(shot.id, "shot"))}" class="storybook-shot" data-start="${start}" data-duration="${shot.durationSec}" data-storybook-shot="${esc(shot.id)}" data-storybook-background="${esc(background.id)}"><div data-storybook-backdrop="true">${backgroundMarkup(background, canvas)}</div><div data-storybook-cast="true">${cast.map(item => item.markup).join("")}</div></section>`;
  return {
    markup,
    cast,
    background,
  };
}

function storybookRuntime() {
  function number(value, fallback) {
    const result = Number(value);
    return Number.isFinite(result) ? result : fallback;
  }
  function smooth(progress) {
    return 0.5 - Math.cos(Math.PI * progress) * 0.5;
  }
  function resolveAssetUrls() {
    const root = document.querySelector("[data-storybook-root]");
    const composition = String(root?.getAttribute("data-storybook-composition-path") || "");
    let current = String(window.location?.pathname || "").replaceAll("\\", "/");
    try { current = decodeURIComponent(current); } catch {}
    const compositionPath = composition.replaceAll("\\", "/").replace(/^\/+/, "");
    const standalone = Boolean(compositionPath && (current.endsWith(`/${compositionPath}`) || current === compositionPath));
    const depth = standalone ? Math.max(0, compositionPath.split("/").length - 1) : 0;
    const prefix = standalone ? `${"../".repeat(depth)}` : "";
    document.querySelectorAll("[data-storybook-asset-path]").forEach(node => {
      const path = node.getAttribute("data-storybook-asset-path");
      if (path) node.setAttribute(node.tagName.toLowerCase() === "img" ? "src" : "href", `${prefix}${path}`);
    });
  }
  function parseMotion(node) {
    if (node.__storybookMotion !== undefined) return node.__storybookMotion;
    const source = node.getAttribute("data-storybook-motion-keyframes");
    if (!source) {
      node.__storybookMotion = null;
      return null;
    }
    try { node.__storybookMotion = JSON.parse(source); } catch { node.__storybookMotion = null; }
    return node.__storybookMotion;
  }
  function sampleMotion(motion, seconds) {
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
      x: number(from.x, 0) + (number(to.x, 0) - number(from.x, 0)) * progress,
      y: number(from.y, 0) + (number(to.y, 0) - number(from.y, 0)) * progress,
      rotation: number(from.rotation, 0) + (number(to.rotation, 0) - number(from.rotation, 0)) * progress,
    };
  }
  function transformFor(node, seconds) {
    const x = number(node.getAttribute("data-storybook-instance-x"), 0);
    const y = number(node.getAttribute("data-storybook-instance-y"), 0);
    const scale = number(node.getAttribute("data-storybook-instance-scale"), 1);
    const frame = sampleMotion(parseMotion(node), seconds);
    return `translate(${x + number(frame.x, 0)}px, ${y + number(frame.y, 0)}px) rotate(${number(frame.rotation, 0)}deg) scale(${scale})`;
  }
  function applyPose(seconds) {
    seconds = number(seconds, 0);
    document.documentElement.dataset.storybookSeek = String(seconds);
    document.querySelectorAll("[data-storybook-shot]").forEach(shot => {
      const start = number(shot.getAttribute("data-start"), 0);
      const duration = Math.max(0, number(shot.getAttribute("data-duration"), 0));
      const local = Math.max(0, Math.min(duration, seconds - start));
      shot.style.visibility = seconds >= start && seconds < start + duration ? "visible" : "hidden";
      shot.querySelectorAll("[data-storybook-instance]").forEach(node => {
        const transform = transformFor(node, local);
        node.style.transform = transform;
      });
    });
  }
  let timeline = null;
  let syncing = false;
  function seek(seconds) {
    const root = document.querySelector("[data-storybook-root]");
    const total = number(root?.getAttribute("data-duration"), 0);
    const target = Math.max(0, Math.min(total, number(seconds, 0)));
    if (timeline && !syncing) {
      syncing = true;
      timeline.time(target, false);
      syncing = false;
    }
    applyPose(target);
  }
  window.__storybookSeek = seek;
  window.addEventListener("hf-seek", event => {
    const time = Number(event?.detail?.time);
    if (Number.isFinite(time)) seek(time);
  });
  if (!window.gsap || typeof window.gsap.timeline !== "function") throw new Error("storybook character composition requires GSAP 3.14.2");
  const root = document.querySelector("[data-storybook-root]");
  const totalDuration = number(root?.getAttribute("data-duration"), 0);
  window.__storybookManifest = {
    durationSec: totalDuration,
    shots: Array.from(document.querySelectorAll("[data-storybook-shot]")).map(shot => shot.getAttribute("data-storybook-shot")),
  };
  resolveAssetUrls();
  applyPose(0);
  timeline = window.gsap.timeline({ paused: true });
  const clock = { value: 0 };
  timeline.to(clock, { value: totalDuration, duration: totalDuration, ease: "none" }, 0);
  document.querySelectorAll("[data-storybook-shot]").forEach(shot => {
    const start = number(shot.getAttribute("data-start"), 0);
    const duration = Math.max(0, number(shot.getAttribute("data-duration"), 0));
    shot.querySelectorAll("[data-storybook-instance][data-storybook-motion-keyframes]").forEach(node => {
      let motion;
      try { motion = JSON.parse(node.getAttribute("data-storybook-motion-keyframes") || "{}"); } catch { motion = null; }
      const frames = Array.isArray(motion?.keyframes) ? motion.keyframes : [];
      for (let index = 0; index < frames.length - 1; index += 1) {
        const from = frames[index];
        const to = frames[index + 1];
        const x = number(node.getAttribute("data-storybook-instance-x"), 0);
        const y = number(node.getAttribute("data-storybook-instance-y"), 0);
        const scale = number(node.getAttribute("data-storybook-instance-scale"), 1);
        const value = `translate(${x + number(to.x, 0)}px, ${y + number(to.y, 0)}px) rotate(${number(to.rotation, 0)}deg) scale(${scale})`;
        timeline.to(node, { transform: value, duration: Math.max(0.000001, Number(to.timeSec) - Number(from.timeSec)), ease: "sine.inOut" }, start + Number(from.timeSec));
      }
      if (frames.length && Number(frames[frames.length - 1].timeSec) < duration) {
        const last = frames[frames.length - 1];
        const x = number(node.getAttribute("data-storybook-instance-x"), 0);
        const y = number(node.getAttribute("data-storybook-instance-y"), 0);
        const scale = number(node.getAttribute("data-storybook-instance-scale"), 1);
        timeline.to(node, { transform: `translate(${x + number(last.x, 0)}px, ${y + number(last.y, 0)}px) rotate(${number(last.rotation, 0)}deg) scale(${scale})`, duration: duration - Number(last.timeSec), ease: "none" }, start + Number(last.timeSec));
      }
    });
  });
  timeline.eventCallback("onUpdate", () => {
    syncing = true;
    applyPose(timeline.time());
    syncing = false;
  });
  window.__timelines = window.__timelines || {};
  window.__timelines.storybook = timeline;
  window.__storybookTimeline = timeline;
  seek(0);
}

function compositionHtml(manifest, shotsHtml, sourceDigest, compositionPath = COMPOSITION_FILENAME) {
  const { width, height } = manifest.canvas;
  const style = `.storybook-stage{position:relative;width:${width}px;height:${height}px;overflow:hidden}.storybook-shot{position:absolute;inset:0;width:${width}px;height:${height}px;visibility:hidden}.storybook-shot [data-storybook-instance]{transform-origin:0 0;will-change:transform}.storybook-shot [data-storybook-character-image]{user-select:none;pointer-events:none}`;
  const gsapScript = `<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js" integrity="sha384-sG0Hv1tP1lZCk9KQmrIbY/XNwi+OY84GQqhMscbnsoBFqAz8KNCil1kvfL3Hbbk2" crossorigin="anonymous"></script>`;
  const script = `<script>(${storybookRuntime.toString()})();</script>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${style}</style></head><body style="margin:0;overflow:hidden;background:transparent"><div id="root" data-composition-id="storybook" data-start="0" data-duration="${manifest.durationSec}" data-width="${width}" data-height="${height}" data-storybook-root="true" data-storybook-style="${esc(manifest.style)}" data-storybook-manifest-sha256="${manifestHash(manifest)}" data-storybook-composition-path="${esc(compositionPath)}" data-storybook-source-digest="${sourceDigest}"><div class="storybook-stage">${shotsHtml}</div></div>${gsapScript}${script}</body></html>`;
}

export function compileProject(projectDir, { manifestPath = null, outputPath = COMPOSITION_FILENAME } = {}) {
  const root = resolve(projectDir);
  const { path: manifestFile, manifest } = loadManifest(root, manifestPath);
  const characters = manifest.characters.map(character => imageEntry(root, character, `character ${character.id} path`, { character: true }));
  const backgrounds = manifest.backgrounds.map(background => imageEntry(root, background, `background ${background.id} path`));
  const assets = manifest.assets.map(asset => genericAssetEntry(root, asset));
  const digest = sourceDigest(characters, backgrounds, assets);
  const renderedShots = [];
  const compiledShots = [];
  let start = 0;
  for (const shot of manifest.shots) {
    const rendered = shotMarkup(shot, characters, backgrounds, start, manifest.canvas);
    renderedShots.push(rendered.markup);
    compiledShots.push({
      id: shot.id,
      durationSec: shot.durationSec,
      startSec: start,
      background: rendered.background.id,
      backgroundPath: rendered.background.path,
      cast: rendered.cast.map(item => ({
        id: item.id,
        character: item.character.id,
        characterPath: item.character.path,
        width: item.character.width,
        height: item.character.height,
        x: item.authored.x,
        y: item.authored.y,
        scale: item.authored.scale,
        motion: item.authored.motion,
        moving: item.moving,
      })),
    });
    start += shot.durationSec;
  }
  const destination = projectPath(root, outputPath, "composition output");
  const compositionPath = relative(root, destination).replaceAll("\\", "/");
  const html = compositionHtml(manifest, renderedShots.join(""), digest, compositionPath);
  mkdirSync(join(destination, ".."), { recursive: true });
  writeFileSync(destination, html);
  const compiled = {
    schemaVersion: 1,
    kind: "hyperframes-storybook-assets-manifest",
    manifestPath: relative(root, manifestFile).replaceAll("\\", "/"),
    manifestSha256: manifestHash(manifest),
    style: manifest.style,
    sourceDigest: digest,
    characters,
    backgrounds,
    assets,
    composition: { path: compositionPath, sha256: sha256File(destination) },
    canvas: manifest.canvas,
    durationSec: manifest.durationSec,
    requirements: manifest.requirements,
    shots: compiledShots,
  };
  const compiledPath = projectPath(root, COMPILED_FILENAME, "compiled asset manifest");
  mkdirSync(join(compiledPath, ".."), { recursive: true });
  writeFileSync(compiledPath, `${JSON.stringify(compiled, null, 2)}\n`);
  return { manifest, manifestFile, sourceDigest: digest, characters, backgrounds, assets, compositionPath: destination, compiledPath, compiled };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.length === 0) {
    console.log("Usage: node compile-scene.mjs <PROJECT_DIR> [--manifest <path>] [--output <relative-path>]");
    process.exit(argv.includes("--help") ? 0 : 2);
  }
  try {
    const project = argv[0];
    const manifestIndex = argv.indexOf("--manifest");
    const outputIndex = argv.indexOf("--output");
    const result = compileProject(project, {
      manifestPath: manifestIndex >= 0 ? argv[manifestIndex + 1] : null,
      outputPath: outputIndex >= 0 ? argv[outputIndex + 1] : COMPOSITION_FILENAME,
    });
    console.log(JSON.stringify({ composition: result.compositionPath, compiled: result.compiledPath, sourceDigest: result.compiled.sourceDigest, manifestSha256: result.compiled.manifestSha256 }, null, 2));
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

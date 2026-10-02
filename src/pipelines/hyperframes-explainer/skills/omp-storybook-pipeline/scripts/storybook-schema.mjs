import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export const STORYBOOK_SCHEMA_VERSION = 1;
export const STORYBOOK_KIND = "hyperframes-storybook";
export const STORYBOOK_STYLE = "storybook-flat";
export const STORYBOOK_FORMATS = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
};
export const MANIFEST_FILENAME = "storybook.json";
export const COMPILED_FILENAME = ".hyperframes/storybook-assets-manifest.json";
export const COMPOSITION_FILENAME = "compositions/storybook-characters.html";

const HASH_RE = /^[a-f0-9]{64}$/i;

export function safeId(value, fallback = "item") {
  const text = String(value ?? "").trim();
  const cleaned = text.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+/, "");
  const prefixed = /^[A-Za-z]/.test(cleaned) ? cleaned : `${fallback}-${cleaned || "item"}`;
  return prefixed.replace(/-+/g, "-").replace(/_+/g, "_").slice(0, 96) || `${fallback}-item`;
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

export function stableStringify(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function object(value, path, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path} must be an object`);
    return {};
  }
  return value;
}

function rejectKeys(value, allowed, path, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path}.${key} is not supported`);
  }
}

function nonEmptyString(value, path, errors) {
  if (typeof value !== "string" || !value.trim()) errors.push(`${path} must be a non-empty string`);
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value, path, errors, { min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    errors.push(`${path} must be a finite number in [${min}, ${max}]`);
  }
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalHash(value, path, errors) {
  if (value == null) return null;
  if (typeof value !== "string" || !HASH_RE.test(value)) errors.push(`${path} must be a SHA-256 hex digest when supplied`);
  return typeof value === "string" ? value.toLowerCase() : null;
}

function normaliseRequirements(raw, errors) {
  const req = raw == null ? {} : object(raw, "requirements", errors);
  rejectKeys(req, new Set(["narration", "music", "narrationMode"]), "requirements", errors);
  const narration = req.narration;
  const music = req.music;
  const narrationMode = req.narrationMode;
  if (narration !== "required" && narration !== "none") errors.push("requirements.narration must be required or none");
  if (music !== "required" && music !== "none") errors.push("requirements.music must be required or none");
  if (narrationMode !== "verbatim" && narrationMode !== "restructured") errors.push("requirements.narrationMode must be verbatim or restructured");
  return {
    narration: narration === "none" ? "none" : "required",
    music: music === "none" ? "none" : "required",
    narrationMode: narrationMode === "restructured" ? "restructured" : "verbatim",
  };
}

function normaliseNarration(raw, requirements, errors) {
  const narration = raw == null ? {} : object(raw, "narration", errors);
  rejectKeys(narration, new Set(["scriptPath", "lines"]), "narration", errors);
  const scriptPath = narration.scriptPath == null ? "SCRIPT.md" : nonEmptyString(narration.scriptPath, "narration.scriptPath", errors);
  const linesRaw = narration.lines == null ? [] : narration.lines;
  if (!Array.isArray(linesRaw)) errors.push("narration.lines must be an array");
  const lines = [];
  for (const [i, line] of (Array.isArray(linesRaw) ? linesRaw : []).entries()) {
    const item = object(line, `narration.lines[${i}]`, errors);
    rejectKeys(item, new Set(["shotId", "sceneId", "frameId", "text"]), `narration.lines[${i}]`, errors);
    const shotId = nonEmptyString(item.shotId ?? item.sceneId ?? item.frameId, `narration.lines[${i}].shotId`, errors);
    const text = nonEmptyString(item.text, `narration.lines[${i}].text`, errors);
    lines.push({ shotId, text });
  }
  if (requirements.narration === "required" && lines.length === 0) errors.push("narration.lines is required when requirements.narration is required");
  if (requirements.narration === "none" && lines.length !== 0) errors.push("narration.lines must be empty when requirements.narration is none");
  return { scriptPath, lines };
}

function normaliseAsset(raw, path, errors, { character = false } = {}) {
  const item = object(raw, path, errors);
  const allowed = character ? ["id", "path", "width", "height", "sha256"] : ["id", "path", "sha256"];
  rejectKeys(item, new Set(allowed), path, errors);
  const idValue = nonEmptyString(item.id, `${path}.id`, errors);
  const id = safeId(idValue, character ? "character" : "background");
  const assetPath = nonEmptyString(item.path, `${path}.path`, errors);
  const sha256 = optionalHash(item.sha256, `${path}.sha256`, errors);
  if (character) {
    const width = finiteNumber(item.width, `${path}.width`, errors, { min: 0.001, max: 16000 });
    const height = finiteNumber(item.height, `${path}.height`, errors, { min: 0.001, max: 16000 });
    return { id, path: assetPath, width, height, sha256 };
  }
  return { id, path: assetPath, sha256 };
}

function normaliseGenericAsset(raw, path, errors) {
  const item = object(raw, path, errors);
  rejectKeys(item, new Set(["path", "sha256"]), path, errors);
  const assetPath = nonEmptyString(item.path, `${path}.path`, errors);
  const sha256 = optionalHash(item.sha256, `${path}.sha256`, errors);
  return { path: assetPath, sha256 };
}

function normaliseKeyframes(raw, path, errors, maxTime) {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push(`${path} must be a non-empty array`);
    return [];
  }
  const frames = [];
  let previousTime = -Infinity;
  for (const [index, value] of raw.entries()) {
    const item = object(value, `${path}[${index}]`, errors);
    rejectKeys(item, new Set(["timeSec", "x", "y", "rotation"]), `${path}[${index}]`, errors);
    const timeSec = finiteNumber(item.timeSec, `${path}[${index}].timeSec`, errors, { min: 0, max: maxTime });
    if (timeSec <= previousTime) errors.push(`${path} timeSec values must be strictly increasing`);
    previousTime = timeSec;
    const x = finiteNumber(item.x, `${path}[${index}].x`, errors);
    const y = finiteNumber(item.y, `${path}[${index}].y`, errors);
    const rotation = item.rotation == null ? 0 : finiteNumber(item.rotation, `${path}[${index}].rotation`, errors, { min: -36000, max: 36000 });
    frames.push({ timeSec, x, y, rotation });
  }
  return frames;
}

function normaliseMotion(raw, path, errors, durationSec) {
  const item = object(raw, path, errors);
  rejectKeys(item, new Set(["keyframes"]), path, errors);
  return { keyframes: normaliseKeyframes(item.keyframes, `${path}.keyframes`, errors, durationSec) };
}

function normaliseCast(raw, path, errors, durationSec) {
  const item = object(raw, path, errors);
  rejectKeys(item, new Set(["id", "character", "x", "y", "scale", "motion"]), path, errors);
  const idValue = nonEmptyString(item.id, `${path}.id`, errors);
  const id = safeId(idValue, "character");
  const characterValue = nonEmptyString(item.character, `${path}.character`, errors);
  const character = safeId(characterValue, "character");
  const x = finiteNumber(item.x, `${path}.x`, errors);
  const y = finiteNumber(item.y, `${path}.y`, errors);
  const scale = item.scale == null ? 1 : finiteNumber(item.scale, `${path}.scale`, errors, { min: 0.01, max: 100 });
  const motion = item.motion == null ? null : normaliseMotion(item.motion, `${path}.motion`, errors, durationSec);
  return { id, character, x, y, scale, motion };
}

function normaliseShot(raw, index, errors) {
  const path = `shots[${index}]`;
  const item = object(raw, path, errors);
  rejectKeys(item, new Set(["id", "durationSec", "duration", "background", "cast"]), path, errors);
  const idValue = nonEmptyString(item.id ?? `shot-${index + 1}`, `${path}.id`, errors);
  const id = safeId(idValue, "shot");
  const durationSec = finiteNumber(item.durationSec ?? item.duration, `${path}.durationSec`, errors, { min: 0.05, max: 3600 });
  const backgroundValue = nonEmptyString(item.background, `${path}.background`, errors);
  const background = safeId(backgroundValue, "background");
  const castRaw = item.cast;
  if (!Array.isArray(castRaw) || castRaw.length === 0) errors.push(`${path}.cast must be a non-empty array`);
  const cast = (Array.isArray(castRaw) ? castRaw : []).map((entry, castIndex) => normaliseCast(entry, `${path}.cast[${castIndex}]`, errors, durationSec));
  const seen = new Set();
  for (const character of cast) {
    if (seen.has(character.id)) errors.push(`${path}.cast has duplicate instance id ${character.id}`);
    seen.add(character.id);
  }
  return { id, durationSec, background, cast };
}

export function normaliseManifest(raw, errors = []) {
  const input = object(raw, "manifest", errors);
  rejectKeys(input, new Set(["schemaVersion", "version", "kind", "style", "format", "canvas", "durationSec", "requirements", "narration", "assets", "characters", "backgrounds", "shots", "meta"]), "manifest", errors);
  const schemaVersion = input.schemaVersion ?? input.version;
  if (schemaVersion !== STORYBOOK_SCHEMA_VERSION) errors.push(`schemaVersion must be ${STORYBOOK_SCHEMA_VERSION}`);
  if (input.kind !== STORYBOOK_KIND) errors.push(`kind must be ${STORYBOOK_KIND}`);
  const style = input.style ?? STORYBOOK_STYLE;
  if (style !== STORYBOOK_STYLE) errors.push(`style must be ${STORYBOOK_STYLE} (the only supported storybook style)`);
  const format = input.format ?? "landscape";
  if (!(format in STORYBOOK_FORMATS)) errors.push("format must be landscape, portrait, or square");
  const dimensions = STORYBOOK_FORMATS[format] ?? STORYBOOK_FORMATS.landscape;
  const canvas = input.canvas == null ? null : object(input.canvas, "canvas", errors);
  if (canvas) rejectKeys(canvas, new Set(["width", "height"]), "canvas", errors);
  const width = canvas?.width == null ? dimensions.width : finiteNumber(canvas.width, "canvas.width", errors, { min: 16, max: 16000 });
  const height = canvas?.height == null ? dimensions.height : finiteNumber(canvas.height, "canvas.height", errors, { min: 16, max: 16000 });
  if (canvas && (width !== dimensions.width || height !== dimensions.height)) errors.push(`canvas must match ${format} format dimensions ${dimensions.width}x${dimensions.height}`);

  const requirements = normaliseRequirements(input.requirements, errors);
  if (input.source != null) errors.push("source is not supported; use root characters and backgrounds");

  const charactersInput = input.characters;
  if (!Array.isArray(charactersInput) || charactersInput.length === 0) errors.push("characters must be a non-empty array");
  const characters = (Array.isArray(charactersInput) ? charactersInput : []).map((entry, index) => normaliseAsset(entry, `characters[${index}]`, errors, { character: true }));
  const backgroundsInput = input.backgrounds;
  if (!Array.isArray(backgroundsInput) || backgroundsInput.length === 0) errors.push("backgrounds must be a non-empty array");
  const backgrounds = (Array.isArray(backgroundsInput) ? backgroundsInput : []).map((entry, index) => normaliseAsset(entry, `backgrounds[${index}]`, errors));
  const checkIds = (items, label) => {
    const ids = new Set();
    for (const item of items) {
      if (ids.has(item.id)) errors.push(`${label} has duplicate id ${item.id}`);
      ids.add(item.id);
    }
  };
  checkIds(characters, "characters");
  checkIds(backgrounds, "backgrounds");

  const assetsInput = input.assets ?? [];
  if (!Array.isArray(assetsInput)) errors.push("assets must be an array");
  const assets = (Array.isArray(assetsInput) ? assetsInput : []).map((asset, i) => normaliseGenericAsset(asset, `assets[${i}]`, errors));
  const shotsInput = input.shots;
  if (!Array.isArray(shotsInput) || shotsInput.length === 0) errors.push("shots must be a non-empty array");
  const shots = (Array.isArray(shotsInput) ? shotsInput : []).map((shot, index) => normaliseShot(shot, index, errors));
  const shotIds = new Set();
  for (const shot of shots) {
    if (shotIds.has(shot.id)) errors.push(`shots has duplicate id ${shot.id}`);
    shotIds.add(shot.id);
    if (backgrounds.length && !backgrounds.some(background => background.id === shot.background)) errors.push(`shots ${shot.id} references missing background ${shot.background}`);
    for (const character of shot.cast) {
      if (characters.length && !characters.some(candidate => candidate.id === character.character)) errors.push(`shots ${shot.id} cast ${character.id} references missing character ${character.character}`);
    }
  }
  const durationSec = finiteNumber(input.durationSec ?? shots.reduce((sum, shot) => sum + shot.durationSec, 0), "durationSec", errors, { min: 0.05, max: 86400 });
  const sum = shots.reduce((total, shot) => total + shot.durationSec, 0);
  if (Math.abs(durationSec - sum) > 0.001) errors.push(`durationSec ${durationSec} must equal the exact sum of shot durations ${sum}`);
  const narration = normaliseNarration(input.narration, requirements, errors);
  const meta = input.meta == null ? {} : object(input.meta, "meta", errors);
  return {
    schemaVersion: STORYBOOK_SCHEMA_VERSION,
    kind: STORYBOOK_KIND,
    style,
    format,
    canvas: { width, height },
    durationSec,
    requirements,
    characters,
    backgrounds,
    assets,
    narration,
    shots,
    meta,
  };
}

export function validateManifest(raw) {
  const errors = [];
  const manifest = normaliseManifest(raw, errors);
  return { ok: errors.length === 0, errors, manifest };
}

export function manifestHash(manifest) {
  return sha256Bytes(Buffer.from(stableStringify(manifest), "utf8"));
}

function safeProjectPath(projectDir, pathValue, label) {
  if (typeof pathValue !== "string" || !pathValue.trim()) throw new Error(`${label} is missing`);
  if (isAbsolute(pathValue)) throw new Error(`${label} must be project-relative`);
  const abs = resolve(projectDir, pathValue);
  const rel = relative(resolve(projectDir), abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${label} escapes project directory: ${pathValue}`);
  return abs;
}

export function projectPath(projectDir, pathValue, label = "path") {
  return safeProjectPath(projectDir, pathValue, label);
}

export function loadManifest(projectDir, manifestPath = null) {
  const path = manifestPath ? (isAbsolute(manifestPath) ? manifestPath : join(projectDir, manifestPath)) : join(projectDir, MANIFEST_FILENAME);
  if (!existsSync(path)) throw new Error(`storybook manifest not found at ${path}`);
  let raw;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (error) { throw new Error(`invalid storybook manifest ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  const parsed = validateManifest(raw);
  if (!parsed.ok) throw new Error(`invalid storybook manifest: ${parsed.errors.join("; ")}`);
  return { path, raw, manifest: parsed.manifest };
}

export function readJson(path, label = path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (error) { throw new Error(`invalid ${label}: ${error instanceof Error ? error.message : String(error)}`); }
}

export function hashProjectFile(projectDir, pathValue, label = "file") {
  const abs = projectPath(projectDir, pathValue, label);
  if (!existsSync(abs)) throw new Error(`${label} not found at ${abs}`);
  return { path: pathValue, absolutePath: abs, sha256: sha256File(abs) };
}

export function assertHash(value, label) {
  if (typeof value !== "string" || !HASH_RE.test(value)) throw new Error(`${label} is not a SHA-256 digest`);
  return value.toLowerCase();
}

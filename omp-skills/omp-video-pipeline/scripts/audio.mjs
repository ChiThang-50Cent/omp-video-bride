#!/usr/bin/env node
// Storybook audio adapter: one local Kokoro batch, one combined Whisper pass,
// approved-phrase ASR span mapping, beat-preserving WAV fitting, and deterministic offline music.  This is a
// workflow adapter, not a second provider engine.  It writes the frame-keyed
// audio_meta.json consumed by faceless-explainer and the id-keyed
// audio_engine_meta.json consumed by its fetch-sfx wrapper.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const realPath = path => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};
const HERE = dirname(realPath(fileURLToPath(import.meta.url)));
const BATCH_SCRIPT = join(HERE, "batch_tts.py");
const DEFAULT_VOICE = "am_michael";
const FIT_EPSILON = 0.005;
const R3 = (n) => Math.round(n * 1000) / 1000;

const HELP = `Usage:
  node audio.mjs <project-dir> [options]

Generate approved storybook narration and an optional original offline music bed.
The project must contain SCRIPT.md and STORYBOARD.md.

Options:
  --voice <id>                    Kokoro voice (default: ${DEFAULT_VOICE})
  --speed <number>                Exact Kokoro speed (default: 1)
  --music required|none           Music policy (default: required)
  --narration-mode verbatim|restructured
                                  Preserve supplied script text (default: verbatim)
  --storyboard <path>             Override STORYBOARD.md
  --script <path>                 Override SCRIPT.md
  --out <path>                    Override audio_meta.json
  --upstream-scripts <path>       Upstream scripts directory for one ASR pass
  --transcribe <path>             Explicit upstream transcribe.mjs
  --model <path>                  Kokoro ONNX model override
  --voices <path>                 Kokoro voice pack override
  --batch-python <path>           Python executable override
  -h, --help                      Show this help without reading or writing files

The TTS helper loads kokoro-onnx once for the whole batch. Every narration WAV
is fit to its approved storyboard beat: shorter speech is padded, but speech
that exceeds a beat fails instead of being cut or rewritten.`;

class AudioError extends Error {}

function fail(message) {
  throw new AudioError(message);
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const valueFlags = new Set([
    "voice",
    "speed",
    "music",
    "narration-mode",
    "storyboard",
    "script",
    "out",
    "upstream-scripts",
    "transcribe",
    "model",
    "voices",
    "batch-python",
  ]);
  const out = {
    project: null,
    voice: DEFAULT_VOICE,
    speed: 1,
    music: "required",
    narrationMode: "verbatim",
    storyboard: null,
    script: null,
    out: null,
    upstreamScripts: null,
    transcribe: null,
    model: null,
    voices: null,
    batchPython: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const name = token.slice(2);
      if (!valueFlags.has(name)) fail(`unknown option --${name} (use --help)`);
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) fail(`--${name} requires a value`);
      const value = argv[++i];
      if (name === "script") out.scriptRequired = true;
      if (name === "narration-mode") out.narrationMode = value;
      else if (name === "batch-python") out.batchPython = value;
      else out[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      continue;
    }
    if (out.project !== null) fail(`unexpected positional argument ${token}`);
    out.project = token;
  }
  if (!out.project) fail("project directory is required (use --help for usage)");
  out.project = resolve(out.project);
  out.storyboard = resolve(out.storyboard ?? join(out.project, "STORYBOARD.md"));
  out.script = resolve(out.script ?? join(out.project, "SCRIPT.md"));
  out.out = resolve(out.out ?? join(out.project, "audio_meta.json"));
  if (!out.voice || typeof out.voice !== "string") fail("--voice must be a non-empty voice id");
  out.speed = Number(out.speed);
  if (!Number.isFinite(out.speed) || out.speed <= 0) fail("--speed must be a finite number greater than zero");
  if (!["required", "none"].includes(out.music)) fail(`--music must be required or none, got ${out.music}`);
  if (!["verbatim", "restructured"].includes(out.narrationMode))
    fail(`--narration-mode must be verbatim or restructured, got ${out.narrationMode}`);
  return out;
}

function parseDuration(value) {
  const match = String(value ?? "").match(/(\d+(?:\.\d+)?)/);
  const result = match ? Number(match[1]) : NaN;
  return Number.isFinite(result) && result > 0 ? result : NaN;
}

/** Parse the lenient Frame/Beat/Scene headings used by upstream STORYBOARD.md. */
export function parseStoryboard(source) {
  const lines = String(source).split(/\r?\n/);
  const frames = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    if (!Number.isFinite(current.duration)) {
      fail(`STORYBOARD.md frame ${current.number ?? current.index} has no valid "- duration: Xs"`);
    }
    frames.push(current);
    current = null;
  };
  for (const line of lines) {
    const heading = line.match(/^#{2,3}\s+(Frame|Beat|Scene)\b\s*(.*)$/i);
    if (heading) {
      flush();
      const tail = heading[2] ?? "";
      const number = Number(tail.match(/^(\d+)/)?.[1]);
      current = {
        index: frames.length + 1,
        number: Number.isFinite(number) && number > 0 ? number : frames.length + 1,
        title: tail.replace(/^\d+\s*[—–:-]?\s*/, "").trim(),
        duration: NaN,
        src: null,
        lines: [],
      };
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    const meta = line.match(/^\s*[-*]?\s*(duration|src)\s*:\s*(.*?)\s*$/i);
    if (meta) {
      if (meta[1].toLowerCase() === "duration") current.duration = parseDuration(meta[2]);
      else current.src = meta[2].replace(/^['"]|['"]$/g, "");
    }
  }
  flush();
  if (!frames.length) fail("STORYBOARD.md contains no Frame/Beat/Scene sections");
  const numbers = new Set();
  for (const frame of frames) {
    if (numbers.has(frame.number)) fail(`STORYBOARD.md repeats frame number ${frame.number}`);
    numbers.add(frame.number);
  }
  return frames;
}

/** Parse the upstream SCRIPT.md indented narration convention without rewriting copy. */
export function parseScript(source) {
  const lines = String(source).split(/\r?\n/);
  const entries = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const text = current.lines.join(" ").trim();
    if (text && !current.frame) fail(`SCRIPT.md heading "${current.title}" has no (Frame N) mapping`);
    if (text) entries.push({ frame: current.frame, text, title: current.title });
    current = null;
  };
  for (const line of lines) {
    const heading = line.match(/^#{2,3}\s+(.+?)\s*$/);
    if (heading) {
      const headingText = heading[1];
      const explicit = headingText.match(/\((?:frame|beat|scene)\s+(\d+)\)/i);
      const leading = headingText.match(/^(?:line|frame|beat|scene)\s+(\d+)/i);
      const frame = Number(explicit?.[1] ?? leading?.[1]);
      flush();
      current = {
        frame,
        title: headingText,
        lines: [],
      };
      continue;
    }
    if (!current) continue;
    // **Voice:** / **Time:** and other metadata rows are not spoken text.
    if (/^\s*\*\*[^*]+\*\*\s*:/.test(line)) continue;
    const indented = line.match(/^(?: {4,}|\t)(.*)$/);
    if (indented && indented[1].trim()) current.lines.push(indented[1].trim());
  }
  flush();
  return entries;
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot parse ${path}: ${error.message}`);
  }
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha256(path) {
  return sha256(readFileSync(path));
}

function relProject(project, path) {
  const rel = relative(project, path).split(sep).join("/");
  return rel && !rel.startsWith("../") && rel !== ".." ? rel : path;
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 << 20,
      timeout: options.timeout ?? 1_800_000,
    });
  } catch (error) {
    const details = String(error.stderr ?? error.stdout ?? error.message ?? "").trim();
    fail(`${options.label ?? command} failed${error.status != null ? ` (exit ${error.status})` : ""}${details ? `: ${details.slice(-1800)}` : ""}`);
  }
}

function ffprobeDuration(path) {
  const out = run(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      "--",
      path,
    ],
    { label: `ffprobe ${path}`, timeout: 60_000 },
  );
  const duration = Number.parseFloat(String(out).trim());
  if (!Number.isFinite(duration) || duration <= 0)
    fail(`ffprobe ${path} returned an invalid duration: ${String(out).trim() || "(empty output)"}`);
  return duration;
}

function ensureMeasuredWav(path, label) {
  if (!existsSync(path)) fail(`${label} did not produce ${path}`);
  const duration = ffprobeDuration(path);
  if (!Number.isFinite(duration) || duration <= 0) fail(`${label} produced an unreadable or empty WAV: ${path}`);
  return duration;
}


function loadCache(path) {
  const empty = { version: 3, synthesis: {}, fits: {}, beat_key: null, bgm: null, asr: null };
  const value = readJson(path, empty);
  if (!value || typeof value !== "object") return empty;
  return {
    version: 3,
    synthesis: value.synthesis && typeof value.synthesis === "object" ? value.synthesis : {},
    fits: value.fits && typeof value.fits === "object" ? value.fits : {},
    beat_key: typeof value.beat_key === "string" ? value.beat_key : null,
    bgm: value.bgm && typeof value.bgm === "object" ? value.bgm : null,
    asr: value.asr && typeof value.asr === "object" ? value.asr : null,
  };
}

function cacheSource(cache, project, key) {
  const entry = cache.synthesis[key];
  if (!entry || typeof entry.source_path !== "string") return null;
  const path = resolve(project, entry.source_path);
  if (!path.startsWith(`${project}${sep}`) || !existsSync(path)) return null;
  if (entry.sha256 !== fileSha256(path)) return null;
  const duration = ensureMeasuredWav(path, `cached synthesis ${key}`);
  return { path, duration };
}

function fitAudio(source, destination, target, sourceDuration) {
  if (sourceDuration > target) {
    fail(
      `speech overflow: ${source} measures ${R3(sourceDuration)}s but frame beat allows ${R3(target)}s. ` +
        "Increase --speed or reallocate the beat duration; verbatim narration is never shortened or truncated.",
    );
  }
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}.wav`;
  if (sourceDuration >= target) {
    copyFileSync(source, temporary);
  } else {
    const pad = Math.max(0, target - sourceDuration);
    run(
      "ffmpeg",
      [
        "-nostdin",
        "-y",
        "-loglevel",
        "error",
        "-i",
        source,
        "-af",
        `apad=pad_dur=${pad.toFixed(6)},atrim=duration=${target.toFixed(6)},asetpts=N/SR/TB`,
        "-ar",
        "24000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        temporary,
      ],
      { label: `padding narration ${destination}` },
    );
  }
  renameSync(temporary, destination);
  const fitted = ensureMeasuredWav(destination, `fitted narration ${destination}`);
  if (Math.abs(fitted - target) > FIT_EPSILON)
    fail(`fitted narration ${destination} measures ${R3(fitted)}s, expected beat ${R3(target)}s`);
  return fitted;
}

function buildConcatList(paths, destination) {
  const quote = (path) => path.replaceAll("'", "'\\''");
  writeFileSync(destination, paths.map((path) => `file '${quote(path)}'`).join("\n") + "\n");
}

function resolveTranscriber(options) {
  const candidates = [];
  if (options.transcribe) candidates.push(resolve(options.transcribe));
  if (process.env.UPSTREAM_TRANSCRIBE) candidates.push(resolve(process.env.UPSTREAM_TRANSCRIBE));
  if (options.upstreamScripts) {
    const upstream = resolve(options.upstreamScripts);
    candidates.push(join(upstream, "transcribe.mjs"));
    candidates.push(join(dirname(dirname(upstream)), "media-use", "scripts", "transcribe.mjs"));
  }
  for (const base of [
    "/opt/skills/media-use/scripts/transcribe.mjs",
    join(homedir(), ".agents/skills/media-use/scripts/transcribe.mjs"),
    join(homedir(), ".pi/agent/skills/media-use/scripts/transcribe.mjs"),
  ])
    candidates.push(base);
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    }
  }
  return null;
}

function normalizeWords(payload) {
  let values = Array.isArray(payload) ? payload : payload?.words;
  if (!Array.isArray(values) && Array.isArray(payload?.segments)) {
    values = payload.segments.flatMap((segment) => segment.words ?? []);
  }
  if (!Array.isArray(values)) return [];
  return values
    .map((word) => {
      const text = String(word?.text ?? word?.word ?? "").trim();
      const timestamp = Array.isArray(word?.timestamp) ? word.timestamp : null;
      const start = Number(word?.start ?? word?.start_s ?? timestamp?.[0]);
      const end = Number(word?.end ?? word?.end_s ?? timestamp?.[1]);
      return { text, start, end };
    })
    .filter((word) => word.text && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start)
    .sort((a, b) => a.start - b.start);
}

const ASR_ALIGNMENT_SCHEMA = "source-guided-v2";
const ALIGNMENT_BOUNDARY_TOLERANCE = 0.35;
const ALIGNMENT_TIME_EPSILON = 0.001;
const ASR_DELETE_COST = 1.15;
const ASR_INSERT_COST = 1.15;

function normalizeCaptionToken(value) {
  return String(value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function tokenizeNarration(text) {
  return String(text)
    .split(/[\s()[\]{}]+/)
    .filter((value) => normalizeCaptionToken(value))
    .map((value) => ({ text: value, norm: normalizeCaptionToken(value) }));
}

function tokenEditDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const saved = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = saved;
    }
  }
  return previous[right.length];
}

function asrPairCost(source, raw, interval) {
  const overlap = Math.min(raw.end, interval.end) - Math.max(raw.start, interval.start);
  if (overlap <= ALIGNMENT_TIME_EPSILON) return Number.POSITIVE_INFINITY;
  const rawNorm = normalizeCaptionToken(raw.text);
  let lexical = 1.35;
  if (source.norm === rawNorm) lexical = 0;
  else {
    const distance = tokenEditDistance(source.norm, rawNorm);
    if (distance <= 1) lexical = 0.45;
    else if (distance <= 2) lexical = 0.75;
  }
  const midpoint = (raw.start + raw.end) / 2;
  const drift = midpoint < interval.start ? interval.start - midpoint : midpoint > interval.end ? midpoint - interval.end : 0;
  const boundaryPenalty = drift > 0 ? 0.3 + Math.min(drift / ALIGNMENT_BOUNDARY_TOLERANCE, 2) * 0.3 : 0;
  return lexical + boundaryPenalty;
}

function sourceGuidedAssignments(sourceTokens, rawWords, offsets) {
  if (!rawWords.length) fail("source-guided ASR alignment returned no measured words; refusing synthetic captions");
  const rowCount = sourceTokens.length;
  const columnCount = rawWords.length;
  const costs = Array.from({ length: rowCount + 1 }, () => new Float64Array(columnCount + 1));
  const operations = Array.from({ length: rowCount + 1 }, () => new Uint8Array(columnCount + 1));
  for (let row = 1; row <= rowCount; row++) {
    costs[row][0] = costs[row - 1][0] + ASR_DELETE_COST;
    operations[row][0] = 2;
  }
  for (let column = 1; column <= columnCount; column++) {
    costs[0][column] = costs[0][column - 1] + ASR_INSERT_COST;
    operations[0][column] = 3;
  }
  for (let row = 1; row <= rowCount; row++) {
    const source = sourceTokens[row - 1];
    for (let column = 1; column <= columnCount; column++) {
      const raw = rawWords[column - 1];
      const pair = costs[row - 1][column - 1] + asrPairCost(source, raw, source.interval);
      let best = pair;
      let operation = 1;
      const deletion = costs[row - 1][column] + ASR_DELETE_COST;
      if (deletion < best - 1e-9) {
        best = deletion;
        operation = 2;
      }
      const insertion = costs[row][column - 1] + ASR_INSERT_COST;
      if (insertion < best - 1e-9) {
        best = insertion;
        operation = 3;
      }
      costs[row][column] = best;
      operations[row][column] = operation;
    }
  }

  const sourceToRaw = Array(rowCount).fill(null);
  let row = rowCount;
  let column = columnCount;
  while (row > 0 || column > 0) {
    const operation = operations[row][column];
    if (operation === 1) {
      sourceToRaw[row - 1] = column - 1;
      row--;
      column--;
    } else if (operation === 2) {
      row--;
    } else if (operation === 3) {
      column--;
    } else {
      fail("source-guided ASR alignment produced an incomplete edit path");
    }
  }

  // A mismatched span straddling a beat boundary is not a safe anchor for
  // the source token. Prefer a measured span from the same authored frame;
  // leave it omitted when no such anchor exists so the final gate fails.
  for (let index = 0; index < rowCount; index++) {
    const rawIndex = sourceToRaw[index];
    if (rawIndex === null) continue;
    const source = sourceTokens[index];
    const raw = rawWords[rawIndex];
    const midpoint = (raw.start + raw.end) / 2;
    const outside = midpoint < source.interval.start || midpoint > source.interval.end;
    if (!outside || source.norm === normalizeCaptionToken(raw.text)) continue;
    let replacement = null;
    let distance = Infinity;
    for (let candidate = 0; candidate < rowCount; candidate++) {
      if (candidate === index || sourceTokens[candidate].frame !== source.frame || sourceToRaw[candidate] === null) continue;
      const candidateRaw = rawWords[sourceToRaw[candidate]];
      const overlap =
        Math.min(candidateRaw.end, source.interval.end) - Math.max(candidateRaw.start, source.interval.start);
      const candidateMidpoint = (candidateRaw.start + candidateRaw.end) / 2;
      if (
        overlap <= ALIGNMENT_TIME_EPSILON ||
        candidateMidpoint < source.interval.start ||
        candidateMidpoint > source.interval.end
      )
        continue;
      const candidateDistance = Math.abs(candidate - index);
      if (candidateDistance < distance) {
        distance = candidateDistance;
        replacement = sourceToRaw[candidate];
      }
    }
    sourceToRaw[index] = replacement;
  }

  const matched = sourceToRaw.filter((value) => value !== null).length;
  const omitted = rowCount - matched;
  const substitutions = sourceToRaw.reduce(
    (count, rawIndex, index) =>
      rawIndex !== null && sourceTokens[index].norm !== normalizeCaptionToken(rawWords[rawIndex].text) ? count + 1 : count,
    0,
  );
  if (!matched) fail("source-guided ASR alignment matched no authored words; rerun with an accurate prompted real ASR transcript");
  if (omitted > Math.max(3, Math.floor(rowCount * 0.45))) {
    fail(
      `source-guided ASR alignment omitted ${omitted} of ${rowCount} authored words; ` +
        "rerun with an accurate prompted real ASR transcript instead of assigning unmeasured timestamps",
    );
  }
  if (substitutions > Math.max(3, Math.floor(rowCount * 0.25))) {
    fail(
      `source-guided ASR alignment substituted ${substitutions} of ${matched} measured words; ` +
        "rerun with an accurate prompted real ASR transcript instead of assigning wrong-shot captions",
    );
  }

  const measuredInFrame = (rawIndex, token) => {
    const raw = rawWords[rawIndex];
    return Math.min(raw.end, token.interval.end) - Math.max(raw.start, token.interval.start) > ALIGNMENT_TIME_EPSILON;
  };
  // A recognizer can omit a short word or collapse two words into one span.
  // Bind omitted source tokens to the nearest measured source-order span so
  // the authored phrase remains exact without creating timestamps.
  for (let index = 0; index < rowCount; index++) {
    if (sourceToRaw[index] !== null) continue;
    const frame = sourceTokens[index].frame;
    let replacement = null;
    for (let next = index + 1; next < rowCount; next++) {
      if (
        sourceTokens[next].frame === frame &&
        sourceToRaw[next] !== null &&
        measuredInFrame(sourceToRaw[next], sourceTokens[index])
      ) {
        replacement = sourceToRaw[next];
        break;
      }
    }
    if (replacement === null) {
      for (let previous = index - 1; previous >= 0; previous--) {
        if (
          sourceTokens[previous].frame === frame &&
          sourceToRaw[previous] !== null &&
          measuredInFrame(sourceToRaw[previous], sourceTokens[index])
        ) {
          replacement = sourceToRaw[previous];
          break;
        }
      }
    }
    if (replacement === null) {
      for (let next = index + 1; next < rowCount; next++) {
        if (sourceToRaw[next] !== null) {
          replacement = sourceToRaw[next];
          break;
        }
      }
    }
    if (replacement === null) {
      for (let previous = index - 1; previous >= 0; previous--) {
        if (sourceToRaw[previous] !== null) {
          replacement = sourceToRaw[previous];
          break;
        }
      }
    }
    if (replacement === null) fail(`source-guided ASR alignment cannot measure authored token "${sourceTokens[index].text}"`);
    sourceToRaw[index] = replacement;
  }

  const byFrame = new Map(offsets.map((offset) => [offset.frame.number, []]));
  for (const frame of offsets) {
    const frameTokens = sourceTokens.filter((token) => token.frame === frame.frame.number);
    if (!frameTokens.length) fail(`source-guided ASR alignment has no authored narration for frame ${frame.frame.number}`);
    const chunks = [];
    let current = null;
    for (const token of frameTokens) {
      const sourceIndex = sourceTokens.indexOf(token);
      const rawIndex = sourceToRaw[sourceIndex];
      if (current && current.rawIndex === rawIndex) current.text += ` ${token.text}`;
      else {
        if (current) chunks.push(current);
        current = { rawIndex, text: token.text };
      }
    }
    if (current) chunks.push(current);
    let previousRaw = -1;
    let previousEnd = 0;
    const words = [];
    for (const chunk of chunks) {
      if (chunk.rawIndex < previousRaw) {
        fail(`source-guided ASR alignment reversed source order in frame ${frame.frame.number}`);
      }
      previousRaw = chunk.rawIndex;
      const raw = rawWords[chunk.rawIndex];
      const start = R3(Math.max(raw.start, frame.start) - frame.start);
      const end = R3(Math.min(raw.end, frame.end) - frame.start);
      if (end <= start || end <= start + ALIGNMENT_TIME_EPSILON) {
        const drift = raw.end <= frame.start ? frame.start - raw.end : raw.start - frame.end;
        fail(
          `source-guided ASR boundary drift maps "${chunk.text}" outside frame ${frame.frame.number} ` +
            `by ${R3(drift)}s; rerun with an accurate prompted real ASR transcript`,
        );
      }
      if (start < previousEnd) {
        fail(`source-guided ASR alignment produced overlapping measured spans in frame ${frame.frame.number}`);
      }
      previousEnd = end;
      words.push({ id: `w${words.length}`, text: chunk.text, start, end });
    }
    if (!words.length) fail(`source-guided ASR alignment returned no words for frame ${frame.frame.number}`);
    byFrame.set(frame.frame.number, words);
  }
  return byFrame;
}

function runCombinedAsr(options, frames, voicePaths, workDir, lines) {
  const combined = join(workDir, "combined.wav");
  const listPath = join(workDir, "concat.txt");
  const transcriptPath = join(workDir, "combined.transcribe.json");
  buildConcatList(voicePaths, listPath);
  run(
    "ffmpeg",
    [
      "-nostdin",
      "-y",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-ac",
      "1",
      "-ar",
      "24000",
      "-c:a",
      "pcm_s16le",
      combined,
    ],
    { label: "combining narration for one ASR pass" },
  );
  const transcriber = resolveTranscriber(options);
  if (transcriber) {
    run(
      process.execPath,
      [transcriber, "--input", combined, "--out", transcriptPath, "--engine", "whisper", "--model", "small.en", "--json"],
      { label: `combined Whisper alignment (${transcriber})` },
    );
  } else {
    // Last-resort direct CLI path for standalone skill installs. This remains
    // exactly one transcriber process for the whole combined WAV.
    run(
      "npx",
      ["--yes", "hyperframes", "transcribe", combined, "--model", "small.en", "--dir", workDir, "--engine", "whisper", "--json"],
      { label: "combined Whisper alignment (hyperframes)", cwd: options.project },
    );
    const produced = join(workDir, "transcript.json");
    if (existsSync(produced)) copyFileSync(produced, transcriptPath);
  }
  if (!existsSync(transcriptPath)) fail("combined Whisper alignment produced no transcript JSON");
  const words = normalizeWords(readJson(transcriptPath, null));
  if (!words.length) fail("combined Whisper alignment returned no word timestamps; refusing fake/evenly-spaced captions");

  const offsets = [];
  const sourceTokens = [];
  const lineByFrame = new Map(lines.map((line) => [line.frame, line]));
  let cursor = 0;
  for (const frame of frames) {
    const offset = { frame, start: cursor, end: cursor + frame.duration };
    const line = lineByFrame.get(frame.number);
    if (line) {
      offsets.push(offset);
      for (const token of tokenizeNarration(line.text)) {
        sourceTokens.push({ ...token, frame: frame.number, interval: offset });
      }
    }
    cursor += frame.duration;
  }
  if (!sourceTokens.length) fail("source-guided ASR alignment has no authored narration tokens");
  return sourceGuidedAssignments(sourceTokens, words, offsets);
}

function buildAsrSignature(options, frames, voicePaths, beatKey) {
  const fitted = voicePaths.map((path, index) => ({
    frame: frames[index].number,
    sha256: fileSha256(path),
  }));
  const scriptSha256 = fileSha256(options.script);
  const transcriber = options.transcribe || process.env.UPSTREAM_TRANSCRIBE || "upstream-default";
  const key = sha256(
    JSON.stringify({
      alignment: ASR_ALIGNMENT_SCHEMA,
      beat_key: beatKey,
      script_sha256: scriptSha256,
      fitted,
      engine: "whisper",
      model: "small.en",
      transcriber,
    }),
  );
  return { key, scriptSha256, fitted, beatKey };
}
function cachedAsrWords(cache, signature, frames) {
  if (
    cache.asr?.alignment !== ASR_ALIGNMENT_SCHEMA ||
    cache.asr.beat_key !== signature.beatKey ||
    cache.asr.key !== signature.key ||
    !cache.asr.words_by_frame
  )
    return null;
  const byFrame = new Map();
  for (const frame of frames) {
    const words = cache.asr.words_by_frame[String(frame.number)];
    if (!Array.isArray(words) || !words.length) return null;
    let previousEnd = 0;
    for (const word of words) {
      if (
        !word ||
        typeof word.text !== "string" ||
        !Number.isFinite(word.start) ||
        !Number.isFinite(word.end) ||
        word.start < previousEnd ||
        word.start < 0 ||
        word.end <= word.start ||
        word.end > frame.duration + FIT_EPSILON
      )
        return null;
      previousEnd = word.end;
    }
    byFrame.set(frame.number, words);
  }
  return byFrame;
}

function storeAsrWords(cache, signature, wordsByFrame) {
  cache.asr = {
    alignment: ASR_ALIGNMENT_SCHEMA,
    key: signature.key,
    beat_key: signature.beatKey,
    script_sha256: signature.scriptSha256,
    fitted: signature.fitted,
    words_by_frame: Object.fromEntries([...wordsByFrame].map(([frame, words]) => [String(frame), words])),
  };
}

function synthesizeMissing(options, lines, cache, workDir, cachePath) {
  const sourceByKey = new Map();
  const missing = [];
  for (const line of lines) {
    const cached = cacheSource(cache, options.project, line.sourceKey);
    if (cached) {
      sourceByKey.set(line.sourceKey, cached);
      continue;
    }
    if (!sourceByKey.has(line.sourceKey)) {
      sourceByKey.set(line.sourceKey, null);
      missing.push({
        id: line.sourceKey.slice(0, 12),
        text: line.text,
        voice: options.voice,
        speed: options.speed,
        output: line.sourcePath,
      });
    }
  }
  if (!missing.length) return { sourceByKey, synthesizedLines: 0, modelLoads: 0 };
  const manifestPath = join(workDir, "tts-manifest.json");
  const resultPath = join(workDir, "tts-result.json");
  atomicJson(manifestPath, { lines: missing });
  const python = options.batchPython || process.env.HYPERFRAMES_PYTHON || "python3";
  const args = [BATCH_SCRIPT, "--input", manifestPath, "--result", resultPath,
    "--model", options.synthesisIdentity.model.path, "--voices", options.synthesisIdentity.voices.path];
  // A failed batch may still have completed earlier items. Remove stale invalid
  // outputs first, then checkpoint every newly measured WAV even on batch failure.
  for (const record of missing) rmSync(record.output, { force: true });
  let stdout;
  let synthesisError;
  try {
    stdout = run(python, args, { label: "batched Kokoro synthesis", cwd: options.project });
  } catch (error) {
    synthesisError = error;
  }
  for (const record of missing) {
    const output = resolve(record.output);
    if (!existsSync(output)) continue;
    let duration;
    try {
      duration = ensureMeasuredWav(output, `Kokoro line ${record.id}`);
    } catch (error) {
      if (synthesisError) continue;
      throw error;
    }
    const line = lines.find((line) => line.sourcePath === output);
    if (!line) fail(`cannot associate generated Kokoro line ${record.id}`);
    cache.synthesis[line.sourceKey] = { source_path: relProject(options.project, output), sha256: fileSha256(output), duration_s: R3(duration), text: line.text, voice: options.voice, speed: options.speed };
    sourceByKey.set(line.sourceKey, { path: output, duration });
    atomicJson(cachePath, cache);
  }
  if (synthesisError) throw synthesisError;
  const result = readJson(resultPath, null) ?? JSON.parse(String(stdout).trim().split(/\r?\n/).at(-1) || "null");
  if (!result?.ok || !Array.isArray(result.lines)) fail("batched Kokoro synthesis returned no successful result");
  for (const record of missing) {
    if (!result.lines.some((entry) => entry.id === record.id && resolve(entry.output) === resolve(record.output)) ||
        !sourceByKey.get(lines.find((line) => line.sourcePath === resolve(record.output))?.sourceKey))
      fail(`batched Kokoro synthesis omitted line ${record.id}`);
  }
  const modelLoads = Number.isFinite(Number(result.model_loads)) ? Number(result.model_loads) : 1;
  return { sourceByKey, synthesizedLines: missing.length, modelLoads };
}

function generateBgm(options, cache, beatKey, totalDuration, workDir) {
  if (options.music === "none") return null;
  const destination = join(options.project, "assets", "bgm", "storybook-original.wav");
  const cached = cache.bgm;
  if (
    cached?.timing_key === beatKey &&
    cached.provenance &&
    typeof cached.provenance === "object" &&
    typeof cached.path === "string" &&
    existsSync(resolve(options.project, cached.path)) &&
    cached.sha256 === fileSha256(resolve(options.project, cached.path))
  ) {
    const measured = ensureMeasuredWav(resolve(options.project, cached.path), "cached offline music");
    if (Math.abs(measured - totalDuration) <= FIT_EPSILON)
      return { path: cached.path, duration_s: R3(measured), volume: 0.12, mode: "original-offline", provenance: cached.provenance };
  }
  const temporary = join(workDir, "storybook-original.wav");
  const fadeOut = Math.max(0, totalDuration - 1.25);
  // A deterministic four-chord cue (C → Am → F → G) with bowed-pad
  // envelopes and a short top-line phrase. It is intentionally quiet at the
  // source and mounted below narration; it is still a musical bed, not a
  // constant oscillator mislabeled as music.
  const gate = (start, end) =>
    `if(between(mod(t\\,8)\\,${start}\\,${end})\\,sin(PI*(mod(t\\,8)-${start})/${end - start})\\,0)`;
  const note = (start, end, frequency, amplitude) =>
    `${amplitude}*${gate(start, end)}*sin(2*PI*${frequency}*t)`;
  const expr = [
    note(0, 2, 130.81, 0.34), note(0, 2, 164.81, 0.22), note(0, 2, 196, 0.18),
    note(2, 4, 110, 0.34), note(2, 4, 130.81, 0.22), note(2, 4, 164.81, 0.18),
    note(4, 6, 87.31, 0.34), note(4, 6, 110, 0.22), note(4, 6, 130.81, 0.18),
    note(6, 8, 98, 0.34), note(6, 8, 123.47, 0.22), note(6, 8, 146.83, 0.18),
    note(0.45, 1.25, 523.25, 0.11), note(1.25, 1.95, 587.33, 0.09),
    note(2.45, 3.25, 659.25, 0.11), note(3.25, 3.95, 587.33, 0.09),
    note(4.45, 5.25, 523.25, 0.11), note(5.25, 5.95, 493.88, 0.09),
    note(6.45, 7.25, 587.33, 0.11), note(7.25, 7.95, 659.25, 0.09),
  ].join("+");
  run(
    "ffmpeg",
    [
      "-nostdin",
      "-y",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `aevalsrc=${expr}:s=48000:d=${totalDuration.toFixed(6)}`,
      "-af",
      `volume=0.08,lowpass=f=1800,afade=t=in:st=0:d=0.35,afade=t=out:st=${fadeOut.toFixed(6)}:d=1.25`,
      "-ar",
      "48000",
      "-ac",
      "2",
      "-c:a",
      "pcm_s16le",
      temporary,
    ],
    { label: "offline original music synthesis" },
  );
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(temporary, destination);
  const measured = ensureMeasuredWav(destination, "offline original music");
  if (Math.abs(measured - totalDuration) > FIT_EPSILON)
    fail(`offline music measures ${R3(measured)}s, expected ${R3(totalDuration)}s`);
  const provenance = {
    generator: "ffmpeg lavfi deterministic additive synthesis",
    source: "generated locally from oscillator/filter primitives",
    license: "original project-local synthesis; no third-party recording or provider",
  };
  cache.bgm = {
    timing_key: beatKey,
    path: relProject(options.project, destination),
    sha256: fileSha256(destination),
    duration_s: R3(measured),
    provenance,
  };
  return { path: relProject(options.project, destination), duration_s: R3(measured), volume: 0.12, mode: "original-offline", provenance };
}

function syncNeutralAndFrameMeta(options, frames, voices, bgm, beatKey) {
  const neutralPath = join(options.project, "audio_engine_meta.json");
  const previousNeutral = readJson(neutralPath, {});
  const previousFrame = readJson(options.out, {});
  const previousSfx = Array.isArray(previousNeutral.sfx)
    ? previousNeutral.sfx
    : Array.isArray(previousFrame.sfx)
      ? previousFrame.sfx.map((sfx) => ({ ...sfx, id: String(sfx.frame).padStart(2, "0") }))
      : [];
  const neutralVoices = voices.map((voice) => ({
    id: String(voice.frame).padStart(2, "0"),
    path: voice.path,
    duration_s: voice.duration_s,
    words: voice.words,
  }));
  const neutral = {
    ...previousNeutral,
    word_alignment: ASR_ALIGNMENT_SCHEMA,
    tts_provider: "kokoro-onnx",
    voice_id: options.voice,
    music: bgm ? "required" : "none",
    bgm,
    bgm_pending: false,
    bgm_provider: bgm ? "ffmpeg-offline" : null,
    bgm_mode: bgm ? "original-offline" : "none",
    voices: neutralVoices,
    sfx: previousSfx,
    total_duration_s: R3(frames.reduce((sum, frame) => sum + frame.duration, 0)),
    narration_mode: options.narrationMode,
    speed: options.speed,
    beat_key: beatKey,
  };
  atomicJson(neutralPath, neutral);
  const frameSfx = previousSfx.map((sfx) => ({
    ...sfx,
    frame: Number(sfx.frame ?? sfx.id),
  }));
  const meta = {
    word_alignment: ASR_ALIGNMENT_SCHEMA,
    tts_provider: "kokoro-onnx",
    voice_id: options.voice,
    speed: options.speed,
    narration_mode: options.narrationMode,
    music: bgm ? "required" : "none",
    bgm,
    bgm_pending: false,
    voices,
    sfx: frameSfx,
    total_duration_s: R3(frames.reduce((sum, frame) => sum + frame.duration, 0)),
    beat_key: beatKey,
  };
  atomicJson(options.out, meta);
  return meta;
}

function correctCaptions(options) {
  if (!existsSync(join(options.project, "SCRIPT.md"))) return;
  // Source-guided metadata is validated without rewriting measured phrase spans;
  // legacy metadata keeps the upstream LCS/punctuation correction policy.
  if (resolve(options.out) !== resolve(join(options.project, "audio_meta.json"))) return;
  run(process.execPath, [join(HERE, "fix-captions.mjs"), options.project], { label: "caption word correction" });
}

export function resolveSynthesisIdentity(options = {}) {
  const python = options.batchPython || process.env.HYPERFRAMES_PYTHON || "python3";
  const args = [BATCH_SCRIPT, "--resolve-assets"];
  if (options.model) args.push("--model", options.model);
  if (options.voices) args.push("--voices", options.voices);
  const identity = JSON.parse(run(python, args, { label: "Kokoro asset/runtime fingerprint" }));
  if (identity.schema !== "kokoro-wav-v2" || !identity.model?.sha256 || !identity.voices?.sha256)
    fail("Kokoro asset resolver returned an invalid synthesis identity");
  // Paths select the bytes passed to synthesis; bytes, not installation location,
  // define cache identity. Fingerprint once, rather than serializing it per line.
  const { model, voices, ...implementation } = identity;
  return { ...identity, fingerprint: sha256(JSON.stringify({
    ...implementation, model: model.sha256, voices: voices.sha256,
  })) };
}

export function makeSynthesisKey(text, voice, speed, identity) {
  if (identity?.schema !== "kokoro-wav-v2" || !/^[a-f0-9]{64}$/.test(identity.fingerprint ?? ""))
    fail("resolved Kokoro synthesis identity is required for cache lookup");
  return sha256(JSON.stringify(["kokoro-wav-v2", identity.fingerprint, text, voice, speed]));
}

export function makeTimingKey(sourceKey, frame, duration) {
  return sha256(`${sourceKey}\0${frame}\0${R3(duration).toFixed(3)}`);
}


function generate(options) {
  if (!existsSync(options.project)) fail(`project directory not found: ${options.project}`);
  if (!existsSync(options.storyboard)) fail(`STORYBOARD.md not found at ${options.storyboard}`);
  if (options.scriptRequired && !existsSync(options.script)) fail(`SCRIPT.md not found at ${options.script}`);
  const frames = parseStoryboard(readFileSync(options.storyboard, "utf8"));
  const scriptEntries = existsSync(options.script) ? parseScript(readFileSync(options.script, "utf8")) : [];
  const scriptByFrame = new Map();
  for (const entry of scriptEntries) {
    if (!entry.frame) fail(`SCRIPT.md heading "${entry.title}" has no (Frame N) mapping`);
    if (scriptByFrame.has(entry.frame)) fail(`SCRIPT.md contains multiple narration lines for frame ${entry.frame}`);
    if (!frames.some((frame) => frame.number === entry.frame))
      fail(`SCRIPT.md maps narration to unknown frame ${entry.frame}`);
    scriptByFrame.set(entry.frame, entry);
  }

  // Silent projects need neither synthesis assets nor a transcription runtime.
  if (scriptEntries.length) options.synthesisIdentity = resolveSynthesisIdentity(options);
  const beatDurations = frames.map((frame) => ({ frame: frame.number, duration_s: R3(frame.duration) }));
  const beatKey = sha256(JSON.stringify(beatDurations));
  const cachePath = join(options.project, "audio_cache.json");
  const cache = loadCache(cachePath);
  cache.beat_key = beatKey;
  const workDir = join(options.project, `.audio-work-${process.pid}`);
  mkdirSync(workDir, { recursive: true });
  try {
    const narratedFrames = frames.filter((frame) => scriptByFrame.has(frame.number));
    const lines = narratedFrames.map((frame) => {
      const entry = scriptByFrame.get(frame.number);
      const sourceKey = makeSynthesisKey(entry.text, options.voice, options.speed, options.synthesisIdentity);
      const sourcePath = join(options.project, ".audio-cache", `${sourceKey}.wav`);
      return {
        frame: frame.number,
        text: entry.text,
        sourceKey,
        sourcePath,
        target: frame.duration,
        finalPath: join(options.project, "assets", "voice", `${String(frame.number).padStart(2, "0")}.wav`),
      };
    });
    const synthesis = synthesizeMissing(options, lines, cache, workDir, cachePath);
    const sourceByKey = synthesis.sourceByKey;
    const voices = [];
    for (const line of lines) {
      const source = sourceByKey.get(line.sourceKey) ?? cacheSource(cache, options.project, line.sourceKey);
      if (!source) fail(`no valid cached or newly synthesized WAV for frame ${line.frame}`);
      const timingKey = makeTimingKey(line.sourceKey, line.frame, line.target);
      const fitEntry = cache.fits[timingKey];
      let measured;
      if (
        fitEntry?.path &&
        resolve(options.project, fitEntry.path) === line.finalPath &&
        existsSync(line.finalPath) &&
        fitEntry.sha256 === fileSha256(line.finalPath)
      ) {
        measured = ensureMeasuredWav(line.finalPath, `cached fitted narration frame ${line.frame}`);
        if (measured > line.target || Math.abs(measured - line.target) > FIT_EPSILON)
          measured = fitAudio(source.path, line.finalPath, line.target, source.duration);
      } else {
        measured = fitAudio(source.path, line.finalPath, line.target, source.duration);
      }
      cache.fits[timingKey] = {
        frame: line.frame,
        beat_duration_s: R3(line.target),
        path: relProject(options.project, line.finalPath),
        sha256: fileSha256(line.finalPath),
      };
      voices.push({ frame: line.frame, text: line.text, voice: options.voice, path: relProject(options.project, line.finalPath), duration_s: R3(measured), words: [] });
    }
    const totalDuration = frames.reduce((sum, frame) => sum + frame.duration, 0);
    const bgm = generateBgm(options, cache, beatKey, totalDuration, workDir);
    // The beat key binds every silent duration; only authored audio bytes need
    // hashing. Build silent WAVs only when a combined ASR pass is necessary.
    const asrSignature = lines.length
      ? buildAsrSignature(options, narratedFrames, lines.map((line) => line.finalPath), beatKey)
      : null;
    let wordsByFrame = asrSignature ? cachedAsrWords(cache, asrSignature, narratedFrames) : new Map();
    const asrCached = wordsByFrame !== null;
    if (!wordsByFrame) {
      const timelinePaths = [];
      const pathByFrame = new Map(lines.map((line) => [line.frame, line.finalPath]));
      for (const frame of frames) {
        let path = pathByFrame.get(frame.number);
        if (!path) {
          path = join(workDir, `silence-${frame.number}.wav`);
          run("ffmpeg", ["-nostdin", "-y", "-loglevel", "error", "-f", "lavfi",
            "-i", "anullsrc=r=24000:cl=mono", "-t", String(frame.duration),
            "-c:a", "pcm_s16le", path], { label: `silence for beat ${frame.number}` });
        }
        timelinePaths.push(path);
      }
      wordsByFrame = runCombinedAsr(options, frames, timelinePaths, workDir, lines);
      storeAsrWords(cache, asrSignature, wordsByFrame);
    }
    for (const voice of voices) voice.words = wordsByFrame.get(voice.frame) ?? [];
    syncNeutralAndFrameMeta(options, frames, voices, bgm, beatKey);
    if (voices.length) correctCaptions(options);
    // fix-captions can replace transcript spelling while retaining timing; fold
    // those corrected words into the neutral sidecar used by fetch-sfx.
    const corrected = readJson(options.out, null);
    if (corrected?.voices) {
      const neutralPath = join(options.project, "audio_engine_meta.json");
      const neutral = readJson(neutralPath, {});
      neutral.voices = corrected.voices.map((voice) => ({ ...voice, id: String(voice.frame).padStart(2, "0") }));
      atomicJson(neutralPath, neutral);
    }
    atomicJson(cachePath, cache);
    const ttsSummary = synthesis.modelLoads > 0
      ? `${synthesis.modelLoads} Kokoro model load(s) for ${synthesis.synthesizedLines} synthesis cache miss(es)`
      : "0 Kokoro model loads (all synthesis cached)";
    const asrSummary = !voices.length ? "no narration; ASR not required"
      : asrCached ? "cached measured ASR spans mapped to approved phrases"
      : "one combined Whisper pass with approved-phrase ASR span mapping";
    console.log(`✓ storybook audio: ${voices.length} voice(s), ${ttsSummary}, ${asrSummary}`);
    console.log(`  beats: ${R3(totalDuration)}s · voice: ${options.voice} @ ${options.speed} · music: ${bgm ? bgm.path : "none"}`);
    console.log(`  audio_meta.json: ${options.out}`);
    console.log(`  audio_engine_meta.json: ${join(options.project, "audio_engine_meta.json")}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  generate(options);
  return 0;
}

const invoked = process.argv[1] ? realPath(process.argv[1]) : "";
const own = realPath(fileURLToPath(import.meta.url));
if (invoked === own) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`✗ storybook audio: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof AudioError ? 1 : 1;
  }
}

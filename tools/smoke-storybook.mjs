#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditStorybook } from "../omp-skills/omp-storybook-pipeline/scripts/audit-storybook.mjs";
import { compileProject } from "../omp-skills/omp-storybook-pipeline/scripts/compile-scene.mjs";
import { validateAcceptance } from "../omp-skills/omp-storybook-pipeline/scripts/acceptance.mjs";
import { buildCaptions } from "../omp-skills/omp-storybook-pipeline/scripts/captions.mjs";

const project = mkdtempSync(join(tmpdir(), "omp-storybook-smoke-"));
if (process.argv.includes("--cleanup")) process.on("exit", () => rmSync(project, { recursive: true, force: true }));
mkdirSync(join(project, "assets/characters"), { recursive: true });
mkdirSync(join(project, "assets/backgrounds"), { recursive: true });
mkdirSync(join(project, "assets/bgm"), { recursive: true });
mkdirSync(join(project, "renders"), { recursive: true });

// These are finished, reusable whole-image assets. Their only transform is the
// scene-level bottom-center transform emitted by compile-scene.mjs.
const characterSvgs = {
  mara: `<svg xmlns="http://www.w3.org/2000/svg" width="260" height="500" viewBox="0 0 260 500" role="img" aria-label="Mara with auburn bob hair and a yellow sweater">
  <g stroke="#2d2a36" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
    <ellipse cx="130" cy="486" rx="92" ry="10" fill="#c7ad91" stroke="none" opacity=".45"/>
    <path d="M101 372v92M159 372v92" fill="none"/>
    <path d="M93 458q20-12 42 0v18q-28 16-50 0zM151 458q20-12 42 0v18q-28 16-50 0z" fill="#5b4960"/>
    <path d="M75 202q-18 48-13 122 7 60 25 77 42 24 86 0 18-18 25-77 5-74-13-122z" fill="#f1c05e"/>
    <path d="M90 208l-29 96M170 208l29 96" fill="none"/>
    <circle cx="61" cy="308" r="14" fill="#f4c9a7"/><circle cx="199" cy="308" r="14" fill="#f4c9a7"/>
    <path d="M98 249h64v106H98z" fill="#3f8f90"/>
    <path d="M98 274h64M98 299h64M98 324h64" fill="none" stroke="#d7e7df" stroke-width="4"/>
    <circle cx="130" cy="126" r="57" fill="#f4c9a7"/>
    <path d="M75 129q-9-65 55-76 64 11 55 76-10-29-28-33-27 22-54 0-18 4-28 33z" fill="#a95738"/>
    <path d="M84 132q-16 35 7 74M176 132q16 35-7 74" fill="none" stroke="#a95738" stroke-width="22"/>
    <circle cx="109" cy="128" r="5" fill="#2d2a36" stroke="none"/><circle cx="151" cy="128" r="5" fill="#2d2a36" stroke="none"/>
    <path d="M116 157q14 10 28 0" fill="none"/>
    <path d="M113 198q17 12 34 0" fill="none" stroke="#2d2a36" stroke-width="4"/>
  </g>
</svg>`,
  leo: `<svg xmlns="http://www.w3.org/2000/svg" width="260" height="500" viewBox="0 0 260 500" role="img" aria-label="Leo with round glasses and blue overalls">
  <g stroke="#2d2a36" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
    <ellipse cx="130" cy="486" rx="92" ry="10" fill="#c7ad91" stroke="none" opacity=".45"/>
    <path d="M100 372v94M160 372v94" fill="none"/>
    <path d="M91 458q21-12 43 0v18q-28 16-51 0zM151 458q21-12 43 0v18q-28 16-51 0z" fill="#34445d"/>
    <path d="M77 202q-17 52-12 135 8 53 26 64 39 20 78 0 18-11 26-64 5-83-12-135z" fill="#ec8c4a"/>
    <path d="M79 231h102v143H79z" fill="#4678a6"/>
    <path d="M98 231v67M162 231v67M99 298h62" fill="none"/>
    <path d="M79 231l-28 81M181 231l28 81" fill="none"/>
    <circle cx="51" cy="312" r="14" fill="#f4c9a7"/><circle cx="209" cy="312" r="14" fill="#f4c9a7"/>
    <circle cx="130" cy="126" r="57" fill="#f4c9a7"/>
    <path d="M75 124q-6-67 17-79 17-28 40 0 23-28 40 0 23 12 17 79-14-26-31-32-18 14-43 0-25 14-40 32z" fill="#3c354b"/>
    <circle cx="108" cy="127" r="18" fill="none"/><circle cx="152" cy="127" r="18" fill="none"/><path d="M126 127h8" fill="none"/>
    <circle cx="108" cy="127" r="4" fill="#2d2a36" stroke="none"/><circle cx="152" cy="127" r="4" fill="#2d2a36" stroke="none"/>
    <path d="M113 163q17 11 34 0" fill="none"/>
    <path d="M121 193h18v18h-18z" fill="#ec8c4a"/>
  </g>
</svg>`,
  jun: `<svg xmlns="http://www.w3.org/2000/svg" width="260" height="500" viewBox="0 0 260 500" role="img" aria-label="Jun with a long black ponytail and red cardigan">
  <g stroke="#2d2a36" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
    <ellipse cx="130" cy="486" rx="92" ry="10" fill="#c7ad91" stroke="none" opacity=".45"/>
    <path d="M101 376v90M159 376v90" fill="none"/>
    <path d="M91 458q21-12 43 0v18q-28 16-51 0zM151 458q21-12 43 0v18q-28 16-51 0z" fill="#e9b64b"/>
    <path d="M77 205q-15 45-10 127 8 50 25 68 38 16 76 0 17-18 25-68 5-82-10-127z" fill="#d45d55"/>
    <path d="M100 238h60v116h-60z" fill="#f1d6ad"/>
    <path d="M100 258h60M100 282h60M100 306h60M100 330h60" fill="none" stroke="#6e9b8c" stroke-width="5"/>
    <path d="M78 226l-31 92M182 226l31 92" fill="none"/>
    <circle cx="47" cy="319" r="14" fill="#f4c9a7"/><circle cx="213" cy="319" r="14" fill="#f4c9a7"/>
    <path d="M84 359h92l-11 47h-70z" fill="#8b609b"/>
    <circle cx="130" cy="126" r="57" fill="#f4c9a7"/>
    <path d="M76 126q-8-67 54-79 62 12 54 79-12-28-28-36-27 21-54 0-14 8-26 36z" fill="#202735"/>
    <path d="M181 90q56 13 43 69-11 43-47 21" fill="#202735"/>
    <circle cx="108" cy="128" r="5" fill="#2d2a36" stroke="none"/><circle cx="152" cy="128" r="5" fill="#2d2a36" stroke="none"/>
    <path d="M113 162q17 11 34 0" fill="none"/>
    <path d="M128 193h4" fill="none"/>
  </g>
</svg>`,
};

const fireplaceRoom = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080" role="img" aria-label="Warm flat outlined fireplace room">
  <rect width="1920" height="1080" fill="#f4e2c5"/>
  <g stroke="#4c3b42" stroke-width="8" stroke-linejoin="round" stroke-linecap="round">
    <path d="M0 710h1920v370H0z" fill="#bd8f74"/>
    <path d="M0 742q320-48 640 0t640 0 640 0" fill="none" stroke="#d9ad83" stroke-width="18"/>
    <path d="M0 115h1920M0 345h1920" fill="none" stroke="#eed0aa" stroke-width="4"/>
    <path d="M150 180h360v300H150z" fill="#f7eddb"/>
    <path d="M180 210h300v238H180z" fill="#a8c6c4"/>
    <path d="M180 448l100-105 77 74 49-55 74 86" fill="#7d9f9c"/>
    <path d="M1390 160h350v300h-350z" fill="#f7eddb"/>
    <path d="M1420 190h290v238h-290z" fill="#d59c88"/>
    <path d="M1460 235q80-90 160 0" fill="none" stroke="#7d5960"/>
    <path d="M1460 235v145h160V235" fill="#e7c0a0" stroke="#7d5960"/>
    <path d="M735 350h450v75H735z" fill="#8c5d55"/>
    <path d="M780 425h360v300H780z" fill="#d7b18d"/>
    <path d="M750 725h420v34H750z" fill="#8c5d55"/>
    <path d="M820 725V545q0-110 140-110t140 110v180z" fill="#5a4549"/>
    <path d="M865 680v-80q0-74 95-74t95 74v80z" fill="#2e2834"/>
    <path d="M908 660q8-90 42-100 34 10 42 100z" fill="#f2b44f"/>
    <path d="M928 660q10-53 22-66 12 13 22 66z" fill="#f7df78" stroke="none"/>
    <path d="M700 360q70-52 140 0M1080 360q70-52 140 0" fill="none" stroke="#e9bd75" stroke-width="18"/>
    <path d="M500 680h220v190H500z" fill="#6f8f89"/>
    <path d="M520 720h180v150H520z" fill="#87a9a0" stroke="none"/>
    <path d="M1200 680h220v190h-220z" fill="#6f8f89"/>
    <path d="M1220 720h180v150h-180z" fill="#87a9a0" stroke="none"/>
    <path d="M580 870h760q-25 115-380 125T580 870z" fill="#d4a66f"/>
    <path d="M640 914q320 85 640 0" fill="none" stroke="#efc892" stroke-width="7"/>
    <path d="M85 710V520M85 520q0-72 62-72t62 72v190" fill="#81a39a"/>
    <path d="M60 520h174M82 495h130" fill="#d6b075"/>
    <path d="M1740 710V510M1740 510q0-70 60-70t60 70v200" fill="#81a39a"/>
    <path d="M1715 510h174M1735 485h130" fill="#d6b075"/>
  </g>
</svg>`;

for (const [id, svg] of Object.entries(characterSvgs)) writeFileSync(join(project, `assets/characters/${id}.svg`), `${svg}\n`);
writeFileSync(join(project, "assets/backgrounds/fireplace-room.svg"), `${fireplaceRoom}\n`);
const characters = Object.keys(characterSvgs).map(id => ({ id, path: `assets/characters/${id}.svg`, width: 260, height: 500 }));
const backgrounds = [{ id: "fireplace-room", path: "assets/backgrounds/fireplace-room.svg" }];
const manifest = {
  schemaVersion: 1,
  kind: "hyperframes-storybook",
  style: "storybook-flat",
  format: "landscape",
  canvas: { width: 1920, height: 1080 },
  durationSec: 8.8,
  requirements: { narration: "required", narrationMode: "verbatim", music: "required" },
  characters,
  backgrounds,
  assets: [],
  narration: { scriptPath: "SCRIPT.md", lines: [{ shotId: "mara-arrives", text: "Mara steps into the warm room." }, { shotId: "leo-speaks", text: "Leo shares a bright idea by the fire." }] },
  shots: [
    {
      id: "mara-arrives",
      durationSec: 4.4,
      background: "fireplace-room",
      cast: [
        { id: "mara", character: "mara", x: 590, y: 900, scale: 1, motion: { keyframes: [{ timeSec: 0, x: -300, y: 0, rotation: 0 }, { timeSec: 2.2, x: 0, y: 0, rotation: 0 }, { timeSec: 4.4, x: 0, y: 0, rotation: 0 }] } },
        { id: "leo", character: "leo", x: 1040, y: 900, scale: 0.95 },
        { id: "jun", character: "jun", x: 1470, y: 900, scale: 0.95 },
      ],
    },
    {
      id: "leo-speaks",
      durationSec: 4.4,
      background: "fireplace-room",
      cast: [
        { id: "mara", character: "mara", x: 590, y: 900, scale: 1 },
        { id: "leo", character: "leo", x: 1040, y: 900, scale: 0.95, motion: { keyframes: [{ timeSec: 0, x: 0, y: 0, rotation: 0 }, { timeSec: 2.2, x: 0, y: 0, rotation: 2.5 }, { timeSec: 4.4, x: 0, y: 0, rotation: 0 }] } },
        { id: "jun", character: "jun", x: 1470, y: 900, scale: 0.95 },
      ],
    },
  ],
};
writeFileSync(join(project, "storybook.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const smokeVoice = process.env.STORYBOOK_SMOKE_VOICE ?? "am_michael";
writeFileSync(join(project, "production-contract.json"), `${JSON.stringify({ pipeline: "hyperframes-storybook", spec: { style: "storybook-flat", format: "landscape", voice: smokeVoice, narrationMode: "verbatim", music: "required", audience: "children", tone: "gentle" }, durationSec: 8.8, brief: "Three friends gather in a warm fireplace room.", permissions: { createAssets: true, generateAudio: true, renderVideo: true } }, null, 2)}\n`);
writeFileSync(join(project, "STORYBOARD.md"), `---
message: Three friends gather in a warm fireplace room.
music: required
---

## Frame 1 — Mara arrives (shot mara-arrives)
- duration: 4.4s
- visual: Mara slides into the fireplace room while Leo and Jun remain still.

## Frame 2 — Leo speaks (shot leo-speaks)
- duration: 4.4s
- visual: Leo gives a gentle speaking tilt while Mara and Jun remain still.
`);
writeFileSync(join(project, "SCRIPT.md"), `# Narration

## Frame 1 — Mara arrives (shot mara-arrives)
**Voice:** smoke fixture

    Mara steps into the warm room.

## Frame 2 — Leo speaks (shot leo-speaks)
**Voice:** smoke fixture

    Leo shares a bright idea by the fire.
`);

const audioCli = process.env.STORYBOOK_AUDIO_CLI ?? join(process.cwd(), "omp-skills/omp-video-pipeline/scripts/audio.mjs");
execFileSync(process.execPath, [audioCli, project, "--voice", smokeVoice, "--speed", "1", "--music", "required", "--narration-mode", "verbatim"], { cwd: project, stdio: "inherit", env: process.env, timeout: 1_800_000 });
const audioMeta = JSON.parse(readFileSync(join(project, "audio_meta.json"), "utf8"));
const arrivingVoice = audioMeta.voices.find(voice => Number(voice.frame) === 1);
const arrivalStart = arrivingVoice.words[0].start;
const arrivalEnd = arrivingVoice.words.at(-1).end;
manifest.shots[0].cast[0].motion.keyframes = [
  { timeSec: 0, x: 0, y: 0, rotation: 0 },
  ...(arrivalStart > 0 ? [{ timeSec: arrivalStart, x: 0, y: 0, rotation: 0 }] : []),
  { timeSec: (arrivalStart + arrivalEnd) / 2, x: -180, y: 0, rotation: 0 },
  { timeSec: arrivalEnd, x: 0, y: 0, rotation: 0 },
  ...(arrivalEnd < manifest.shots[0].durationSec ? [{ timeSec: manifest.shots[0].durationSec, x: 0, y: 0, rotation: 0 }] : []),
];
// Speaking motion ends with measured speech, not the padded shot duration.
const speakingVoice = audioMeta.voices.find(voice => Number(voice.frame) === 2);
const speechStart = speakingVoice.words[0].start;
const speechEnd = speakingVoice.words.at(-1).end;
const speakingKeys = [{ timeSec: 0, x: 0, y: 0, rotation: 0 }];
if (speechStart > 0) speakingKeys.push({ timeSec: speechStart, x: 0, y: 0, rotation: 0 });
speakingKeys.push(
  { timeSec: (speechStart + speechEnd) / 2, x: 0, y: 0, rotation: 2.5 },
  { timeSec: speechEnd, x: 0, y: 0, rotation: 0 },
);
if (speechEnd < manifest.shots[1].durationSec) speakingKeys.push({ timeSec: manifest.shots[1].durationSec, x: 0, y: 0, rotation: 0 });
manifest.shots[1].cast[1].motion.keyframes = speakingKeys;
writeFileSync(join(project, "storybook.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const compiled = compileProject(project);
let composition = readFileSync(compiled.compositionPath, "utf8");
const captions = buildCaptions(project);
const starts = [0, manifest.shots[0].durationSec];
const audioTags = [];
if (audioMeta.bgm?.path) audioTags.push(`<audio id="storybook-music" class="clip" src="${audioMeta.bgm.path}" data-start="0" data-duration="${manifest.durationSec}" data-track-index="99" data-volume="${audioMeta.bgm.volume ?? 0.12}"></audio>`);
for (const voice of audioMeta.voices ?? []) {
  const frame = Number(voice.frame ?? voice.id);
  const start = starts[frame - 1] ?? 0;
  const duration = manifest.shots[frame - 1]?.durationSec ?? voice.duration_s;
  audioTags.push(`<audio id="storybook-voice-${frame}" class="clip" src="${voice.path}" data-start="${start}" data-duration="${duration}" data-track-index="${100 + frame}" data-volume="1"></audio>`);
}
composition = composition.replace("</body>", `${audioTags.join("")}${captions.html}</body>`);
writeFileSync(join(project, "index.html"), composition);

const expectRejected = (label, fn, text) => {
  let error = null;
  try { fn(); } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
  assert(error, `${label} unexpectedly passed`);
  assert.match(error, new RegExp(text), `${label} error did not mention ${text}: ${error}`);
};

await auditStorybook(project);
const previewError = validateAcceptance(project, false);
assert(previewError, "preview acceptance unexpectedly passed without a human visual review");
assert.match(previewError, /visual-review\.json|visual review/i);
const originalMara = readFileSync(join(project, "assets/characters/mara.svg"));
writeFileSync(join(project, "assets/characters/mara.svg"), Buffer.concat([originalMara, Buffer.from("\n")]));
expectRejected("stale character asset", () => {
  const result = validateAcceptance(project, false);
  if (result) throw new Error(result);
}, "stale .*asset|asset .*hash");
writeFileSync(join(project, "assets/characters/mara.svg"), originalMara);
await auditStorybook(project);

const originalIndex = readFileSync(join(project, "index.html"), "utf8");
writeFileSync(join(project, "index.html"), originalIndex.replace("function seek(seconds){", "function seek(seconds){seconds=0;"));
let frozenError = null;
try { await auditStorybook(project); } catch (error) { frozenError = error instanceof Error ? error.message : String(error); }
assert(frozenError, "frozen root movement unexpectedly passed");
assert.match(frozenError, /stationary|motion|position|transform/i);
writeFileSync(join(project, "index.html"), originalIndex);
await auditStorybook(project);
const musicFile = audioMeta.bgm?.path ? join(project, audioMeta.bgm.path) : null;
if (musicFile) {
  const musicBytes = readFileSync(musicFile);
  rmSync(musicFile);
  expectRejected("missing required music", () => {
    const result = validateAcceptance(project, false);
    if (result) throw new Error(result);
  }, "music|audio");
  writeFileSync(musicFile, musicBytes);
}
const captionBytes = readFileSync(captions.paths.data);
writeFileSync(captions.paths.data, "[]\n");
expectRejected("broken required captions", () => {
  const result = validateAcceptance(project, false);
  if (result) throw new Error(result);
}, "caption");
writeFileSync(captions.paths.data, captionBytes);


const hfVersion = process.env.HYPERFRAMES_VERSION ?? "0.8.82";
execFileSync("npx", ["--yes", `hyperframes@${hfVersion}`, "render", "--strict", "--quality", "draft", "--output", "renders/video.mp4"], { cwd: project, stdio: "inherit", env: process.env, timeout: 180_000 });
await auditStorybook(project, { video: "renders/video.mp4" });
const finalError = validateAcceptance(project, true);
assert(finalError, "final acceptance unexpectedly passed without a human visual review");
assert.match(finalError, /visual-review\.json|visual review/i);
execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", join(project, "renders/video.mp4"), "-f", "null", "-"], { timeout: 60_000 });
const auditReport = JSON.parse(readFileSync(join(project, ".hyperframes/storybook-audit.json"), "utf8"));
console.log(`PASS storybook smoke: three whole-character SVGs + browser audit + HyperFrames MP4 (${project}/renders/video.mp4)`);
console.log(`Review required: create ${project}/.hyperframes/storybook-audit/visual-review.json with sourceDigest ${auditReport.evidence.digest}, then run node "$STORYBOOK_SCRIPTS/acceptance.mjs" "${project}" --require-video`);
if (process.argv.includes("--cleanup")) rmSync(project, { recursive: true, force: true });
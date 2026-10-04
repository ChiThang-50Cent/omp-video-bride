---
name: omp-storybook-pipeline
version: 3.0.0
description: Build generic narrated storybook films from coherent reusable character and background artwork, with real browser inspection and machine-bound acceptance under native OMP orchestration.
---

# omp-storybook-pipeline

This is the storybook route, not the technical-explainer route. It accepts a generic story brief and produces a short `storybook-flat` film with readable complete 2D character images, recurring background artwork, measured narration/captions, and source-bound acceptance. Do not infer this route from words in a brief: Hermes specifies the deliberate explicit pipeline (`hyperframes-storybook`). Do not hard-code a named tale or a cast. A fixture story belongs only in `tools/smoke-storybook.mjs`.

The visual priority is art first: choose or create a coherent set of complete character image files and recurring background image files before authoring motion. Use `skill://create-static-assets` for asset creation, reuse and visual review; this pipeline supplies its output contract, not a universal anatomy or design template. Supplied or already available artwork is preferred. New artwork MAY be created only with an authorized available tool; do not assume a paid provider, use fake placeholders, or require programmatic primitive drawing. Keep each recurring subject's defining features, body plan, palette, outline treatment and proportions consistent as applicable to the brief. Reuse the same image files in every shot that uses those characters or backgrounds.

## Runtime paths and gates

The brief or parent prompt supplies absolute paths. In the worker environment, canonical paths are:

- `$PROJECT_DIR`: the fixed project directory. Discover the project from the explicit brief or arguments; NEVER guess the project slug or search the workdir.
- `$STORYBOOK_SCRIPTS`: `/opt/omp-skills/omp-storybook-pipeline/scripts/` (this directory's `scripts/` directory).
- `$AUDIO_CLI`: `/opt/omp-skills/omp-video-pipeline/scripts/audio.mjs`.
- `$CONTRACT_HELPER`: `/opt/omp-skills/omp-video-pipeline/scripts/production-contract.mjs`.
- `$UPSTREAM_SCRIPTS`: `/opt/skills/faceless-explainer/scripts/` (upstream HyperFrames/faceless-explainer scripts).
Never discover a project by slug or by searching the workdir. Never edit upstream skill snapshots or the runtime image. Preflight required assets and dependencies before use: confirm `HYPERFRAMES_BROWSER_PATH` is set and points to an existing browser executable for browser audits; no browser or model download is performed by this skill. Check that character and background artwork exist or can be created within authorized permissions. All delegated paths MUST be absolute.

## Permissions and Contract

The production contract at `$PROJECT_DIR/production-contract.json` governs pipeline execution. It defines:
```json
{
  "permissions": {
    "createAssets": true,
    "generateAudio": true,
    "renderVideo": true
  }
}
```
Create or update the contract with:
```bash
node "$CONTRACT_HELPER" "$PROJECT_DIR" --input "$BRIEF_PATH" [--update]
```

The pipeline MUST honor permissions strictly:
- `permissions.createAssets`: If false, do not create new artwork or run `create-static-assets` generation. Reuse supplied assets only.
- `permissions.generateAudio`: If false, do not invoke the audio CLI to generate speech or audio.
- `permissions.renderVideo`: If false, do not invoke HyperFrames video render.
- If a required step lacks permission, STOP and communicate blocking questions through native UI to Hermes. Changes requiring new permission go back to Hermes/user; no implicit approval.

Do not rewrite, normalize, or regenerate that sidecar without an explicit `--update`. The acceptance validator checks the contract's pipeline (`hyperframes-storybook`), music mode, narration mode, and exact total duration.

There is no extra user approval gate for internal still-frame or visual review. When the deliberate brief specifies storyboard-only review instructions (or omits asset/audio/render permissions), stop after the storyboard and script at that gate before asset generation, audio or frame production, and return status `awaiting_approval` with real paths to Hermes. After approval notes and updated permissions are provided, inventory existing assets and complete any missing or affected artwork before motion; do not assume that a still composition already exists. Otherwise continue through internal art review and the authorized phases without asking for a new gate.
## 1. Project contract and manifest

Create `storybook.json` at the project root. The manifest is the machine contract; prose in a prompt is not a substitute. This exact shape is the supported authoring schema (`schemaVersion: 1`):

```json
{
  "schemaVersion": 1,
  "kind": "hyperframes-storybook",
  "style": "storybook-flat",
  "format": "landscape",
  "canvas": { "width": 1920, "height": 1080 },
  "durationSec": 6.0,
  "requirements": {
    "narration": "required",
    "narrationMode": "verbatim",
    "music": "required"
  },
  "characters": [
    {
      "id": "traveler",
      "path": "assets/characters/traveler.png",
      "width": 240,
      "height": 420,
      "sha256": "<sha256 of the exact local file>"
    }
  ],
  "backgrounds": [
    {
      "id": "fireplace-room",
      "path": "assets/backgrounds/fireplace-room.webp",
      "sha256": "<sha256 of the exact local file>"
    }
  ],
  "assets": [],
  "narration": {
    "scriptPath": "SCRIPT.md",
    "lines": [
      { "shotId": "opening", "text": "The exact authored line stays here." }
    ]
  },
  "shots": [
    {
      "id": "opening",
      "durationSec": 6.0,
      "background": "fireplace-room",
      "cast": [
        {
          "id": "traveler-opening",
          "character": "traveler",
          "x": 720,
          "y": 900,
          "scale": 1,
          "motion": {
            "keyframes": [
              { "timeSec": 0, "x": 0, "y": 0, "rotation": 0 },
              { "timeSec": 3, "x": 12, "y": 0, "rotation": -2 },
              { "timeSec": 6, "x": 0, "y": 0, "rotation": 0 }
            ]
          }
        }
      ]
    }
  ]
}
```

`durationSec` MUST equal the exact sum of all shot durations. `format` determines the canvas dimensions; the declared `canvas` MUST match that format. `requirements` records the actual configured modes rather than relying on defaults. `music: "none"` only removes the music bed; it does not turn off narration or captions. To make a silent film, set `requirements.narration` to `"none"` and provide no narration lines. Supported `narrationMode` values are `verbatim` and `restructured`; supplied exact copy uses `verbatim`.

For `narration: "none"`, narration metadata and subtitle artifacts are optional. If subtitle files exist, they MUST contain no cues/text (`captions.vtt` retains its `WEBVTT` header); no caption cues may be mounted. Silent films may still use authored motion without a speech-span restriction.

`characters` and `backgrounds` are root manifest arrays. Each character path and background path MUST be a local project-relative PNG, WebP, or SVG file. A character MUST have positive authored `width` and `height`; these dimensions define the whole image's authored bounds and bottom-center pivot. Optional `sha256` values bind the declared source file. Backgrounds are complete scene backdrops: the rendered shot backdrop comes entirely from its selected background asset. The `assets` array retains the project asset metadata contract.

Asset directories are mandatory, not merely examples: character source files MUST live in `$PROJECT_DIR/assets/characters/`, and background source files MUST live in `$PROJECT_DIR/assets/backgrounds/`. Create these directories before asset production. Copy suitable supplied assets into the corresponding directory without modifying the originals; create new artwork and deliver revisions there as well. Every manifest character path MUST start with `assets/characters/`, and every background path MUST start with `assets/backgrounds/`; neither may be absolute or contain `..` traversal. Use the exact delivered filenames in the manifest.

A shot selects one `background` ID and a cast of complete character images. Cast `x`/`y` are bottom-center anchor coordinates in canvas pixels. `scale` defaults to `1`. A cast entry's optional `motion.keyframes` contains finite, strictly increasing `timeSec` values within that shot; each keyframe's `x`/`y` is an offset from the cast anchor and `rotation` is degrees, defaulting to `0` when omitted. Missing `motion` means the character is completely still. Use restrained whole-image slide/tilt transforms only across the measured narration/word span for the acting beat, then return to neutral when that utterance ends; do not rock through silent padded time. Stationary characters are valid. Do not add alternate authoring fields: the supported character, background, shot, cast, and motion fields above are the contract.

Audit and acceptance enforce that every narrated-shot cast transform remains neutral outside the measured first-word-to-last-word span and is neutral at speech end. Keyframe interpolation and holds are checked, not only keyframe timestamps; shots without narration in a narrated film must remain neutral.

When supplied, exact narration MUST match both the manifest and indented `SCRIPT.md` lines, including punctuation and order. Accept one `[NARRATION]` block containing ordered `shot-id: exact text` lines, or repeated `VO: exact text` lines. For prose-only briefs, author narration within the authorized story; do not claim it was user-supplied copy. The production contract helper preserves the approved/current script baseline for verbatim continuation and revisions. Full replacement copy in approval/revision notes takes precedence; targeted changes use `voiceover <shot-id>: exact new line`. Preserve every other line.

Use either of these authored forms before converting to `SCRIPT.md` (never both for one shot):

```text
[NARRATION]
opening: The exact sentence to be spoken.
[/NARRATION]
```

or:

```text
VO: The exact sentence to be spoken.
```

Use 1-based frame headings for timing and explicit shot IDs for narration:

```markdown
## Frame 1 — Opening (shot opening)
- duration: 6s
```

In `SCRIPT.md`, the same heading is followed by an indented spoken line:

```markdown
## Frame 1 — Opening (shot opening)
**Voice:** am_michael

    The exact authored line stays here.
```

## 2. Art-first still composition and scene compile

After the storyboard/script is settled and any requested storyboard approval is granted, inventory the whole film's characters, environments and important props. Reuse suitable supplied or completed artwork.

Check `permissions.createAssets`: if false, do not create or generate new artwork; reuse existing assets only. If new artwork is needed but `permissions.createAssets` is false, STOP and communicate the blocking question to Hermes.

When authorized to create or revise artwork, read `skill://create-static-assets` before proceeding and use its design/render/review procedure. When new or changed artwork needs delegation, assign one asset worker the coherent asset set or affected subset, not independently generated per-shot characters. The worker MUST read `skill://create-static-assets`. Supply the approved storyboard/script, exact asset identities and required features, actual reference-file paths, shared art direction, absolute `$PROJECT_DIR`, absolute input paths and exact absolute output paths under the required asset directories, dimensions, alpha requirements, expected viewing size, staging/text-safe regions, available authorized tools and revision policy. Supply exact in-project output paths for required previews and still compositions too; workers must not choose their own output directories or write relative to their current directory.

The storybook output contract is `storybook-flat`, local PNG/WebP/SVG sources, separate reusable whole-image characters and full-frame backgrounds, positive authored character dimensions, bottom-center canvas anchors and a safe caption band. State these constraints in the asset task; do not turn them into universal restrictions in the generic asset skill. Preserve subject-appropriate anatomy and intentional visibility; do not require human faces, hair, clothing, every limb or full-body framing independent of the brief.

The asset handoff MUST identify the usable file paths, dimensions, previews, composition evidence and remaining limitations. The parent must inspect the actual rendered still using the exact files and expected staging before authoring motion; an asset worker's prose verdict is not a substitute. Resume/revision reuses completed suitable files and only creates or changes missing/affected artwork. Fix observed design defects before accepting the set; do not proceed with unmet requirements disguised as approved artwork.

The still review MUST verify:

- characters are bounded and readable in their intended framing, with consistent defining features, body plan, palette, outline treatment and proportions where applicable;
- each character is staged from its authored bottom-center anchor and remains inside the canvas;
- the selected background fills the entire canvas and reads as one coherent room/place;
- the composition leaves a safe caption band without covering faces or important action;
- the same source files can be reused across all planned shots.

This review is an internal visual-agent check, not a new user gate. Correct art, source paths, dimensions, and staging before motion. Do not redraw a recurring character or background for a later shot. Use only local PNG/WebP/SVG paths in the manifest and never substitute a fake placeholder.

Run the compiler after `storybook.json` and all referenced local assets exist:

```bash
node "$STORYBOOK_SCRIPTS/compile-scene.mjs" "$PROJECT_DIR"
```

The module exports `compileProject(projectDir)`. The CLI and exported function use the same project directory and write:

- `compositions/storybook-characters.html` (`COMPOSITION_FILENAME`) — the mounted scene composition;
- `.hyperframes/storybook-assets-manifest.json` (`COMPILED_FILENAME`) — source/asset/composition hashes and normalized scene records for audit.

The compiled record MAY evolve with additional audit bookkeeping, but the authored fields and values it communicates MUST remain the exact manifest fields above: character IDs/paths/positive dimensions, background IDs/paths, shot background IDs, cast character IDs/anchors/scales, and finite motion keyframes. Source files are reused, hashed, and bound; do not copy a second per-shot artwork file as a substitute.

The composition MUST mount the entire selected background asset and each character image once per cast instance. Character transforms apply to the whole image about its bottom-center pivot. A native paused registered GSAP timeline and deterministic seek function MUST drive the actual encoded character transforms; the caption wrapper MUST use the same deterministic seek path. Do not use a wall-clock animation, polling loop, or synthetic audit-only state. The generated composition and final index expose explicit markers for the mounted root, current compiled manifest hash, composition path, character/background/instance IDs, and source hashes. The final index MUST mount the generated composition root and its seek script rather than leaving the composition beside an unrelated page.

## 3. Audio and authored beats

Keep the supplied scene beats and exact narration copy. Check `permissions.generateAudio`: if false, STOP if audio generation is required and ask Hermes for audio permission. When permitted, run the shared audio CLI, not a provider-specific command:
```bash
node "$AUDIO_CLI" "$PROJECT_DIR" \
  --voice <voice-id> \
  --speed <factor> \
  --music required|none \
  --narration-mode verbatim|restructured
```

The CLI MUST support `--help` before any work, preserve exact `SCRIPT.md` text for `verbatim`, fail rather than cut overflow, and write measured `audio_meta.json` with frame/shot voice paths and durations. One combined ASR pass supplies measured spans; `word_alignment: "source-guided-v2"` maps those spans to approved source phrases, including a multiword phrase when ASR collapses words. These are ASR-guided phrase spans, not fabricated independent word timestamps. A required music bed is real offline FFmpeg output. The manifest requirements and production contract must agree with the CLI invocation; the required track must be mounted in the index and rendered MP4.

Synthesis cache keys bind the actual model and voice-pack SHA256 values, installed synthesis runtime/implementation, text, voice and speed. Changing model or voice-pack bytes invalidates reuse; legacy keys without this identity are not reused.

If storyboard sound cues are requested and `permissions.generateAudio` is true, run `node "$UPSTREAM_SCRIPTS/audio.mjs" fetch-sfx --storyboard "$PROJECT_DIR/STORYBOARD.md" --hyperframes "$PROJECT_DIR"`. Then rerun the shared audio CLI with the same flags: unchanged voice/ASR MUST use cache, and rich narration/music metadata MUST be restored while retaining the SFX. Upstream fetch-sfx down-converts the sidecar, so do not build captions from that lossy intermediate. Mount each resolved SFX at its measured shot-relative offset; unresolved required cues block delivery, not a silent success. Never regenerate audio or fetch SFX without audio permission.
## 4. Build and mount measured captions

After the audio CLI finishes (including its canonical `fix-captions` word correction), build captions from the same measured metadata:

```bash
node "$STORYBOOK_SCRIPTS/captions.mjs" "$PROJECT_DIR"
```

The builder reads exactly `$PROJECT_DIR/storybook.json` and `$PROJECT_DIR/audio_meta.json`. Each voice entry MUST contain authored `text`, `voice`, 1-based `frame`, measured relative `path` and `duration_s`, and `words[]` phrase chunks with approved `text` and measured `start`/`end`. It maps frames to shot order, offsets spans by preceding shot durations, and fails missing, non-monotonic, or out-of-shot timing. It preserves source-guided phrase spans rather than splitting a phrase into invented per-word timestamps.

The command writes these canonical project-root artifacts:

- `caption_groups.json` — `kind: "hyperframes-storybook-caption-groups"`, with exact source phrase text, absolute `start`/`end`, `shotId`, and measured spans;
- `transcript.txt` — approved source text carried by those caption phrases;
- `captions.srt` and `captions.vtt` — the same absolute timings in SRT/WebVTT form.

Every group has at most eight words and at most two readable lines. The HTML fragment returned by the exported `buildCaptions(projectDir)` function is standalone and contains the safe-margin caption layer, styles, and a deterministic seek wrapper. Its return shape is:

```js
{
  html,                         // fragment to insert before index.html's </body>
  data,                         // exact caption_groups.json object
  paths: { data, transcript, srt, vtt } // absolute artifact paths
}
```

Mount the generated composition, audio clips, and `result.html` (the returned fragment) in that order. Read the current compiled composition, append the music `<audio>` clip (track 99, below narration tracks), append each measured voice clip at its shot start/duration, then insert `result.html` immediately before the one closing `</body>` and write `$PROJECT_DIR/index.html`. Do not make a second index or leave the caption fragment beside an unmounted index. The fragment wraps the compiler's existing `window.__storybookSeek`, updates on direct audit seeks, and listens for `hf-seek`; it has no wall clock, polling, provider, or synthetic timing. Keep the caption layer above the scene; `music: "none"` removes only the bed and does not suppress narration or captions.

Every timed `<audio>` MUST have a unique stable `id` (`storybook-music`, `storybook-voice-1`, etc.); HyperFrames otherwise leaves it silent. Central audit runs native lint and rejects any error before rendering. Use a caption keep-out region so faces and important staging remain readable.

Browser audit binds each audio clip's resolved local source, measured duration, timeline start/duration, gain and ready state to the metadata plan, including resolved sound effects. Unsupported clip modifiers or substituted/muted sources fail. Final audit reconstructs the native AAC mix and compares decoded MP4 samples to the full mix and each clip-omitted mix; an audio stream alone does not prove required narration/music.

The reference uses native PCM16/48kHz stereo preparation (mono is duplicated at unity) before AAC mixing. The full mix must meet a 20 dB reconstruction SNR; each clip's full-versus-omitted projection must establish more than 75% of its expected amplitude. Unrelated codec error in loud narration does not by itself disprove quiet music.

Re-run `captions.mjs` and remount the fresh fragment after any `fix-captions`, narration, shot-order, or duration change. The final index MUST retain the compiler's root marker, current compiled manifest hash, composition path, source markers, and every audio/caption artifact.

## 5. Real browser inspection and visual review

Before rendering, run the real browser audit:

```bash
HYPERFRAMES_BROWSER_PATH="$HYPERFRAMES_BROWSER_PATH" \
node "$STORYBOOK_SCRIPTS/audit-storybook.mjs" "$PROJECT_DIR"
```

The audit resolves `puppeteer-core` from the HyperFrames package, opens the actual `index.html`, seeks every shot at start/midpoint/end, and checks actual DOM geometry for visible bounded full-character images, authored root positions and rotations, deterministic seek behavior, complete background coverage, same-asset reuse, caption timing/safety, source/hash integrity, and real lint/media behavior. Stationary characters are valid; there is no mandatory movement, blink, or extra visual effect gate. It writes screenshot evidence under `.hyperframes/storybook-audit/`, `contact.json`, and `.hyperframes/storybook-audit.json`; the report's `evidence.digest` binds those screenshots to the current source/manifest/composition/index hashes. `--video <path>` additionally probes the actual MP4 dimensions, duration, streams, and hash.

Automated checks do **not** certify aesthetic quality. Review every screenshot in the contact artifact, then write exactly `.hyperframes/storybook-audit/visual-review.json`:

```json
{
  "schemaVersion": 1,
  "kind": "hyperframes-storybook-visual-review",
  "verdict": "approved",
  "sourceDigest": "<exact evidence.digest from .hyperframes/storybook-audit.json>",
  "evidence": [".hyperframes/storybook-audit/opening-0.png"],
  "shots": [
    {
      "shotId": "opening",
      "style": "Observed coherent flat outlined art, readable full characters, and a complete background.",
      "continuity": "Observed the same character and background files, identity, palette, and proportions across the reviewed transition.",
      "acting": "Observed readable staging and the intended still or whole-image slide/tilt acting.",
      "captions": "Observed the active exact-word caption placement and readability in the reviewed screenshot, or explicitly observed that this shot is music-only."
    }
  ]
}
```

List every audit screenshot (or a deliberate inspected subset) in `evidence`, include one substantive observation for every manifest shot, and use the exact current digest. The reviewed evidence MUST include a screenshot while each narrated shot's caption is active; if a shot has no narration, explicitly review its music-only frame. If the standard start/midpoint/end samples miss a caption cue, capture an active-cue screenshot through the same real browser surface and include that emitted file in the review evidence. The validator rejects missing/stale evidence, mismatched digests, and incomplete shot observations. The report keeps visual review distinct from machine geometry acceptance; `verdict` is a human/agent aesthetic decision, never an automatically generated pass.

Then run preview acceptance:

```bash
node "$STORYBOOK_SCRIPTS/acceptance.mjs" "$PROJECT_DIR"
```

It writes `acceptance.json` at the project root. Do not proceed to final render unless this command succeeds.

## 6. Render once and final acceptance

Check `permissions.renderVideo`. If false, skip render. When permitted, render the accepted project once through the pinned HyperFrames runtime:

```bash
npx hyperframes@0.8.82 render --strict --quality high --output renders/video.mp4
```

After rendering, audit the actual output and validate the final metadata:

```bash
node "$STORYBOOK_SCRIPTS/audit-storybook.mjs" "$PROJECT_DIR" --video renders/video.mp4
node "$STORYBOOK_SCRIPTS/acceptance.mjs" "$PROJECT_DIR" --require-video
```

The acceptance module exports `parseScript(scriptPath)` and `validateAcceptance(projectDir, requireVideo)` APIs. `parseScript` binds the approved narration source when a production contract is prepared; `validateAcceptance` validates preview and final audit against the production contract. Do not bypass those APIs or replace the documented CLI paths.
The final `acceptance.json` binds the actual source, character/background assets, manifest, composition, index, audio files/metadata, browser evidence, visual-review notes, and MP4 hashes. It fails if any bound file is stale, if required narration/music is absent, if phrase timing is missing/non-monotonic, if the MP4 has the wrong dimensions or duration, or if the copied production contract does not match the authored project. A report claiming success in prose or a boolean field is never sufficient.

## CLI quick reference

```bash
node "$STORYBOOK_SCRIPTS/compile-scene.mjs" "$PROJECT_DIR" [--manifest storybook.json] [--output compositions/storybook-characters.html]
node "$STORYBOOK_SCRIPTS/captions.mjs" "$PROJECT_DIR"
node "$STORYBOOK_SCRIPTS/audit-storybook.mjs" "$PROJECT_DIR" [--video renders/video.mp4]
node "$STORYBOOK_SCRIPTS/acceptance.mjs" "$PROJECT_DIR" [--require-video]
node tools/smoke-storybook.mjs [--cleanup]
```

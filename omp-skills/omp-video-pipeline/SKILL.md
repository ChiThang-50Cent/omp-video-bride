---
name: omp-video-pipeline
version: 3.0.0
description: Direct HyperFrames faceless-explainer production pipeline under native OMP orchestration. Fast phase procedure, exact script paths, frame-worker authoring rules and lint gates.
---

# omp-video-pipeline

This skill defines HOW to run `faceless-explainer` under direct OMP RPC orchestration. The upstream skill defines WHAT each step produces. Where they conflict, this skill wins. You are the orchestrator. Frame workers write the scene HTML. You write scene HTML only for one-line non-visual fixes.

## Paths (use them directly; never glob or search for scripts)
The brief or prompt supplies `$PROJECT_DIR`, `$UPSTREAM_SCRIPTS`, `$OUR_SCRIPTS` and `$PRESETS_DIR`. In the container worker environment, canonical paths are:
- Upstream canonical scripts: `/opt/skills/faceless-explainer/scripts/<name>.mjs` (or `$UPSTREAM_SCRIPTS/<name>.mjs`: assemble-index, captions, transitions, frame-packets, sync-durations, fetch-sfx, …).
- Our scripts: `/opt/omp-skills/omp-video-pipeline/scripts/` (or `$OUR_SCRIPTS/`):
  - `production-contract.mjs <absolute PROJECT_DIR> --input <absolute brief.json> [--update]`: creates or updates the normalized production contract sidecar.
  - `audio.mjs <PROJECT_DIR> --voice <voice> --music <required|none> --narration-mode <verbatim|restructured>`: one local Kokoro model load, measured scene fitting, one combined alignment pass, and original offline music when required. `--help` is safe and never generates.
  - `stage-fonts.mjs <PROJECT_DIR> <preset>`: stages every family/weight that `frame.md` uses (the preset's shipped files, or Google Fonts fetched once into a shared cache) and prints the `@font-face` lines. Works for every preset.
  - `lint-frame.mjs <PROJECT_DIR> compositions/frames/<file>.html`: the centrally run frame gate.
  - `verify.mjs <PROJECT_DIR> [--focus 5,6]`: fixes caption typos against SCRIPT.md, then runs captions build, assemble, transitions, check, and midpoint snapshots.
  - `fix-captions.mjs <PROJECT_DIR>`: already called by verify.mjs.
- Presets: `/opt/skills/hyperframes-creative/frame-presets/<preset>/` (or `$PRESETS_DIR/<preset>/`).

Discover the project from the explicit brief or invocation arguments; NEVER guess the project slug or search the workdir. All delegated paths MUST be absolute.

## Permissions and Contract
The production contract at `<PROJECT_DIR>/production-contract.json` governs pipeline execution. It defines:
```json
{
  "permissions": {
    "createAssets": true,
    "generateAudio": true,
    "renderVideo": true
  }
}
```
The pipeline MUST honor permissions strictly:
- `permissions.createAssets`: If false, do not source, fetch or create external assets.
- `permissions.generateAudio`: If false, do not invoke the audio CLI or perform speech synthesis.
- `permissions.renderVideo`: If false, do not execute Phase E video render.
- If a requested or required phase lacks permission, STOP and communicate blocking questions through native UI to Hermes. Changes requiring new permission go back to Hermes/user; no implicit approval.

## Review gates and storyboard-only instructions
When the deliberate brief specifies storyboard-only review (or omits audio/render permissions), finish the enriched STORYBOARD.md and SCRIPT.md first, and STOP before any audio generation, asset creation, font staging, or worker dispatches. Report status `awaiting_approval` with the real absolute paths of STORYBOARD.md, SCRIPT.md, and PROJECT_DIR in the native response to Hermes. When Hermes resumes with approved notes and updated permissions, apply the notes to the storyboard/script and proceed to audio generation at Step 5.

If `permissions.renderVideo` is false, complete all verification steps through `verify.mjs`, but skip Phase E render.

## Direct inputs
The contract specifies pipeline (`hyperframes-explainer`), style, format, voice, length, audience, tone and permissions. The rest is fixed:
- Hermes orchestrates the session over direct RPC. Execute direct phases without interactive chat; when blocking questions or missing permissions arise, communicate them through native UI to Hermes. Frame count: about one frame per 7s of target length (min 4, max 10).
- English narration. Use the prompt's narration mode: `verbatim` preserves supplied narration exactly; `restructured` permits authoring. Offline Kokoro with the spec's voice. Captions on. Use the prompt's music setting; `required` produces an original quiet offline music bed. No HeyGen sign-in.
- Canvas W×H comes from the spec's format (landscape 1920x1080, portrait 1080x1920, square 1080x1080). Every size rule below is relative to that canvas.
- Preflight required assets and dependencies before use: confirm `HYPERFRAMES_BROWSER_PATH` and `HYPERFRAMES_PYTHON` are set and point to valid executables. Check that required font or synthesis assets exist before dispatching workers; if missing, report the missing capability rather than pretending or installing packages mid-flight. Fonts come only from `stage-fonts.mjs`. Never run `skills update`.
- Use the exact absolute PROJECT_DIR supplied in the brief and production contract. Never forcibly resolve into `videos/` or guess directory names. Create `compositions/frames/` before starting workers. Every worker read/write path must be absolute.
## Assets (the prompt's "Assets" block)
- Project assets are files the requester supplied (logos, screenshots, photos, audio, fonts). Copy the ones you use into `<PROJECT_DIR>/assets/media/` during Phase A. Mention each by its relative path (`assets/media/<file>`) in the frame's storyboard section, so the worker gets it through the packet. Never modify the originals.
  - Images/video: `<img>`/`<video>` inside the frame, framed by the preset's components. Never stretch them: use `object-fit: contain` or `cover`, and respect the keep-out band.
  - Fonts: copy them into `assets/fonts/` and add `@font-face` lines alongside the stage-fonts output.
- Check `permissions.createAssets`:
  - If `permissions.createAssets` is false: never download, fetch or generate new media assets. Use only supplied assets or draw visuals in code (SVG/CSS).
  - If `permissions.createAssets` is true and the brief allows sourcing images: search the web only for concrete things code cannot draw well (product screenshot, real logo, photo of place/person).
  - Prefer official press kits, Wikimedia Commons, Unsplash or Pexels. Download with `curl -L`, check file is an image (`file`), short edge ≥ 800px, no watermarks.
  - Save to `<PROJECT_DIR>/assets/media/`. Append `- <file> — <source URL> — <license/credit>` to `<PROJECT_DIR>/SOURCES.md`.
  - At most 5 downloads per scene. If nothing suitable turns up in 2 searches, draw it in code instead.

## Phase A — Plan (≤ 4 min)
1. Read skill://hyperframes and skill://faceless-explainer. Then read the references they require for Steps 0–4 in ONE parallel batch. Never re-read them.
2. Step 0: init, then write BRIEF.md from the deliberate brief. Skip the interactive interview and recipe steps (Hermes provides the deliberate brief and permissions).
3. Steps 1–2: capture files, then build-frame. **Preset:** if the spec names one, use exactly that preset. If it says `auto`, pick from `$PRESETS_DIR/` to match topic, audience and tone:
   - code/systems → `code-editorial`, `editorial-forest`, `cartesian`
   - business/data → `blue-professional`, `cobalt-grid`
   - bold/punchy → `bold-poster`, `broadside`, `coral`, `creative-mode`, `blockframe`
   - friendly/beginner → `capsule`, `daisy-days`
   - arts/culture → `biennale-yellow`

   Record the chosen preset in BRIEF.md.
4. Step 3: write STORYBOARD.md and SCRIPT.md. Narration spells out symbols the way they are spoken ("hash of key modulo N"), and the on-screen form stays symbolic.
5. Step 4: write the whole enriched STORYBOARD.md in ONE `write`. Skip sketches. **Packet budget:** a frame packet is capped at 48000 bytes, so keep each frame's storyboard section under ~2500 characters. Describe the visual; don't paste code or long copy into it.

   *Storyboard gate:* If the brief specifies storyboard-only review (or `permissions.generateAudio` is false), STOP here before audio, assets, fonts, or worker dispatches. Report status `awaiting_approval` with real paths to Hermes. When Hermes resumes with approved notes and audio permission, apply any notes and continue to Phase B.

## Phase B — Audio ∥ visual design (≤ 3 min)
6. Check `permissions.generateAudio`. If false, STOP if audio is required and ask Hermes for audio generation permission. When permitted, start `node $OUR_SCRIPTS/audio.mjs <PROJECT_DIR> --voice <voice> --music <music> --narration-mode <mode>` as one finite asynchronous tool job. While it runs, continue visual design. Do not invoke upstream audio generation or probe it with `--help`, regenerate completed narration, use PID/file-existence sleep loops, or cut speech with FFmpeg `-t`. If speech exceeds a beat, adjust the approved beat allocation within total duration or use an explicitly chosen slower/faster pace; never discard words.
7. Stage fonts: `stage-fonts.mjs <PROJECT_DIR> <preset>`. The printed lines are the only fonts workers may use.
8. Await the audio job's completion result, not mere metadata existence. The audio CLI has already fitted/measured WAVs to the storyboard beats; do not run sync-durations. If sound cues are specified and `permissions.generateAudio` is true, run `node $UPSTREAM_SCRIPTS/audio.mjs fetch-sfx --storyboard <PROJECT_DIR>/STORYBOARD.md --hyperframes <PROJECT_DIR>`, then run the shared audio CLI again with the same flags to restore rich metadata while preserving SFX; unchanged synthesis and alignment must be cache hits, not regenerated. Build packets using the canonical upstream path from the prompt. If a packet is oversized, shorten only that frame's design section and rebuild once.
## Phase C — Build (≤ 4 min)
9. Dispatch ALL frame workers in ONE `task` batch. Each assignment contains:
   - absolute role/packet paths, absolute PROJECT_DIR and absolute output file path, frame_id, canvas W×H, and caption keep-out band (bottom 17% of height);
   - the `@font-face` lines, verbatim;
   - the full **Worker rules** section below, copied verbatim.
10. While workers run, do not edit their files. After completion, confirm each exact output path exists before assembly. If a worker wrote to the job cwd instead, recover that actual artifact into the expected path and gate it; do not regenerate all frames. Retry only a genuinely missing or defective frame.

## Worker rules (copy verbatim into every worker assignment)
- Write only the exact absolute output path in your assignment. Do not prepend or drop `videos/<project>`. Do not glob, list, or read sibling frames.
- ids and classes start with a letter and contain only letters, digits, `-` and `_`. Prefix them with your frame, e.g. `f03-bucket`. Never start an id with a digit.
- Every element with `data-start`/`data-duration`/`data-track-index` has `class="clip"`. **Clips that are visible at the same time must have different `data-track-index` values.** Reuse a track index only after the previous clip on it has ended. Prefer one clip per track.
- Fonts: use only the `@font-face` lines you were given, with `url("assets/fonts/…")`. No other families, weights or absolute `/assets` paths.
- Layout: every element stays inside the W×H canvas at every moment in which it is visible, with a margin of ≥ 3% of the shorter edge. Nothing goes into the bottom 17% of the height (captions). Panels and code blocks are at most 90% of W. Size them to the longest line, or shrink the font. In portrait, stack vertically instead of side by side. Off-canvas motion is allowed only on entry/exit and must be marked `data-layout-allow-overflow`.
- Camera moves (translate/scale on a world container) must keep every visible element on screen at the camera's final position. Compute the extents at the final zoom; don't pan text off the edge. Position children relative to their own container, not in canvas pixels.
- The midpoint of the frame must be well filled: the main visual covers ≥ 40% of the canvas, and nothing important stays at opacity < 0.8 at the midpoint.
- Do not run build/lint/tests/formatters in a worker. The orchestrator runs the gates once after every assigned artifact exists. Before returning, read the exact absolute output path to confirm your artifact exists; report that path, not an assumed relative path.

## Phase D — Verify with parallel fixes (≤ 4 min, max 2 rounds)
11. Run `verify.mjs <PROJECT_DIR>`. It centrally gates every exact storyboard source, then builds captions/assembly/transitions, checks runtime/layout and captures snapshots. Its nonzero exit is a failure; fix the reported frames before rendering. Do not run its steps individually. Open snapshots-check.json only when a finding needs detail.
    - verify.mjs rewrites misheard caption words from SCRIPT.md (e.g. "medjulo" → "modulo"). Never hand-edit captions.
    - It lists content more than 24px off-canvas as a defect.
12. Look at `snapshots/contact-sheet.jpg`. Write ONE defect list per frame, combining the verify findings with what the sheet shows: clipped content, overlapping text, near-empty or faded frames, broken formulas, typos.
13. If any frame has a defect, dispatch ONE parallel `task` batch with one fix worker per defective frame. Give each worker the absolute paths of its frame file and of `<PROJECT_DIR>/.hyperframes/frame-packets/_role.md`, its exact defects, the font lines and the Worker rules. Then re-run verify.mjs and look at the sheet again.
    - `layout/info` lines are advisory. Fix them only when the contact sheet shows the problem. Decorative elements (confetti, floating tags, background shapes) overlapping each other are fine.
    - Round 2 happens only if `error` findings or visible clipping, overlap or empty frames remain. Taste-level polish is not a reason for another round. Never run more than 2 rounds. Record what is left in `notes`.

## Revise mode (the prompt says "Revise an existing … video")
Resume the exact project in place at PROJECT_DIR. Change only what the request needs. Never re-plan, re-storyboard or rebuild untouched frames. Read BRIEF.md, STORYBOARD.md, SCRIPT.md and `frame.md`. Rerun `stage-fonts.mjs <PROJECT_DIR> <preset from BRIEF.md>` to get the font lines. Then run `verify.mjs <PROJECT_DIR> --focus <frames>` once. This samples the target frames at 20/40/60/80/95%, so problems late in a frame are visible. Look at every sheet it prints. Frame N = `## Frame N`. Never open a browser, start an http server or render just to inspect: the focus sheets are the inspection tool.

R1. Classify the request. Pick the cheapest class that fully satisfies it:
   - **captions**: wrong caption words only. Edit the word `text` in `audio_meta.json` (keep the timings), then continue at R3.
   - **visual**: layout, color, text on screen, animation, overlap in specific frames. Go to R2 with those frames.
   - **narration**: spoken words change. Check `permissions.generateAudio`: if false, STOP and ask Hermes. Edit those lines in SCRIPT.md, rerun the shared audio CLI (foreground) with the prompt's voice/music/mode, then rebuild packets. Its cache reuses unchanged synthesis. Changed frames go to R2, along with any frame whose approved beat duration shifted by > 0.3s.
   - **duration**: the prompt's "Video length" says to change it. Let current = the sum of the frame durations and r = target / current.
     - Adjust storyboard beat durations to the requested total first. Preserve supplied speech in verbatim mode. Check `permissions.generateAudio`: if false, STOP and ask Hermes. Run the shared audio CLI with the prompt's voice/music/mode and an explicitly chosen `--speed` only if needed; measured overflow fails rather than truncating words. Rebuild packets. Every retimed frame goes to R2 with its new duration; do not regenerate valid unchanged visuals.
     - If the total cannot fit the supplied narration at a reasonable pace, report the actual overflow instead of silently shortening the speech. In restructured mode only, rewrite the narration to fit and regenerate the changed lines.
     - A length change combined with other edits is still class `duration`. Apply the other edits in the same pass.
   - **restructure**: a new style or format, or a different angle (frames added or removed only for a length change are class `duration`). Do not attempt it in place. Stop and tell Hermes to create a deliberate fresh project instead.
R2. Dispatch ONE parallel `task` batch with one fix worker per affected frame. Give each worker the absolute paths of its frame file, its packet and `.hyperframes/frame-packets/_role.md`, the exact change for that frame, the font lines and the Worker rules. Tell it to keep everything else about the frame as is.
R3. Run `verify.mjs <PROJECT_DIR> --focus <changed frames>`, check the sheets, and do at most 1 more fix round, following the Phase D rules. Before Phase E, run a plain `verify.mjs <PROJECT_DIR>` (no `--focus`), so the delivered `snapshots/contact-sheet.jpg` has one tile per frame and its numbering matches the frames. Then run Phase E **once** if `permissions.renderVideo` is true. `frames_changed` lists the frame numbers you touched.
## Phase E — Render once
14. Check `permissions.renderVideo`. If false, skip render and report `"video": ""`. If true, run `npx hyperframes render --skill=faceless-explainer --quality high --output renders/video.mp4`. Never re-render.
15. ffprobe the output: duration, 1920x1080, audio stream present.

## Reporting
Return real delivered paths, status, duration, and notes in the native response to Hermes; do not demand a legacy job result JSON block. Keep tool calls lean. Batch independent reads and checks in one turn. No todo bookkeeping.

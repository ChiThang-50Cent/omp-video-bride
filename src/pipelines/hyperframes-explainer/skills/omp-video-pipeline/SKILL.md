---
name: omp-video-pipeline
version: 2.0.0
description: Use when running the HyperFrames faceless-explainer skill unattended (bridge jobs). Fast phase procedure, exact script paths, frame-worker authoring rules and lint gates.
---

# omp-video-pipeline

This skill defines HOW to run `faceless-explainer` quickly and without a user. The upstream skill defines WHAT each step produces. Where they conflict, this skill wins. You are the orchestrator. Frame workers write the scene HTML. You write scene HTML only for one-line non-visual fixes.

## Paths (use them directly; never glob or search for scripts)
The prompt's **Paths** block gives the real values of `$UPSTREAM_SCRIPTS`, `$OUR_SCRIPTS` and `$PRESETS_DIR`. Substitute them whenever you run a command or copy text into a worker assignment; workers do not see the prompt.
- Upstream scripts: `$UPSTREAM_SCRIPTS/<name>.mjs` (assemble-index, captions, transitions, frame-packets, sync-durations, fetch-sfx, …).
- Our scripts: `$OUR_SCRIPTS/`
  - `stage-fonts.mjs <PROJECT_DIR> <preset>`: stages every family/weight that `frame.md` uses (the preset's shipped files, or Google Fonts fetched once into a shared cache) and prints the `@font-face` lines. Works for every preset.
  - `lint-frame.mjs <PROJECT_DIR> compositions/frames/<file>.html`: the frame-worker gate.
  - `verify.mjs <PROJECT_DIR> [--focus 5,6]`: fixes caption typos against SCRIPT.md, then runs captions build, assemble, transitions, check, and midpoint snapshots.
  - `fix-captions.mjs <PROJECT_DIR>`: already called by verify.mjs.
- Presets: `$PRESETS_DIR/<preset>/`.

## Job flags (the prompt's "Flags" block)
- `approve: storyboard`: after Phase B step 6 (STORYBOARD.md, SCRIPT.md and the preset are final) STOP. Do not run audio-dependent steps, workers or render. Reply with only the final JSON `{"status":"awaiting_approval","storyboard":"<abs path of STORYBOARD.md>","script":"<abs path of SCRIPT.md>","project_dir":"<abs>","style":"<preset>"}`. The bridge resumes this same session with reviewer notes; then apply the notes to the storyboard/script and continue at Phase B step 7.
- `render: false`: do everything up to and including the last plain `verify.mjs` run, but skip Phase E. Report `"video": ""`.

## Fixed inputs (never ask; there is no user)
The prompt's **Job spec** sets style, format, voice, length, audience and tone. The rest is fixed:
- Autonomous mode. Frame count: about one frame per 7s of target length (min 4, max 10).
- English narration, VO_MODE restructured. Offline Kokoro with the spec's voice. Captions on. No BGM. No HeyGen sign-in.
- Canvas W×H comes from the spec's format (landscape 1920x1080, portrait 1080x1920, square 1080x1080). Every size rule below is relative to that canvas.
- The environment is ready: `HYPERFRAMES_BROWSER_PATH` and `HYPERFRAMES_PYTHON` are set. Never install Chrome, Python packages or Kokoro. Fonts come only from `stage-fonts.mjs`. Never run `skills update`.
- The project lives in `./videos/<kebab-case-topic>` (PROJECT_DIR). Write nothing outside the cwd.

## Assets (the prompt's "Assets" block)
- Project assets are files the requester supplied (logos, screenshots, photos, audio, fonts). Copy the ones you use into `<PROJECT_DIR>/assets/media/` during Phase A. Mention each by its relative path (`assets/media/<file>`) in the frame's storyboard section, so the worker gets it through the packet. Never modify the originals.
  - Images/video: `<img>`/`<video>` inside the frame, framed by the preset's components. Never stretch them: use `object-fit: contain` or `cover`, and respect the keep-out band.
  - Fonts: copy them into `assets/fonts/` and add `@font-face` lines alongside the stage-fonts output.
- When the block says you MAY source images: search the web only for concrete things code cannot draw well (a product screenshot, a real logo, a photo of a place or person). Diagrams, icons, charts and code stay in SVG/CSS.
  - Prefer official press kits, Wikimedia Commons, Unsplash or Pexels. Download with `curl -L`, and check that the file really is an image (`file`), is ≥ 800px on its short edge, and is not watermarked.
  - Save it to the project `found/` dir named in the block and also to `<PROJECT_DIR>/assets/media/`. Append `- <file> — <source URL> — <license/credit>` to `found/SOURCES.md`.
  - At most 5 downloads per scene. If nothing suitable turns up in 2 searches, draw it in code instead.
- When the block says not to download: never fetch images. Draw missing visuals in code.

## Phase A — Plan (≤ 4 min)
1. Read skill://hyperframes and skill://faceless-explainer. Then read the references they require for Steps 0–4 in ONE parallel batch. Never re-read them.
2. Step 0: init, then write BRIEF.md from the fixed inputs. Skip the intent interview, `prefs.mjs record` and the recipe steps (there is no returning user).
3. Steps 1–2: capture files, then build-frame. **Preset:** if the spec names one, use exactly that preset. If it says `auto`, pick from `$PRESETS_DIR/` to match topic, audience and tone:
   - code/systems → `code-editorial`, `editorial-forest`, `cartesian`
   - business/data → `blue-professional`, `cobalt-grid`
   - bold/punchy → `bold-poster`, `broadside`, `coral`, `creative-mode`, `blockframe`
   - friendly/beginner → `capsule`, `daisy-days`
   - arts/culture → `biennale-yellow`

   Record the chosen preset in BRIEF.md.
4. Step 3: write STORYBOARD.md and SCRIPT.md. Narration spells out symbols the way they are spoken ("hash of key modulo N"), and the on-screen form stays symbolic.

## Phase B — Audio ∥ visual design (≤ 3 min)
5. Start Step 3.1 audio as a detached background process that logs to a file. Do not wait for it yet.
6. Meanwhile do Step 4: write the whole enriched STORYBOARD.md in ONE `write`. Skip sketches. **Packet budget:** a frame packet is capped at 48000 bytes, so keep each frame's storyboard section under ~2500 characters. Describe the visual; don't paste code or long copy into it.
7. Stage fonts: `stage-fonts.mjs <PROJECT_DIR> <preset>`. The printed lines are the only fonts workers may use.
8. Now wait for audio. Then run sync-durations and fetch-sfx, and build the packets. If frame-packets reports an oversized packet, shorten only that frame's section (drop examples and repeated rules) and rebuild once.

## Phase C — Build (≤ 4 min)
9. Dispatch ALL frame workers in ONE `task` batch. Each assignment contains:
   - its `_role.md` and packet paths, PROJECT_DIR, frame_id, the canvas W×H, and the caption keep-out band (bottom 17% of the height);
   - the `@font-face` lines, verbatim;
   - the full **Worker rules** section below, copied verbatim.
10. While workers run, do not edit their files.

## Worker rules (copy verbatim into every worker assignment)
- Write only your own frame file, `compositions/frames/<NN-name>.html`. The directory exists after dispatch. Do not glob, list or read other frames.
- ids and classes start with a letter and contain only letters, digits, `-` and `_`. Prefix them with your frame, e.g. `f03-bucket`. Never start an id with a digit.
- Every element with `data-start`/`data-duration`/`data-track-index` has `class="clip"`. **Clips that are visible at the same time must have different `data-track-index` values.** Reuse a track index only after the previous clip on it has ended. Prefer one clip per track.
- Fonts: use only the `@font-face` lines you were given, with `url("assets/fonts/…")`. No other families, weights or absolute `/assets` paths.
- Layout: every element stays inside the W×H canvas at every moment in which it is visible, with a margin of ≥ 3% of the shorter edge. Nothing goes into the bottom 17% of the height (captions). Panels and code blocks are at most 90% of W. Size them to the longest line, or shrink the font. In portrait, stack vertically instead of side by side. Off-canvas motion is allowed only on entry/exit and must be marked `data-layout-allow-overflow`.
- Camera moves (translate/scale on a world container) must keep every visible element on screen at the camera's final position. Compute the extents at the final zoom; don't pan text off the edge. Position children relative to their own container, not in canvas pixels.
- The midpoint of the frame must be well filled: the main visual covers ≥ 40% of the canvas, and nothing important stays at opacity < 0.8 at the midpoint.
- Gate before returning: run `node $OUR_SCRIPTS/lint-frame.mjs <PROJECT_DIR> compositions/frames/<file>.html` and fix until it prints PASS. Return one line: frame_id, the main visual, and `lint-frame PASS`.

## Phase D — Verify with parallel fixes (≤ 4 min, max 2 rounds)
11. Run `verify.mjs <PROJECT_DIR>`. Do not run its steps individually. Open snapshots-check.json only when a finding needs detail.
    - verify.mjs rewrites misheard caption words from SCRIPT.md (e.g. "medjulo" → "modulo"). Never hand-edit captions.
    - It lists content more than 24px off-canvas as a defect.
12. Look at `snapshots/contact-sheet.jpg`. Write ONE defect list per frame, combining the verify findings with what the sheet shows: clipped content, overlapping text, near-empty or faded frames, broken formulas, typos.
13. If any frame has a defect, dispatch ONE parallel `task` batch with one fix worker per defective frame. Give each worker the absolute paths of its frame file and of `<PROJECT_DIR>/.hyperframes/frame-packets/_role.md`, its exact defects, the font lines and the Worker rules. Then re-run verify.mjs and look at the sheet again.
    - `layout/info` lines are advisory. Fix them only when the contact sheet shows the problem. Decorative elements (confetti, floating tags, background shapes) overlapping each other are fine.
    - Round 2 happens only if `error` findings or visible clipping, overlap or empty frames remain. Taste-level polish is not a reason for another round. Never run more than 2 rounds. Record what is left in `notes`.

## Revise mode (the prompt says "Revise an existing … video")
The project is finished and copied. Change only what the request needs. Never re-plan, re-storyboard or rebuild untouched frames. Read BRIEF.md, STORYBOARD.md, SCRIPT.md and `frame.md`. Rerun `stage-fonts.mjs <PROJECT_DIR> <preset from BRIEF.md>` to get the font lines. Then run `verify.mjs <PROJECT_DIR> --focus <frames>` once. This samples the target frames at 20/40/60/80/95%, so problems late in a frame are visible. Look at every sheet it prints. Frame N = `## Frame N`. Never open a browser, start an http server or render just to inspect: the focus sheets are the inspection tool.

R1. Classify the request. Pick the cheapest class that fully satisfies it:
   - **captions**: wrong caption words only. Edit the word `text` in `audio_meta.json` (keep the timings), then continue at R3.
   - **visual**: layout, color, text on screen, animation, overlap in specific frames. Go to R2 with those frames.
   - **narration**: spoken words change. Edit those lines in SCRIPT.md, rerun Step 3.1 audio (foreground), then `sync-durations`, then rebuild the packets. Changed frames go to R2, along with any frame whose duration shifted by > 0.3s and that has time-coded animation.
   - **duration**: the prompt's "Video length" says to change it. Let current = the sum of the frame durations and r = target / current.
     - 0.88 ≤ r ≤ 1.12: pace only. Rerun Step 3.1 audio with `--speed <current/target, clamped to 0.88–1.15>`, then `sync-durations`, and rebuild the packets. Every frame goes to R2 with the note "retime your animation to the new data-duration; keep the design".
     - Otherwise: keep the frame count if the target stays within ~5–9s per frame. If not, add or remove at most 2 frames and update STORYBOARD.md (new frames get a full Step 4 design section). Rewrite SCRIPT.md lines to about 2.6 words per second of target, cutting examples or adding one concrete example per frame. Then rerun audio, `sync-durations` and the packets. Frames whose text changed or whose duration shifted by > 0.3s go to R2. Added frames get a full frame worker as in Phase C.
     - A length change combined with other edits is still class `duration`. Apply the other edits in the same pass.
   - **restructure**: a new style or format, or a different angle (frames added or removed only for a length change are class `duration`). Do not attempt it. Stop and report `"change_class": "restructure"` with `"video": ""`, and in `notes` tell the requester to submit a new job.
R2. Dispatch ONE parallel `task` batch with one fix worker per affected frame. Give each worker the absolute paths of its frame file, its packet and `.hyperframes/frame-packets/_role.md`, the exact change for that frame, the font lines and the Worker rules. Tell it to keep everything else about the frame as is.
R3. Run `verify.mjs <PROJECT_DIR> --focus <changed frames>`, check the sheets, and do at most 1 more fix round, following the Phase D rules. Before Phase E, run a plain `verify.mjs <PROJECT_DIR>` (no `--focus`), so the delivered `snapshots/contact-sheet.jpg` has one tile per frame and its numbering matches the frames. Then run Phase E **once**. `frames_changed` lists the frame numbers you touched.

## Phase E — Render once
14. `npx hyperframes render --skill=faceless-explainer --quality high --output renders/video.mp4`. Never re-render.
15. ffprobe the output: duration, 1920x1080, audio stream present.

## Reporting
Keep tool calls lean. Batch independent reads and checks in one turn. No todo bookkeeping.

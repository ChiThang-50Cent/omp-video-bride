# omp-video-bridge v2 — Current implementation

Status: repository implementation. Prior v2 deployment evidence is recorded below; updating this checkout does not imply a production rollout. This document separates implemented behavior from retained design gaps. v1 sources are retained in historical commit `7634908`.

## 1. Architecture and commands

The host deployment runs the bridge and omp on the host with Hermes in Docker. The additional repository Compose deployment runs both the worker and Hermes in separate containers. Two pipelines are registered: HyperFrames `hyperframes-explainer` for technical explainers and `hyperframes-storybook` for art-first flat 2D storybook films built from complete reusable character/background images and sparse whole-character slide/tilt motion. The core job state machine contains no pipeline-specific behavior.

Runtime: Node.js `^22.20.0 || ^24.0.0 || >=26.0.0`, native TypeScript stripping, built-in `node:sqlite`, `node:http`, and zod. TypeScript is used for typechecking; Vitest runs the tests. There is no emitted `dist` deployment or separate build step.

```sh
npm ci
npm start          # run src/main.ts
npm run dev        # same entry point with Node watch mode
npm run typecheck  # src, test and tools
npm test
npm run smoke       # authenticated API smoke
npm run smoke:webhook
npm run check      # typecheck + test + API + webhook smoke
```

Host production uses `deploy/omp-video-bridge.service`, which starts `src/main.ts` directly. `BRIDGE_CONFIG` selects a JSON configuration file; `BRIDGE_HOST`, `BRIDGE_PORT`, `BRIDGE_DATA_DIR` and `BRIDGE_TOKEN_FILE` override the corresponding settings. See `src/config.ts` for defaults and validation.

`dataDir` and `tokenFile` must be nonempty absolute paths, including environment overrides. This keeps startup, host preflight and persisted artifact paths independent of the caller's working directory.

## 2. Domain and jobs

- A project owns scenes, shared pipeline/spec, assets, timeline order/transitions, and its last stitched output.
- A scene owns versions and selects a `currentVersionId`. Even a one-off video is a one-scene project. A storybook scene can contain multiple internal shots; internal shot count is not API scene count.
- A version records `parentVersionId`, its workdir/projectDir, state, duration, notes, and outputs: `video`, `contactSheets[]`, `captionsGroups`.
- Jobs are `build`, `revise`, `render` or `stitch`. They carry entity references, opaque caller metadata, usage, limits, result/error, and timestamps.
- Project, scene, version and asset records are JSON documents in indexed SQLite tables. Jobs and append-only events are persisted separately.

States: `queued`, `running`, `awaiting_approval`, `interrupted`, `succeeded`, `failed`, `rejected`, `cancelled`. Transitions are implemented in `src/core/job.ts`; illegal transitions throw.

Automatic crash recovery applies only to an omp job left `running` by a bridge restart. The bridge may recover it at most two times, using the original omp session and the **original** `maxMinutes` clock. Automatic recovery does not reset limits and is distinct from an explicit manual resume. Approval continuation uses the same session without consuming an automatic crash-resume slot.

Manual recovery is an authenticated `POST /v1/jobs/:id/resume` for an existing `build`, `revise`, `render`, or `stitch` job in `failed`, `cancelled`, or `interrupted`. It is never inferred from a webhook, notification, or failed-job poll, and it never creates a replacement job or falls back to a fresh session. The same job ID, references, version, workdir, input, metadata, phase, approval notes, and history are retained. A new persisted `manual_resume` event records the explicit action; the continuation emits `job.resumed` and exposes `resumeReason:"manual"` in the job response. Manual resume does not increment the automatic-recovery count.

Before any mutation, manual resume requires the target job to be absent from the local running map and no conflicting scene/project work (a stitch conflicts with any work in its project), and revalidates that all referenced project, scene, version, timeline, and current rendered inputs still exist and belong together. For build/revise the original workdir and main session must exist; revise also requires its original copied project directory. Render requires the original ready preview with a project directory and no video; stitch revalidates and reruns the **current** project timeline/scenes, not a stale snapshot. A deleted reference or ready version is not resurrected or overwritten. Build/revise restore the existing pending/failed version and clear its notes without copying a revise parent. Missing required build/revise directories/session data returns `resume_unavailable`; other invalid or conflicting requests are rejected without state, event, version, or outbox mutation.

The optional resume body is `{limits?: {maxMinutes?: positive number <= 240, maxUsd?: positive number <= 50}}`. Omitted fields reuse the old limit; supplied fields replace only those fields. A manual resume clears terminal error/result/finishedAt and resets `startedAt` to null so its next start opens a fresh time window. Usage and tokens remain cumulative: if cumulative USD has exhausted the old `maxUsd`, an explicit higher **total** `maxUsd` is required; lowering it cannot erase prior spend. `maxUsd` remains a bridge-side watcher, not a hard provider billing cap. Native render and stitch keep `maxUsd: 0`, reject USD edits with `invalid_request`, never invoke omp/LLM work, and do not add a native time watcher.

Build approval (`approve:"storyboard"`) stops after the storyboard/script/preset, before audio and frames. The job waits until approved or cancelled; there is no automatic approval timeout. Reviewer notes are applied before production continues, and an approval continuation remains in the approved phase.

The approval waiting state has no automatic timeout, but its **automatic** recovery clock remains the original job start and includes approval waiting. Manual resume is the only path that opens a fresh time window. A late approval or continuation can fail at the next watcher check after beginning provider work; choose a limit that includes review time and never automatically resubmit a paid request.

Build preview (`render:false`) produces frame compositions and contact sheets but no MP4. A separate native render job encodes the ready version without an LLM call. Preview still incurs the storyboard, audio, frame and verification costs; no fixed speedup is guaranteed.

## 3. Pipeline contract

`src/ports/pipeline.ts` defines the canonical `Pipeline` interface:

- `id`, `version`, `specSchema`, `sceneOptionsSchema`.
- `catalog()` and `prompt(ctx)` for build/revise/resume/approval continuation.
- `parseResult(finalText, workdir, {requireVideo})`.
- `omp()` supplies skill directories and environment.
- `prepareBuild?(ctx)` may write a pipeline-owned production contract after the workdir exists.
- `prepareRevision(fromProjectDir, toWorkdir)` copies sources and rewrites embedded packet paths.
- `render(projectDir, signal?)` encodes a preview natively.

The two HyperFrames constructors live under `src/pipelines/hyperframes-explainer/`.
`hyperframesExplainer` keeps the technical explainer contract; `hyperframesStorybook`
uses the sibling `omp-storybook-pipeline` skill and accepts `style`,
`format`, `voice`, `audience`, `tone`, `narrationMode` (`verbatim` or
`restructured`, default `verbatim`), and `music` (`required` or `none`, default
`required`). Its sole supported style is `storybook-flat`. Storybook production
starts with coherent complete image assets and a still establishing-frame review,
then uses whole-character slide/tilt transforms; supplied or authorized artwork
is allowed and no paid-provider or primitive-drawing assumption is made. A
storybook build must preserve its production contract and machine acceptance
artifacts; visual review remains a human/aesthetic check.

The HyperFrames implementation, prompt templates, custom skills, and helper scripts live together under `src/pipelines/hyperframes-explainer/`. The technical worker rules remain in `omp-video-pipeline/SKILL.md`; storybook rules and scripts are in the sibling storybook skill. Upstream skills are not edited. The pipeline pins `hyperframes@0.8.82`.

### Storybook authoring manifest and compiled scene

The worker's `storybook.json` is the source contract. It keeps
`schemaVersion`, `kind:"hyperframes-storybook"`, `style:"storybook-flat"`,
`format`, `canvas`, `durationSec`, `requirements`, `narration`, and `assets`.
It adds root `characters` and `backgrounds` arrays; it does not accept alternate
source or character-schema forms:

```json
{
  "schemaVersion": 1,
  "kind": "hyperframes-storybook",
  "style": "storybook-flat",
  "format": "landscape",
  "canvas": {"width": 1920, "height": 1080},
  "durationSec": 6,
  "requirements": {
    "narration": "required",
    "narrationMode": "verbatim",
    "music": "required"
  },
  "characters": [
    {"id": "traveler", "path": "assets/characters/traveler.png",
     "width": 240, "height": 420, "sha256": "<optional sha256>"}
  ],
  "backgrounds": [
    {"id": "fireplace-room", "path": "assets/backgrounds/fireplace-room.webp",
     "sha256": "<optional sha256>"}
  ],
  "assets": [],
  "narration": {
    "scriptPath": "SCRIPT.md",
    "lines": [{"shotId": "opening", "text": "The exact authored line stays here."}]
  },
  "shots": [
    {
      "id": "opening",
      "durationSec": 6,
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
              {"timeSec": 0, "x": 0, "y": 0, "rotation": 0},
              {"timeSec": 6, "x": 0, "y": 0, "rotation": 0}
            ]
          }
        }
      ]
    }
  ]
}
```

Character and background paths are local project-relative PNG, WebP, or SVG
files. Character `width` and `height` are positive authored whole-image
dimensions. A character is positioned by its bottom-center pivot. Shot cast
`x`/`y` are bottom-center anchor pixels in the canvas; `scale` defaults to 1.
Motion keyframes are finite, strictly ordered times within the shot, with `x`/`y`
offsets from that anchor and `rotation` in degrees (default 0). Speaking
slide/tilt windows SHOULD follow measured narration/word spans and return to
neutral when each utterance ends; do not rock through silent padded time. Missing
motion means completely still. The selected background asset covers the entire
backdrop. Source files are reused, hashed, and bound to the compiled record.
`durationSec` equals the sum of shot durations. The narration and caption
metadata contracts remain unchanged.

Run `compileProject(projectDir)` from
`src/pipelines/hyperframes-explainer/skills/omp-storybook-pipeline/scripts/compile-scene.mjs`
or its CLI:

```bash
node "$STORYBOOK_SCRIPTS/compile-scene.mjs" "$PROJECT_DIR"
```

The compiler writes `.hyperframes/storybook-assets-manifest.json` and
`compositions/storybook-characters.html`. The compiled record may add audit
bookkeeping, but must communicate the authored IDs, paths, dimensions, anchors,
scales, and finite keyframes above. The native composition uses a paused
registered GSAP timeline plus deterministic seek to drive actual encoded
whole-image transforms and the caption wrapper. The mounted root, index, and
composition expose explicit markers and current source hashes so audit can prove
the files in the rendered page are the authored files.

Final storybook acceptance binds the delivered video path to the audited artifact
and compares sampled encoded frames against browser references at the same CFR
frame timestamps. Codec-tolerant whole-frame and spatial-tile bounds detect
visual mismatches; this is sampled evidence, not an exhaustive frame-by-frame
comparison. Screenshot/contact-sheet bytes, contact metadata and the evidence
digest are revalidated before accepting visual review. Older audits must be
regenerated. Measured caption phrases must cover the authored narration words
in order, using the existing case/punctuation normalization.

The shared audio helper supports leading, intervening and trailing unnarrated
beats while retaining the complete storyboard timeline for music and alignment.
Silent projects do not require Kokoro/Whisper. Completed measured synthesis is
checkpointed before fitting, music, alignment or caption failures, so reruns can
reuse successful unchanged narration.


## 4. HTTP API

Every endpoint except `/v1/health` requires an explicit `Authorization: Bearer <token>` header. Empty/whitespace token files fail startup. Errors are `{"error":{"code":"…","message":"…"}}`; responses carry `X-Request-ID`, and unexpected HTTP failures are logged with request metadata, not bodies or credentials. JSON bodies are limited to 1 MiB; raw asset uploads to 200 MiB.

| Method + path | Current behavior |
|---|---|
| `GET /v1/health` | App/pipeline versions, running/queued counts, webhook pending/dead counts or disabled |
| `GET /v1/catalog` | All registered pipeline catalogs |
| `POST /v1/videos` | Creates `{project,scene,job,version}` for a one-off build; optional `pipeline` selects an exact registered pipeline ID, defaulting to `hyperframes-explainer` |
| `POST/GET /v1/projects` | Create/list projects; creation accepts an exact registered `pipeline` ID |
| `GET/PATCH/DELETE /v1/projects/:id` | Inspect/update/remove a project; GET includes scenes/versions/assets |
| `POST /v1/projects/:id/scenes` | Creates a scene without starting production |
| `GET/DELETE /v1/scenes/:id` | Inspect/remove a scene; GET includes versions |
| `POST /v1/scenes/:id/build` | Queues a build |
| `POST /v1/scenes/:id/revise` | Requires instructions; accepts frames, durationSec, fromVersionId and job options |
| `POST /v1/scenes/:id/use` | Selects a ready version with `{versionId}` |
| `GET /v1/versions/:id` | Version details |
| `POST /v1/versions/:id/render` | Native render of an unrendered ready version |
| `POST /v1/projects/:id/assets?name=&tags=&source=&license=` | Raw upload; content deduplication by SHA-256 |
| `GET /v1/projects/:id/assets` | Lists project assets |
| `DELETE /v1/projects/:id/assets/:aid` | Removes an asset and its scene references |
| `PUT /v1/projects/:id/timeline` | Updates complete order and cut/fade transitions |
| `POST /v1/projects/:id/stitch` | Joins current rendered versions in timeline order |
| `GET /v1/jobs?state=&project=&limit=` | Lists jobs; state must be known, limit is a decimal integer 1–500 (default 50) |
| `GET /v1/jobs/:id?events=1` | Job, related version, optional persisted events |
| `POST /v1/jobs/:id/approve` | Continues a waiting job with optional notes |
| `POST /v1/jobs/:id/cancel` | Cancels a nonterminal job |
| `POST /v1/jobs/:id/resume` | Explicitly resumes a failed, cancelled, or interrupted build/revise/render/stitch job; optional `{limits:{maxMinutes,maxUsd}}`; returns `{job}` |

`src/http/routes.ts` contains the exact request schemas. Job submissions accept metadata, echoed in webhooks. `POST /v1/videos` accepts an optional exact pipeline ID and preserves the explainer default; unknown IDs are rejected. For storybook, upload real assets through `/v1/projects/:id/assets` before creating/building scenes and pass only returned IDs/names in scene `assets`; `metadata.localProjectDir` is never a file import. Explicit pipeline selection is also available when creating a project. Resume requests are authenticated and validate limits before mutation: `maxMinutes` is positive and at most 240, `maxUsd` is positive and at most 50, and native render/stitch jobs reject USD edits with `invalid_request`. `not_resumable` covers queued, running, awaiting-approval, succeeded, and rejected jobs. For an existing job, missing or mismatched project/scene/version references use `resume_unavailable`; an unknown job ID retains the normal `not_found` behavior. Conflicting or stale ready/current inputs are rejected without mutati…

Resume guard errors are returned before any state/event/version/outbox change:
`409 resume_unavailable` for missing or mismatched project/scene/version/timeline,
revision parent, newer ready version, original workdir/main session, or
incomplete persisted usage history; `409 budget_exhausted` when cumulative USD
has reached the effective total; `409 job_busy` for a locally running target;
`409 scene_busy` for other active work on the same scene; `409 project_busy` for
an active project stitch or other project conflict; and `409 already_rendered`
when a native render already has a video. Native USD edits are `400
invalid_request`.

## 5. Runner, storage and artifacts

Concurrency is configurable, default one. Queued jobs are FIFO; there is no cheap-job priority lane. omp runs in its own process group. Cancel sends SIGTERM to that group, with SIGKILL after the grace period.

Usage is summed over all `sessions/**/*.jsonl`, including workers, and persisted usage/tokens are cumulative across automatic and manual continuation. The app polls reported usage and elapsed time for omp jobs (default interval 15 seconds) and fails exceeded budgets with `limit_exceeded`; it does not pass `--max-time` to omp. `maxUsd` is not a hard provider spend cap: unreported/in-flight usage and polling delay can overshoot it. A manual resume may replace a limit only within the accepted bounds and requires a higher **total** USD limit when cumulative usage has exhausted the old one; it never reduces saved usage. Polling and finalization cannot decrease persisted USD or token totals. Preserve the worker/session usage logs needed to account those totals; incomplete history is rejected before mutation rather than silently starting a new job. Hermes provider usage is separate. Native render/stitch cancellation uses AbortSignal.

SQLite (`<dataDir>/bridge.db`, WAL) is the source of truth. Files live under:

```text
<dataDir>/projects/<project-id>/
  assets/<sanitized-name>
  assets/found/                         # optional sourced files and SOURCES.md
  scenes/<scene-id>/v<number>/          # omp cwd, sessions, logs, pipeline project
    production-contract.json            # worker-side contract copy
    videos/storybook/
      production-contract.json           # project copy used by the storybook worker
      storybook.json                     # root characters/backgrounds and shots
      assets/                            # local character/background PNG/WebP/SVG files
      compositions/storybook-characters.html
      .hyperframes/storybook-assets-manifest.json
      acceptance.json                    # machine acceptance and source/assets hashes
      .hyperframes/storybook-audit.json  # machine audit report
      .hyperframes/storybook-audit/
        contact.json                     # visual-review handoff, sourceDigest/evidence, review-required
        *.png                            # browser audit screenshots
        visual-review.json               # single human review, bound to audit evidence
  final/final.mp4
```

Version records point to the pipeline's rendered video/contact sheets; no copied `outputs/` tree or `current` symlink is maintained. Published media/caption outputs and approval documents are made readable (`0644`) for Hermes's different UID. Private sessions/config files are not included in that permission change.

For `hyperframes-storybook`, the browser audit proves visible bounded full-character
geometry, authored anchor positions/rotations, deterministic seek behavior,
complete background coverage, same-file reuse, source/hash integrity, caption
timing/safety, and real lint/media checks. Stationary characters are valid; no
mandatory motion or extra visual-effect gate is required. `acceptance.json` must
bind the actual source and asset hashes and is checked against the current
production contract; a stale or missing report cannot certify the version.
Delivery also requires `.hyperframes/storybook-audit/visual-review.json` with an
approved verdict, the current audit `sourceDigest`, only emitted evidence files,
and one substantive style/continuity/acting/captions observation per internal
shot. Machine acceptance does not certify aesthetic quality.

Project/scene deletion refuses queued, running, awaiting-approval and interrupted work without a history-size cap. Scene deletion also refuses active project stitches, cleans owned version directories and timeline references, and preserves imported external workdirs and terminal job/event history. Scene/version/timeline changes invalidate the previous final output. Asset uploads deduplicate by hash and disambiguate colliding names; staged writes/deletes compensate database failures.

Stitch uses native FFmpeg re-encoding and never invokes omp/LLM. Hard cut is the default; `fade` on an incoming scene applies an up-to-0.5s video/audio crossfade. Every timeline scene must have a current rendered version. A manual stitch resume revalidates and reruns the current timeline/scenes at execution time.

`tools/import-v1.ts` imports finished v1 job chains as projects/scenes/versions without moving original files. It does not import legacy project manifests or unfinished jobs. Keep the old video directory mounted if imported versions are still used.

## 6. Hermes webhooks and deployment

Host systemd deployments normally bind the bridge to loopback. The host example webhook URL is `http://127.0.0.1:8644/webhooks/omp-video`; the isolated Docker worker instead binds inside its Compose network and uses the configured Hermes service URL. Do not expose either deployment publicly without an authenticated reverse-proxy/network design.

Signing: `X-Webhook-Signature-V2` is hex HMAC-SHA256 over `<timestamp>.<body>`, with `X-Webhook-Timestamp` and stable `X-Request-ID` delivery identity. Transactional outbox delivery is at-least-once, with retry backoff 10s / 1m / 5m / 30m, then dead.

Events: `job.started`, `job.awaiting_approval`, `job.succeeded`, `job.failed`, `job.rejected`, `job.cancelled`, `job.resumed`. The persisted API event list (`GET /v1/jobs/:id?events=1`) records `manual_resume` for an explicit authenticated manual-resume call; `job.resumed` is the webhook continuation notice for manual or automatic recovery. It is not approval and never asks a consumer to submit another job. Successful build/revise/render/stitch jobs all use `job.succeeded`.

Payload: `{event_type,event_id,at,job:{id,kind,state,refs,usage,error,result,phase,attempts},metadata}`. Webhook paths are rewritten using `containerMount`; HTTP responses retain host paths.

The owner explicitly grants `terminal`, `file`, and `skills` only to the authenticated `omp-video` route. A notification is not approval. The custom Hermes skill uses authenticated curl to inspect jobs/documents, and `/opt/hermes/bin/hermes send --to telegram --json` for real MP4/contact-sheet attachments. Sender warnings identify partial failures even when `success:true`.

`deploy/install.sh` validates the actual `src/config.ts` schema and required host executables (nonempty private bearer token, omp, configured HyperFrames browser/Python providers, ffmpeg and ffprobe) before rendering a portable `deploy/omp-video-bridge.service` template. Install mode writes the unit and reloads systemd but does not enable, start, or restart production unless the operator supplies an explicit action flag; `--check-only` performs no writes or systemd calls. It never sources config with shell evaluation and has no machine-specific home/repository paths. Hermes skill copying, Docker port/mount configuration, and webhook registration remain separate operations; there is no automatic skill-version handshake in the installer.

### Host systemd operation and offline recovery

The service is single-instance per absolute `dataDir`; SQLite and artifacts must be backed up together while the service is stopped. `deploy/backup.mjs --stopped` validates a regular-file/directory data tree (rejecting links/special files), checkpoints WAL, runs `integrity_check`, and archives the complete tree with the host `tar` (hardlinks are copied independently, archive mode is `0600`); it never copies config/secrets or overwrites an existing archive. `deploy/restore.mjs --stopped` validates archive paths/types, requires an absent destination, checks SQLite integrity, and atomically restores into a new directory. Both tools refuse relative paths and require explicit stopped acknowledgement. Retention is manual (there is no automatic destructive pruning), and imported v1 sources need their original mount. See [`docs/OPS.md`](OPS.md) for exact upgrade, restore, permission, and webhook dead-letter commands.

### 6.1 Repository Docker deployment (linux/amd64)

This is an additional deployment recipe, not a production migration. The existing host systemd service and Hermes state remain unchanged. Docker Engine with BuildKit and Compose v2 are required; the host does not need Node/Python/model installations for this recipe.

- `deploy/Dockerfile.runtime` builds the reusable CPU dependency base: pinned Node/omp/HyperFrames, Python TTS environment, portable Whisper binary, system libraries and the selected upstream skills. Upstream archives/binaries are fetched and SHA256-checked during the build; no local checkout or binary is required.
- `deploy/Dockerfile.worker` adds production bridge dependencies, startup/configuration scripts and application source last. Models and Chrome are **not** in either worker image.
- `deploy/hermes/Dockerfile` fetches the pinned Hermes commit and packages core Python, Telegram/webhooks, curl, FFmpeg, git/SSH, terminal/file/skills and fixed SQLite 3.53.4. No Node, browser, desktop/dashboard or build compiler is installed in the final image. This is not a replacement for every capability of the official Hermes image.
- `deploy/runtime-lock.json`, `deploy/hyperframes/package-lock.json` and `deploy/requirements.worker.txt` retain the tested versions. Skills are the exact composite snapshot from upstream commits `663b02297d58b56d7153bb156451ebb2b830941b` and `2195db5e1d05f72d966e880e4d258a2e779fa143` (media-use only); automatic skill refresh is disabled in the worker. Native apt packages still come from the base distribution repositories, and Python wheels have version pins rather than hash pins: byte-identical whole-image rebuilds are not claimed.
- `.dockerignore` allowlists source/recipes/locks and excludes `.token`, environment files, host dependencies, data and other heavy/state inputs. State/secrets/assets belong outside Git and outside the build context.

Follow the [Docker onboarding guide](SETUP.md#docker-onboarding) for the complete build/init/start, separate worker/Hermes authentication, account-valid model selection, Telegram configuration and readiness checks. It uses a durable external state root, explicit Compose project and unused loopback ports; health alone does not prove provider access or Telegram delivery.

`setup.sh` defaults to `all`: build the base and application images, initialize external state/assets, then start and wait for healthy services. Separate actions are `build`, `init`, `up` and `down`. `down` does not remove persistent bind-mounted state. Keep the same state/project/port settings and checkout for subsequent commands. Raw Compose requires `OMP_VIDEO_STATE_DIR`; the wrapper defaults it to the external directory above and rejects a state directory inside the repo. Raw Compose port defaults are 8765/8644, unlike the onboarding's isolated 18765/28644.

See [USAGE](USAGE.md) for submit, approval, preview/native render, revision, cancellation and Telegram interaction; see [Docker OPS](OPS.md#docker-isolated-deployment) for status, updates, stopped backups, restore/rollback and troubleshooting.

External state layout:

```text
$OMP_VIDEO_STATE_DIR/
  assets/                 # pinned models + complete Chrome tree + integrity receipt
  video-data/             # SQLite, projects, versions, sessions, outputs
  omp-state/              # dedicated worker .omp state/auth, not shared with host
  font-cache/             # stage-fonts cache
  hermes/                 # persistent Hermes configuration/auth/sessions
  secrets/                # bridge-token and webhook-secret
  worker-config.json      # operator-editable config, initially seeded from example
```

`init-state` seeds configuration/secrets only when absent and prepares UID1001 worker directories and UID10000 Hermes directories, including the writable skill parent before mounting `omp-video` beneath it read-only. The enclosing host state/secrets directories are private; individual secret files use operator ownership and mode `0644` so both authorized container UIDs can read their file binds. No secret value is baked into an image or printed by setup. Worker configuration and provider state remain private; do not recursively change these owners/modes.

The worker's `runner.defaultModel` selects both orchestrator and worker models. Selecting a model in the omp TUI does not edit this bridge setting; the schema fallback is not a guarantee that an account can access that model. `omp login [provider]` and `omp models` use the dedicated worker `.omp` state (credential store `agent.db`), separate from Hermes authentication/model configuration. The [setup guide](SETUP.md#4-authenticate-the-omp-worker-and-inspect-its-model-catalog) handles OAuth callback constraints and optional private provider environment settings without exposing secrets in argv.

Worker startup generates its effective private configuration at `/tmp/omp-worker/worker-config.json`, injecting the webhook URL/secrets. `docker compose exec` does not inherit the entrypoint's newly set `BRIDGE_CONFIG`. Recreate the worker after editing its file-bound operator config, especially when an editor replaces the file inode; restarting only the bridge process inside a running container retains the old bind. Reload Hermes after changing its settings, without launching a second polling gateway.

Use a separate Telegram test bot while an old gateway is running. Reusing its production bot token in a second polling gateway causes competing consumers; switch gateways only during an explicit cutover. The [setup guide's configuration-only Telegram helper](SETUP.md#configure-telegram-without-starting-a-second-gateway) does not poll/send; `hermes setup gateway` can start a gateway and is not a safe config-only substitute.

`init-assets` downloads only pinned model revisions/Chrome with SHA256 verification. An initialized matching cache is reusable without network; incomplete/corrupt assets fail validation and are not silently accepted. Worker startup rechecks model hashes and the complete Chrome tree, then mounts `/assets` read-only. The TTS helper cache stays writable separately from its read-only `models/` and `voices/` links. Worker `/tmp` is executable tmpfs because espeakng-loader copies its shared library there before `dlopen`; capabilities remain dropped and no privileged/GPU/socket access is granted. Stop the worker before changing asset pins or repairing assets. Fonts/CDN scripts can still require network at render time; this is not a fully offline worker.

The [pinned HF mirror model](https://huggingface.co/mikkoph/kokoro-onnx/tree/55c2af9958bf69eee07133cda380c1599c2f2bc5) preserves the previously tested Kokoro ONNX bytes. The canonical upstream release currently has a different model checksum; filenames alone are not version identity. Chrome comes from the [exact Chrome for Testing release](https://googlechromelabs.github.io/chrome-for-testing/156.0.8075.0.json).

Worker API binds inside its container, Hermes uses `http://video-worker:8765`, and bridge webhooks use `http://hermes:8644/webhooks/omp-video`. Both host publications are loopback-only. `worker-config.json` maps `/data/worker` to Hermes `/videos-v2`; `OMP_BRIDGE_DATA_DIR=/data/worker` tells the mounted skill how to translate API paths. The bootstrap grants terminal/file/skills only to the HMAC-authenticated `omp-video` route; notifications are not approval. There is no unauthenticated probe secret or ephemeral tmpfs Hermes home.

Do not copy a live SQLite file or point these paths at production data as an automatic cutover. Existing DB rows/session packets contain absolute paths. Moving the host state root is supported operationally only while preserving its original in-container namespaces, especially `/data/worker` and `/videos-v2`; there is no supported general absolute-path migration tool. Imported v1 references additionally require their original legacy read-only mounts. Drain/stop and a consistent full backup are prerequisites; restoring files does not prove provider access or authorize resuming paid work.

Observed isolated packaging smoke (2026-09-30): worker/Hermes health, bearer authorization and HMAC-V2 rejection/acceptance using an ignored event; standard offline bare/pinned npx; CPU Kokoro WAV (24kHz mono, 4.437s), Whisper small.en word timestamps; read-only assets and rejection of a corrupt voice checksum before startup; and a fresh 1920x1080@30 H.264/AAC render (~20.467s) readable by Hermes. The retained render fixture pins CLI 0.8.95 while the bridge deliberately uses 0.8.82; the fixture also reports 1 lint error/19 warnings, so this smoke does not claim a clean authoring audit. No paid LLM turn, actual Telegram send, production restore or ARM/offline verification is included.

Independent final-artifact verification exercised a fresh final-tag container for CPU TTS, Chrome DOM execution, project scaffolding without skill refresh, full asset validation and a new 20.467s H.264/AAC render. It also verified CPU transcription, decoded and visually inspected the fresh video, proved Hermes's read-only view and terminal/file/skills/FTS5 behavior, verified bootstrap preservation and HMAC authentication, rejected corrupt assets before startup, scanned the Hermes rootfs for Node/browser/C compiler executables, and byte-compared all 406 selected skill files to the checksum-verified upstream archives. Verdict: PASS for the exercised Linux/amd64 packaging scope. Whole-image clean-build reproducibility and configured LLM/Telegram/production cutover remain outside that verdict.

Docker Engine local image accounting on this machine: worker ~2.17GB versus previous ~4.22GB (about 48% lower), Hermes ~1.28GB; external assets ~1.13GB (~1.05GiB). Worker uncompressed layer sum is ~1.59GB. The base's ~2.16GB local size shares layers with the worker: do not add both as separate disk consumption. These are not registry transfer sizes. A fully cached worker-only rebuild took 4.05s; this is not a cold-build or first asset-download measurement.

## 7. Verification and retained design gaps

Repository verification for 2.0.2: Node 22.22.3 typecheck and 52 tests passed; native service startup/auth/query/lifecycle/shutdown and real loopback HMAC-V2 retry/dead-letter delivery passed. Real FFmpeg cut/fade outputs were fully decoded as H.264/AAC at 320x180 (2.432s/1.932s). A 6,000-file stopped backup restored successfully; overwrite/link rejection, atomic redrive, systemd unit parsing, selected configuration and permission/path preflight were exercised. Fresh Linux/amd64 runtime/worker/Hermes images built successfully; the worker image passed native API and media smoke, and Hermes passed SQLite 3.53.4/FTS5/Telegram/aiohttp dependency smoke. No paid model call, actual Telegram send, production restore or rollout was performed in this verification.

Earlier live smoke evidence covers a 30s video, cancel, crash-resume/revision, a two-scene logo project with crossfade stitch, storyboard approval with reviewer notes, preview without MP4, native render, and real Telegram MP4/contact-sheet delivery. The approval/preview sample retained 11 contrast warnings; runtime/layout checks did not report errors.

The original design also proposed items not implemented by the current code: generated OpenAPI, separate retry/log/event endpoints, scene PATCH, project-level music mixing after timeline stitching, stitched VTT/thumbnail output, automatic brand application, cheap-job priority, automatic retention/pruning, and complete legacy-project import. Storybook composition rendering already mixes its own narration and music bed. Health reports app and registered pipeline/worker-skill versions, but there is no automatic compatibility handshake with Hermes or upstream runtime tools. Manual cleanup and stopped backup/restore procedures are operational safeguards, not automatic retention.

Video directories, session history and DB files are retained. Cleanup does not delete them or remove rollback history from Git.

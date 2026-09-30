# omp-video-bridge v2 — Current implementation

Status: deployed. This document describes the current code and explicitly separates unimplemented items from the original design. v1 sources are retained in historical commit `068109c`, not alongside the running v2 source.

## 1. Architecture and commands

Hermes runs in Docker; the bridge and omp run on the host. HyperFrames `faceless-explainer` is the first pipeline. The core job state machine contains no HyperFrames-specific behavior.

Runtime: Node.js >=22.20.0, native TypeScript stripping, built-in `node:sqlite`, `node:http`, and zod. TypeScript is used for typechecking; Vitest runs the tests. There is no emitted `dist` deployment or separate build step.

```sh
npm ci
npm start          # run src/main.ts
npm run dev        # same entry point with Node watch mode
npm run typecheck  # src, test and tools
npm test
```

Production uses `deploy/omp-video-bridge.service`, which starts `src/main.ts` directly. `BRIDGE_CONFIG` selects a JSON configuration file; `BRIDGE_HOST`, `BRIDGE_PORT`, `BRIDGE_DATA_DIR` and `BRIDGE_TOKEN_FILE` override the corresponding settings. See `src/config.ts` for defaults and validation.

## 2. Domain and jobs

- A project owns scenes, shared pipeline/spec, assets, timeline order/transitions, and its last stitched output.
- A scene owns versions and selects a `currentVersionId`. Even a one-off video is a one-scene project.
- A version records `parentVersionId`, its workdir/projectDir, state, duration, notes, and outputs: `video`, `contactSheets[]`, `captionsGroups`.
- Jobs are `build`, `revise`, `render` or `stitch`. They carry entity references, opaque caller metadata, usage, limits, result/error, and timestamps.
- Project, scene, version and asset records are JSON documents in indexed SQLite tables. Jobs and append-only events are persisted separately.

States: `queued`, `running`, `awaiting_approval`, `interrupted`, `succeeded`, `failed`, `rejected`, `cancelled`. Transitions are implemented in `src/core/job.ts`; illegal transitions throw.

Running omp jobs left by a bridge restart become interrupted and are requeued with `omp --continue`. Automatic crash resumes are limited to two. Approval continuation uses the same session without consuming a crash resume.

Build approval (`approve:"storyboard"`) stops after the storyboard/script/preset, before audio and frames. The job waits until approved or cancelled; there is no automatic approval timeout. Reviewer notes are applied before production continues.

Build preview (`render:false`) produces frame compositions and contact sheets but no MP4. A separate native render job encodes the ready version without an LLM call. Preview still incurs the storyboard, audio, frame and verification costs; no fixed speedup is guaranteed.

## 3. Pipeline contract

`src/ports/pipeline.ts` defines the canonical `Pipeline` interface:

- `id`, `version`, `specSchema`, `sceneOptionsSchema`.
- `catalog()` and `prompt(ctx)` for build/revise/resume/approval continuation.
- `parseResult(finalText, workdir, {requireVideo})`.
- `omp()` supplies skill directories and environment.
- `prepareRevision(fromProjectDir, toWorkdir)` copies sources and rewrites embedded packet paths.
- `render(projectDir, signal?)` encodes a preview natively.

The HyperFrames implementation, prompt templates, custom skill, and helper scripts live together under `src/pipelines/hyperframes-explainer/`. Worker rules are a section of `omp-video-pipeline/SKILL.md`, not a separate skill. Upstream skills are not edited. The pipeline pins `hyperframes@0.8.82`.

## 4. HTTP API

Every endpoint except `/v1/health` requires bearer authentication. Errors are `{"error":{"code":"…","message":"…"}}`. JSON bodies are limited to 1 MiB; raw asset uploads to 200 MiB.

| Method + path | Current behavior |
|---|---|
| `GET /v1/health` | Health, running/queued counts, webhook pending/dead counts or disabled |
| `GET /v1/catalog` | All registered pipeline catalogs |
| `POST /v1/videos` | Creates `{project,scene,job,version}` for a one-off build |
| `POST/GET /v1/projects` | Create/list projects |
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
| `GET /v1/jobs?state=&project=&limit=` | Lists jobs |
| `GET /v1/jobs/:id?events=1` | Job, related version, optional persisted events |
| `POST /v1/jobs/:id/approve` | Continues a waiting job with optional notes |
| `POST /v1/jobs/:id/cancel` | Cancels a nonterminal job |

`src/http/routes.ts` contains the exact request schemas. Job submissions accept metadata, echoed in webhooks. The quick video endpoint uses the default pipeline; explicit pipeline selection is available when creating a project.

## 5. Runner, storage and artifacts

Concurrency is configurable, default one. Queued jobs are FIFO; there is no cheap-job priority lane. omp runs in its own process group. Cancel sends SIGTERM to that group, with SIGKILL after the grace period.

Usage is summed over all `sessions/**/*.jsonl`, including workers. The app polls usage and elapsed time for omp jobs and fails exceeded budgets with `limit_exceeded`; it does not pass `--max-time` to omp. Native render/stitch cancellation uses AbortSignal.

SQLite (`<dataDir>/bridge.db`, WAL) is the source of truth. Files live under:

```text
<dataDir>/projects/<project-id>/
  assets/<sanitized-name>
  assets/found/                         # optional sourced files and SOURCES.md
  scenes/<scene-id>/v<number>/          # omp cwd, sessions, logs, pipeline project
  final/final.mp4
```

Version records point to the pipeline's rendered video/contact sheets; no copied `outputs/` tree or `current` symlink is maintained. Published media/caption outputs and approval documents are made readable (`0644`) for Hermes's different UID. Private sessions/config files are not included in that permission change.

Stitch uses FFmpeg re-encoding. Hard cut is the default; `fade` on an incoming scene applies an up-to-0.5s video/audio crossfade. Every timeline scene must have a current rendered version.

`tools/import-v1.ts` imports finished v1 job chains as projects/scenes/versions without moving original files. It does not import legacy project manifests or unfinished jobs. Keep the old video directory mounted if imported versions are still used.

## 6. Hermes webhooks and deployment

Hermes listens on port 8644, published on host loopback. `deploy/config.example.json` points the bridge to `http://127.0.0.1:8644/webhooks/omp-video`. The bridge itself binds the pinned Docker network gateway for container access.

Signing: `X-Webhook-Signature-V2` is hex HMAC-SHA256 over `<timestamp>.<body>`, with `X-Webhook-Timestamp` and stable `X-Request-ID` delivery identity. Transactional outbox delivery is at-least-once, with retry backoff 10s / 1m / 5m / 30m, then dead.

Events: `job.started`, `job.awaiting_approval`, `job.succeeded`, `job.failed`, `job.rejected`, `job.cancelled`, `job.resumed`. Successful build/revise/render/stitch jobs all use `job.succeeded`.

Payload: `{event_type,event_id,at,job:{id,kind,state,refs,usage,error,result,phase,attempts},metadata}`. Webhook paths are rewritten using `containerMount`; HTTP responses retain host paths.

The owner explicitly grants `terminal`, `file`, and `skills` only to the authenticated `omp-video` route. A notification is not approval. The custom Hermes skill uses authenticated curl to inspect jobs/documents, and `/opt/hermes/bin/hermes send --to telegram --json` for real MP4/contact-sheet attachments. Sender warnings identify partial failures even when `success:true`.

`deploy/install.sh` installs/restarts the systemd unit only. Hermes skill copying, Docker port/mount configuration and webhook registration are separate operations; there is no automatic skill-version handshake in the installer.

## 7. Verification and retained design gaps

Live smoke evidence covers a 30s video, cancel, crash-resume/revision, a two-scene logo project with crossfade stitch, storyboard approval with reviewer notes, preview without MP4, native render, and real Telegram MP4/contact-sheet delivery. The approval/preview sample retained 11 contrast warnings; runtime/layout checks did not report errors.

The original design also proposed items not implemented by the current code: generated OpenAPI, separate retry/log/event endpoints, scene PATCH, background-music mixing, stitched VTT/thumbnail output, automatic brand application, cheap-job priority, retention/pruning, and complete legacy-project import. Health does not report package/pipeline/skill versions. These are explicit gaps, not features supplied by cleanup.

Video directories, session history and DB files are retained. Cleanup does not delete them or remove rollback history from Git.

# omp-video-bridge v2 — Spec (draft for review)

Status: draft. Scope: rewrite of v1 (`server.mjs` + `projects.mjs`). No code until this is approved.

## 1. Goals / non-goals
Goals
- Hermes (in Docker) orders videos, and omp (on the host) produces them through **pluggable pipelines**. HyperFrames `faceless-explainer` is the first pipeline. Others (Manim, screen-demo, other TTS) can be added without touching core, API or the Hermes skill.
- Durable jobs: queue, cancel, resume after a crash, revise with versions, cost/time limits.
- Multi-scene projects: shared look, assets and brand, plus stitching.
- Push notifications to Hermes via its webhook platform. Polling still works.
- Testable: domain and pipelines are unit-tested, and runner/API are integration-tested with a fake `omp`.

Non-goals (v2)
- Multi-host workers, a web UI, and users/tenants (a single bearer token is the only auth).

## 2. Domain model
```
Project 1─* Scene 1─* Version            Asset *─1 Project
                         │
                         └─ produced by ─ Job (kind: build | revise | stitch)
```
| Entity | Key fields |
|---|---|
| **Project** | `id` (slug), `name`, `pipeline`, `spec` (pipeline-specific look: style/format/voice/…), `brief`, `brand` {logoAsset, colors, fonts}, `timeline` {order[], transitions, bgm?}, `createdAt` |
| **Scene** | `id` (`<project>:<n>`), `n`, `title`, `topic`, `brief`, `durationSec`, `assetRefs[]`, `findAssets`, `currentVersion` |
| **Version** | `id`, `sceneId` (or none for standalone videos), `number` (1,2,…), `parentVersion`, `jobId`, `workdir`, `outputs` {video, contactSheet, captionsVtt, thumbnail}, `durationSec`, `createdAt` |
| **Asset** | `id`, `projectId`, `name`, `kind` (image/video/audio/font/other), `bytes`, `sha256`, `origin` (upload/ai-found), `source`, `license`, `tags[]` |
| **Job** | `id`, `kind`, `pipeline`, `state`, `input` (validated), `metadata` (opaque, echoed in webhooks), `limits` {maxMinutes, maxUsd}, `attempts`, `usage` {usd, tokens, phases}, `error` {code, message}, timestamps |
| **Event** | append-only: `jobId`, `type`, `at`, `data`. Drives webhooks and the audit trail |

A standalone video (no project) is an implicit one-scene project, so there is a single code path.

## 3. Job state machine
```
queued ──start──▶ running ──ok──▶ succeeded
  │                 │ ├─needs_approval─▶ awaiting_approval ──approve──▶ queued (phase 2)
  │                 │ │                         └──reject/timeout──▶ cancelled
  │                 │ ├─error──▶ failed
  │                 │ ├─refused (e.g. revise needs restructure)──▶ rejected
  │                 │ └─bridge crash──▶ interrupted ──resume (≤2)──▶ queued
  └──cancel──▶ cancelled ◀──cancel── running / awaiting_approval / interrupted
```
- Only `app/transition(job, event)` changes state. Illegal transitions throw, and unit tests cover them.
- `interrupted` → `queued` with `resume=true`. The runner then uses `omp --continue`. After more than 2 attempts the job ends `failed` with `code=resume_exhausted`.
- Limits: `maxMinutes` (passed as `omp --max-time`) and `maxUsd` (the runner sums session usage live and cancels on breach) → `failed` with `code=limit_exceeded`.
- **Approval (P1, in v2 scope):** a build job with `approve: "storyboard"` stops after the storyboard, script and preset are written, emits `approval.required` with a storyboard preview, and waits. `POST /v1/jobs/:id/approve {notes?}` resumes the same session, with the notes applied before the frames are built.
- **Preview:** a build with `render: false` stops after verify, which produces the contact sheet. Rendering later is `POST /v1/versions/:id/render`, a cheap job with no LLM frames.

## 4. Pipeline plugin interface
```ts
interface Pipeline {
  id: string;                                   // "hyperframes-explainer"
  version: string;
  specSchema: ZodType;                          // project/scene look
  sceneSchema: ZodType;                         // per-scene input
  catalog(): Promise<Catalog>;                  // styles, voices, formats… (GET /v1/catalog)
  prompt(kind: "build"|"revise"|"resume"|"approve-continue"|"render", ctx: PromptCtx): string;
  parseResult(finalText: string, workdir: string): Result;   // zod-validated; outputs must exist
  omp: { skills: string[]; skillDirs: string[] };           // what the overlay loads
  prepareRevision(fromWorkdir, toWorkdir): void;            // copy + fix embedded paths
}
```
- Core never mentions HyperFrames: presets, Kokoro, fonts and packets live under `pipelines/hyperframes-explainer/`.
- Scenes in one project must share a pipeline and format, so they stitch. A later version may allow mixing pipelines with re-encoding.

## 5. HTTP API (`/v1`, JSON, Bearer auth)
Errors are always `{"error":{"code":"…","message":"…","details":{}}}`. The OpenAPI spec is generated from the zod schemas and served at `GET /v1/openapi.json`.

| Method + path | Purpose |
|---|---|
| `GET /v1/health` | version, pipeline versions, skill versions, queue depth |
| `GET /v1/catalog?pipeline=` | pipelines and their options (replaces `/styles`) |
| `POST /v1/videos` | quick one-scene video → `{projectId, sceneId, jobId}` |
| `POST /v1/projects` · `GET /v1/projects` · `GET/PATCH/DELETE /v1/projects/:id` | projects |
| `POST /v1/projects/:id/scenes` · `PATCH/DELETE /v1/scenes/:id` | scenes (creating one queues a build unless `build:false`) |
| `POST /v1/scenes/:id/revise` `{instructions?, frames?, durationSec?}` | revise the current version → new version |
| `GET /v1/scenes/:id/versions` · `POST /v1/scenes/:id/current {version}` | history, rollback |
| `POST /v1/projects/:id/timeline` `{order, transitions?, bgm?}` | order and transitions |
| `POST /v1/projects/:id/stitch` | stitch job → `final.mp4` (+ `.vtt`) |
| `POST /v1/projects/:id/assets?name=&kind=&tags=` (raw body) · `GET` · `DELETE /v1/assets/:id` | assets |
| `GET /v1/jobs?state=&project=` · `GET /v1/jobs/:id` · `GET /v1/jobs/:id/events` · `GET /v1/jobs/:id/logs?tail=` | jobs |
| `POST /v1/jobs/:id/cancel` · `POST /v1/jobs/:id/approve` · `POST /v1/jobs/:id/retry` | control |
| `POST /v1/versions/:id/render` | render a preview version |

Every create call accepts `metadata` (≤ 4 KB), for example `{"platform":"telegram","chatId":"…"}`. It is echoed in every webhook for that job.

## 6. Webhooks → Hermes
- Target: a Hermes webhook route (`hermes webhook subscribe omp-video …`), with the platform enabled in the Hermes config. The bridge config holds `webhook.url` and `webhook.secret`.
- Signing: HMAC-SHA256 of the body. The header format must match what Hermes expects; check it before implementation.
- Delivery: at-least-once. Retries with backoff (10s, 1m, 5m, 30m) are persisted in `outbox`. Each event carries an `eventId` for dedupe.

| Event | When | Hermes handling |
|---|---|---|
| `job.started` | runner starts | deliver-only (optional, off by default) |
| `approval.required` | storyboard ready | agent + skill: send the preview and ask to approve/change |
| `version.published` | scene version ready | deliver-only: sheet + video, with ids |
| `job.failed` / `job.rejected` / `job.cancelled` | terminal | agent + skill: explain and offer the next step |
| `stitch.finished` | final.mp4 ready | deliver-only: final + project id |

Payload: `{eventId, type, at, job:{id,kind,state}, project:{id,name}, scene:{id,n,title}, version:{id,number,outputs}, error?, metadata}`. Paths are given both as host paths and as container paths (`/videos/…`).

## 7. Storage layout
- **SQLite** (`data/bridge.db`, WAL) is the source of truth: tables `projects, scenes, versions, assets, jobs, events, outbox`, with numbered SQL migrations.
- **Files**: `data/projects/<project>/`
  - `assets/<sha256-prefix>-<name>`, and `assets/found/SOURCES.md`
  - `scenes/<NN>-<slug>/v<k>/`: the pipeline workdir (the omp cwd, sessions, logs)
  - `scenes/<NN>-<slug>/current` → symlink to `v<k>/outputs`
  - `final/final.mp4`, `final/final.vtt`
- Hermes mounts `data/projects` read-only at `/videos`.
- Migration: a one-off script imports the v1 `omp-videos/*/job.json` and `projects/*` as projects, versions and jobs, then leaves the old dirs untouched.

## 8. Runner
- Concurrency is configurable (default 1). FIFO, with priority for cheap job kinds (stitch, render, captions revise).
- Spawns `omp -p --mode json --session-dir <workdir>/sessions --config <overlay> --cwd <workdir> [--continue] --max-time <m>` in its own process group. Cancel sends SIGTERM to the group, then SIGKILL after 10s.
- Streams stdout into the event log (message_end → usage and cost), and extracts the final JSON through `pipeline.parseResult`.
- On start, `running` jobs → `interrupted` → resume. Queued jobs keep their order.

## 9. Code layout
```
src/core/        entities, state machine, events (pure)
src/app/         use-cases (createVideo, addScene, revise, cancel, approve, stitch, publishVersion, resumeInterrupted)
src/ports/       Store, Runner, Pipeline, Notifier, Blob
src/adapters/    store-sqlite, runner-omp, notifier-webhook, blob-fs, stitch-ffmpeg
src/pipelines/hyperframes-explainer/  spec, catalog, prompts/*.md, result, revision, skills/ (omp-video-pipeline, worker-rules, scripts/)
src/http/        routes (thin), zod→openapi, errors, auth
src/config.ts    one TOML file (paths, host/port, models, limits, webhook) validated with zod
test/unit · test/integration (fake-omp binary emitting scripted JSON, tmp dirs, :memory: sqlite)
deploy/          systemd unit, install.sh (install unit, sync the Hermes skill, register the Hermes webhook)
docs/            SPEC.md, API (generated), CHANGELOG.md
hermes-skill/omp-video/   written against /v1 + catalog; no duplicated option lists
```
Stack: TypeScript on Node 22 (tsx for dev, tsc build), zod, better-sqlite3, node:http with a small router (no framework), vitest.

## 10. Skills
| Layer | Location | Rule |
|---|---|---|
| Hermes orchestration | `hermes-skill/omp-video` | Spec choice, API usage, identifying the video, delivery. Option lists come from `GET /v1/catalog` |
| Pipeline procedure | `pipelines/hyperframes-explainer/skills/omp-video-pipeline` | Phases (build/revise/resume/approve/render). Paths are injected via the prompt, never hard-coded |
| Worker rules | `…/skills/omp-video-worker-rules` | Only non-lintable rules. Each machine-checkable rule names its checker script |
| Tools | `…/skills/*/scripts` | Fixture-tested (the regressions seen so far: TDZ, track overlap, "medjulo", symlink main guard, off-canvas) |
| Upstream | `~/.agents/skills/*` | Never edited. Pinned `hyperframes@0.8.82`, and the version is reported by `/v1/health` |

Every skill has a `version` in its front-matter. `install.sh` fails if the version the Hermes skill expects does not match the bridge's `/v1/health`.

## 11. Milestones
1. Scaffold: config, SQLite and migrations, core state machine and tests, fake-omp.
2. Runner and the jobs API (build/cancel/resume/limits), plus the HyperFrames pipeline build.
3. Revise, versions and rollback; the preview/render split; approval.
4. Projects, scenes, assets, timeline, stitch (with transitions and bgm).
5. Webhooks and outbox, plus Hermes webhook registration and the skill rewrite.
6. v1 data migration, cutover (the unit points to v2), and live smoke tests: one video, one 2-scene project with a logo, one revision, one cancel, one crash-resume.

## 12. Open questions
- Hermes webhook header and signature format, and the port the gateway listens on (to be checked at M5).
- Whether stitch transitions should be crossfades (re-encode) or hard cuts (stream copy) by default.
- Retention: how long old version workdirs (sessions, frames) are kept, and whether to prune them.

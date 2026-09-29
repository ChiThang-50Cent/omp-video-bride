# Changelog

## v2.0.0 (unreleased)
Full rewrite in TypeScript. v1 (`server.mjs`) stays on `master` until cutover.

- Core job state machine (pure), SQLite store with migrations, `Pipeline` plugin port; HyperFrames explainer is the first pipeline.
- `/v1` API: videos, projects, scenes, versions (revise, rollback), assets (sha256 dedupe), timeline, stitch (ffmpeg, cut or 0.5 s crossfade), jobs (approve, cancel).
- Storyboard approval gate and cheap preview (`render:false`) with a native render job.
- Crash recovery: jobs `running` at startup are resumed with `omp --continue` (max 2), cost summed over all session files, limits per job.
- Webhooks: transactional outbox, HMAC `X-Webhook-Signature-V2`, backoff 10 s / 1 m / 5 m / 30 m, then dead.
- Skill paths are injected through the prompt; the skill lives with the pipeline (`src/pipelines/hyperframes-explainer/skills`).
- `tools/import-v1.ts` imports finished v1 jobs.

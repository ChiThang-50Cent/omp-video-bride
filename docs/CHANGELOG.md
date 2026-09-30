# Changelog

## v2.0.1

- Publish video, contact sheets, caption data and approval documents as `0644`, so Hermes can read the read-only bind mount under its own UID. Session/config files are unchanged.
- Hermes skill: authenticated bridge access, host-to-container path translation, explicit owner-granted per-route `terminal`/`file`/`skills`, and actual attachments via `/opt/hermes/bin/hermes send`. Sender warnings are treated as partial delivery, not success for every file.
- Live verification: storyboard gate stopped before audio/frames; reviewer notes applied on continuation; preview produced no MP4; native render produced a 20.47s H.264/AAC 1080p/30 video without LLM usage. Real completion replay sent MP4 and contact sheet to Telegram without warnings. The preview retained 11 contrast warnings.

## v2.0.0 (unreleased)
Full rewrite in TypeScript. The running service uses v2; v1 sources remain available in historical commit `068109c`.

- Core job state machine (pure), SQLite store with migrations, `Pipeline` plugin port; HyperFrames explainer is the first pipeline.
- `/v1` API: videos, projects, scenes, versions (revise, rollback), assets (sha256 dedupe), timeline, stitch (ffmpeg, cut or 0.5 s crossfade), jobs (approve, cancel).
- Storyboard approval gate and cheap preview (`render:false`) with a native render job.
- Crash recovery: jobs `running` at startup are resumed with `omp --continue` (max 2), cost summed over all session files, limits per job.
- Webhooks: transactional outbox, HMAC `X-Webhook-Signature-V2`, backoff 10 s / 1 m / 5 m / 30 m, then dead.
- Skill paths are injected through the prompt; the skill lives with the pipeline (`src/pipelines/hyperframes-explainer/skills`).
- `tools/import-v1.ts` imports finished v1 jobs.

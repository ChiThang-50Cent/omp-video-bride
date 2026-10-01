# Changelog

## 2.0.2 - 2026-09-30

- Document the public `omp-video-bride` repository spelling while retaining the `omp-video-bridge` package name, supported Node runtimes, isolated configuration quickstart, authenticated API examples, Docker entry point, maintenance, and security disclosure guidance.
- Replace the workstation-specific host unit with a safely rendered portable systemd template. `deploy/install.sh` provides schema/tool/secret preflight, non-mutating `--check-only` and `--print-unit`, and explicit service actions. Rendered units are exercised with systemd's parser and the actual configuration loader.
- Document default-ACL provisioning for a host's private umask when published artifacts are shared with a different UID. Isolated worker UID 1001/Hermes UID 10000 smoke demonstrated traversal failure without the ACL, readable published files after provisioning, and continued denial of a private file.
- Add stopped, absolute-path-only `deploy/backup.mjs` and non-overwriting `deploy/restore.mjs` for consistent SQLite plus artifact archives. Private backups validate/checkpoint SQLite and reject symlink/special trees; restore streams archive validation instead of imposing a 1 MiB listing cap. Add a permissions, upgrade/rollback, retention and recovery runbook.
- Fail closed on blank bearer tokens, require the Bearer prefix, validate job query limits/states, and add request correlation with structured unexpected-error logs. Health reports the package and registered pipeline versions. Configuration rejects relative data/token paths.
- Protect scene inputs during active project stitches, block deletion for interrupted work without a history-size cap, retain terminal audit events, preserve imported external files, and invalidate stale project outputs. Uploads with colliding names no longer overwrite prior assets; filesystem/database failures are compensated.
- Add Node 22/24 CI, dependency update automation, native API/HMAC HTTP/real FFmpeg/operations smoke commands, and a manual GHCR release workflow with digest references, SBOM and provenance.
- Publish the bridge source under the owner-selected Apache-2.0 license, with copyright NOTICE and license files included in the worker image.
- Provision FFmpeg/ffprobe explicitly on ephemeral GitHub CI and release-verification runners instead of relying on the runner image's installed tools.
- Use directly digest-pinned Ubuntu base declarations so Docker dependency automation detects the image. Keep Ubuntu 24.04 for the Python 3.12 runtime and manage this repository's internal runtime image through its build/release workflow.
- Verified locally: typecheck, 52 tests, native API/HMAC HTTP smoke, real FFmpeg full decode, 6,000-file backup/restore and installer unit parsing. Fresh worker/runtime/Hermes images built; isolated worker API/media and Hermes dependency smoke passed. Production dependencies reported zero npm audit vulnerabilities. No production rollout, paid model call or actual Telegram send was performed.

## 2.0.1 maintenance

- Use native Node.js TypeScript execution consistently for `npm start`, watch-mode `npm run dev`, and production. Remove unused `tsx` and emitted-build configuration; require Node.js >=22.20.0. Include import tools in typechecking.
- Integration test fixtures now stop their app, close SQLite and remove their temporary directories after each test.
- Keep the custom pipeline and Hermes `SKILL.md` files visible to Git despite the workstation's global ignore rule.
- Correct the deployment example to the host-loopback Hermes webhook URL. Replace the stale design draft with the actual API/runtime contract and an explicit list of retained design gaps.
- Verified: 35 tests, typecheck, isolated native start/watch health and catalog smoke checks. Production health remained OK; video data, DB, token and live configuration were not changed.

## v2.0.1

- Publish video, contact sheets, caption data and approval documents as `0644`, so Hermes can read the read-only bind mount under its own UID. Session/config files are unchanged.
- Hermes skill: authenticated bridge access, host-to-container path translation, explicit owner-granted per-route `terminal`/`file`/`skills`, and actual attachments via `/opt/hermes/bin/hermes send`. Sender warnings are treated as partial delivery, not success for every file.
- Live verification: storyboard gate stopped before audio/frames; reviewer notes applied on continuation; preview produced no MP4; native render produced a 20.47s H.264/AAC 1080p/30 video without LLM usage. Real completion replay sent MP4 and contact sheet to Telegram without warnings. The preview retained 11 contrast warnings.

## v2.0.0
Full rewrite in TypeScript. The running service uses v2; v1 sources remain available in historical commit `7634908`.

- Core job state machine (pure), SQLite store with migrations, `Pipeline` plugin port; HyperFrames explainer is the first pipeline.
- `/v1` API: videos, projects, scenes, versions (revise, rollback), assets (sha256 dedupe), timeline, stitch (ffmpeg, cut or 0.5 s crossfade), jobs (approve, cancel).
- Storyboard approval gate and cheap preview (`render:false`) with a native render job.
- Crash recovery: jobs `running` at startup are resumed with `omp --continue` (max 2), cost summed over all session files, limits per job.
- Webhooks: transactional outbox, HMAC `X-Webhook-Signature-V2`, backoff 10 s / 1 m / 5 m / 30 m, then dead.
- Skill paths are injected through the prompt; the skill lives with the pipeline (`src/pipelines/hyperframes-explainer/skills`).
- `tools/import-v1.ts` imports finished v1 jobs.

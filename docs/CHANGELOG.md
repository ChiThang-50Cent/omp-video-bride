# Changelog

## 0.3.0 - 2026-10-04 (Direct stack clean cutover)

- Execute approved clean cutover to sole direct architecture: Hermes → authenticated
  internal TCP (`omp-executor:9876`) → pinned OMP 18.4.4.
- Discontinue and remove the HTTP bridge (`/v1`), SQLite job store, transactional
  outbox, background scheduler, and host systemd installation. Former bridge state
  is preserved outside this repository and is not consumed by the direct stack.
- Retain the native RPC plugin (`omp-executor`) exposing 6 tools covering all 48
  pinned native OMP 18.4.4 RPC commands: `omp_sessions`, `omp_open`, `omp_rpc`,
  `omp_events`, `omp_respond`, and `omp_close`.
- Relocate retained production skills to canonical root `omp-skills/`
  (`omp-video-pipeline`, `omp-storybook-pipeline`, `create-static-assets`). Worker
  installs them at `/opt/omp-skills` discoverable alongside `/opt/skills`. Native
  internal workflow identities remain `hyperframes-explainer` and
  `hyperframes-storybook`.
- Introduce canonical direct production contract helper at
  `omp-skills/omp-video-pipeline/scripts/production-contract.mjs` (`node <helper> <absolute PROJECT_DIR> --input <absolute brief.json> [--update]`).
  Validates `pipeline`, `spec`, `durationSec`, `brief`, and `permissions`
  (`{createAssets:boolean, generateAudio:boolean, renderVideo:boolean}`). Refuses
  overwrite without `--update`, preserves existing fields (`revisionInstructions`,
  `changedFrames`, `approvalNotes`, `narrationSource`), and maintains approved
  narration baselines on update. Skills must honor permissions; changes requiring
  ungranted permissions escalate to Hermes/user.
- Establish canonical Hermes skills at `hermes-skill/omp-orchestrator/SKILL.md`
  (high-level planning, brief validation, permissions) and rewrite
  `hermes-skill/omp-video/SKILL.md` for direct RPC only (no HTTP bridge routes or
  compatibility modes). Hermes mounts both skills read-only at
  `/opt/data/skills/omp-orchestrator` and `/opt/data/skills/omp-video`.
- Canonical deployment uses `deploy/compose.yaml`, direct worker
  `deploy/Dockerfile.worker` (`omp-direct-executor:0.3.0`), Hermes
  `deploy/hermes/Dockerfile` (`omp-hermes-executor:0.3.0`), Hermes runtime base
  `deploy/hermes/Dockerfile.runtime` (`omp-hermes-runtime:2026.9.24-telegram`), and
  dependency base `deploy/Dockerfile.runtime` (`omp-runtime:18.4.4-hf0.8.82-cpu`).
  Discontinue `*.executor` Dockerfiles and Compose aliases.
- Use separate external state directory `OMP_DIRECT_STATE_DIR`, retaining existing
  bootstrap permissions (`init-executor.py`, shared secret token mode 0644 inside
  private 0700 secrets/, worker UID 1001, Hermes UID 10000).
- Preserve safety boundaries: no transport-driven paid task replay or budget watcher;
  exact session resume via `omp_open` requires a valid `session_id` or indexed
  `session_file` and never falls back to fresh or latest sessions; media
  acceptance fidelity remains unverified unless separately authorized.
- Verified the current checkout in isolated Docker: TypeScript plus 28 no-media
  integration tests, 40 transport/plugin regressions, native plugin doctor
  (6 tools / 2 hooks), and the real Hermes → TCP → OMP smoke exercising all
  48 native command kinds, exact session resume, interactive UI, background
  settlement, and finalization cleanup. Both Hermes skills and all three OMP
  skills were discovered and read through native runtime interfaces.
  No paid provider, Telegram, audio synthesis, or video render was invoked.
- Independent final runtime verification also exercised a real focused OMP child:
  it read an isolated fixture file, yielded its result to the main agent, and
  persisted its native child transcript. Production media fidelity remains
  outside the authorized no-media checks.

---

## Historical releases (Bridge v2 / v1)

The entries below record historical releases of the former HTTP bridge architecture,
retained for audit and historical context.

### Historical: 2.0.2 - 2026-09-30

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

### Historical: 2.0.1 maintenance

- Use native Node.js TypeScript execution consistently for `npm start`, watch-mode `npm run dev`, and production. Remove unused `tsx` and emitted-build configuration; require Node.js >=22.20.0. Include import tools in typechecking.
- Integration test fixtures now stop their app, close SQLite and remove their temporary directories after each test.
- Keep the custom pipeline and Hermes `SKILL.md` files visible to Git despite the workstation's global ignore rule.
- Correct the deployment example to the host-loopback Hermes webhook URL. Replace the stale design draft with the actual API/runtime contract and an explicit list of retained design gaps.

### Historical: v2.0.1

- Publish video, contact sheets, caption data and approval documents as `0644`, so Hermes can read the read-only bind mount under its own UID. Session/config files are unchanged.
- Hermes skill: authenticated bridge access, host-to-container path translation, explicit owner-granted per-route `terminal`/`file`/`skills`, and actual attachments via `/opt/hermes/bin/hermes send`. Sender warnings are treated as partial delivery, not success for every file.
- Live verification: storyboard gate stopped before audio/frames; reviewer notes applied on continuation; preview produced no MP4; native render produced a 20.47s H.264/AAC 1080p/30 video without LLM usage. Real completion replay sent MP4 and contact sheet to Telegram without warnings. The preview retained 11 contrast warnings.

### Historical: v2.0.0

Full rewrite in TypeScript. The running service uses v2; v1 sources remain available in historical commit `7634908`.

- Core job state machine (pure), SQLite store with migrations, `Pipeline` plugin port; HyperFrames explainer is the first pipeline.
- `/v1` API: videos, projects, scenes, versions (revise, rollback), assets (sha256 dedupe), timeline, stitch (ffmpeg, cut or 0.5 s crossfade), jobs (approve, cancel).
- Storyboard approval gate and cheap preview (`render:false`) with a native render job.
- Crash recovery: jobs `running` at startup can be recovered at most twice using the original session and time window; usage is summed over all session files and limits remain per job.
- Webhooks: transactional outbox, HMAC `X-Webhook-Signature-V2`, backoff 10 s / 1 m / 5 m / 30 m, then dead.
- Skill paths are injected through the prompt; the skill lives with the pipeline (`src/pipelines/hyperframes-explainer/skills`).
- `tools/import-v1.ts` imports finished v1 jobs.

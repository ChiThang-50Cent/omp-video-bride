# omp-direct-executor

`omp-direct-executor` provides direct Hermes orchestration to checksum-pinned
oh-my-pi (`omp`) over an authenticated internal TCP connection. Hermes directs
briefs, permissions, checkpoints, and session selection; OMP executes tasks as the
main agent and assigns narrowly scoped subagent roles.

This architecture replaces the former HTTP bridge, SQLite job queue, and
webhook outbox with direct RPC. Former bridge state is preserved outside this
repository and is not consumed by the direct stack.

The public repository is spelled **omp-video-bride** (without the second
`g`): <https://github.com/ChiThang-50Cent/omp-video-bride>. The package name is
`omp-direct-executor`.

## Architecture and boundaries

- **Sole transport:** Hermes communicates with OMP exclusively over an
  authenticated internal TCP socket (`omp-executor:9876`). There are no dual
  transport modes, HTTP routes, SQLite job schedulers, or fallback shims.
- **Hermes RPC plugin:** The `omp-executor` plugin exposes 6 tools covering all
  48 pinned OMP 18.4.4 RPC commands: `omp_sessions`, `omp_open`, `omp_rpc`,
  `omp_events`, `omp_respond`, and `omp_close`.
- **Hermes skills:** Canonical skills live in `hermes-skill/omp-orchestrator/SKILL.md`
  (high-level planning and delegation) and `hermes-skill/omp-video/SKILL.md`
  (video pipeline direction over RPC). Hermes mounts them read-only at
  `/opt/data/skills/omp-orchestrator` and `/opt/data/skills/omp-video`.
- **OMP internal skills:** Retained production skills live under `omp-skills/`
  (`omp-video-pipeline`, `omp-storybook-pipeline`, `create-static-assets`). The
  worker container installs them at `/opt/omp-skills` alongside upstream
  `/opt/skills`. Production workflow identifiers remain `hyperframes-explainer`
  and `hyperframes-storybook`.
- **Direct brief and production contract:** A standalone contract helper at
  `omp-skills/omp-video-pipeline/scripts/production-contract.mjs` validates
  briefs and creates `PROJECT_DIR/production-contract.json`:
  ```sh
  node omp-skills/omp-video-pipeline/scripts/production-contract.mjs <absolute PROJECT_DIR> --input <absolute brief.json> [--update]
  ```
  The helper validates `pipeline`, `spec`, `durationSec`, `brief`, and
  `permissions` (`{createAssets:boolean, generateAudio:boolean, renderVideo:boolean}`).
  It refuses to overwrite an existing contract unless `--update` is explicitly
  passed, preserving approved narration baselines and previous notes.
- **Exact session resume:** Hermes lists sessions with `omp_sessions` and
  resumes exact histories via `omp_open` (`mode: "resume"` with `session_id` or
  indexed `session_file`). Resume recovers the recorded worker working directory
  and saved model/thinking settings. Missing or corrupt histories fail; there is
  no automatic fallback to fresh sessions or newest IDs.
- **Artifacts and acceptance:** The worker task manually copies the complete
  project directory, including hidden `.hyperframes/`, to
  `$OMP_EXECUTOR_ARTIFACT_ROOT` (`/data/executor/artifacts/<project-name>`),
  validates machine acceptance on that published copy, and returns the exact
  bound video path (preview runs omit `--require-video`). Hermes accesses this
  directory read-only at `/artifacts/<project-name>`. Storybook acceptance
  requires a truthful `visual-review.json` based on actual inspection of real
  video and screenshot evidence by an operator or reviewing agent; fabricated or
  placeholder approvals are rejected.
- **Resource limits:** Limits are enforced directly by native OMP and configured
  model providers. There is no durable background scheduler, bridge budget
  watcher, or automatic paid-task resubmission.

## Pinned environment and images

| Component | Identifier / Pin | Description |
|---|---|---|
| Root package | `omp-direct-executor` 0.3.0 | Repository package and plugin manifest |
| Native OMP | `deploy/runtime-lock.json` → `versions.omp` | Binary and matching RPC client pins |
| Worker image | `omp-direct-executor:0.3.0` | Built from `deploy/Dockerfile.worker` |
| Hermes image | `omp-hermes-executor:0.3.0` | Built from `deploy/hermes/Dockerfile` |
| Hermes runtime base | `deploy/runtime-lock.json` → `versions.hermesSource` | Built from `deploy/hermes/Dockerfile.runtime` |
| Media dependency base | `deploy/Dockerfile.runtime` | Independent of OMP and Hermes versions |

## Verification and testing

Default verification runs in Docker against the current checkout, using the pinned
runtime environment:

```sh
# Isolated Hermes → TCP → OMP smoke with local deterministic fixture provider:
python3 tools/smoke-executor.py --docker
```

Build the dependency bases as described in [setup](docs/SETUP.md#3-build-dependency-runtime-and-application-images)
before running the smoke. The helper selects their lock-derived tags; the smoke
builds application images, not missing dependency bases.

`smoke-executor.py --docker` exercises Hermes tool discovery, session listing,
exact resume, all 48 native RPC command kinds, event streaming, and dialog side
channels using a local deterministic fixture. It performs pinned Docker build
network fetches, but makes no external model provider calls, sends no Telegram
messages, and performs no media rendering.

Run source checks in a dedicated pinned container with the current checkout:

```sh
(
  set -eu
  C=$(docker run --detach --rm --entrypoint /bin/sleep omp-direct-executor:0.3.0 infinity)
  trap 'docker stop --timeout 3 "$C" >/dev/null' EXIT
  WORK=$(docker exec "$C" mktemp -d /tmp/omp-source-check-XXXXXX)
  for path in package.json package-lock.json tsconfig.json omp-skills test tools; do
    docker cp "$path" "$C:$WORK/$path"
  done
  docker exec --workdir "$WORK" "$C" npm ci --ignore-scripts --no-audit --fund=false --cache /tmp/omp-check-npm-cache
  docker exec --workdir "$WORK" "$C" npm run check
)
```

`npm run check` typechecks and runs four no-media integration suites. Container
creation, dependency installation, and temporary cleanup require approval.

`npm test` runs the full test suite, which generates temporary audio fixtures and
requires explicit authorization.

Media smoke requires a dedicated pinned test container with provisioned assets
and a staged current checkout (`C` and `WORK` below), plus explicit authorization:

```sh
docker exec --workdir "$WORK" "$C" node tools/smoke-storybook.mjs
```

Media acceptance fidelity remains unverified unless separately authorized and
visually inspected.
## Deployment and operations

The stack is deployed via Docker Compose using `deploy/compose.yaml` with a
dedicated state directory (`OMP_DIRECT_STATE_DIR`) located outside the
checkout:

1. **Setup:** See [`docs/SETUP.md`](docs/SETUP.md) for initial state bootstrap,
   worker provider authentication (`omp login`), model configuration, and
   Hermes onboarding.
2. **Usage:** See [`docs/USAGE.md`](docs/USAGE.md) for session selection,
   the 6 Hermes tools, production brief workflows, and artifact retrieval.
3. **Operations:** See [`docs/OPS.md`](docs/OPS.md) for container lifecycle,
   stopped backup procedures, upgrades, and troubleshooting.
4. **Specification:** See [`docs/SPEC.md`](docs/SPEC.md) for the direct
   transport protocol, contract schema, and pipeline boundaries.
5. **Changelog:** See [`docs/CHANGELOG.md`](docs/CHANGELOG.md) for historical
   release records and the 0.3.0 direct cutover notes.

## Security and maintenance

- The internal TCP port (`9876`) binds only to the internal Compose bridge
  network and is never published to host interfaces.
- Credentials, tokens, and worker state are stored in `OMP_DIRECT_STATE_DIR` with
  restricted permissions (`0700` directories, `secrets/executor-token` mode `0644`
  inside private `0700` `secrets/` so both container UIDs can read their bind mounts).
- Never commit `.token`, provider credentials, or state files.
- For security vulnerability reports, use a private GitHub security advisory:
  <https://github.com/ChiThang-50Cent/omp-video-bride/security/advisories/new>.

## License

Licensed under [Apache-2.0](LICENSE).
Copyright 2026 Thang Nguyen Chi; see [NOTICE](NOTICE).
Third-party runtimes, dependencies, and upstream skills retain their respective
licenses.

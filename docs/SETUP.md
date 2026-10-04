# Deployment setup

This guide covers deployment and onboarding for the **direct Hermes-to-OMP
stack** via authenticated internal TCP.

The architecture eliminates the former HTTP bridge, SQLite job queue, and
webhook outbox. Former bridge state is preserved outside this repository and is
not consumed or migrated by the direct stack.

## Architecture overview

Hermes orchestrates briefs, permissions, checkpoints, and session selection. Pinned
oh-my-pi (`omp`) 18.4.4 executes tasks as the main agent, delegating focused
assignments to narrowly scoped subagents.

```text
+------------------------+              +------------------------------+
|         Hermes         |  Internal    |         OMP Worker           |
|                        |  TCP :9876   |                              |
|  omp-executor plugin   | ------------>|  omp --mode rpc-ui           |
|  (6 tools/48 commands) |  JSONL auth  |  (Main agent + subagents)    |
|                        |              |                              |
|  Skills:               |              |  Skills (/opt/omp-skills):   |
|  - omp-orchestrator    |              |  - omp-video-pipeline        |
|  - omp-video (RPC)     |              |  - omp-storybook-pipeline    |
|                        |              |  - create-static-assets      |
|  Mount: /artifacts <---+--------------+-- Publishes: /data/executor/ |
|         (read-only)    |              |              artifacts       |
+------------------------+              +------------------------------+
```

- **Single transport:** Private authenticated TCP over port 9876 between
  containers. No host port is published; no HTTP endpoints exist.
- **Hermes RPC plugin:** Exposes 6 tools (`omp_sessions`, `omp_open`, `omp_rpc`,
  `omp_events`, `omp_respond`, `omp_close`) granting access to all 48 pinned
  native OMP 18.4.4 commands.
- **Hermes skills:**
  - `hermes-skill/omp-orchestrator/SKILL.md`: High-level workflow orchestration,
    contract creation, and permission boundaries.
  - `hermes-skill/omp-video/SKILL.md`: Video pipeline direction over native RPC.
  Mounted read-only into Hermes at `/opt/data/skills/omp-orchestrator` and
  `/opt/data/skills/omp-video`.
- **Internal OMP skills:** Canonical skills reside under `omp-skills/`
  (`omp-video-pipeline`, `omp-storybook-pipeline`, `create-static-assets`).
  Installed at `/opt/omp-skills` in the worker, alongside `/opt/skills`.
  Production workflow IDs remain `hyperframes-explainer` and
  `hyperframes-storybook`.
- **Permissions and direct brief:**
  Workflow contracts are governed by `PROJECT_DIR/production-contract.json`,
  created and updated using:
  ```sh
  # On host / source checkout:
  node omp-skills/omp-video-pipeline/scripts/production-contract.mjs <absolute PROJECT_DIR> --input <absolute brief.json> [--update]

  # Inside worker container:
  node /opt/omp-skills/omp-video-pipeline/scripts/production-contract.mjs <absolute PROJECT_DIR> --input <absolute brief.json> [--update]
  ```
  The brief requires: `pipeline`, `spec`, `durationSec`, `brief`, and
  `permissions` (`{createAssets:boolean, generateAudio:boolean, renderVideo:boolean}`).
  Skills must strictly honor these permissions. Any change requiring new
  permissions escalates to Hermes and the user; no implicit approvals are made.
- **Exact session resume:** Hermes discovers sessions via `omp_sessions` and
  resumes exact histories via `omp_open` (`mode: "resume"` with `session_id` or
  `session_file`). Missing, corrupt, or ambiguous selectors fail; they never
  fall back to fresh sessions.
- **Resource limits:** Limits are native to OMP and provider accounts. There is
  no durable job scheduler, budget watcher, or automatic paid-task resubmission.

## Pinned components and images

| Component | Source / Dockerfile | Canonical Image Tag |
|---|---|---|
| Root package | `package.json` | `omp-direct-executor` 0.3.0 |
| OMP binary | `deploy/runtime-lock.json` → `versions.omp` | Installed by the worker's separate pinned binary stage |
| Media runtime dependency | `deploy/Dockerfile.runtime` | Derived by `deploy/runtime-pins.py`; independent of OMP/Hermes |
| Pinned Hermes base | `deploy/hermes/Dockerfile.runtime` | Derived from immutable Hermes source pins |
| Direct worker | `deploy/Dockerfile.worker` | `omp-direct-executor:0.3.0` |
| Hermes service | `deploy/hermes/Dockerfile` | `omp-hermes-executor:0.3.0` |

## State directory layout

The stack requires an external state directory (`OMP_DIRECT_STATE_DIR`) located
**outside** the checkout repository. Do not reuse old bridge directories.

```text
$OMP_DIRECT_STATE_DIR/
  secrets/
    executor-token       # shared secret file (mode 0644 inside private 0700 directory)
  omp-state/             # worker .omp state, credentials, native sessions (UID 1001)
  executor/
    workspaces/          # worker workspaces and managed session logs
    artifacts/           # published outputs (mounted read-only in Hermes at /artifacts)
  hermes/                # Hermes auth, config, conversation history (UID 10000)
  assets/                # optional media runtime assets (Kokoro, Whisper, Chrome)
  font-cache/            # stage-fonts cache
```

Worker state is owned by UID 1001; Hermes state by UID 10000.

## Step-by-step onboarding

### 1. Prerequisites

- Linux/amd64 Docker Engine with BuildKit and Compose v2.
- Host Bash, Git, Python 3.12 or newer, curl, and jq.
- Model provider credentials (API key or OAuth account).
- An isolated Telegram bot token (if deploying the Telegram gateway).

### 2. Prepare environment and checkout

```bash
export OMP_DIRECT_REPO="$HOME/code/omp-video-bridge"
export OMP_DIRECT_STATE_DIR="$HOME/.local/state/omp-direct-executor"
export COMPOSE_PROJECT_NAME=omp-direct-executor

mkdir -p "$HOME/code"
cd "$OMP_DIRECT_REPO"

# Helper for docker compose commands using the canonical compose file
dc() { docker compose -p "$COMPOSE_PROJECT_NAME" -f "$OMP_DIRECT_REPO/deploy/compose.yaml" "$@"; }
```

### 3. Build dependency runtime and application images

Canonical base images are not automatically available on a fresh Docker host.
Derive tags and build arguments from the checked-in locks before building:

```bash
PIN_ENV="$(mktemp)"
python3 deploy/runtime-pins.py --format env > "$PIN_ENV"
set -a
. "$PIN_ENV"
set +a

docker build -f deploy/Dockerfile.runtime -t "$WORKER_RUNTIME_IMAGE" \
  --build-arg NODE_VERSION --build-arg HYPERFRAMES_VERSION .
docker build -f deploy/hermes/Dockerfile.runtime -t "$HERMES_BASE_IMAGE" \
  --build-arg HERMES_COMMIT --build-arg HERMES_ARCHIVE_SHA256 \
  --build-arg SQLITE_AUTOCONF_VERSION --build-arg SQLITE_SHA256 \
  --build-arg SQLITE_VERSION .
```

The metadata helper validates the coupled OMP/RPC locks and filtered media lock.
An OMP/Hermes-only update does not change the media lock or media image tag.
Environment overrides may select already-tested image digests; never alias an
old OMP-containing runtime as the new media base.

Next, build the worker and Hermes application images:

```bash
dc build omp-executor hermes
```

### 4. Bootstrap isolated state

Now that the worker image (`omp-direct-executor:0.3.0`) is built, initialize the
state directory structure, file permissions, and shared secret:

```bash
install -d -m 700 "$OMP_DIRECT_STATE_DIR"
dc --profile bootstrap run --rm init-state
```

`init-state` seeds private external directories (`0700`), generates
`secrets/executor-token` (mode `0644` inside private `0700` `secrets/` so both
container UIDs can read it), and prepares persistent Hermes configuration.
It preserves existing configuration on rerun.

### 5. Start worker and authenticate OMP

Start the worker service:

```bash
dc up -d --wait omp-executor
```

Authenticate worker OMP with your provider:

```bash
# Interactive OAuth login (e.g., github, anthropic, openai)
dc exec omp-executor omp login <provider>

# Or verify available models
dc exec omp-executor omp models
```

Provider credentials are saved in the private `$OMP_DIRECT_STATE_DIR/omp-state`
directory (never committed).

### 6. Verify Hermes plugin discovery

Verify that Hermes discovers the `omp-executor` plugin and the mounted skills:

```bash
dc run --rm --no-deps hermes plugins doctor /opt/data/plugins/omp-executor --ci
```

### 7. Configure Hermes and start stack

Configure the model for Hermes:

```bash
dc run --rm --no-deps hermes model
```

If connecting to Telegram, configure bot credentials in Hermes's private state,
then launch the full stack:

```bash
dc up -d hermes
dc ps
```

## Media assets provisioning (optional)

For video and audio generation pipelines (`hyperframes-explainer` and
`hyperframes-storybook`), provision pinned media runtime assets:

```bash
dc --profile media run --rm init-assets
dc exec omp-executor python3.12 /opt/direct-executor/prepare-assets.py --check /assets
```

This validates the pinned Kokoro TTS models, Whisper models, and headless Chrome
binary. General OMP executor tasks do not require media asset provisioning.

## Verification

### Isolated fixture smoke (no external model, Telegram, or media)

Verify Hermes discovery, TCP transport, and all 48 native RPC commands using an
isolated deterministic mock provider:

```bash
python3 tools/smoke-executor.py --docker
```

This runs a complete end-to-end smoke test verifying session cataloging, exact
resume, live settings, side channels, events streaming, and error handling.
The Docker build performs pinned network dependency fetches, but makes no
external model provider calls, sends no Telegram messages, and performs no media
rendering.

For repository unit/contract checks, use the dedicated pinned-container
procedure in [README.md — Verification and testing](../README.md#verification-and-testing).
It copies the current package/lock/config and source/test/tool trees before
running `npm ci` and `npm run check`; do not substitute an unsupported host Node.

`npm test` runs the full test suite, which generates temporary audio fixtures and
requires explicit authorization.

### Authorized media smoke and acceptance

To verify the storybook pipeline, provision assets in a dedicated test container,
stage the current checkout there, and obtain explicit rendering authorization.
Here `C` is that container and `WORK` is its staged absolute source directory:

```bash
docker exec --workdir "$WORK" "$C" node tools/smoke-storybook.mjs
```

The worker task manually copies the complete project directory, including hidden
`.hyperframes/`, to `$OMP_EXECUTOR_ARTIFACT_ROOT` (`/data/executor/artifacts/<project-name>`),
validates machine acceptance on that published copy, and returns the exact
bound video path (preview runs omit `--require-video`). Hermes accesses this
directory read-only at `/artifacts/<project-name>`.

Machine acceptance is validated via:

```bash
# Inside worker container:
node /opt/omp-skills/omp-storybook-pipeline/scripts/acceptance.mjs "$PROJECT_DIR" --require-video

# Or from source checkout:
node omp-skills/omp-storybook-pipeline/scripts/acceptance.mjs "$PROJECT_DIR" --require-video
```

Media acceptance fidelity remains unverified until actual visual evidence
(contact sheets, screenshots, video) is inspected by an operator or reviewing
agent and a truthful `visual-review.json` is recorded (no fabricated approvals).

See [`docs/USAGE.md`](USAGE.md) for workflow details and
[`docs/OPS.md`](OPS.md) for maintenance and recovery.

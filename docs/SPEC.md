# omp-direct-executor v0.3.0 — System specification

This specification defines the architecture, transport protocol, tool contracts,
skills hierarchy, and acceptance criteria for **omp-direct-executor**.

The former HTTP bridge, SQLite job state machine, and webhook outbox are
discontinued. Former bridge state is preserved outside this repository and is
not consumed or migrated by the direct stack.

## 1. System architecture

The system establishes direct orchestration between Hermes and pinned oh-my-pi
(`omp`) 18.4.4:

```text
+-------------------------------------------------------------+
|                           Hermes                            |
|                                                             |
|  - Skills: omp-orchestrator, omp-video (RPC only)           |
|  - Plugin: omp-executor (6 tools / 48 native RPC commands)  |
|  - Mounts: /artifacts (read-only)                           |
+-------------------------------------------------------------+
                              │
                    Internal TCP :9876
                    JSONL Authentication
                              ▼
+-------------------------------------------------------------+
|                         OMP Worker                          |
|                                                             |
|  - Runtime: omp 18.4.4 --mode rpc-ui                        |
|  - Internal skills (/opt/omp-skills):                       |
|    - omp-video-pipeline                                     |
|    - omp-storybook-pipeline                                 |
|    - create-static-assets                                   |
|  - Workflows: hyperframes-explainer, hyperframes-storybook  |
|  - Output root: /data/executor/artifacts                    |
+-------------------------------------------------------------+
```

### Core boundaries

- **Single transport:** Private authenticated TCP over port 9876 between
  containers within the Docker Compose network. No external HTTP API or host port
  binding exists.
- **Role separation:** Hermes manages user interaction, project briefs,
  permissions, and session selection. OMP main agent plans and executes tasks,
  delegating focused tasks to narrowly scoped subagents.
- **No durable scheduler:** In-flight execution terminates on container stop or
  disconnect. Session files persist on disk, enabling exact resume on restart.
  There is no automatic resubmission of paid model tasks.

## 2. Transport and authentication protocol

Hermes connects to `omp-executor:9876` via an internal stdio/TCP tunnel.

### Connection handshake

1. **Catalog request:**
   ```json
   {"type": "sessions", "token": "<secret>", "offset": 0, "limit": 50}
   ```
   The worker returns a paginated list of valid regular JSONL session files from
   managed workspaces and native session trees, then closes the connection.

2. **Connect request:**
   ```json
   {
     "type": "connect",
     "token": "secret-token-hex",
     "executor": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
     "mode": "resume",
     "session_id": "session-20261003-example"
   }
   ```
   *(Alternatively, `mode: "new"` with optional `cwd`, `model`, and `thinking`).*
   - Worker verifies the shared secret in constant time.
   - `mode: "new"` initializes a new session, optionally with an explicit worker
     working directory (`cwd`).
   - `mode: "resume"` requires an exact indexed `session_id` or `session_file`.
     It restores the recorded working directory and saved model/thinking settings
     unless explicitly overridden. Missing or ambiguous selectors fail immediately;
     there is no automatic fallback to fresh or latest sessions.

3. **Handshake response:**
   ```json
   {"type": "connected", "executor": "<digest>", "workdir": "<path>", "resumed": true, "session_file": "<path>"}
   ```
   Or on error:
   ```json
   {"type": "transport_error", "error": "<message>"}
   ```

4. **Workspace locking:** The worker acquires a canonical-cwd lock across executor
   identities, rejecting concurrent RPC sessions targeting the same workspace.

5. **Bidirectional relay:** Once connected, the connection transparently relays
   raw OMP RPC frames and chunked streams.

## 3. Hermes plugin and tool contract

The `omp-executor` plugin exposes 6 tools covering all 48 pinned native OMP 18.4.4
commands:

| Tool | Parameters | Contract |
|---|---|---|
| `omp_sessions` | `offset?: number`, `limit?: number` (1–100) | Scans workspace and native session trees; returns session metadata, cwd, and timestamps. |
| `omp_open` | `mode: "new" \| "resume"`, `executor?: string`, `session_id?: string`, `session_file?: string`, `cwd?: string`, `model?: string`, `thinking?: string` | Opens session channel. `mode: "resume"` requires exact ID/file. Rejects corrupt or ambiguous targets. |
| `omp_rpc` | `command: string`, `params?: object`, `executor?: string` | Dispatches native OMP RPC command asynchronously. Returns `request_id` and `submitted: true`. |
| `omp_events` | `executor?: string`, `after?: number`, `limit?: number` (≤ 1000) | Non-destructive monotonically sequenced replay ring buffer (5000 frames) with gap reporting. Exposes `turn_active`, `session_settled`, and `pending_requests`. |
| `omp_respond` | `response: object`, `executor?: string` | Answers interactive UI side-channels (`extension_ui_response`), host-tool updates/results, and host-URI reads/writes. Enforces strict types and booleans. |
| `omp_close` | `executor?: string` | Gracefully closes connection and shuts down OMP process group. Workspaces and history persist. |

*Note: The native `get_available_commands` RPC command lists active extension,
prompt, and skill commands registered in the current session; it does not list
the complete set of 48 underlying native protocol methods exposed by `omp_rpc`.*
## 4. Skills and subagents hierarchy

### Hermes skills

Mounted read-only into Hermes at `/opt/data/skills/`:
- **`omp-orchestrator`** (`hermes-skill/omp-orchestrator/SKILL.md`): Top-level
  planning, brief compilation, permissions verification, and session governance.
- **`omp-video`** (`hermes-skill/omp-video/SKILL.md`): Direct video production
  workflow via native RPC, governing storyboard reviews, asset checks, and render
  checkpoints.

### Internal OMP skills

Located in canonical repo root `omp-skills/` and installed in the worker at
`/opt/omp-skills`:
- **`omp-video-pipeline`**: HyperFrames explainer logic, prompt composition, and
  contract helpers.
- **`omp-storybook-pipeline`**: 2D storybook direction, character/background
  image consistency, whole-character slide/tilt motion, and acceptance validation.
- **`create-static-assets`**: Coherent character and background generation,
  browser still preview review, and asset reuse.

Production workflow identifiers remain `hyperframes-explainer` and
`hyperframes-storybook`.

### Subagent delegation

The OMP main agent plans and executes the primary workflow. Subagents are
dispatched only for narrowly scoped assignments (e.g., character sketch
generation, caption timing inspection). Subagents inherit caller configuration
and do not bypass workflow permissions.

## 5. Direct brief and production contract

Workflow execution is governed by `PROJECT_DIR/production-contract.json`,
generated via the canonical CLI helper:

```sh
# Inside worker container:
node /opt/omp-skills/omp-video-pipeline/scripts/production-contract.mjs <absolute PROJECT_DIR> --input <absolute brief.json> [--update]

# Or from host / source checkout:
node omp-skills/omp-video-pipeline/scripts/production-contract.mjs <absolute PROJECT_DIR> --input <absolute brief.json> [--update]
```

### Brief input schema

```json
{
  "pipeline": "hyperframes-storybook",
  "spec": {
    "style": "storybook-flat",
    "format": "landscape",
    "voice": "am_michael",
    "audience": "families",
    "tone": "warm, gentle, character-led",
    "narrationMode": "verbatim",
    "music": "required"
  },
  "durationSec": 15,
  "brief": "Detailed prompt describing the narrative and visual scenes.",
  "permissions": {
    "createAssets": true,
    "generateAudio": false,
    "renderVideo": false
  }
}
```

### Brief schema fields

- **`pipeline`**: Required string (`"hyperframes-storybook"` or `"hyperframes-explainer"`).
- **`spec.format`**: Optional string (`"landscape"`, `"portrait"`, `"square"`; default `"landscape"`).
- **`spec.style`**: Optional string (`"storybook-flat"` for storybook; non-empty string for explainer, default `"auto"`).
- **`spec.voice`**: Optional Kokoro English voice (default `"am_michael"`).
- **`spec.audience`**: Optional string ≤200 characters (default storybook: `"families"`, explainer: `"developers"`).
- **`spec.tone`**: Optional string ≤200 characters (default storybook: `"warm, gentle, character-led"`, explainer: `"clear, friendly, technical"`).
- **`spec.narrationMode`**: Optional string (`"verbatim"`, `"restructured"`; default storybook: `"verbatim"`, explainer: `"restructured"`).
- **`spec.music`**: Optional string (`"required"`, `"none"`; default storybook: `"required"`, explainer: `"none"`).
- **`durationSec`**: Required positive finite number.
- **`brief`**: Required non-empty brief text.
- **`permissions`**: Required object with boolean flags: `createAssets`, `generateAudio`, `renderVideo`.
### Safety and lifecycle rules

- **Overwrite refusal:** The helper refuses to overwrite an existing
  `production-contract.json` without the explicit `--update` flag.
- **Preservation on update:** Explicit new values in the brief input win.
  Otherwise, existing fields are preserved: `revisionInstructions` (default `""`),
  `changedFrames` (default `[]`), `approvalNotes` (default `""`), and
  `narrationSource` (explicit new wins, otherwise existing preserved, otherwise
  captures from `SCRIPT.md` if verbatim). Unchanged approved narration baselines
  are retained rather than regenerated.
- **Permissions enforcement:** Skills must strictly respect the granted
  permissions. Work requiring ungranted permissions (e.g., audio synthesis when
  `generateAudio: false`) must pause and escalate to Hermes/user.
- **Operational scope:** The contract helper acts as an orchestration boundary,
  not an operating system sandbox or billing monitor.

## 6. Artifacts publishing and machine acceptance

### Output locations and artifact publishing

Artifact publishing is **manual by the worker task/OMP**, not an automatic daemon
copy. When rendering completes:

1. The worker task copies the complete project directory, **including hidden
   `.hyperframes/`**, to:
   ```text
   $OMP_EXECUTOR_ARTIFACT_ROOT = /data/executor/artifacts/<project-name>/
   ```
2. Machine acceptance validation is run directly on that published copy:
   ```sh
   node /opt/omp-skills/omp-storybook-pipeline/scripts/acceptance.mjs /data/executor/artifacts/<project-name> [--require-video]
   ```
   *(Preview runs omit `--require-video`).*
3. The task returns the exact bound video path from the published directory.

Hermes accesses this directory read-only at:

```text
/artifacts/<project-name>/
```

### Acceptance validation

Acceptance enforces:
1. Valid `storybook.json` matching the production contract.
2. Verified character and recurring background image assets.
3. Accurate audio alignment, speech bounds, and caption cue coverage.
4. Frame alignment and motion stability across all shots.
5. Presence of a truthful `visual-review.json` recorded after actual inspection
   of real video and screenshot evidence by an operator or reviewing agent.
   Fabricated approvals are rejected.
## 7. Deployment and runtime pins

### Canonical Docker configuration

- **Compose file:** `deploy/compose.yaml`
- **Worker image:** `omp-direct-executor:0.3.0` (built from `deploy/Dockerfile.worker`)
- **Hermes image:** `omp-hermes-executor:0.3.0` (built from `deploy/hermes/Dockerfile`)
- **Hermes runtime base:** Derived from the immutable source commit in `deploy/runtime-lock.json`; built from `deploy/hermes/Dockerfile.runtime`.
- **Media runtime dependency:** Derived from filtered media pins; built from `deploy/Dockerfile.runtime`, without OMP. `deploy/runtime-pins.py` emits build tags/arguments and validates the locks.

### External state layout

State lives in `$OMP_DIRECT_STATE_DIR`:

```text
  secrets/
    executor-token       # shared secret (mode 0644 inside private 0700 directory)
  omp-state/                   # worker credentials, sessions (UID 1001)
  executor/workspaces/         # OMP workspaces and session logs (UID 1001)
  executor/artifacts/          # published deliverables
  hermes/                      # Hermes auth and conversation history (UID 10000)
  assets/                      # optional media runtime assets
  font-cache/                  # stage-fonts cache
```

## 8. Resource limits and failure semantics

- **Native enforcement:** Context window limits, model timeouts, and API rate
  limits are handled natively by OMP and the configured provider.
- **No transport replay:** The plugin and TCP transport never resubmit failed
  or interrupted tasks. Hermes inspects the error before deliberate continuation.
  Native in-turn retries remain controlled by OMP settings (`set_auto_retry`);
  this is distinct from reconnecting or replaying a completed/interrupted task.
- **Process isolation:** Disconnecting or terminating the container boundedly
  cleans up the worker process group without corrupting on-disk session files.

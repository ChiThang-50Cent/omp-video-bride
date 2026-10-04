# Direct executor usage guide

This guide covers Hermes orchestration of pinned oh-my-pi (`omp`) 18.4.4 over the
direct internal TCP transport.

The former HTTP bridge, SQLite job store, and webhook outbox are removed. Hermes
directs tasks directly via the `omp-executor` plugin, managing permissions,
briefs, and checkpoints. OMP executes tasks as the main agent, delegating focused
tasks to subagents.

## Core interaction model

Hermes communicates with OMP inside the Docker Compose network over internal TCP
port 9876.

```text
Hermes Conversation
  │
  ├─> 1. omp_sessions: inspect available owner-wide sessions
  ├─> 2. omp_open: open new session or resume exact session ID/file
  ├─> 3. omp_rpc: submit commands (prompt, get_state, set_model, etc.)
  ├─> 4. omp_events: stream events and poll for settlement
  ├─> 5. omp_respond: answer interactive confirmations or host tool requests
  └─> 6. omp_close: gracefully disconnect when finished
```

## Hermes `omp-executor` tools

The plugin exposes 6 tools covering all 48 pinned native OMP 18.4.4 RPC commands:

| Tool | Arguments | Description |
|---|---|---|
| `omp_sessions` | `offset` (optional, default 0), `limit` (optional, 1–100, default 50) | List owner-visible sessions across workspaces, ordered newest first, with `session_id`, `session_file`, `cwd`, and timestamps. |
| `omp_open` | `mode` (required: `"new"` or `"resume"`), `executor` (optional, default `"default"`), `session_id` (optional), `session_file` (optional), `cwd` (optional), `model` (optional), `thinking` (optional) | Connect to OMP. `mode: "new"` starts a fresh session; `mode: "resume"` resumes an exact session ID or file. |
| `omp_rpc` | `command` (required), `params` (optional), `executor` (optional) | Submit any pinned native OMP command asynchronously. Returns `request_id` and `submitted: true`. |
| `omp_events` | `executor` (optional), `after` (optional cursor), `limit` (optional, up to 1000) | Replay native event stream sequentially. Provides active side-channel requests and settlement state. |
| `omp_respond` | `response` (required object), `executor` (optional) | Answer active UI prompts (confirmations, choices, input) or host-tool requests. |
| `omp_close` | `executor` (optional) | Close connection and stop the active OMP process. Session history remains durable. |

*Note: The native `get_available_commands` RPC command lists active extension,
prompt, and skill commands registered in the current session; it does not list
the complete set of 48 underlying native protocol methods exposed by `omp_rpc`.*

### Logical executors and scoping

The `executor` argument specifies a logical channel (such as `"default"` or
`"review"`). Handles are scoped to the Hermes conversation plus the executor name,
preventing cross-conversation collisions. Session history itself is owner-wide:
any Hermes conversation may explicitly resume an existing session by ID.

## Session management and exact resume

### Listing sessions

```json
{
  "offset": 0,
  "limit": 20
}
```

The response includes an array of sessions with `session_id`, `session_file`,
`name`, `cwd`, and `modified_at`.

### Starting a new session

```json
{
  "mode": "new",
  "cwd": "/data/executor/workspaces/project-alpha"
}
```

### Exact session resume

To continue previous work:

```json
{
  "mode": "resume",
  "session_id": "session-20261003-example"
}
```

**Resumption rules:**
- `mode: "resume"` requires an exact `session_id` or indexed `session_file`.
- Corrupt, missing, or ambiguous session references fail immediately.
- There is **no automatic fallback** to a new session or the most recent session.
- Resume restores the recorded worker working directory and saved model/thinking
  settings unless explicit overrides are passed.

## Executing tasks and streaming events

### 1. Sending a prompt

```json
{
  "command": "prompt",
  "params": {
    "message": "Review PROJECT_DIR/production-contract.json and generate initial character sketches."
  }
}
```

OMP returns `{ "request_id": "req-001", "submitted": true }`.
### 2. Streaming events and polling settlement

Hermes streams execution progress by calling `omp_events` with the returned cursor:

```json
{
  "after": 0,
  "limit": 100
}
```

Replay records include the native event stream (`message_chunk`, `tool_call`,
`agent_end`, `prompt_result`).

- `session_settled: true` indicates OMP has finished all queued and background tasks.
- Authoritative state can be queried at any time using `get_state`.
- If `prompt_result` reports an error, Hermes inspects the error and decides next
  steps; there is no automatic paid retry.

### 3. Handling interactive confirmations

If OMP pauses for confirmation, the request appears in `pending_requests` inside
`omp_events`. Hermes answers using `omp_respond`:

```json
{
  "response": {
    "type": "extension_ui_response",
    "id": "ui-prompt-001",
    "confirmed": true
  }
}
```

Confirmations require strict booleans (`true` or `false`). Coerced string values
are rejected.

## Direct brief and production contracts

For video and storybook pipelines (`hyperframes-explainer` and
`hyperframes-storybook`), work begins with a structured brief and explicit
permissions.

### Contract helper

The canonical production contract helper validates briefs and creates or updates
`PROJECT_DIR/production-contract.json`:

```sh
# Inside worker container:
node /opt/omp-skills/omp-video-pipeline/scripts/production-contract.mjs <absolute PROJECT_DIR> --input <absolute brief.json> [--update]

# Or from host / source checkout:
node omp-skills/omp-video-pipeline/scripts/production-contract.mjs <absolute PROJECT_DIR> --input <absolute brief.json> [--update]
```

### Input brief format

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
  "brief": "A traveler encounters a mysterious cottage in a quiet forest.",
  "permissions": {
    "createAssets": true,
    "generateAudio": false,
    "renderVideo": false
  }
}
```

### Brief schema and configuration fields

| Field | Type | Description |
|---|---|---|
| `pipeline` | string | Required: `"hyperframes-storybook"` or `"hyperframes-explainer"`. |
| `spec.format` | string | Optional: `"landscape"` (1920x1080), `"portrait"` (1080x1920), or `"square"` (1080x1080). Default: `"landscape"`. |
| `spec.style` | string | Optional: `"storybook-flat"` for storybook; non-empty string for explainer (default `"auto"`). |
| `spec.voice` | string | Optional Kokoro English voice (e.g. `"am_michael"`, `"af_heart"`). Default: `"am_michael"`. |
| `spec.audience` | string | Optional target audience description (≤200 characters). Default storybook: `"families"`, explainer: `"developers"`. |
| `spec.tone` | string | Optional tone guidance (≤200 characters). Default storybook: `"warm, gentle, character-led"`, explainer: `"clear, friendly, technical"`. |
| `spec.narrationMode` | string | Optional: `"verbatim"` or `"restructured"`. Default storybook: `"verbatim"`, explainer: `"restructured"`. |
| `spec.music` | string | Optional: `"required"` or `"none"`. Default storybook: `"required"`, explainer: `"none"`. |
| `durationSec` | number | Required: positive finite number. |
| `brief` | string | Required: non-empty brief prompt describing narrative and visuals. |
| `permissions` | object | Required booleans: `createAssets`, `generateAudio`, `renderVideo`. |

### Contract enforcement and safety boundaries

- **Permissions:** `{createAssets: boolean, generateAudio: boolean, renderVideo: boolean}`
  strictly govern pipeline execution.
- **Overwrite protection:** The helper refuses to overwrite an existing contract
  unless `--update` is explicitly provided.
- **Preservation on update:** Explicit new values in the brief input win.
  Otherwise, existing fields are preserved: `revisionInstructions` (default `""`),
  `changedFrames` (default `[]`), `approvalNotes` (default `""`), and
  `narrationSource` (explicit new wins, otherwise existing preserved, otherwise
  captures from `SCRIPT.md` if verbatim). Unchanged approved narration baselines
  are retained rather than regenerated.
- **Skills compliance:** Internal skills must honor these permissions. If a
  pipeline reaches a stage requiring ungranted permissions (e.g., rendering video
  when `renderVideo: false`), it stops and requests permission from Hermes/user.
- **Not a security sandbox:** The helper is an orchestration checkpoint, not an
  isolated security sandbox, durable job machine, or billing watcher.

## Artifacts and acceptance validation

### Artifact publishing

Artifact publishing is **manual by the worker task/OMP**, not an automatic
daemon copy. When a project is rendered or previewed:

1. The worker task copies the complete project directory, **including the hidden
   `.hyperframes/` directory**, to:
   ```text
   $OMP_EXECUTOR_ARTIFACT_ROOT = /data/executor/artifacts/<project-name>/
   ```
2. Machine acceptance validation is run directly on the published copy:
   ```sh
   node /opt/omp-skills/omp-storybook-pipeline/scripts/acceptance.mjs /data/executor/artifacts/<project-name> [--require-video]
   ```
   *(Preview runs omit `--require-video`).*
3. The task returns the exact bound video path from the published directory.

Hermes mounts this artifact tree read-only at:

```text
/artifacts/<project-name>/
```

### Storybook acceptance validation

Machine acceptance requires:
1. Valid storybook manifest (`storybook.json`) and source contracts.
2. Verified character and recurring background images.
3. Audio alignment, narration timing, and caption cue coverage.
4. Frame alignment and motion bounds across all shots.
5. Presence of a truthful `visual-review.json` recorded after actual inspection
   of real video and screenshot evidence by an operator or reviewing agent.

Fabricating approval files without inspecting real evidence is strictly prohibited.
## Resource limits and boundaries

- **Native limits:** OMP executes commands within its native context. Model
  quotas, context windows, and rate limits are reported directly by OMP and the
  model provider.
- **No durable scheduler:** Disconnecting or stopping containers terminates
  in-flight execution processes. Session history remains intact, allowing exact
  resumption once the stack is restarted.
- **No automatic paid replay:** The plugin and transport never resubmit failed
  or interrupted tasks. Hermes evaluates the failure and obtains authorization
  before further paid work. Native in-turn retry behavior is controlled by OMP
  settings (`set_auto_retry`), not by a bridge scheduler.
- **Provider authentication:** OAuth providers requiring browser callbacks must
  be authenticated via `dc exec omp-executor omp login <provider>`.

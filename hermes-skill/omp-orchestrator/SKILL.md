---
name: omp-orchestrator
description: Orchestrate tasks on the isolated OMP worker via direct authenticated RPC. Inspect catalog sessions, launch new or resumed sessions, dispatch native commands, poll sequenced events, and handle interactive UI confirmations.
version: 0.3.0
platforms: [linux]
metadata:
  hermes:
    tags: [omp, orchestrator, rpc, delegation]
    category: tools
    requires_toolsets: [omp-executor]
---

# omp-orchestrator

Orchestrate tasks on the isolated OMP worker via direct authenticated TCP RPC. Never attempt HTTP bridge calls or execute arbitrary unapproved host tools.

Hermes orchestrates permissions, session selection, user confirmations, and top-level workflow. The OMP main agent executes inside the worker environment, delegating narrowly scoped assignments to subagents.

---

## 1. Toolset & Architecture

All communication uses the 6 native tools in the `omp-executor` toolset:

- `omp_sessions`: Query durable session catalogs recorded on disk across workspace and `~/.omp/agent/sessions`.
- `omp_open`: Launch a new isolated session or resume an existing catalog session.
- `omp_rpc`: Asynchronously dispatch any of the 48 native `RpcCommand` types.
- `omp_events`: Retrieve sequenced events, cursor progression, dropped-event overflow, and settlement status.
- `omp_respond`: Deliver interactive UI responses, host tool updates, or host URI results.
- `omp_close`: Explicitly close the connection and process while preserving session history.

Live session handles are private to your Hermes session context. `omp_sessions` discovers recorded sessions on disk, while active turn status and settlement are polled through `omp_events` on your open executor.

---

## 2. Session Selection: New vs. Resume

Never guess session identifiers or replace an existing task with an unsanctioned new session.

### Inspect the Session Catalog First
```json
{
  "offset": 0,
  "limit": 50
}
```
`omp_sessions` returns `{ "ok": true, "sessions": [...], "total": <int> }` with session IDs, file paths, modified timestamps, and recorded working directories.

### Mode: `new`
Starts a fresh native OMP session in the worker workspace:
```json
{
  "executor": "default",
  "mode": "new"
}
```
Optional `cwd` specifies an absolute path on the worker filesystem. Do not pass model or thinking overrides unless the user explicitly requested them. Session `cwd` is locked at creation and cannot be changed mid-session.

### Mode: `resume`
Reconnects to an exact historical session:
```json
{
  "executor": "default",
  "mode": "resume",
  "session_id": "<session_id_from_omp_sessions>"
}
```
Pass `session_id` or `session_file` selected from `omp_sessions`. Mode `resume` recovers the recorded `cwd` from session headers and strictly rejects `cwd` overrides.

---

## 3. Probing Capabilities & Skills

Before delegating work, inspect the worker environment. Note that `omp_rpc` returns `{ "ok": true, "executor": "...", "request_id": "<id>" }` asynchronously; retrieve actual data payloads by polling `omp_events` for the response event matching that `request_id`.

- **Session State**: Dispatch `get_state` and poll matching response to inspect active model, thinking level, and runtime flags. (Working directory is obtained from catalog entries in `omp_sessions` or by running `pwd` via `bash`).
- **Available Extension & Skill Commands**: Dispatch `get_available_commands` and poll matching response. This lists session-registered extension, prompt, and skill commands (distinct from the 48 wire protocol RPC methods accepted by `omp_rpc`).
- **On-Disk Skills**: Installed skills reside at `/opt/skills` (upstream) and `/opt/omp-skills` (internal). Probe directories via the `bash` command in `omp_rpc` if needed.
- **NEVER use `get_entries` for skill discovery**: `get_entries` retrieves session journal history, not skill inventories.
---

## 4. Command Dispatch, Queueing & Abort

`omp_rpc` dispatches commands asynchronously and returns immediately with `{ "ok": true, "executor": "...", "request_id": "<id>" }`. Correlate this `request_id` with subsequent event notifications.

### Prompting & Steering
- **`prompt`**: Start an agent turn:
  ```json
  {
    "command": "prompt",
    "params": {
      "message": "Inspect repository structure and report findings.",
      "streamingBehavior": "steer"
    }
  }
  ```
- **`steer`**: Inject instructions into an active turn:
  ```json
  {
    "command": "steer",
    "params": { "message": "Avoid touching configuration files." }
  }
  ```
- **`follow_up`**: Queue instructions to execute after the current turn settles:
  ```json
  {
    "command": "follow_up",
    "params": { "message": "Run tests across changed files." }
  }
  ```
- **`abort`**: Cancel the active turn:
  ```json
  { "command": "abort", "params": {} }
  ```

---

## 5. Sequenced Event Loop & Settlement

Poll events non-destructively:
```json
{
  "executor": "default",
  "after": 0,
  "limit": 100
}
```

### Event Handling Protocol
1. Track sequence numbers: update your cursor to `res.next_cursor`.
2. Check `overflow`: if `overflow: true`, cursor was older than `dropped_through`. Query `get_state` or `get_messages` via `omp_rpc` to re-sync state.
3. Check `pending_requests`: handle interactive UI requests or host callbacks immediately via `omp_respond`.
4. Check settlement: when `turn_active == false` and `session_settled == true`, the turn has settled.
5. **Settlement is NOT artifact proof**: Always verify actual deliverables, exit codes, and output files before claiming completion.

---

## 6. UI Confirmations & Host Callbacks

Hermes owns the user interaction interface. Never automatically confirm dangerous, destructive, or paid actions.

- **`confirm`**: Requires strict boolean `confirmed`.
  ```json
  {
    "executor": "default",
    "response": {
      "type": "extension_ui_response",
      "id": "ui_req_1",
      "confirmed": true
    }
  }
  ```
- **`select`**: Requires string `value` from offered options.
  ```json
  {
    "executor": "default",
    "response": {
      "type": "extension_ui_response",
      "id": "ui_req_2",
      "value": "selected_option"
    }
  }
  ```
- **Host Tool Callbacks**: Execute ONLY explicitly authorized host tools. Never run arbitrary system commands requested by the worker. Deliver results with `host_tool_result`.

---

## 7. Lifecycle & Native Limits

- **Closing**: Call `omp_close({ "executor": "default" })` when done to terminate process and connection cleanly.
- **No Automatic Replay**: If a turn fails or disconnects, inspect error messages and consult the user before retrying paid work.
- **Headless OAuth**: Native RPC cannot handle interactive OAuth credential flows. Credentials must be preconfigured in the worker environment.
- **Fixed CWD**: Working directory is fixed at session launch. Launch separate named executors for tasks in different directories.
- **Terminal vs. RPC**: Native worker `bash` can use a PTY for subprocesses, but the RPC transport is structured JSON-RPC over TCP, not an interactive TTY/TUI mirror.

---
name: omp-video
description: Make a narrated technical explainer or storybook video (MP4) by orchestrating the direct OMP video worker via authenticated RPC.
version: 0.3.0
platforms: [linux]
metadata:
  hermes:
    tags: [creative, video, explainer, storybook, hyperframes, rpc]
    category: creative
    requires_toolsets: [omp-executor]
---

# omp-video

Orchestrate video production on the isolated OMP worker via direct authenticated TCP RPC. Never make HTTP bridge calls (`/v1/...`), run HyperFrames locally on the host, or author production video files directly from Hermes.

Hermes orchestrates permissions, brief validation, session selection, checkpoints, acceptance verification, and user delivery.
Inside the worker:
- **OMP Main**: Executes the overall pipeline, synthesizes shared audio, coordinates visual review, and renders final video.
- **Frame Subagents**: Author individual frame HTML and visual compositions.
- **Asset Subagents**: Create and source static illustration assets.

---

## 1. Toolset & Connection Architecture

All operations use the 6 native tools from the `omp-executor` toolset:
`omp_sessions`, `omp_open`, `omp_rpc`, `omp_events`, `omp_respond`, `omp_close`.

No HTTP bridge, curl calls, or webhook daemons exist. Communication is strictly internal authenticated TCP RPC.

---

## 2. Pipeline Selection & Constraints

Select the pipeline from the user's explicit intent; do not guess from keywords:

1. **Technical Explainer / Tutorial**:
   - Internal Pipeline ID: `hyperframes-explainer`
   - Internal Skill: `omp-video-pipeline`
   - Styles: `code-editorial`, `editorial-forest`, `blue-professional`, `auto`.
   - Formats: `landscape` (1920x1080 default), `portrait` (1080x1920), `square` (1080x1080).
   - Voice: English only (default `am_michael`).
   - Duration: 45–75s for concepts, up to 180s for tutorials, ~30s for Shorts.

2. **Storybook Animation**:
   - Internal Pipeline ID: `hyperframes-storybook`
   - Internal Skill: `omp-storybook-pipeline`
   - Style: `storybook-flat` (supported flat 2D style).
   - Narration mode: `verbatim` (exact user text) or `restructured`.
   - Music: `required` (default) or `none`.
   - **Capability Bounds**: Flat 2D storybook artwork with sparse, restrained whole-image motion across measured voiceover spans. Recurring characters and background images are reused across shots. Characters return to neutral rest states when utterances end; no continuous rocking during silence. Storybook is not 3D cinematography, live action, or continuous camera motion.

---

## 3. Validated Direct Brief & Production Contract Helper

Video generation requires a valid `production-contract.json` created in the worker project directory using the canonical helper:
```bash
node /opt/omp-skills/omp-video-pipeline/scripts/production-contract.mjs <absolute PROJECT_DIR> --input <absolute brief.json> [--update]
```

### Brief Specification (`brief.json`)
```json
{
  "pipeline": "hyperframes-storybook",
  "spec": {
    "style": "storybook-flat",
    "format": "landscape",
    "voice": "am_michael",
    "audience": "children",
    "tone": "gentle",
    "narrationMode": "verbatim",
    "music": "required"
  },
  "durationSec": 50,
  "brief": "A curious fox explores an autumn forest.",
  "permissions": {
    "createAssets": true,
    "generateAudio": true,
    "renderVideo": true
  }
}
```

### Brief Rules & Permissions
- **Validation**: `pipeline` must be `hyperframes-explainer` or `hyperframes-storybook`. `durationSec` must be positive. `permissions` must contain booleans `{ createAssets, generateAudio, renderVideo }`.
- **Operational Directives**: Permission flags are operational instructions that pipeline skills honor, not operating system sandboxing or hypervisor isolation.
- **Contract Updates & Precedence**: Helper refuses to overwrite an existing contract unless `--update` is explicitly passed. On `--update`, explicit brief fields take precedence over existing contract fields (`brief.revisionInstructions` > existing, `brief.changedFrames` > existing, `brief.approvalNotes` > existing).
- **Narration Precedence**: Explicit input `narrationSource` in brief > existing contract `narrationSource` > `SCRIPT.md` baseline (when `narrationMode: "verbatim"`).
- **Permissions Enforcement**:
  - `createAssets`: Authorize static asset generation/sourcing.
  - `generateAudio`: Authorize voice and music synthesis.
  - `renderVideo`: Authorize MP4 video rendering.
  - **No Hidden Renders**: For preview-only jobs, set `renderVideo: false`. If an ungranted permission is required, pause and request user authorization; never assume implicit approval.

---

## 4. Production Execution Workflow via RPC

1. **Session Setup (`omp_open`)**:
   Inspect existing sessions with `omp_sessions`.
   For new projects, launch without `cwd` to use the default worker workspace:
   ```json
   {
     "executor": "video-worker",
     "mode": "new"
   }
   ```
   Determine the worker workspace directory by running `pwd` via the `bash` command in `omp_rpc` (or inspecting `cwd` in `omp_sessions` catalog).
   Create the project directory under that workspace:
   ```json
   {
     "executor": "video-worker",
     "command": "bash",
     "params": {
       "command": "mkdir -p <workspace>/projects/<project_slug>"
     }
   }
   ```
   Set `PROJECT_DIR="<workspace>/projects/<project_slug>"`.
   For revisions, reconnect to the exact recorded session with `omp_open({ "executor": "video-worker", "mode": "resume", "session_id": "<id>" })`.

2. **Establish Production Contract**:
   Write `brief.json` in `<PROJECT_DIR>`, then execute the helper via `omp_rpc`:
   ```json
   {
     "executor": "video-worker",
     "command": "bash",
     "params": {
       "command": "node /opt/omp-skills/omp-video-pipeline/scripts/production-contract.mjs <PROJECT_DIR> --input <PROJECT_DIR>/brief.json"
     }
   }
   ```

3. **Prompt Pipeline Execution**:
   Dispatch prompt using the exact skill URI and absolute contract path:
   ```json
   {
     "executor": "video-worker",
     "command": "prompt",
     "params": {
       "message": "skill://omp-storybook-pipeline <PROJECT_DIR>/production-contract.json",
       "streamingBehavior": "steer"
     }
   }
   ```
   (For explainers, use `skill://omp-video-pipeline <PROJECT_DIR>/production-contract.json`).

4. **Sequenced Event Loop & Settlement**:
   Poll `omp_events({ "executor": "video-worker", "after": cursor, "limit": 100 })`.
   - Update cursor to `next_cursor`.
   - Handle interactive UI requests in `pending_requests` via `omp_respond`.
   - Loop until `turn_active == false` and `session_settled == true`.

---

## 5. Checkpoints & Targeted Revisions

Revisions execute directly within the exact resumed project directory (no copy-on-revise workdir):
1. Resume session with `omp_open({ "executor": "video-worker", "mode": "resume", "session_id": "<session_id>" })`.
2. Update contract in place using `--update` and updated brief specifying `revisionInstructions` and `changedFrames: [3, 5]`.
3. Unchanged frames and approved baseline narration are preserved; only targeted frames are regenerated.
4. Dispatch revision prompt with exact skill URI and monitor to settlement.

---

## 6. Artifact Publication Procedure & Acceptance

The server does NOT automatically publish artifacts. OMP must publish deliverables explicitly:

1. **Clean Publication Destination**:
   Pick a fresh explicit publication directory per accepted revision (e.g. `/data/executor/artifacts/<project_slug>`) to prevent nesting stale projects; refuse overwriting unrelated existing directories.
   Create directory and copy exact contents (including hidden `.hyperframes/` audit/evidence, `production-contract.json`, contact sheets, renders):
   ```bash
   mkdir -p /data/executor/artifacts/<project_slug> && cp -a <PROJECT_DIR>/. /data/executor/artifacts/<project_slug>/
   ```

2. **Rerun Validator on Published Copy**:
   - **Storybook (`hyperframes-storybook`)**:
     Run acceptance CLI directly on the published directory:
     ```bash
     node /opt/omp-skills/omp-storybook-pipeline/scripts/acceptance.mjs /data/executor/artifacts/<project_slug> [--require-video]
     ```
     Pass `--require-video` as a boolean flag for full video jobs; omit it for preview-only runs (`renderVideo: false`).
     Acceptance CLI must exit with status 0. Read `.hyperframes/storybook-audit.json` to extract `video.path` (typically `renders/video.mp4`), and assert the returned video path binds to that exact audited artifact (`/data/executor/artifacts/<project_slug>/renders/video.mp4`).
     Verify `.hyperframes/storybook-audit/visual-review.json` has `kind: "hyperframes-storybook-visual-review"`, `verdict: "approved"`, and matches audit digest.
   - **Explainer (`hyperframes-explainer`)**:
     Do NOT run storybook acceptance. Rerun explainer verify CLI on the published copy:
     ```bash
     node /opt/omp-skills/omp-video-pipeline/scripts/verify.mjs /data/executor/artifacts/<project_slug>
     ```
     Verify with `ffprobe` that the bound MP4 matches expected format (dimensions, duration, audio/video streams) and inspect contact sheets.

---

## 7. Delivery & Reporting

Hermes reads published deliverables from `/artifacts/<project_slug>/` (read-only bind mount):
- Report duration, format, audited video path (`/artifacts/<project_slug>/renders/video.mp4`), contact sheets, and audit/review findings.
- **No Automatic Telegram Sends**: Deliver media paths directly in conversation. Do not trigger host-level Telegram broadcasts without authorization.
- **No Fake USD Watchers**: Report actual completion status; do not fabricate USD cost estimations or synthetic timers.

## 8. Platform Limits & Native Protocol Constraints

- **Headless OAuth**: Native RPC cannot accept interactive OAuth flows. Credentials must be preconfigured in the worker environment.
- **Fixed CWD**: Working directory is fixed at session creation. Revisions must stay in the project workdir or open a fresh session.
- **Structured RPC vs. TTY**: Native worker `bash` can use a PTY for internal processes, but communication between Hermes and OMP is strictly structured JSON-RPC over TCP.

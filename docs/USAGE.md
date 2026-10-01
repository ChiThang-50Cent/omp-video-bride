# Docker usage guide

This page is a **human-facing** API tutorial for the isolated Docker deployment. It
starts after the Docker deployment has been bootstrapped. Follow the complete
onboarding checklist in [`SETUP.md#docker-onboarding`](SETUP.md#docker-onboarding)
first: it covers the checkout, external state, provider/model credentials, and
Hermes/Telegram configuration (including the
[`configuration-only Telegram procedure`](SETUP.md#configure-telegram-without-starting-a-second-gateway)).
This page does not replace the API contract in [`docs/SPEC.md`](SPEC.md).

The commands below are Bash and require `jq`. They use the Compose service names
`video-worker` and `hermes`; do not replace them with ad-hoc container names.
Run the snippets in one shell where possible. Request and response files are
kept under the external state directory, not in Git.

## Safety and cost boundary

A build or revision invokes the configured `omp`/LLM provider and can consume
paid provider usage. The `limits.maxUsd` and `limits.maxMinutes` fields are
bridge-side usage/time checks: they are not a provider billing cap or a promise
that no provider work happens before a limit is observed. The `render:false`
preview still runs the storyboard, narration, frames, and verification steps;
it only omits the final MP4 render. Native rendering of a ready preview does not
make another LLM call.

A notification, webhook, or Telegram progress message is **not** approval. Do
not answer a notification by approving, resubmitting, or starting another paid
job. Submit, approve, revise, and cancel only after an explicit user decision.
If a request or response is lost, use `GET /v1/jobs/<job-id>` with the saved ID
before doing anything else.

The repository's verification boundary is explicit: Docker packaging/health
checks have not performed a paid live provider turn or an actual Telegram send.
Those actions require configured test credentials and explicit permission. No
example in this document sends a Telegram message or makes a live provider
request on the reader's behalf.

## 1. Connect to the isolated Docker deployment

Use the same values as the setup guide's onboarding. The API and webhook publications
are loopback-only by default.

```bash
# Run with Bash, not sh: the bridge_api helper uses process substitution.
export OMP_VIDEO_REPO="$HOME/code/omp-video-bridge"
export OMP_VIDEO_STATE_DIR="$HOME/.local/state/omp-video-bridge-docker"
export COMPOSE_PROJECT_NAME=omp-video-bridge
export OMP_VIDEO_HTTP_PORT=18765
export OMP_VIDEO_WEBHOOK_PORT=28644
export BRIDGE_URL="http://127.0.0.1:$OMP_VIDEO_HTTP_PORT"
function dc(){ docker compose -f "$OMP_VIDEO_REPO/deploy/compose.yaml" "$@"; }

cd "$OMP_VIDEO_REPO"
install -d -m 700 "$OMP_VIDEO_STATE_DIR/client"
export CLIENT_DIR="$OMP_VIDEO_STATE_DIR/client"

# This reads the generated bridge token into a short-lived curl header file.
# The token is not an environment variable, curl argument, request body, or
# normal command output; standard input remains available for request JSON.
bridge_api(){ curl --silent --show-error --fail-with-body \
  --header @<(printf 'Authorization: Bearer %s\n' \
    "$(tr -d '\r\n' < "$OMP_VIDEO_STATE_DIR/secrets/bridge-token")") "$@"; }
```

Check the service and then the authenticated catalog. A green health response
only proves that the service is running. It does **not** prove that provider
credentials, a selected model, or Telegram delivery is ready.

```bash
dc ps
curl --fail --silent --show-error "$BRIDGE_URL/v1/health" | jq .

bridge_api "$BRIDGE_URL/v1/catalog" > "$CLIENT_DIR/catalog.json"
jq -e '.pipelines | length > 0' "$CLIENT_DIR/catalog.json" >/dev/null
jq '.pipelines[] | {pipeline, version, options}' "$CLIENT_DIR/catalog.json"
```

`GET /v1/health` is the only unauthenticated route. Every other route in this
tutorial needs the bearer header supplied by `bridge_api`. Use the catalog to
confirm the available `style`, `format`, and `voice` values before choosing a
non-default style.

### Shared polling and artifact helpers

Initialize these before either workflow. Preview/native rendering requires only
section 1 and section 3; it does not require submitting the approval example.

```bash
poll_job() {
  local id="$1" label="$2" max="${3:-240}" i=0 file state
  while [ "$i" -lt "$max" ]; do
    file="$CLIENT_DIR/${label}.json"
    bridge_api "$BRIDGE_URL/v1/jobs/$id" > "$file" || return 1
    jq -e --arg expected "$id" '.job.id == $expected' "$file" >/dev/null
    jq -r '"job=\(.job.id) kind=\(.job.kind) state=\(.job.state) usage_usd=\(.job.usage.usd)"' "$file"
    state=$(jq -er '.job.state' "$file")
    case "$state" in
      awaiting_approval|succeeded|failed|rejected|cancelled)
        return 0
        ;;
      interrupted)
        echo 'job is interrupted; the bridge may resume it automatically; do not resubmit' >&2
        return 0
        ;;
      queued|running)
        ;;
      *)
        echo "unexpected job state: $state" >&2
        return 1
        ;;
    esac
    i=$((i + 1))
    sleep 15
  done
  echo "poll limit reached for $id; inspect $CLIENT_DIR/$label.json and poll again later" >&2
  return 2
}
VIDEO_DATA_ROOT=$(realpath -e -- "$OMP_VIDEO_STATE_DIR/video-data")

worker_path_to_host() {
  local api_path="$1" relative candidate
  case "$api_path" in
    /data/worker/*) relative=${api_path#/data/worker/} ;;
    *) echo "refusing non-worker path: $api_path" >&2; return 1 ;;
  esac
  candidate=$(realpath -e -- "$VIDEO_DATA_ROOT/$relative") || {
    echo "worker path does not exist on the host: $api_path" >&2
    return 1
  }
  case "$candidate/" in
    "$VIDEO_DATA_ROOT/"*) printf '%s\n' "$candidate" ;;
    *) echo "refusing path outside video-data: $api_path" >&2; return 1 ;;
  esac
}
```


## 2. Submit a build that pauses for storyboard approval

`POST /v1/videos` creates a one-scene project and returns all four IDs in one
response: `.project.id`, `.scene.id`, `.version.id`, and `.job.id`. Save those
IDs; never reconstruct one by guessing a prefix or a filesystem name.

The request below uses only fields accepted by the current route schema. The
HyperFrames pipeline accepts `style`, `format`, `voice`, `audience`, and `tone`
in `spec`. `topic` is required; `durationSec` is in seconds. `approve` and
`render` are job options. `metadata` is caller data echoed in webhook events.

```bash
jq -n \
  --arg title 'Hash tables in 30 seconds' \
  --arg topic 'Explain hash tables and collision handling' \
  --arg brief 'Cover hash(key) modulo N, chaining, load factor, and resize.' \
  '{
    title: $title,
    topic: $topic,
    brief: $brief,
    durationSec: 30,
    spec: {
      style: "auto",
      format: "landscape",
      voice: "am_michael",
      audience: "junior developers",
      tone: "clear, friendly, technical"
    },
    approve: "storyboard",
    render: true,
    limits: {maxMinutes: 60, maxUsd: 5},
    metadata: {client: "docker-usage", purpose: "storyboard-approval"}
  }' > "$CLIENT_DIR/build-request.json"

bridge_api -X POST "$BRIDGE_URL/v1/videos" \
  -H 'Content-Type: application/json' \
  --data-binary @"$CLIENT_DIR/build-request.json" \
  > "$CLIENT_DIR/build-submit-response.json"

jq -er '
  [.project.id, .scene.id, .version.id, .job.id]
  | if all(.[]; type == "string" and length > 0)
    then @tsv
    else error("response did not contain all four IDs")
    end
' "$CLIENT_DIR/build-submit-response.json" > "$CLIENT_DIR/build-ids.tsv"
IFS=$'\t' read -r PROJECT_ID SCENE_ID VERSION_ID JOB_ID < "$CLIENT_DIR/build-ids.tsv"
printf 'project=%s\nscene=%s\nversion=%s\njob=%s\n' \
  "$PROJECT_ID" "$SCENE_ID" "$VERSION_ID" "$JOB_ID"
```

This is a paid-capable submission. `maxUsd: 5` is a limit check, not a hard
provider spending guarantee. The initial response has `job.state: "queued"` or
may already show `"running"` because the dispatcher starts work immediately.

### Poll without resubmitting

The bridge job states are `queued`, `running`, `awaiting_approval`, `interrupted`,
`succeeded`, `failed`, `rejected`, and `cancelled`. The helper below polls only
`GET`; it never approves or submits another job. It stops at an approval or
terminal state and has a finite polling bound (240 requests at 15 seconds,
about one hour). The awaiting-approval state has no automatic timeout, but
`maxMinutes` measures wall-clock time since the job first started, including
review waiting. Approval does not reset it; a late continuation can perform
paid work before the next watcher check fails it with `limit_exceeded`.
Choose a limit that includes review time (at most 240 minutes) and approve
within it. If polling ends, inspect/poll the saved ID; never auto-resubmit.

```bash

poll_job "$JOB_ID" build-before-approval 240
BUILD_STATE=$(jq -er '.job.state' "$CLIENT_DIR/build-before-approval.json")
printf 'build state: %s\n' "$BUILD_STATE"
```

If the state is `interrupted`, the bridge's restart recovery normally requeues
the same job. Do not submit a replacement. Poll the same `$JOB_ID` again. For
`failed` or `rejected`, report `.job.error.code` and `.job.error.message`; do
not automatically retry a paid request.

### Read the approval documents safely

When the state is `awaiting_approval`, the related response includes
`.version.projectDir`. In this Docker deployment the worker returns paths below
`/data/worker`; the host bind mount for that same tree is
`$OMP_VIDEO_STATE_DIR/video-data`. The following mapping rejects any path that
is not under the exact worker prefix and uses `realpath -e` containment checks
before opening either document.

```bash
if [ "$BUILD_STATE" = awaiting_approval ]; then
  PROJECT_DIR_API=$(jq -er '.version.projectDir' "$CLIENT_DIR/build-before-approval.json")

  PROJECT_DIR_HOST=$(worker_path_to_host "$PROJECT_DIR_API")
  PROJECT_DIR_HOST=$(realpath -e -- "$PROJECT_DIR_HOST")

  read_doc() {
    local root="$1" name="$2" real
    real=$(realpath -e -- "$root/$name") || {
      echo "missing approval document: $name" >&2
      return 1
    }
    case "$real/" in
      "$root/"*) cat -- "$real" ;;
      *) echo "refusing document outside projectDir: $name" >&2; return 1 ;;
    esac
  }

  read_doc "$PROJECT_DIR_HOST" STORYBOARD.md > "$CLIENT_DIR/STORYBOARD.md"
  read_doc "$PROJECT_DIR_HOST" SCRIPT.md > "$CLIENT_DIR/SCRIPT.md"
  printf 'approval documents saved under %s\n' "$CLIENT_DIR"
  printf '\n--- STORYBOARD.md ---\n'
  cat "$CLIENT_DIR/STORYBOARD.md"
  printf '\n--- SCRIPT.md ---\n'
  cat "$CLIENT_DIR/SCRIPT.md"
fi
```

If the host user cannot traverse the bind mount, read the same files inside the
worker instead. Pass the API-returned path as an argument (not as shell source)
and keep the realpath check inside the container:

```bash
# PROJECT_DIR_API must come from GET /v1/jobs/$JOB_ID, as above.
dc exec -T video-worker node --input-type=module - \
  "$PROJECT_DIR_API" STORYBOARD.md <<'NODE'
import { realpathSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
const [projectArg, name] = process.argv.slice(-2);
const root = realpathSync(projectArg);
const file = realpathSync(join(root, name));
if (!file.startsWith(root + sep)) throw new Error("document escaped projectDir");
process.stdout.write(readFileSync(file, "utf8"));
NODE
```

For Hermes, the same relative path is mounted read-only as `/videos-v2`: replace
only the verified `/data/worker` prefix with `/videos-v2`. Do not give Hermes a
host path or an unverified path. The worker's `/data/worker` and Hermes's
`/videos-v2` are two container views of the host
`$OMP_VIDEO_STATE_DIR/video-data` bind mount.

### Approve with explicit notes, then finish the render

Review the storyboard and script before this step. The approval endpoint accepts
only optional `notes` and continues the **same** job/session; it does not create
a new job or version. A notification must not be treated as approval.

```bash
jq -n \
  --arg notes 'Approved. Keep the hash(key) modulo N example; make the resize transition explicit.' \
  '{notes: $notes}' > "$CLIENT_DIR/approve.json"

bridge_api -X POST "$BRIDGE_URL/v1/jobs/$JOB_ID/approve" \
  -H 'Content-Type: application/json' \
  --data-binary @"$CLIENT_DIR/approve.json" \
  > "$CLIENT_DIR/approve-response.json"
jq -e --arg id "$JOB_ID" '.job.id == $id' "$CLIENT_DIR/approve-response.json" >/dev/null
jq '{id: .job.id, state: .job.state, phase: .job.phase, approvalNotes: .job.approvalNotes}' \
  "$CLIENT_DIR/approve-response.json"

poll_job "$JOB_ID" build-after-approval 240
```

For a successful `render:true` build, the completion response has
`.job.result` with `versionId`, `video`, `contactSheets`, `durationSec`,
`notes`, and `framesChanged`. The same `versionId` must match the saved version
ID. Retrieve and copy the published MP4 and contact sheets only after this gate:

```bash
jq -e --arg vid "$VERSION_ID" '
  .job.state == "succeeded"
  and .job.result.versionId == $vid
  and (.job.result.video | type == "string" and length > 0)
  and (.job.result.contactSheets | type == "array" and length > 0)
' "$CLIENT_DIR/build-after-approval.json" >/dev/null

OUTPUT_DIR="$CLIENT_DIR/output-$VERSION_ID"
install -d -m 700 "$OUTPUT_DIR"
VIDEO_API_PATH=$(jq -er '.job.result.video' "$CLIENT_DIR/build-after-approval.json")
VIDEO_HOST_PATH=$(worker_path_to_host "$VIDEO_API_PATH")
cp -- "$VIDEO_HOST_PATH" "$OUTPUT_DIR/final.mp4"

n=0
while IFS= read -r CONTACT_API_PATH; do
  n=$((n + 1))
  cp -- "$(worker_path_to_host "$CONTACT_API_PATH")" \
    "$OUTPUT_DIR/contact-sheet-$n.jpg"
done < <(jq -er '.job.result.contactSheets[]' "$CLIENT_DIR/build-after-approval.json")

printf 'MP4: %s\n' "$OUTPUT_DIR/final.mp4"
printf 'contact sheets: %s\n' "$OUTPUT_DIR/contact-sheet-*.jpg"
jq '{id: .job.id, state: .job.state, usage: .job.usage, result: .job.result}' \
  "$CLIENT_DIR/build-after-approval.json"
```

The paths in the HTTP response are worker paths. `worker_path_to_host` maps and
checks them before copying. In Hermes, the corresponding MP4/contact-sheet
paths are `/videos-v2/<relative path>` and are read-only. The bridge publishes
only intended artifacts (MP4, contact sheets, captions, and approval documents)
for the different Hermes UID; private sessions and configuration files are not
published.

## 3. Preview first, then use the native render job

Use a separate submission when you want to inspect contact sheets before
spending compute on the native render step. This is **not** a no-cost build: storyboard, narration,
frame, and verification work still runs. `render:false` is a truthful output
gate: the build must succeed with `.job.result.video == null` and the version
must be ready with contact sheets before the native render endpoint is called.

```bash
jq -n \
  '{
    title: "Hash tables preview",
    topic: "Explain hash tables and collision handling",
    brief: "Show chaining and load-factor resize with a compact example.",
    durationSec: 30,
    spec: {
      style: "auto",
      format: "landscape",
      voice: "am_michael",
      audience: "junior developers",
      tone: "clear, friendly, technical"
    },
    render: false,
    limits: {maxMinutes: 60, maxUsd: 5},
    metadata: {client: "docker-usage", purpose: "preview-before-native-render"}
  }' > "$CLIENT_DIR/preview-request.json"

bridge_api -X POST "$BRIDGE_URL/v1/videos" \
  -H 'Content-Type: application/json' \
  --data-binary @"$CLIENT_DIR/preview-request.json" \
  > "$CLIENT_DIR/preview-submit-response.json"
jq -er '
  [.project.id, .scene.id, .version.id, .job.id]
  | if all(.[]; type == "string" and length > 0) then @tsv
    else error("preview response did not contain all four IDs") end
' "$CLIENT_DIR/preview-submit-response.json" > "$CLIENT_DIR/preview-ids.tsv"
IFS=$'\t' read -r PREVIEW_PROJECT_ID PREVIEW_SCENE_ID PREVIEW_VERSION_ID PREVIEW_JOB_ID \
  < "$CLIENT_DIR/preview-ids.tsv"
printf 'preview project=%s\npreview scene=%s\npreview version=%s\npreview job=%s\n' \
  "$PREVIEW_PROJECT_ID" "$PREVIEW_SCENE_ID" "$PREVIEW_VERSION_ID" "$PREVIEW_JOB_ID"

poll_job "$PREVIEW_JOB_ID" preview-build 240
jq -e --arg vid "$PREVIEW_VERSION_ID" '
  .job.state == "succeeded"
  and .job.result.versionId == $vid
  and .job.result.video == null
  and (.job.result.contactSheets | type == "array" and length > 0)
' "$CLIENT_DIR/preview-build.json" >/dev/null

bridge_api "$BRIDGE_URL/v1/versions/$PREVIEW_VERSION_ID" \
  > "$CLIENT_DIR/preview-version-before-render.json"
jq -e '
  .version.state == "ready"
  and .version.outputs.video == null
  and (.version.outputs.contactSheets | type == "array" and length > 0)
' "$CLIENT_DIR/preview-version-before-render.json" >/dev/null
```

Only after that gate, submit the native render. Its request schema is
`{metadata?: object}` and its response is `{job}`. The native render job has
`kind: "render"`, `maxUsd: 0`, and does not invoke the LLM.

```bash
jq -n '{metadata: {client: "docker-usage", purpose: "native-render"}}' \
  > "$CLIENT_DIR/native-render-request.json"
bridge_api -X POST "$BRIDGE_URL/v1/versions/$PREVIEW_VERSION_ID/render" \
  -H 'Content-Type: application/json' \
  --data-binary @"$CLIENT_DIR/native-render-request.json" \
  > "$CLIENT_DIR/native-render-submit-response.json"
NATIVE_JOB_ID=$(jq -er '.job.id' "$CLIENT_DIR/native-render-submit-response.json")
jq -e --arg vid "$PREVIEW_VERSION_ID" \
  '.job.kind == "render" and .job.refs.versionId == $vid' \
  "$CLIENT_DIR/native-render-submit-response.json" >/dev/null
printf 'native render job=%s\n' "$NATIVE_JOB_ID"

poll_job "$NATIVE_JOB_ID" native-render 240
jq -e --arg vid "$PREVIEW_VERSION_ID" '
  .job.state == "succeeded"
  and .job.result.versionId == $vid
  and (.job.result.video | type == "string" and length > 0)
' "$CLIENT_DIR/native-render.json" >/dev/null

# Native render result intentionally omits contactSheets. Fetch the version.
bridge_api "$BRIDGE_URL/v1/versions/$PREVIEW_VERSION_ID" \
  > "$CLIENT_DIR/preview-version-after-render.json"
jq -e '
  .version.state == "ready"
  and (.version.outputs.video | type == "string" and length > 0)
  and (.version.outputs.contactSheets | type == "array" and length > 0)
' "$CLIENT_DIR/preview-version-after-render.json" >/dev/null

NATIVE_OUTPUT_DIR="$CLIENT_DIR/output-$PREVIEW_VERSION_ID-native"
install -d -m 700 "$NATIVE_OUTPUT_DIR"
NATIVE_VIDEO_API_PATH=$(jq -er '.job.result.video' "$CLIENT_DIR/native-render.json")
NATIVE_VIDEO_HOST_PATH=$(worker_path_to_host "$NATIVE_VIDEO_API_PATH")
cp -- "$NATIVE_VIDEO_HOST_PATH" "$NATIVE_OUTPUT_DIR/final.mp4"
n=0
while IFS= read -r CONTACT_API_PATH; do
  n=$((n + 1))
  cp -- "$(worker_path_to_host "$CONTACT_API_PATH")" \
    "$NATIVE_OUTPUT_DIR/contact-sheet-$n.jpg"
done < <(jq -er '.version.outputs.contactSheets[]' "$CLIENT_DIR/preview-version-after-render.json")
printf 'native MP4: %s\n' "$NATIVE_OUTPUT_DIR/final.mp4"
printf 'native contact sheets: %s\n' "$NATIVE_OUTPUT_DIR/contact-sheet-*.jpg"

```

Copy `.job.result.video` from the native job through the same
`worker_path_to_host` check. Read contact sheets from
`.version.outputs.contactSheets` in the version response, not from the native
job result. A second native render of a version that already has a video is a
`409 already_rendered`; a preview that is not ready is a `409 version_not_ready`.
Do not turn either response into another build submission.

## 4. Revise a known scene/version

Every revision creates a **new** version and a new job. The route is
`POST /v1/scenes/<scene-id>/revise`; `instructions` is required (3–4000
characters). `frames`, `durationSec`, `fromVersionId`, `metadata`, `limits`, and
`render` are optional. Supplying `fromVersionId` makes the base explicit and
prevents selecting the wrong version when a scene has history.

This example uses the IDs saved from the approved `render:true` flow. Use a
ready version from either flow, but replace the variables with that flow's
saved IDs rather than guessing.

```bash
# These are the IDs from build-ids.tsv and are intentionally explicit.
IFS=$'\t' read -r PROJECT_ID SCENE_ID BASE_VERSION_ID BASE_BUILD_JOB_ID \
  < "$CLIENT_DIR/build-ids.tsv"

jq -n \
  --arg instructions 'Frame 5: separate the three collision-handling pills; keep all other frames unchanged.' \
  --arg base "$BASE_VERSION_ID" \
  '{
    instructions: $instructions,
    frames: [5],
    fromVersionId: $base,
    render: true,
    limits: {maxMinutes: 60, maxUsd: 5},
    metadata: {client: "docker-usage", purpose: "revision"}
  }' > "$CLIENT_DIR/revise-request.json"

bridge_api -X POST "$BRIDGE_URL/v1/scenes/$SCENE_ID/revise" \
  -H 'Content-Type: application/json' \
  --data-binary @"$CLIENT_DIR/revise-request.json" \
  > "$CLIENT_DIR/revise-response.json"
REVISE_JOB_ID=$(jq -er '.job.id' "$CLIENT_DIR/revise-response.json")
REVISE_VERSION_ID=$(jq -er '.version.id' "$CLIENT_DIR/revise-response.json")
jq -e --arg base "$BASE_VERSION_ID" --arg scene "$SCENE_ID" \
  '.job.kind == "revise"
   and .job.refs.sceneId == $scene
   and .version.parentVersionId == $base' \
  "$CLIENT_DIR/revise-response.json" >/dev/null
printf 'revision job=%s\nrevision version=%s\nbase version=%s\n' \
  "$REVISE_JOB_ID" "$REVISE_VERSION_ID" "$BASE_VERSION_ID"

poll_job "$REVISE_JOB_ID" revise 240
jq -e --arg vid "$REVISE_VERSION_ID" '
  .job.state == "succeeded"
  and .job.result.versionId == $vid
  and (.job.result.video | type == "string" and length > 0)
' "$CLIENT_DIR/revise.json" >/dev/null
```

A successful revision has the same build/revise result fields as the original
build, including the new `.job.result.video` and `.job.result.contactSheets`.
Use `GET /v1/versions/$REVISE_VERSION_ID` and the same path-containment copy
procedure to retrieve them. The old version remains available. If the revision
is rejected because it requests a new style/format or another unsupported
restructure, report `.job.error.message`; do not silently submit a new video.

## 5. Cancel a nonterminal job

`POST /v1/jobs/<job-id>/cancel` accepts `{reason?: string}` and returns
`{job}`. Use the exact job ID returned by the submission you intend to stop.
For a queued or approval-waiting job, the response normally is already
`cancelled`. For a running job, the first response can still show `running`
while the worker is being stopped; poll that same ID until `cancelled`. A
terminal job returns `409 job_finished`; inspect it and do not retry the cancel
or submit a replacement.

The following cancels the revision created above. Run it only if that is the
user's explicit decision; do not run it if you want the revision to finish.

```bash
jq -n --arg reason 'User cancelled before the revision completed.' \
  '{reason: $reason}' > "$CLIENT_DIR/cancel-request.json"
bridge_api -X POST "$BRIDGE_URL/v1/jobs/$REVISE_JOB_ID/cancel" \
  -H 'Content-Type: application/json' \
  --data-binary @"$CLIENT_DIR/cancel-request.json" \
  > "$CLIENT_DIR/cancel-response.json"
jq -e --arg id "$REVISE_JOB_ID" '.job.id == $id' "$CLIENT_DIR/cancel-response.json" >/dev/null
jq '{id: .job.id, kind: .job.kind, state: .job.state, error: .job.error}' \
  "$CLIENT_DIR/cancel-response.json"

# If the response was still running, this observes the same job; it does not resubmit.
poll_job "$REVISE_JOB_ID" revise-after-cancel 240
```

Cancelling a build/revision leaves its pending version failed; do not revise a
cancelled build. Cancelling an approval-waiting build is the supported way to
decline it. There is no `POST /reject` user endpoint: `rejected` is a pipeline
outcome (for example, an unsupported restructure), not a command to fabricate
in a client.

## 6. Using the bot through Telegram

This section is for the **person requesting a video**, not for configuring the
agent. The agent-only skill is
[`hermes-skill/omp-video/SKILL.md`](../hermes-skill/omp-video/SKILL.md); it
contains tool permissions, path translation, and sender details that users
should not copy as shell commands. The setup guide's
[`configuration-only Telegram procedure`](SETUP.md#configure-telegram-without-starting-a-second-gateway)
must configure the bot before exactly one gateway is started. Do not run a
second polling gateway with the same token; use a separate test bot or an
explicit cutover.

### Request a video

Give the bot enough information to form the API fields:

- subject/topic and the intended audience;
- approximate length (the API accepts `durationSec` 10–300; the HyperFrames
  catalog currently advertises 15–180);
- output format: `landscape` (1920×1080), `portrait` (1080×1920), or `square`
  (1080×1080);
- whether to pause for storyboard approval before production; and
- any concrete style, voice, frame, or content constraints.

For example:

> Create a 30-second English explainer for junior developers about hash-table
> collisions. Use landscape format, a clear technical tone, and pause after the
> storyboard so I can review it. Do not start production until I explicitly
> approve the storyboard.

The bot should confirm the chosen spec and return a job ID/scene ID/version ID
(or quote the message that contains them). A build may queue behind other work;
there is no guaranteed completion time. Do not promise a fixed number of minutes
without a current benchmark and provider availability.

### Approval, changes, and cancellation

When the bot presents the storyboard/script and says the job is
`awaiting_approval`, review those documents. Reply explicitly to that message,
for example:

> Approve job `job_…` with these notes: make the resize transition explicit and
> keep the final example.

Only that explicit instruction should cause the bot to call
`POST /v1/jobs/<id>/approve` with `{ "notes": "…" }`. A progress notification
alone is never approval.

There is no implemented manual reject endpoint or guaranteed `/reject` chat
command. If you do not want to continue, tell the bot explicitly to cancel the
job (or cancel the known `job_…`); the bot should use the real cancel endpoint.
A `rejected` status may still appear when the pipeline rejects an unsupported
revision/restructure; that is different from a user rejecting a storyboard.

To request a revision, reply to the bot's MP4/contact-sheet message and name
what to change, preferably by contact-sheet frame number:

> Revise scene `scn_…`, version `ver_…`: in frame 5, separate the three pills;
> keep the narration and format.

Replying to the message is useful, but the scene ID is the API routing key and
the version ID identifies the exact base. If several videos are in the chat,
include both IDs; never guess between them. Each revision gets a new version
and job, while the old version remains available. To stop work, reply with
`cancel job job_…` or clearly ask the bot to cancel the referenced job.

### What the bot can deliver

Expect progress or error messages keyed by the job ID. The implemented webhook
and job lifecycle events include `job.started`, `job.awaiting_approval`,
`job.succeeded`, `job.failed`, `job.rejected`, `job.cancelled`, and
`job.resumed`. On success, the bot can deliver the MP4 and contact sheet(s),
with the project/scene/version IDs in the caption so a later reply targets the
right video. On failure, it should report the job error code/message and not
silently resubmit. `job.resumed` means the bridge recovered an interrupted job;
it is not a request for approval or a reason to start another job.

Delivery depends on the configured Hermes route, Telegram credentials, and
readability of the `/videos-v2` read-only mount. A sender may report partial
attachment failures even when its overall response says `success:true`; the
bot should identify which artifact was actually delivered. Timing is not
guaranteed: queue depth, provider work, CPU rendering, network/font downloads,
and Telegram availability all affect completion.

## 7. Troubleshooting and contract links

- **401:** use the `bridge_api` helper and confirm the Docker bootstrap created
  `$OMP_VIDEO_STATE_DIR/secrets/bridge-token`; do not paste the token into a
  command, an environment variable, or a log. `/v1/health` intentionally does
  not require it.
- **Healthy containers but no useful video:** health is process health, not
  provider/model readiness. Recheck the provider login and bridge
  `runner.defaultModel` in `worker-config.json`, then follow the [setup guide's reload](SETUP.md#8-recreate-the-configured-services)
  procedure; do not resubmit the paid job merely because health is green.
- **OAuth/quota/model errors:** inspect `.job.error` from the saved job response,
  verify the configured account's supported catalog/model, and make a deliberate
  new request only after the cause is fixed.
- **Telegram `409 Conflict`:** only one gateway may poll a bot token. Stop the
  competing gateway or use a separate test bot; do not keep two pollers running.
- **Unreadable attachments:** verify the `/data/worker` → host
  `video-data` → Hermes `/videos-v2` mapping and permissions. Do not expose
  private sessions/configuration just to make an attachment readable.

For exact request schemas, errors, state transitions, storage paths, and Docker
mounts, use [`docs/SPEC.md`](SPEC.md) and [`src/http/routes.ts`](../src/http/routes.ts)
as the source of truth. The route summary is:

```text
POST /v1/videos                         -> {project, scene, job, version}
GET  /v1/jobs/:id                       -> {job, version, events?}
POST /v1/jobs/:id/approve               -> {job}
POST /v1/jobs/:id/cancel                -> {job}
POST /v1/scenes/:id/revise              -> {job, version}
GET  /v1/versions/:id                   -> {version}
POST /v1/versions/:id/render            -> {job}
```

These examples do not change runtime code or dependency pins. Lifecycle
requests mutate persistent job/project state; build, revision and approval
continuation can invoke paid provider work when the reader explicitly runs them.

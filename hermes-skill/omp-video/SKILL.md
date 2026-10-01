---
name: omp-video
description: Make a narrated technical explainer video (MP4) by handing the job to the separate omp video worker. Use when the user asks for an explainer, concept, or tutorial video, a multi-part video, or a revision of one.
version: 2.0.1
platforms: [linux]
prerequisites:
  commands: [curl]
metadata:
  hermes:
    tags: [creative, video, explainer, hyperframes, delegation]
    category: creative
    requires_toolsets: [terminal]
---

# omp-video

Delegate production to the separate omp worker via `/v1`; never run HyperFrames here.
Choose settings, save IDs, report progress, deliver media. Ask only when the
target or requested change is ambiguous. Never promise a fixed completion time.

## Connection and files

- Use `$OMP_BRIDGE_URL`, `$OMP_BRIDGE_TOKEN`, and `H="Authorization: Bearer $OMP_BRIDGE_TOKEN"`. Never print the token or guess ports.
- Errors: `{"error":{"code","message"}}`; report both. Never automatically retry paid work.
- `/videos-v2/` is read-only. Webhook paths already use it. For API paths, replace the exact `$OMP_BRIDGE_DATA_DIR/` prefix with `/videos-v2/` (Compose: `/data/worker`; unset: existing host prefix `/home/thangnc/general/omp-videos-v2`).
- Imported `/home/thangnc/general/omp-videos/` paths map to `/videos/` and require the legacy mount.

## Submit

Pick settings from the audience/platform and briefly state the choice:
- Style: `code-editorial` for dev topics, `editorial-forest` for deep dives, `blue-professional` for business, or `auto`. Live choices: `GET /v1/catalog` → `pipelines[0].options.style`.
- Format: `landscape` (default), `portrait` for Shorts/Reels, `square` for feeds.
- Voice: English only; default `am_michael`. Say Vietnamese narration is unsupported.
- Duration: default 50s; ~30s for Shorts, 45–75s for concepts, up to 180s for tutorials. Add short `audience` and `tone` phrases.

Build payloads with `json.dumps`, never concatenate user text into JSON:
```bash
python3 - <<'PY' > /tmp/job.json
import json
print(json.dumps({
    "topic": "Hash tables", "brief": "Explain collisions and resizing",
    "durationSec": 45,
    "spec": {"style": "code-editorial", "format": "landscape", "voice": "am_michael",
             "audience": "junior devs", "tone": "clear and technical"},
    "metadata": {"chat": "<copy destination from conversation>"}
}))
PY
curl -s -X POST "$OMP_BRIDGE_URL/v1/videos" -H "$H" \
  -H "Content-Type: application/json" --data-binary @/tmp/job.json
```
Save job/scene/version/project IDs. Revisions create new versions; never replace
a saved job with a fresh submission as recovery. Optional submit limits:
`"limits":{"maxUsd":5,"maxMinutes":60}`; USD is a soft watcher, not a hard provider cap.

## Follow and control

Webhooks carry submit metadata: `job.started`, `job.awaiting_approval`,
`job.succeeded`, `job.failed`, `job.rejected`, `job.cancelled`, `job.resumed`.
If events are missing, poll the same job no more often than every 2 minutes,
with a finite bound; inspect it later rather than submit a replacement.

| Action | Request / rule |
|---|---|
| Inspect | `GET /v1/jobs/<id>?events=1` → job, version, history |
| Storyboard gate | Submit `"approve":"storyboard"`; on `awaiting_approval`, translate `version.projectDir`, read `STORYBOARD.md` / `SCRIPT.md`, summarize |
| Approve | Only after user approval: `POST /v1/jobs/<id>/approve {"notes":"changes"}` |
| Preview | Submit `"render":false`; contact sheets but no MP4, still incurs authoring costs |
| Native render | After user accepts preview: `POST /v1/versions/<id>/render {}` (no LLM) |
| Revise | Resolve scene from reply/context or `GET /v1/projects` → `GET /v1/projects/<id>`; ask if ambiguous. `POST /v1/scenes/<id>/revise {"instructions":"Frame 5: ...","frames":[5],"metadata":{"chat":"..."}}` |
| Revision source/length | Defaults to current version; optional `fromVersionId`, `durationSec` (10–300). Use concrete contact-sheet frame numbers |
| Roll back | `POST /v1/scenes/<id>/use {"versionId":"..."}` |
| Cancel | `POST /v1/jobs/<id>/cancel {"reason":"..."}`; `job_finished` means nothing remains to cancel |

Approval waiting has no automatic timeout, but the original `maxMinutes` clock
includes that wait. Style/format/frame-count changes can be rejected: report
the reason and offer a new video, never submit it without authorization.

### Manual resume

Only an explicit user request authorizes continuation. Resolve the exact saved ID
from conversation/API; ask only if ambiguous. Inspect job/history first:
- Kinds: `build`, `revise`, `render`, `stitch`; states: `failed`, `cancelled`, `interrupted`. Never bypass `awaiting_approval`.
- `POST /v1/jobs/<id>/resume {}` retains IDs, workdir/session, phase, approval notes and cumulative USD/tokens; opens a fresh time window. Auto crash recovery stays capped at two and keeps the old clock.
- Optional `{"limits":{"maxMinutes":20,"maxUsd":8}}`: positive bounds 240 minutes / $50. USD is the **total** budget, not additional spend; get authorization before raising it.
- Native render/stitch reject USD overrides and have no native time watcher. Stitch resumes against the **current** timeline.
- The API checks references, artifacts/session/accounting history, stale versions and busy conflicts. On error, report code/message; no state repair, retry or new-job fallback. Preserve workdirs/usage logs; never edit them while the worker is live.
- `200 {job}` retains the ID and records `manual_resume` / `job.resumed`. A webhook, timeout or missing response never authorizes approval, another resume, or a new submission.

## Deliver

On success, use `job.result` and translate API paths. Send MP4 (if present) **and**
contact sheets, plus duration and reported USD. Native render omits sheets:
`GET /v1/versions/<versionId>` → `outputs.contactSheets`; stitch returns the final MP4.
Include scene/version IDs in captions for later revisions. On failure, report
error; logs are `version.workdir/{omp.jsonl,omp.stderr.log}`.

Webhook forwarding is text-only. The owner must grant `terminal`, `file`, `skills`
to this route in `webhook_subscriptions.json`; never self-grant tools.
Verify readable paths, then use the sender for the configured Telegram home:
```bash
/opt/hermes/bin/hermes send --to telegram --json "Scene <id> · version <id>
MEDIA:/videos-v2/<actual MP4 path>
MEDIA:/videos-v2/<actual contact sheet path>"
```
Omit MP4 for previews. Check `success` **and** `warnings`; claim only confirmed
attachments. Report partial failures without resending the entire bundle.
Final webhook response summarizes delivery without repeating MEDIA directives.

## Projects and assets

Split distinct parts into 30–90s scenes. Use the same authenticated API:
- `POST /v1/projects {"name":"...","brief":"...","spec":{...}}`; `GET /v1/projects/<id>` lists scenes/versions/assets/final.
- Upload raw bytes: `POST /v1/projects/<id>/assets?name=logo.png&tags=logo` with `--data-binary @/path/logo.png` (≤200MB, content-deduplicated).
- `POST /v1/projects/<id>/scenes {"topic":"...","durationSec":45,"assets":["logo.png"],"findAssets":false}`; then `POST /v1/scenes/<id>/build {"metadata":{"chat":"..."}}`.
- `PUT /v1/projects/<id>/timeline {"order":["scn_a","scn_b"],"transitions":{"scn_b":"fade"}}`; default hard cut, fade up to 0.5s into the named scene.
- `POST /v1/projects/<id>/stitch {"metadata":{"chat":"..."}}` needs current rendered versions for every timeline scene. Stitch again after revisions to refresh the final.
- `PATCH /v1/projects/<id>` merges spec fields. Delete via `/v1/projects/<id>`, `/v1/scenes/<id>`, `/v1/projects/<id>/assets/<assetId>`; conflicting active work blocks deletion.
- Upload user files and select them in `assets`. Set `findAssets:true` only for requested/needed real-world imagery (credits recorded); otherwise visuals are drawn in code.

Jobs queue according to configured concurrency; do not promise sequential timings.

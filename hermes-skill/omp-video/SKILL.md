---
name: omp-video
description: Make a narrated technical explainer or storybook video (MP4) by handing the job to the separate omp video worker. Use when the user asks for an explainer, concept, tutorial, or real storybook animation, or a revision of one.
version: 2.1.0
platforms: [linux]
prerequisites:
  commands: [curl]
metadata:
  hermes:
    tags: [creative, video, explainer, storybook, hyperframes, delegation]
    category: creative
    requires_toolsets: [terminal]
---

# omp-video

Delegate production to the separate omp worker via `/v1`; never run HyperFrames here.
Choose the pipeline from the user's explicit intent, save IDs, report progress,
and deliver media. Ask only when the target or requested change is ambiguous.
Never promise a fixed completion time.

## Connection and files

- Use `$OMP_BRIDGE_URL`, `$OMP_BRIDGE_TOKEN`, and `H="Authorization: Bearer $OMP_BRIDGE_TOKEN"`. Never print the token, export it into command output, enable shell tracing, or guess ports.
- Errors: `{"error":{"code","message"}}`; report both. Never automatically retry paid work.
- `/videos-v2/` is read-only. Webhook paths already use it. For API paths, replace the exact `$OMP_BRIDGE_DATA_DIR/` prefix with `/videos-v2/` (Compose: `/data/worker`; unset: existing host prefix `/home/thangnc/general/omp-videos-v2`).
- Imported `/home/thangnc/general/omp-videos/` paths map to `/videos/` and require the legacy mount.
- `metadata` is opaque caller data only. Never read, import, or treat `metadata.localProjectDir` (or any metadata path) as a file transfer. Upload real files through the authenticated assets endpoint and use API-returned artifact paths only after verifying their mount prefix and containment.

## Submit

Choose the pipeline from the user's intent; do not infer it from a keyword or
regular expression in the brief:
- Technical explainer/tutorial: `pipeline: "hyperframes-explainer"`.
- Storybook animation: `pipeline: "hyperframes-storybook"`.
Fetch `GET /v1/catalog` and select by the exact `.pipeline` ID. Never use
`pipelines[0]`; array order is not a contract. Reject an unavailable ID rather
than silently packaging a storybook into the explainer pipeline.

Pick settings from the audience/platform and briefly state the choice:
- Explainer style comes from the selected pipeline's catalog; common choices are
  `code-editorial`, `editorial-forest`, `blue-professional`, or `auto`.
- Storybook profile: use `style: "storybook-flat"` (the supported style), put the user's story and beats in `topic`/`brief` without rewriting them, default `narrationMode: "verbatim"` and `music: "required"`, and use `music: "none"` only when requested. `format`, `voice`, `audience`, and `tone` remain explicit profile fields.
- Format: `landscape` (default), `portrait` for Shorts/Reels, `square` for feeds.
- Voice: English only; default `am_michael`. Say Vietnamese narration is unsupported.
- Duration: default 50s; ~30s for Shorts, 45–75s for concepts, up to 180s for tutorials. Add short `audience` and `tone` phrases.

Storybook capability is intentionally bounded to readable flat 2D storybook
artwork and sparse whole-image motion: choose or create complete character
images and recurring background images first, inspect a still establishing frame,
then use restrained whole-character slides and slight tilts only across measured
VO/word spans, returning to neutral when each utterance ends. Do not rock through
silent padded time. Reuse the same files in every shot. Supplied or authorized
artwork is preferred; do not assume paid generation, use fake placeholders, or
require programmatic primitive drawing. It is not generated cinematography,
photoreal live action, or arbitrary 3D camera work. Describe that limitation
before submission when it affects the user's expectation.

Build payloads with `json.dumps`, never concatenate user text into JSON:
```bash
python3 - <<'PY' > /tmp/job.json
import json
print(json.dumps({
    "pipeline": "hyperframes-explainer",
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
the reason and offer a new video, never submit it without authorization. If the
user already authorized production and did not request a storyboard gate, do not
insert another approval gate merely because the pipeline is storybook.

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

For a storybook job, `succeeded` is necessary but not sufficient for delivery.
Before claiming acceptance, inspect the project-root `acceptance.json` through the
verified `/data/worker` → `/videos-v2` mapping and require it to be current and
valid. Also inspect `.hyperframes/storybook-audit.json` and
`.hyperframes/storybook-audit/contact.json`, then inspect the single required
`.hyperframes/storybook-audit/visual-review.json`. It must have
`kind:"hyperframes-storybook-visual-review"`, `verdict:"approved"`, a
`sourceDigest` matching the current audit evidence digest, only evidence files
emitted by that audit, and one substantive observation for every internal shot
(style, continuity, acting, captions). The contact report remains
`review-required`: report visual review separately because machine acceptance
cannot certify aesthetic quality. A missing, stale, failed, or unreviewed
artifact is a delivery issue, not a reason to pretend the job failed or to
submit a replacement.

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

Split distinct parts into 30–90s API scenes. A storybook API scene may contain
multiple internal shots; do not create one API scene per shot or report internal
shot count as API scene count. Use the same authenticated API:
- For storybook requests with supplied files, use the project workflow: the
  one-shot route cannot upload an asset before it creates its scene. Upload every
  real character/background asset **before** adding/building that scene.
- `POST /v1/projects {"name":"...","pipeline":"hyperframes-storybook","brief":"...","spec":{...}}`; `GET /v1/projects/<id>` lists scenes/versions/assets/final`.
- Upload raw bytes: `POST /v1/projects/<id>/assets?name=character.png&tags=character` with `--data-binary @/path/to/character.png` (≤200MB, content-deduplicated); then reference the returned asset ID/name in `assets`. Upload recurring backgrounds the same way with a `background` tag.
- `POST /v1/projects/<id>/scenes {"topic":"...","durationSec":45,"assets":["character.png","room.webp"],"findAssets":false}`; then `POST /v1/scenes/<id>/build {"metadata":{"chat":"..."}}`.
- Never use a host path or `metadata.localProjectDir` as an asset reference. Metadata does not transfer files. For storybook, choose supplied/reusable artwork first; set `findAssets:true` only when the user requests authorized asset sourcing, and never substitute fake placeholders.
- `PUT /v1/projects/<id>/timeline {"order":["scn_a","scn_b"],"transitions":{"scn_b":"fade"}}`; default hard cut, fade up to 0.5s into the named scene.
- `POST /v1/projects/<id>/stitch {"metadata":{"chat":"..."}}` needs current rendered versions for every timeline scene. Stitch again after revisions to refresh the final.
- `PATCH /v1/projects/<id>` merges spec fields. Delete via `/v1/projects/<id>`, `/v1/scenes/<id>`, `/v1/projects/<id>/assets/<assetId>`; conflicting active work blocks deletion.
- For technical explainers, upload user files and select them in `assets`. Set `findAssets:true` only for requested/needed real-world imagery (credits recorded); otherwise follow the explainer skill's visual rules.

Jobs queue according to configured concurrency; do not promise sequential timings.

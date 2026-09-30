---
name: omp-video
description: Make a narrated technical explainer video (MP4) by handing the job to the omp agent on the host. Use when the user asks for an explainer, concept, or tutorial video, a multi-part video, or a revision of one.
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

Video production does not run here. It runs in **omp** on the host, behind an HTTP API (`/v1`). omp uses the HyperFrames `faceless-explainer` workflow: storyboard, Kokoro voice-over, captions, parallel frame workers, render. Your job: turn the request into a job, hand over progress, deliver the result.

Environment: `$OMP_BRIDGE_URL`, `$OMP_BRIDGE_TOKEN`. Use `H="Authorization: Bearer $OMP_BRIDGE_TOKEN"`. Finished files are read-only under `/videos-v2/` (host `/home/thangnc/general/omp-videos-v2/`). Webhook paths are rewritten to `/videos-v2/...`; API responses use host paths, so replace `/home/thangnc/general/omp-videos-v2/` with `/videos-v2/` before reading files here. Older videos map `/home/thangnc/general/omp-videos/` to `/videos/`.

All errors look like `{"error":{"code","message"}}`; 400 messages name the bad field and list allowed values.

## Concepts
- **Project** → **scenes** → **versions**. A one-off video is a project with one scene (`POST /v1/videos` creates all three plus the build job).
- A **job** does one thing: `build` (make a scene version), `revise`, `render` (render a previewed version), `stitch` (join scenes). States: `queued`, `running`, `awaiting_approval`, `succeeded`, `failed`, `rejected`, `cancelled`.
- Every revision makes a **new version**; older versions stay. `POST /v1/scenes/<id>/use {"versionId"}` rolls back.
- Progress arrives as webhook events (`job.started`, `job.awaiting_approval`, `job.succeeded`, `job.failed`, `job.rejected`, `job.cancelled`, `job.resumed`). The event carries the `metadata` you set on submit. If you get no event, poll `GET /v1/jobs/<id>` (at most every 2 minutes).

## 1. Decide the job spec

Pick the spec yourself from the user's request, the platform and the audience. Ask the user only if they explicitly want to choose. In the confirmation message, state what you chose and why (one line).

**style**, a HyperFrames preset. The live list comes from `GET $OMP_BRIDGE_URL/v1/catalog` (`pipelines[0].options.style`); use it if a name below is rejected.

| Preset | Look | Good for |
|---|---|---|
| `code-editorial` | cream paper, ink, coral accent, serif + mono, code panels | programming, CS concepts (safe default for dev topics) |
| `editorial-forest` | literary serif, mono chrome, calm | architecture, deep-dive, "why" essays |
| `cartesian` | museum catalog, 1px hairlines, very quiet | theory, math-ish, elegant minimal |
| `blue-professional` | cream + one cobalt, consulting deck | business, metrics, product, cloud cost |
| `cobalt-grid` | risograph cobalt on graph paper | data, research, trend reports |
| `bold-poster` | vintage sports poster, tomato red, heavy display | punchy hooks, opinions, social clips |
| `broadside` | protest poster, giant words | manifesto, one strong claim, short reels |
| `coral` | coral/ink/cream color blocks | marketing, launch, high-energy |
| `creative-mode` | neo-brutalist, four colliding accents | creative/design topics, youthful |
| `blockframe` | neobrutalist, black borders, hard shadows | playful tech, hackathon, startup |
| `capsule` | everything is a pill, friendly | beginners, onboarding, product how-to |
| `daisy-days` | kawaii picture book, pastel | kids, very gentle intros |
| `biennale-yellow` | art-catalog, indigo ink, solar yellow | culture, history, design theory |

Use `auto` to let omp decide. Prefer choosing yourself, since you know the user and the channel.

**format**: `landscape` (1920x1080; YouTube, docs, slides), `portrait` (1080x1920; TikTok, Reels, Shorts), `square` (1080x1080; LinkedIn/X feed). Match the platform the user mentions. Default is landscape.

**voice**: an English Kokoro voice. `am_michael` (default, warm male US), `af_heart` / `af_bella` (female US), `am_adam` (deeper male US), `bf_emma` / `bm_george` (British). Narration is English only. If the user wants Vietnamese, say it is not supported yet.

**durationSec**: 15–180, default 50. Reels/Shorts ~30; a concept explainer 45–75; a tutorial up to 120–180.

**audience** / **tone**: short phrases, e.g. `"junior backend devs"` / `"clear, friendly, technical"`.

## 2. Submit a video

```bash
python3 - <<'EOF' > /tmp/job.json
import json
print(json.dumps({
  "topic": "Hash tables and collision handling",
  "brief": "cover hash(key)%N, chaining, load factor resize",
  "durationSec": 45,
  "spec": {"style": "code-editorial", "format": "landscape", "voice": "am_michael", "audience": "junior devs", "tone": "clear, friendly, technical"},
  "metadata": {"chat": "<where to report, copy it from the conversation>"}
}))
EOF
curl -s -X POST "$OMP_BRIDGE_URL/v1/videos" -H "$H" -H "Content-Type: application/json" --data @/tmp/job.json
# -> {"project":{"id":...},"scene":{"id":"scn_..."},"job":{"id":"job_..."},"version":{"id":"ver_..."}}
```

Always build the JSON with `json.dumps`. Never hand-concatenate user text into JSON.

Optional job fields: `"approve":"storyboard"` (stop after the storyboard for the user's OK, see section 3), `"render":false` (everything except the final render; see section 3), `"limits":{"maxUsd":5,"maxMinutes":60}`. Preview still incurs the storyboard, voice, frame and verification costs; do not promise a fixed speedup.

Tell the user right away what spec you chose and that a video takes ~12-20 minutes. Keep `job.id`, `scene.id`, `project.id`.

## 3. Cheaper flows

- **Storyboard approval.** Use it for long or important videos, or when the user wants control over content. Submit with `"approve":"storyboard"`. On `job.awaiting_approval`, GET `/v1/jobs/<id>`, translate `version.projectDir` to its container path, read `STORYBOARD.md` and `SCRIPT.md`, and show the user a short summary. Only after the user approves, POST `/v1/jobs/<id>/approve {"notes":"changes to apply"}`. A webhook notification is not approval. No answer from the user for a long time is fine: the job waits.
- **Preview first.** Submit with `"render":false`; the result has a contact sheet but no MP4. After the user likes it: `POST /v1/versions/<version id>/render` → a `render` job (no LLM; time depends on the composition and host).

## 4. Deliver

On `job.succeeded`, `job.result` holds `{versionId, video, contactSheets[], durationSec, notes}`. Translate host paths returned by the API before accessing them. Send the user **both** the MP4 (when present) and the contact sheet(s), plus `durationSec` and `usage.usd`. Native render results omit contact sheets: fetch `/v1/versions/<versionId>` and use `version.outputs.contactSheets`. **Always put the ids in the caption**, e.g. `🎬 Why HTTPS is safe · scene scn_ab12 · ver_cd34 · frames numbered on the sheet`; this is how later revisions find the video.

On `job.failed`, report `job.error.message`. Logs: `<version workdir>/omp.jsonl` and `omp.stderr.log` (`GET /v1/jobs/<id>` → `version.workdir`). Do not resubmit automatically. `job.resumed` means the bridge restarted and the job continues by itself; no action.

### Webhook delivery

The owner must grant `terminal`, `file`, and `skills` to this route's `toolsets` in `webhook_subscriptions.json`; the default webhook tools cannot access the bridge. Never self-grant tools. Use terminal `curl` with `$OMP_BRIDGE_URL` and `$OMP_BRIDGE_TOKEN`, not web extraction or guessed localhost ports. Never print the token.

Webhook cross-platform forwarding is text-only. To deliver actual attachments to this route's configured Telegram home channel, verify each container path is readable and use the supported standalone sender. In this Docker deployment, the agent terminal PATH omits the CLI directory, so use `/opt/hermes/bin/hermes`:

```bash
/opt/hermes/bin/hermes send --to telegram --json "Scene <scene id> · version <version id>
MEDIA:/videos-v2/<actual MP4 path>
MEDIA:/videos-v2/<actual contact sheet path>"
```

Omit the MP4 line for previews. Resolve missing contact sheets from the version endpoint. Check both `success` and `warnings` in the sender's JSON: `success:true` may mean text/video was sent while another attachment failed. Claim delivery only for attachments without failures; report unreadable files, do not retry the whole bundle and duplicate the video. Do not make new build/render/approval requests merely because a webhook arrived. The final webhook response should summarize the event and confirmed delivery without repeating media directives.

## 5. Revise

Find the scene id from the message the user replies to, or the conversation, or `GET /v1/projects` then `GET /v1/projects/<id>` (scenes with versions and their contact sheets). Several candidates: show their contact sheets and ask. Never guess between two videos.

Write concrete per-frame instructions using the contact-sheet numbering. If the user is vague, ask what to change first.

```bash
python3 - <<'EOF' > /tmp/rev.json
import json
print(json.dumps({"instructions": "Frame 5: the MALWARE and UNSAFE SITE pills overlap; space the three pills evenly.", "frames": [5], "metadata": {"chat": "..."}}))
EOF
curl -s -X POST "$OMP_BRIDGE_URL/v1/scenes/<scene id>/revise" -H "$H" -H "Content-Type: application/json" --data @/tmp/rev.json
```

- Revises the scene's **current** version by default; add `"fromVersionId"` to branch from an older one.
- Length: `"durationSec": 20` (10-300), with or without instructions. Without a number, use about +-30%.
- Expected time: captions ~2-4 min; visuals ~4-7; narration ~6-9; length +-12% ~6-9; bigger length change ~8-14.
- New style/format, adding or removing frames, different angle: the job ends `rejected` with the reason. Tell the user and offer a new video.

## 6. Cancel

`POST /v1/jobs/<id>/cancel` (optional `{"reason"}`). Running jobs stop within ~10 s and end `cancelled` (webhook `job.cancelled`). 409 `job_finished` = nothing to cancel. A cancelled build leaves no video and its version is `failed`; never revise it.

## 7. Multi-scene projects and assets

Use when the total length is > ~90 s, the user describes distinct parts, or wants their own images/logo. Split into 30-90 s scenes, one idea each.

```bash
B="$OMP_BRIDGE_URL"
curl -s -X POST "$B/v1/projects" -H "$H" -H "Content-Type: application/json" --data @/tmp/project.json
#   {"name":"Caching 101","brief":"series on caching","spec":{"style":"code-editorial","format":"landscape","voice":"am_michael"}}
curl -s -X POST "$B/v1/projects/<id>/assets?name=company-logo.png&tags=logo" -H "$H" --data-binary @/path/to/logo.png   # raw body, <=200 MB, deduped by content
curl -s -X POST "$B/v1/projects/<id>/scenes" -H "$H" -H "Content-Type: application/json" --data @/tmp/scene.json
#   {"title":"Why cache","topic":"Why caching speeds up reads","brief":"...","durationSec":45,"assets":["company-logo.png"],"findAssets":false}
curl -s -X POST "$B/v1/scenes/<scene id>/build" -H "$H" -H "Content-Type: application/json" -d '{"metadata":{"chat":"..."}}'   # per scene
curl -s "$B/v1/projects/<id>" -H "$H"        # scenes+versions, assets, project.final
curl -s -X PUT "$B/v1/projects/<id>/timeline" -H "$H" -H "Content-Type: application/json" -d '{"order":["scn_b","scn_a"],"transitions":{"scn_b":"fade"}}'
curl -s -X POST "$B/v1/projects/<id>/stitch" -H "$H" -H "Content-Type: application/json" -d '{"metadata":{"chat":"..."}}'
```

- Transitions default to hard cuts; `"fade"` on a scene means a 0.5 s crossfade into it.
- Stitch needs every scene in the timeline to have a rendered video (409 `scenes_not_ready` lists which). Deliver `job.result.video`. After revising a scene, stitch again.
- Remove: `DELETE /v1/scenes/<id>`, `DELETE /v1/projects/<id>/assets/<assetId>`, `DELETE /v1/projects/<id>` (409 if a job is active). Edit: `PATCH /v1/projects/<id>` (spec fields merge).
- One scene per project runs at a time; different scenes queue and run one after another (~12-15 min each). Tell the user the estimated total and send each scene's contact sheet as it finishes.
- Assets policy: user's files → upload and list in `assets`. If the user asks you to find pictures, or the topic needs real-world imagery, set `findAssets: true` (credits are recorded per asset). Otherwise false: the AI draws visuals in code.

## Pitfalls
- One job runs at a time; extra jobs queue.
- `/videos-v2` is read-only; copy a file before modifying it.
- Do not render with HyperFrames in this container. The host owns the pipeline.

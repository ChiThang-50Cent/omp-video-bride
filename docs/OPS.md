# Operations runbook

This runbook covers the host systemd deployment, stopped SQLite/artifact
backups, restore, upgrades, rollback, retention, and webhook dead letters. It
also records the boundaries of the separate Docker recipe.

## Operating invariants

1. **One bridge process owns one data directory.** Do not run `npm start`, a
   second systemd unit, or a second container against the same directory.
   SQLite uses WAL and the application dispatcher writes the webhook outbox;
   two writers make backup and recovery assumptions unsafe.
2. **The database and artifacts move together.** The database stores absolute
   paths to project files, sessions, rendered videos, contact sheets, and
   captions. `dataDir` and every backup/restore path must be absolute. A
   restore to a different absolute path is not a path migration; old rows and
   packets still refer to the original path.
3. **Stop before copying.** A filesystem copy of a live WAL database is not a
   consistent application backup. Drain/cancel work as appropriate, stop the
   bridge, then use `deploy/backup.mjs --stopped`. The flag is an explicit
   operator acknowledgement; the tool does not stop or inspect a service for
   you.
4. **No automatic destructive cleanup.** The bridge does not prune old jobs,
   sessions, versions, projects, rollback history, or media. Keep enough space
   for active work and backups, and make every deletion a reviewed manual
   change.

The checked-in implementation contract, state transitions, path layout, and
Docker notes are in [`SPEC.md`](SPEC.md). The host installer validates the
actual `src/config.ts` schema; it is not a second configuration parser.

## Accounts, paths, permissions, and secrets

A typical host layout is:

```text
/opt/omp-video-bridge/                 # checkout, owned/readable by bridge
/etc/omp-video-bridge/config.json      # service config, no group/world write
/etc/omp-video-bridge/token             # bearer token, mode 0600
/var/lib/omp-video-bridge/              # dataDir, owned by bridge
/var/backups/omp-video-bridge/          # private stopped backups
```

Choose paths appropriate for the host; the names above are examples, not
required locations. Do not use a path from a workstation, a relative path, or
a path inside the Git checkout for production data/secrets. Configured
`omp.bin`, `HYPERFRAMES_BROWSER_PATH`, and `HYPERFRAMES_PYTHON` paths must be
real executable files. `ffmpeg` and `ffprobe` must be available in the service
PATH. An enabled webhook secret must be unique and non-placeholder.

Prepare an unprivileged account and private directories before installation:

```sh
sudo install --directory --owner=bridge --group=bridge --mode=0755 /opt/omp-video-bridge
sudo install --directory --owner=bridge --group=bridge --mode=0750 /etc/omp-video-bridge
sudo install --directory --owner=bridge --group=bridge --mode=0750 /var/lib/omp-video-bridge
sudo install --directory --owner=bridge --group=bridge --mode=0700 /var/backups/omp-video-bridge
sudo install --owner=bridge --group=bridge --mode=0600 /dev/null /etc/omp-video-bridge/token
```

Generate a token without printing it into shell history or logs:

```sh
sudo -u bridge node -e 'require("node:fs").writeFileSync("/etc/omp-video-bridge/token", require("node:crypto").randomBytes(32).toString("hex")+"\n", { mode: 0o600 })'
sudo chmod 600 /etc/omp-video-bridge/token
```

Edit `/etc/omp-video-bridge/config.json` with the real absolute paths and
`host: "127.0.0.1"` unless an authenticated network listener is explicitly
required. Keep webhook secrets in the private config or an equivalent private
secret-management layer. Do not commit config, token, provider credentials,
SQLite files, media, or Docker state.

### Sharing host artifacts with a different UID

Published media and approval documents use mode `0644`, but their containing
directories must also be traversable by the reader. The host unit uses
`UMask=0077`; file permissions alone do not make new job directories accessible.
For a read-only Hermes bind mount, provision a POSIX default ACL **before the
first job**, on a filesystem supporting ACLs (`setfacl` requires the host's ACL
tools):

```sh
sudo chmod o+x /var/lib/omp-video-bridge
sudo setfacl --modify default:user::rwx,default:group::---,default:other::--x /var/lib/omp-video-bridge
```

This gives new directories traversal without directory listing. Regular files
created with mode `0666` remain `0600`; the bridge explicitly publishes selected
artifacts as `0644`. Explicitly private `0600` files remain unreadable by the
other UID. Bind-mount only the intended data directory **read-only**, not token,
provider-state or configuration directories. A host reader outside a bind mount
also needs traversal through the configured path's ancestors.

For existing data, audit and grant traversal only to the containing directories
of intended published artifacts. Do not apply recursive `chmod` to sessions,
credentials or the entire data tree. Docker's separately provisioned shared-state
permissions are described in the Docker section; this ACL procedure is for the
private host service.

## Portable systemd installation

`deploy/install.sh` separates validation/preview from installation:

- `--check-only` performs no writes and does not call systemd. It loads the
  real Zod schema from `src/config.ts`, checks supported Node, private/nonempty
  token, executable OMP/provider paths, FFmpeg tools, and placeholder webhook
  secrets.
- `--print-unit` performs the same validation and prints a rendered unit to
  stdout, without writing files or calling systemd. Review it before installing.
- Install mode renders `deploy/omp-video-bridge.service`, installs it under
  `/etc/systemd/system/`, and runs `systemctl daemon-reload`. It requires the
  operator to invoke it as root (normally with `sudo`); it never invokes sudo.
  It does **not** enable/start/restart production unless those flags are
  explicitly supplied.

Run the check as the target account first:

```sh
sh /opt/omp-video-bridge/deploy/install.sh --check-only \
  --user bridge \
  --repo /opt/omp-video-bridge \
  --node /usr/bin/node \
  --config /etc/omp-video-bridge/config.json
```

To preview the exact unit before any privileged action:

```sh
sh /opt/omp-video-bridge/deploy/install.sh --print-unit \
  --user bridge --repo /opt/omp-video-bridge --node /usr/bin/node \
  --config /etc/omp-video-bridge/config.json
```

After reviewing the result, render/install the unit as an explicit operator
action:

```sh
sudo sh /opt/omp-video-bridge/deploy/install.sh \
  --user bridge \
  --repo /opt/omp-video-bridge \
  --node /usr/bin/node \
  --config /etc/omp-video-bridge/config.json
sudo systemctl enable --now omp-video-bridge.service
```

The final command is intentionally outside the installer's default action.
For a planned restart, use `--restart`; for a first start use `--start`; for
boot enablement use `--enable`. Review `systemctl cat omp-video-bridge` and
`systemctl status omp-video-bridge` after any explicit action. The unit has no
Docker dependency and does not assume a particular home directory, Node
manager, checkout path, or data path.

## Stopped, consistent backup and restore

The offline tools use only Node's built-in `node:sqlite` and the host `tar`.
They do not install packages, stop services, copy secrets, or overwrite an
existing archive/destination.

### Backup procedure

The following is an exact host procedure. Replace only the variables with the
actual installation values. It saves config/token separately because those
files contain secrets and are deliberately not put in the data archive.

```sh
set -eu
SERVICE=omp-video-bridge.service
SERVICE_USER=bridge
REPO=/opt/omp-video-bridge
NODE=/usr/bin/node
DATA_DIR=/var/lib/omp-video-bridge
CONFIG=/etc/omp-video-bridge/config.json
TOKEN=/etc/omp-video-bridge/token
BACKUP_DIR=/var/backups/omp-video-bridge
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ARCHIVE="$BACKUP_DIR/data-$STAMP.tar.gz"

sudo install --directory --owner="$SERVICE_USER" --group="$SERVICE_USER" --mode=0700 "$BACKUP_DIR"
sudo systemctl stop "$SERVICE"
# A successful stop is not enough if another process was started manually.
if sudo systemctl is-active --quiet "$SERVICE"; then
  echo "bridge is still active; refusing backup" >&2
  exit 1
fi
# The explicit --stopped acknowledgement is required by the tool.
sudo -u "$SERVICE_USER" "$NODE" "$REPO/deploy/backup.mjs" --stopped "$DATA_DIR" "$ARCHIVE"
# Secret-bearing files are separate, private recovery inputs.
sudo install --owner="$SERVICE_USER" --group="$SERVICE_USER" --mode=0600 "$CONFIG" "$BACKUP_DIR/config-$STAMP.json"
sudo install --owner="$SERVICE_USER" --group="$SERVICE_USER" --mode=0600 "$TOKEN" "$BACKUP_DIR/token-$STAMP"
# Check the archive has the root DB before allowing service restart.
sudo tar -tzf "$ARCHIVE" | grep -qx './bridge.db'
sudo systemctl start "$SERVICE"
sudo systemctl --no-pager --full status "$SERVICE"
```

The archive contains the entire `DATA_DIR` tree, including `bridge.db`,
SQLite sidecars if any, projects, sessions, logs, and rendered artifacts. The
backup tool checkpoints/truncates WAL, refuses a nonzero checkpoint-busy result,
and runs SQLite `integrity_check` before tarring. It validates that the tree
contains only regular files/directories: symlinks, devices, FIFOs, sockets,
control-character/backslash names, and other special entries are refused;
legitimate hardlinks are copied as independent regular files. The resulting
archive is mode `0600`. It also refuses a relative path, missing database,
archive inside the source directory, or existing output archive. Keep the
archive and its config/token companions private; rotate a token rather than
publishing a backup.

If the service cannot be stopped, do not remove `--stopped` or copy the live
files anyway. Schedule a maintenance window. Imported v1 projects are only
references to their original files; back up and retain that old v1 mount
separately.

### Restore into a fresh path

Restore is intentionally non-overwriting. The destination must not exist. Move
an old directory aside first so it remains available for rollback; never point
the restore command at a populated directory.

```sh
set -eu
SERVICE=omp-video-bridge.service
SERVICE_USER=bridge
REPO=/opt/omp-video-bridge
NODE=/usr/bin/node
DATA_DIR=/var/lib/omp-video-bridge
BACKUP=/var/backups/omp-video-bridge/data-20260930T120000Z.tar.gz
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OLD_DATA="${DATA_DIR}.before-restore-$STAMP"

sudo systemctl stop "$SERVICE"
if sudo systemctl is-active --quiet "$SERVICE"; then
  echo "bridge is still active; refusing restore" >&2
  exit 1
fi
# Keep the old tree; do not delete it until verification and a retention review.
sudo mv -- "$DATA_DIR" "$OLD_DATA"
sudo -u "$SERVICE_USER" "$NODE" "$REPO/deploy/restore.mjs" --stopped "$BACKUP" "$DATA_DIR"
sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
```

The restore tool first validates every archive member (absolute/traversal
names, duplicate paths, links, devices, FIFOs, and hard links are rejected),
extracts to a temporary sibling, checks that root `bridge.db` is regular, runs
SQLite `integrity_check`, and atomically renames the prepared directory. It
rejects an existing destination even when it is nonempty; this prevents an
archive from silently overwriting live or rollback data.

Run this concrete verification before starting the service:

```bash
sudo -u "$SERVICE_USER" env DATA_DIR="$DATA_DIR" "$NODE" --input-type=module <<'NODE'
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.DATA_DIR;
const db = new DatabaseSync(join(dir, "bridge.db"), { readOnly: true });
try {
  const integrity = db.prepare("PRAGMA integrity_check").get();
  if (Object.values(integrity ?? {})[0] !== "ok") throw new Error(`integrity_check=${JSON.stringify(integrity)}`);
  const version = Number(Object.values(db.prepare("PRAGMA user_version").get() ?? {})[0] ?? 0);
  if (version < 2) throw new Error(`unexpected schema user_version=${version}`);
  const counts = db.prepare("SELECT (SELECT COUNT(*) FROM projects) AS projects, (SELECT COUNT(*) FROM jobs) AS jobs, (SELECT COUNT(*) FROM outbox WHERE state='dead') AS dead").get();
  if (Number(counts.projects) > 0 && !existsSync(join(dir, "projects"))) throw new Error("projects rows exist but projects/ is missing");
  console.log(JSON.stringify({ integrity: "ok", user_version: version, ...counts }));
} finally {
  db.close();
}
NODE
sudo systemctl start "$SERVICE"
curl --fail http://127.0.0.1:8765/v1/health
curl --fail --header @<(sudo cat "$TOKEN" | tr -d '\r\n' | {
  IFS= read -r token || test -n "$token"
  printf 'Authorization: Bearer %s\n' "$token"
}) http://127.0.0.1:8765/v1/catalog
```

Expected verification includes `integrity:"ok"`, `user_version` at least `2`,
JSON counts, a successful health response, and an authenticated catalog
response. If any check fails, stop the service, preserve both trees, and
restore the old path; do not overwrite the failed tree.

The archive does not contain config, token, provider credentials, webhook
secret, or an imported v1 mount. Restore those from the private companion
files or re-create them, then rerun the installer `--check-only` before
starting. If the restore target changes absolute path, plan a separate,
reviewed path migration; do not search-and-replace database JSON blindly.

## Upgrade and rollback

SQLite migrations run when the application opens `bridge.db`. Migrations are
append-only in `src/adapters/store-sqlite/migrations.ts`; a newer checkout can
advance `PRAGMA user_version`, and an older checkout may not understand that
schema. Treat a migration as a one-way compatibility boundary until the
release explicitly says otherwise.

Recommended upgrade sequence:

1. Read `docs/CHANGELOG.md` and the release's verification limits. Confirm
   Node, OMP, provider, FFmpeg, and disk-space prerequisites.
2. Keep the current checkout and data path intact. In a separate checkout,
   run `npm ci`, `npm run check`, and any release-specific smoke command; do
   not run a new code checkout against production data while the old service
   is live.
3. Stop the service and make the stopped backup above, including private
   config/token companions. Verify the archive listing.
4. Install the new checkout/config with `deploy/install.sh --check-only`, then
   render the unit. Review the rendered unit and config paths.
5. Start explicitly, inspect `journalctl -u omp-video-bridge`, query health and
   authenticated catalog, and submit no paid/production job until these pass.
6. Keep the backup and old checkout until a retention review. Do not delete
   rollback history immediately after a successful migration.

If startup or verification fails after a migration:

```sh
sudo systemctl stop omp-video-bridge.service
sudo mv /var/lib/omp-video-bridge /var/lib/omp-video-bridge.failed-$(date -u +%Y%m%dT%H%M%SZ)
# Restore to a new, absent /var/lib/omp-video-bridge with restore.mjs as above.
# Select the previously verified checkout, render its unit, then:
sudo systemctl start omp-video-bridge.service
```

Never restore over a directory in place, downgrade code onto a migrated DB
without compatibility evidence, or delete the failed tree before logs and
verification are collected. If an old checkout is required, point the unit at
that checkout using the explicit installer options and rerun `--check-only`.

## Retention and manual cleanup

There is no automatic destructive retention policy. Before deleting anything:

- ensure no job for the project is `queued`, `running`, `awaiting_approval`, or
  `interrupted`; cancel/drain it through the authenticated API;
- verify the project/version is not needed for rollback, audit, or imported-v1
  playback;
- take a stopped backup and record the project IDs, paths, and operator;
- prefer the authenticated `DELETE /v1/projects/:id` or asset-delete API,
  which enforces active-job/reference rules, rather than `rm -rf` on a project;
- remove old backup archives only after an independent newer backup has been
  verified and the retention decision is documented.

Do not prune `bridge.db`, `sessions/**/*.jsonl`, a version workdir, or an
artifact directory by age alone. Database rows, session packets, and output
paths are coupled. If disk pressure requires emergency action, stop the
service, preserve a backup, and make a narrowly scoped manual deletion with a
rollback plan.

## Manual job resumption

Manual resumption is an explicit, authenticated continuation of the same job,
not a generic retry. It supports `build`, `revise`, `render`, and `stitch` only
when the saved state is `failed`, `cancelled`, or `interrupted`. A failure
notification or webhook never authorizes it; an explicit user request can.
Operations must not create a fresh job as a fallback.

Before calling `POST /v1/jobs/<id>/resume`, inspect the exact saved ID with
`GET /v1/jobs/<id>?events=1` and obtain explicit user authorization. Confirm
the project/scene/version references, current version/timeline inputs, and that
the target is absent from the local running map. For build/revise, verify the
original workdir and main session; revise also needs its copied project
directory. Render requires the original ready preview/project
directory with no video; stitch revalidates its current timeline/scenes. No
conflicting scene/project work may be active; a project stitch conflicts with
any work in that project. Deleted references, ready-version overwrites, stale
render inputs, and missing required data must fail closed without mutation.
If a failed/cancelled job may be resumed later, retain its referenced records,
workdir, and (for build/revise) main session, plus the worker/session usage
logs used to account cumulative totals; deletion makes it unavailable and
must not be repaired by recreating or guessing a reference.

Do not edit or delete referenced workdirs, session files, or usage logs while
the bridge/worker is live; out-of-band filesystem mutation during a job is not
a supported recovery mechanism. Drain/stop first, then preserve the saved
state and inspect it through the authenticated API.
`resume_unavailable` identifies missing/mismatched project, scene, version,
timeline, revision parent, newer ready version, required omp workdir/main
session, or incomplete persisted usage history; an unknown job ID retains
normal `not_found`. `budget_exhausted` means cumulative USD reached the
effective total. `job_busy`, `scene_busy`, `project_busy`, and
`already_rendered` identify local-target, same-scene, project, and duplicate
native-render conflicts respectively. These are rejected before mutation.

Use `{}` to reuse old limits or replace only explicitly supplied fields:
`maxMinutes` is positive and at most 240, and `maxUsd` is positive and at most
50. Usage/tokens remain cumulative. If cumulative USD has exhausted the old
limit, an explicit higher **total** `maxUsd` is required; the bridge watcher
is not a hard provider billing cap. Native render/stitch jobs keep `maxUsd: 0`,
reject USD edits with `400 invalid_request`, never invoke omp, and do not add a
native time watcher. Build/revise continuation can incur paid provider usage.

An accepted request returns `200 {job}` with the same ID and records a
`manual_resume` history event; the continuation emits `job.resumed`. Automatic
restart recovery is separate: it is limited to two attempts and retains the
original time window, while manual resume alone opens a fresh time window.
Inspect/poll the same job ID after either event; never retry from a notification.

## Webhook dead letters and replay

Webhook delivery is transactional and at-least-once. The bridge stores the
payload and stable `event_id` in SQLite, retries at 10 seconds, 1 minute,
5 minutes, and 30 minutes, then marks a row `dead`. Receiver failures do not
roll back the completed video job.

1. Check `GET /v1/health` for `pending`/`dead` counts and inspect
   `journalctl -u omp-video-bridge` for connection, HTTP, and timeout errors.
2. Fix the receiver first: verify Hermes is listening on the configured URL,
   its HMAC secret matches, the host/container mount mapping is correct, and
   the receiver accepts `X-Webhook-Signature-V2`, timestamp, and stable
   `X-Request-ID`. Do not rotate the secret without coordinating both sides.
3. List dead rows without printing private payloads:

   ```sh
   sudo -u bridge /usr/bin/node /opt/omp-video-bridge/tools/outbox.ts \
     list --db /var/lib/omp-video-bridge/bridge.db --limit 50
   ```

4. Stop the bridge dispatcher before replay. Select only IDs whose receiver
   is ready, and acknowledge the stopped state explicitly. The operation is
   atomic and allows at most 100 distinct IDs:

   ```sh
   sudo systemctl stop omp-video-bridge.service
   sudo -u bridge /usr/bin/node /opt/omp-video-bridge/tools/outbox.ts \
     redrive --db /var/lib/omp-video-bridge/bridge.db \
     --ids 12,13 \
     --stopped
   sudo systemctl start omp-video-bridge.service
   ```

   Use the same service user or appropriate DB permissions. The tool resets
   delivery timing/attempts, preserves payload and `event_id`, refuses rows
   that are not currently dead, and makes no change if any selected ID is
   invalid.
5. Confirm the receiver deduplicates by `event_id`. A redrive may produce a
   duplicate HTTP delivery by design; it must not create a duplicate external
   job or Telegram send. Inspect health and receiver logs after restart.

Do not edit outbox rows with ad-hoc SQL or replay every dead row blindly.
Outbox redrive is separate from job continuation; `/v1/jobs/:id/resume` is the
explicit manual-resume endpoint, not an automatic or generic retry.

## Docker isolated deployment

The repository Docker recipe is an additional, externally stateful deployment
for Linux/amd64. It uses Docker Compose v2, external `OMP_VIDEO_STATE_DIR`,
loopback host publications, pinned runtime inputs, and separate worker/Hermes
state. It is not a live migration of a systemd data directory. The detailed
image, state, asset, and webhook contract remains in
[`SPEC.md`](SPEC.md#61-repository-docker-deployment-linuxamd64); this section is
the operator runbook around that contract.

### Shared shell context

Set these values once in the shell that runs every Compose command. Keep the
checkout at this path while the services use its bind-mounted
`hermes-skill/omp-video/SKILL.md`; do not move, rename, or delete that checkout
until the Compose project has been stopped and replaced from the new checkout.
The state directory is outside Git and the host ports are loopback-only:

```bash
export OMP_VIDEO_REPO="$HOME/code/omp-video-bridge"
export OMP_VIDEO_STATE_DIR="$HOME/.local/state/omp-video-bridge-docker"
export COMPOSE_PROJECT_NAME=omp-video-bridge
export OMP_VIDEO_HTTP_PORT=18765
export OMP_VIDEO_WEBHOOK_PORT=28644
export BRIDGE_URL="http://127.0.0.1:$OMP_VIDEO_HTTP_PORT"
function dc(){ docker compose -f "$OMP_VIDEO_REPO/deploy/compose.yaml" "$@"; }
cd "$OMP_VIDEO_REPO"
test -f "$OMP_VIDEO_REPO/deploy/compose.yaml"
test -f "$OMP_VIDEO_REPO/hermes-skill/omp-video/SKILL.md"
```

Never put a bearer token, provider credential, Telegram token, webhook secret,
or Hermes API key in a command argument, shell transcript, log, screenshot, or
committed file. The shared [setup guide](SETUP.md#docker-onboarding) defines `bridge_api` without
putting the token in the curl argument list. If this section is being run
without that context, define the same helper in Bash:

```bash
bridge_api() {
  curl --silent --show-error --fail-with-body \
    --header @<(printf 'Authorization: Bearer %s\n' \
      "$(tr -d '\r\n' < "$OMP_VIDEO_STATE_DIR/secrets/bridge-token")") \
    "$@"
}
```

The process-substitution header is ephemeral and the token is never typed into
the command. Do not inline the header value in curl arguments on a shared host:
it can then be visible in process inspection.

### Status, logs, and readiness

Use Compose service names, not container IDs or guessed names. The build and
bootstrap services are `worker-runtime`, `init-state`, and `init-assets`; the
long-running services are `video-worker` and `hermes`:

```sh
dc ps --all worker-runtime init-state init-assets video-worker hermes
dc ps --status running video-worker hermes
# Read logs through the redaction filter below; do not paste raw log output.
```

Logs are operational input, not a secret-safe artifact. Before sharing a
redacted excerpt, use a filter that removes common credential forms and still
inspect the unshared original only on the private host:

```sh
redact_logs() {
  sed -E \
    -e 's/(Authorization:[[:space:]]*Bearer[[:space:]]+)[^[:space:]]+/\1[REDACTED]/Ig' \
    -e 's/((token|secret|password|api[_-]?key)[=:][[:space:]]*)[^[:space:],"]+/\1[REDACTED]/Ig'
}
dc logs --tail=200 --no-color video-worker 2>&1 | redact_logs
dc logs --tail=200 --no-color hermes 2>&1 | redact_logs
```

`video-worker`'s green health check only proves that
`GET /v1/health` answers. Hermes's green health check only proves its local
HTTP health endpoint answers. Neither proves provider OAuth, model access,
Telegram polling, Telegram chat permissions, webhook delivery, or readiness to
spend on a video. Check the public health endpoint and then an authenticated
catalog without printing the token:

```sh
curl --fail --silent --show-error "$BRIDGE_URL/v1/health"
bridge_api "$BRIDGE_URL/v1/catalog"
```

Recreate the `bridge_api` process substitution after a token rotation.
`/v1/health` is intentionally public, while `/v1/catalog` and all
state-changing routes require the exact `Authorization: Bearer <token>` form.

### Drain and stop before state or asset changes

There is no bulk drain command and no automatic cancellation policy. Before
editing `worker-config.json`, replacing images, repairing assets, backing up,
restoring, or moving state, list the nonterminal work and either let it reach a
terminal state or cancel selected jobs explicitly:

```sh
bridge_api "$BRIDGE_URL/v1/jobs?state=running&limit=500"
bridge_api "$BRIDGE_URL/v1/jobs?state=queued&limit=500"
bridge_api "$BRIDGE_URL/v1/jobs?state=awaiting_approval&limit=500"
bridge_api "$BRIDGE_URL/v1/jobs?state=interrupted&limit=500"
```

Do not blindly cancel every returned ID. For one job that an operator has
chosen to stop, substitute its returned ID in this command:

```sh
bridge_api \
  -X POST "$BRIDGE_URL/v1/jobs/<job-id>/cancel" \
  -H 'Content-Type: application/json' \
  --data '{"reason":"planned Docker maintenance"}'
```

Re-list the queues until no work that must be preserved remains. A notification
is not approval or authorization to resume; do not approve, resubmit, or resume
work as part of a maintenance operation.

On restart, queued work dispatches and interrupted/running omp work may recover
automatically at most twice, using its original time window. This automatic
recovery is distinct from manual resume. Review authorization to preserve any
nonterminal jobs before starting restored services; a notification is not
approval or paid-work consent. A later manual resume still requires an explicit
user decision, the same job ID, and the guards above.
Then stop the gateway before the worker:


```sh
dc stop hermes video-worker
dc ps --status running hermes video-worker
```

`docker compose stop` is deliberate and does not remove bind-mounted state.
Do not use `docker restart`, `docker compose up -d`, or an image/asset command
until the operator intends to bring the services back. `dc down` is also
non-destructive to the bind-mounted state, but it removes the Compose
containers/network; never add `--volumes`, and never use an indiscriminate
`docker system prune` or `rm -rf` against the state directory.


### Application-only versus runtime/assets updates

An application-only update changes bridge source or its application dependency
layers while retaining the tested runtime base, external assets, Hermes image,
and state. It does not run `worker-runtime` or change `runtime-lock.json`.
After draining and stopping as above:

```sh
dc build video-worker
dc up -d --wait --force-recreate video-worker hermes
dc ps --status running video-worker hermes
```

`dc up` reconciles the requested services; it is the explicit update action and
may recreate a changed worker. It does not silently cancel jobs or delete
bind-mounted data. A changed bind-mounted `worker-config.json` is read by
`worker-entrypoint.mjs` only at process start, so use the same stopped,
intentional update sequence rather than expecting a live process to reload an
inode-replaced file.

`worker-entrypoint.mjs` reads the bind-mounted file and writes the effective
configuration to the worker's executable tmpfs at
`/tmp/omp-worker/worker-config.json`, adding the webhook secret. Never print or
copy that generated file. A command run by `dc exec video-worker` does not
inherit the entrypoint's `BRIDGE_CONFIG`; an ad-hoc `loadConfig()` using its
defaults is therefore not proof that the running worker loaded the mounted
file. Validate through the worker's startup/health behavior or pass an
explicit, non-secret `BRIDGE_CONFIG` to a separate validation process.

A runtime/assets update changes `deploy/Dockerfile.runtime`,
`deploy/Dockerfile.worker`, `deploy/runtime-lock.json`,
`deploy/requirements.worker.txt`, `deploy/hyperframes/package-lock.json`,
the worker dependency/base image, `deploy/hermes/Dockerfile`,
`deploy/hermes/entrypoint.sh`, or the pinned asset set. Stop first, then
rebuild the complete affected chain and validate assets before starting:

```sh
dc --profile build build worker-runtime
dc build video-worker hermes
dc --profile bootstrap run --rm init-state
dc run --rm init-assets
dc up -d --wait --force-recreate video-worker hermes
```

`init-state` seeds only absent files and preserves existing configuration and
secrets. `init-assets` reuses matching files and downloads only the pinned
revisions when repair is needed; it is not a license to weaken or remove a
checksum. If the update changes only the Hermes skill, stop the gateway and
worker before changing the checkout, verify the skill file is present at the
same relative path, then recreate the gateway deliberately.

### Immutable images and checkout compatibility

The Compose defaults are build-oriented version tags, not rollback identities.
For a release deployment, use the `release-images.env` artifact produced by the
release workflow, which contains `SOURCE_COMMIT` and digest-pinned
`WORKER_RUNTIME_IMAGE`, `WORKER_IMAGE`, and `HERMES_IMAGE` values. Do not
replace a digest with `latest` or a mutable tag. Load that non-secret artifact
and verify the checkout before using its images:

```sh
RELEASE_IMAGES="$HOME/secure/omp-video-release-images.env"
test -r "$RELEASE_IMAGES"
set -a
. "$RELEASE_IMAGES"
set +a
test "$(git -C "$OMP_VIDEO_REPO" rev-parse HEAD)" = "$SOURCE_COMMIT"
dc config --images
```

The release checkout and image `SOURCE_COMMIT` must be compatible. In
particular, Compose bind-mounts the skill from the checkout into Hermes at
`/opt/data/skills/omp-video`; an image digest does not contain or pin that
mount. Keep the verified checkout in place, and do not delete or move it while
the gateway may need the mount. To run published images without rebuilding
them, initialize/validate state with those exact image variables and use
`--no-build`:

```sh
dc --profile bootstrap pull init-state init-assets video-worker hermes
dc --profile bootstrap run --rm init-state
dc run --rm init-assets
dc up -d --wait --no-build video-worker hermes
```

Record the `SOURCE_COMMIT`, image digests, checkout path, state path, and
Compose project name with each maintenance change. Keep the previous stopped
backup and checkout until verification and rollback retention are complete.

### Offline backup scope

Docker application backup is offline and stopped. It must cover the
`video-data` bind mount only through `deploy/backup.mjs`; that tool checkpoints
WAL, runs SQLite `integrity_check`, rejects unsafe trees, and refuses to
overwrite an archive. It does not copy configuration, tokens, provider
credentials, webhook secrets, Hermes state, worker `.omp` state, or assets.
Those are separate private recovery inputs:

| State path | Container namespace | Purpose and backup policy |
| --- | --- | --- |
| `video-data` | `/data/worker` (worker), `/videos-v2` read-only (Hermes) | Required app backup. Retain the same worker namespace on restore. |
| `omp-state` | `/home/worker/.omp` | Worker provider/auth state; include in a private support archive. |
| `hermes` | `/opt/data` | Hermes config, Telegram/provider auth, sessions, logs; include privately. |
| `worker-config.json` | `/etc/omp-video-bridge/config.json` | Include separately and keep mode `0600`, owner UID/GID `1001:1001`. |
| `secrets/bridge-token`, `secrets/webhook-secret` | `/run/secrets/...` | Include separately in a mode-`0700` private directory; never print values. |
| `assets` | `/assets` read-only | Pinned models and complete Chrome tree; include for offline recovery, or document an approved network reinitialization with `init-assets`. |
| `font-cache` | `/home/worker/.cache/omp-video-fonts` | Optional rebuildable cache; include if a no-network recovery requires it. |

Imported-v1 media is an external read-only mount and is in neither archive;
retain its original namespace separately before any relocation.

The initialized layout uses worker UID/GID `1001:1001` for `video-data`,
`assets`, `omp-state`, `font-cache`, and `worker-config.json`, and Hermes
UID/GID `10000:10000` for `hermes` and its `skills` parent. `init-state` gives
those directories their required private/public traversal modes and preserves
existing secret/config contents. Verify owner and mode without reading values:

`init-state` seeds `hermes/config.yaml` as mode `0600` owned by
`10000:10000`; it seeds `worker-config.json` as mode `0600` owned by
`1001:1001`. The individual secret files are seeded mode `0644` but live
under the mode-`0700` `secrets` directory owned by the operator, so the
directory is the confidentiality boundary. Provider credentials in the
worker's `.omp/agent.db` and Hermes's persistent `hermes` root are also
separate from the application archive.

```sh
stat -c '%A %u:%g %n' \
  "$OMP_VIDEO_STATE_DIR" \
  "$OMP_VIDEO_STATE_DIR/video-data" \
  "$OMP_VIDEO_STATE_DIR/assets" \
  "$OMP_VIDEO_STATE_DIR/omp-state" \
  "$OMP_VIDEO_STATE_DIR/hermes" \
  "$OMP_VIDEO_STATE_DIR/secrets" \
  "$OMP_VIDEO_STATE_DIR/worker-config.json"
```

Create a private app archive after `dc stop` has confirmed both long-running
services are stopped. The command runs the checked-in tool from the worker
image so a Docker-only host does not need Node; `/data/worker` remains the
absolute in-container data namespace:

```sh
set -eu
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR="$HOME/.local/backups/omp-video-bridge-docker"
install -d -m 700 "$BACKUP_DIR"
APP_ARCHIVE="$BACKUP_DIR/video-data-$STAMP.tar.gz"
SUPPORT_ARCHIVE="$BACKUP_DIR/support-$STAMP.tar.gz"
test ! -e "$APP_ARCHIVE"
test ! -e "$SUPPORT_ARCHIVE"
test -z "$(dc ps --status running --services hermes video-worker)"
dc run --rm --no-deps --user 0:0 --cap-add DAC_OVERRIDE \
  -v "$BACKUP_DIR:/backup" \
  -v "$OMP_VIDEO_REPO/deploy/backup.mjs:/opt/bridge/deploy/backup.mjs:ro" \
  --entrypoint node video-worker \
  /opt/bridge/deploy/backup.mjs --stopped /data/worker "/backup/video-data-$STAMP.tar.gz"
```
The worker image does not package the backup/restore tools; these one-off
helpers mount the checked-in script read-only. `DAC_OVERRIDE` is confined to
the offline helper: Compose drops all capabilities, so UID 0 alone cannot
read another UID's private database or the operator's mode-`0700` backup
directory. The resulting archive is root-owned mode `0600`; use authorized
administrative access to inspect/copy it, never loosen it to world-readable.


The app archive contains only the complete `video-data` tree. Make a separate
private support archive with explicit roots; do not archive the whole host
state directory by habit:

```sh
sudo tar --numeric-owner --create --gzip --file="$SUPPORT_ARCHIVE" \
  --directory="$OMP_VIDEO_STATE_DIR" \
  omp-state hermes worker-config.json secrets assets font-cache
sudo chmod 600 "$SUPPORT_ARCHIVE"
sudo tar --list --file="$SUPPORT_ARCHIVE" >/dev/null
```

The support archive contains credentials and provider state. Keep both archives
private, retain their creation commit/digest metadata, and do not publish a
listing that discloses sensitive filenames. If the archive includes only
`omp-state`, `hermes`, `worker-config.json`, `secrets`, and `assets`, record
whether the rebuildable `font-cache` was intentionally omitted.

### Deterministic restore and rollback

Restore is non-overwriting and must be staged into a new, absent directory.
Never restore an archive over the mounted `video-data` path. First stop and
retain the old tree for rollback:

```sh
set -eu
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR="$HOME/.local/backups/omp-video-bridge-docker"
APP_ARCHIVE="$BACKUP_DIR/video-data-<backup-stamp>.tar.gz"
RESTORE_PARENT="$OMP_VIDEO_STATE_DIR.restore-$STAMP"
OLD_VIDEO_DATA="$OMP_VIDEO_STATE_DIR/video-data.before-restore-$STAMP"
dc stop hermes video-worker
test -z "$(dc ps --status running --services hermes video-worker)"
install -d -m 700 "$RESTORE_PARENT"
test ! -e "$RESTORE_PARENT/video-data"
dc run --rm --no-deps --user 0:0 \
  --cap-add DAC_OVERRIDE --cap-add CHOWN --cap-add FOWNER \
  -v "$BACKUP_DIR:/backup:ro" \
  -v "$RESTORE_PARENT:/restore" \
  -v "$OMP_VIDEO_REPO/deploy/restore.mjs:/opt/bridge/deploy/restore.mjs:ro" \
  --entrypoint node video-worker \
  /opt/bridge/deploy/restore.mjs --stopped \
  "/backup/video-data-<backup-stamp>.tar.gz" /restore/video-data
sudo chown -R 1001:1001 "$RESTORE_PARENT/video-data"
test -f "$RESTORE_PARENT/video-data/bridge.db"
test ! -e "$OLD_VIDEO_DATA"
mv "$OMP_VIDEO_STATE_DIR/video-data" "$OLD_VIDEO_DATA"
mv "$RESTORE_PARENT/video-data" "$OMP_VIDEO_STATE_DIR/video-data"
rmdir "$RESTORE_PARENT"
```

Replace `<backup-stamp>` only with the existing archive's timestamp; do not
invent a second archive or overwrite an existing destination. The restore tool
validates archive paths/types, checks SQLite integrity, and atomically creates
the staged directory. Preserve `OLD_VIDEO_DATA` and the original stopped app
archive until authenticated catalog/health verification and rollback retention
are complete.

Restore `worker-config.json`, `omp-state`, `hermes`, `secrets`, `assets`, and
any retained `font-cache` from the separate support archive into a separate
staging directory, then swap each named root while all services remain
stopped. Use numeric owners/perms from the archive; do not overwrite secrets
with newly generated files:

```sh
set -eu
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SUPPORT_ARCHIVE="$HOME/.local/backups/omp-video-bridge-docker/support-<backup-stamp>.tar.gz"
SUPPORT_PARENT="$OMP_VIDEO_STATE_DIR.support-$STAMP"
install -d -m 700 "$SUPPORT_PARENT"
sudo tar --numeric-owner --same-owner --same-permissions \
  --extract --file="$SUPPORT_ARCHIVE" --directory="$SUPPORT_PARENT"
sudo tar --list --file="$SUPPORT_ARCHIVE" >/dev/null
# Review the named roots and ownership before swapping them:
sudo stat -c '%A %u:%g %n' \
  "$SUPPORT_PARENT"/{omp-state,hermes,worker-config.json,secrets,assets,font-cache}
```

Swap each named root explicitly while services remain stopped; each old root
is retained for rollback and no destination is overwritten:

```sh
for name in omp-state hermes worker-config.json secrets assets font-cache; do
  test -e "$SUPPORT_PARENT/$name"
  old="$OMP_VIDEO_STATE_DIR/$name.before-restore-$STAMP"
  test ! -e "$old"
  mv -- "$OMP_VIDEO_STATE_DIR/$name" "$old"
  mv -- "$SUPPORT_PARENT/$name" "$OMP_VIDEO_STATE_DIR/$name"
done
rmdir "$SUPPORT_PARENT"
```
Move each old named root to a timestamped `.before-restore-$STAMP` sibling
before moving its staged replacement into the exact
`$OMP_VIDEO_STATE_DIR` name. Do not run `init-state` against a different state
directory: it is safe to re-run only when `OMP_VIDEO_STATE_DIR` is correct and
its seed-if-absent behavior will preserve the restored config/secrets. Start
only after the swaps and permission review:

```sh
dc --profile bootstrap run --rm init-state
dc run --rm init-assets
dc up -d --wait --force-recreate video-worker hermes
curl --fail --silent --show-error "$BRIDGE_URL/v1/health"
bridge_api "$BRIDGE_URL/v1/catalog"
```

SQLite migrations run when the worker opens `bridge.db`; they are append-only.
A newer checkout may advance `PRAGMA user_version`, while an older image may
not understand that schema. There is no inferred or supported down-migration
utility. Treat a schema-changing update as a one-way compatibility boundary:
retain the original stopped backup and old checkout, and roll back directly
only when the older code is known to understand the database. Otherwise stop,
preserve the failed tree, and restore the original app archive into a new
absent staging path before swapping it back. Never downgrade code onto a
migrated DB in place and never delete the failed tree before its logs and
verification evidence are retained.

### Test-to-durable relocation

A host-path copy is not a path migration. SQLite rows, session packets, and
imported-v1 references can contain absolute paths. Docker recovery is supported
only when the worker keeps `/data/worker`, Hermes keeps `/videos-v2`, the
Compose service names/project remain `video-worker`, `hermes`, and
`omp-video-bridge`, and the checkout-bound skill remains available at its
relative checkout path. Do not claim that copying state to a new host path
alone relocates those references; an imported v1 mount still needs its old
read-only namespace, and a different container namespace is unsupported
without a separately reviewed path migration.

For a test deployment becoming durable:

1. Drain selected work, stop `hermes` then `video-worker`, and run the stopped
   app/support backups above. Stop any old gateway using the same Telegram bot
   token before starting the durable gateway; never run two pollers during a
   cutover.
2. Place the verified checkout at the durable `OMP_VIDEO_REPO` path and keep
   its `SOURCE_COMMIT` aligned with the image digests. Do not move/delete the
   old checkout while its containers are still mounted.
3. Restore into the durable external state directory, preserving the host
   owners/modes and the exact container namespaces above. Do not bind host
   paths directly into the worker or Hermes in place of `/data/worker` and
   `/videos-v2`.
4. Re-run `init-state` only with the durable `OMP_VIDEO_STATE_DIR`; it
   preserves existing config/secrets. Run `init-assets` while stopped and
   verify its pinned receipt. Do not replace a secret with a newly seeded
   value.
5. Keep `COMPOSE_PROJECT_NAME=omp-video-bridge`, inspect service-targeted
   status, start explicitly with `dc up -d --wait video-worker hermes`, and
   perform health/auth/readiness checks before accepting paid work.

Do not start the durable project until the old project/gateway is stopped.
There is no runtime path-rewrite or automatic migration capability hidden in
`setup.sh`.

### Troubleshooting

- **API `401`** — `/v1/health` is public; every other `/v1` route requires the
  exact `Bearer` header. Check that
  `$OMP_VIDEO_STATE_DIR/secrets/bridge-token` is nonempty and that the
  container sees a nonempty `/run/secrets/bridge-token` without printing it.
  A changed secret is read at process startup; after an intentional rotation,
  recreate `video-worker` and `hermes`, then repeat the safe catalog check.
- **Provider OAuth expired, quota exhausted, or model unavailable** — green
  worker health does not test the LLM provider. Inspect the redacted
  `video-worker` logs and use the installed omp provider/model setup flow with
  the worker's persistent `/home/worker/.omp` state:

  ```sh
  dc run --rm --no-deps --entrypoint /opt/omp/omp video-worker login
  dc run --rm --no-deps --entrypoint /opt/omp/omp video-worker models
  dc run --rm --no-deps --entrypoint /opt/omp/omp video-worker models --json
  ```

  `login` saves provider authentication in the persistent worker credentials
  store (`omp-state` mounted at `/home/worker/.omp`) as `agent.db`; it does
  not create an `auth.json`. `models` shows the grouped cached catalog without
  inference; catalog presence does not prove account access or quota. Use `models refresh` when the provider catalog
  is stale. Select a model supported by the account and set
  `runner.defaultModel` in `worker-config.json`; bridge model selection is
  independent of the Hermes model. Recreate the worker after a deliberate
  config replacement:
  `dc up -d --force-recreate --no-build video-worker`. A `defaultMaxUsd`
  value is an application job limit, not a guaranteed provider spending cap,
  and the bridge does not silently change models or resubmit failed work.
- **Telegram `409 Conflict`** — two polling gateways are consuming the same
  bot token. Inspect only the `hermes` logs, stop the old gateway/process, and
  start exactly one gateway. Use a separate test bot while the old gateway is
  running; do not rely on Compose restart behavior to resolve a conflict.
- **Bot cannot send to the home chat/channel** — configure Telegram credentials
  and the home chat in the persistent Hermes state, ensure the bot is a member
  with permission to send there, and follow the setup guide's
  [no-second-gateway Telegram configuration procedure](SETUP.md#configure-telegram-without-starting-a-second-gateway).
  That procedure writes the persistent Hermes `.env` without starting another
  gateway. `hermes model` is the separate LLM provider/model picker, not a
  Telegram configuration command. Do **not** use `hermes setup gateway` as a
  config-only action: the pinned source may ensure or start a gateway and can
  create a second poller. Check redacted logs and
  sender warnings; a notification is not approval and successful text delivery
  does not prove every attachment was sent.
- **UID or bind-mount permission errors** — run the official bootstrap
  initializer with the correct project/state variables:
  `dc --profile bootstrap run --rm init-state`. Confirm UID/GID `1001:1001`
  for worker roots and `10000:10000` for Hermes roots with `stat`; do not use
  recursive world-writable modes or recursive `chmod` over sessions,
  credentials, or the whole data tree. Published artifacts are `0644`, but
  every containing directory still needs traversal; private session/config
  files intentionally remain private. If `omp` reports `failed to map segment
  from shared object` or another native-addon load error, inspect the
  filesystem mount flags:

  ```sh
  findmnt -no OPTIONS --target "$OMP_VIDEO_STATE_DIR/omp-state"
  ```

  A `noexec` host filesystem cannot load native addons from that cache. The
  worker's `/tmp` is intentionally an executable tmpfs for its loader; do not
  replace it with `noexec`, run as root to bypass the error, or download an
  unverified latest addon. Move the state to an approved exec-capable
  filesystem only as a stopped, namespace-preserving relocation.
- **Asset checksum failure** — stop both long-running services before repairing
  assets. Run `dc run --rm init-assets` to reuse verified files or download the
  exact pinned revisions, then start explicitly. Never delete the state tree,
  bypass SHA256 checks, substitute a same-named model, or weaken the Chrome
  tree receipt. `prepare-assets.py` rejects model, voice, Whisper, Chrome
  binary, and complete Chrome-tree mismatches.
- **Health is green but the deployment is not ready** — query authenticated
  `/v1/catalog`, inspect both service logs, verify the worker's provider/model
  state, verify the HMAC webhook route and Hermes's Telegram setup, and check
  that `/opt/data/skills/omp-video` is mounted from the current checkout.
  Health does not perform an LLM call or Telegram send.
- **Hermes slim capability mismatch** — this final image contains the pinned
  Hermes Python runtime, Telegram/webhook dependencies, curl, FFmpeg, git,
  OpenSSH client, procps, ripgrep, tini, terminal/file/skills support, and
  fixed SQLite 3.53.4. It does **not** contain Node, a browser, desktop or
  dashboard components, or a build compiler; lazy installs are disabled.
  Do not treat it as the official full Hermes image, run HyperFrames rendering
  there, or assume unavailable tools. The separate `video-worker` owns the
  pipeline; use `/opt/hermes/bin/hermes send` for supported Telegram
  attachments and `/videos-v2` for its read-only media namespace.


## Security reporting

Do not publish tokens, HMAC secrets, provider credentials, database files, or
media in issues/logs. For a suspected vulnerability, use the repository's
[private GitHub security advisory](https://github.com/ChiThang-50Cent/omp-video-bride/security/advisories/new)
with a minimal redacted reproduction and affected commit. If that mechanism is
unavailable, contact the owner privately through GitHub; coordinate disclosure
rather than opening a public issue first.

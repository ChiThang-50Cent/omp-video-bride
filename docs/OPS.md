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

```sh
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
TOKEN=$(sudo cat /etc/omp-video-bridge/token)
curl --fail -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8765/v1/catalog
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

- ensure no job for the project is `queued`, `running`, or
  `awaiting_approval`; cancel/drain it through the authenticated API;
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
There is no separate public retry endpoint in the current API.

## Docker isolated deployment

The repository Docker recipe is an additional, externally stateful deployment
for Linux/amd64. It uses Docker Compose v2, external `OMP_VIDEO_STATE_DIR`,
loopback host publications, pinned runtime inputs, and separate worker/Hermes
state. It is not a live migration of a systemd data directory.

Follow the [Docker section of `SPEC.md`](SPEC.md#61-repository-docker-deployment-linuxamd64)
and `deploy/setup.sh`. Keep worker/Hermes state outside Git, use unused ports,
and never bind the host's live SQLite/auth state into a new deployment. Stop
before changing assets. Imported v1 media still needs its original read-only
mount.

## Security reporting

Do not publish tokens, HMAC secrets, provider credentials, database files, or
media in issues/logs. For a suspected vulnerability, use the repository's
[private GitHub security advisory](https://github.com/ChiThang-50Cent/omp-video-bride/security/advisories/new)
with a minimal redacted reproduction and affected commit. If that mechanism is
unavailable, contact the owner privately through GitHub; coordinate disclosure
rather than opening a public issue first.

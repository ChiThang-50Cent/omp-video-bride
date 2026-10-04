# Operations runbook

This runbook covers operational lifecycle management, stopped backups, restore,
upgrades, logging, and troubleshooting for the **direct Hermes-to-OMP stack**.

The former HTTP bridge, SQLite database, webhook outbox, and host systemd
installation are discontinued. Former bridge state is preserved outside this
repository and is not consumed by the direct stack.

## Operating invariants

1. **Internal TCP transport:** Hermes connects directly to OMP over private TCP
   port 9876 within Docker Compose (`omp-executor:9876`). The port is not
   published to the host or internet.
2. **State lives outside the repository:** Persistent data resides under
   `$OMP_DIRECT_STATE_DIR`, keeping private tokens, sessions, credentials, and
   workspaces isolated from source checkouts.
3. **No automatic background replay or scheduler:** Stopping containers
   terminates active executor child processes. History is preserved on disk, but
   no automatic background worker resubmits failed or interrupted paid tasks.
   Resumption requires an explicit user command.
4. **Manual, review-driven retention:** The stack does not prune workspaces,
   session history, or artifacts automatically. Workspace and artifact cleanup
   must always be an operator-reviewed action.

## State directory and permissions

Persistent state is stored under `$OMP_DIRECT_STATE_DIR`:

```text
$OMP_DIRECT_STATE_DIR/
  secrets/
    executor-token       # shared secret (mode 0644 inside private 0700 dir)
  omp-state/             # worker .omp credentials, profiles, sessions (UID 1001)
  executor/
    workspaces/          # worker workspaces and managed session logs (UID 1001)
    workspaces/.runtime/ # canonical-cwd locks and stderr logs
    artifacts/           # published deliverables (read-only mount in Hermes)
  hermes/                # Hermes auth, config, conversation history (UID 10000)
  assets/                # optional media runtime assets (Kokoro, Whisper, Chrome)
  font-cache/            # stage-fonts cache
```

### UID ownership boundaries

- **Worker:** Runs as UID/GID `1001:1001`. Owns `omp-state/` and `executor/`.
- **Hermes:** Runs as UID/GID `10000:10000`. Owns `hermes/`.
- **Secrets:** Shared secret `secrets/executor-token` uses mode `0644` inside
  the private `0700` `secrets/` directory so both container UIDs (1001 and 10000)
  can read their Docker secret file mounts.
- Do not apply recursive `chmod 777` or change ownership blindly across the
  state tree.

## Operational commands

All commands run via Bash from the checkout root using the canonical compose file:

```bash
export OMP_DIRECT_REPO="$HOME/code/omp-video-bridge"
export OMP_DIRECT_STATE_DIR="$HOME/.local/state/omp-direct-executor"
export COMPOSE_PROJECT_NAME=omp-direct-executor

dc() { docker compose -p "$COMPOSE_PROJECT_NAME" -f "$OMP_DIRECT_REPO/deploy/compose.yaml" "$@"; }
```

### Checking status and logs

```bash
# Service status
dc ps

# Inspect logs
dc logs --tail=100 omp-executor
dc logs --tail=100 hermes

# Check plugin health in Hermes
dc run --rm --no-deps hermes plugins doctor /opt/data/plugins/omp-executor --ci
```

### Workspace runtime logs and locks

Worker execution stderr is written to:

```text
$OMP_DIRECT_STATE_DIR/executor/workspaces/.runtime/<sha256(canonical cwd)>.stderr.log
```

Lock files share the same runtime directory. If a workspace is actively open by
an executor handle, concurrent connection attempts to the same canonical working
directory are rejected until the active connection is closed.

## Stopped backup and restore

Filesystem copies of active state risk inconsistent session logs or corrupt
SQLite credential databases. Always stop both services before copying:

### Backup procedure

```bash
# 1. Stop services cleanly
dc stop hermes omp-executor

# 2. Create archive of external state directory preserving permissions
BACKUP_ARCHIVE="/var/backups/omp-direct-executor-$(date +%Y%m%d%H%M%S).tar.gz"
tar --create --gzip --preserve-permissions \
    --file="$BACKUP_ARCHIVE" \
    -C "$(dirname "$OMP_DIRECT_STATE_DIR")" "$(basename "$OMP_DIRECT_STATE_DIR")"

# 3. Restart services
dc up -d --wait omp-executor
dc up -d hermes
```

### Restore procedure

```bash
# 1. Stop services if running
dc stop hermes omp-executor

# 2. Extract backup archive preserving original directory layout
tar --extract --gzip --preserve-permissions \
    --file="/path/to/backup.tar.gz" \
    -C "$(dirname "$OMP_DIRECT_STATE_DIR")"

# 3. Verify permissions (UID 1001 for worker, UID 10000 for Hermes)
# 4. Restart services
dc up -d --wait omp-executor
dc up -d hermes
```

When restoring, preserve the absolute path names and in-container mounts
(`/data/executor` and `/artifacts`). Session headers record absolute working
directories.

## Upgrades and image rebuilds

### Prepare a candidate, not a running-container update

`deploy/runtime-lock.json` owns upstream runtime pins. The Python RPC lock is
prepared together with the OMP binary; do not update either independently.
The updater never deploys, builds images, invokes downloaded code, or edits
production state:

```bash
python3 tools/update-runtime.py check
python3 tools/update-runtime.py prepare omp --version <exact-release> --repo <candidate-checkout>
python3 tools/update-runtime.py prepare hermes --ref <exact-tag-or-full-commit> --repo <candidate-checkout>
```

Use a separate checkout for candidates. Review the output and lock diff, including
RPC command/schema changes and Hermes dependency changes. Preparation does not
migrate plugin commands or prove compatibility. GitHub-provided asset digests,
when available, are checked; a locally calculated checksum alone is not an
independent publisher signature.

Specify an exact three-component OMP version, such as `18.6.0`; floating
`latest`, branch names, and ambiguous `18.6` are not preparation targets.
GitHub API authentication is optional via `GITHUB_TOKEN` or `GH_TOKEN` and is
sent only to HTTPS `api.github.com`, never artifact/raw hosts. Keep tokens out of
generated pin env files and logs. API rate-limit failures abort preparation;
there is no automatic retry or deployment.

Normal replacement errors roll back already-replaced locks. If rollback also
fails, the error identifies affected files and any preserved recovery snapshots.
Sequential replacements are not a cross-file power-loss transaction. After an
interrupted preparation, restore consistent locks or recreate the candidate
checkout before proceeding; a prepared candidate is never a rollout approval.

Build and verify the candidate before touching the running stack. The media
dependency base excludes OMP, allowing OMP-only updates to reuse it. OMP updates
require both the worker image and the Hermes image containing the matching RPC
client. Hermes-only updates require its runtime base and service image.

Run the no-media native smoke against the exact candidate images. This checks
plugin discovery, skills, RPC, UI, session lifecycle, and cleanup without model
provider calls, Telegram messages, audio, or video. A cross-version migration
also needs a sanitized previous-version session/database fixture; a same-version
resume smoke does not establish backward compatibility.

Promotion remains an explicit operator action. Stop affected services and take
a state snapshot using the stopped backup procedure before first startup with
new images. Record immutable image digests. If the new version migrates state,
rollback requires the previous image digests **and** the matching state snapshot,
not merely swapping image tags. Never run `omp update` or `hermes update` inside
serving containers.

### Rebuild and restart

Build and verify candidate images first; do not stop production during a build.
From the candidate checkout:

```bash
PIN_ENV="$(mktemp)"
python3 deploy/runtime-pins.py --format env > "$PIN_ENV"
set -a
. "$PIN_ENV"
set +a

# Reuses the heavy media base for OMP/Hermes-only upgrades.
docker build -f deploy/Dockerfile.runtime -t "$WORKER_RUNTIME_IMAGE" \
  --build-arg NODE_VERSION --build-arg HYPERFRAMES_VERSION .
docker build -f deploy/hermes/Dockerfile.runtime -t "$HERMES_BASE_IMAGE" \
  --build-arg HERMES_COMMIT --build-arg HERMES_ARCHIVE_SHA256 \
  --build-arg SQLITE_AUTOCONF_VERSION --build-arg SQLITE_SHA256 \
  --build-arg SQLITE_VERSION .
docker compose -f deploy/compose.yaml build omp-executor hermes

# Isolated verification; no production state is used.
python3 tools/smoke-executor.py --docker --no-build
```

The smoke requires both explicit final-image variables; the metadata helper
supplies them. Do not promote merely because pin preparation succeeded.
After candidate verification, use the deployment checkout and approved digest
references, stop affected services, take the stopped state backup, then recreate
the affected services:

```bash
dc up -d --wait omp-executor
dc up -d hermes
```

`WORKER_RUNTIME_IMAGE` and `HERMES_BASE_IMAGE` select dependency bases.
`OMP_EXECUTOR_IMAGE` and `HERMES_EXECUTOR_IMAGE` select final service images.
Keep these four references with the state snapshot for rollback.

## Rotating credentials and tokens

### Executor shared token

The token authorizing Hermes connections to OMP lives in
`$OMP_DIRECT_STATE_DIR/secrets/executor-token`. To rotate:

```bash
# 1. Stop services
dc stop hermes omp-executor

# 2. Generate a new random token
python3 -c 'import secrets; print(secrets.token_hex(32))' > "$OMP_DIRECT_STATE_DIR/secrets/executor-token"
chmod 644 "$OMP_DIRECT_STATE_DIR/secrets/executor-token"

# 3. Recreate containers to load the updated secret
dc up -d --force-recreate omp-executor hermes
```

### Provider credentials

To update model provider credentials (e.g. OpenAI, Anthropic, GitHub):

```bash
# Interactive provider login in worker
dc exec omp-executor omp login <provider>
```

Credentials update inside `$OMP_DIRECT_STATE_DIR/omp-state`. No container restart
is required for OMP credential updates.

## Troubleshooting

### Connection refused on port 9876

- Confirm `omp-executor` is healthy: `dc ps omp-executor`.
- Check worker logs for startup failures: `dc logs omp-executor`.
- Verify the internal Compose network is intact.

### Plugin Doctor reports mismatch or failure

- Run `dc run --rm --no-deps hermes plugins doctor /opt/data/plugins/omp-executor --ci`.
- Ensure Hermes image was rebuilt after any plugin changes.
- Check that `secrets/executor-token` exists and is non-empty.

### Session resume fails

- Session resume requires an exact `session_id` or indexed `session_file`.
- Inspect available sessions via `omp_sessions({"offset":0,"limit":50})`.
- Ensure the session file exists under `$OMP_DIRECT_STATE_DIR/executor/workspaces/`
  or `$OMP_DIRECT_STATE_DIR/omp-state/sessions/`.
- If a workspace lock is active from an unclean shutdown, check
  `workspaces/.runtime/` for stale locks.

## Security vulnerability disclosure

Do not file public issues for suspected security vulnerabilities. Use a private
security advisory:
<https://github.com/ChiThang-50Cent/omp-video-bride/security/advisories/new>

Redact private tokens, provider credentials, and personal artifacts from reports.

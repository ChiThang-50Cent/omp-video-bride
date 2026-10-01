# Deployment setup

Choose a deployment path below. Run repository-relative host commands from the
checkout root. The [README](../README.md) lists supported runtimes and development
commands; [OPS](OPS.md) covers maintenance and recovery.

- [Isolated host quickstart](#safe-isolated-quickstart)
- [Host systemd deployment](#host-systemd-deployment)
- [Docker onboarding](#docker-onboarding)

## Safe isolated quickstart

The following keeps state outside the checkout, binds only to loopback, and
uses a non-default port. It assumes the host has already installed `omp`,
FFmpeg, a HyperFrames-compatible browser, and the Python provider. Set the
three executable paths explicitly; do not paste the example values from a
production machine into Git.

```sh
export OMP_BIN="$(command -v omp)"
export HYPERFRAMES_BROWSER_PATH=/absolute/path/to/chrome-headless-shell
export HYPERFRAMES_PYTHON=/absolute/path/to/python

export OMP_VIDEO_DEMO="$HOME/.local/state/omp-video-bridge-demo"
install -d -m 700 "$OMP_VIDEO_DEMO"
node -e 'require("node:fs").writeFileSync(process.argv[1], require("node:crypto").randomBytes(32).toString("hex")+"\n", { mode: 0o600 })' "$OMP_VIDEO_DEMO/token"

cat > "$OMP_VIDEO_DEMO/config.json" <<JSON
{
  "host": "127.0.0.1",
  "port": 18765,
  "dataDir": "$OMP_VIDEO_DEMO/data",
  "tokenFile": "$OMP_VIDEO_DEMO/token",
  "omp": {
    "bin": "$OMP_BIN",
    "skillDirs": []
  },
  "env": {
    "HYPERFRAMES_BROWSER_PATH": "$HYPERFRAMES_BROWSER_PATH",
    "HYPERFRAMES_PYTHON": "$HYPERFRAMES_PYTHON"
  }
}
JSON
chmod 600 "$OMP_VIDEO_DEMO/config.json"
BRIDGE_CONFIG="$OMP_VIDEO_DEMO/config.json" npm start
```

Keep that terminal running. In another terminal, query health and the
pipeline catalog. Health is intentionally public; the catalog and all state
changing routes require the bearer token:

```bash
host_api() {
  curl --fail-with-body --silent --show-error \
    --header @<(printf 'Authorization: Bearer %s\n' \
      "$(tr -d '\r\n' < "$OMP_VIDEO_DEMO/token")") "$@"
}
curl --fail http://127.0.0.1:18765/v1/health
host_api http://127.0.0.1:18765/v1/catalog
```

Create a project without starting a production job:

```bash
host_api -X POST http://127.0.0.1:18765/v1/projects \
  -H 'Content-Type: application/json' \
  -d '{"name":"isolated smoke project","pipeline":"hyperframes-explainer"}'
```

This is a service/API smoke, not provider readiness. Before a paid job, configure
credentials and an explicit supported `runner.defaultModel`; the schema's default
is not a model-access guarantee. Use Bash for the header helper, keep shell
tracing (`set -x`) and curl verbose/trace output off, and never export a bearer
token into the environment or put it in command arguments. The
[Docker usage tutorial](USAGE.md) covers approval through the completed MP4,
including preview/native-render, revise, cancel, and explicit manual-resume
paths.

Stop the process with `Ctrl-C`. Do not reuse the demo data directory for a
production service. The full request schema and state transitions are in
[`docs/SPEC.md`](SPEC.md).

## Host systemd deployment

The installer validates the real `src/config.ts` schema before it writes a
unit. It requires an existing nonempty private bearer token, real `omp`,
HyperFrames provider executables, and `ffmpeg`/`ffprobe`; a placeholder webhook
secret is rejected. It never sources the JSON file or uses shell `eval`.

First run a non-mutating check as the service user (or with explicit values):

```sh
sh deploy/install.sh --check-only \
  --user bridge \
  --repo /opt/omp-video-bridge \
  --node /usr/bin/node \
  --config /etc/omp-video-bridge/config.json
```

Use the same arguments with `--print-unit` instead of `--check-only` to inspect
the exact rendered unit without a privileged action. Data and token paths in
the JSON config must be absolute.

Review the output, then invoke installation explicitly as root. The default
install writes the rendered unit and reloads systemd, but does not enable,
start, or restart production:

```sh
sudo sh deploy/install.sh \
  --user bridge \
  --repo /opt/omp-video-bridge \
  --node /usr/bin/node \
  --config /etc/omp-video-bridge/config.json
sudo systemctl enable --now omp-video-bridge.service   # explicit operator action
```

Use `--enable`, `--start`, or `--restart` on the installer only when that
service action is intended. A config file containing a webhook secret should
be owned/readable by the service account and not group/world writable; token
files should be mode `0600`. The installer does not create credentials or
silently migrate a data directory. See [`docs/OPS.md`](OPS.md) for
upgrade, backup, restore, retention, and dead-letter procedures.

## Docker onboarding

This checklist is for a **new** Linux/amd64 deployment. For an existing service,
use the [Docker operations runbook](OPS.md#docker-isolated-deployment) instead;
startup can dispatch queued work and automatically recover interrupted/running
omp work at most twice using its original time window. Manual continuation of a
failed, cancelled, or interrupted job is separate, requires an explicit user
decision, and never falls back to a fresh submission. Do not point this recipe
at live host/systemd data or reuse a running gateway's bot token.

### 1. Prerequisites and capacity

- Linux/amd64 Docker daemon on the machine holding the checkout/state paths;
  Docker Engine with BuildKit, the Buildx plugin, and Compose **v2**. Remote
  Docker contexts with different filesystem paths are not covered by this guide.
- Host **Bash**, Git, curl and jq. Node/Python/model tools are included in the
  images; they are not required on the host.
- Working DNS/outbound HTTPS for Docker/GHCR, GitHub/codeload, npm, PyPI,
  Node.js releases, Hugging Face, Chrome for Testing, your model provider and
  Telegram. Fonts/CDN resources may also need network at render time.
- Capacity for images, build cache, roughly 1.13 GB of pinned external assets,
  and growing project/media/backups. An initial planning budget of **20 GB free
  disk and 8 GB RAM** is a recommendation, not a measured minimum or performance
  guarantee. Compose defaults to a two-CPU worker limit and 512 MB shared memory;
  CPU rendering is not a fixed-time service.
- A provider account/model available to each LLM client, and a **separate test
  Telegram bot** or an explicitly scheduled cutover. Only one gateway may poll
  a given bot token.

```bash
docker version
docker buildx version
docker compose version
uname -m                         # x86_64 on the supported host
```

### 2. Durable checkout and one shared shell context

Run the following in **Bash**. Keep these non-secret values for later shells;
all subsequent snippets use the same settings. Choose unused loopback ports.

```bash
umask 077
export OMP_VIDEO_REPO="$HOME/code/omp-video-bridge"
export OMP_VIDEO_STATE_DIR="$HOME/.local/state/omp-video-bridge-docker"
export COMPOSE_PROJECT_NAME=omp-video-bridge
export OMP_VIDEO_HTTP_PORT=18765
export OMP_VIDEO_WEBHOOK_PORT=28644
export BRIDGE_URL="http://127.0.0.1:$OMP_VIDEO_HTTP_PORT"
mkdir -p "$HOME/code"
git clone https://github.com/ChiThang-50Cent/omp-video-bride.git "$OMP_VIDEO_REPO"
cd "$OMP_VIDEO_REPO"
function dc(){ docker compose -f "$OMP_VIDEO_REPO/deploy/compose.yaml" "$@"; }
dc config --quiet
```

For an existing checkout, skip `git clone` and use its actual durable path.
Do not use a temporary checkout or move/delete it while containers use it:
Hermes's `omp-video` skill is **bind-mounted from this checkout**. State,
credentials, models and Chrome are outside Git; models/Chrome are also outside
the worker image. See the [canonical state layout](SPEC.md#61-repository-docker-deployment-linuxamd64).

### 3. Build, initialize and start once

For a fresh state directory only:

```bash
test ! -e "$OMP_VIDEO_STATE_DIR" || {
  printf '%s\n' 'State already exists: use the operations runbook, not fresh onboarding.' >&2
  exit 1
}
sh "$OMP_VIDEO_REPO/deploy/setup.sh"
dc ps --all
curl --fail --silent --show-error "$BRIDGE_URL/v1/health" | jq .
# Pause both clients while credentials/configuration are prepared.
dc stop hermes video-worker
```

`setup.sh` builds runtime/worker/Hermes images, initializes private external
state, downloads and verifies assets, then starts services. Separate actions are
`build`, `init`, `up`, `down`. Bootstrap preserves existing files; it is not a
reset or path-migration command. A green health check proves process/API startup
only—not LLM access, Telegram polling, or delivery.

### 4. Authenticate the omp worker and inspect its model catalog

Worker state is owned by **UID/GID 1001**; Hermes state by **10000**. The host
operator normally cannot edit their private files directly. Use one-off
containers with their normal UID; do not fix this with `chmod 777` or recursive
ownership changes. The worker credential/cache tree is
`$OMP_VIDEO_STATE_DIR/omp-state`, mounted at `/home/worker/.omp`; local credentials
use `agent.db` within that tree (the login CLI prints the exact path).

Define a helper that gives catalog/login commands the same configured provider
environment as the bridge, without putting API-key values in arguments:

```bash
omp_cli() {
  dc run --rm --no-deps --workdir /data/worker --entrypoint python3.12 video-worker -c '
import json, os, sys
with open("/etc/omp-video-bridge/config.json") as f:
    config = json.load(f)
os.environ.update(config.get("env", {}))
os.makedirs(os.environ.get("TMPDIR", "/tmp/omp-worker"), exist_ok=True)
os.execv("/opt/omp/omp", ["omp", *sys.argv[1:]])
' "$@"
}
omp_cli login --help
```

**OAuth:** use `omp_cli login`, choose a provider offered by the picker and follow
its browser/device instructions. Do not record login URLs/codes or screenshot
the session. A provider using a loopback browser callback needs that callback
reachable on the machine running the browser; a container's `localhost` is not
the host. For such a provider on this local Linux host, use this auth-only
override (never for normal worker startup):

```bash
cat > "$OMP_VIDEO_STATE_DIR/operator-auth.compose.yaml" <<'YAML'
services:
  video-worker:
    network_mode: host
YAML
docker compose -f "$OMP_VIDEO_REPO/deploy/compose.yaml" \
  -f "$OMP_VIDEO_STATE_DIR/operator-auth.compose.yaml" \
  run --rm --no-deps --workdir /data/worker \
  --entrypoint /opt/omp/omp video-worker login
```

This runs only the login CLI with the same private credential mount, not the
bridge or a Telegram gateway. Published service ports are ignored in host
network mode. Use a browser on this host, leave the provider's callback port free,
and follow the provider's displayed instructions. For a remote/headless host
without reachable callbacks, use a device-flow provider or the API-key route
below; this guide does not promise every OAuth flow works without a tunnel.

**API key:** for a provider that uses an environment variable listed by
`omp_cli --help` (for example `OPENAI_API_KEY`), enter it through a hidden prompt.
The key is saved in the private external worker JSON's `env` map, which the
bridge passes to omp. Pick **one** credential route for the chosen provider.

```bash
dc run --rm --no-deps \
  --volume "$OMP_VIDEO_STATE_DIR/worker-config.json:/operator/worker-config.json:rw" \
  --entrypoint python3.12 video-worker -c '
import getpass, json, os, re, sys
if not sys.stdin.isatty():
    raise SystemExit("Use an interactive terminal; do not pipe or record secret input.")
name = input("Provider credential variable from omp --help: ").strip()
if not re.fullmatch(r"[A-Z][A-Z0-9_]*", name):
    raise SystemExit("Invalid environment variable name.")
secret = getpass.getpass("Provider API key (hidden): ").strip()
if not secret:
    raise SystemExit("No key saved.")
path = "/operator/worker-config.json"
with open(path) as f:
    config = json.load(f)
config.setdefault("env", {})[name] = secret
with open(path, "w") as f:
    json.dump(config, f, indent=2)
    f.write("\n")
os.chmod(path, 0o600)
print("Credential saved outside Git; value not displayed.")
'
```

Now inspect the catalog using your credentials:

```bash
omp_cli models
omp_cli models --json | jq '.models[] | {selector, thinking}'
# If the cached catalog is stale, metadata refresh (not an inference request):
omp_cli models refresh
```

Copy an exact `selector` (`provider/model-id`) supported by **your** account.
Catalog presence is not proof of quota, billing or successful inference; check
the provider account too. Do not use `omp token`, environment dumps or raw
credential DB contents as a readiness check. Selecting a model in the omp TUI
does **not** update the bridge's `runner.defaultModel`.

### 5. Configure the separate Hermes LLM client

```bash
dc run --rm --no-deps hermes model
dc run --rm --no-deps hermes config check
dc run --rm --no-deps hermes config get model.provider
dc run --rm --no-deps hermes config get model.default
```

The pinned interactive model picker chooses Hermes's provider, obtains its
credentials and selects a default model from that provider's catalog. Prefer a
provider route supported by the slim Python image; Node/browser/app-server
capabilities are not installed. API-key prompts are private; do not pass keys
as flags. OAuth callback limitations still apply. Never use `--insecure` to
work around auth/network errors.

Hermes uses `/opt/data`, bound from `$OMP_VIDEO_STATE_DIR/hermes`: `config.yaml`,
`.env`, provider auth files and sessions stay there. Preserve the seeded
`platforms.webhook` route and `terminal` settings; do not reset configuration.
Hermes's model is **independent** of the bridge model and can incur separate
usage for chats and webhook handling.

### Configure Telegram without starting a second gateway

**Step 6.** Create a bot using Telegram's `@BotFather` (`/newbot`). Use a separate
test bot if another gateway is running. Obtain your numeric Telegram user ID
(for example through `@userinfobot`); a username is not an allowlist ID.

The script below edits only `.env` as UID 10000 and does not start polling or
send messages. Run it in an interactive terminal with shell tracing disabled:

```bash
dc run --rm --no-deps hermes python -c '
import getpass, os, re, sys
from pathlib import Path
from dotenv import set_key
if not sys.stdin.isatty():
    raise SystemExit("Use an interactive terminal; do not pipe or record secret input.")
token = getpass.getpass("BotFather token (hidden): ").strip()
users = input("Allowed numeric user IDs, comma-separated (required): ").replace(" ", "")
home = input("Home chat ID (DM: your numeric user ID; group: its chat ID): ").strip()
if not re.fullmatch(r"\d+:[A-Za-z0-9_-]{30,}", token):
    raise SystemExit("Invalid bot-token format; nothing saved.")
if not re.fullmatch(r"\d+(,\d+)*", users) or not re.fullmatch(r"-?\d+", home):
    raise SystemExit("Numeric allowlist and home chat ID are required; nothing saved.")
path = Path("/opt/data/.env")
path.touch(exist_ok=True)
path.chmod(0o600)
for name, value in {
    "TELEGRAM_BOT_TOKEN": token,
    "TELEGRAM_ALLOWED_USERS": users,
    "TELEGRAM_HOME_CHANNEL": home,
}.items():
    set_key(str(path), name, value)
path.chmod(0o600)
print("Telegram settings saved; no polling or send performed.")
'
```

For a DM home channel, open the bot in Telegram and press **Start** before
expecting delivery. For a group/channel, add the bot and grant its required
send/media permissions; use that destination's numeric chat ID, not a user ID.
Do not leave the allowlist empty or enable open access. Do not run
`hermes setup gateway` as a config-only shortcut: the pinned wizard can ensure
or start a gateway. Compose owns the one intended poller.

### 7. Set the bridge model explicitly

The seeded worker config omits `runner.defaultModel`; the schema supplies an
account-specific fallback, not a universally accessible model. Set it before
submitting a job. Both the bridge's main omp session and frame-worker task role
use this model; their thinking defaults are separate settings.

```bash
read -r -p 'Exact selector from omp models: ' BRIDGE_MODEL
read -r -p 'Supported thinking effort (non-reasoning: off): ' BRIDGE_THINKING
export BRIDGE_MODEL BRIDGE_THINKING
dc run --rm --no-deps -T --env BRIDGE_MODEL --env BRIDGE_THINKING \
  --volume "$OMP_VIDEO_STATE_DIR/worker-config.json:/operator/worker-config.json:rw" \
  --entrypoint node video-worker --input-type=module <<'JS'
import {readFileSync, writeFileSync, chmodSync} from "node:fs";
import {loadConfig} from "/opt/bridge/src/config.ts";
const path = "/operator/worker-config.json";
const config = JSON.parse(readFileSync(path, "utf8"));
const model = process.env.BRIDGE_MODEL?.trim();
const thinking = process.env.BRIDGE_THINKING?.trim();
if (!model || !thinking) throw new Error("Model and supported thinking effort are required.");
config.runner = {...config.runner, defaultModel: model,
  defaultThinking: thinking, defaultWorkerThinking: thinking};
// Validate through the application schema before updating the operator file.
const validatedPath = "/tmp/operator-config-validation.json";
writeFileSync(validatedPath, JSON.stringify(config), {mode: 0o600});
loadConfig({...process.env, BRIDGE_CONFIG: validatedPath});
writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
chmodSync(path, 0o600);
console.log("Bridge model updated:", model, "thinking:", thinking);
JS
```

The extra file mount is deliberately writable only in this one-off editing
container; the running worker's config mount stays read-only. It avoids host
UID mismatch and writes the file **in place**. If an editor instead replaces
the file's inode, a still-running container can retain the old bind; restarting
only the bridge process inside it does not remount the file. Recreate the worker
as below to make the remount and configuration reload explicit.

For LLM build/revise phases, `maxUsd`/`maxMinutes` are best-effort watcher
thresholds, not a hard provider spending cap. Usage and tokens remain
cumulative across automatic/manual continuation; if cumulative USD exhausts
the old limit, an explicit manual resume must provide a higher **total**
`maxUsd` (positive, at most 50). Manual `maxMinutes` is positive and at most
240 and opens a fresh time window; automatic restart recovery keeps the
original window and is limited to two attempts. The default usage poll is 15
seconds, and missing prices, in-flight calls, and cancellation latency can
exceed a threshold. Hermes usage is separate and not included. Use
provider-side billing limits and account monitoring too. Native render/stitch
jobs do not invoke omp and keep `maxUsd: 0`.

### 8. Recreate the configured services

For this new, idle deployment:

```bash
dc up -d --no-deps --force-recreate video-worker
dc up -d --wait hermes
# Read the startup-generated effective config, not the stale host inode:
dc exec -T video-worker node --input-type=module -e '
import {loadConfig} from "/opt/bridge/src/config.ts";
const path = `${process.env.TMPDIR || "/tmp/omp-worker"}/worker-config.json`;
const c = loadConfig({...process.env, BRIDGE_CONFIG: path});
console.log(JSON.stringify({model: c.runner.defaultModel,
  thinking: c.runner.defaultThinking, workerThinking: c.runner.defaultWorkerThinking}));
'
```

Worker startup combines operator config and Docker webhook secrets into a
private effective config. `docker exec` does not inherit the entrypoint's added
`BRIDGE_CONFIG`, so the check explicitly selects that generated file. The check
does not print secrets. Hermes mounts a directory, so replaced config files
remain visible, but recreate it after provider/Telegram changes to reload
cached settings (`dc up -d --no-deps --force-recreate --wait hermes`).
For a used deployment, drain/stop first rather than treating these as safe live
restart commands.

### 9. Health, authentication and readiness

```bash
# Bash process substitution keeps token bytes out of curl argv/environment.
bridge_api(){ curl --silent --show-error --fail-with-body \
  --header @<(printf 'Authorization: Bearer %s\n' \
    "$(tr -d '\r\n' < "$OMP_VIDEO_STATE_DIR/secrets/bridge-token")") "$@"; }
dc ps
curl --fail --silent --show-error "$BRIDGE_URL/v1/health" | jq .
bridge_api "$BRIDGE_URL/v1/catalog" | jq .
# No bearer header: expected 401, not 200.
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  "$BRIDGE_URL/v1/catalog"
curl --fail --silent --show-error \
  "http://127.0.0.1:$OMP_VIDEO_WEBHOOK_PORT/health"
```

Do not enable `set -x`, `curl -v` or curl trace logging around credentials.
Before a first video, confirm: assets passed checksum validation, the effective
bridge model is the selector you chose, each client has its own credentials,
the provider account has access/quota, Telegram allowlist/home destination are
set, and only one gateway polls this bot. Health and config checks **do not prove**
live LLM inference or Telegram delivery. The first authorized live video is a
paid integration exercise, not a free readiness probe.

Continue with the [copy-paste video tutorial](USAGE.md) for
**submit → storyboard review → approve → render → MP4/contact sheets**, the
`render:false`/native-render alternative, revise/cancel, and explicit manual
resume. It also contains [Telegram user instructions](USAGE.md#7-using-the-bot-through-telegram).
For updates, backup/restore, rollback, relocation and troubleshooting, use
the [Docker runbook](OPS.md#docker-isolated-deployment).

# omp-video-bridge

`omp-video-bridge` is a small, authenticated HTTP bridge for running the
repository's oh-my-pi (`omp`) video pipeline. It stores projects,
scenes, versions, jobs, events, assets, and webhook outbox state in SQLite;
project files and rendered artifacts stay in a separate data directory. The
first bundled pipeline is the HyperFrames explainer. Hermes and Telegram are
optional consumers of the bridge's signed webhook events.

The public repository is spelled **omp-video-bride** (without the second
`g`): <https://github.com/ChiThang-50Cent/omp-video-bride>. The npm package
and local directory intentionally remain `omp-video-bridge`.

## What is included

- A bearer-authenticated `/v1` API for projects, scenes, versions, assets,
  timeline stitching, and jobs.
- A SQLite-backed job state machine with crash recovery, approval gates,
  native render/stitch steps, and an at-least-once signed webhook outbox.
- The `hyperframes-explainer` pipeline and its checked-in worker skill.
- Portable host systemd installation and offline stopped-data backup/restore
  tools.
- An additional isolated Docker/Compose recipe. It is a separate deployment
  shape, not an automatic migration of host state.

The bridge does **not** silently prune old artifacts, restart production, send
Telegram messages, or make paid LLM calls during installation or verification.
There is one intended bridge process per data directory; see the operations
runbook before running a second instance.

## Architecture and contract

Start with these documents before changing or operating the service:

- [Current implementation and API specification](docs/SPEC.md)
- [Operations runbook](docs/OPS.md)
- [Release history](docs/CHANGELOG.md)
- [Pipeline port](src/ports/pipeline.ts) and
  [HTTP routes](src/http/routes.ts)
- [Host installer](deploy/install.sh), [systemd template](deploy/omp-video-bridge.service),
  [backup tool](deploy/backup.mjs), and [restore tool](deploy/restore.mjs)

The source of truth is SQLite at `<dataDir>/bridge.db`. Artifacts are under
`<dataDir>/projects/<project-id>/`; paths recorded in the database are
absolute. The `tools/import-v1.ts` compatibility importer does not move its
source files, so imported v1 media must remain mounted at its old path.

## Supported runtime

- Linux host for the systemd recipe; Linux/amd64 is the verified Docker
  packaging target.
- Node.js `^22.20.0 || ^24.0.0 || >=26.0.0`.
- Native TypeScript stripping in Node; there is no emitted `dist/` directory.
- `node:sqlite`, `node:http`, and `zod` at runtime. Host video operations
  require executable `ffmpeg` and `ffprobe`; the HyperFrames pipeline also
  requires the configured browser and Python provider paths.
- npm with the checked-in `package-lock.json`.

The supported Node versions are deliberate. Node 23 and 25 are not in the
package engine range; use Node 22.20+, Node 24.x, or a release in the `>=26`
engine range.

## Development commands

From a clean checkout:

```sh
npm ci
npm start                 # run src/main.ts using BRIDGE_CONFIG, if set
npm run dev               # watch mode
npm run typecheck         # TypeScript checks, including tests/tools
npm test                  # Vitest suite
npm run smoke             # local authenticated API smoke path
npm run smoke:webhook     # loopback HMAC/outbox retry and dead-letter smoke
npm run smoke:ops         # offline backup/restore and installer preflight
npm run check             # typecheck + test + API + webhook smoke
```

`npm run smoke:media` executes the native FFmpeg cut/fade path and decodes the
result. Do not point a development process at a production `dataDir`; use an
isolated directory and loopback port.

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

```sh
export TOKEN="$(cat "$OMP_VIDEO_DEMO/token")"
curl --fail http://127.0.0.1:18765/v1/health
curl --fail -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:18765/v1/catalog
```

Create a project without starting a production job:

```sh
curl --fail -X POST http://127.0.0.1:18765/v1/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"isolated smoke project","pipeline":"hyperframes-explainer"}'
```

To submit a real one-shot video, use an explicit request and review the
returned job before spending provider/LLM budget. This example is
**authenticated** but is not a no-cost demo:

```sh
curl --fail -X POST http://127.0.0.1:18765/v1/videos \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"topic":"Explain a small API","durationSec":15,"approve":"storyboard","render":false}'
```

Stop the process with `Ctrl-C`. Do not reuse the demo data directory for a
production service. The full request schema and state transitions are in
[`docs/SPEC.md`](docs/SPEC.md).

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
silently migrate a data directory. See [`docs/OPS.md`](docs/OPS.md) for
upgrade, backup, restore, retention, and dead-letter procedures.

## Docker quickstart

The Docker recipe is isolated by design. It requires Docker Engine with
BuildKit and Compose v2 and external state under an absolute directory outside
the repository. Use unused loopback ports when a host service is already
running:

```sh
export OMP_VIDEO_STATE_DIR="$HOME/.local/state/omp-video-bridge-docker"
export COMPOSE_PROJECT_NAME=omp-video-bridge
export OMP_VIDEO_HTTP_PORT=18765
export OMP_VIDEO_WEBHOOK_PORT=28644
sh deploy/setup.sh
```

The complete image, external-state, asset, and Hermes instructions are in the
[Docker deployment section of the specification](docs/SPEC.md#61-repository-docker-deployment-linuxamd64)
and the [operations runbook](docs/OPS.md#docker-isolated-deployment). `setup.sh`
uses bind-mounted state outside Git; it does not import or overwrite host
SQLite data.

## Maintenance and security

- Keep exactly one bridge process per data directory. Stop and drain jobs before
  copying SQLite or artifacts; use the offline tools and the exact commands in
  [`docs/OPS.md`](docs/OPS.md#stopped-consistent-backup-and-restore).
- Retention is manual and review-driven. Do not delete a project directory,
  session history, or database row while a version/job may still reference it.
- Monitor `GET /v1/health` and service logs. Webhook delivery is at-least-once:
  repair the receiver first, inspect dead rows with `tools/outbox.ts`, then
  explicitly redrive selected rows while stopped. Preserve `event_id` for
  receiver deduplication.
- Never commit `.token`, provider credentials, webhook secrets, SQLite files,
  media, or Docker state. Rotate leaked bearer/webhook credentials and review
  logs before sharing them.
- For a suspected security issue, do **not** open a public issue. Use a
  private [GitHub security advisory](https://github.com/ChiThang-50Cent/omp-video-bride/security/advisories/new)
  with a minimal reproduction, affected commit/configuration, and a safe
  contact path. Redact tokens, provider credentials, personal media, and
  webhook signatures. If private advisories are unavailable, contact the
  repository owner privately through GitHub and wait for coordinated
  disclosure.

See [`docs/CHANGELOG.md`](docs/CHANGELOG.md) for release notes and retained
verification limits.

## License

Bridge source is licensed under [Apache-2.0](LICENSE).
Copyright 2026 Thang Nguyen Chi; see [NOTICE](NOTICE).
Third-party dependencies, models, runtimes and downloaded upstream skills retain
their own licenses and attribution.

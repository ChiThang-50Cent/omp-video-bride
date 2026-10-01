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
  timeline stitching, and jobs, including explicit manual job resumption.
- A SQLite-backed job state machine with bounded automatic crash recovery,
  approval gates, native render/stitch steps, and an at-least-once signed
  webhook outbox.
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

## Deployment
- [Docker onboarding](docs/SETUP.md#docker-onboarding): prerequisites, isolated
  state, provider/model setup, Telegram configuration and readiness checks.
- [Isolated host quickstart](docs/SETUP.md#safe-isolated-quickstart) and
  [host systemd installation](docs/SETUP.md#host-systemd-deployment).
- [Video API and Telegram usage](docs/USAGE.md): approval, preview/native render,
  revisions, explicit manual resumption, cancellation and output retrieval.
- [Operations](docs/OPS.md): updates, backup/restore, rollback and troubleshooting.

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

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { OmpRunner } from "./adapters/runner-omp/omp-runner.ts";
import { stitchFfmpeg } from "./adapters/stitch-ffmpeg/stitch.ts";
import { SqliteStore } from "./adapters/store-sqlite/sqlite-store.ts";
import { Dispatcher, outboxHook } from "./adapters/webhook/webhook.ts";
import { App } from "./app/app.ts";
import { loadConfig } from "./config.ts";
import { buildRouter } from "./http/routes.ts";
import { serve } from "./http/router.ts";
import { hyperframesExplainer, hyperframesStorybook } from "./pipelines/hyperframes-explainer/index.ts";

const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };

const cfg = loadConfig();
mkdirSync(cfg.dataDir, { recursive: true });
if (!existsSync(cfg.tokenFile)) {
  mkdirSync(dirname(cfg.tokenFile), { recursive: true });
  writeFileSync(cfg.tokenFile, randomBytes(24).toString("hex"), { mode: 0o600 });
  chmodSync(cfg.tokenFile, 0o600);
}
const token = readFileSync(cfg.tokenFile, "utf8").trim();
if (!token) throw new Error(`token file ${cfg.tokenFile} is empty`);

const store = new SqliteStore(join(cfg.dataDir, "bridge.db"));
const now = () => new Date().toISOString();
const app = new App({
  store,
  runner: new OmpRunner({ bin: cfg.omp.bin, firstEventTimeoutSeconds: cfg.omp.firstEventTimeoutSeconds }),
  pipelines: {
    "hyperframes-explainer": hyperframesExplainer({ env: cfg.env }),
    "hyperframes-storybook": hyperframesStorybook({ env: cfg.env }),
  },
  config: {
    dataDir: cfg.dataDir, concurrency: cfg.runner.concurrency, model: cfg.runner.defaultModel, thinking: cfg.runner.defaultThinking,
    workerModel: cfg.runner.defaultModel, workerThinking: cfg.runner.defaultWorkerThinking,
    maxMinutes: cfg.runner.defaultMaxMinutes, maxUsd: cfg.runner.defaultMaxUsd, env: cfg.env, skillDirs: cfg.omp.skillDirs,
  },
  now,
  stitch: stitchFfmpeg,
  onJobEvent: cfg.webhook ? outboxHook(store, { ...cfg.webhook, mount: cfg.containerMount }, now) : undefined,
});
const dispatcher = cfg.webhook ? new Dispatcher(store, { ...cfg.webhook, mount: cfg.containerMount }) : undefined;

const router = buildRouter(app, store, () => ({
  versions: {
    app: packageMetadata.version ?? "unknown",
    pipelines: Object.fromEntries(Object.values(app.d.pipelines).map(p => [p.id, p.version])),
  },
  webhook: cfg.webhook ? store.outboxCounts() : "disabled",
  jobs: { running: store.listJobs({ state: "running", limit: -1 }).length, queued: store.listJobs({ state: "queued", limit: -1 }).length },
}));
const server = serve(router, { token, publicPaths: ["/v1/health"] });
server.listen(cfg.port, cfg.host, () => {
  console.log(`omp-video-bridge v2 listening on http://${cfg.host}:${cfg.port} data=${cfg.dataDir}`);
  app.recover();
  dispatcher?.start();
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  server.close();
  dispatcher?.stop();
  await app.stop();
  store.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

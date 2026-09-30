import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach } from "vitest";
import { OmpRunner } from "../../src/adapters/runner-omp/omp-runner.ts";
import { SqliteStore } from "../../src/adapters/store-sqlite/sqlite-store.ts";
import { App, type Deps } from "../../src/app/app.ts";
import { buildRouter } from "../../src/http/routes.ts";
import { serve } from "../../src/http/router.ts";
import { hyperframesExplainer } from "../../src/pipelines/hyperframes-explainer/index.ts";

export const fakeOmp = resolve("test/fixtures/fake-omp.mjs");

const resources: { dir: string; store: SqliteStore; app: App }[] = [];
afterEach(async () => {
  for (const { dir, store, app } of resources.splice(0)) {
    try {
      await app.stop();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

export function harness(over: Partial<Deps> = {}, usagePollMs = 50) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-test-"));
  const scenarioFile = join(dir, "scenario.json");
  const logFile = join(dir, "omp-log.jsonl");
  const store = new SqliteStore(join(dir, "db.sqlite"));
  const runner = new OmpRunner({ bin: process.execPath, argvPrefix: [fakeOmp], firstEventTimeoutSeconds: 120, baseEnv: { ...process.env, FAKE_OMP_SCENARIO: scenarioFile, FAKE_OMP_LOG: logFile } });
  const presets = join(dir, "presets");
  const app = new App({
    store, runner, pipelines: { "hyperframes-explainer": hyperframesExplainer({ presetsDir: presets, upstreamScripts: "/x/scripts" }) },
    config: { dataDir: join(dir, "data"), concurrency: 1, model: "m", thinking: "high", workerModel: "m", workerThinking: "medium", maxMinutes: 60, maxUsd: 5, env: {}, skillDirs: [], usagePollMs },
    ...over,
  });
  resources.push({ dir, store, app });
  const scenario = (s: unknown) => writeFileSync(scenarioFile, JSON.stringify(s));
  return { dir, store, app, scenario, logFile, presets };
}

/** A scenario that behaves like a finished build: writes a video and reports it. */
export const okScenario = (extra: Record<string, unknown> = {}) => ({
  writeFiles: { "videos/demo/renders/video.mp4": "fake", "videos/demo/caption_groups.json": "[]", "videos/demo/snapshots/contact-sheet.jpg": "x" },
  steps: [{ text: "working", usd: 0.1 }],
  final: '```json\n{"video":"{{cwd}}/videos/demo/renders/video.mp4","project_dir":"{{cwd}}/videos/demo","duration_s":31.5,"notes":"ok"}\n```',
  ...extra,
});

export { serve, buildRouter };

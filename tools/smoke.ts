import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

// Exercise the actual entrypoint without touching operator state or calling a model.
const dir = mkdtempSync(join(tmpdir(), "bridge-smoke-"));
const children = new Set<ChildProcess>();
const token = "isolated-smoke-token";
const tokenFile = join(dir, "token");
const configFile = join(dir, "config.json");
const packageVersion = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))).version;
const Health = z.object({ ok: z.boolean(), versions: z.object({ app: z.string(), pipelines: z.record(z.string(), z.string()) }) });

async function unusedPort(): Promise<number> {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  const closed = Promise.withResolvers<void>();
  socket.close(error => error ? closed.reject(error) : closed.resolve());
  await closed.promise;
  return port;
}

function launch(port: number, dataDir: string) {
  writeFileSync(configFile, JSON.stringify({ host: "127.0.0.1", port, dataDir, tokenFile, omp: { bin: join(dir, "must-not-run-omp") } }));
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/main.ts"], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, BRIDGE_CONFIG: configFile, BRIDGE_HOST: "127.0.0.1", BRIDGE_PORT: String(port), BRIDGE_DATA_DIR: dataDir, BRIDGE_TOKEN_FILE: tokenFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let output = "";
  child.stdout!.on("data", chunk => { output += chunk; });
  child.stderr!.on("data", chunk => { output += chunk; });
  const done = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  child.once("error", done.reject);
  child.once("close", (code, signal) => { children.delete(child); done.resolve({ code, signal }); });
  return { child, done: done.promise, output: () => output };
}

async function deadline<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error(`${label} timed out`)), milliseconds);
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally { clearTimeout(timer); }
}

try {
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const port = await unusedPort();
  const run = launch(port, join(dir, "data"));
  const base = `http://127.0.0.1:${port}`;
  const readyUntil = Date.now() + 10_000;
  let health: z.infer<typeof Health> | undefined;
  while (Date.now() < readyUntil) {
    if (run.child.exitCode !== null) throw new Error(`service exited before readiness: ${run.output()}`);
    try {
      const response = await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) { health = Health.parse(await response.json()); break; }
    } catch { /* Startup connection refusal only; bounded by readyUntil. */ }
    await delay(50);
  }
  assert(health?.ok, `service did not become ready: ${run.output()}`);
  assert.equal(health.versions.app, packageVersion);
  assert.equal(typeof health.versions.pipelines["hyperframes-explainer"], "string");
  const request = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, {
    ...init, headers: { authorization: `Bearer ${token}`, ...init.headers }, signal: AbortSignal.timeout(5000),
  });
  assert.equal((await fetch(`${base}/v1/catalog`)).status, 401);
  assert.equal((await fetch(`${base}/v1/catalog`, { headers: { authorization: token } })).status, 401);
  const catalog = await request("/v1/catalog");
  assert.equal(catalog.status, 200);
  const catalogBody = z.object({ pipelines: z.array(z.object({ pipeline: z.string() })) }).parse(await catalog.json());
  assert(catalogBody.pipelines.some(p => p.pipeline === "hyperframes-explainer"));
  for (const query of ["limit=0", "limit=-1", "limit=1.5", "limit=NaN", "limit=501", "state=invalid"]) {
    assert.equal((await request(`/v1/jobs?${query}`)).status, 400, query);
  }
  const created = await request("/v1/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "isolated smoke" }) });
  assert.equal(created.status, 201);
  const { project } = z.object({ project: z.object({ id: z.string() }) }).parse(await created.json());
  const upload = await request(`/v1/projects/${project.id}/assets?name=logo.svg`, { method: "POST", body: "<svg xmlns=\"http://www.w3.org/2000/svg\"/>" });
  assert.equal(upload.status, 201);
  const { asset } = z.object({ asset: z.object({ id: z.string() }) }).parse(await upload.json());
  assert.equal((await request(`/v1/projects/${project.id}/assets/${asset.id}`, { method: "DELETE" })).status, 200);
  const assets = await request(`/v1/projects/${project.id}/assets`);
  const listedAssets = z.object({ assets: z.array(z.unknown()) }).parse(await assets.json());
  assert.deepEqual(listedAssets.assets, []);
  assert.equal((await request(`/v1/projects/${project.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await request(`/v1/projects/${project.id}`)).status, 404);
  run.child.kill("SIGTERM");
  assert.equal((await deadline(run.done, 5000, "graceful shutdown")).code, 0);

  writeFileSync(tokenFile, " \n", { mode: 0o600 });
  const invalid = launch(await unusedPort(), join(dir, "invalid-data"));
  const exit = await deadline(invalid.done, 5000, "blank-token startup rejection");
  assert.notEqual(exit.code, 0, invalid.output());
  console.log("PASS native service smoke: isolated startup, versioned health, bearer auth, query validation, project/asset lifecycle, graceful shutdown, blank-token rejection");
} finally {
  for (const child of children) child.kill("SIGKILL");
  await Promise.all([...children].map(child => child.exitCode !== null ? Promise.resolve() : once(child, "exit")));
  rmSync(dir, { recursive: true, force: true });
}

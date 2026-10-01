#!/usr/bin/env node
// Stand-in for `omp -p --mode json ...` in runner/integration tests. No model calls, no cost.
// Behaviour comes from the JSON file named by FAKE_OMP_SCENARIO:
//   { "steps": [ {"text": "...", "usd": 0.1}, {"sleepMs": 500}, ... ],
//     "final": "text of the last assistant message",
//     "exit": 0,
//     "writeFiles": { "relative/path": "content" },  // created under --cwd
//     "writeMode": 384                             // optional file mode (0600)
//   }
// Every invocation appends {argv, cwd, continued} to FAKE_OMP_LOG (JSONL), so tests can assert on it.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const flag = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const cwd = flag("--cwd") ?? process.cwd();
const continued = argv.includes("--continue") || argv.includes("--session");
// Explicit --session and automatic --continue both keep the existing session.
let scenario = JSON.parse(readFileSync(process.env.FAKE_OMP_SCENARIO, "utf8").replaceAll("{{cwd}}", cwd));
if (continued && scenario.continued) scenario = { ...scenario, ...scenario.continued };
// Persist a main session before the first provider event, like real omp.
const sessionDir = flag("--session-dir");
const sessionFile = flag("--session") ?? (sessionDir ? join(sessionDir, "main.jsonl") : undefined);
if (sessionFile && !existsSync(sessionFile)) {
  if (continued && argv.includes("--session")) throw new Error("selected session is missing");
  mkdirSync(dirname(sessionFile), { recursive: true });
  const timestamp = new Date().toISOString();
  writeFileSync(sessionFile, [
    { type: "session", version: 3, id: "fake-main-session", timestamp, cwd },
    { type: "message", id: "user-1", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: argv.at(-1) }] } },
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
}

if (process.env.FAKE_OMP_LOG) {
  appendFileSync(process.env.FAKE_OMP_LOG, JSON.stringify({ argv, cwd, continued, pid: process.pid }) + "\n");
}
for (const [rel, content] of Object.entries(scenario.writeFiles ?? {})) {
  const p = join(cwd, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, { mode: scenario.writeMode ?? 0o644 });
}
const emit = (text, usd = 0) => {
  const message = { role: "assistant", content: [{ type: "text", text }], usage: { input: 100, output: 50, cost: { total: usd } } };
  if (sessionFile) appendFileSync(sessionFile, JSON.stringify({ type: "message", message }) + "\n");
  console.log(JSON.stringify({ type: "message_end", message }));
};

process.on("SIGTERM", () => process.exit(143));
for (const step of scenario.steps ?? []) {
  if (step.sleepMs) await new Promise(r => setTimeout(r, step.sleepMs));
  if (step.text) emit(step.text, step.usd);
}
if (scenario.final) emit(scenario.final, scenario.finalUsd ?? 0);
process.exit(scenario.exit ?? 0);

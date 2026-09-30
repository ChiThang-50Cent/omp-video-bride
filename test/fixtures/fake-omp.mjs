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
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const flag = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const cwd = flag("--cwd") ?? process.cwd();
// `{{cwd}}` in any string is replaced by --cwd; a `continued` object overrides fields when --continue is passed.
let scenario = JSON.parse(readFileSync(process.env.FAKE_OMP_SCENARIO, "utf8").replaceAll("{{cwd}}", cwd));
if (argv.includes("--continue") && scenario.continued) scenario = { ...scenario, ...scenario.continued };

if (process.env.FAKE_OMP_LOG) {
  appendFileSync(process.env.FAKE_OMP_LOG, JSON.stringify({ argv, cwd, continued: argv.includes("--continue"), pid: process.pid }) + "\n");
}
for (const [rel, content] of Object.entries(scenario.writeFiles ?? {})) {
  const p = join(cwd, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, { mode: scenario.writeMode ?? 0o644 });
}
// Real omp records every assistant message (with usage) in <session-dir>/*.jsonl; the bridge sums those files.
const sessionDir = flag("--session-dir");
const emit = (text, usd = 0) => {
  const line = { message: { role: "assistant", usage: { input: 100, output: 50, cost: { total: usd } } } };
  if (sessionDir) { mkdirSync(sessionDir, { recursive: true }); appendFileSync(join(sessionDir, "main.jsonl"), JSON.stringify(line) + "\n"); }
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 100, output: 50, cost: { total: usd } } } }));
};

process.on("SIGTERM", () => process.exit(143));
for (const step of scenario.steps ?? []) {
  if (step.sleepMs) await new Promise(r => setTimeout(r, step.sleepMs));
  if (step.text) emit(step.text, step.usd);
}
if (scenario.final) emit(scenario.final, scenario.finalUsd ?? 0);
process.exit(scenario.exit ?? 0);

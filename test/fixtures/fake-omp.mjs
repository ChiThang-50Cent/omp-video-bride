#!/usr/bin/env node
// Stand-in for `omp -p --mode json ...` in runner/integration tests. No model calls, no cost.
// Behaviour comes from the JSON file named by FAKE_OMP_SCENARIO:
//   { "steps": [ {"text": "...", "usd": 0.1}, {"sleepMs": 500}, ... ],
//     "final": "text of the last assistant message",
//     "exit": 0,
//     "writeFiles": { "relative/path": "content" }   // created under --cwd
//   }
// Every invocation appends {argv, cwd, continued} to FAKE_OMP_LOG (JSONL), so tests can assert on it.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const flag = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const cwd = flag("--cwd") ?? process.cwd();
const scenario = JSON.parse(readFileSync(process.env.FAKE_OMP_SCENARIO, "utf8"));

if (process.env.FAKE_OMP_LOG) {
  appendFileSync(process.env.FAKE_OMP_LOG, JSON.stringify({ argv, cwd, continued: argv.includes("--continue"), pid: process.pid }) + "\n");
}
for (const [rel, content] of Object.entries(scenario.writeFiles ?? {})) {
  const p = join(cwd, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}
const emit = (text, usd = 0) =>
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 100, output: 50, cost: { total: usd } } } }));

process.on("SIGTERM", () => process.exit(143));
for (const step of scenario.steps ?? []) {
  if (step.sleepMs) await new Promise(r => setTimeout(r, step.sleepMs));
  if (step.text) emit(step.text, step.usd);
}
if (scenario.final) emit(scenario.final, scenario.finalUsd ?? 0);
process.exit(scenario.exit ?? 0);

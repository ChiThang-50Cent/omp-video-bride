import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Usage } from "../../core/job.ts";
import type { RunHandle, RunOptions, Runner } from "../../ports/runner.ts";

export interface OmpRunnerConfig {
  bin: string;
  firstEventTimeoutSeconds: number;
  /** Command line prefix, so tests can run `node fake-omp.mjs` instead of the real binary. */
  argvPrefix?: string[];
  baseEnv?: NodeJS.ProcessEnv;
}

export class OmpRunner implements Runner {
  private readonly cfg: OmpRunnerConfig;
  constructor(cfg: OmpRunnerConfig) {
    this.cfg = cfg;
  }

  start(o: RunOptions): RunHandle {
    mkdirSync(o.workdir, { recursive: true });
    // Frame workers are `task` subagents: without this overlay they use the host's modelRoles.task.
    // First-event timeout: provider stalls of 12-19 min before the first token were observed;
    // aborting lets omp's retry resend instead of waiting.
    const overlay = join(o.workdir, "omp-overlay.yml");
    writeFileSync(overlay, JSON.stringify({
      modelRoles: { default: `${o.model}:${o.thinking}`, task: `${o.workerModel}:${o.workerThinking}` },
      providers: { streamFirstEventTimeoutSeconds: this.cfg.firstEventTimeoutSeconds },
      skills: { customDirectories: o.skillDirs },
    }));
    const args = [
      ...(this.cfg.argvPrefix ?? []),
      "-p", "--session-dir", join(o.workdir, "sessions"), "--mode", "json",
      "--model", o.model, "--thinking", o.thinking, "--config", overlay, "--cwd", o.workdir,
      ...(o.resume ? ["--continue"] : []),
      o.prompt,
    ];
    const [cmd, ...rest] = [this.cfg.bin, ...args];
    const flag = o.resume ? "a" : "w";
    const log = createWriteStream(join(o.workdir, "omp.jsonl"), { flags: flag });
    const errLog = createWriteStream(join(o.workdir, "omp.stderr.log"), { flags: flag });
    // Own process group, so cancel also kills render/TTS/Chrome children.
    const child = spawn(cmd!, rest, { cwd: o.workdir, env: { ...(this.cfg.baseEnv ?? process.env), ...o.env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.pipe(errLog);

    let finalText = "";
    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      log.write(chunk);
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.startsWith('{"type":"message_end"')) continue;
        try {
          const msg = JSON.parse(line).message as { role?: string; content?: { type: string; text?: string }[] };
          if (msg.role === "assistant") finalText = (msg.content ?? []).filter(c => c.type === "text").map(c => c.text ?? "").join("\n") || finalText;
        } catch { /* partial or foreign line */ }
      }
    });

    const pgid = child.pid;
    const done = new Promise<{ code: number | null; signal: string | null; finalText: string }>(resolve => {
      child.on("error", () => resolve({ code: -1, signal: null, finalText }));
      child.on("close", (code, signal) => {
        log.end();
        errLog.end();
        resolve({ code, signal, finalText });
      });
    });
    return {
      pid: pgid,
      done,
      kill(graceMs = 10_000) {
        if (!pgid) return;
        try { process.kill(-pgid, "SIGTERM"); } catch { /* already gone */ }
        setTimeout(() => { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } }, graceMs).unref();
      },
    };
  }

  usage(workdir: string): Usage {
    const total: Usage = { usd: 0, inputTokens: 0, outputTokens: 0 };
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith(".jsonl")) continue;
        for (const line of readFileSync(p, "utf8").split("\n")) {
          if (!line.includes('"usage"')) continue;
          try {
            const u = (JSON.parse(line).message as { usage?: { input?: number; output?: number; cost?: { total?: number } } } | undefined)?.usage;
            if (!u) continue;
            total.usd += u.cost?.total ?? 0;
            total.inputTokens += u.input ?? 0;
            total.outputTokens += u.output ?? 0;
          } catch { /* skip */ }
        }
      }
    };
    walk(join(workdir, "sessions"));
    total.usd = Math.round(total.usd * 1e6) / 1e6;
    return total;
  }
}

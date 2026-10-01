import type { Usage } from "../core/job.ts";

export interface RunOptions {
  workdir: string;
  prompt: string;
  /** Continue the omp session stored in workdir/sessions instead of starting a new one. */
  resume: boolean;
  /** Explicit main-session file selected for an operator-requested resume. */
  sessionFile?: string;
  model: string;
  thinking: string;
  workerModel: string;
  workerThinking: string;
  skillDirs: string[];
  env: Record<string, string>;
}

export interface RunHandle {
  readonly pid: number | undefined;
  /** Resolves when the whole process group is gone. */
  readonly done: Promise<{ code: number | null; signal: string | null; finalText: string }>;
  /** SIGTERM the process group; SIGKILL after `graceMs`. */
  kill(graceMs?: number): void;
}

export interface Runner {
  start(opts: RunOptions): RunHandle;
  /** Finds a main session, or validates an already pinned file without falling back. */
  sessionToResume(workdir: string, sessionFile?: string): string | null;
  /** Total usage of the orchestrator and all subagents in this workdir. */
  usage(workdir: string): Usage;
}

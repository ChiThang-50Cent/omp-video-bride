import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// One JSON file (BRIDGE_CONFIG) plus env overrides for the deploy-specific bits.
// Every path defaults from $HOME, so nothing in the code is tied to one machine.
const home = homedir();

const ConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(8765),
  /** File holding the bearer token. */
  tokenFile: z.string().default(join(home, ".config/omp-video-bridge/token")),
  /** Root for the database and all project files. */
  dataDir: z.string().default(join(home, ".local/share/omp-video-bridge")),
  omp: z.object({
    bin: z.string().default(join(home, ".local/bin/omp")),
    /** Directories omp loads skills from, in addition to the pipeline's own. */
    skillDirs: z.array(z.string()).default([join(home, ".pi/agent/skills")]),
    firstEventTimeoutSeconds: z.number().int().min(10).default(120),
  }).prefault({}),
  runner: z.object({
    concurrency: z.number().int().min(1).max(8).default(1),
    defaultModel: z.string().default("openai-codex/gpt-5.6-luna"),
    defaultThinking: z.string().default("high"),
    defaultWorkerThinking: z.string().default("medium"),
    defaultMaxMinutes: z.number().positive().default(60),
    defaultMaxUsd: z.number().positive().default(5),
  }).prefault({}),
  /** Extra environment for every omp child (browser, TTS python, ...). */
  env: z.record(z.string(), z.string()).default({}),
  webhook: z.object({
    url: z.string().url(),
    secret: z.string().min(16),
  }).optional(),
  /** How Hermes sees the data dir, for the container paths in webhooks. */
  containerMount: z.object({ host: z.string(), container: z.string() }).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const file = env.BRIDGE_CONFIG;
  const raw: Record<string, unknown> = file ? JSON.parse(readFileSync(file, "utf8")) : {};
  if (env.BRIDGE_HOST) raw.host = env.BRIDGE_HOST;
  if (env.BRIDGE_PORT) raw.port = Number(env.BRIDGE_PORT);
  if (env.BRIDGE_DATA_DIR) raw.dataDir = env.BRIDGE_DATA_DIR;
  if (env.BRIDGE_TOKEN_FILE) raw.tokenFile = env.BRIDGE_TOKEN_FILE;
  return ConfigSchema.parse(raw);
}

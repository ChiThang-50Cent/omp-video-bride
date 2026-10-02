import type { ZodType } from "zod";
import type { Asset, Project, Scene } from "../core/entities.ts";
import type { Job } from "../core/job.ts";

export type PromptKind = "build" | "revise" | "resume" | "approve-continue";

export interface PromptCtx {
  kind: PromptKind;
  job: Job;
  project: Project;
  scene: Scene;
  /** omp cwd of this version. */
  workdir: string;
  /** Pipeline project dir when it is already known (revise / resume / approve-continue). */
  projectDir: string | null;
  assets: { dir: string; foundDir: string; selected: Asset[]; others: Asset[] };
  revise?: { instructions: string; frames: number[]; durationSec: number | null; currentDurationSec: number | null };
  flags: { approve: "storyboard" | null; render: boolean };
  approvalNotes: string | null;
}

export type ParsedResult =
  | { kind: "ok"; video: string | null; projectDir: string; contactSheets: string[]; captionsGroups: string | null; durationSec: number | null; note: string | null; changed: number[] }
  | { kind: "awaiting_approval"; projectDir: string; storyboard: string; script: string | null }
  | { kind: "rejected"; reason: string }
  | { kind: "invalid"; message: string };

export interface Catalog {
  pipeline: string;
  version: string;
  options: Record<string, unknown>;
}

/** A way of producing a video. The core knows nothing beyond this interface. */
export interface Pipeline {
  readonly id: string;
  readonly version: string;
  /** Project-level look shared by all scenes (validated; defaults applied). */
  readonly specSchema: ZodType<Record<string, unknown>>;
  /** Extra scene-level options this pipeline understands. */
  readonly sceneOptionsSchema: ZodType<Record<string, unknown>>;
  catalog(): Promise<Catalog>;
  /** Stage a bridge-owned production contract before authoring starts. */
  prepareBuild?(ctx: PromptCtx): void;
  prompt(ctx: PromptCtx): string;
  parseResult(finalText: string, workdir: string, opts: { requireVideo: boolean }): ParsedResult;
  /** How omp is configured for this pipeline. */
  omp(): { skillDirs: string[]; env: Record<string, string> };
  /** Copy a finished version's project into a fresh workdir for revision; returns the new project dir. */
  prepareRevision(fromProjectDir: string, toWorkdir: string): string;
  /** Render a previewed version without an LLM. */
  render(projectDir: string, signal?: AbortSignal): Promise<{ video: string; durationSec: number | null }>;
}

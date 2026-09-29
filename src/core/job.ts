// Job entity and its state machine. Pure: no I/O, no clock (callers pass `now`).
// Every state change goes through `transition`; illegal moves throw IllegalTransition.

export const JOB_KINDS = ["build", "revise", "stitch", "render"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATES = ["queued", "running", "awaiting_approval", "interrupted", "succeeded", "failed", "rejected", "cancelled"] as const;
export type JobState = (typeof JOB_STATES)[number];

export const TERMINAL_STATES: Readonly<Record<JobState, boolean>> = {
  queued: false, running: false, awaiting_approval: false, interrupted: false,
  succeeded: true, failed: true, rejected: true, cancelled: true,
};
export const MAX_RESUMES = 2;

export interface JobError {
  code: string;
  message: string;
}

export interface Usage {
  usd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface Job {
  id: string;
  kind: JobKind;
  pipeline: string;
  state: JobState;
  /** Validated pipeline input (opaque to the core). */
  input: unknown;
  /** Caller data echoed in every webhook (chat id, platform, ...). */
  metadata: Record<string, unknown>;
  limits: { maxMinutes: number; maxUsd: number };
  /** Number of times the runner started this job. */
  attempts: number;
  /** Number of automatic resumes after an interruption. */
  resumes: number;
  /** True when the next start must continue the existing omp session. */
  resume: boolean;
  /** Why the session continues: an interruption (crash/restart) or a passed approval gate. */
  resumeReason: "crash" | "approval" | null;
  /** Links to the entities this job works on. */
  refs: { projectId?: string; sceneId?: string; versionId?: string };
  /** Reviewer notes from the approval gate, applied when the job continues. */
  approvalNotes: string | null;
  /** "main" until the approval gate is passed, then "after-approval". */
  phase: "main" | "after-approval";
  usage: Usage;
  error: JobError | null;
  result: unknown;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export type JobEvent =
  | { type: "start" }
  | { type: "succeed"; result: unknown }
  | { type: "fail"; error: JobError }
  | { type: "reject"; error: JobError }
  | { type: "cancel"; reason?: string }
  | { type: "need_approval" }
  | { type: "approve"; notes?: string }
  | { type: "interrupt" }
  | { type: "resume" }
  | { type: "usage"; usage: Usage };

export class IllegalTransition extends Error {
  readonly jobId: string;
  readonly from: JobState;
  readonly event: JobEvent["type"];
  constructor(jobId: string, from: JobState, event: JobEvent["type"]) {
    super(`job ${jobId}: event "${event}" is not allowed in state "${from}"`);
    this.name = "IllegalTransition";
    this.jobId = jobId;
    this.from = from;
    this.event = event;
  }
}

type EventType = JobEvent["type"];
const ALLOWED: Record<JobState, Partial<Record<EventType, true>>> = {
  queued: { start: true, cancel: true },
  running: { succeed: true, fail: true, reject: true, cancel: true, need_approval: true, interrupt: true, usage: true },
  awaiting_approval: { approve: true, cancel: true },
  interrupted: { resume: true, cancel: true, fail: true },
  succeeded: {},
  failed: {},
  rejected: {},
  cancelled: {},
};

export function newJob(init: {
  id: string;
  kind: JobKind;
  pipeline: string;
  input: unknown;
  metadata?: Record<string, unknown>;
  limits?: Partial<Job["limits"]>;
  refs?: Job["refs"];
  now: string;
}): Job {
  return {
    id: init.id,
    kind: init.kind,
    pipeline: init.pipeline,
    state: "queued",
    input: init.input,
    metadata: init.metadata ?? {},
    limits: { maxMinutes: init.limits?.maxMinutes ?? 60, maxUsd: init.limits?.maxUsd ?? 5 },
    attempts: 0,
    resumes: 0,
    resume: false,
    resumeReason: null,
    refs: init.refs ?? {},
    approvalNotes: null,
    phase: "main",
    usage: { usd: 0, inputTokens: 0, outputTokens: 0 },
    error: null,
    result: null,
    createdAt: init.now,
    startedAt: null,
    finishedAt: null,
    updatedAt: init.now,
  };
}

/** Returns the next job value. Never mutates its argument. */
export function transition(job: Job, event: JobEvent, now: string): Job {
  if (!ALLOWED[job.state][event.type]) throw new IllegalTransition(job.id, job.state, event.type);
  const next: Job = { ...job, updatedAt: now };
  switch (event.type) {
    case "start":
      next.state = "running";
      next.resume = false;
      next.attempts = job.attempts + 1;
      next.startedAt = job.startedAt ?? now;
      break;
    case "usage":
      next.usage = event.usage;
      break;
    case "need_approval":
      next.state = "awaiting_approval";
      break;
    case "approve":
      // The same omp session continues with the approval notes.
      next.state = "queued";
      next.resume = true;
      next.resumeReason = "approval";
      next.phase = "after-approval";
      next.approvalNotes = event.notes ?? null;
      break;
    case "interrupt":
      next.state = "interrupted";
      break;
    case "resume":
      if (job.resumes >= MAX_RESUMES) {
        next.state = "failed";
        next.error = { code: "resume_exhausted", message: `interrupted ${job.resumes + 1} times; giving up` };
        next.finishedAt = now;
      } else {
        next.state = "queued";
        next.resume = true;
        next.resumeReason = "crash";
        next.resumes = job.resumes + 1;
      }
      break;
    case "succeed":
      next.state = "succeeded";
      next.result = event.result;
      next.finishedAt = now;
      break;
    case "fail":
      next.state = "failed";
      next.error = event.error;
      next.finishedAt = now;
      break;
    case "reject":
      next.state = "rejected";
      next.error = event.error;
      next.finishedAt = now;
      break;
    case "cancel":
      next.state = "cancelled";
      next.error = { code: "cancelled", message: event.reason ?? "cancelled by request" };
      next.finishedAt = now;
      break;
  }
  return next;
}

/** Limit check used by the runner on every usage update. */
export function limitExceeded(job: Job, now: string): JobError | null {
  if (job.usage.usd > job.limits.maxUsd) return { code: "limit_exceeded", message: `cost $${job.usage.usd.toFixed(2)} exceeded the $${job.limits.maxUsd} limit` };
  if (job.startedAt) {
    const minutes = (Date.parse(now) - Date.parse(job.startedAt)) / 60_000;
    if (minutes > job.limits.maxMinutes) return { code: "limit_exceeded", message: `runtime exceeded ${job.limits.maxMinutes} min` };
  }
  return null;
}

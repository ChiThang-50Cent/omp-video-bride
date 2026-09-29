import type { Job, JobEvent, JobState } from "../core/job.ts";

export interface StoredEvent {
  id: number;
  jobId: string;
  type: string;
  at: string;
  data: unknown;
}

/** Persistence port. Synchronous on purpose: the SQLite adapter runs everything in transactions. */
export interface Store {
  /** Runs `fn` atomically; a throw rolls everything back. */
  tx<T>(fn: () => T): T;
  insertJob(job: Job): void;
  getJob(id: string): Job | undefined;
  listJobs(filter?: { state?: JobState; kind?: string; limit?: number }): Job[];
  /** Applies a state-machine event: loads, transitions, saves and logs in one transaction. */
  applyEvent(jobId: string, event: JobEvent, now: string): Job;
  listEvents(jobId: string, sinceId?: number): StoredEvent[];
  close(): void;
}

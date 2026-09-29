import type { Asset, Project, Scene, Version } from "../core/entities.ts";
import type { Job, JobEvent, JobState } from "../core/job.ts";

export interface StoredEvent {
  id: number;
  jobId: string;
  type: string;
  at: string;
  data: unknown;
}

export interface OutboxRow {
  id: number;
  eventId: string;
  payload: string;
  attempts: number;
  nextAt: string;
}

/** Persistence port. Synchronous on purpose: the SQLite adapter runs everything in transactions. */
export interface Store {
  /** Runs `fn` atomically; a throw rolls everything back. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T;

  insertJob(job: Job): void;
  getJob(id: string): Job | undefined;
  listJobs(filter?: { state?: JobState; kind?: string; projectId?: string; limit?: number }): Job[];
  /** Loads, applies the state-machine event, saves and logs, in one transaction. */
  applyEvent(jobId: string, event: JobEvent, now: string): Job;
  listEvents(jobId: string, sinceId?: number): StoredEvent[];

  putProject(p: Project): void;
  getProject(id: string): Project | undefined;
  listProjects(): Project[];
  deleteProject(id: string): void;

  putScene(s: Scene): void;
  getScene(id: string): Scene | undefined;
  listScenes(projectId: string): Scene[];
  deleteScene(id: string): void;

  putVersion(v: Version): void;
  getVersion(id: string): Version | undefined;
  listVersions(sceneId: string): Version[];

  putAsset(a: Asset): void;
  getAsset(id: string): Asset | undefined;
  listAssets(projectId: string): Asset[];
  deleteAsset(id: string): void;

  enqueueOutbox(eventId: string, payload: string, now: string): void;
  dueOutbox(now: string, limit: number): OutboxRow[];
  outboxDelivered(id: number): void;
  outboxRetry(id: number, attempts: number, nextAt: string, dead: boolean): void;
  outboxCounts(): { pending: number; dead: number };

  close(): void;
}

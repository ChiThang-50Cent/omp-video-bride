import { createHmac, randomBytes } from "node:crypto";
import type { Job, JobEvent } from "../../core/job.ts";
import type { Store } from "../../ports/store.ts";

export interface WebhookConfig {
  url: string;
  secret: string;
  /** Rewrites host paths in payloads to what the receiver sees (docker mount). */
  mount?: { host: string; container: string };
  /** Retry delays in ms; the delivery is `dead` after the last one fails. */
  backoffMs?: number[];
}

const NAMES: Partial<Record<JobEvent["type"], string>> = {
  start: "job.started", need_approval: "job.awaiting_approval", succeed: "job.succeeded", fail: "job.failed",
  reject: "job.rejected", cancel: "job.cancelled", resume: "job.resumed", manual_resume: "job.resumed",
};

export function eventName(job: Job, event: JobEvent): string | undefined {
  if (event.type === "resume" && job.state === "failed") return "job.failed";
  if (event.type === "start" && job.attempts > 1) return undefined; // restart after resume/approval: `job.resumed` already told
  return NAMES[event.type];
}

export function buildPayload(job: Job, name: string, eventId: string, at: string, mount?: WebhookConfig["mount"]): string {
  let body = JSON.stringify({
    event_type: name, event_id: eventId, at,
    job: { id: job.id, kind: job.kind, state: job.state, refs: job.refs, usage: job.usage, error: job.error, result: job.result, phase: job.phase, attempts: job.attempts },
    metadata: job.metadata,
  });
  if (mount) body = body.replaceAll(mount.host, mount.container);
  return body;
}

export function signature(secret: string, ts: string, body: string): string {
  return createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
}

/** Enqueues in the same transaction as the job event, so a webhook is never lost or sent for a rolled-back change. */
export function outboxHook(store: Store, cfg: WebhookConfig, now: () => string) {
  return (job: Job, event: JobEvent): void => {
    const name = eventName(job, event);
    if (!name) return;
    const eventId = `evt_${randomBytes(6).toString("hex")}`;
    store.enqueueOutbox(eventId, buildPayload(job, name, eventId, now(), cfg.mount), now());
  };
}

export class Dispatcher {
  private readonly store: Store;
  private readonly cfg: WebhookConfig;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(store: Store, cfg: WebhookConfig, opts: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.store = store;
    this.cfg = cfg;
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  start(intervalMs = 2000): void {
    this.timer = setInterval(() => void this.drain(), intervalMs);
    this.timer.unref();
  }
  stop(): void { clearInterval(this.timer); }

  /** Delivers everything due. Per-row failures reschedule; they never throw. */
  async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const backoff = this.cfg.backoffMs ?? [10_000, 60_000, 300_000, 1_800_000];
      for (const row of this.store.dueOutbox(new Date(this.now()).toISOString(), 20)) {
        const ts = String(Math.floor(this.now() / 1000));
        let ok = false;
        try {
          const res = await this.fetchFn(this.cfg.url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-webhook-timestamp": ts, "x-webhook-signature-v2": signature(this.cfg.secret, ts, row.payload), "x-request-id": row.eventId },
            body: row.payload,
            signal: AbortSignal.timeout(10_000),
          });
          ok = res.ok;
        } catch { ok = false; }
        if (ok) this.store.outboxDelivered(row.id);
        else {
          const attempts = row.attempts + 1;
          const dead = attempts > backoff.length;
          this.store.outboxRetry(row.id, attempts, new Date(this.now() + (backoff[attempts - 1] ?? 0)).toISOString(), dead);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

import { describe, expect, it } from "vitest";
import { Dispatcher, buildPayload, outboxHook, signature } from "../../src/adapters/webhook/webhook.ts";
import { harness, okScenario } from "./harness.ts";

describe("webhook outbox", () => {
  it("emits started and succeeded once each, signed, with metadata and container paths", async () => {
    const cfg = { url: "http://hermes/webhooks/omp", secret: "s".repeat(20) };
    const h = harness();
    const hooked = new (h.app.constructor as any)({ ...h.app.d, onJobEvent: outboxHook(h.store, { ...cfg, mount: { host: h.dir, container: "/videos" } }, () => new Date().toISOString()) });
    h.scenario(okScenario());
    hooked.createVideo({ topic: "Notify me" }, { metadata: { chat: 7 } });
    await hooked.idle();
    const calls: { headers: Record<string, string>; body: string }[] = [];
    let fail = true;
    const d = new Dispatcher(h.store, { ...cfg, backoffMs: [0, 0] }, {
      fetch: (async (_u: string, init: any) => { if (fail) return new Response("no", { status: 503 }); calls.push({ headers: init.headers, body: init.body }); return new Response("ok"); }) as any,
    });
    await d.drain();
    expect(h.store.outboxCounts().pending).toBe(2); // both failed, rescheduled
    fail = false;
    await d.drain();
    const bodies = calls.map(c => JSON.parse(c.body));
    expect(bodies.map(b => b.event_type)).toEqual(["job.started", "job.succeeded"]);
    expect(bodies[1].metadata).toEqual({ chat: 7 });
    expect(bodies[1].job.result.video).toMatch(/^\/videos\//);
    const c = calls[1]!;
    expect(c.headers["x-webhook-signature-v2"]).toBe(signature(cfg.secret, c.headers["x-webhook-timestamp"]!, c.body));
    expect(h.store.outboxCounts()).toEqual({ pending: 0, dead: 0 });
  });

  it("marks a delivery dead after the last backoff", async () => {
    const h = harness();
    h.store.enqueueOutbox("e1", buildPayload({ ...({} as any), id: "j", kind: "build", state: "failed", refs: {}, usage: {}, metadata: {} }, "job.failed", "e1", "t"), "2000-01-01T00:00:00Z");
    const d = new Dispatcher(h.store, { url: "http://x", secret: "s".repeat(20), backoffMs: [0] }, { fetch: (async () => new Response("", { status: 500 })) as any });
    await d.drain();
    await d.drain();
    expect(h.store.outboxCounts()).toEqual({ pending: 0, dead: 1 });
  });
});

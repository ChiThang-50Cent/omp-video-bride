import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { z } from "zod";
import { SqliteStore } from "../src/adapters/store-sqlite/sqlite-store.ts";
import { buildPayload, Dispatcher } from "../src/adapters/webhook/webhook.ts";
import { newJob, transition } from "../src/core/job.ts";

const store = new SqliteStore(":memory:");
const secret = "local-smoke-webhook-secret";
const received: { eventId: string; body: string }[] = [];
const failures: unknown[] = [];
const statuses = [503, 200, 503];
const receiver = createServer(async (req, res) => {
  try {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    const timestamp = req.headers["x-webhook-timestamp"];
    assert.equal(typeof timestamp, "string");
    const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    assert.equal(req.headers["x-webhook-signature-v2"], digest);
    const payload = z.object({ event_id: z.string(), event_type: z.string(), job: z.object({ id: z.string(), state: z.string() }) }).parse(JSON.parse(body));
    assert.equal(req.headers["x-request-id"], payload.event_id);
    assert.equal(payload.event_type, "job.succeeded");
    assert.equal(payload.job.state, "succeeded");
    received.push({ eventId: payload.event_id, body });
    res.writeHead(statuses[received.length - 1] ?? 500).end();
  } catch (error) {
    failures.push(error);
    res.writeHead(500).end();
  }
});
try {
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  const address = receiver.address();
  assert(address && typeof address !== "string");
  const now = new Date().toISOString();
  const queued = newJob({ id: "webhook-smoke", kind: "render", pipeline: "hyperframes-explainer", input: {}, now });
  const running = transition(queued, { type: "start" }, now);
  const job = transition(running, { type: "succeed", result: { video: "/isolated/video.mp4" } }, now);
  const dispatcher = new Dispatcher(store, { url: `http://127.0.0.1:${address.port}/webhook`, secret, backoffMs: [0] });
  store.enqueueOutbox("event-retry", buildPayload(job, "job.succeeded", "event-retry", now), now);
  await dispatcher.drain();
  assert.deepEqual(store.outboxCounts(), { pending: 1, dead: 0 });
  assert.equal(store.dueOutbox(new Date().toISOString(), 1)[0]?.attempts, 1);
  await dispatcher.drain();
  assert.deepEqual(store.outboxCounts(), { pending: 0, dead: 0 });
  assert.equal(received[0]?.eventId, "event-retry");
  assert.deepEqual(received[1], received[0], "retry must preserve event identity and body");
  const deadDispatcher = new Dispatcher(store, { url: `http://127.0.0.1:${address.port}/webhook`, secret, backoffMs: [] });
  store.enqueueOutbox("event-dead", buildPayload(job, "job.succeeded", "event-dead", now), now);
  await deadDispatcher.drain();
  assert.deepEqual(store.outboxCounts(), { pending: 0, dead: 1 });
  assert.deepEqual(failures, []);
  console.log("PASS real loopback HTTP webhook smoke: HMAC-V2, stable delivery identity/body, failed-request retry, delivery persistence and dead-letter transition");
} finally {
  receiver.closeAllConnections();
  const closed = Promise.withResolvers<void>();
  receiver.close(error => error ? closed.reject(error) : closed.resolve());
  await closed.promise;
  store.close();
}

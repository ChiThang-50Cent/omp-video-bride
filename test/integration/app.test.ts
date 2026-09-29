import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { App } from "../../src/app/app.ts";
import { harness, okScenario } from "./harness.ts";

describe("build", () => {
  it("runs a build to success and records the version, cost and files", async () => {
    const h = harness();
    h.scenario(okScenario());
    const { job, version, scene } = h.app.createVideo({ topic: "How DNS works" });
    await h.app.idle();
    const done = h.app.job(job.id);
    expect(done.state).toBe("succeeded");
    expect(done.usage.usd).toBeCloseTo(0.1);
    const v = h.app.version(version.id);
    expect(v.state).toBe("ready");
    expect(v.durationSec).toBe(31.5);
    expect(existsSync(v.outputs.video!)).toBe(true);
    expect(v.outputs.contactSheets).toHaveLength(1);
    expect(h.app.scene(scene.id).currentVersionId).toBe(version.id);
    const argv = JSON.parse(readFileSync(h.logFile, "utf8").trim().split("\n")[0]!).argv as string[];
    expect(argv.at(-1)).toContain("How DNS works");
    expect(argv).not.toContain("--continue");
  });

  it("fails the job when the reported video is not on disk", async () => {
    const h = harness();
    h.scenario({ steps: [], final: '```json\n{"video":"{{cwd}}/nope.mp4","project_dir":"{{cwd}}/videos/demo"}\n```' });
    const { job, version } = h.app.createVideo({ topic: "Nothing produced" });
    await h.app.idle();
    expect(h.app.job(job.id).error?.code).toBe("bad_result");
    expect(h.app.version(version.id).state).toBe("failed");
  });

  it("kills the run when the cost limit is exceeded", async () => {
    const h = harness();
    h.scenario({ steps: [{ text: "a", usd: 0.6 }, { sleepMs: 30_000 }], final: "x" });
    const { job } = h.app.createVideo({ topic: "Too expensive" }, { limits: { maxUsd: 0.5 } });
    await h.app.idle();
    expect(h.app.job(job.id).error?.code).toBe("limit_exceeded");
  });

  it("rejects a second job on a busy scene", async () => {
    const h = harness();
    h.scenario({ steps: [{ sleepMs: 5_000 }], final: "x" });
    const { scene, job } = h.app.createVideo({ topic: "Busy scene" });
    expect(() => h.app.buildScene(scene.id)).toThrow(/active job/);
    h.app.cancel(job.id);
    await h.app.idle();
    expect(h.app.job(job.id).state).toBe("cancelled");
  });
});

describe("approval gate", () => {
  it("stops after the storyboard, then continues the same session with notes", async () => {
    const h = harness();
    h.scenario({
      writeFiles: { "videos/demo/STORYBOARD.md": "sb" },
      final: '```json\n{"status":"awaiting_approval","storyboard":"{{cwd}}/videos/demo/STORYBOARD.md","project_dir":"{{cwd}}/videos/demo"}\n```',
      continued: okScenario(),
    });
    const { job } = h.app.createVideo({ topic: "Gate me" }, { approve: "storyboard" });
    await h.app.idle();
    expect(h.app.job(job.id).state).toBe("awaiting_approval");
    h.app.approve(job.id, "make scene 2 shorter");
    await h.app.idle();
    expect(h.app.job(job.id).state).toBe("succeeded");
    const calls = readFileSync(h.logFile, "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(calls[1].continued).toBe(true);
    expect(calls[1].argv.at(-1)).toContain("make scene 2 shorter");
  });
});

describe("crash recovery", () => {
  it("resumes a job left running by a stopped process with --continue", async () => {
    const h = harness();
    h.scenario({ steps: [{ sleepMs: 10_000 }], final: "x" });
    const { job } = h.app.createVideo({ topic: "Survive restart" });
    await new Promise(r => setTimeout(r, 300));
    await h.app.stop(); // process going down: job stays `running` in the database
    expect(h.store.getJob(job.id)!.state).toBe("running");

    h.scenario(okScenario());
    const app2 = new App({ ...h.app.d });
    app2.recover();
    await app2.idle();
    expect(app2.job(job.id).state).toBe("succeeded");
    expect(app2.job(job.id).resumes).toBe(1);
    const calls = readFileSync(h.logFile, "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(calls.at(-1).continued).toBe(true);
    expect(calls.at(-1).argv.at(-1)).toContain("interrupted");
  });
});

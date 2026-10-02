import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
// @ts-expect-error standalone worker JavaScript
import { compareVisualPixels, evidenceDigest, verifyVisualEvidence } from "../../src/pipelines/hyperframes-explainer/skills/omp-storybook-pipeline/scripts/visual-evidence.mjs";
// @ts-expect-error standalone worker JavaScript
import { sha256File } from "../../src/pipelines/hyperframes-explainer/skills/omp-storybook-pipeline/scripts/storybook-schema.mjs";

function fixture(root: string) {
  writeFileSync(join(root, "screenshot.png"), "original screenshot");
  writeFileSync(join(root, "contact.jpg"), "original contact sheet");
  const screenshots = ["screenshot.png"];
  const contactSheets = [{ path: "contact.jpg", sha256: sha256File(join(root, "contact.jpg")) }];
  const audit = { compiled: { sha256: "compiled" }, source: { digest: "source" }, manifest: { sha256: "manifest" }, composition: { sha256: "composition" }, index: { sha256: "index" }, captions: null, samples: [], video: null, evidence: { screenshots, screenshotHashes: [{ path: "screenshot.png", sha256: sha256File(join(root, "screenshot.png")) }], contactSheets, videoFrames: [], contact: "contact.json", report: "audit.json", digest: "" } };
  audit.evidence.digest = evidenceDigest(audit);
  const contact = { kind: "hyperframes-storybook-visual-review", status: "review-required", sourceDigest: audit.evidence.digest, report: "audit.json", screenshots, contactSheets };
  writeFileSync(join(root, "contact.json"), JSON.stringify(contact));
  return { audit, contact };
}

describe("storybook visual evidence integrity", () => {
  it("permits bounded codec noise but rejects black and locally stale frames", () => {
    const reference = Buffer.alloc(320 * 180 * 3, 220);
    assert.deepEqual(compareVisualPixels(reference, Buffer.alloc(reference.length, 217)), { meanError: 3, maxTileError: 3 });
    assert.throws(() => compareVisualPixels(reference, Buffer.alloc(reference.length)), /visual mismatch/);
    const stale = Buffer.from(reference);
    for (let y = 36; y < 72; y++) for (let x = 80; x < 120; x++) stale.fill(20, (y * 320 + x) * 3, (y * 320 + x + 1) * 3);
    assert.throws(() => compareVisualPixels(reference, stale), /visual mismatch/);
  });

  for (const mutation of ["screenshot", "sheet", "missing", "digest", "contact"]) it(`rejects ${mutation} evidence mutations`, () => {
    const root = mkdtempSync(join(tmpdir(), "storybook-visual-"));
    try {
      const { audit, contact } = fixture(root);
      verifyVisualEvidence(root, audit);
      if (mutation === "screenshot") writeFileSync(join(root, "screenshot.png"), "changed screenshot");
      if (mutation === "sheet") writeFileSync(join(root, "contact.jpg"), "changed contact sheet");
      if (mutation === "missing") unlinkSync(join(root, "screenshot.png"));
      if (mutation === "digest") audit.index.sha256 = "stale index";
      if (mutation === "contact") writeFileSync(join(root, "contact.json"), JSON.stringify({ ...contact, screenshots: ["other.png"] }));
      assert.throws(() => verifyVisualEvidence(root, audit), /missing or overwritten|digest is stale|metadata is stale/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

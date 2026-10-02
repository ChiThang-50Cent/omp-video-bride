import assert from "node:assert/strict";
// @ts-expect-error standalone worker JavaScript has no TypeScript declaration
import { inspectMotionTiming } from "../../src/pipelines/hyperframes-explainer/skills/omp-storybook-pipeline/scripts/motion-timing.mjs";
import { describe, it } from "vitest";

interface MotionFrame { timeSec: number; x: number; y: number; rotation: number }
const pose = (timeSec: number, x = 0, y = 0, rotation = 0) => ({ timeSec, x, y, rotation });
function fixture(keyframes: MotionFrame[] | null = [pose(1), pose(2, 12), pose(3)]) {
  return {
    manifest: {
      requirements: { narration: "required" },
      narration: { lines: [{ shotId: "one", text: "Hello world" }] },
      shots: [{ id: "one", durationSec: 4, cast: [{ id: "hero", ...(keyframes === null ? {} : { motion: { keyframes } }) }] }],
    },
    metadata: { voices: [{ frame: 1 as number | string, text: "Hello world", duration_s: 4, words: [{ start: 1, end: 1.5 }, { start: 2.5, end: 3 }] }] },
  };
}

function inspect(keyframes: MotionFrame[]) {
  const { manifest, metadata } = fixture(keyframes);
  return inspectMotionTiming(manifest, metadata);
}

describe("speech-linked storybook motion timing", () => {
  it("allows acting throughout the utterance, including an intra-utterance pause", () => {
    const evidence = inspect([pose(0), pose(1), pose(2, 12, -3, 8), pose(3), pose(4)]);
    assert.deepEqual(evidence.shots[0].speechSpan, { startSec: 1, endSec: 3 });
    assert.equal(evidence.shots[0].cast[0].neutralOutsideSpeech, true);
    assert.equal(evidence.shots[0].cast[0].keyframeCount, 5);
  });

  it("rejects nonneutral lead holds and motion authored in the padded tail", () => {
    assert.throws(() => inspect([pose(0, 10), pose(1), pose(3)]), /outside.*speech span/);
    assert.throws(() => inspect([pose(1), pose(2, 10), pose(3), pose(3.5, 10), pose(4)]), /outside.*speech span/);
  });

  it("requires neutral return even when speech ends at the shot boundary", () => {
    const { manifest, metadata } = fixture([pose(1), pose(4, 0, 0, 5)]);
    metadata.voices[0]!.words[1]!.end = 4;
    assert.throws(() => inspectMotionTiming(manifest, metadata), /neutral at speech end/);
    assert.throws(() => inspect([pose(1), pose(2, 10)]), /outside.*speech span/);
  });

  it("rejects interpolation crossing the speech boundary despite neutral outside keyframes", () => {
    assert.throws(() => inspect([pose(0), pose(2, 12), pose(3)]), /interpolation/);
    assert.throws(() => inspect([pose(1), pose(2, 12), pose(4)]), /interpolation/);
    // A nonneutral first keyframe is held all the way back to shot start.
    assert.throws(() => inspect([pose(2, 12), pose(3)]), /holds/);
  });

  it("accepts stationary cast, absent motion, empty tracks, and neutral single frames", () => {
    for (const frames of [null, [], [pose(2)]]) {
      const { manifest, metadata } = fixture(frames);
      assert.equal(inspectMotionTiming(manifest, metadata).shots[0].cast[0].neutralOutsideSpeech, true);
    }
    assert.throws(() => inspect([pose(2, 1)]), /outside.*speech span/);
  });

  it("allows silent motion without inventing a speech gate or requiring metadata", () => {
    const { manifest } = fixture([pose(0, 10), pose(4, 20)]);
    manifest.requirements.narration = "none";
    manifest.narration.lines = [];
    const evidence = inspectMotionTiming(manifest, null);
    assert.equal(evidence.shots[0].speechSpan, null);
    assert.equal(evidence.shots[0].cast[0].neutralOutsideSpeech, null);
  });

  it("maps voices by frame rather than input order and keeps un-narrated shots neutral", () => {
    const { manifest, metadata } = fixture();
    manifest.shots.unshift({ id: "silent-shot", durationSec: 4, cast: [{ id: "hero", motion: { keyframes: [pose(0), pose(4)] } }] });
    metadata.voices[0]!.frame = "2";
    assert.equal(inspectMotionTiming(manifest, metadata).shots[1].speechSpan.endSec, 3);
    manifest.shots[0]!.cast[0]!.motion!.keyframes[1]!.rotation = 1;
    assert.throws(() => inspectMotionTiming(manifest, metadata), /without measured speech|outside.*speech span/);
  });

  it("rejects missing, duplicate, out-of-range and malformed voice frames", () => {
    for (const frame of [0, 1.5, 2, "", "1x", NaN, Infinity]) {
      const { manifest, metadata } = fixture(null);
      metadata.voices[0]!.frame = frame;
      assert.throws(() => inspectMotionTiming(manifest, metadata), /voice frame/);
    }
    const { manifest, metadata } = fixture(null);
    assert.throws(() => inspectMotionTiming(manifest, null), /metadata voices/);
    assert.throws(() => inspectMotionTiming(manifest, { voices: [] }), /missing voice/);
    assert.throws(() => inspectMotionTiming(manifest, { voices: [metadata.voices[0], metadata.voices[0]] }), /duplicate/);
    assert.throws(() => inspectMotionTiming(manifest, { voices: [null] }), /voice must be an object/);
  });

  it("rejects absent and invalid measured words even for stationary cast", () => {
    for (const words of [[], null, [{ start: NaN, end: 3 }], [{ start: 1, end: Infinity }],
      [{ start: -1, end: 2 }], [{ start: 1, end: 1 }], [{ start: 1, end: 5 }],
      [{ start: 2, end: 3 }, { start: 1, end: 2 }], [{ start: "1", end: 3 }]]) {
      const { manifest, metadata } = fixture(null);
      assert.throws(() => inspectMotionTiming(manifest, { voices: [{ ...metadata.voices[0], words }] }), /words|timestamps/);
    }
  });

  it("rejects malformed keyframes rather than treating them as neutral", () => {
    const { manifest, metadata } = fixture();
    for (const keyframes of [null, [pose(2), pose(1)], [pose(1), pose(1)], [pose(0, NaN)], [{ timeSec: 0 }], [pose(5)]]) {
      const broken = { ...manifest, shots: [{ ...manifest.shots[0], cast: [{ id: "hero", motion: { keyframes } }] }] };
      assert.throws(() => inspectMotionTiming(broken, metadata), /malformed/);
    }
  });
});

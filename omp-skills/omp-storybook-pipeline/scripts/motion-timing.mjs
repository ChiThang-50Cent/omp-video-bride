// This is numerical roundoff tolerance, not a frame-sized allowance for acting
// before/after speech. Linear and sine.inOut interpolation both have positive
// interior weights: a segment is identically neutral iff both endpoints are.
const TIME_EPSILON = 1e-9;
const POSE_EPSILON = 1e-9;
const axes = ["x", "y", "rotation"];
const fail = message => { throw new Error(`motion timing: ${message}`); };
const neutral = frame => axes.every(axis => Math.abs(frame[axis]) <= POSE_EPSILON);
const object = value => value && typeof value === "object" && !Array.isArray(value);

function speechSpans(manifest, metadata) {
  const spans = new Map();
  if (!object(metadata) || !Array.isArray(metadata.voices)) fail("required narration needs audio metadata voices");
  const lines = new Map();
  for (const line of manifest.narration?.lines ?? []) {
    if (!object(line) || typeof line.shotId !== "string" || lines.has(line.shotId)) fail("malformed or duplicate narration line");
    if (!manifest.shots.some(shot => shot.id === line.shotId)) fail(`narration references unknown shot ${line.shotId}`);
    lines.set(line.shotId, line.text);
  }
  if (!lines.size) fail("required narration has no authored lines");
  for (const voice of metadata.voices) {
    if (!object(voice)) fail("voice must be an object");
    const frame = typeof voice.frame === "string" && /^\d+$/.test(voice.frame) ? Number(voice.frame) : voice.frame;
    if (!Number.isInteger(frame) || frame < 1 || frame > manifest.shots.length) fail("voice frame must identify a shot by 1-based index");
    const shot = manifest.shots[frame - 1];
    if (spans.has(shot.id)) fail(`duplicate voice frame ${frame}`);
    if (!lines.has(shot.id) || voice.text !== lines.get(shot.id)) fail(`voice frame ${frame} does not match authored narration`);
    if (!Number.isFinite(voice.duration_s) || voice.duration_s <= 0) fail(`voice frame ${frame} has invalid duration_s`);
    if (!Array.isArray(voice.words) || !voice.words.length) fail(`voice frame ${frame} has no measured words`);
    let previousEnd = 0;
    for (const word of voice.words) {
      if (!object(word) || !Number.isFinite(word.start) || !Number.isFinite(word.end)
        || word.start < 0 || word.end <= word.start || word.start < previousEnd
        || word.end > shot.durationSec + TIME_EPSILON || word.end > voice.duration_s + TIME_EPSILON) {
        fail(`voice frame ${frame} has malformed or out-of-order word timestamps`);
      }
      previousEnd = word.end;
    }
    spans.set(shot.id, { startSec: voice.words[0].start, endSec: voice.words.at(-1).end });
  }
  for (const shotId of lines.keys()) if (!spans.has(shotId)) fail(`missing voice for shot ${shotId}`);
  return spans;
}

function framesFor(cast, duration, label) {
  if (cast.motion == null) return [];
  if (!object(cast.motion) || !Array.isArray(cast.motion.keyframes)) fail(`${label} has malformed motion`);
  const frames = cast.motion.keyframes;
  let previous = -Infinity;
  for (const frame of frames) {
    if (!object(frame) || !Number.isFinite(frame.timeSec) || frame.timeSec < 0 || frame.timeSec > duration
      || frame.timeSec <= previous || !axes.every(axis => Number.isFinite(frame[axis]))) fail(`${label} has malformed keyframes`);
    previous = frame.timeSec;
  }
  return frames;
}

function inspectCast(cast, duration, span, gated, shotId) {
  const label = `${shotId}/${cast.id}`;
  const frames = framesFor(cast, duration, label);
  if (gated && frames.length) {
    // Holds are real motion poses too, including a single-keyframe track.
    const pieces = [
      { start: 0, end: frames[0].timeSec, from: frames[0], to: frames[0] },
      ...frames.slice(1).map((to, index) => ({ start: frames[index].timeSec, end: to.timeSec, from: frames[index], to })),
      { start: frames.at(-1).timeSec, end: duration, from: frames.at(-1), to: frames.at(-1) },
    ];
    for (const piece of pieces) {
      const outside = !span || piece.start < span.startSec - TIME_EPSILON || piece.end > span.endSec + TIME_EPSILON;
      if (piece.end - piece.start > TIME_EPSILON && outside && (!neutral(piece.from) || !neutral(piece.to))) {
        fail(`${label} is nonneutral outside its measured speech span (including interpolation/holds)`);
      }
    }
    // Even when speech ends exactly at the shot boundary, the final rendered
    // pose must return to neutral. Both interpolation schemes are monotonic,
    // so evaluate sine.inOut explicitly at the endpoint for boundary evidence.
    if (span) {
      let pose = frames[0];
      if (span.endSec >= frames.at(-1).timeSec) pose = frames.at(-1);
      else if (span.endSec > frames[0].timeSec) {
        const index = frames.findIndex(frame => frame.timeSec >= span.endSec);
        const from = frames[index - 1];
        const to = frames[index];
        const weight = (1 - Math.cos(Math.PI * (span.endSec - from.timeSec) / (to.timeSec - from.timeSec))) / 2;
        pose = Object.fromEntries(axes.map(axis => [axis, from[axis] + (to[axis] - from[axis]) * weight]));
      }
      if (!neutral(pose)) fail(`${label} does not return to neutral at speech end`);
    } else if (frames.some(frame => !neutral(frame))) fail(`${label} has motion without measured speech`);
  }
  return { id: cast.id, keyframeCount: frames.length, neutralOutsideSpeech: gated ? true : null };
}

export function inspectMotionTiming(manifest, metadata) {
  if (!object(manifest) || !Array.isArray(manifest.shots)) fail("manifest shots must be an array");
  const narration = manifest.requirements?.narration;
  if (narration !== "none" && narration !== "required") fail("invalid narration requirement");
  const gated = narration === "required";
  const spans = gated ? speechSpans(manifest, metadata) : new Map();
  const shots = manifest.shots.map((shot, index) => {
    if (!Number.isFinite(shot.durationSec) || shot.durationSec <= 0 || !Array.isArray(shot.cast)) fail(`shot ${shot.id} has invalid duration or cast`);
    const speechSpan = spans.get(shot.id) ?? null;
    return {
      shotId: shot.id, frame: index + 1, durationSec: shot.durationSec, speechSpan,
      cast: shot.cast.map(cast => inspectCast(cast, shot.durationSec, speechSpan, gated, shot.id)),
    };
  });
  return { schemaVersion: 1, narration, epsilon: { timeSec: TIME_EPSILON, pose: POSE_EPSILON }, shots };
}

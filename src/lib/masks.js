// Manual masks: user-drawn boxes with keyframes over time. Between keyframes the
// box position/size is linearly interpolated, so you can set a box at one frame,
// scrub, move it at another, and it tweens — i.e. adjust it frame by frame.

let _id = 1;
// kind: 'mask' applies an effect; 'ignore' draws nothing and instead suppresses
// auto-detections that overlap it (used to delete a wonky detection).
// pin: when a mask was adopted from an auto-detection, the original detection box
// — auto-detections overlapping it are suppressed so the adopted mask (which you
// can now move freely) controls coverage instead of the raw detection.
export function newMask({ x, y, w, h, t, effect = 'inherit', emoji = '😀', kind = 'mask', pin = null }) {
  return { id: _id++, kind, effect, emoji, pin, keyframes: [{ t, x, y, w, h }] };
}

const EPS = 0.04; // seconds — keyframes closer than this are treated as the same

// Insert or replace the keyframe at time t.
export function setKeyframe(mask, t, box) {
  const kf = { t, x: box.x, y: box.y, w: box.w, h: box.h };
  const i = mask.keyframes.findIndex((k) => Math.abs(k.t - t) <= EPS);
  if (i >= 0) mask.keyframes[i] = kf;
  else mask.keyframes.push(kf);
  mask.keyframes.sort((a, b) => a.t - b.t);
  return mask;
}

export function removeKeyframeAt(mask, t) {
  mask.keyframes = mask.keyframes.filter((k) => Math.abs(k.t - t) > EPS);
  return mask;
}
export function hasKeyframeAt(mask, t) {
  return mask.keyframes.some((k) => Math.abs(k.t - t) <= EPS);
}

const pick = (k) => ({ x: k.x, y: k.y, w: k.w, h: k.h });

// Interpolated box for a mask at time t. Holds first/last value outside the range.
export function maskBoxAt(mask, t) {
  const kfs = mask.keyframes;
  if (!kfs.length) return null;
  if (t <= kfs[0].t) return pick(kfs[0]);
  if (t >= kfs[kfs.length - 1].t) return pick(kfs[kfs.length - 1]);
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i], b = kfs[i + 1];
    if (t >= a.t && t <= b.t) {
      const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f,
               w: a.w + (b.w - a.w) * f, h: a.h + (b.h - a.h) * f };
    }
  }
  return pick(kfs[kfs.length - 1]);
}

// Boxes at time t that should suppress auto-detections: every 'ignore' mask's
// current box, plus every adopted mask's original detection box (its pin).
export function suppressBoxesAt(masks, t) {
  const out = [];
  for (const m of masks || []) {
    if (m.kind === 'ignore') { const b = maskBoxAt(m, t); if (b) out.push(b); }
    else if (m.pin) out.push(m.pin);
  }
  return out;
}

// True if a detected region should be suppressed by any of the given boxes
// (center inside, or substantial overlap).
export function boxSuppressed(t, boxes) {
  const cx = t.x + t.w / 2, cy = t.y + t.h / 2;
  for (const b of boxes) {
    if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) return true;
    const x1 = Math.max(t.x, b.x), y1 = Math.max(t.y, b.y);
    const x2 = Math.min(t.x + t.w, b.x + b.w), y2 = Math.min(t.y + t.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const u = t.w * t.h + b.w * b.h - inter;
    if (u > 0 && inter / u > 0.3) return true;
  }
  return false;
}

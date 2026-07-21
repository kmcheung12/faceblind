// Lightweight IoU tracker. Associates per-frame detections into stable tracks
// so an identity label computed occasionally (expensive) can persist across
// frames (cheap). Nothing fancy — greedy IoU matching with a short max-age.

function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

export class Tracker {
  constructor({ iouThreshold = 0.3, maxAge = 12 } = {}) {
    this.iouThreshold = iouThreshold;
    this.maxAge = maxAge;
    this.tracks = []; // { id, x,y,w,h, keypoints, age, identity, dist, lastEmbedFrame }
    this._nextId = 1;
    this._frame = 0;
  }

  // detections: [{x,y,w,h,keypoints,score}] -> returns active tracks for this frame.
  update(detections) {
    this._frame++;
    const unmatched = new Set(this.tracks.keys ? [] : this.tracks.map((_, i) => i));
    // rebuild as index set
    const trackIdx = new Set(this.tracks.map((_, i) => i));
    const usedDet = new Set();

    // Greedy: for each track find best detection.
    const pairs = [];
    this.tracks.forEach((t, ti) => {
      detections.forEach((d, di) => {
        const s = iou(t, d);
        if (s >= this.iouThreshold) pairs.push({ ti, di, s });
      });
    });
    pairs.sort((a, b) => b.s - a.s);

    const matchedTrack = new Set();
    for (const { ti, di } of pairs) {
      if (matchedTrack.has(ti) || usedDet.has(di)) continue;
      matchedTrack.add(ti);
      usedDet.add(di);
      const t = this.tracks[ti];
      const d = detections[di];
      t.x = d.x; t.y = d.y; t.w = d.w; t.h = d.h;
      t.keypoints = d.keypoints;
      t.score = d.score;
      t.type = d.type;
      t.age = 0;
    }

    // Age / drop unmatched tracks.
    trackIdx.forEach((ti) => {
      if (!matchedTrack.has(ti)) this.tracks[ti].age++;
    });
    this.tracks = this.tracks.filter((t) => t.age <= this.maxAge);

    // Spawn new tracks for unmatched detections.
    detections.forEach((d, di) => {
      if (usedDet.has(di)) return;
      this.tracks.push({
        id: this._nextId++,
        x: d.x, y: d.y, w: d.w, h: d.h,
        keypoints: d.keypoints,
        score: d.score,
        type: d.type,
        age: 0,
        identity: null, // { label, dist } once recognized
        lastEmbedFrame: -999,
        pendingEmbed: true,
      });
    });

    return this.tracks.filter((t) => t.age === 0);
  }

  frame() { return this._frame; }
}

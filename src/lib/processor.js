// Orchestrates the full pipeline over a playing <video>:
// detect (MediaPipe) -> track (IoU) -> occasionally embed (face-api) for
// identity -> apply blur/emoji -> capture canvas via MediaRecorder (webm).
import { detectFrame } from './detector.js';
import { detectHeads } from './pose.js';
import { Tracker } from './tracker.js';
import { computeDescriptor, matchDescriptor } from './recognizer.js';
import { applyEffect, drawBox, fillMask, padded, drawEmoji } from './effects.js';
import { maskBoxAt, suppressBoxesAt, boxSuppressed } from './masks.js';

function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const u = a.w * a.h + b.w * b.h - inter;
  return u > 0 ? inter / u : 0;
}
function centerInside(a, b) {
  const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
  return cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
}

// Hybrid merge: face detections win (they carry face keypoints + enable identity);
// add pose head boxes only where no face already covers that head.
function mergeRegions(faces, heads) {
  const out = faces.map((f) => ({ ...f, type: 'face' }));
  for (const hd of heads) {
    if (!out.some((f) => centerInside(hd, f) || iou(hd, f) > 0.3)) out.push(hd);
  }
  return out;
}

const EMBED_EVERY = 10; // frames between identity refreshes per track

// Decide whether a track should be anonymized given the mode + identity.
// mode: 'all' | 'known' (blur enrolled) | 'unknown' (blur everyone but enrolled)
export function shouldAffect(track, mode) {
  if (mode === 'all') return true;
  const isKnown = !!track.identity;
  if (mode === 'known') return isKnown;
  if (mode === 'unknown') return !isKnown;
  return true;
}

// Crop a face region (padded) from the video into a small canvas for embedding.
const cropCanvas = document.createElement('canvas');
const cropCtx = cropCanvas.getContext('2d');
function cropFace(video, t) {
  const pad = 0.25;
  const px = t.w * pad, py = t.h * pad;
  const x = Math.max(0, t.x - px);
  const y = Math.max(0, t.y - py);
  const w = Math.min(video.videoWidth - x, t.w + px * 2);
  const h = Math.min(video.videoHeight - y, t.h + py * 2);
  if (w < 24 || h < 24) return null;
  cropCanvas.width = Math.round(w);
  cropCanvas.height = Math.round(h);
  cropCtx.drawImage(video, x, y, w, h, 0, 0, cropCanvas.width, cropCanvas.height);
  return cropCanvas;
}

// Kick off an async identity embed for a track (non-blocking).
function maybeEmbed(video, track, tracker, people, threshold) {
  if (!people.length) return;
  if (track._embedding) return;
  const due = track.pendingEmbed || tracker.frame() - track.lastEmbedFrame >= EMBED_EVERY;
  if (!due) return;
  const crop = cropFace(video, track);
  if (!crop) return;
  track._embedding = true;
  track.lastEmbedFrame = tracker.frame();
  track.pendingEmbed = false;
  // snapshot the crop so it isn't overwritten before the async call reads it
  const snap = document.createElement('canvas');
  snap.width = crop.width; snap.height = crop.height;
  snap.getContext('2d').drawImage(crop, 0, 0);
  computeDescriptor(snap)
    .then((desc) => {
      if (desc) {
        const m = matchDescriptor(desc, people, threshold);
        track.identity = m; // {label,dist} or null
      }
    })
    .catch(() => {})
    .finally(() => { track._embedding = false; });
}

function pickMime() {
  const cands = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  return cands.find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';
}

// Draw one processed frame onto ctx. Shared by live preview and recording.
export function renderFrame(ctx, video, tracker, opts, people) {
  const tsMs = performance.now();
  const faces = detectFrame(video, tsMs);
  const heads = opts.usePose ? detectHeads(video, tsMs) : [];
  const dets = mergeRegions(faces, heads);
  const tracks = tracker.update(dets);

  // Boxes where the user has moved/deleted a detection: skip the raw auto-effect
  // there (an adopted or ignore mask takes over instead).
  const time = video.currentTime || 0;
  const suppress = suppressBoxesAt(opts.masks, time);

  // Mask-only pass: render a white-on-black matte of everything that would be
  // anonymized (auto-detections honoring mode/suppression + manual masks), for
  // download + use with ffmpeg locally. No video, no effects.
  if (opts.maskOnly) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.fillStyle = '#fff';
    for (const t of tracks) {
      maybeEmbed(video, t, tracker, people, opts.matchThreshold);
      if (shouldAffect(t, opts.mode) && !boxSuppressed(t, suppress)) fillMask(ctx, t);
    }
    for (const m of opts.masks || []) {
      if (m.kind === 'ignore') continue;
      const box = maskBoxAt(m, time);
      if (box) fillMask(ctx, { ...box, keypoints: null });
    }
    return tracks;
  }

  // Emoji-overlay pass: draw the emojis (exactly as the app does) on a solid
  // MAGENTA key colour, so it can be composited over the ORIGINAL locally with
  // ffmpeg via `colorkey` (MediaRecorder can't record real alpha in Chrome, so a
  // chroma key is used instead of transparency). Source-independent → full quality.
  if (opts.overlayOnly) {
    ctx.fillStyle = '#ff00ff';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    for (const t of tracks) {
      maybeEmbed(video, t, tracker, people, opts.matchThreshold);
      if (shouldAffect(t, opts.mode) && !boxSuppressed(t, suppress)) drawEmoji(ctx, opts.emoji, t);
    }
    for (const m of opts.masks || []) {
      if (m.kind === 'ignore') continue;
      const box = maskBoxAt(m, time);
      if (box) drawEmoji(ctx, m.emoji || opts.emoji, { ...box, keypoints: null });
    }
    return tracks;
  }

  ctx.drawImage(video, 0, 0, ctx.canvas.width, ctx.canvas.height);

  for (const t of tracks) {
    maybeEmbed(video, t, tracker, people, opts.matchThreshold);
    if (shouldAffect(t, opts.mode) && !boxSuppressed(t, suppress)) {
      applyEffect(ctx, video, t, opts);
    }
    if (opts.showBoxes) {
      const known = !!t.identity;
      const isHead = t.type === 'head';
      const color = known ? '#2ea043' : isHead ? '#f0a020' : '#f85149';
      const label = known ? t.identity.label
        : isHead ? 'head (pose)'
        : (people.length ? 'unknown' : `#${t.id}`);
      drawBox(ctx, t, color, label);
    }
  }

  // Manual masks: always applied (explicit user intent), interpolated at the
  // current video time so keyframed boxes tween frame by frame. Editing overlays
  // in the app pass drawMasks:false so mask effects can be painted live on top.
  if (opts.drawMasks === false) return tracks;
  for (const m of opts.masks || []) {
    if (m.kind === 'ignore') continue; // suppression-only; nothing to draw
    const box = maskBoxAt(m, time);
    if (!box) continue;
    const eff = m.effect === 'inherit' ? opts.effect : m.effect;
    applyEffect(ctx, video, { ...box, keypoints: null },
      { ...opts, effect: eff, emoji: m.emoji || opts.emoji });
  }

  return tracks;
}

// Full record run. Returns a webm Blob. Plays the video start->end.
// opts.captureSpeed > 1 boosts playbackRate so the pass finishes faster (fewer
// frames are presented/detected — a speed/temporal-resolution trade-off). The
// recording is then physically shorter; onCaptured(seconds) reports the actual
// wall-time so the caller can restore the correct duration with ffmpeg setpts.
export function processVideo({ video, canvas, opts, people, onProgress, onCaptured, onFps }) {
  return new Promise((resolve, reject) => {
    const ctx = canvas.getContext('2d');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const tracker = new Tracker();

    // Sample the canvas fast enough that speeding playback up doesn't throw away
    // temporal resolution: at captureSpeed N the wall-clock pass is 1/N as long,
    // so we need ~N× the stream fps to keep the same number of source frames in
    // the matte. Capped at 60 (display/compositor limit). At speed 1 this is just
    // the base fps. Effective mask fps ≈ capFps / captureSpeed.
    const baseFps = opts.fps || 30;
    const capFps = Math.min(60, baseFps * (opts.captureSpeed || 1));
    const stream = canvas.captureStream(capFps);
    const mimeType = pickMime();
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: opts.bitrate || 8_000_000,
    });
    const chunks = [];
    let startedAt = 0, capturedSec = 0;
    // Measure the SOURCE video's real frame rate from the presented-frame metadata
    // (mediaTime is in media-seconds, independent of captureSpeed). The encode is
    // then resampled to this so the MP4 matches the input's fps — MediaRecorder's
    // WebM has only a 1kHz timebase and no true fps, so without a target ffmpeg
    // would guess ~1000fps and pad the file with ~30× duplicate frames.
    let firstMediaTime = null, lastMediaTime = null, frameCount = 0, srcFps = 0;
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      onCaptured?.(capturedSec);
      onFps?.(srcFps);
      resolve(new Blob(chunks, { type: 'video/webm' }));
    };
    recorder.onerror = (e) => reject(e.error || new Error('recorder error'));

    let stopped = false;
    const finish = () => {
      if (stopped) return;
      stopped = true;
      capturedSec = startedAt ? (performance.now() - startedAt) / 1000 : 0;
      const span = (lastMediaTime ?? 0) - (firstMediaTime ?? 0);
      if (frameCount > 1 && span > 0) srcFps = (frameCount - 1) / span;
      video.pause();
      video.playbackRate = 1;
      if (recorder.state !== 'inactive') recorder.stop();
    };

    const tick = (now, meta) => {
      if (stopped) return;
      if (meta) {
        if (firstMediaTime == null) firstMediaTime = meta.mediaTime;
        lastMediaTime = meta.mediaTime;
        frameCount++;
      }
      renderFrame(ctx, video, tracker, opts, people);
      onProgress?.(video.duration ? video.currentTime / video.duration : 0);
      if (video.ended) { finish(); return; }
      video.requestVideoFrameCallback(tick);
    };

    video.muted = true;
    video.playbackRate = opts.captureSpeed || 1;
    video.onended = finish;

    // Start the recorder only AFTER seeking to 0 and painting the first frame, so
    // t≈0 is actually captured. Otherwise MediaRecorder records a few stale/blank
    // canvas frames while the first requestVideoFrameCallback is still pending, and
    // the un-awaited seek means playback can even begin before we've reached 0 — at
    // high captureSpeed that lost head is several tenths of a second of *source*
    // time, leaving the opening of the video un-obscured.
    const begin = () => {
      renderFrame(ctx, video, tracker, opts, people); // paint the t≈0 matte first
      recorder.start();
      startedAt = performance.now();
      video.play()
        .then(() => video.requestVideoFrameCallback(tick))
        .catch(reject);
    };
    const seekStart = () => {
      if (Math.abs(video.currentTime) < 1e-3) { begin(); return; }
      const onSeeked = () => { video.removeEventListener('seeked', onSeeked); begin(); };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = 0;
    };
    if (video.readyState >= 2) seekStart();
    else video.addEventListener('loadeddata', function onLoaded() {
      video.removeEventListener('loadeddata', onLoaded);
      seekStart();
    });
  });
}

// Same detection/mode/mask logic as a full export, but instead of drawing it
// collects the obscured regions (padded ellipse bounding boxes, source pixels)
// per frame. Returns { width, height, fps, duration, shape, frames:[{t, regions}] }.
export function processRegions({ video, canvas, opts, people, onProgress }) {
  return new Promise((resolve, reject) => {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const W = video.videoWidth, H = video.videoHeight;
    const tracker = new Tracker();
    const frames = [];

    const clampBox = (b) => {
      const x = Math.max(0, Math.round(b.x)), y = Math.max(0, Math.round(b.y));
      return { x, y, w: Math.min(W - x, Math.round(b.w)), h: Math.min(H - y, Math.round(b.h)) };
    };

    let stopped = false;
    const finish = () => {
      if (stopped) return;
      stopped = true;
      video.pause();
      video.playbackRate = 1;
      resolve({ width: W, height: H, fps: opts.fps || 30, duration: video.duration || 0,
                shape: 'ellipse', frames });
    };

    const tick = () => {
      if (stopped) return;
      const tsMs = performance.now();
      const faces = detectFrame(video, tsMs);
      const heads = opts.usePose ? detectHeads(video, tsMs) : [];
      const dets = mergeRegions(faces, heads);
      const tracks = tracker.update(dets);
      const time = video.currentTime || 0;
      const suppress = suppressBoxesAt(opts.masks, time);

      const regions = [];
      for (const t of tracks) {
        maybeEmbed(video, t, tracker, people, opts.matchThreshold);
        if (shouldAffect(t, opts.mode) && !boxSuppressed(t, suppress)) regions.push(clampBox(padded(t)));
      }
      for (const m of opts.masks || []) {
        if (m.kind === 'ignore') continue;
        const box = maskBoxAt(m, time);
        if (box) regions.push(clampBox(padded(box)));
      }
      frames.push({ t: +time.toFixed(3), regions });

      onProgress?.(video.duration ? video.currentTime / video.duration : 0);
      if (video.ended) { finish(); return; }
      video.requestVideoFrameCallback(tick);
    };

    video.muted = true;
    video.playbackRate = opts.captureSpeed || 1;
    video.onended = finish;
    // Seek to 0 and wait for it to land before playing, so the first collected
    // frame is actually the start of the video (see processVideo for the rationale).
    const begin = () => video.play().then(() => video.requestVideoFrameCallback(tick)).catch(reject);
    const seekStart = () => {
      if (Math.abs(video.currentTime) < 1e-3) { begin(); return; }
      const onSeeked = () => { video.removeEventListener('seeked', onSeeked); begin(); };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = 0;
    };
    if (video.readyState >= 2) seekStart();
    else video.addEventListener('loadeddata', function onLoaded() {
      video.removeEventListener('loadeddata', onLoaded);
      seekStart();
    });
  });
}

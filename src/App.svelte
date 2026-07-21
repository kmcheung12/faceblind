<script>
  import { onMount, tick } from 'svelte';
  import { initDetector, detectFrame } from './lib/detector.js';
  import { initRecognizer, computeDescriptor } from './lib/recognizer.js';
  import { Tracker } from './lib/tracker.js';
  import { renderFrame, processVideo, processRegions } from './lib/processor.js';
  import { initPose } from './lib/pose.js';
  import { initFFmpeg, encodeMp4, normalizeInput } from './lib/encoder.js';
  import { applyEffect } from './lib/effects.js';
  import { newMask, setKeyframe, maskBoxAt, hasKeyframeAt, removeKeyframeAt, suppressBoxesAt, boxSuppressed, endMaskAt, startMaskAt, clearLifespan } from './lib/masks.js';

  const EMOJIS = ['😀', '🙂', '😎', '🤡', '👽', '🐱', '🐶', '🦊', '🐵', '🎃', '🌚', '⬛'];

  // Browser support gate — the pipeline needs requestVideoFrameCallback + WebM
  // MediaRecorder, which today only desktop Chromium browsers fully provide.
  const browserSupported =
    typeof HTMLVideoElement !== 'undefined' &&
    'requestVideoFrameCallback' in HTMLVideoElement.prototype &&
    typeof MediaRecorder !== 'undefined' &&
    !!MediaRecorder.isTypeSupported?.('video/webm');

  let videoEl, canvasEl;
  let file = null;
  let videoURL = '';
  let ready = false;          // video metadata loaded
  let detectorReady = false;
  let dragHot = false;
  let converting = false;     // running an ffmpeg compatibility normalize pass
  let convertProgress = 0;
  let convertNote = '';       // hint shown when a video may need converting
  let usePose = true;         // detect turned-away / distant heads via pose
  let poseReady = false;

  // settings
  let mode = 'all';           // all | known | unknown
  let effect = 'blur';        // blur | pixelate | emoji
  let emoji = '😀';
  let blurStrength = 16;
  let pixelBlocks = 10;
  let matchThreshold = 0.55;
  let showBoxes = true;

  // enrollment
  let people = [];            // { label, descriptors:[Float32Array], thumb }
  let enrollBusy = false;
  let lastPreviewTracks = [];

  // manual masks / editing
  let editMode = 'masks';     // 'enroll' | 'masks' — clicking the video edits masks by default
  let masks = [];             // keyframed manual masks
  let selectedMaskId = null;
  let drag = null;            // active drag/resize state
  const bgCanvas = document.createElement('canvas');
  const bgCtx = bgCanvas.getContext('2d');
  $: selectedMask = masks.find((m) => m.id === selectedMaskId) || null;

  // processing
  let phase = 'idle';         // idle | processing | encoding | done
  let procProgress = 0;
  let encProgress = 0;
  let statusMsg = '';
  let errorMsg = '';
  let resultURL = '';
  let ffmpegLog = '';

  // ffmpeg-mask export (run a full-quality blur locally on the original)
  let maskPhase = 'idle';     // idle | rendering | encoding | done
  let maskProgress = 0;
  let jsonPhase = 'idle';     // idle | rendering | done
  let jsonProgress = 0;

  $: opts = { mode, effect, emoji, blurStrength, pixelBlocks, matchThreshold, showBoxes,
              usePose: usePose && poseReady, masks, fps: 30 };

  onMount(async () => {
    try {
      await initDetector();
      detectorReady = true;
    } catch (e) {
      errorMsg = 'Failed to load MediaPipe detector: ' + e.message;
    }
    // Pose model is ~9MB — load in the background so face detection is usable first.
    initPose()
      .then(() => { poseReady = true; console.log('[FaceBlind] pose ready'); })
      .catch((e) => console.warn('[FaceBlind] pose load failed', e.message));
  });

  function onFile(f) {
    if (!f) return;
    if (!f.type.startsWith('video/')) { errorMsg = 'Please choose a video file.'; return; }
    errorMsg = '';
    resultURL = '';
    convertNote = '';
    phase = 'idle';
    ready = false;
    // A new video invalidates masks keyframed against the old one.
    masks = [];
    selectedMaskId = null;
    file = f;
    if (videoURL) URL.revokeObjectURL(videoURL);
    videoURL = URL.createObjectURL(f);
    console.log('[FaceBlind][file]', { name: f.name, type: f.type, sizeMB: +(f.size / 1e6).toFixed(1) });
  }

  // ---- page-wide drag & drop (drop anywhere to load / replace the video) ----
  let dragDepth = 0; // counts dragenter/leave so nested elements don't flicker the hint
  function onWindowDragEnter(e) {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    dragDepth++; dragHot = true;
  }
  function onWindowDragLeave() {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dragHot = false;
  }
  function onWindowDragOver(e) {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); // allow drop
  }
  function onWindowDrop(e) {
    e.preventDefault();
    dragDepth = 0; dragHot = false;
    onFile(e.dataTransfer?.files?.[0]);
  }

  async function onLoaded() {
    console.log('[FaceBlind][loaded]', {
      vw: videoEl.videoWidth, vh: videoEl.videoHeight,
      duration: +(videoEl.duration || 0).toFixed(2), readyState: videoEl.readyState,
    });
    if (!videoEl.videoWidth || !videoEl.videoHeight) {
      // Metadata parsed but no decodable video track (e.g. 10-bit HEVC).
      convertNote = 'This video didn’t decode (0×0). It may be HEVC/10-bit — convert it below.';
      return;
    }
    ready = true;
    convertNote = '';
    await tick();
    canvasEl.width = videoEl.videoWidth;
    canvasEl.height = videoEl.videoHeight;
    videoEl.currentTime = Math.min(0.1, videoEl.duration || 0.1);
  }

  // <video> failed to load the source at all (unsupported codec / container).
  function onVideoError() {
    ready = false;
    const code = videoEl?.error?.code;
    console.error('[FaceBlind][video error]', { code, message: videoEl?.error?.message });
    convertNote =
      'Your browser can’t decode this file' +
      (code === 4 ? ' (unsupported codec — often iPhone HEVC/10-bit).' : '.') +
      ' Convert it below to fix detection.';
  }

  // Normalize the current file to 8-bit H.264 (rotation baked in) via ffmpeg.wasm,
  // then reload the pipeline from the converted, decodable video.
  async function convertVideo() {
    if (!file) return;
    converting = true;
    convertProgress = 0;
    errorMsg = '';
    statusMsg = 'Loading ffmpeg.wasm…';
    try {
      await initFFmpeg((m) => (ffmpegLog = m));
      statusMsg = 'Converting to a browser-compatible format…';
      const mp4 = await normalizeInput(file, (p) => (convertProgress = p));
      console.log('[FaceBlind][convert] done', { outMB: +(mp4.size / 1e6).toFixed(1) });
      file = new File([mp4], 'converted.mp4', { type: 'video/mp4' });
      if (videoURL) URL.revokeObjectURL(videoURL);
      convertNote = '';
      ready = false;
      videoURL = URL.createObjectURL(mp4); // onLoaded will re-init the stage
      statusMsg = 'Converted. Ready to detect.';
    } catch (e) {
      errorMsg = 'Conversion failed: ' + (e?.message || e);
    } finally {
      converting = false;
    }
  }

  // Sample average brightness of the canvas — ~0 means the frame painted black
  // (a common symptom of a codec that "loads" but doesn't actually decode).
  function canvasBrightness() {
    try {
      const ctx = canvasEl.getContext('2d');
      const w = Math.min(64, canvasEl.width), h = Math.min(64, canvasEl.height);
      const d = ctx.getImageData(0, 0, w, h).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      return +(sum / (d.length / 4) / 3).toFixed(1); // 0..255
    } catch (e) { return -1; }
  }

  // Full preview: run detection + auto effects (mask-free), cache that as the
  // "base" layer, then paint manual masks + editing overlays on top. Splitting
  // it lets us redraw masks while dragging WITHOUT re-running detection (pose is
  // slow), so editing stays smooth.
  function previewCurrent() {
    if (!ready || !detectorReady) {
      console.log('[FaceBlind][preview] skipped', { ready, detectorReady });
      return;
    }
    const ctx = canvasEl.getContext('2d');
    const t = new Tracker({ maxAge: 0 });
    // preview applies the effect to ALL faces regardless of identity mode.
    // drawMasks:false → masks are NOT painted into the base layer (redraw() paints
    // them live for editing) but they're still passed so suppression (moved/deleted
    // detections) is honored when baking the auto-detected effects.
    const tracks = renderFrame(ctx, videoEl, t, { ...opts, mode: 'all', drawMasks: false }, []);
    const bright = canvasBrightness();
    console.log('[FaceBlind][preview]', {
      t: +videoEl.currentTime.toFixed(2),
      faces: tracks.length, masks: masks.length, brightness: bright,
      note: bright >= 0 && bright < 3 ? 'CANVAS IS BLACK — video likely not decoding; try Convert' : '',
    });
    lastPreviewTracks = tracks.map((x) => ({ x: x.x, y: x.y, w: x.w, h: x.h, keypoints: x.keypoints, type: x.type }));
    // cache base layer (video + auto effects), then paint masks/overlays
    bgCanvas.width = canvasEl.width; bgCanvas.height = canvasEl.height;
    bgCtx.drawImage(canvasEl, 0, 0);
    redraw();
  }

  // Fast repaint: base layer + manual mask effects + editing overlays. No detection.
  function redraw() {
    if (!ready) return;
    const ctx = canvasEl.getContext('2d');
    ctx.drawImage(bgCanvas, 0, 0);
    const time = videoEl.currentTime || 0;
    for (const m of masks) {
      if (m.kind === 'ignore') continue; // suppression-only; nothing to paint
      const box = maskBoxAt(m, time);
      if (!box) continue;
      const eff = m.effect === 'inherit' ? effect : m.effect;
      applyEffect(ctx, videoEl, { ...box, keypoints: null }, { ...opts, effect: eff, emoji: m.emoji || emoji });
    }
    if (editMode === 'masks') drawMaskOverlays(ctx, time);
  }

  const HS = () => Math.max(10, canvasEl.width * 0.018); // handle size (canvas px)
  function corners(b) {
    return { tl: [b.x, b.y], tr: [b.x + b.w, b.y], br: [b.x + b.w, b.y + b.h], bl: [b.x, b.y + b.h] };
  }
  // Delete/disable badge lives at the box's upper-right corner.
  function xHandleHit(b, p, hs) {
    return Math.abs(p.x - (b.x + b.w)) <= hs && Math.abs(p.y - b.y) <= hs;
  }
  function drawXHandle(ctx, b, hs, color) {
    const cx = b.x + b.w, cy = b.y;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, hs * 0.85, 0, 7);
    ctx.fillStyle = '#0b0e14'; ctx.globalAlpha = 0.92; ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.5, hs * 0.16); ctx.stroke();
    const r = hs * 0.4;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
    ctx.moveTo(cx + r, cy - r); ctx.lineTo(cx - r, cy + r);
    ctx.stroke();
    ctx.restore();
  }
  function drawMaskOverlays(ctx, time) {
    const hs = HS();
    const suppress = suppressBoxesAt(masks, time);
    // Auto-detected boxes (face / head-pose) as clickable guides. Suppressed ones
    // (a detection you moved or deleted) are drawn faint + struck through so it's
    // clear the raw detection is no longer applied.
    ctx.save();
    ctx.font = `${Math.max(12, canvasEl.width * 0.02)}px sans-serif`;
    ctx.textBaseline = 'bottom';
    for (const a of lastPreviewTracks) {
      const isHead = a.type === 'head';
      const off = boxSuppressed(a, suppress);
      ctx.globalAlpha = off ? 0.35 : 1;
      ctx.strokeStyle = isHead ? '#f0a020' : '#f85149';
      ctx.lineWidth = Math.max(1.5, canvasEl.width * 0.0022);
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(a.x, a.y, a.w, a.h);
      ctx.setLineDash([]);
      ctx.fillStyle = isHead ? '#f0a020' : '#f85149';
      ctx.fillText((isHead ? 'head (pose)' : 'face') + (off ? ' — removed' : ' — click to edit'), a.x + 2, a.y - 2);
      ctx.globalAlpha = 1;
      if (!off) drawXHandle(ctx, a, hs, isHead ? '#f0a020' : '#f85149'); // X = disable detection
    }
    ctx.restore();

    // Ignore regions (deleted detections): dashed red outline, no fill.
    ctx.save();
    for (const m of masks) {
      if (m.kind !== 'ignore') continue;
      const b = maskBoxAt(m, time);
      if (!b) continue;
      const sel = m.id === selectedMaskId;
      ctx.strokeStyle = '#f85149';
      ctx.lineWidth = Math.max(2, canvasEl.width * 0.003);
      ctx.setLineDash(sel ? [] : [10, 6]);
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.setLineDash([]);
      ctx.font = `${Math.max(12, canvasEl.width * 0.02)}px sans-serif`;
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = '#f85149';
      ctx.fillText('🚫 detection off', b.x + 2, b.y - 2);
      if (sel) {
        ctx.fillStyle = '#f85149';
        for (const [hx, hy] of Object.values(corners(b)))
          ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
      }
      drawXHandle(ctx, b, hs, '#f85149'); // X = end ignore here (re-enable detection from here on)
    }
    ctx.restore();

    for (const m of masks) {
      if (m.kind === 'ignore') continue;
      const b = maskBoxAt(m, time);
      if (!b) continue;
      const sel = m.id === selectedMaskId;
      ctx.save();
      ctx.strokeStyle = sel ? '#4f9dff' : '#8be9fd';
      ctx.lineWidth = Math.max(2, canvasEl.width * 0.003);
      ctx.setLineDash(sel ? [] : [8, 6]);
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.setLineDash([]);
      if (hasKeyframeAt(m, time)) { // keyframe marker
        ctx.fillStyle = '#f0a020';
        ctx.beginPath(); ctx.arc(b.x + hs, b.y + hs, hs * 0.5, 0, 7); ctx.fill();
      }
      if (sel) {
        ctx.fillStyle = '#4f9dff';
        for (const [hx, hy] of Object.values(corners(b)))
          ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
      }
      drawXHandle(ctx, b, hs, sel ? '#4f9dff' : '#8be9fd'); // X = end mask here (temporal trim)
      ctx.restore();
    }
  }

  function onSeeked() { previewCurrent(); }

  // ---- canvas pointer interaction ----
  function toCanvas(e) {
    const r = canvasEl.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (canvasEl.width / r.width),
             y: (e.clientY - r.top) * (canvasEl.height / r.height) };
  }
  function cornerAt(b, p, hs) {
    for (const [name, [hx, hy]] of Object.entries(corners(b)))
      if (Math.abs(p.x - hx) <= hs && Math.abs(p.y - hy) <= hs) return name;
    return null;
  }

  async function onCanvasPointerDown(e) {
    if (!ready) return;
    const p = toCanvas(e);

    if (editMode === 'enroll') {
      if (enrollBusy) return;
      const hit = lastPreviewTracks.find((t) => p.x >= t.x && p.x <= t.x + t.w && p.y >= t.y && p.y <= t.y + t.h);
      if (hit) await enroll(hit);
      return;
    }

    // masks mode
    const time = videoEl.currentTime || 0;
    const hs = HS();
    // 0) "X" badge (upper-right of every box) ENDS the mask at the current frame
    //    (temporal trim: kept before now, gone from here on). Checked first since
    //    it sits on the top-right corner. To wipe a mask across all time use its
    //    chip ✕ or the Delete key. Manual masks + ignore regions...
    for (let i = masks.length - 1; i >= 0; i--) {
      const b = maskBoxAt(masks[i], time);
      if (b && xHandleHit(b, p, hs)) { endMaskHere(masks[i].id); return; }
    }
    //    ...and auto-detected boxes (X disables the raw detection via an ignore region).
    const suppressed = suppressBoxesAt(masks, time);
    const autoX = lastPreviewTracks.find((a) => !boxSuppressed(a, suppressed) && xHandleHit(a, p, hs));
    if (autoX) { ignoreDetection(autoX); return; }
    // 1) resize handle of the selected mask
    if (selectedMask) {
      const b = maskBoxAt(selectedMask, time);
      const corner = b && cornerAt(b, p, hs);
      if (corner) { startDrag(e, 'resize', selectedMask, b, p, corner); return; }
    }
    // 2) inside any mask (topmost first) → select + move
    for (let i = masks.length - 1; i >= 0; i--) {
      const b = maskBoxAt(masks[i], time);
      if (b && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) {
        selectedMaskId = masks[i].id;
        startDrag(e, 'move', masks[i], b, p, null);
        redraw();
        return;
      }
    }
    // 2.5) clicked an auto-detected box (face / head-pose) → adopt it into an
    // editable mask (pinning the original box so the raw detection is suppressed)
    // and start moving it immediately.
    const autoHit = lastPreviewTracks.find((a) => p.x >= a.x && p.x <= a.x + a.w && p.y >= a.y && p.y <= a.y + a.h);
    if (autoHit) {
      const pin = { x: autoHit.x, y: autoHit.y, w: autoHit.w, h: autoHit.h };
      const m = newMask({ x: autoHit.x, y: autoHit.y, w: autoHit.w, h: autoHit.h, t: time, emoji, pin });
      masks = [...masks, m];
      selectedMaskId = m.id;
      startDrag(e, 'move', m, { x: autoHit.x, y: autoHit.y, w: autoHit.w, h: autoHit.h }, p, null);
      previewCurrent(); // re-bake base so the now-suppressed raw detection disappears
      return;
    }
    // 3) empty space → start drawing a NEW mask by dragging (rubber-band)
    const time2 = videoEl.currentTime || 0;
    const m = newMask({ x: p.x, y: p.y, w: 1, h: 1, t: time2, emoji });
    masks = [...masks, m];
    selectedMaskId = m.id;
    editMode = 'masks';
    drag = { kind: 'draw', maskId: m.id, startX: p.x, startY: p.y, box: { x: p.x, y: p.y, w: 1, h: 1 }, origin: { x: p.x, y: p.y } };
    canvasEl.setPointerCapture?.(e.pointerId);
    redraw();
  }

  function startDrag(e, kind, mask, box, p, corner) {
    drag = { kind, maskId: mask.id, corner, startX: p.x, startY: p.y, box: { ...box } };
    canvasEl.setPointerCapture?.(e.pointerId);
  }

  function onCanvasPointerMove(e) {
    if (!drag) return;
    const mask = masks.find((m) => m.id === drag.maskId);
    if (!mask) return;
    const p = toCanvas(e);
    const dx = p.x - drag.startX, dy = p.y - drag.startY;
    let b;
    if (drag.kind === 'move') {
      b = { x: drag.box.x + dx, y: drag.box.y + dy, w: drag.box.w, h: drag.box.h };
    } else if (drag.kind === 'draw') {
      const x0 = drag.origin.x, y0 = drag.origin.y;
      b = { x: Math.min(x0, p.x), y: Math.min(y0, p.y), w: Math.abs(p.x - x0), h: Math.abs(p.y - y0) };
    } else {
      b = { ...drag.box };
      const minS = 12;
      if (drag.corner.includes('l')) { b.x = drag.box.x + dx; b.w = drag.box.w - dx; }
      if (drag.corner.includes('r')) { b.w = drag.box.w + dx; }
      if (drag.corner.includes('t')) { b.y = drag.box.y + dy; b.h = drag.box.h - dy; }
      if (drag.corner.includes('b')) { b.h = drag.box.h + dy; }
      if (b.w < minS) { b.w = minS; } if (b.h < minS) { b.h = minS; }
    }
    setKeyframe(mask, videoEl.currentTime || 0, b);
    masks = masks; // trigger reactivity
    redraw();
  }

  function onCanvasPointerUp(e) {
    if (!drag) return;
    canvasEl.releasePointerCapture?.(e.pointerId);
    // A "draw" that stayed tiny was really just a click on empty space → turn it
    // into a default-sized mask centered on the click (clicking adds a mask).
    if (drag.kind === 'draw') {
      const m = masks.find((x) => x.id === drag.maskId);
      const b = m && maskBoxAt(m, videoEl.currentTime || 0);
      if (m && (!b || b.w < 10 || b.h < 10)) {
        const w = canvasEl.width * 0.18, h = w * 1.2;
        setKeyframe(m, videoEl.currentTime || 0,
          { x: drag.origin.x - w / 2, y: drag.origin.y - h / 2, w, h });
        masks = masks;
      }
    }
    drag = null;
    redraw();
  }

  function deleteSelected() {
    if (selectedMaskId != null) deleteMask(selectedMaskId);
  }
  function onWindowKey(e) {
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    // ← / → step one frame at a time (Shift = 10 frames) for precise scrubbing.
    if (ready && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      const frames = e.shiftKey ? 10 : 1;
      const step = frames / (opts.fps || 30);
      const dur = videoEl.duration || 0;
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      videoEl.currentTime = Math.max(0, Math.min(dur, (videoEl.currentTime || 0) + dir * step));
      return;
    }
    if (editMode === 'masks' && selectedMaskId != null && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      deleteSelected();
    }
  }

  // ---- mask operations ----
  // Turn a detected face/head box into an editable mask you can drag over the head.
  // Records the original box as a pin so the raw (wonky) detection is suppressed.
  function pinDetection(box) {
    const t = videoEl.currentTime || 0;
    const pin = { x: box.x, y: box.y, w: box.w, h: box.h };
    const m = newMask({ x: box.x, y: box.y, w: box.w, h: box.h, t, emoji, pin });
    masks = [...masks, m];
    selectedMaskId = m.id;
    editMode = 'masks';
    previewCurrent(); // re-bake base so the suppressed raw detection disappears
  }
  // Delete a wonky/false detection: drop an 'ignore' region over it so the auto
  // effect is skipped there on export. Editable (move/resize/keyframe) like a mask.
  function ignoreDetection(box) {
    const t = videoEl.currentTime || 0;
    const m = newMask({ x: box.x, y: box.y, w: box.w, h: box.h, t, kind: 'ignore' });
    masks = [...masks, m];
    selectedMaskId = m.id;
    editMode = 'masks';
    previewCurrent();
  }
  // Temporal delete: end the mask at the current frame so it's kept before now
  // and gone from here on. Ending at/before its start means it never shows → drop
  // it entirely instead.
  function endMaskHere(id) {
    const m = masks.find((x) => x.id === id);
    if (!m) return;
    const t = videoEl.currentTime || 0;
    if (t <= (m.start ?? 0) + 0.001) { deleteMask(id); return; }
    endMaskAt(m, t);
    masks = masks;
    // An ignore/pinned mask ending here restores the detection after now → re-bake.
    if (m.kind === 'ignore' || m.pin) previewCurrent();
    else redraw();
  }
  // Lifespan controls for the selected mask (panel buttons).
  function setMaskStartHere() {
    if (!selectedMask) return;
    startMaskAt(selectedMask, videoEl.currentTime || 0);
    masks = masks;
    if (selectedMask.kind === 'ignore' || selectedMask.pin) previewCurrent(); else redraw();
  }
  function setMaskEndHere() {
    if (!selectedMask) return;
    endMaskAt(selectedMask, videoEl.currentTime || 0);
    masks = masks;
    if (selectedMask.kind === 'ignore' || selectedMask.pin) previewCurrent(); else redraw();
  }
  function clearMaskLifespan() {
    if (!selectedMask) return;
    clearLifespan(selectedMask);
    masks = masks;
    if (selectedMask.kind === 'ignore' || selectedMask.pin) previewCurrent(); else redraw();
  }
  const fmtT = (t) => (t === Infinity || t == null ? 'end' : `${(+t).toFixed(2)}s`);

  function deleteMask(id) {
    const removed = masks.find((m) => m.id === id);
    masks = masks.filter((m) => m.id !== id);
    if (selectedMaskId === id) selectedMaskId = null;
    // Removing a mask that suppressed a detection (pin/ignore) must restore it,
    // so re-bake the base layer rather than just repainting masks.
    if (removed && (removed.kind === 'ignore' || removed.pin)) previewCurrent();
    else redraw();
  }
  function addKeyframeHere() {
    if (!selectedMask) return;
    const t = videoEl.currentTime || 0;
    setKeyframe(selectedMask, t, maskBoxAt(selectedMask, t));
    masks = masks; redraw();
  }
  function removeKeyframeHere() {
    if (!selectedMask) return;
    removeKeyframeAt(selectedMask, videoEl.currentTime || 0);
    masks = masks; redraw();
  }

  async function enroll(region) {
    enrollBusy = true;
    statusMsg = 'Loading recognition model…';
    try {
      await initRecognizer();
      statusMsg = 'Computing face descriptor…';
      const pad = 0.25;
      const px = region.w * pad, py = region.h * pad;
      const x = Math.max(0, region.x - px), y = Math.max(0, region.y - py);
      const w = Math.min(videoEl.videoWidth - x, region.w + px * 2);
      const h = Math.min(videoEl.videoHeight - y, region.h + py * 2);
      const c = document.createElement('canvas');
      c.width = Math.round(w); c.height = Math.round(h);
      c.getContext('2d').drawImage(videoEl, x, y, w, h, 0, 0, c.width, c.height);
      const desc = await computeDescriptor(c);
      if (!desc) { statusMsg = 'No face descriptor could be computed there.'; return; }
      people = [...people, {
        label: `Person ${people.length + 1}`,
        descriptors: [desc],
        thumb: c.toDataURL('image/jpeg', 0.7),
      }];
      statusMsg = `Enrolled ${people.length} face(s).`;
      if (mode === 'all') mode = 'unknown';
    } catch (e) {
      errorMsg = 'Enroll failed: ' + e.message;
    } finally {
      enrollBusy = false;
    }
  }

  async function enrollFromImage(f) {
    if (!f) return;
    enrollBusy = true;
    statusMsg = 'Loading recognition model…';
    try {
      await initRecognizer();
      const img = await loadImage(URL.createObjectURL(f));
      const desc = await computeDescriptor(img);
      if (!desc) { statusMsg = 'No face found in that image.'; return; }
      const c = document.createElement('canvas');
      c.width = 96; c.height = 96;
      c.getContext('2d').drawImage(img, 0, 0, 96, 96);
      people = [...people, {
        label: `Person ${people.length + 1}`,
        descriptors: [desc],
        thumb: c.toDataURL('image/jpeg', 0.7),
      }];
      statusMsg = `Enrolled ${people.length} face(s).`;
      if (mode === 'all') mode = 'unknown';
    } catch (e) {
      errorMsg = 'Enroll failed: ' + e.message;
    } finally {
      enrollBusy = false;
    }
  }

  function loadImage(src) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = src;
    });
  }

  function removePerson(i) {
    people = people.filter((_, k) => k !== i);
    if (!people.length && mode !== 'all') mode = 'all';
  }

  async function run() {
    if (!ready) return;
    errorMsg = '';
    resultURL = '';
    phase = 'processing';
    procProgress = 0; encProgress = 0;
    statusMsg = 'Processing frames…';
    try {
      let srcFps = 0;
      const webm = await processVideo({
        video: videoEl,
        canvas: canvasEl,
        opts: { ...opts, showBoxes: false },
        people,
        onProgress: (p) => (procProgress = p),
        onFps: (f) => (srcFps = f),
      });
      console.log('[FaceBlind][run] recorded webm', {
        MB: +((webm?.size || 0) / 1e6).toFixed(2), durationSec: +(videoEl.duration || 0).toFixed(2),
      });
      if (!webm || !webm.size) throw new Error('Recording produced an empty video (0 bytes).');

      phase = 'encoding';
      statusMsg = 'Loading ffmpeg.wasm…';
      await initFFmpeg((m) => (ffmpegLog = m));
      statusMsg = 'Encoding MP4 (+ original audio)…';
      // Match the output fps to the SOURCE video (measured during the pass), so we
      // don't inherit MediaRecorder's bogus ~1000fps timebase. Fall back to 30.
      const outFps = srcFps > 1 ? Math.round(srcFps) : (opts.fps || 30);
      console.log('[FaceBlind][run] measured source fps', { srcFps: +srcFps.toFixed(2), outFps });
      const mp4 = await encodeMp4(webm, file, (p) => (encProgress = p), videoEl.duration || 0, outFps);

      resultURL = URL.createObjectURL(mp4);
      phase = 'done';
      statusMsg = 'Done — downloaded faceblind-output.mp4.';
      // Auto-download the result (anchor download → no user gesture needed here).
      const a = document.createElement('a');
      a.href = resultURL; a.download = 'faceblind-output.mp4'; a.click();
      previewCurrent();
    } catch (e) {
      errorMsg = 'Processing failed: ' + (e?.message || e);
      phase = 'idle';
    }
  }

  // Ask the user where to save BEFORE the long render — showSaveFilePicker needs
  // transient user activation, which is gone by the time rendering finishes.
  // Returns { cancelled } | { handle } (handle null ⇒ fall back to browser download).
  const MIME = { mp4: 'video/mp4', webm: 'video/webm', json: 'application/json' };
  async function chooseDest(name) {
    if (!window.showSaveFilePicker) return { handle: null }; // no API → default download
    const ext = name.split('.').pop();
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: `${ext.toUpperCase()} file`,
                  accept: { [MIME[ext] || 'application/octet-stream']: ['.' + ext] } }],
      });
      return { handle };
    } catch (e) {
      if (e?.name === 'AbortError') return { cancelled: true };
      return { handle: null }; // picker unavailable/blocked → fall back
    }
  }
  // Write to the chosen handle, or fall back to a browser download (~/Downloads).
  async function saveBlob(handle, blob, name) {
    if (handle) {
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Render a white-on-black mask video of everything that would be anonymized and
  // download it, so the user can run a full-quality blur locally on the ORIGINAL
  // file (no lossy canvas recording). Same detection/mode/masks as export.
  // Capture the mask/overlay pass at N× playbackRate so it finishes faster (fewer
  // frames presented/detected — a speed vs. temporal-resolution trade-off). The
  // recorded webm is shipped as-is (NO in-browser re-encode), and re-timed to the
  // true duration by a `setpts` in the *local* ffmpeg command (native = fast).
  // Effective mask fps ≈ min(60, sourceFps × speed) / speed, so 4× → ~15fps of
  // source coverage (6× gave a coarse ~5fps that lagged fast movement).
  const CAPTURE_SPEED = 4;
  let maskStretch = CAPTURE_SPEED; // dur / actual-capture-seconds, for the command
  async function downloadMask() {
    if (!ready) return;
    const isEmoji = effect === 'emoji';
    const name = isEmoji ? 'faceblind-emoji-overlay.webm' : 'faceblind-mask.webm';
    const dest = await chooseDest(name); // prompt up-front (keeps user gesture)
    if (dest.cancelled) return;
    errorMsg = '';
    maskPhase = 'rendering';
    maskProgress = 0;
    try {
      let capturedSec = 0;
      const webm = await processVideo({
        video: videoEl,
        canvas: canvasEl,
        // blur/pixelate → white matte (content-dependent, applied via ffmpeg
        // filter). emoji → magenta-keyed overlay of the actual emojis.
        opts: { ...opts, showBoxes: false, captureSpeed: CAPTURE_SPEED,
                ...(isEmoji ? { overlayOnly: true } : { maskOnly: true }) },
        people,
        onProgress: (p) => (maskProgress = p),
        onCaptured: (s) => (capturedSec = s),
      });
      // Self-correcting stretch: whatever effective speed the browser achieved,
      // dur/capturedSec re-times the short webm back to the real duration.
      const dur = videoEl.duration || 0;
      maskStretch = capturedSec > 0.1 && dur > 0 ? +(dur / capturedSec).toFixed(3) : 1;
      await saveBlob(dest.handle, webm, name);
      maskPhase = 'done';
      previewCurrent(); // restore the live preview on the canvas
    } catch (e) {
      errorMsg = 'Mask export failed: ' + (e?.message || e);
      maskPhase = 'idle';
    }
  }

  // Per-frame region coordinates (source pixels) as JSON — lighter than the mp4
  // mask and ideal for scripting your own pipeline. Same detection/mode/masks.
  async function downloadMaskJson() {
    if (!ready) return;
    const name = 'faceblind-mask.json';
    const dest = await chooseDest(name); // prompt up-front (keeps user gesture)
    if (dest.cancelled) return;
    errorMsg = '';
    jsonPhase = 'rendering';
    jsonProgress = 0;
    try {
      const data = await processRegions({
        video: videoEl,
        canvas: canvasEl,
        opts: { ...opts, maskOnly: true, captureSpeed: CAPTURE_SPEED },
        people,
        onProgress: (p) => (jsonProgress = p),
      });
      const meta = { source: file?.name || 'input', shape: 'ellipse',
        note: 'regions are bounding boxes (source pixels) of padded ellipses that are obscured; one entry per rendered frame', ...data };
      const blob = new Blob([JSON.stringify(meta)], { type: 'application/json' });
      await saveBlob(dest.handle, blob, name);
      jsonPhase = 'done';
      previewCurrent();
    } catch (e) {
      errorMsg = 'Coordinate export failed: ' + (e?.message || e);
      jsonPhase = 'idle';
    }
  }

  $: busy = phase === 'processing' || phase === 'encoding'
    || maskPhase === 'rendering' || jsonPhase === 'rendering';

  // ffmpeg command to reproduce the CURRENT effect locally using the download.
  // blur/pixelate: obscure the whole frame, then reveal it only where the white
  //   matte is (thresholded so compression softening still yields full coverage).
  // emoji: just overlay the transparent emoji video.
  $: inputName = file?.name || 'input.mp4';
  $: exportFile = effect === 'emoji' ? 'faceblind-emoji-overlay.webm' : 'faceblind-mask.webm';
  // The mask is captured fast (short webm); setpts stretches it back to the true
  // duration so it lines up with the source. Runs on the user's native ffmpeg.
  $: retime = `setpts=${maskStretch}*PTS`;
  $: maskReveal =
    `[1:v]${retime},format=gray,lutyuv=y='if(gt(val,90),255,0)'[m];` +
    `[fg][m]alphamerge[fga];[0:v][fga]overlay=shortest=1[out]`;
  const tail = `-map "[out]" -map "0:a?" -c:a copy -movflags +faststart output.mp4`;
  $: ffmpegCmd =
    effect === 'emoji'
      // colorkey removes the magenta key colour so only the emojis remain, then overlay.
      ? `ffmpeg -i "${inputName}" -i faceblind-emoji-overlay.webm -filter_complex ` +
        `"[1:v]${retime},colorkey=0xff00ff:0.30:0.10[ov];[0:v][ov]overlay=shortest=1[out]" ${tail}`
      : effect === 'pixelate'
      // pixelate the whole frame with ffmpeg's pixelize filter, then masked reveal.
      // Tune w/h for bigger/smaller blocks.
      ? `ffmpeg -i "${inputName}" -i faceblind-mask.webm -filter_complex ` +
        `"[0:v]pixelize=w=${pixelSize}:h=${pixelSize}[fg];${maskReveal}" ${tail}`
      : `ffmpeg -i "${inputName}" -i faceblind-mask.webm -filter_complex ` +
        `"[0:v]boxblur=${Math.round(blurStrength)}:1[fg];${maskReveal}" ${tail}`;
  // Approx pixel-block size so the ffmpeg pixelation ~matches the in-app preview.
  $: pixelSize = Math.max(4, Math.round(150 / Math.max(2, pixelBlocks)));

  async function copyFfmpegCmd() {
    try { await navigator.clipboard.writeText(ffmpegCmd); statusMsg = 'ffmpeg command copied.'; }
    catch { statusMsg = 'Copy failed — select the command and copy manually.'; }
  }

  $: modeHint = !people.length
    ? 'Enroll a face to unlock identity-based modes.'
    : mode === 'known' ? 'Blurs ONLY enrolled people.'
    : mode === 'unknown' ? 'Blurs everyone EXCEPT enrolled people.'
    : 'Blurs every detected face.';
</script>

<svelte:window
  on:keydown={onWindowKey}
  on:dragenter={onWindowDragEnter}
  on:dragleave={onWindowDragLeave}
  on:dragover={onWindowDragOver}
  on:drop={onWindowDrop}
/>

{#if dragHot}
  <div class="dropoverlay">
    <div class="dropoverlay-box">
      {videoURL ? 'Drop to replace the video' : 'Drop a video to load it'}
    </div>
  </div>
{/if}

<h1>FaceBlind</h1>
<p class="sub">In-browser face blur / emoji-replace. Nothing leaves your machine.</p>

{#if !browserSupported}
  <div class="panel err">
    <b>Unsupported browser.</b> FaceBlind currently works only in desktop <b>Chrome</b> (or another
    Chromium browser like Edge/Brave). Firefox and Safari lack the video APIs this app needs. Please
    switch to Chrome to use it.
  </div>
{/if}

{#if errorMsg}<div class="panel err">{errorMsg}</div>{/if}

{#if !videoURL}
  <div class="panel">
    <div
      class="dropzone {dragHot ? 'hot' : ''}"
      on:click={() => document.getElementById('fileInput').click()}
      on:keydown={(e) => (e.key === 'Enter' || e.key === ' ') && document.getElementById('fileInput').click()}
      role="button" tabindex="0"
    >
      <div style="font-size:15px">Drop a video here, or click to choose</div>
      <div class="hint" style="margin-top:6px">
        {detectorReady ? 'Detector ready.' : 'Loading face detector…'}
      </div>
    </div>
    <input id="fileInput" type="file" accept="video/*" style="display:none"
      on:change={(e) => onFile(e.target.files?.[0])} />
  </div>
{:else}
  <div class="panel">
    {#if ready}
      <div class="stagewrap">
        <!-- Kept mounted (hidden, not unmounted) while showing the result so the
             canvasEl binding survives for a re-process. -->
        <canvas class="stage" bind:this={canvasEl}
          style="{resultURL ? 'display:none;' : ''}cursor:{editMode === 'masks' ? 'crosshair' : 'pointer'}"
          on:pointerdown={onCanvasPointerDown}
          on:pointermove={onCanvasPointerMove}
          on:pointerup={onCanvasPointerUp}
          on:pointerleave={onCanvasPointerUp}></canvas>
        {#if resultURL}
          <div class="col" style="align-items:center;gap:10px;width:100%">
            <video class="stage" src={resultURL} controls autoplay loop playsinline>
              <track kind="captions" />
            </video>
            <div class="row" style="justify-content:center">
              <a class="dl" href={resultURL} download="faceblind-output.mp4">⬇ Download MP4</a>
              <button on:click={() => { URL.revokeObjectURL(resultURL); resultURL = ''; previewCurrent(); }}>← Back to editing</button>
            </div>
          </div>
        {/if}
      </div>
    {/if}
    <video
      class="hidden" bind:this={videoEl} src={videoURL} playsinline
      on:loadedmetadata={onLoaded} on:seeked={onSeeked} on:error={onVideoError}
    >
      <track kind="captions" />
    </video>

    {#if convertNote}
      <div class="err" style="margin-bottom:12px">{convertNote}</div>
      <div class="row">
        <button class="good" on:click={convertVideo} disabled={converting}>
          {converting ? 'Converting…' : 'Convert for compatibility'}
        </button>
        <span class="hint">Transcodes to 8-bit H.264 (rotation applied) in your browser via ffmpeg.wasm.</span>
      </div>
      {#if converting}
        <p class="hint" style="margin-top:10px">Converting ({Math.round(convertProgress * 100)}%)</p>
        <div class="progress"><i style="width:{convertProgress * 100}%"></i></div>
      {/if}
    {/if}

    {#if ready}
      <div class="row" style="margin-top:12px">
        <input type="range" min="0" max={videoEl?.duration || 0} step="0.05"
          style="flex:1"
          on:input={(e) => { videoEl.currentTime = +e.target.value; }} />
        <button on:click={() => onFile(null) || (videoURL = '', ready = false)}>Change video</button>
      </div>
      <p class="hint" style="margin-top:6px">
        Drag the slider to scrub, or press <kbd>←</kbd> / <kbd>→</kbd> to step one frame
        (<kbd>Shift</kbd>+<kbd>←</kbd>/<kbd>→</kbd> jumps 10 frames).
      </p>

      <p class="hint">
        <b>Drag on the video to draw a mask</b> over a head. Drag inside to move it, drag a corner to resize.
        Scrub to another frame (<kbd>←</kbd>/<kbd>→</kbd> step one frame, <kbd>Shift</kbd> = 10) and move it
        again — positions <b>tween between keyframes</b> (orange dot = keyframe here). A mask is <b>a function of time</b>: it lives from where you add it to where you end
        it. Click the box's <b>top-right ✕ to end the mask at the current frame</b> (kept before, gone from
        there on); to remove it across all time use its chip ✕ or <kbd>Delete</kbd>. Masks are applied on
        export only while they're active.
      </p>
      <p class="hint">
        <b>Detection wonky?</b> Click a dashed detection box on the video to <b>adopt</b> it into an editable
        mask (drag it over the head, resize, keyframe) — the raw detection is then suppressed. To fully
        <b>delete</b> a false detection, drop an ignore region (🚫) over it so it's skipped on export.
      </p>
      {#if lastPreviewTracks.length}
        <p class="hint">Detections:
          {#each lastPreviewTracks as t, i}
            <span style="white-space:nowrap">
              <button class="linklike" on:click={() => pinDetection(t)}>{t.type === 'head' ? 'head (pose)' : 'face'} {i + 1} — move</button>
              <button class="linklike" on:click={() => ignoreDetection(t)}>🚫 delete</button>
            </span>{i < lastPreviewTracks.length - 1 ? ' · ' : ''}
          {/each}
        </p>
      {/if}
      {#if converting}
        <p class="hint" style="margin-top:6px">Converting ({Math.round(convertProgress * 100)}%)</p>
        <div class="progress"><i style="width:{convertProgress * 100}%"></i></div>
      {/if}

      <!-- Effect controls, embedded in the preview panel -->
      <div style="border-top:1px solid var(--border);margin-top:14px;padding-top:14px">
        <h3 style="margin:0 0 10px">Effect</h3>
        <div class="pills">
          <button type="button" class="pill {effect === 'blur' ? 'active' : ''}" on:click={() => (effect = 'blur')}>Blur</button>
          <button type="button" class="pill {effect === 'pixelate' ? 'active' : ''}" on:click={() => (effect = 'pixelate')}>Pixelate</button>
          <button type="button" class="pill {effect === 'emoji' ? 'active' : ''}" on:click={() => (effect = 'emoji')}>Emoji</button>
        </div>

        {#if effect === 'blur'}
          <label class="field" style="margin-top:12px">Blur strength: {blurStrength}px
            <input type="range" min="4" max="40" bind:value={blurStrength} on:input={previewCurrent} />
          </label>
        {:else if effect === 'pixelate'}
          <label class="field" style="margin-top:12px">Pixel blocks: {pixelBlocks}
            <input type="range" min="4" max="30" bind:value={pixelBlocks} on:input={previewCurrent} />
          </label>
        {:else}
          <div class="emoji-grid" style="margin-top:12px">
            {#each EMOJIS as em}
              <button type="button" class="pill {emoji === em ? 'active' : ''}" on:click={() => { emoji = em; previewCurrent(); }}>{em}</button>
            {/each}
          </div>
        {/if}

        <div class="row" style="margin-top:14px">
          <label class="field" style="flex-direction:row;align-items:center;gap:6px">
            <input type="checkbox" bind:checked={showBoxes} on:change={previewCurrent} /> Show detection boxes (preview only)
          </label>
          <label class="field" style="flex-direction:row;align-items:center;gap:6px"
            title="Uses MediaPipe Pose to cover heads that are turned away, small, or steeply angled — which face detection misses.">
            <input type="checkbox" bind:checked={usePose} on:change={previewCurrent} disabled={!poseReady} />
            Cover turned-away / distant heads (pose){poseReady ? '' : ' — loading…'}
          </label>
          <button on:click={previewCurrent}>Refresh preview</button>
        </div>
      </div>
    {/if}
  </div>

  {#if editMode === 'masks' && masks.length}
    <div class="panel">
      <h2>Manual masks</h2>
      {#if selectedMask}
        <div class="row" style="margin-bottom:12px">
          {#if selectedMask.kind === 'ignore'}
            <span class="hint">🚫 <b>Ignore region</b> — auto-detections inside it are skipped on export. Move/resize it over the false detection.</span>
          {:else}
            <label class="field">Effect
              <select bind:value={selectedMask.effect} on:change={() => { masks = masks; redraw(); }}>
                <option value="inherit">Same as global ({effect})</option>
                <option value="blur">Blur</option>
                <option value="pixelate">Pixelate</option>
                <option value="emoji">Emoji</option>
              </select>
            </label>
            {#if selectedMask.effect === 'emoji'}
              <label class="field">Emoji
                <select bind:value={selectedMask.emoji} on:change={() => { masks = masks; redraw(); }}>
                  {#each EMOJIS as em}<option value={em}>{em}</option>{/each}
                </select>
              </label>
            {/if}
          {/if}
          <div class="col" style="gap:4px">
            <span class="hint">Keyframes ({selectedMask.keyframes.length})</span>
            <div class="row" style="gap:6px">
              <button on:click={addKeyframeHere}>+ Keyframe here</button>
              <button on:click={removeKeyframeHere} disabled={selectedMask.keyframes.length <= 1}>− Remove</button>
            </div>
          </div>
          <div class="col" style="gap:4px">
            <span class="hint">Active {fmtT(selectedMask.start)} → {fmtT(selectedMask.end)}</span>
            <div class="row" style="gap:6px">
              <button on:click={setMaskStartHere} title="Mask begins at the current frame">⇥ Start here</button>
              <button on:click={setMaskEndHere} title="Mask ends at the current frame (kept before, gone after)">End here ⇤</button>
              <button on:click={clearMaskLifespan} disabled={(selectedMask.start ?? 0) === 0 && (selectedMask.end ?? Infinity) === Infinity} title="Active for the whole video">Whole video</button>
            </div>
          </div>
        </div>
      {/if}
      <div class="chips">
        {#each masks as m, i}
          <div class="chip" style={m.id === selectedMaskId ? 'border-color:var(--accent)' : ''}>
            <button class="linklike" on:click={() => { selectedMaskId = m.id; redraw(); }}>
              {#if m.kind === 'ignore'}
                🚫 Ignore {i + 1} · detection off · {m.keyframes.length}kf
              {:else}
                {m.pin ? '📌' : 'Mask'} {i + 1} · {m.effect === 'inherit' ? effect : m.effect}{m.effect === 'emoji' || (m.effect === 'inherit' && effect === 'emoji') ? ' ' + m.emoji : ''} · {m.keyframes.length}kf
              {/if}{#if (m.start ?? 0) > 0 || (m.end ?? Infinity) !== Infinity} · ⏱ {fmtT(m.start)}→{fmtT(m.end)}{/if}
            </button>
            <button on:click={() => deleteMask(m.id)}>✕</button>
          </div>
        {/each}
      </div>
    </div>
  {/if}


  <div class="panel">
    <button class="primary" style="width:100%;font-size:16px;padding:14px" on:click={run} disabled={busy}>
      {phase === 'processing' || phase === 'encoding' ? 'Working…' : '⬇ Process and download'}
    </button>
    {#if statusMsg}<p class="status" style="margin-top:10px">{statusMsg}</p>{/if}

    {#if phase === 'processing'}
      <p class="hint" style="margin-top:12px">Detecting & rendering ({Math.round(procProgress * 100)}%)</p>
      <div class="progress"><i style="width:{procProgress * 100}%"></i></div>
    {/if}
    {#if phase === 'encoding'}
      <p class="hint" style="margin-top:12px">Encoding MP4 ({Math.round(encProgress * 100)}%)</p>
      <div class="progress"><i style="width:{encProgress * 100}%"></i></div>
      {#if ffmpegLog}<p class="hint" style="font-family:monospace;opacity:.6">{ffmpegLog}</p>{/if}
    {/if}

    {#if resultURL}
      <p class="status" style="margin-top:12px">Done — preview and download are shown above in the video area.</p>
    {/if}

    <div class="row" style="margin-top:18px;border-top:1px solid var(--border);padding-top:14px">
      <div class="col" style="gap:6px;flex:1">
        <b>Prefer to run ffmpeg yourself?</b>
        <span class="hint">Export the regions to obscure (matching your settings + mask edits) and apply the
          <b>{effect}</b> effect to the <b>original</b> file locally for full quality — no lossy re-encode.
          Captured fast at {CAPTURE_SPEED}× and re-timed by the command's <code>setpts</code>.
          {#if effect === 'emoji'}
            The download is an <b>emoji overlay</b> (.webm on a magenta key) composited via <code>colorkey</code> + <code>overlay</code>.
          {:else}
            The download is a white-on-black matte (.webm); the command applies <b>{effect}</b> through it.
          {/if}
          <b>.json</b> = per-frame box coordinates (source pixels) for your own script.</span>
      </div>
      <div class="col" style="gap:6px">
        <button class="good" on:click={downloadMask} disabled={busy}>
          {maskPhase === 'rendering'
            ? 'Building…'
            : effect === 'emoji' ? '⬇ Emoji overlay (.webm)' : '⬇ Mask video (.webm)'}
        </button>
        <button on:click={downloadMaskJson} disabled={busy}>
          {jsonPhase === 'rendering' ? 'Collecting…' : '⬇ Coordinates (.json)'}
        </button>
      </div>
    </div>

    {#if maskPhase === 'rendering'}
      <p class="hint" style="margin-top:12px">Rendering ({Math.round(maskProgress * 100)}%)</p>
      <div class="progress"><i style="width:{maskProgress * 100}%"></i></div>
    {/if}
    {#if jsonPhase === 'rendering'}
      <p class="hint" style="margin-top:12px">Collecting coordinates ({Math.round(jsonProgress * 100)}%)</p>
      <div class="progress"><i style="width:{jsonProgress * 100}%"></i></div>
    {/if}

    {#if maskPhase === 'done'}
      <p class="status" style="margin-top:12px">Saved <code>{exportFile}</code>. Run this next to your original file:</p>
    {:else}
      <p class="hint" style="margin-top:12px">Then run (assumes <code>{exportFile}</code> sits next to your original <code>{inputName}</code>):</p>
    {/if}
    <div class="row" style="align-items:flex-start;gap:8px">
      <textarea readonly rows="4" style="flex:1;font-family:monospace;font-size:12px;resize:vertical" on:focus={(e) => e.target.select()}>{ffmpegCmd}</textarea>
      <button on:click={copyFfmpegCmd}>Copy</button>
    </div>
    <p class="hint" style="margin-top:6px">
      {#if effect === 'emoji'}
        The overlay uses a magenta key (Chrome can't record alpha); <code>colorkey</code> drops it out. Per-mask blur/pixelate overrides aren't included in an emoji overlay.
      {:else}
        Reveals the {effect} only where the matte is white. Tune the {effect === 'blur' ? 'boxblur' : 'pixelize block size'} to taste.
      {/if}
    </p>
  </div>
{/if}

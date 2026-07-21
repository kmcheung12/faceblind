// Frame-exact export via WebCodecs.
//
// Unlike the MediaRecorder path (which captures the canvas in real time and
// therefore drops/duplicates frames whenever rendering can't keep up with the
// clock), this path DECODES the source one frame at a time by seeking, renders
// each frame through the same detect+effects pipeline, and ENCODES it with a
// WebCodecs VideoEncoder at the source's own frame rate. Result: exactly one
// output frame per source frame, real H.264 with exact per-frame timestamps —
// i.e. same fps / frame count as the input, like a local ffmpeg run. No
// real-time constraint, so masks/blur never cause choppiness.
//
// Audio is muxed back in afterwards by the caller (encoder.muxAudioIntoMp4).
import { Tracker } from './tracker.js';
import { renderFrame } from './processor.js';

export function webcodecsSupported() {
  return typeof VideoEncoder !== 'undefined' &&
         typeof VideoFrame !== 'undefined' &&
         typeof HTMLVideoElement !== 'undefined' &&
         'requestVideoFrameCallback' in HTMLVideoElement.prototype;
}

// Seek the <video> to `t` (seconds) and resolve once the frame has landed.
// Resolves immediately if we're already within half a frame of the target
// (setting currentTime to its current value fires no 'seeked' event).
function seekTo(video, t, halfFrame) {
  return new Promise((resolve) => {
    if (Math.abs((video.currentTime || 0) - t) <= halfFrame) { resolve(); return; }
    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = t;
  });
}

// Measure the source's true frame rate from presented-frame metadata over a
// short real-time sampling pass. mediaTime is in media-seconds, so this is the
// source fps regardless of playback speed. Falls back to `fallback` on failure.
function measureFps(video, { seconds = 0.8, fallback = 30 } = {}) {
  return new Promise((resolve) => {
    let first = null, last = null, count = 0, done = false;
    const finish = () => {
      if (done) return; done = true;
      video.pause();
      const span = (last ?? 0) - (first ?? 0);
      const fps = count > 1 && span > 0 ? (count - 1) / span : 0;
      resolve(fps > 1 ? fps : fallback);
    };
    const tick = (_now, meta) => {
      if (done) return;
      if (first == null) first = meta.mediaTime;
      last = meta.mediaTime;
      count++;
      if (meta.mediaTime - first >= seconds) { finish(); return; }
      video.requestVideoFrameCallback(tick);
    };
    const begin = () => {
      video.muted = true;
      video.play()
        .then(() => video.requestVideoFrameCallback(tick))
        .catch(() => resolve(fallback));
    };
    seekTo(video, 0, 1e-3).then(begin);
    // Hard cap in case rvfc stalls.
    setTimeout(finish, Math.max(2000, seconds * 4000));
  });
}

// Pick the first H.264 codec string the encoder actually supports at this size.
// Levels are upper bounds, so we lead with high levels (cover up to 4K) and
// fall back to progressively lower profiles/levels.
async function pickAvcCodec(width, height, bitrate, framerate) {
  const candidates = [
    'avc1.640033', 'avc1.640028', 'avc1.4d0033', 'avc1.4d0028',
    'avc1.42003d', 'avc1.42e01f',
  ];
  for (const codec of candidates) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported({
        codec, width, height, bitrate, framerate,
      });
      if (supported) return codec;
    } catch (_) { /* try next */ }
  }
  return 'avc1.42001f'; // last-ditch; configure() will surface a clear error if bad
}

// Render + encode the whole video frame by frame. Returns a video-only MP4 Blob
// (H.264). onProgress(0..1), onFps(measuredFps) are optional callbacks.
export async function processVideoWebCodecs({ video, canvas, opts, people, onProgress, onFps }) {
  const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');

  const W = video.videoWidth, H = video.videoHeight;
  if (!W || !H) throw new Error('Video has no decodable dimensions.');

  // Real source fps (opts.fps is just a UI default of 30, so always measure).
  const fps = await measureFps(video, { fallback: opts.fps || 30 });
  onFps?.(fps);
  const frameDurUs = 1e6 / fps;        // microseconds per frame
  const halfFrame = 0.5 / fps;         // seconds, for seek de-duping
  const duration = video.duration || 0;
  const total = Math.max(1, Math.round(duration * fps));

  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const tracker = new Tracker();

  const target = new ArrayBufferTarget();
  // No frameRate on the muxer: our explicit per-frame timestamps define timing
  // exactly, avoiding any rounding drift from a nominal rate.
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: W, height: H },
    fastStart: 'in-memory',
  });

  const bitrate = opts.bitrate || 8_000_000;
  const codec = await pickAvcCodec(W, H, bitrate, Math.round(fps));

  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encodeError = e; },
  });
  encoder.configure({
    codec, width: W, height: H, bitrate,
    framerate: Math.round(fps),
    latencyMode: 'quality',
  });

  const gop = Math.max(1, Math.round(fps * 2)); // keyframe every ~2s
  const renderOpts = { ...opts, showBoxes: false, drawMasks: true };

  try {
    await seekTo(video, 0, halfFrame);
    for (let i = 0; i < total; i++) {
      if (encodeError) throw encodeError;
      const t = i / fps;
      await seekTo(video, t, halfFrame);

      // Draw the source + auto effects + manual masks onto the canvas.
      renderFrame(ctx, video, tracker, renderOpts, people);

      const frame = new VideoFrame(canvas, {
        timestamp: Math.round(i * frameDurUs),
        duration: Math.round(frameDurUs),
      });
      encoder.encode(frame, { keyFrame: i % gop === 0 });
      frame.close();

      onProgress?.((i + 1) / total);

      // Backpressure: don't let the encode queue grow unbounded on big frames.
      if (encoder.encodeQueueSize > 8) {
        await new Promise((resolve) => {
          const check = () => (encoder.encodeQueueSize <= 4 ? resolve() : setTimeout(check, 4));
          check();
        });
      }
    }

    await encoder.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();
    return { blob: new Blob([target.buffer], { type: 'video/mp4' }), fps };
  } finally {
    try { encoder.close(); } catch (_) {}
    video.pause();
    video.playbackRate = 1;
  }
}

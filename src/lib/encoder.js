// ffmpeg.wasm: transcode the processed canvas recording (webm/vp8/9) into an
// MP4 (H.264) and mux the ORIGINAL audio track back in. Single-threaded core
// so we don't need SharedArrayBuffer / cross-origin isolation.
// ffmpeg.wasm is only needed for the final export step, so it is dynamically
// imported to keep it out of the initial bundle.
// @ffmpeg/ffmpeg spawns its worker via `new URL('./worker.js', import.meta.url)`,
// which Vite's dep pre-bundling (optimizeDeps.include) breaks — the worker 404s
// and load() hangs forever with no error. We sidestep that by self-hosting the
// worker (public/ffmpeg/*, copied from @ffmpeg/ffmpeg's esm build) and passing it
// as classWorkerURL. The worker is a *module* worker, so its import() of the core
// needs the ESM core build (the UMD build only works via importScripts).
//
// ⚠️ VERSION PINNING: public/ffmpeg/{worker.js,const.js,errors.js} are a manual
// copy of @ffmpeg/ffmpeg's esm build, and CORE below is pinned to a specific
// @ffmpeg/core version. These are NOT auto-updated by npm. If you bump
// @ffmpeg/ffmpeg, re-copy the three files:
//   cp node_modules/@ffmpeg/ffmpeg/dist/esm/{worker,const,errors}.js public/ffmpeg/
// and keep CORE's version compatible with the installed @ffmpeg/ffmpeg. A stale
// worker vs. core mismatch shows up as load() hanging (caught by the 30s timeout).
const CORE = 'https://unpkg.com/@ffmpeg/core@0.12.9/dist/esm';
// Self-hosted worker from public/ (same-origin). Resolved against Vite's BASE_URL
// (from vite.config `base`) so it stays correct under a subpath deploy such as a
// GitHub Pages project site (/<repo>/ffmpeg/worker.js). BASE_URL always ends in
// '/'. Falls back to '/' outside a bundler (e.g. tests).
const CLASS_WORKER_URL = (import.meta.env?.BASE_URL || '/') + 'ffmpeg/worker.js';

let ffmpeg = null;
let loaded = false;
let fetchFile = null;

export async function initFFmpeg(onLog) {
  if (loaded) { console.log('[FaceBlind][ffmpeg] already loaded'); return ffmpeg; }
  console.log('[FaceBlind][ffmpeg] importing modules…');
  const [{ FFmpeg }, util] = await Promise.all([
    import('@ffmpeg/ffmpeg'),
    import('@ffmpeg/util'),
  ]);
  const { toBlobURL } = util;
  fetchFile = util.fetchFile;
  ffmpeg = new FFmpeg();
  if (onLog) ffmpeg.on('log', ({ message }) => onLog(message));
  console.log('[FaceBlind][ffmpeg] fetching core.js + core.wasm (~30MB) from', CORE);
  const t0 = performance.now();
  const [coreURL, wasmURL] = await Promise.all([
    toBlobURL(`${CORE}/ffmpeg-core.js`, 'text/javascript'),
    toBlobURL(`${CORE}/ffmpeg-core.wasm`, 'application/wasm'),
  ]);
  console.log('[FaceBlind][ffmpeg] core fetched', { sec: +((performance.now() - t0) / 1000).toFixed(1) }, 'loading via self-hosted worker…');
  // ffmpeg.load() can hang forever (worker never signals ready) with no error —
  // race it against a timeout so the failure is visible instead of a frozen UI.
  const loadP = ffmpeg.load({ coreURL, wasmURL, classWorkerURL: CLASS_WORKER_URL });
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error('ffmpeg.load() timed out after 30s — worker never became ready (see console/network)')), 30000));
  await Promise.race([loadP, timeout]);
  loaded = true;
  console.log('[FaceBlind][ffmpeg] loaded', { sec: +((performance.now() - t0) / 1000).toFixed(1) });
  return ffmpeg;
}

// Normalize a browser-unfriendly input (e.g. iPhone 10-bit HEVC .mov, rotated
// footage) into a guaranteed-decodable 8-bit H.264 MP4 so the <video> element
// and MediaPipe can actually read frames. ffmpeg auto-applies rotation metadata
// (autorotate) so faces come out upright, and we downscale to keep decode /
// detection fast and memory in check. Returns an MP4 Blob.
export async function normalizeInput(source, onProgress, { maxDim = 1280 } = {}) {
  if (!loaded) throw new Error('ffmpeg not initialized');
  if (onProgress) {
    ffmpeg.on('progress', ({ progress }) =>
      onProgress(Math.max(0, Math.min(1, progress)))
    );
  }
  await ffmpeg.writeFile('in.bin', await fetchFile(source));
  // Scale longest side down to maxDim (only if larger), keep aspect, even dims.
  const vf = `scale='if(gt(iw,ih),min(${maxDim},iw),-2)':'if(gt(iw,ih),-2,min(${maxDim},ih))'`;
  await ffmpeg.exec([
    '-i', 'in.bin',
    '-vf', vf,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',   // force 8-bit
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-movflags', '+faststart',
    'norm.mp4',
  ]);
  const data = await ffmpeg.readFile('norm.mp4');
  try {
    await ffmpeg.deleteFile('in.bin');
    await ffmpeg.deleteFile('norm.mp4');
  } catch (_) {}
  return new Blob([data.buffer], { type: 'video/mp4' });
}

// Mux the ORIGINAL audio track into an already-encoded (WebCodecs) MP4 video.
// The video stream is copied verbatim (-c:v copy) — its frames/timestamps are
// already frame-exact from the WebCodecs pass — and only the audio is (re)encoded
// to AAC. If the source has no audio track, the video MP4 is returned unchanged
// (and ffmpeg isn't even needed). Returns an MP4 Blob.
export async function muxAudioIntoMp4(videoMp4, audioSource, onProgress, durationHint = 0) {
  if (!audioSource) { onProgress?.(1); return videoMp4; }
  if (!loaded) throw new Error('ffmpeg not initialized');

  ffmpeg.off?.('progress');
  let sawNative = false;
  if (onProgress) {
    ffmpeg.on('progress', ({ progress, time }) => {
      if (Number.isFinite(progress) && progress > 0) { sawNative = true; onProgress(Math.min(1, progress)); }
      else if (durationHint > 0 && Number.isFinite(time)) onProgress(Math.min(1, (time / 1e6) / durationHint));
    });
  }
  const onLog = ({ message }) => {
    const t = parseTime(message);
    if (t != null && onProgress && !sawNative && durationHint > 0) onProgress(Math.min(1, t / durationHint));
  };
  ffmpeg.on('log', onLog);

  await ffmpeg.writeFile('vid.mp4', await fetchFile(videoMp4));
  await ffmpeg.writeFile('aud.bin', await fetchFile(audioSource));

  let out;
  try {
    await ffmpeg.exec([
      '-i', 'vid.mp4',
      '-i', 'aud.bin',
      '-map', '0:v:0',
      '-map', '1:a:0?',   // '?' → tolerate a source with no audio stream
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '160k',
      '-movflags', '+faststart',
      '-shortest',
      'muxed.mp4',
    ]);
    out = await ffmpeg.readFile('muxed.mp4');
  } catch (e) {
    // Source had no usable audio (or a mux quirk) → fall back to the silent video.
    console.warn('[FaceBlind][mux] audio mux failed, returning video-only', e?.message || e);
    ffmpeg.off?.('log', onLog);
    onProgress?.(1);
    return videoMp4;
  }

  ffmpeg.off?.('log', onLog);
  onProgress?.(1);
  try {
    await ffmpeg.deleteFile('vid.mp4');
    await ffmpeg.deleteFile('aud.bin');
    await ffmpeg.deleteFile('muxed.mp4');
  } catch (_) {}
  return new Blob([out.buffer], { type: 'video/mp4' });
}

// Parse "time=00:00:04.00" (or "time=4.00") from an ffmpeg log line → seconds.
function parseTime(msg) {
  let m = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(msg);
  if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
  m = /time=\s*(\d+(?:\.\d+)?)/.exec(msg);
  return m ? +m[1] : null;
}

// videoBlob: processed frames (webm). audioSource: original File/Blob to pull
// audio from (may have no audio — handled gracefully). durationHint (seconds)
// lets us derive progress from ffmpeg's log (WebM from MediaRecorder has no
// duration metadata, so ffmpeg's own `progress` event never yields a fraction).
// Returns an MP4 Blob.
export async function encodeMp4(videoBlob, audioSource, onProgress, durationHint = 0, fps = 30) {
  if (!loaded) throw new Error('ffmpeg not initialized');

  // Clear any progress/log handlers from a previous run so they don't stack.
  ffmpeg.off?.('progress');

  // Prefer ffmpeg's native progress; fall back to time-parsed progress from logs.
  let sawNativeProgress = false;
  if (onProgress) {
    ffmpeg.on('progress', ({ progress, time }) => {
      if (Number.isFinite(progress) && progress > 0) {
        sawNativeProgress = true;
        onProgress(Math.max(0, Math.min(1, progress)));
      } else if (durationHint > 0 && Number.isFinite(time)) {
        // time here is in microseconds in @ffmpeg/ffmpeg 0.12.
        onProgress(Math.max(0, Math.min(1, (time / 1e6) / durationHint)));
      }
    });
  }
  // Log-based progress + visibility into whether ffmpeg is actually working.
  const onLog = ({ message }) => {
    const t = parseTime(message);
    if (t != null) {
      console.log('[FaceBlind][encode] progress', { atSec: +t.toFixed(2), ofSec: +durationHint.toFixed(2) });
      if (onProgress && !sawNativeProgress && durationHint > 0) {
        onProgress(Math.max(0, Math.min(1, t / durationHint)));
      }
    }
  };
  ffmpeg.on('log', onLog);

  const webmMB = +((videoBlob?.size || 0) / 1e6).toFixed(2);
  console.log('[FaceBlind][encode] writing proc.webm…', { webmMB });
  await ffmpeg.writeFile('proc.webm', await fetchFile(videoBlob));
  console.log('[FaceBlind][encode] wrote proc.webm');
  let hasAudio = false;
  if (audioSource) {
    console.log('[FaceBlind][encode] writing orig.bin (audio source)…', { MB: +((audioSource?.size || 0) / 1e6).toFixed(2) });
    await ffmpeg.writeFile('orig.bin', await fetchFile(audioSource));
    console.log('[FaceBlind][encode] wrote orig.bin');
    hasAudio = true;
  }

  const args = ['-i', 'proc.webm'];
  if (hasAudio) args.push('-i', 'orig.bin');
  args.push(
    '-map', '0:v:0',
    ...(hasAudio ? ['-map', '1:a:0?'] : []),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-crf', '23',
    // Resample to the source video's frame rate (measured by the caller). The
    // MediaRecorder WebM carries only a 1kHz (millisecond) timebase and no real
    // fps, so without a target ffmpeg guesses ~1000fps and emits a file padded
    // with ~30× duplicate frames — bloated and vastly slower to encode. Matching
    // the input fps yields a normal clip (~source frame count) and a fast encode.
    '-fps_mode', 'cfr',
    '-r', String(fps),
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', '160k'] : []),
    '-movflags', '+faststart',
    '-shortest',
    'out.mp4'
  );

  console.log('[FaceBlind][encode] exec start', { webmMB, hasAudio, durationHint, args: args.join(' ') });
  const t0 = performance.now();
  await ffmpeg.exec(args);
  console.log('[FaceBlind][encode] exec done', { sec: +((performance.now() - t0) / 1000).toFixed(1) });

  const data = await ffmpeg.readFile('out.mp4');
  console.log('[FaceBlind][encode] output', { outMB: +((data?.length || data?.byteLength || 0) / 1e6).toFixed(2) });
  ffmpeg.off?.('log', onLog);
  if (onProgress) onProgress(1);

  // cleanup
  try {
    await ffmpeg.deleteFile('proc.webm');
    if (hasAudio) await ffmpeg.deleteFile('orig.bin');
    await ffmpeg.deleteFile('out.mp4');
  } catch (_) {}

  return new Blob([data.buffer], { type: 'video/mp4' });
}

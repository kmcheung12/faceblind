// MediaPipe Face Detector (BlazeFace short-range) wrapper.
// Fast per-frame detection: returns bounding boxes + 6 keypoints per face.
import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';

const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

let detector = null;

export async function initDetector() {
  if (detector) return detector;
  const fileset = await FilesetResolver.forVisionTasks(WASM_CDN);
  detector = await FaceDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    minDetectionConfidence: 0.3, // permissive: catch small / angled / partial faces
  });
  return detector;
}

let _lastLog = 0;

// Detect faces in a video frame at timestamp `tsMs` (monotonic ms).
// Returns [{ x, y, w, h, score, keypoints:[{x,y}...] }] in pixel coords.
export function detectFrame(video, tsMs) {
  if (!detector) {
    console.warn('[FaceBlind][detect] called before detector init');
    return [];
  }
  const W = video.videoWidth;
  const H = video.videoHeight;
  if (!W || !H) {
    console.warn('[FaceBlind][detect] video has no dimensions', { W, H, readyState: video.readyState });
    return [];
  }
  const res = detector.detectForVideo(video, tsMs);
  const n = res.detections?.length || 0;
  // Throttle logs to ~2/sec so we don't flood during 30fps processing.
  if (n > 0 || tsMs - _lastLog > 500) {
    _lastLog = tsMs;
    console.log('[FaceBlind][detect]', { ts: Math.round(tsMs), vw: W, vh: H, faces: n,
      scores: (res.detections || []).map((d) => +(d.categories?.[0]?.score ?? 0).toFixed(2)) });
  }
  return (res.detections || []).map((d) => {
    const b = d.boundingBox;
    return {
      x: b.originX,
      y: b.originY,
      w: b.width,
      h: b.height,
      score: d.categories?.[0]?.score ?? 0,
      keypoints: (d.keypoints || []).map((k) => ({ x: k.x * W, y: k.y * H })),
    };
  });
}

export function disposeDetector() {
  detector?.close?.();
  detector = null;
}

// MediaPipe Pose Landmarker → head boxes. Unlike a face detector, pose finds the
// head via whole-body context, so it works when the face is turned away, small,
// or steeply angled (exactly where BlazeFace fails). We derive a head region
// from the head landmarks (nose, eyes, ears, mouth = indices 0..10).
import { PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';

const HEAD_IDX = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; // nose, eyes(x6), ears, mouth
let pose = null;

export async function initPose() {
  if (pose) return pose;
  const fileset = await FilesetResolver.forVisionTasks(WASM_CDN);
  pose = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numPoses: 5,
    minPoseDetectionConfidence: 0.3,
    minPosePresenceConfidence: 0.3,
    minTrackingConfidence: 0.3,
  });
  return pose;
}

export function isPoseReady() {
  return !!pose;
}

// Returns head regions [{ x, y, w, h, score, keypoints:[eye1,eye2], type:'head' }].
export function detectHeads(video, tsMs) {
  if (!pose) return [];
  const W = video.videoWidth, H = video.videoHeight;
  if (!W || !H) return [];
  const res = pose.detectForVideo(video, tsMs);
  const heads = [];
  for (const lms of res.landmarks || []) {
    const pts = HEAD_IDX.map((i) => ({ x: lms[i].x * W, y: lms[i].y * H, v: lms[i].visibility ?? 1 }));
    const vis = pts.filter((p) => p.v > 0.3);
    if (vis.length < 3) continue; // head not really present
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const earSpan = Math.abs(pts[7].x - pts[8].x);
    const spread = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const r = Math.max(earSpan, spread) * 1.9; // pad for skull + hair
    const avgV = vis.reduce((s, p) => s + p.v, 0) / vis.length;
    heads.push({
      x: cx - r,
      y: cy - r * 1.15,
      w: r * 2,
      h: r * 2.3,
      score: avgV,
      type: 'head',
      // eyes (indices 2 = left eye, 5 = right eye) drive emoji roll angle
      keypoints: [{ x: pts[5].x, y: pts[5].y }, { x: pts[2].x, y: pts[2].y }],
    });
  }
  return heads;
}

export function disposePose() {
  pose?.close?.();
  pose = null;
}

// Identity matching via face-api.js recognition net (128-d descriptors).
// MediaPipe gives us fast boxes; this gives each face an identity embedding
// so we can decide "known" vs "unknown" for selective blurring.
// face-api (+ its bundled tfjs) is large and only needed once the user enrolls
// a face, so it is dynamically imported here to keep the initial bundle small.
const MODEL_CDN = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';

let faceapi = null;
let detOpts = null;
let ready = false;

export async function initRecognizer() {
  if (ready) return;
  faceapi = await import('@vladmandic/face-api');
  detOpts = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.35 });
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_CDN),
    faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_CDN),
    faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_CDN),
  ]);
  ready = true;
}

// Compute a 128-d descriptor (Float32Array) for the single most prominent face
// in an image/canvas source. Returns null if no face is found.
export async function computeDescriptor(source) {
  if (!ready) return null;
  const res = await faceapi
    .detectSingleFace(source, detOpts)
    .withFaceLandmarks()
    .withFaceDescriptor();
  return res ? res.descriptor : null;
}

// Euclidean distance between two descriptors. < ~0.5 => likely same person.
export function distance(a, b) {
  return faceapi.euclideanDistance(a, b);
}

// Best match of a descriptor against enrolled people.
// Returns { label, dist } or null. `people` = [{ label, descriptors:[Float32Array] }].
export function matchDescriptor(desc, people, threshold = 0.55) {
  let best = null;
  for (const p of people) {
    for (const d of p.descriptors) {
      const dist = distance(desc, d);
      if (!best || dist < best.dist) best = { label: p.label, dist };
    }
  }
  if (best && best.dist <= threshold) return best;
  return null;
}

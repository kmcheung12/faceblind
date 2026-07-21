# FaceBlind

In-browser video face blurs / pixelates / replaces them with an emoji — then re-encodes to
MP4. **Everything runs locally in the browser; no video ever leaves the machine.** Optionally support a fast mask video generation, which you can further process with ffmpeg locally.

Demo: https://kmcheung12.github.io/faceblind/

> **Browser support:** currently tested on **desktop Chrome and Firefox only**. The pipeline relies on `requestVideoFrameCallback` and WebM
> `MediaRecorder`, which Firefox and Safari don't (fully) support.

## Stack

- **Vite + Svelte** — app shell / UI.
- **MediaPipe Tasks Vision** (`FaceDetector`, BlazeFace short-range) — fast
  per-frame face detection (box + keypoints).
- **MediaPipe Pose Landmarker** (`pose_landmarker_full`) — derives a head box
  from body pose to cover heads that are **turned away, distant, or steeply
  angled**, which face detection misses. Optional (toggle in the UI); the ~9 MB
  model loads lazily in the background.
- **@vladmandic/face-api** (recognition net) — 128-d face descriptors for
  identity matching (MediaPipe has no JS face-embedding task).
- **ffmpeg.wasm** (single-threaded core) — transcodes the processed canvas
  recording to H.264 MP4 and muxes the original audio back in. Also used to
  **convert incompatible inputs** (see below).

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production bundle → dist/
```

### Try the built app

`npm run build` emits a static bundle in `dist/`. Serve it over HTTP (opening the
files directly with `file://` won't work — the app fetches modules/models and uses
APIs that require an `http://` origin):

```bash
npm run build

# Python 3
python3 -m http.server 8000 --directory dist

# …or Node
npx serve dist        # http://localhost:3000
```

Then open the printed URL (e.g. http://localhost:8000) in Chrome.

### Deploying under a sub-path

The app is fully static and needs no special headers (it uses the single-threaded
ffmpeg.wasm core, so no cross-origin isolation). At a root domain, user page
(`kmcheung12.github.io`), or custom domain, `npm run build` works as-is.

To serve under a sub-path `/<repo>/` (e.g.
`https://kmcheung12.github.io/faceblind/`), set the base path at build time so asset and
worker URLs resolve correctly (the ffmpeg worker in particular — a wrong path
makes MP4 export hang):

```bash
BASE_PATH=/faceblind/ npm run build   # keep the trailing slash
```

`BASE_PATH` feeds Vite's `base`; the self-hosted ffmpeg worker path is derived
from it automatically.

Requires a Chromium-based browser (uses `requestVideoFrameCallback`,
`canvas.captureStream`, `MediaRecorder`, WebGL). Models are fetched from public
CDNs on first use; ffmpeg core is loaded lazily on first export.

## Manual mask editing

Auto-detection isn't perfect, so you can edit coverage by hand on the preview
canvas:

- **Draw a mask** by dragging over any region; drag inside to move it, drag a
  corner to resize.
- **Keyframes over time** — scrub to another frame and move/resize the mask and
  it sets a keyframe there; positions **tween between keyframes** so a mask can
  follow a head frame by frame.
- **Time-scoped lifespan** — a mask is a function of time: it lives from where
  you add it until where you end it. The box's top-right **✕ ends the mask at
  the current frame** (kept before, gone after); the chip ✕ / <kbd>Delete</kbd>
  removes it across all time.
- **← / →** step one frame at a time for precise placement (**Shift** = 10 frames).
- **Fix a bad detection** — click a detection box to adopt it into an editable
  mask, or drop a 🚫 *ignore* region over a false detection to skip it.

Per-mask effect/emoji overrides are respected, and masks are always applied on
export.

## Convert for compatibility

Some inputs (notably iPhone **HEVC / 10-bit** `.mov`, or rotated footage) can't
be decoded by the `<video>` element. When that's detected the app offers a
**Convert for compatibility** step that transcodes the file to 8-bit H.264
(rotation baked in) with ffmpeg.wasm, then reloads the pipeline from the
decodable version. Everything still stays on your machine.

## Notes / limitations

- Processing runs in **realtime playback** (capture-as-it-plays). On slow
  machines heavy frames may drop; detection with BlazeFace is normally fast
  enough to keep up.

# FaceBlind

In-browser video face blurs / pixelates / replaces them with an emoji — then re-encodes to
MP4. **Everything runs locally in the browser; no video ever leaves the machine.** Optionally support a fast mask video generation, which you can further process with ffmpeg locally.

> **Browser support:** currently tested on **desktop Chrome only**. The pipeline relies on `requestVideoFrameCallback` and WebM
> `MediaRecorder`, which Firefox and Safari don't (fully) support.

## Stack

- **Vite + Svelte** — app shell / UI.
- **MediaPipe Tasks Vision** (`FaceDetector`, BlazeFace short-range) — fast
  per-frame face detection (box + keypoints).
- **@vladmandic/face-api** (recognition net) — 128-d face descriptors for
  identity matching (MediaPipe has no JS face-embedding task).
- **ffmpeg.wasm** (single-threaded core) — transcodes the processed canvas
  recording to H.264 MP4 and muxes the original audio back in.

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

Requires a Chromium-based browser (uses `requestVideoFrameCallback`,
`canvas.captureStream`, `MediaRecorder`, WebGL). Models are fetched from public
CDNs on first use; ffmpeg core is loaded lazily on first export.

## Notes / limitations

- Processing runs in **realtime playback** (capture-as-it-plays). On slow
  machines heavy frames may drop; detection with BlazeFace is normally fast
  enough to keep up.

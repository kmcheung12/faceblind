import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// No cross-origin-isolation headers are set on purpose: we use the
// single-threaded ffmpeg.wasm core (no SharedArrayBuffer required) so that
// MediaPipe / face-api model files can still be pulled from public CDNs.
export default defineConfig({
  // Public base path. Defaults to '/' (root domain / user page / custom domain).
  // For a GitHub Pages *project* site the app is served under /<repo>/, so build
  // with e.g. `BASE_PATH=/faceblind/ npm run build`. Must keep the trailing slash.
  base: process.env.BASE_PATH || '/',
  plugins: [svelte()],
  optimizeDeps: {
    // face-api ships its own tfjs; let esbuild pre-bundle it cleanly.
    include: ['@vladmandic/face-api', '@mediapipe/tasks-vision', '@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  build: {
    // face-api + tfjs is an unavoidably large ML chunk; it is lazy-loaded
    // (separate chunk, not in the initial bundle) so the size is acceptable.
    chunkSizeWarningLimit: 1600,
  },
  server: { port: 5173 },
});

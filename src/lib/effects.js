// Drawing effects applied to a detected face region on a 2D canvas context.
// Region: { x, y, w, h, keypoints }. Source is the current frame already drawn
// on the canvas (we sample from a provided source image/video for clean blur).

const scratch = document.createElement('canvas');
const sctx = scratch.getContext('2d');

// Pad the box a bit so the effect fully covers the face + hair/chin.
export function padded(r, padX = 0.18, padY = 0.28) {
  const px = r.w * padX;
  const py = r.h * padY;
  return { x: r.x - px, y: r.y - py, w: r.w + px * 2, h: r.h + py * 2 };
}

function ellipseClip(ctx, b) {
  ctx.beginPath();
  ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
  ctx.clip();
}

// Face roll angle from eye keypoints (MediaPipe order: 0=right eye, 1=left eye).
function faceAngle(r) {
  const kp = r.keypoints;
  if (!kp || kp.length < 2) return 0;
  return Math.atan2(kp[1].y - kp[0].y, kp[1].x - kp[0].x);
}

export function drawBlur(ctx, source, region, strength = 14, elliptical = true) {
  const b = padded(region);
  ctx.save();
  if (elliptical) ellipseClip(ctx, b);
  ctx.filter = `blur(${strength}px)`;
  // Draw the source region, blurred, back over itself.
  ctx.drawImage(source, b.x, b.y, b.w, b.h, b.x, b.y, b.w, b.h);
  ctx.restore();
}

export function drawPixelate(ctx, source, region, blocks = 12, elliptical = true) {
  const b = padded(region);
  const sw = Math.max(2, Math.round(blocks));
  const sh = Math.max(2, Math.round((blocks * b.h) / b.w));
  scratch.width = sw;
  scratch.height = sh;
  sctx.imageSmoothingEnabled = false;
  sctx.clearRect(0, 0, sw, sh);
  sctx.drawImage(source, b.x, b.y, b.w, b.h, 0, 0, sw, sh);
  ctx.save();
  if (elliptical) ellipseClip(ctx, b);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(scratch, 0, 0, sw, sh, b.x, b.y, b.w, b.h);
  ctx.restore();
}

export function drawEmoji(ctx, emoji, region) {
  const b = padded(region, 0.15, 0.2);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const size = Math.max(b.w, b.h) * 1.05;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(faceAngle(region));
  ctx.font = `${size}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, 0, size * 0.02);
  ctx.restore();
}

export function drawBox(ctx, region, color, label) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, region.w * 0.02);
  ctx.strokeRect(region.x, region.y, region.w, region.h);
  if (label) {
    ctx.font = `${Math.max(14, region.w * 0.12)}px sans-serif`;
    ctx.fillStyle = color;
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, region.x + 2, region.y - 2);
  }
  ctx.restore();
}

// Fill the exact region an effect would cover (padded ellipse) in the current
// fillStyle. Used to render a white-on-black mask video for external ffmpeg use,
// so the downloaded mask lines up precisely with what the app blurs.
export function fillMask(ctx, region) {
  const b = padded(region);
  ctx.beginPath();
  ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
  ctx.fill();
}

export function applyEffect(ctx, source, region, opts) {
  const { effect, emoji, blurStrength, pixelBlocks } = opts;
  if (effect === 'blur') drawBlur(ctx, source, region, blurStrength);
  else if (effect === 'pixelate') drawPixelate(ctx, source, region, pixelBlocks);
  else if (effect === 'emoji') drawEmoji(ctx, emoji, region);
}

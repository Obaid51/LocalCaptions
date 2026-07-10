/**
 * Generates the Chrome Web Store small promo tile (440x280) with zero deps.
 * Same hand-rolled PNG encoder as gen-icons, plus a compact 5x7 bitmap font.
 * Rendered at 3x supersampling and box-downsampled for smooth edges.
 *
 *   node tools/gen-promo.mjs  ->  store-assets/promo-tile-440x280.png
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'store-assets');

// ---- PNG encoder ----
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const t = Buffer.from(type, 'ascii'); const l = Buffer.alloc(4); l.writeUInt32BE(data.length, 0); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])), 0); return Buffer.concat([l, t, data, c]); }
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = w * 4; const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- 5x7 bitmap font (rows top->bottom, 5 cols) ----
const F = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10101', '10011', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  a: ['00000', '00000', '01110', '00001', '01111', '10001', '01111'],
  c: ['00000', '00000', '01110', '10001', '10000', '10001', '01110'],
  i: ['00100', '00000', '01100', '00100', '00100', '00100', '01110'],
  l: ['01100', '00100', '00100', '00100', '00100', '00100', '01110'],
  n: ['00000', '00000', '10110', '11001', '10001', '10001', '10001'],
  o: ['00000', '00000', '01110', '10001', '10001', '10001', '01110'],
  p: ['00000', '00000', '11110', '10001', '11110', '10000', '10000'],
  s: ['00000', '00000', '01111', '10000', '01110', '00001', '11110'],
  t: ['01000', '01000', '11110', '01000', '01000', '01001', '00110'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
};

const W = 440, H = 280, SS = 3, HW = W * SS, HH = H * SS;
const buf = new Uint8ClampedArray(HW * HH * 4);

function setHi(hx, hy, r, g, b) {
  if (hx < 0 || hy < 0 || hx >= HW || hy >= HH) return;
  const i = (hy * HW + hx) * 4; buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
}
function lerp(a, b, t) { return a + (b - a) * t; }
function inRR(px, py, x, y, w, h, r) {
  const nx = Math.max(x + r, Math.min(px, x + w - r));
  const ny = Math.max(y + r, Math.min(py, y + h - r));
  const dx = px - nx, dy = py - ny; return dx * dx + dy * dy <= r * r;
}

// Fill a rounded rect (final coords) with a per-pixel color function, blended.
function fillRoundRect(x, y, w, h, r, colorFn, alpha = 1) {
  const x0 = Math.floor(x * SS), y0 = Math.floor(y * SS), x1 = Math.ceil((x + w) * SS), y1 = Math.ceil((y + h) * SS);
  for (let hy = y0; hy < y1; hy++) {
    for (let hx = x0; hx < x1; hx++) {
      if (hx < 0 || hy < 0 || hx >= HW || hy >= HH) continue;
      const fx = hx / SS, fy = hy / SS;
      if (!inRR(fx, fy, x, y, w, h, r)) continue;
      const c = colorFn(fx, fy);
      if (alpha >= 1) setHi(hx, hy, c[0], c[1], c[2]);
      else {
        const i = (hy * HW + hx) * 4;
        setHi(hx, hy, lerp(buf[i], c[0], alpha), lerp(buf[i + 1], c[1], alpha), lerp(buf[i + 2], c[2], alpha));
      }
    }
  }
}

function textWidth(str, scale) { return str.length * 6 * scale - scale; }
function drawText(str, x, y, scale, color) {
  let cx = x;
  for (const ch of str) {
    if (!F[ch]) console.warn(`gen-promo: missing glyph for '${ch}'`);
    const g = F[ch] || F[' '];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (g[row][col] === '1') fillRoundRect(cx + col * scale, y + row * scale, scale, scale, 0, () => color);
      }
    }
    cx += 6 * scale;
  }
}
function drawTextCentered(str, y, scale, color) { drawText(str, (W - textWidth(str, scale)) / 2, y, scale, color); }

// ---- compose ----
const BG_TL = [26, 115, 232], BG_BR = [12, 46, 110];   // indigo -> deep blue
function bgAt(fx, fy) {
  const t = (fx / W + fy / H) / 2;
  return [Math.round(lerp(BG_TL[0], BG_BR[0], t)), Math.round(lerp(BG_TL[1], BG_BR[1], t)), Math.round(lerp(BG_TL[2], BG_BR[2], t))];
}
// background
for (let hy = 0; hy < HH; hy++) for (let hx = 0; hx < HW; hx++) { const c = bgAt(hx / SS, hy / SS); setHi(hx, hy, c[0], c[1], c[2]); }

// ---- app icon (centered top): shadow, tile, caption bars ----
const IW = 88, IX = (W - IW) / 2, IY = 26, IR = 20;
fillRoundRect(IX + 3, IY + 5, IW, IW, IR, () => [0, 0, 0], 0.28);   // soft shadow
const ITL = [45, 130, 235], IBR = [23, 78, 190];
fillRoundRect(IX, IY, IW, IW, IR, (fx, fy) => { const t = (fy - IY) / IW; return [Math.round(lerp(ITL[0], IBR[0], t)), Math.round(lerp(ITL[1], IBR[1], t)), Math.round(lerp(ITL[2], IBR[2], t))]; });
// caption bars inside the icon
const bars = [{ w: 0.52 }, { w: 0.52 }, { w: 0.34 }];
const barH = IW * 0.11, barX = IX + IW * 0.24;
bars.forEach((b, i) => fillRoundRect(barX, IY + IW * (0.30 + i * 0.18), b.w * IW, barH, barH / 2, () => [255, 255, 255]));

// ---- wordmark + taglines ----
drawTextCentered('LocalCaptions', 128, 4, [255, 255, 255]);
drawTextCentered('REAL-TIME MEETING TRANSCRIPTS', 178, 2, [223, 234, 255]);
drawTextCentered('SAVED LOCALLY - NO CLOUD', 210, 2, [150, 190, 250]);

// ---- downsample SSxSS -> 1 ----
const out = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  let r = 0, g = 0, b = 0;
  for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) { const i = ((y * SS + sy) * HW + (x * SS + sx)) * 4; r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; }
  const n = SS * SS, o = (y * W + x) * 4;
  out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = 255;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, 'promo-tile-440x280.png');
fs.writeFileSync(outPath, encodePNG(W, H, out));
console.log(`wrote ${path.relative(path.join(__dirname, '..'), outPath)} (${W}x${H})`);

/**
 * Generates LocalCaptions PNG icons (16/32/48/128) with zero dependencies.
 * A tiny PNG encoder (CRC32 + zlib/deflate) renders a supersampled canvas
 * of a rounded indigo tile with three white "caption line" bars, then
 * box-downsamples for smooth edges.
 *
 *   node tools/gen-icons.mjs
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'icons');

// ---- PNG encoder ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  // 10,11,12 = compression, filter, interlace = 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy ? rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
      : Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- drawing ----
// Signed inside-test for a rounded rectangle.
function inRoundRect(px, py, x, y, w, h, r) {
  const nx = Math.max(x + r, Math.min(px, x + w - r));
  const ny = Math.max(y + r, Math.min(py, y + h - r));
  const dx = px - nx, dy = py - ny;
  return dx * dx + dy * dy <= r * r;
}
function lerp(a, b, t) { return a + (b - a) * t; }

// Render one icon at `size` using SS× supersampling.
function renderIcon(size) {
  const SS = 4;
  const S = size * SS;
  const hi = Buffer.alloc(S * S * 4); // RGBA, transparent

  // Background gradient (indigo top -> deep blue bottom).
  const top = [26, 115, 232];   // #1a73e8
  const bot = [21, 60, 140];    // #153c8c
  const pad = S * 0.045;
  const radius = S * 0.22;

  // Caption bars (unit fractions of S).
  const bars = [
    { y: 0.32, w: 0.54 },
    { y: 0.50, w: 0.54 },
    { y: 0.68, w: 0.36 },
  ];
  const barH = S * 0.10;
  const barX = S * 0.24;
  const barR = barH / 2;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      if (!inRoundRect(x, y, pad, pad, S - 2 * pad, S - 2 * pad, radius)) continue;
      const t = y / S;
      let r = Math.round(lerp(top[0], bot[0], t));
      let g = Math.round(lerp(top[1], bot[1], t));
      let b = Math.round(lerp(top[2], bot[2], t));
      // Paint white bars on top.
      for (const bar of bars) {
        const by = bar.y * S;
        if (inRoundRect(x, y, barX, by, bar.w * S, barH, barR)) { r = g = b = 255; break; }
      }
      hi[i] = r; hi[i + 1] = g; hi[i + 2] = b; hi[i + 3] = 255;
    }
  }

  // Box-downsample SS×SS -> 1 px.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * S + (x * SS + sx)) * 4;
          const af = hi[i + 3] / 255;
          r += hi[i] * af; g += hi[i + 1] * af; b += hi[i + 2] * af; a += hi[i + 3];
        }
      }
      const n = SS * SS;
      const aAvg = a / n;
      const o = (y * size + x) * 4;
      if (aAvg <= 0) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; continue; }
      // Un-premultiply for straight-alpha PNG.
      const cover = a / 255; // sum of alpha fractions
      out[o] = Math.round(r / cover);
      out[o + 1] = Math.round(g / cover);
      out[o + 2] = Math.round(b / cover);
      out[o + 3] = Math.round(aAvg);
    }
  }
  return out;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const rgba = renderIcon(size);
  const png = encodePNG(size, size, rgba);
  const file = path.join(OUT_DIR, `icon-${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
console.log('done');

// Renders the Schedula "stopwatch check" logo to PNG (no dependencies). Mirrors icons/logo.svg.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = process.argv[2];
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return buf => { let c = 0xffffffff; for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
})();
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(td));
  return Buffer.concat([len, td, crc]);
};
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = size * 4 + 1, raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---- geometry, in the 64-unit space of logo.svg ----
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const TILE_TOP = hex('#16213d'), TILE_BOT = hex('#070b16'), GLOW = hex('#7aa2ff');
const G0 = hex('#9dbbff'), G1 = hex('#b196ff'), WHITE = [255, 255, 255];
const C = [32, 32], R = 20, ARC_HALF = 2.5;
const A_START = Math.atan2(13.4 - 32, 39.2 - 32), A_END = Math.atan2(13.4 - 32, 24.8 - 32); // gap between END..START (top)
const ENDS = [[39.2, 13.4], [24.8, 13.4]];
const DOT = [32, 11.6], DOT_R = 2.9;
const CHECK = [[23.8, 33.2], [29.8, 39.2], [41.6, 27.4]], CHECK_HALF = 2.6;

function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function arcDist(x, y) {
  const a = Math.atan2(y - C[1], x - C[0]);
  const inGap = a > A_END && a < A_START;
  if (!inGap) return Math.abs(Math.hypot(x - C[0], y - C[1]) - R);
  return Math.min(...ENDS.map(([ex, ey]) => Math.hypot(x - ex, y - ey)));
}
const grad = (x, y) => mix(G0, G1, Math.max(0, Math.min(1, ((x - 12) + (y - 9)) / 80)));

/** Colour at logo-space point (u,v). `rounded` = rounded tile with transparent corners. */
function sample(u, v, { rounded, markScale }) {
  const RR = 15;
  let inside = true, edge = Infinity;
  if (rounded) {
    const cx = Math.min(Math.max(u, RR), 64 - RR), cy = Math.min(Math.max(v, RR), 64 - RR);
    const d = Math.hypot(u - cx, v - cy);
    if (d > RR) inside = false;
    edge = RR - d; // distance to the rounded border (valid near corners/edges)
    edge = Math.min(edge, u, v, 64 - u, 64 - v);
  }
  if (!inside) return null;
  let c = mix(TILE_TOP, TILE_BOT, v / 64);
  const gd = Math.hypot((u - 32) / 38.4, (v - 25.6) / 38.4);
  c = mix(c, GLOW, 0.28 * Math.max(0, 1 - gd));
  if (rounded && edge < 1.5) c = mix(c, WHITE, 0.08);
  // mark (optionally scaled about the centre for maskable icons)
  const x = 32 + (u - 32) / markScale, y = 32 + (v - 32) / markScale;
  if (arcDist(x, y) <= ARC_HALF || Math.hypot(x - DOT[0], y - DOT[1]) <= DOT_R) c = grad(x, y);
  if (Math.min(segDist(x, y, CHECK[0], CHECK[1]), segDist(x, y, CHECK[1], CHECK[2])) <= CHECK_HALF) c = WHITE;
  return c;
}

function render(size, opts) {
  const SS = 4, buf = Buffer.alloc(size * size * 4), k = 64 / size;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const c = sample((px + (sx + 0.5) / SS) * k, (py + (sy + 0.5) / SS) * k, opts);
      if (c) { r += c[0]; g += c[1]; b += c[2]; n++; }
    }
    const i = (py * size + px) * 4;
    if (n) { buf[i] = Math.round(r / n); buf[i + 1] = Math.round(g / n); buf[i + 2] = Math.round(b / n); }
    buf[i + 3] = Math.round(255 * n / (SS * SS));
  }
  return png(size, buf);
}

fs.mkdirSync(OUT, { recursive: true });
const jobs = [
  ['icon-192.png', 192, { rounded: true, markScale: 1 }],
  ['icon-512.png', 512, { rounded: true, markScale: 1 }],
  ['icon-maskable-512.png', 512, { rounded: false, markScale: 0.74 }], // mark inside the 80% safe zone
  ['apple-touch-icon.png', 180, { rounded: false, markScale: 0.86 }],  // iOS applies its own rounding
];
for (const [name, size, opts] of jobs) { fs.writeFileSync(path.join(OUT, name), render(size, opts)); console.log('wrote', name); }

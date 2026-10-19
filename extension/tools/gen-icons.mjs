// 极简 PNG 编码器 + 生成 16/32/48/128 图标（蓝色圆角底 + 白/金 双箭头环）
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const si = (y * size + x) * 4;
      const di = y * (size * 4 + 1) + 1 + x * 4;
      raw[di] = rgba[si]; raw[di + 1] = rgba[si + 1]; raw[di + 2] = rgba[si + 2]; raw[di + 3] = rgba[si + 3];
    }
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function rr(x, y, cx, cy, r) { return Math.hypot(x - cx, y - cy) <= r; }
function rounded(x, y, s, r) {
  const cx = Math.min(Math.max(x, r), s - r), cy = Math.min(Math.max(y, r), s - r);
  return Math.hypot(x - cx, y - cy) <= r || (x > r && x < s - r && y > r && y < s - r);
}
export function generateIcons(dir) {
  mkdirSync(dir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const px = Buffer.alloc(size * size * 4);
    const s = size;
    const cx = s / 2, cy = s / 2;
    const bg = [37, 99, 235];       // blue
    const ring = [255, 255, 255];   // white arc
    const gold = [250, 204, 21];    // gold arrow
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const i = (y * s + x) * 4;
        const aa = 8; // supersample 2x
        let rAcc = 0, gAcc = 0, bAcc = 0, aAcc = 0;
        for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
          const fx = x + (sx + 0.5) / 2, fy = y + (sy + 0.5) / 2;
          if (!rounded(fx, fy, s, s * 0.22)) { aAcc += 0; continue; }
          let col = bg, alpha = 255;
          // globe ring
          const d = Math.hypot(fx - cx, fy - cy);
          const rOut = s * 0.36, rIn = s * 0.30;
          const ang = Math.atan2(fy - cy, fx - cx);
          const inRing = d >= rIn && d <= rOut;
          if (inRing) {
            // two arcs leaving a gap at ~upper right / lower left
            const deg = ((ang * 180 / Math.PI) + 360) % 360;
            const gapA = deg > 100 && deg < 130;
            const gapB = deg > 280 && deg < 310;
            col = gapA || gapB ? bg : ring;
          } else if (d < rIn && d > s * 0.05) {
            // gold inner arrow -> hint "translation flow"
            const a2 = ang + Math.PI * 0.5;
            const tip = d > s * 0.22 && d < rIn && ((ang * 180 / Math.PI + 360) % 360) < 200 ? gold : bg;
            col = tip;
          }
          rAcc += col[0]; gAcc += col[1]; bAcc += col[2]; aAcc += alpha;
        }
        px[i] = rAcc / 4; px[i + 1] = gAcc / 4; px[i + 2] = bAcc / 4; px[i + 3] = 255;
      }
    }
    writeFileSync(join(dir, `icon${size}.png`), encodePng(size, px));
  }
}
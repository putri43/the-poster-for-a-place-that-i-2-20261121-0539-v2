// VESPERA — a travel poster for a place that does not exist.
// Floating isles with waterfalls pouring into a sea of clouds, a lighthouse,
// a skyferry airship, dusk sky with moon and shooting star.
// Node 22, stdlib only. Own PNG encoder (CRC32 + zlib deflate).
// Deterministic: identical SHA-256 across runs. Writes /output/entry.png
// and a repo copy at output/entry.png.

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

const W = 900;
const H = 1350;

// ---------- deterministic PRNG ----------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261121);

// ---------- PNG encoding ----------
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w: number, h: number, rgb: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0;
    rgb.copy(raw, y * (1 + w * 3) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- canvas ----------
type RGB = [number, number, number];
const buf = Buffer.alloc(W * H * 3);
function setPx(x: number, y: number, c: RGB): void {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
  const i = (yi * W + xi) * 3;
  buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
}
function blendPx(x: number, y: number, c: RGB, a: number): void {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
  const i = (yi * W + xi) * 3;
  buf[i] = Math.round(buf[i] * (1 - a) + c[0] * a);
  buf[i + 1] = Math.round(buf[i + 1] * (1 - a) + c[1] * a);
  buf[i + 2] = Math.round(buf[i + 2] * (1 - a) + c[2] * a);
}
function hex(h: string): RGB {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function lerp(a: RGB, b: RGB, t: number): RGB {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}
function fillRect(x0: number, y0: number, x1: number, y1: number, c: RGB): void {
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++)
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) setPx(x, y, c);
}
function vGrad(y0: number, y1: number, stops: [number, RGB][]): void {
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    const t = (y - y0) / (y1 - y0);
    let c = stops[stops.length - 1][1];
    for (let s = 0; s < stops.length - 1; s++) {
      if (t >= stops[s][0] && t <= stops[s + 1][0]) {
        c = lerp(stops[s][1], stops[s + 1][1], (t - stops[s][0]) / (stops[s + 1][0] - stops[s][0]));
        break;
      }
    }
    for (let x = 0; x < W; x++) setPx(x, y, c);
  }
}
function disc(cx: number, cy: number, r: number, c: RGB, a = 1): void {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r * r) { if (a >= 1) setPx(x, y, c); else blendPx(x, y, c, a); }
    }
}
function ellipse(cx: number, cy: number, rx: number, ry: number, c: RGB, a = 1): void {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) { if (a >= 1) setPx(x, y, c); else blendPx(x, y, c, a); }
    }
}
function poly(points: [number, number][], c: RGB, a = 1): void {
  let minY = Infinity, maxY = -Infinity;
  for (const [, y] of points) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
    const xs: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + (y - y1) * (x2 - x1) / (y2 - y1));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2)
      for (let x = Math.ceil(xs[k]); x <= xs[k + 1]; x++) { if (a >= 1) setPx(x, y, c); else blendPx(x, y, c, a); }
  }
}
function line(x0: number, y0: number, x1: number, y1: number, c: RGB, wdt = 1, a = 1): void {
  const dx = x1 - x0, dy = y1 - y0, steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
  for (let i = 0; i <= steps; i++) {
    const x = x0 + dx * i / steps, y = y0 + dy * i / steps;
    if (wdt <= 1) { if (a >= 1) setPx(x, y, c); else blendPx(x, y, c, a); }
    else disc(x, y, wdt / 2, c, a);
  }
}

// ---------- 5x7 pixel font ----------
const FONT: Record<string, string[]> = {
  A: ["01110","10001","10001","11111","10001","10001","10001"],
  B: ["11110","10001","10001","11110","10001","10001","11110"],
  C: ["01110","10001","10000","10000","10000","10001","01110"],
  D: ["11110","10001","10001","10001","10001","10001","11110"],
  E: ["11111","10000","10000","11110","10000","10000","11111"],
  F: ["11111","10000","10000","11110","10000","10000","10000"],
  G: ["01110","10001","10000","10111","10001","10001","01111"],
  H: ["10001","10001","10001","11111","10001","10001","10001"],
  I: ["01110","00100","00100","00100","00100","00100","01110"],
  J: ["00111","00010","00010","00010","00010","10010","01100"],
  K: ["10001","10010","10100","11000","10100","10010","10001"],
  L: ["10000","10000","10000","10000","10000","10000","11111"],
  M: ["10001","11011","10101","10101","10001","10001","10001"],
  N: ["10001","11001","10101","10011","10001","10001","10001"],
  O: ["01110","10001","10001","10001","10001","10001","01110"],
  P: ["11110","10001","10001","11110","10000","10000","10000"],
  Q: ["01110","10001","10001","10001","10101","10010","01101"],
  R: ["11110","10001","10001","11110","10100","10010","10001"],
  S: ["01111","10000","10000","01110","00001","00001","11110"],
  T: ["11111","00100","00100","00100","00100","00100","00100"],
  U: ["10001","10001","10001","10001","10001","10001","01110"],
  V: ["10001","10001","10001","10001","10001","01010","00100"],
  W: ["10001","10001","10001","10101","10101","11011","10001"],
  X: ["10001","10001","01010","00100","01010","10001","10001"],
  Y: ["10001","10001","01010","00100","00100","00100","00100"],
  Z: ["11111","00001","00010","00100","01000","10000","11111"],
  "0": ["01110","10001","10011","10101","11001","10001","01110"],
  "1": ["00100","01100","00100","00100","00100","00100","01110"],
  "2": ["01110","10001","00001","00110","01000","10000","11111"],
  "3": ["11110","00001","00001","01110","00001","00001","11110"],
  "4": ["00010","00110","01010","10010","11111","00010","00010"],
  "5": ["11111","10000","11110","00001","00001","10001","01110"],
  "6": ["01110","10000","10000","11110","10001","10001","01110"],
  "7": ["11111","00001","00010","00100","01000","01000","01000"],
  "8": ["01110","10001","10001","01110","10001","10001","01110"],
  "9": ["01110","10001","10001","01111","00001","00001","01110"],
  " ": ["00000","00000","00000","00000","00000","00000","00000"],
  ".": ["00000","00000","00000","00000","00000","01100","01100"],
  ",": ["00000","00000","00000","00000","01100","00100","01000"],
  "'": ["00100","00100","01000","00000","00000","00000","00000"],
  "·": ["00000","00000","01100","01100","00000","00000","00000"],
  "—": ["00000","00000","00000","11111","00000","00000","00000"],
  "-": ["00000","00000","00000","01110","00000","00000","00000"],
  "!": ["00100","00100","00100","00100","00100","00000","00100"],
  ":": ["00000","01100","00000","00000","00000","01100","00000"],
  "*": ["00000","00100","10101","01110","10101","00100","00000"],
};
function textWidth(s: string, scale: number): number {
  return s.length * 6 * scale - scale;
}
function drawText(s: string, cx: number, y: number, scale: number, c: RGB): void {
  let x = Math.round(cx - textWidth(s, scale) / 2);
  for (const ch of s.toUpperCase()) {
    const g = FONT[ch] ?? FONT[" "];
    for (let r = 0; r < 7; r++)
      for (let col = 0; col < 5; col++)
        if (g[r][col] === "1") fillRect(x + col * scale, y + r * scale, x + (col + 1) * scale, y + (r + 1) * scale, c);
    x += 6 * scale;
  }
}

// ---------- scene ----------
const INK = hex("#241a4d");
const CREAM = hex("#f8efdc");

function drawSky(): void {
  vGrad(0, 1080, [
    [0, hex("#171238")], [0.35, hex("#46307a")], [0.6, hex("#8a4f96")],
    [0.8, hex("#d2695f")], [1, hex("#f6a55c")],
  ]);
  // stars in the upper sky
  for (let i = 0; i < 190; i++) {
    const x = rnd() * W, y = rnd() * 720, r = rnd() < 0.85 ? 1 : 2;
    const b = 0.5 + rnd() * 0.5;
    disc(x, y, r, [Math.round(255 * b), Math.round(245 * b), Math.round(225 * b)]);
  }
  // moon with glow and craters
  const mx = 690, my = 168;
  for (const [r, a] of [[120, 0.10], [95, 0.14], [72, 0.20]] as [number, number][])
    disc(mx, my, r, hex("#f8ecd4"), a);
  disc(mx, my, 56, hex("#f8ecd4"));
  disc(mx - 18, my - 10, 9, hex("#e3d3ae"));
  disc(mx + 14, my + 16, 6, hex("#e3d3ae"));
  disc(mx + 22, my - 20, 5, hex("#e8d9b6"));
  // shooting star
  line(150, 108, 330, 236, hex("#fff6d8"), 3, 0.95);
  for (let i = 0; i < 26; i++) {
    const t = i / 26;
    disc(150 + (330 - 150) * t - rnd() * 6, 108 + (236 - 108) * t + rnd() * 4, 2.5 - t * 1.5, hex("#ffe9a8"), 0.85 - t * 0.6);
  }
  disc(330, 236, 5, hex("#fffbe8"));
  // tiny birds
  for (const [bx, by, s] of [[420, 300, 9], [455, 322, 7], [385, 335, 6]] as [number, number, number][]) {
    line(bx - s, by, bx, by - s * 0.55, hex("#2c2350"), 2);
    line(bx, by - s * 0.55, bx + s, by, hex("#2c2350"), 2);
  }
}

function drawIsle(x0: number, topY: number, x1: number, depth: number, withFalls: boolean): void {
  const midX = (x0 + x1) / 2, wHalf = (x1 - x0) / 2;
  // rock underside: tapered wedge
  poly([[x0, topY], [x1, topY], [midX + wHalf * 0.28, topY + depth], [midX - wHalf * 0.28, topY + depth]], hex("#6b4a3a"));
  poly([[x0 + wHalf * 0.55, topY], [x1 - wHalf * 0.55, topY], [midX + wHalf * 0.28, topY + depth], [midX - wHalf * 0.28, topY + depth]], hex("#54382c"));
  // grassy cap
  ellipse(midX, topY, wHalf, 26, hex("#4f9e5f"));
  ellipse(midX, topY - 6, wHalf * 0.92, 20, hex("#63b06a"));
  // little shrubs
  for (let i = 0; i < 7; i++) {
    const sx = x0 + 20 + rnd() * (x1 - x0 - 40);
    disc(sx, topY - 14 - rnd() * 8, 5 + rnd() * 4, hex("#3d8a4e"));
  }
  if (withFalls) {
    // waterfalls pouring off the rim into the cloud sea
    for (const fx of [x0 + wHalf * 0.35, midX + wHalf * 0.55]) {
      const fallTop = topY + 4;
      const fallBot = 1010 + rnd() * 30;
      for (let y = fallTop; y < fallBot; y += 3) {
        const wob = Math.sin(y * 0.05 + fx) * 3;
        line(fx + wob - 4, y, fx + wob - 4, y + 3, hex("#cfeef7"), 2, 0.9);
        line(fx + wob + 1, y, fx + wob + 1, y + 3, hex("#ffffff"), 1.5, 0.9);
        line(fx + wob + 5, y, fx + wob + 5, y + 3, hex("#a8d8ea"), 2, 0.8);
      }
      ellipse(fx + 1, fallBot, 22, 8, hex("#eaf7fb"), 0.9);
    }
  }
}

function drawLighthouse(x: number, baseY: number): void {
  // light beam sweeping right
  poly([[x + 6, baseY - 128], [x + 330, baseY - 178], [x + 330, baseY - 96]], hex("#ffefa8"), 0.28);
  poly([[x - 6, baseY - 128], [x - 150, baseY - 150], [x - 150, baseY - 108]], hex("#ffefa8"), 0.16);
  // tower with red bands
  poly([[x - 16, baseY], [x + 16, baseY], [x + 10, baseY - 118], [x - 10, baseY - 118]], hex("#f4ede0"));
  fillRect(x - 13, baseY - 30, x + 13, baseY - 14, hex("#c23b2e"));
  fillRect(x - 11, baseY - 76, x + 11, baseY - 60, hex("#c23b2e"));
  // gallery + lamp room + roof
  fillRect(x - 20, baseY - 126, x + 20, baseY - 116, hex("#3a2c22"));
  fillRect(x - 11, baseY - 140, x + 11, baseY - 126, hex("#ffe9a8"));
  poly([[x - 15, baseY - 140], [x + 15, baseY - 140], [x, baseY - 156]], hex("#c23b2e"));
  disc(x, baseY - 133, 3, hex("#fff6c8"));
}

function drawAirship(cx: number, cy: number): void {
  // skyferry: striped balloon envelope + gondola
  ellipse(cx, cy, 118, 46, hex("#8e2f2a"));
  ellipse(cx, cy - 8, 118, 40, hex("#b33a3a"));
  ellipse(cx, cy - 16, 96, 30, hex("#c94f43"));
  // gold band + ribs
  fillRect(cx - 112, cy - 4, cx + 112, cy + 6, hex("#e8b34a"));
  for (const rx of [-70, -35, 0, 35, 70]) line(cx + rx, cy - 42, cx + rx, cy + 40, hex("#7e2823"), 2, 0.6);
  // tail fin
  poly([[cx + 108, cy - 10], [cx + 148, cy - 34], [cx + 132, cy + 6]], hex("#8e2f2a"));
  // gondola + ropes
  line(cx - 60, cy + 30, cx - 46, cy + 66, hex("#5a3a28"), 2);
  line(cx + 60, cy + 30, cx + 46, cy + 66, hex("#5a3a28"), 2);
  line(cx, cy + 42, cx, cy + 66, hex("#5a3a28"), 2);
  poly([[cx - 52, cy + 66], [cx + 52, cy + 66], [cx + 44, cy + 96], [cx - 44, cy + 96]], hex("#5a3a28"));
  // windows
  for (const wx of [-30, -10, 10, 30]) disc(cx + wx, cy + 80, 6, hex("#ffe9a8"));
  // little flag
  line(cx - 118, cy - 40, cx - 118, cy - 66, hex("#3a2c22"), 2);
  poly([[cx - 118, cy - 66], [cx - 92, cy - 59], [cx - 118, cy - 52]], hex("#e8b34a"));
}

function drawCloudSea(): void {
  // layered soft clouds the waterfalls pour into
  const puffs: [number, number, number, number, RGB][] = [
    [120, 1030, 150, 46, hex("#f7e7c9")], [330, 1055, 190, 56, hex("#f3d9b8")],
    [580, 1025, 170, 50, hex("#f7e7c9")], [790, 1060, 160, 54, hex("#eecfae")],
    [60, 1090, 170, 52, hex("#dcc3e6")], [430, 1100, 210, 58, hex("#f7e7c9")],
    [760, 1105, 190, 56, hex("#e9cfe0")], [240, 1130, 200, 50, hex("#f3d9b8")],
    [620, 1135, 210, 52, hex("#f7e7c9")],
  ];
  for (const [x, y, rx, ry, c] of puffs) {
    ellipse(x, y, rx, ry, c, 0.96);
    ellipse(x - rx * 0.45, y - ry * 0.5, rx * 0.55, ry * 0.7, c, 0.96);
    ellipse(x + rx * 0.45, y - ry * 0.45, rx * 0.5, ry * 0.65, c, 0.96);
  }
  fillRect(0, 1140, W, 1160, hex("#f3d9b8"));
}

function drawBand(): void {
  fillRect(0, 1150, W, H, CREAM);
  fillRect(0, 1150, W, 1156, hex("#c9a86a"));
  fillRect(0, 1156, W, 1159, hex("#241a4d"));
  // thin double rule above the title
  fillRect(150, 1192, 750, 1194, hex("#c9a86a"));
  drawText("VESPERA", 450, 1198, 13, INK);
  drawText("ISLANDS THAT FLOAT · SKIES THAT NEVER END", 450, 1296, 3, hex("#7a4a3a"));
  fillRect(330, 1322, 570, 1324, hex("#c9a86a"));
  drawText("SKYFERRY DEPARTS DAILY · NO PASSPORT REQUIRED FOR DREAMERS", 450, 1328, 2, hex("#5a5468"));
  drawText("* EST. NEVER *", 450, 1166, 2, hex("#8a7a5a"));
}

// ---------- compose + write ----------
function main(): void {
  drawSky();
  // distant small isle, upper left
  drawIsle(80, 400, 260, 110, true);
  // skyferry airship cruising between the isles
  drawAirship(585, 330);
  // main isle with the lighthouse
  drawIsle(120, 560, 560, 210, true);
  drawLighthouse(300, 552);
  // right isle, lower
  drawIsle(580, 700, 830, 150, true);
  // cloud sea swallows the waterfall bases
  drawCloudSea();
  // classic poster band
  drawBand();

  const png = encodePNG(W, H, buf);
  const repoOut = path.join(process.cwd(), "output", "entry.png");
  fs.mkdirSync(path.dirname(repoOut), { recursive: true });
  fs.writeFileSync(repoOut, png);
  fs.mkdirSync("/output", { recursive: true });
  fs.writeFileSync("/output/entry.png", png);
  console.log(`wrote ${repoOut} (${png.length} bytes) and /output/entry.png`);
}
main();

/* 扫描垂直中心，找出能把"完整脸部（含眼睛、下巴）"包进圆形的位置。
 * 用法：node tools/preview-sticker.mjs v
 */
import sharp from 'sharp';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GAME = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(GAME, 'assets', 'src', 'yuncai_full.png');
const OUT = join(GAME, 'assets', 'preview_crops.png');

const meta = await sharp(SRC).metadata();
const W = meta.width, H = meta.height;

/* 第三轮：cy=0.29 r=0.195 已能完整包住头部（含头顶发饰与下巴）。
   微调水平中心与半径，让脸更居中、留白更均匀。 */
const CANDS = [
  { label: 'cx=0.47 cy=0.29 r=0.195', cx: 0.47, cy: 0.29, r: 0.195 },
  { label: 'cx=0.49 cy=0.29 r=0.195', cx: 0.49, cy: 0.29, r: 0.195 },
  { label: 'cx=0.47 cy=0.30 r=0.195', cx: 0.47, cy: 0.30, r: 0.195 },
  { label: 'cx=0.47 cy=0.30 r=0.210', cx: 0.47, cy: 0.30, r: 0.210 },
  { label: 'cx=0.47 cy=0.28 r=0.210', cx: 0.47, cy: 0.28, r: 0.210 },
  { label: 'cx=0.49 cy=0.30 r=0.210', cx: 0.49, cy: 0.30, r: 0.210 }
];

const SIZE = 220;
function mask(size, feather = 3) {
  const r = size / 2, inner = r - feather;
  const svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs><radialGradient id="g" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#fff" stop-opacity="1"/>
      <stop offset="${((inner / r) * 100).toFixed(2)}%" stop-color="#fff" stop-opacity="1"/>
      <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
    </radialGradient></defs>
    <circle cx="${r}" cy="${r}" r="${r}" fill="url(#g)"/></svg>`;
  return Buffer.from(svg);
}

const tiles = [];
for (const c of CANDS) {
  const side = Math.round(c.r * 2 * W);
  const left = Math.max(0, Math.min(W - side, Math.round(c.cx * W - side / 2)));
  const top = Math.max(0, Math.min(H - side, Math.round(c.cy * H - side / 2)));
  const png = await sharp(SRC)
    .extract({ left, top, width: side, height: side })
    .resize(SIZE, SIZE, { fit: 'cover' })
    .composite([{ input: mask(SIZE), blend: 'dest-in' }])
    .png().toBuffer();
  const label = Buffer.from(
    `<svg width="${SIZE}" height="26"><text x="4" y="18" font-family="sans-serif" font-size="15" fill="#111">${c.label}</text></svg>`
  );
  tiles.push(await sharp({ create: { width: SIZE, height: SIZE + 26, channels: 4, background: '#f2efe4' } })
    .composite([{ input: png, top: 26, left: 0 }, { input: label, top: 0, left: 0 }])
    .png().toBuffer());
}

const cols = 3, rows = Math.ceil(tiles.length / cols), cellW = SIZE, cellH = SIZE + 26, gap = 10;
const canvasW = cols * cellW + (cols + 1) * gap;
const canvasH = rows * cellH + (rows + 1) * gap;
const comps = tiles.map((t, i) => ({
  input: t, left: gap + (i % cols) * (cellW + gap), top: gap + Math.floor(i / cols) * (cellH + gap)
}));
await sharp({ create: { width: canvasW, height: canvasH, channels: 4, background: '#e9e5d8' } })
  .composite(comps).png().toFile(OUT);
console.log(`对比图：${OUT.replace(GAME, 'game')}  (${canvasW}×${canvasH})`);

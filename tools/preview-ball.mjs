/* 生成小球外观预览：贴图本身 + 放在不同底色上的观感（模拟实战画面）。
 * 用法：node tools/preview-ball.mjs
 */
import sharp from 'sharp';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GAME = join(dirname(fileURLToPath(import.meta.url)), '..');
const F = join(GAME, 'assets', 'characters', 'yuncai_head.png');
const OUT = join(GAME, 'assets', 'preview_ball.png');

const S = 200;
const head = await sharp(F).resize(S, S).png().toBuffer();

const bgs = [
  ['白底（场地内）', '#fdfcf7'],
  ['深底', '#221f18'],
  ['蓝队描边色', '#2f6df6'],
  ['红队描边色', '#e8452c']
];

const tiles = [];
for (const [label, bg] of bgs) {
  const tile = await sharp({ create: { width: S, height: S, channels: 4, background: bg } })
    .composite([{ input: head }])
    .png().toBuffer();
  const text = Buffer.from(
    `<svg width="${S}" height="24"><text x="6" y="17" font-family="sans-serif" font-size="14" fill="#111">${label}</text></svg>`
  );
  tiles.push(await sharp({ create: { width: S, height: S + 28, channels: 4, background: '#e9e5d8' } })
    .composite([{ input: tile, top: 24, left: 0 }, { input: text, top: 0, left: 0 }])
    .png().toBuffer());
}

const gap = 12;
const W = gap * (tiles.length + 1) + S * tiles.length;
const H = 28 + S + gap * 2;
await sharp({ create: { width: W, height: H, channels: 4, background: '#e9e5d8' } })
  .composite(tiles.map((t, i) => ({ input: t, left: gap + i * (S + gap), top: gap })))
  .png().toFile(OUT);

console.log(`预览图：${OUT.replace(GAME, 'game')}  (${W}×${H})`);

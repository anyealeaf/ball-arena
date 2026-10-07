/* 从截图里裁剪并放大指定区域，便于逐像素观察渲染异常。
 * 用法：node tools/zoom-shot.mjs <输入图> <x> <y> <w> <h> [放大倍数]
 */
import sharp from 'sharp';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GAME = join(dirname(fileURLToPath(import.meta.url)), '..');
const [input, x, y, w, h, z] = process.argv.slice(2);
if (!input || x === undefined) {
  console.log('用法: node tools/zoom-shot.mjs <输入图> <x> <y> <w> <h> [放大倍数]');
  process.exit(1);
}

const zoom = Number(z || 4);
const left = Number(x), top = Number(y), width = Number(w), height = Number(h);
const out = join(GAME, 'assets', `zoom_${basename(input).replace(/\.[^.]+$/, '')}.png`);

const meta = await sharp(input).metadata();
const L = Math.max(0, Math.min(meta.width - 1, left));
const T = Math.max(0, Math.min(meta.height - 1, top));
const Wd = Math.max(1, Math.min(meta.width - L, width));
const Hd = Math.max(1, Math.min(meta.height - T, height));

await sharp(input)
  .extract({ left: L, top: T, width: Wd, height: Hd })
  .resize(Wd * zoom, Hd * zoom, { kernel: 'nearest' })
  .png()
  .toFile(out);

console.log(`原图 ${meta.width}×${meta.height}`);
console.log(`裁切 (${L},${T}) ${Wd}×${Hd}，放大 ${zoom}×`);
console.log(`输出：${out.replace(GAME, 'game')}`);

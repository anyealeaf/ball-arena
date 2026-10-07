// preview-domain.mjs — 把辉光领域的展开过程画成一张预览图
//
//   node tools/preview-domain.mjs
//
// 为什么需要它：气浪的时机、领域展开的范围、滚动、透明度这几件事，
// 光看断言里的数字没有把握（数字全对但看起来不对是常事）。
// 这个脚本用和 render.js 的 _aurora() **同一套算法与同一份参数**把结果拼出来，
// 改完 balls.js 里的 domain 配置立刻能看效果，不用开浏览器、也不用打完一局。
//
// 版式：3 列 × 2 行，每格一个时刻；格底标注该时刻的状态。
import sharp from 'sharp';
import { SPECIES_BY_ID } from '../js/balls.js';

const CFG = SPECIES_BY_ID.yuncai.domain;
const SRC = CFG.src;

/* 与游戏同一套几何：方形场地，气浪中心取实测的"开局时晕彩所在位置" */
const W = 720, H = 440;               // 场地尺寸（世界单位）
const CX = 87, CY = 214;              // 气浪中心
const PX = 0.92;                      // 每个世界单位画多少像素
const DW = Math.round(W * PX), DH = Math.round(H * PX);

const STATES = [
  { t: 0.00, note: '起手：中心一个亮点' },
  { t: 0.35, note: '气浪扩散中' },
  { t: 0.70, note: '快铺满了' },
  { t: 1.00, note: '刚铺满，开始滚动' },
  { t: 1.00, scroll: 6, note: '展开后 +6 秒' },
  { t: 1.00, scroll: 20, note: '展开后 +20 秒' },
];

/* ---------- 格子的准备（世界单位算布局，最后一步换像素）---------- */
const srcMeta = await sharp(SRC).metadata();
const tileWw = H * (srcMeta.width / srcMeta.height);   // 一格的世界宽度（按高度等比）
const tileW = Math.round(tileWw * PX);                 // 一格的像素宽度
const period = tileWw * 2;                             // 镜像平铺的周期（世界单位）
const baseTile = await sharp(SRC).resize(tileW, DH, { fit: 'fill' }).png().toBuffer();
const mirrorTile = await sharp(baseTile).flop().png().toBuffer();

/* 与 _aurora 一致：镜像平铺 + 展开后向右滚动 */
async function layerFor(cell) {
  const elapsed = cell.t * CFG.revealSeconds + (cell.scroll || 0);
  let off = 0;
  if (cell.t >= 1 && CFG.scrollUnitsPerSec > 0) {
    off = ((elapsed - CFG.revealSeconds) * CFG.scrollUnitsPerSec) % period;
    if (off < 0) off += period;
  }
  const first = Math.floor((0 - off) / tileWw);
  const last = Math.floor((W - off) / tileWw);
  const comps = [];
  for (let k = first; k <= last; k++) {
    const x = Math.round((k * tileWw + off) * PX) + tileW;   // 右移一格宽，保证不出左边界
    const mirrored = (((k % 2) + 2) % 2) === 1;
    comps.push({ input: mirrored ? mirrorTile : baseTile, left: x, top: 0 });
  }
  /* sharp 的 composite 要求贴图不大于底板，所以先铺在一块更宽的画布上，
     再裁出可见的那一格 —— 等价于浏览器里"画到画布外面去"。 */
  const wide = tileW * 2 + DW;
  const big = await sharp({
    create: { width: wide, height: DH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite(comps).png().toBuffer();
  return sharp(big).extract({ left: tileW, top: 0, width: DW, height: DH }).png().toBuffer();
}

/* 距离中心最远的那个角决定"铺满全场"要多大半径 —— 与 _aurora 同一个算式 */
const corner = Math.max(
  Math.hypot(CX - 0, CY - 0), Math.hypot(CX - W, CY - 0),
  Math.hypot(CX - 0, CY - H), Math.hypot(CX - W, CY - H));

function grid(w, h, step) {
  let out = '';
  for (let x = 0; x <= w; x += step) out += `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="#eee9db" stroke-width="1"/>`;
  for (let y = 0; y <= h; y += step) out += `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#eee9db" stroke-width="1"/>`;
  return out;
}

async function cellImage(cell) {
  const ease = 1 - Math.pow(1 - cell.t, 3);
  const waveR = corner * ease + 2;
  const alpha = CFG.opacity * Math.min(1, cell.t / CFG.fadeInPortion);

  const layer = await layerFor(cell);
  /* 圆形遮罩：dest-in 只保留遮罩不透明的地方 —— 等价于 canvas 的 arc + clip */
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${DW}" height="${DH}">` +
    `<circle cx="${CX * PX}" cy="${CY * PX}" r="${waveR * PX}" fill="#fff"/></svg>`);
  const clipped = await sharp(layer)
    .composite([{ input: mask, blend: 'dest-in' }])
    .ensureAlpha().linear([1, 1, 1, alpha], [0, 0, 0, 0])
    .png().toBuffer();

  const comps = [{ input: clipped, left: 0, top: 0 }];

  /* 气浪环：只在还没铺满时画（铺满即消失） */
  if (cell.t < 1) {
    const fade = Math.min(1, cell.t / 0.05);
    const ringA = CFG.ringAlpha * fade * Math.pow(1 - cell.t, 0.8);
    if (ringA > 0.01) {
      comps.push({
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${DW}" height="${DH}">` +
          `<circle cx="${CX * PX}" cy="${CY * PX}" r="${waveR * PX}" fill="none"` +
          ` stroke="${CFG.glow}" stroke-opacity="${ringA.toFixed(3)}" stroke-width="${(CFG.ringWidth * PX).toFixed(1)}"/>` +
          `<circle cx="${CX * PX}" cy="${CY * PX}" r="${waveR * PX}" fill="none"` +
          ` stroke="${CFG.core}" stroke-opacity="${(ringA * CFG.ringCoreAlpha).toFixed(3)}" stroke-width="3"/></svg>`),
        left: 0, top: 0,
      });
    }
  }

  /* 底板：方格纸 + 场地描边 + 晕彩（一个球，标出气浪中心） */
  const board = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${DW}" height="${DH}">` +
    `<rect width="100%" height="100%" fill="#fdfcf7"/>` +
    grid(DW, DH, 24 * PX) +
    `<rect x="1" y="1" width="${DW - 2}" height="${DH - 2}" fill="none" stroke="#3a352a" stroke-width="2"/>` +
    `<circle cx="${CX * PX}" cy="${CY * PX}" r="${16 * PX}" fill="#8b7fd4" stroke="#5b4bb8" stroke-width="2"/>` +
    `</svg>`);
  return sharp(board).composite(comps).png().toBuffer();
}

const LABEL = 26;
const COLS = 3, ROWS = 2;
const comps = [];
for (let i = 0; i < STATES.length; i++) {
  const col = i % COLS, row = Math.floor(i / COLS);
  const cell = STATES[i];
  const top = row * (DH + LABEL);
  comps.push({ input: await cellImage(cell), left: col * DW, top });
  comps.push({
    input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${DW}" height="${LABEL}">` +
      `<text x="${DW / 2}" y="18" font-size="14" fill="#3a352a" text-anchor="middle" ` +
      `font-family="sans-serif">${cell.note} · 展开 ${(cell.t * 100).toFixed(0)}%</text></svg>`),
    left: col * DW, top: top + DH,
  });
}

const out = 'tools/preview-domain.png';
await sharp({
  create: { width: DW * COLS, height: (DH + LABEL) * ROWS, channels: 4, background: { r: 238, g: 235, b: 225, alpha: 1 } },
}).composite(comps).png().toFile(out);

console.log(`已生成 ${out}  ${DW * COLS}x${(DH + LABEL) * ROWS}`);
console.log(`场地 ${W}x${H}（世界单位）· 气浪中心 (${CX}, ${CY}) · 铺满需要半径 ${corner.toFixed(0)}`);
console.log(`图 ${srcMeta.width}x${srcMeta.height} → 一格 ${tileW}x${DH}px（按高度等比，横向溢出 ${(tileWw - W).toFixed(0)} 世界单位）`);
console.log(`不透明度 ${CFG.opacity} · 展开 ${CFG.revealSeconds} 秒 · 滚动 ${CFG.scrollUnitsPerSec} 单位/秒`);

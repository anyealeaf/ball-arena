// make-bow-sprites.mjs — 把作者给的弓/箭原图，规整成游戏直接能用的贴图
//
//   node tools/make-bow-sprites.mjs
//
// 为什么需要"规整"这一步，而不是直接把原图塞进游戏：
//   两张弓帧的**画布宽度不一样**（116 vs 196），因为拉弓那张多了一支搭好的箭。
//   渲染层如果各自居中画，弓会左右横跳 (196-116)/2 = 40px —— 动作直接废掉。
//   所以必须先把两帧按"弓臂对齐"贴到同一块画布上，之后渲染层只按同一个锚点画。
//
// 对齐量是**量出来的**，不是猜的：把两帧的列不透明度剖面做互相关，
// 排除掉"箭矢所在的那几行"（否则那支横箭会把结果拉偏）。
//
// 源图（已按项目约定改成纯英文名，避免路径问题）：
//   assets/src/taoyao/bow_idle.png  ← 作者原件「映霞[荣]-1.png」  平时（弓举着，弦是直的）
//   assets/src/taoyao/bow_draw.png  ← 作者原件「映霞[荣]-2.png」  拉弓（弦拉开，搭好一支箭）
//   assets/src/taoyao/arrow.png     ← 作者原件「映霞[荣]-箭矢.png」 箭矢（箭尖朝 +X）
//   assets/src/taoyao/ball.png      ← 作者原件「魔法少女[桃夭]（小球）.png」（球体贴图，另一步处理）
// 作者更新美术后：把新图按上面的英文名覆盖进 assets/src/taoyao/，再跑一次本脚本。
// 产物：assets/characters/taoyao_bow_idle.png
//       assets/characters/taoyao_bow_draw.png    ← 与 idle 同尺寸、同锚点
//       assets/characters/taoyao_arrow.png
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GAME = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(GAME, 'assets', 'src', 'taoyao');
const OUT = join(GAME, 'assets', 'characters');

const F_IDLE = join(SRC, 'bow_idle.png');
const F_DRAW = join(SRC, 'bow_draw.png');
const F_ARROW = join(SRC, 'arrow.png');

const ALPHA_THR = 8;      // 判定"有像素"的 alpha 阈值（抗锯齿边缘不算）

async function raw(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, ch: info.channels };
}
const at = (im, x, y) => im.data[(y * im.w + x) * im.ch + 3];

function bbox(im, thr = ALPHA_THR) {
  let l = im.w, r = -1, t = im.h, b = -1;
  for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) {
    if (at(im, x, y) > thr) {
      if (x < l) l = x; if (x > r) r = x;
      if (y < t) t = y; if (y > b) b = y;
    }
  }
  return { l, r, t, b, w: r - l + 1, h: b - t + 1 };
}

/* 找出"箭矢横穿的那几行"：一行的横向跨度远大于该帧的中位数跨度，
   就是那支搭好的箭所在的行。对齐时要排除它们。 */
function arrowRows(im, bb) {
  const spans = [];
  for (let y = bb.t; y <= bb.b; y++) {
    let l = -1, r = -1;
    for (let x = 0; x < im.w; x++) if (at(im, x, y) > 60) { if (l < 0) l = x; r = x; }
    spans.push({ y, span: r < 0 ? 0 : r - l + 1 });
  }
  const med = [...spans.map(s => s.span)].sort((a, b) => a - b)[spans.length >> 1];
  const rows = new Set(spans.filter(s => s.span > med * 1.8).map(s => s.y));
  return rows;
}

/* 列剖面互相关：求把 draw 相对 idle 横移多少像素时，弓臂最吻合 */
function alignOffset(a, b, skipB) {
  const prof = (im, skip) => {
    const p = new Array(im.w).fill(0);
    for (let x = 0; x < im.w; x++) {
      let s = 0;
      for (let y = 0; y < im.h; y++) if (!skip.has(y)) s += at(im, x, y);
      p[x] = s;
    }
    return p;
  };
  const pa = prof(a, new Set());
  const pb = prof(b, skipB);
  let best = null;
  for (let d = -140; d <= 140; d++) {
    let err = 0, n = 0;
    for (let x = 0; x < a.w; x++) {
      const xb = x + d;
      if (xb < 0 || xb >= b.w) continue;
      err += Math.abs(pa[x] - pb[xb]); n++;
    }
    if (n < a.w * 0.5) continue;
    const score = err / n;
    if (!best || score < best.score) best = { d, score, n };
  }
  return best;
}

/* 把一张图贴到目标画布的指定位置（保留各自的 alpha） */
async function place(im, canvasW, canvasH, ox, oy) {
  const buf = await sharp(Buffer.from(im.data), {
    raw: { width: im.w, height: im.h, channels: im.ch },
  }).png().toBuffer();
  return sharp({
    create: { width: canvasW, height: canvasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite([{ input: buf, left: ox, top: oy }]).png().toBuffer();
}

await mkdir(OUT, { recursive: true });

const A = await raw(F_IDLE);
const B = await raw(F_DRAW);
const bbA = bbox(A), bbB = bbox(B);
const skipB = arrowRows(B, bbB);
const al = alignOffset(A, B, skipB);

console.log(`源图：平时 ${A.w}x${A.h}  拉弓 ${B.w}x${B.h}`);
console.log(`拉弓帧里被判为"箭矢行"的有 ${skipB.size} 行`);
console.log(`对齐：拉弓帧相对平时帧横移 ${al.d}px（吻合误差 ${al.score.toFixed(0)}）`);

/* 两块内容在两套坐标里的并集 —— 统一到"平时帧"的坐标系：
   平时帧放 (0,0)，拉弓帧放 (-al.d, 0)（因为 al.d 是"B 相对 A 的偏移"） */
const drawOx = -al.d;
const minX = Math.min(0, drawOx);
const maxX = Math.max(A.w, drawOx + B.w);
const H = Math.max(A.h, B.h);
const W = maxX - minX;
const idleOx = -minX, drawFinalOx = drawOx - minX;

const idlePng = await place(A, W, H, idleOx, 0);
const drawPng = await place(B, W, H, drawFinalOx, 0);

await writeFile(join(OUT, 'taoyao_bow_idle.png'), idlePng);
await writeFile(join(OUT, 'taoyao_bow_draw.png'), drawPng);

/* 箭矢：裁到内容框，箭尾贴左边缘、箭尖贴右边缘 —— 这样"画多长"就是"箭多长" */
const R = await raw(F_ARROW);
const bbR = bbox(R);
const arrowPng = await sharp(Buffer.from(R.data), {
  raw: { width: R.w, height: R.h, channels: R.ch },
}).extract({ left: bbR.l, top: bbR.t, width: bbR.w, height: bbR.h }).png().toBuffer();
await writeFile(join(OUT, 'taoyao_arrow.png'), arrowPng);

/* 锚点：把"球心"定在统一画布上的哪个位置。
   先按"平时帧内容的横向中心 + 搭箭那一行的高度"给一个初值，
   真正的微调靠 tools/preview-bow.mjs 看图。 */
const anchor = {
  x: +(((bbA.l + bbA.r) / 2 + idleOx) / W).toFixed(4),
  y: +(296 / H).toFixed(4),
};
console.log(`\n统一画布 ${W}x${H}`);
console.log(`  平时帧贴到 x=${idleOx}，拉弓帧贴到 x=${drawFinalOx}`);
console.log(`锚点初值 anchor = { x: ${anchor.x}, y: ${anchor.y} }（画布比例）`);
console.log(`箭矢：裁到 ${bbR.w}x${bbR.h}（原 ${R.w}x${R.h}）`);
console.log(`\n产物：taoyao_bow_idle.png / taoyao_bow_draw.png / taoyao_arrow.png`);

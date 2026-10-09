// make-sprites.mjs — 把作者给的原图，规整成游戏直接能用的贴图
//
//   node tools/make-sprites.mjs
//
// 规整做两件事，都是"渲染层不方便在运行时做"的：
//
//   ① **对齐**：弓的"平时/拉弓"两张图，画布宽度不一样（拉弓那张多一支箭）。
//      各自居中画的话弓会在两帧之间横跳 (196−116)/2 = 40px，动作直接废掉。
//      所以把两帧按"弓臂对齐"贴到**同一块画布**上，之后运行时换图不会位移。
//      对齐量是**量出来的**：两帧的列不透明度剖面做互相关，
//      排除掉"箭矢所在的那几行"（否则那支横箭会把结果拉偏）。
//
//   ② **定向**：全项目的约定是「**+X（右）就是"前方"**」——
//      渲染层按 atan2(vy,vx) 旋转贴图，所以每张方向性贴图都必须朝右。
//      作者画的时候方向并不统一（实测）：
//        · 映霞[荣] 的箭矢：横的，箭尖朝右        → 不用转
//        · 映霞[枯] 的箭矢：**竖的**，箭尖朝上    → 顺时针 90°
//        · 缇娜的蝙蝠：头在**左**                → 180°
//        · 两枚能量弹：尾迹在左、亮核在右        → 不用转
//      这些角度**在构建时一次性转正**，运行时就不用记"哪张图要额外转几度"——
//      那种"运行时每处都要记得加一个偏移"的约定，迟早会漏。
//      转完还会**验一遍**：方向性贴图的"重的一头/宽的一头"必须落在右半边。
//
// 源图（assets/src/…）→ 产物（assets/characters/…）
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bowFacing } from './lib/bow-facing.mjs';

const GAME = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(GAME, 'assets', 'src');
const OUT = join(GAME, 'assets', 'characters');
await mkdir(OUT, { recursive: true });

const ALPHA_THR = 8;

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

/* 找出"箭矢横穿的那几行"：一行的横向跨度远大于该帧的中位数跨度 */
function arrowRows(im, bb) {
  const spans = [];
  for (let y = bb.t; y <= bb.b; y++) {
    let l = -1, r = -1;
    for (let x = 0; x < im.w; x++) if (at(im, x, y) > 60) { if (l < 0) l = x; r = x; }
    spans.push({ y, span: r < 0 ? 0 : r - l + 1 });
  }
  const med = [...spans.map(s => s.span)].sort((a, b) => a - b)[spans.length >> 1];
  return new Set(spans.filter(s => s.span > med * 1.8).map(s => s.y));
}

/* 列剖面互相关：求把 b 相对 a 横移多少像素时弓臂最吻合 */
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
    if (!best || score < best.score) best = { d, score };
  }
  return best;
}

async function place(im, canvasW, canvasH, ox, oy) {
  const buf = await sharp(Buffer.from(im.data), {
    raw: { width: im.w, height: im.h, channels: im.ch },
  }).png().toBuffer();
  return sharp({
    create: { width: canvasW, height: canvasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite([{ input: buf, left: ox, top: oy }]).png().toBuffer();
}

/* ---------- 方向校验 ----------
   两种判据，按贴图本身选：

   · 'mass'：**重的一头是头**。适合箭矢、能量弹 ——
     箭镞是个实心三角、比箭羽重；能量弹的亮核比尾迹重。转正后重心应落在右半边。

   · 'tipLeft'：**尖的那头是尾**。适合蝙蝠 ——
     它质量的大头是**翅膀**，而翅膀长在身体两侧靠后的位置。
     实测：原图重心偏右（54%），按重心判会得出"已经朝右"的结论，
     但它是**头朝左**的。对蝙蝠该看的是"最尖的那一端（尾尖）在不在左边"。 */
async function checkMass(file) {
  const im = await raw(file);
  const bb = bbox(im);
  const cx = (bb.l + bb.r) / 2;
  let left = 0, right = 0;
  for (let y = bb.t; y <= bb.b; y++) for (let x = bb.l; x <= bb.r; x++) {
    const v = at(im, x, y);
    if (v > ALPHA_THR) { if (x < cx) left += v; else right += v; }
  }
  const ratio = right / (left + right);
  return { ok: ratio >= 0.5, what: '右半边质量占比 ' + (ratio * 100).toFixed(0) + '%' };
}

/** 沿长轴取头尾各 12% 的平均宽度：**左端更窄**才算"尾尖在左" */
async function checkTipLeft(file) {
  const im = await raw(file);
  const bb = bbox(im);
  const band = Math.max(1, Math.round(bb.w * 0.12));
  const widthNear = (fromLeft) => {
    let sum = 0, cnt = 0;
    for (let k = 0; k < band; k++) {
      const x = fromLeft ? bb.l + k : bb.r - k;
      let lo = -1, hi = -1;
      for (let y = bb.t; y <= bb.b; y++) if (at(im, x, y) > ALPHA_THR) { if (lo < 0) lo = y; hi = y; }
      if (hi >= 0) { sum += hi - lo + 1; cnt++; }
    }
    return cnt ? sum / cnt : 0;
  };
  const lw = widthNear(true), rw = widthNear(false);
  return { ok: lw < rw, what: '左端宽 ' + lw.toFixed(0) + ' / 右端宽 ' + rw.toFixed(0) };
}

/* ---------- 弓的朝向：**鼓起的弓臂在弦的哪一侧** ----------
   判据本身在 tools/lib/bow-facing.mjs 里（诊断 tests/diag/bow.mjs 也调它，
   免得两处各写一份启发式、结论悄悄不一样）。这里只负责"按结论修图"。

   为什么值得写这个：作者这轮给的「映霞[枯] 平时」那张是**镜像**的
   （弦在右、弓臂鼓向左），和它自己的「拉弓」那张、以及荣的两张正好相反。
   不修正的话，球一举弓就是反的，一拉弓整把弓还会左右翻个个儿。 */
/** 把一帧弓图**摆正成朝 +X**。朝 −X 就左右镜像过来。
 *  注意镜像 ≠ 转 180°：弓是上下有别的（弓梢、握把装饰），
 *  转 180° 会连上下一起翻掉，镜像才是"作者画反了手"的唯一正确修法。 */
async function faceUpBow(im, label) {
  const f = bowFacing(im);
  if (f.dir === 1) {
    console.log(`  ${label}: 朝 +X ✅  ${f.what}`);
    return im;
  }
  if (f.dir === 0) {
    console.error(`  ✘ ${label}: 朝向判不准（两个信号不一致）—— ${f.what}`);
    console.error('     弓的朝向判不准时**不能猜**：猜错就是整把弓反着画。请人工看一眼这张图。');
    process.exitCode = 1;
    return im;
  }
  const flipped = await raw(await sharp(Buffer.from(im.data), {
    raw: { width: im.w, height: im.h, channels: im.ch },
  }).flop().png().toBuffer());
  const g = bowFacing(flipped);
  console.log(`  ${label}: ⚠️ 原图朝 −X（作者画反了手）→ 自动左右镜像  ` +
    `${g.dir === 1 ? '✅' : '❌'}  ${f.what}  →  ${g.what}`);
  if (g.dir !== 1) {
    console.error(`  ✘ ${label}: 镜像后仍然不是朝 +X —— 判据或图有问题，别照抄下面的数字。`);
    process.exitCode = 1;
  }
  return flipped;
}

/* ---------- ① 弓：两帧各自摆正，再对齐到同一块画布 ---------- */
async function buildBow(name, idleLabel, idleFile, drawFile) {
  /* **先各自摆正，再对齐**：两帧的朝向必须一致，
     否则"对齐"是在把两张反着的图硬凑到一起 —— 那正是修之前的状态。 */
  const A = await faceUpBow(await raw(idleFile), `${name} 平时`);
  const B = await faceUpBow(await raw(drawFile), `${name} 拉弓`);
  const bbA = bbox(A), bbB = bbox(B);
  const al = alignOffset(A, B, arrowRows(B, bbB));
  const drawOx = -al.d;
  const minX = Math.min(0, drawOx);
  const W = Math.max(A.w, drawOx + B.w) - minX;
  const H = Math.max(A.h, B.h);
  await sharp(await place(A, W, H, -minX, 0)).png()
    .toFile(join(OUT, `${name}_idle.png`));
  await sharp(await place(B, W, H, drawOx - minX, 0)).png()
    .toFile(join(OUT, `${name}_draw.png`));

  /* ---------- 把三个几何量**量出来**，不靠人眼试 ---------- */
  /* ① 搭箭那一行：拉弓帧里横向跨度最大的那几行的中点 */
  const rows = [...arrowRows(B, bbB)];
  const arrowCY = rows.length
    ? rows.reduce((a, c) => a + c, 0) / rows.length
    : (bbB.t + bbB.b) / 2;
  /* ② 那支搭好的箭的左右端（在拉弓帧自己的坐标里） */
  let arrowL = B.w, arrowR = -1;
  for (const y of rows.length ? rows : [Math.round(arrowCY)]) {
    for (let x = 0; x < B.w; x++) {
      if (at(B, x, y) > 60) { if (x < arrowL) arrowL = x; if (x > arrowR) arrowR = x; }
    }
  }
  if (arrowR < 0) { arrowL = 0; arrowR = 1; }
  /* 换算到统一画布：拉弓帧贴在 drawOx - minX 处 */
  const arrowLc = arrowL + (drawOx - minX);
  const arrowRc = arrowR + (drawOx - minX);

  const out = {
    canvas: { w: W, h: H },
    /* 球心：平时帧内容的横向中心。
       纵向取"搭箭那一行"—— 球心落在搭箭点上，箭才会从球身上射出去。 */
    anchor: {
      x: +(((bbA.l + bbA.r) / 2 - minX) / W).toFixed(4),
      y: +(arrowCY / H).toFixed(4),
    },
    /* 搭箭节点 = 那支搭好的箭的**箭尾**（左端） */
    nock: { x: +(arrowLc / W).toFixed(4), y: +(arrowCY / H).toFixed(4) },
    /* 箭长占弓高的比例 —— 画在地上的箭与飞出去的箭共用它 */
    arrowLenFrac: +((arrowRc - arrowLc) / H).toFixed(4),
  };
  console.log(`  ${name}: 对齐偏移 ${al.d}px → 画布 ${W}x${H}`);
  console.log(`      anchor = { x: ${out.anchor.x}, y: ${out.anchor.y} }  ` +
    `nock = { x: ${out.nock.x}, y: ${out.nock.y} }  arrowLenFrac = ${out.arrowLenFrac}`);
  console.log(`      （搭箭那一行在拉弓帧 y=${Math.round(arrowCY)}，箭跨 x=${arrowL}..${arrowR}）`);
  return out;
}

/* ---------- ② 方向性贴图：转到"+X = 前方"，然后验证 ---------- */
async function buildDirectional(srcFile, outFile, rotateDeg, label, mode = 'mass') {
  const probe = mode === 'tipLeft' ? checkTipLeft : checkMass;
  const before = await probe(srcFile);
  const buf = await sharp(srcFile)
    .rotate(rotateDeg, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .trim({ threshold: 1 })
    .png().toBuffer();
  await sharp(buf).png().toFile(outFile);
  const after = await probe(outFile);
  const ok = after.ok ? '✅' : '❌';
  console.log('  ' + label + ': 转 ' + rotateDeg + '°  ' + ok + '  转前 ' + before.what + ' → 转后 ' + after.what);
  if (!after.ok) {
    console.error('     ✘ ' + label + ' 转完仍然不是朝右（' + after.what + '）—— 方向判断错了，检查 rotateDeg。');
    process.exitCode = 1;
  }
}

console.log('【弓 · 两帧各自摆正 → 对齐 + 几何量测算】');
const bows = {};
bows.rong = await buildBow('taoyao_bow', '映霞[荣]', join(SRC, 'taoyao/bow_idle.png'), join(SRC, 'taoyao/bow_draw.png'));
bows.ku = await buildBow('taoyao_ku_bow', '映霞[枯]', join(SRC, 'taoyao/ku_bow_idle.png'), join(SRC, 'taoyao/ku_bow_draw.png'));
/* 自检：荣 的那组值早就人眼调好并写进了 balls.js，算出来的应当基本一致。
   容差按量分别给 —— nock.x 天生更"糊"：
   它取的是那支搭好的箭最左端的像素，而箭有一圈辉光，
   把 41 行并起来取并集（本脚本）会比单看一行（当初人眼量的）宽几个像素。
   这几个像素在 196 宽的画布上是 1.5%，视觉上看不出来，不值得为它判失败。 */
const KNOWN = { anchorX: 0.426, nockX: 0.0204, arrowLenFrac: 0.335 };
const dAnchor = Math.abs(bows.rong.anchor.x - KNOWN.anchorX);
const dNock = Math.abs(bows.rong.nock.x - KNOWN.nockX);
const dLen = Math.abs(bows.rong.arrowLenFrac - KNOWN.arrowLenFrac);
const ok = dAnchor <= 0.02 && dNock <= 0.04 && dLen <= 0.02;
console.log(`\n  自检（对照人眼调好的荣）：` +
  `anchor.x 差 ${dAnchor.toFixed(4)}（容差 0.02）、` +
  `nock.x 差 ${dNock.toFixed(4)}（容差 0.04）、` +
  `arrowLenFrac 差 ${dLen.toFixed(4)}（容差 0.02） → ${ok ? '✅ 一致' : '❌ 不一致'}`);
if (!ok) {
  console.error('  ✘ 测算结果与已知良好值差太多 —— 测算法可能有问题，先别照抄。');
  process.exitCode = 1;
}

console.log('\n【方向性贴图 · 一律转成"朝右(+X)"】');
await buildDirectional(join(SRC, 'taoyao/arrow.png'), join(OUT, 'taoyao_arrow.png'), 0, '映霞[荣] 箭矢');
await buildDirectional(join(SRC, 'taoyao/ku_arrow_raw.png'), join(OUT, 'taoyao_ku_arrow.png'), 90, '映霞[枯] 箭矢（原图朝上）');
await buildDirectional(join(SRC, 'yuncai/bolt_raw.png'), join(OUT, 'yuncai_bolt.png'), 0, '晕彩 能量弹');
await buildDirectional(join(SRC, 'tina/bolt_raw.png'), join(OUT, 'tina_bolt.png'), 0, '缇娜 能量弹');
/* 蝙蝠用"尾尖在左"判据：它的重心被翅膀带偏，用重心判会得出相反的结论 */
await buildDirectional(join(SRC, 'tina/bat_raw.png'), join(OUT, 'tina_bat.png'), 180, '缇娜 蝙蝠（原图头朝左）', 'tipLeft');

console.log('\n产物都在 assets/characters/');

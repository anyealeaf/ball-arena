// preview-bow.mjs — 把"球 + 弓 + 箭"的合成结果画成一张预览图
//
//   node tools/preview-bow.mjs
//
// 为什么需要它：弓画在球**外面**，锚点/大小对不对，光看数字没有把握
// （数字全对但看起来歪是常事）。这个脚本用和 render.js 的 _bow()
// **同一套算法**把结果拼出来，改完 balls.js 里的 anchor / bowH
// 立刻能看效果，不用开浏览器、也不用打完一局。
//
// 版式：横排若干列，列底标注该列的状态与瞄准角。
import sharp from 'sharp';
import { SPECIES_BY_ID } from '../js/balls.js';

const SP = SPECIES_BY_ID.taoyao;
const BOW = SP.bow;
const BALL_R = SP.r;

const CASES = [
  { state: 'idle', aim: 0, note: '平时' },
  { state: 'draw', aim: 0, note: '拉弓' },
  { state: 'shot', aim: 0, note: '射箭那一帧' },
  { state: 'burst', aim: 0, note: '五连发' },
  { state: 'draw', aim: 90, note: '拉弓·朝下' },
  { state: 'burst', aim: 200, note: '五连发·朝左上' },
];

const PX = 2.6;                  // 每个世界单位画多少像素
const PAD = 16, LABEL = 30;
const cell = Math.ceil(2 * BOW.bowH * PX) + PAD * 2;
const W = cell * CASES.length, CH = cell + LABEL;

/* 把一张图旋转 angleDeg 后，让它内部的"锚点"落在球心上。
   做法：先把原图放到一块方形画布上、让锚点落在画布正中，
   于是"绕锚点转"就等价于"绕画布中心转"，sharp 的 rotate 可以直接用
   —— 这与 render.js 里 translate(球心) → rotate → drawImage(−锚点) 等价。 */
async function rotAbout(file, axF, ayF, angleDeg, drawH) {
  const m = await sharp(file).metadata();
  const ax = axF * m.width, ay = ayF * m.height;
  const S = 2 * Math.ceil(Math.max(ax, m.width - ax, ay, m.height - ay));
  const sq = await sharp({
    create: { width: S, height: S, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite([{
    input: await sharp(file).png().toBuffer(),
    left: Math.round(S / 2 - ax), top: Math.round(S / 2 - ay),
  }]).png().toBuffer();
  const rot = await sharp(sq)
    .rotate(angleDeg, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const k = (drawH * PX) / m.height;
  const side = Math.max(1, Math.round(S * k));
  return sharp(rot).resize(side, side, { fit: 'fill' }).png().toBuffer();
}

/* 把箭图旋转 angleDeg，让**箭尾**（左边缘中点）落在 (tx, ty)。
   原图中心在箭尾右侧 W/2 处，绕中心转 θ 后该向量是 (W/2·cosθ, W/2·sinθ)。 */
async function arrowAt(file, angleDeg, lenPx, tx, ty) {
  const m = await sharp(file).metadata();
  const h = Math.max(2, Math.round(m.height * (lenPx / m.width)));
  const scaled = await sharp(file).resize(Math.round(lenPx), h, { fit: 'fill' }).png().toBuffer();
  const rot = await sharp(scaled)
    .rotate(angleDeg, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const rm = await sharp(rot).metadata();
  const th = (angleDeg * Math.PI) / 180;
  return {
    input: rot,
    left: Math.round(tx + Math.cos(th) * (lenPx / 2) - rm.width / 2),
    top: Math.round(ty + Math.sin(th) * (lenPx / 2) - rm.height / 2),
  };
}

const ballPx = Math.round(2 * BALL_R * PX);
const ballImg = await sharp(SP.sticker.src).resize(ballPx, ballPx).png().toBuffer();

/* 搭箭节点相对球心的偏移（像素）：由锚点与 nock 的差算出来 */
const bm = await sharp(BOW.draw).metadata();
const upp = BOW.bowH / bm.height;               // 世界单位 / 原图像素
const drawW = BOW.bowH * (bm.width / bm.height);
const nockLocal = {
  x: (BOW.nock.x - BOW.anchor.x) * drawW * PX,
  y: (BOW.nock.y - BOW.anchor.y) * BOW.bowH * PX,
};
const arrowLenPx = BOW.arrowLenFrac * BOW.bowH * PX;

const composites = [];
for (let i = 0; i < CASES.length; i++) {
  const c = CASES[i];
  const cx = i * cell + cell / 2, cy = cell / 2;
  const th = (c.aim * Math.PI) / 180;

  /* 1) 弓：平时与"射箭那一帧"都用 idle，拉弓与五连发用 draw
        （shot 在 render.js 里留 null = 回退成 idle，这里显式演示同一件事） */
  const useIdle = c.state === 'idle' || c.state === 'shot';
  composites.push({
    input: await rotAbout(useIdle ? BOW.idle : BOW.draw,
      BOW.anchor.x, BOW.anchor.y, c.aim, BOW.bowH),
    left: Math.round(cx - (BOW.bowH * PX) / 2),
    top: Math.round(cy - (BOW.bowH * PX) / 2),
  });

  /* 2) 五连发：在搭箭节点扇形多排四根箭（跟着弓一起转，所以用弓的局部方向） */
  if (c.state === 'burst') {
    const nx = cx + (nockLocal.x * Math.cos(th) - nockLocal.y * Math.sin(th));
    const ny = cy + (nockLocal.x * Math.sin(th) + nockLocal.y * Math.cos(th));
    const n = BOW.burst.extra;
    for (let k = 0; k < n; k++) {
      const off = ((k + 1) / (n + 1) * 2 - 1) * BOW.burst.spreadDeg;
      composites.push(await arrowAt(BOW.arrow, c.aim + off, arrowLenPx, nx, ny));
    }
  }

  /* 3) 球画在最上面 —— 与 render.js 的图层顺序一致（球要盖住弓的中间） */
  composites.push({ input: ballImg, left: Math.round(cx - ballPx / 2), top: Math.round(cy - ballPx / 2) });

  composites.push({
    input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${LABEL}">` +
      `<text x="${cell / 2}" y="20" font-size="15" fill="#cbd5e1" text-anchor="middle" ` +
      `font-family="sans-serif">${c.note} · aim ${c.aim}°</text></svg>`),
    left: i * cell, top: cell,
  });
}

const out = 'tools/preview-bow.png';
await sharp({
  create: { width: W, height: CH, channels: 4, background: { r: 15, g: 18, b: 26, alpha: 1 } },
}).composite(composites).png().toFile(out);

console.log(`已生成 ${out}  ${W}x${CH}`);
console.log(`球半径 ${BALL_R} / 弓高 ${BOW.bowH} / 锚点 (${BOW.anchor.x}, ${BOW.anchor.y})`);
console.log(`弓宽 ${drawW.toFixed(1)}（原图 1 世界单位 = ${(1 / upp).toFixed(1)} 像素）`);
console.log(`搭箭节点 (${BOW.nock.x}, ${BOW.nock.y}) / 箭长 ${(BOW.arrowLenFrac * BOW.bowH).toFixed(1)}`);
console.log(`五连发：额外 ${BOW.burst.extra} 根，扇形 ±${BOW.burst.spreadDeg}°`);

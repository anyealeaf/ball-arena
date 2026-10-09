// preview-bloom.mjs — 把「开华」那一瞬间画成一排定格，看效果
//
//   node tools/preview-bloom.mjs        → tools/preview-bloom.png
//
// 为什么需要它：开华只在一局里出现一次、而且是一瞬间的事，
// 想调"够不够显眼"要反复打对局。这里把爆发过程按时间切成 6 格并排画出来，
// 每格标注**屏幕抖动的位移**（抖动本身是动态的，静帧只能看数值）。
//
// 几何**调的是 render.js 导出的 bloomBurstSpec()** —— 和游戏里画的是同一份公式，
// 所以预览不会和实际效果漂（本项目在"五连发扇形"上吃过一次亏：
// 预览画 14°、真正飞出去 24°）。
import sharp from 'sharp';
import { SPECIES_BY_ID } from '../js/balls.js';
import {
  bloomBurstSpec, BLOOM_LIFE, BLOOM_GLOW_ALPHA, BLOOM_ARC_ALPHA,
  SHAKE_MAX, SHAKE_FRAMES, SHAKE_HZ
} from '../js/render.js';

const SP = SPECIES_BY_ID.yuncai;
/* 格子必须装得下**最大的那一环**：bloomBurstSpec 里最外环半径最大
   12 + 2*9 + 58 = 88 世界单位，再留光晕的余量。
   踩过的坑：一开始格子只有 280px（只能看到 30 单位半径），后三格的
   光环已经扩到格子外面去了，图上看着像"特效提前没了"——那是被裁掉的。
   PX 就是这么反推出来的：(CELL/2 - PAD) / 92。 */
const CELL = 440, PAD = 10, LABEL = 30;
const PX = (CELL / 2 - PAD) / 92;     // 每个世界单位多少像素（最外环 ~88 单位）
const BALL_PX = Math.round(SP.r * 2 * PX);
const PAPER = { r: 253, g: 252, b: 247, alpha: 1 };
const INK = '#5b5546';

/* 抖动位移：和 render.js 的 _screenShake 同一条公式（帧号驱动、平方衰减） */
function shakeAt(ageFrames) {
  if (ageFrames < 0 || ageFrames > SHAKE_FRAMES) return { x: 0, y: 0, amp: 0 };
  const k = 1 - ageFrames / SHAKE_FRAMES;
  const amp = k * k;
  const ph = (ageFrames / 60) * SHAKE_HZ * Math.PI * 2;
  return { x: Math.sin(ph) * SHAKE_MAX * amp, y: Math.cos(ph * 1.37) * SHAKE_MAX * 0.7 * amp, amp };
}

const ballImg = await sharp(SP.stickerBloom.src).resize(BALL_PX, BALL_PX).png().toBuffer();
/* 常驻光晕：和 _units 里那层径向柔光同一个比例（r+14） */
const GLOW_R = Math.round((SP.r + 14) * PX);

const FRAMES = [0, 4, 9, 15, 22, 33];      // 爆发后第 N 帧（BLOOM_LIFE = 34）
const cells = [];
for (let c = 0; c < FRAMES.length; c++) {
  const age = FRAMES[c];
  const t = age / BLOOM_LIFE;
  const fade = 1 - t;                    // _events 里的整体淡出
  const spec = bloomBurstSpec(t);
  const sh = shakeAt(age);
  const cx = PAD + CELL / 2, cy = PAD + CELL / 2 + 6;

  /* 常驻形态光晕（开华之后的每一帧都有） */
  const glow = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL}" height="${CELL}">` +
    `<defs><radialGradient id="g${c}">` +
    `<stop offset="0" stop-color="#a78bfa" stop-opacity="${BLOOM_GLOW_ALPHA}"/>` +
    `<stop offset="0.55" stop-color="#7dd3fc" stop-opacity="${(BLOOM_GLOW_ALPHA * 0.45).toFixed(3)}"/>` +
    `<stop offset="1" stop-color="#a78bfa" stop-opacity="0"/>` +
    `</radialGradient></defs>` +
    `<circle cx="${cx}" cy="${cy}" r="${GLOW_R}" fill="url(#g${c})"/></svg>`);

  /* 爆发：闪光 + 放射线 + 三层光环（几何来自 bloomBurstSpec）。
     注意 svg 变量这里**不含收尾标签**，下面要拿它拼两份图（球下面一份、球上面一份）。 */
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL}" height="${CELL}">`;
  if (spec.flash) {
    svg += `<defs><radialGradient id="f${c}">` +
      `<stop offset="0" stop-color="#ffffff" stop-opacity="${spec.flash.alpha.toFixed(3)}"/>` +
      `<stop offset="0.4" stop-color="#c4b5fd" stop-opacity="${(spec.flash.alpha * 0.7).toFixed(3)}"/>` +
      `<stop offset="1" stop-color="#a78bfa" stop-opacity="0"/>` +
      `</radialGradient></defs>` +
      `<circle cx="${cx}" cy="${cy}" r="${(spec.flash.r * PX).toFixed(1)}" fill="url(#f${c})"/>`;
  }
  for (const ray of spec.rays) {
    const x0 = cx + Math.cos(ray.a) * ray.r0 * PX, y0 = cy + Math.sin(ray.a) * ray.r0 * PX;
    const x1 = cx + Math.cos(ray.a) * ray.r1 * PX, y1 = cy + Math.sin(ray.a) * ray.r1 * PX;
    svg += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"` +
      ` stroke="#f5d0fe" stroke-width="2" opacity="${(fade * 0.75).toFixed(3)}"/>`;
  }
  for (const ring of spec.rings) {
    svg += `<circle cx="${cx}" cy="${cy}" r="${(ring.r * PX).toFixed(1)}" fill="none"` +
      ` stroke="${ring.color}" stroke-width="${(ring.lw * PX).toFixed(2)}"` +
      ` opacity="${(fade * ring.alpha).toFixed(3)}"/>`;
  }
  const burstSvg = Buffer.from(svg + '</svg>');

  const cell = await sharp({ create: { width: CELL, height: CELL, channels: 4, background: PAPER } })
    .composite([
      { input: glow, left: 0, top: 0 },
      { input: ballImg, left: Math.round(cx - BALL_PX / 2), top: Math.round(cy - BALL_PX / 2) },
      /* 真实的绘制顺序是"球 → 事件特效"，所以爆发画在球上面 */
      { input: burstSvg, left: 0, top: 0 },
    ]).png().toBuffer();
  cells.push({ input: cell, left: c * CELL, top: 0 });

  const note = `+${age} 帧（t=${(t * 100).toFixed(0)}%）　最外环 R=${spec.rings[2].r.toFixed(0)} 单位` +
    `　抖动 (${sh.x.toFixed(1)}, ${sh.y.toFixed(1)})`;
  cells.push({
    input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL}" height="${LABEL}">` +
      `<text x="${CELL / 2}" y="20" font-size="15" fill="${INK}" text-anchor="middle" ` +
      `font-family="sans-serif">${note}</text></svg>`),
    left: c * CELL, top: CELL
  });
}

const W = CELL * FRAMES.length, H = CELL + LABEL;
const out = 'tools/preview-bloom.png';
await sharp({ create: { width: W, height: H, channels: 4, background: PAPER } })
  .composite(cells).png().toFile(out);

console.log(`已生成 ${out}  ${W}x${H}`);
console.log(`爆发持续 ${BLOOM_LIFE} 帧（${(BLOOM_LIFE / 60).toFixed(2)} 秒），普通事件是 22 帧`);
console.log(`屏幕抖动：最大位移 ${SHAKE_MAX} 世界单位、持续 ${SHAKE_FRAMES} 帧、频率 ${SHAKE_HZ}Hz`);
console.log('（抖动是动态的，图上只标出那一帧的位移数值；球直径 = ' + (SP.r * 2) + ' 世界单位，可当尺子）');

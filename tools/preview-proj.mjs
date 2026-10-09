// preview-proj.mjs — 把"飞在空中的贴图弹道"画成一张预览图
//
//   node tools/preview-proj.mjs        → tools/preview-proj.png
//
// 为什么需要它：弹道贴图有三个只能靠眼睛判的事 ——
//   ① **大小**：图里的亮核和判定圆是不是差不多大？（图比判定小 = "看着没碰到却掉血"；
//      图比判定大一个数量级 = "明明看着打到了却没伤害"。）
//   ② **方向**：图是不是朝着飞行方向？方向由两个环节保证
//      （构建时转成 +X：tools/make-sprites.mjs；运行时按 atan2 转：render.js），
//      但那是两段逻辑，人眼过一遍四方向最省事。
//   ③ **光效**：外边那圈对应颜色的柔光够不够、会不会太糊 —— 这条只能看。
//
// 每格画：**光晕 + 真图**（按配置的 spriteLen 缩放、按飞行方向旋转）
//         ＋ **判定圆** ＋ 一条飞行方向箭头。
// 光晕的比例、峰值不透明度、图的透明度都**照抄 render.js 的那几个常量**
// （下面 GLOW_*/ALPHA_*），数字来源是真实对局跑出来的调色板，不是另抄配置。
//
// **背景用游戏里那个颜色**（浅色方格纸 #fdfcf7）：光晕是半透明的，
// 在深色背景上好看不代表在白纸上好看 —— 之前这张预览用深色背景，那是个错的参照系。
//
// 版式：一行 = 一张贴图，一列 = 一个飞行方向（0° / 90° / 180° / 270°）。
import sharp from 'sharp';
/* 诊断夹具（测试球）—— 它们已经不在游戏球种里了，要用就显式 import */
import '../tests/lib/test-balls.mjs';
import { Battle } from '../js/core.js';
import { ARENA_BY_ID } from '../js/arenas.js';
import { DEFAULT_RULES, SPECIES, makeUnitStats } from '../js/balls.js';

/* 与 render.js 保持一致 */
const GLOW_RX = 0.55, GLOW_RY = 0.95, GLOW_ALPHA = 0.30, GLOW_FLOOR = 0.45;
const ALPHA_MIN = 0.25, ALPHA_MAX = 0.40;   // 呼吸区间（只对配了 spritePulse 的弹道生效）
const GLOW_STOP_MID = 0.55;               // 中段色标的位置（同 render.js）
const PAPER = { r: 253, g: 252, b: 247, alpha: 1 };   // = render.js 的 _bg 底色
const INK = '#5b5546';                    // 白纸上的字色

/* ---------- 1. 跑对局，收集"每张贴图长什么样" ---------- */
const RUNS = [];
for (const sp of SPECIES) {
  if (sp.skills && sp.skills.length) RUNS.push({ id: sp.id, name: sp.name, skills: sp.skills });
}
RUNS.push({ id: 'taoyao', name: '桃夭·枯', skills: ['taoyao_ku', 'taoyao_aim'] });

const found = new Map();     // src → { len, r, glow, where }
for (const run of RUNS) {
  const stats = (id, sk) => ({ ...makeUnitStats(id), skills: sk });
  let b = null;
  try {
    b = new Battle({
      teams: [
        { units: [{ stats: stats(run.id, run.skills) }] },
        /* 对手用诊断夹具里的"测试球"：它只是站着挨打的靶子角色，
           换成正式角色会让这一局多出一堆不属于本次预览的弹道。
           （夹具那几个球已经不在游戏里了，所以这里显式 import 一下。） */
        { units: [{ stats: stats('test', []) }] },
      ],
      arena: ARENA_BY_ID.rect, sizeScale: 1,
      rules: { ...DEFAULT_RULES, timeLimit: 6 }, seed: 11,
    });
  } catch { continue; }
  b.runToEnd();
  const pal = b.projSpritePalette || [];
  for (const s of b.snapshots) {
    if (!s.proj) continue;
    for (let o = 0; o < s.proj.length; o += 11) {
      const e = pal[s.proj[o + 9]];
      if (!e || !e.src || found.has(e.src)) continue;
      found.set(e.src, { len: e.len, r: s.proj[o + 2], glow: e.glow, pulse: !!e.pulse, where: run.name });
    }
  }
}
if (!found.size) {
  console.error('✘ 一局都没跑出贴图弹道 —— 配置是不是坏了？');
  process.exit(1);
}

/* ---------- 2. 逐张画四方向 ---------- */
const ANGLES = [0, 90, 180, 270];
const CELL = 220;            // 每格边长（像素）
const LABEL = 34;            // 每格下方标注高度
const FIT = 168;             // 图沿飞行方向占多少像素（每张各自缩放，保证看得清）

/* hex → "r,g,b" */
const rgbOf = (hex) => {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  return m ? [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)] : [128, 128, 128];
};

const cells = [];
const rows = [];
let row = 0;
for (const [src, info] of found) {
  const name = src.split('/').pop();
  const K = FIT / info.len;                       // 世界单位 → 像素
  const hitPx = 2 * info.r * K;                   // 判定圆直径（像素）
  const imgPx = await sharp(src).resize(Math.round(FIT), null).png().toBuffer();
  const meta = await sharp(imgPx).metadata();
  const hgtPx = Math.round(FIT * (meta.height / meta.width));
  const b64 = imgPx.toString('base64');
  const [gr, gg, gb] = rgbOf(info.glow);
  /* 透明度照**真实规则**取：配了呼吸的取区间中点（预览是静帧，
     取中间那一档不偏袒最亮或最暗），没配呼吸的就是完全不透明 1.0。 */
  const artA = info.pulse ? (ALPHA_MIN + ALPHA_MAX) / 2 : 1;
  /* 光晕同理：呼吸的取"中点"那一档，不呼吸的恒为峰值 */
  const ga = GLOW_ALPHA * (info.pulse ? (GLOW_FLOOR + (1 - GLOW_FLOOR) * 0.5) : 1);
  rows.push({ name, ...info, hitPx, K, artA });

  for (let c = 0; c < ANGLES.length; c++) {
    const ang = ANGLES[c];
    const lx = CELL / 2, ly = CELL / 2;
    const ox = c * CELL, oy = row * (CELL + LABEL);
    const rad = (ang * Math.PI) / 180;

    /* 判定圆 + 方向箭头画在图**上面**，"图比判定大多少"才一眼能看出来 */
    const ax = lx + Math.cos(rad) * (CELL / 2 - 8), ay = ly + Math.sin(rad) * (CELL / 2 - 8);
    const bx = lx + Math.cos(rad) * (CELL / 2 - 26), by = ly + Math.sin(rad) * (CELL / 2 - 26);
    /* 光晕是椭圆（贴着图的形状）：半轴按 render.js 的比例算，
       整组再按飞行方向旋转。图用 SVG 的 <image> 贴进来，
       透明度直接写在 opacity 上（等于渲染层的 globalAlpha）。 */
    const cellSvg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `width="${CELL}" height="${CELL}">` +
      `<defs><radialGradient id="glow">` +
      `<stop offset="0" stop-color="rgb(${gr},${gg},${gb})" stop-opacity="${ga.toFixed(3)}"/>` +
      `<stop offset="${GLOW_STOP_MID}" stop-color="rgb(${gr},${gg},${gb})" stop-opacity="${(ga * 0.4).toFixed(3)}"/>` +
      `<stop offset="1" stop-color="rgb(${gr},${gg},${gb})" stop-opacity="0"/>` +
      `</radialGradient></defs>` +
      `<g transform="rotate(${ang} ${lx} ${ly})">` +
      `<ellipse cx="${lx}" cy="${ly}" rx="${(FIT * GLOW_RX).toFixed(1)}" ry="${(hgtPx * GLOW_RY).toFixed(1)}" fill="url(#glow)"/>` +
      `<image x="${(lx - FIT / 2).toFixed(1)}" y="${(ly - hgtPx / 2).toFixed(1)}" ` +
      `width="${FIT}" height="${hgtPx}" opacity="${artA}" ` +
      `xlink:href="data:image/png;base64,${b64}" href="data:image/png;base64,${b64}"/>` +
      `</g>` +
      `<circle cx="${lx}" cy="${ly}" r="${(hitPx / 2).toFixed(1)}" fill="none" ` +
      `stroke="#0e7490" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.85"/>` +
      `<circle cx="${lx}" cy="${ly}" r="1.6" fill="#0e7490"/>` +
      `<line x1="${bx}" y1="${by}" x2="${ax}" y2="${ay}" stroke="#0e7490" stroke-width="2" opacity="0.8"/>` +
      `<circle cx="${ax}" cy="${ay}" r="4" fill="#0e7490" opacity="0.9"/>` +
      `</svg>`);

    cells.push({
      input: await sharp({ create: { width: CELL, height: CELL, channels: 4, background: PAPER } })
        .composite([{ input: cellSvg, left: 0, top: 0 }]).png().toBuffer(),
      left: ox, top: oy,
    });
    if (c === 0) {
      cells.push({
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL * ANGLES.length}" height="${LABEL}">` +
          `<text x="8" y="22" font-size="15" fill="${INK}" font-family="sans-serif">` +
          `${name} · ${info.where} · spriteLen ${info.len.toFixed(1)}` +
          ` · 判定直径 ${(2 * info.r).toFixed(1)}（占图长 ${(hitPx / FIT * 100).toFixed(0)}%）` +
          ` · 光晕 ${info.glow || '无'} · 图透明度 ${(artA * 100).toFixed(0)}%${info.pulse ? '（呼吸 25%~40%）' : '（不呼吸）'}` +
          `</text></svg>`),
        left: ox, top: oy + CELL,
      });
    }
  }
  row++;
}

const W = CELL * ANGLES.length, H = (CELL + LABEL) * row;
const out = 'tools/preview-proj.png';
await sharp({ create: { width: W, height: H, channels: 4, background: PAPER } })
  .composite(cells).png().toFile(out);

console.log(`已生成 ${out}  ${W}x${H}（背景就是游戏里的浅色方格纸 #fdfcf7）`);
for (const r of rows) {
  console.log(`  ${r.name}（${r.where}）：spriteLen ${r.len.toFixed(1)} / 判定直径 ${(2 * r.r).toFixed(1)}` +
    ` → 判定圆占图长 ${(r.hitPx / FIT * 100).toFixed(0)}% / 光晕 ${r.glow || '无'}`);
}
console.log('深青虚线圆 = 判定范围，箭头 = 飞行方向，椭圆软光 = 光效环绕。');
console.log('透明度按真实规则画：配了呼吸的（目前只有蝙蝠）取区间中点，其余一律完全不透明。');

/* 伤害飘字自检（作者 2026-10：「加大加粗伤害文字，改成显眼一些的红色」）
 *
 * 这个环境截不了图，所以这里用一个"记录型 2D 上下文"把每一次
 * fillText / strokeText 连同**当时的样式与变换**一起录下来，再核对：
 *   · 颜色真的是那支显眼红（不是原来的深灰）；
 *   · 字号 / 字重都比原来大（原来 bold 12px）；
 *   · 每个数字先描边后填充（描边是"压在深色球面上也看得清"的关键）；
 *   · 伤害越高字越大（和音效的打击权重是**同一个** hitWeight）；
 *   · 出现那一瞬间会放大，几帧内收回 1.0；
 *   · 真打一局时它确实画在命中点上、并且逐帧往上飘。
 *
 * 用法：node tests/diag/dmg-text.mjs
 */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats } from '../../js/balls.js';
import {
  Renderer, drawDamageNumber,
  DMG_FONT_PX, DMG_WEIGHT, DMG_COLOR, DMG_OUTLINE, DMG_OUTLINE_W,
  DMG_SIZE_GAIN, DMG_POP, DMG_POP_FRAMES, DMG_RISE
} from '../../js/render.js';
/* 伤害权重住在音效那一层（打击音与飘字共用一套刻度） */
import { hitWeight } from '../../js/audio.js';

let pass = 0, fail = 0;
const log = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; log.push(`  ✅ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; log.push(`  ❌ ${name}${detail ? '  — ' + detail : ''}`); }
};

/* ---------- 记录型 2D 上下文（带变换栈与样式快照） ---------- */
function makeCtx() {
  const calls = [];
  const stack = [];
  const tf = { x: 0, y: 0, s: 1 };
  const at = () => ({ x: tf.x, y: tf.y, s: tf.s });
  const noop = (name) => (...a) => { calls.push({ name, a }); };
  const ctx = {
    calls,
    globalAlpha: 1, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    lineCap: 'butt', lineJoin: 'miter', miterLimit: 10, font: '',
    textAlign: 'left', textBaseline: 'alphabetic', lineDashOffset: 0, filter: 'none',
    save() { calls.push({ name: 'save' }); stack.push({ ...tf }); },
    restore() { calls.push({ name: 'restore' }); const s = stack.pop(); if (s) Object.assign(tf, s); },
    translate(x, y) {
      tf.x += x; tf.y += y;
      calls.push({ name: 'translate', a: [x, y], at: at() });
    },
    scale(x, y) { tf.s *= x; calls.push({ name: 'scale', a: [x, y], at: at() }); },
    rotate: noop('rotate'),
    setTransform: noop('setTransform'),
    clearRect: noop('clearRect'),
    beginPath: noop('beginPath'), closePath: noop('closePath'),
    moveTo: noop('moveTo'), lineTo: noop('lineTo'), rect: noop('rect'),
    clip: noop('clip'), fill: noop('fill'), stroke: noop('stroke'),
    fillRect: noop('fillRect'), strokeRect: noop('strokeRect'),
    setLineDash: noop('setLineDash'),
    arc: (x, y, r, a0, a1) => calls.push({ name: 'arc', a: [x, y, r, a0, a1] }),
    ellipse: (x, y, rx, ry) => calls.push({ name: 'ellipse', a: [x, y, rx, ry] }),
    drawImage: noop('drawImage'),
    measureText: (t) => ({ width: String(t).length * 6 }),
    createRadialGradient: () => ({ addColorStop() {} }),
    /* 两个文字入口：连同**当时的样式与当前变换**一起记下来 */
    fillText(t, x, y) {
      calls.push({
        name: 'fillText', t, a: [x, y], at: at(),
        color: ctx.fillStyle, font: ctx.font, alpha: ctx.globalAlpha,
      });
    },
    strokeText(t, x, y) {
      calls.push({
        name: 'strokeText', t, a: [x, y], at: at(),
        color: ctx.strokeStyle, font: ctx.font, alpha: ctx.globalAlpha,
        lineWidth: ctx.lineWidth,
      });
    },
  };
  return ctx;
}
const makeCanvas = (ctx) => ({
  width: 900, height: 550, clientWidth: 900, clientHeight: 550,
  style: {}, parentElement: null, getContext: () => ctx,
});

globalThis.window = { devicePixelRatio: 1 };
globalThis.performance = globalThis.performance || { now: () => 0 };

const mkRenderer = () => {
  const ctx = makeCtx();
  const cv = makeCanvas(ctx);
  cv.parentElement = { clientWidth: 900 };
  const rd = new Renderer(cv);
  rd.showHud = true;
  rd.showDamage = true;
  return { ctx, rd };
};

const mk = (skills, foe = 'test') => new Battle({
  teams: [
    { units: [{ stats: makeUnitStats('yuncai', skills) }] },
    { units: [{ stats: makeUnitStats(foe, []) }] },
  ],
  arena: ARENA_BY_ID.rect,
  sizeScale: 1,
  rules: { ...DEFAULT_RULES, timeLimit: 60 },
  seed: 5,
});

/* 字号（px）与"填充色是不是红"两个常用判断 */
const pxOf = (font) => {
  const m = /(\d+(?:\.\d+)?)px/.exec(String(font));
  return m ? Number(m[1]) : NaN;
};
const weightOf = (font) => {
  const m = /^(\d+)\s/.exec(String(font));
  return m ? Number(m[1]) : NaN;
};
const isRed = (hex) => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex));
  if (!m) return false;
  const [r, g, b] = [1, 2, 3].map(i => parseInt(m[i], 16));
  return r > 150 && r > g * 1.8 && r > b * 1.8;   // 红分量压倒性
};

console.log('=========== 伤害飘字自检 ===========\n');

/* ---------- 1) 样式：更大、更粗、更红、带描边 ---------- */
console.log('【1】样式（更大 / 更粗 / 显眼的红）');
{
  const ctx = makeCtx();
  drawDamageNumber(ctx, '-66', 100, 100, hitWeight(66), 0);
  const fill = ctx.calls.find(c => c.name === 'fillText');
  const stroke = ctx.calls.find(c => c.name === 'strokeText');

  check('数字真的画出来了', !!fill && fill.t === '-66', fill ? fill.t : '没有 fillText');
  check('填充色是鲜红（不是原来的深灰 #1f1c15）',
    isRed(fill.color) && fill.color.toLowerCase() === DMG_COLOR.toLowerCase(),
    fill.color);
  check('字号比原来的 12px 明显大', pxOf(fill.font) >= 17,
    `${pxOf(fill.font).toFixed(1)}px（原来 12px）`);
  check('字重是粗体（≥ 700，原来只是 bold）', weightOf(fill.font) >= 700,
    `weight ${weightOf(fill.font)}`);
  check('先描边再填充（描边必须在下面，否则会被填充盖掉）',
    ctx.calls.indexOf(stroke) < ctx.calls.indexOf(fill),
    `stroke#${ctx.calls.indexOf(stroke)} < fill#${ctx.calls.indexOf(fill)}`);
  check('描边色是浅色（压住深色球面，让红字不糊）',
    String(stroke.color).toLowerCase() === DMG_OUTLINE.toLowerCase(), stroke.color);
  check('描边宽度取的是 DMG_OUTLINE_W',
    Math.abs(stroke.lineWidth - DMG_OUTLINE_W) < 1e-9,
    `${stroke.lineWidth}`);
  check('文字用中心对齐画在锚点上（描边向两边扩，不会偏）',
    ctx.calls.filter(c => c.name === 'fillText').length ===
    ctx.calls.filter(c => c.name === 'translate').length,
    `${ctx.calls.filter(c => c.name === 'translate').length} 次 translate`);
}

/* ---------- 2) 伤害越高字越大（和打击音共用一套权重） ---------- */
console.log('\n【2】伤害 → 字号（与音效同一套权重）');
{
  const sizeFor = (dmg) => {
    const ctx = makeCtx();
    drawDamageNumber(ctx, `-${dmg}`, 0, 0, hitWeight(dmg), 0);
    return pxOf(ctx.calls.find(c => c.name === 'fillText').font);
  };
  const [s66, s200, s400] = [66, 200, 400].map(sizeFor);
  check('伤害越高字越大', s66 < s200 && s200 < s400,
    `66 → ${s66.toFixed(1)}px　200 → ${s200.toFixed(1)}px　400 → ${s400.toFixed(1)}px`);
  check('轻伤害也仍然比原来的 12px 大（不会缩回去）',
    sizeFor(1) > 12 * (1 + DMG_SIZE_GAIN * 0) - 1e-9 && sizeFor(1) >= DMG_FONT_PX - 1e-9,
    `1 伤害 → ${sizeFor(1).toFixed(1)}px`);
  check('幅度受 DMG_SIZE_GAIN 控制（砍到 0 就回到统一字号）', (() => {
    const ctx = makeCtx();
    drawDamageNumber(ctx, '-400', 0, 0, 1, 0, { sizeGain: 0 });
    return Math.abs(pxOf(ctx.calls.find(c => c.name === 'fillText').font) - DMG_FONT_PX) < 1e-9;
  })(), `DMG_SIZE_GAIN = ${DMG_SIZE_GAIN}`);
}

/* ---------- 3) 出现瞬间放大、然后收回 ---------- */
console.log('\n【3】出现瞬间的放大（"打出来"的顿挫感）');
{
  const scaleAt = (age) => {
    const ctx = makeCtx();
    drawDamageNumber(ctx, '-66', 0, 0, 0.5, age);
    const s = ctx.calls.filter(c => c.name === 'scale');
    return s.length ? s[s.length - 1].a[0] : 1;
  };
  const s0 = scaleAt(0), s3 = scaleAt(3), sEnd = scaleAt(DMG_POP_FRAMES), sLater = scaleAt(DMG_POP_FRAMES + 5);
  check('第 0 帧放大到 DMG_POP', Math.abs(s0 - DMG_POP) < 1e-9, `${s0.toFixed(2)}×`);
  check('放大在几帧内收回（不是一直大着）', s3 < s0 && s3 > 1, `第 3 帧 ${s3.toFixed(2)}×`);
  check('到 DMG_POP_FRAMES 帧已恢复 1.0', Math.abs(sEnd - 1) < 1e-9, `${sEnd.toFixed(2)}×`);
  check('之后再也不会放大', Math.abs(sLater - 1) < 1e-9, `${sLater.toFixed(2)}×`);
  check('放大是绕锚点做的（先 translate 再 scale）', (() => {
    const ctx = makeCtx();
    drawDamageNumber(ctx, '-66', 30, 40, 0.5, 0);
    const ti = ctx.calls.findIndex(c => c.name === 'translate');
    const si = ctx.calls.findIndex(c => c.name === 'scale');
    const t = ctx.calls[ti];
    return ti >= 0 && si > ti && Math.abs(t.at.x - 30) < 1e-9 && Math.abs(t.at.y - 40) < 1e-9;
  })(), '缩放中心就是飘字位置');
}

/* ---------- 4) 描边可以关掉 / 血量代价那种冷色也可以走同一条路 ---------- */
console.log('\n【4】同一份函数的其他用法');
{
  const ctx = makeCtx();
  drawDamageNumber(ctx, '-66', 0, 0, 0.5, 0, { outlineW: 0 });
  check('outlineW = 0 时不描边（作者若想要细字）',
    !ctx.calls.some(c => c.name === 'strokeText') && ctx.calls.some(c => c.name === 'fillText'));

  const ctx2 = makeCtx();
  drawDamageNumber(ctx2, '-120', 0, 0, 0, 0, { color: '#7c3aed', outlineW: 2.4, px: 13 });
  const f2 = ctx2.calls.find(c => c.name === 'fillText');
  check('换一个颜色/字号就变成"血量代价"那种小字（伤害飘字仍是红的）',
    !isRed(f2.color) && pxOf(f2.font) < DMG_FONT_PX,
    `${f2.color} / ${pxOf(f2.font)}px`);
}

/* ---------- 5) 真打一局：位置、上升、开关 ---------- */
console.log('\n【5】真对局里真的画在命中点上');
{
  const b = mk(['yuncai_modan', 'yuncai_caiguang', 'yuncai_prism']);
  b.runToEnd();
  const hits = b.events.filter(e => e.type === 'hit' && !e.tick && e.value > 0);
  check('这一局产生了可飘字的命中事件', hits.length > 0, `${hits.length} 次`);

  const { ctx, rd } = mkRenderer();
  /* 找一个"活了几帧就消失"的普通命中（寿命 22 帧），逐帧跟住它 */
  const ev = hits.find(e => e.f + 22 < b.snapshots.length) || hits[0];
  const life = 22;
  const found = [];
  for (let age = 0; age <= life; age++) {
    const f = ev.f + age;
    if (f >= b.snapshots.length) break;
    ctx.calls.length = 0;
    rd.draw(b, f);
    const want = `-${Math.round(ev.value)}`;
    const t = (f - ev.f) / life;
    const wantY = ev.by - 20 - t * DMG_RISE;
    const hit = ctx.calls.find(c => c.name === 'fillText' && c.t === want &&
      Math.abs(c.at.x - ev.bx) < 0.01 && Math.abs(c.at.y - wantY) < 0.01);
    if (hit) found.push({ age, y: hit.at.y, size: pxOf(hit.font) });
  }
  check('每个数字都画在"命中点 + 该帧应有的高度"上',
    found.length >= life - 2, `${found.length}/${life + 1} 帧命中`);
  check('飘字逐帧往上走', found.length > 2 &&
    found.every((p, i) => i === 0 || p.y <= found[i - 1].y + 1e-9),
    found.length ? `${found[0].y.toFixed(1)} → ${found[found.length - 1].y.toFixed(1)}` : '');
  check('上升总距离就是 DMG_RISE',
    found.length > 2 && Math.abs((found[0].y - found[found.length - 1].y) - DMG_RISE) < 0.6,
    `${(found[0].y - found[found.length - 1].y).toFixed(1)} / ${DMG_RISE}`);
  check('同一串数字的字号全程不变（变的是位置和透明度）',
    new Set(found.map(p => p.size.toFixed(3))).size === 1,
    found.length ? `${found[0].size.toFixed(1)}px` : '');

  /* 整局扫一遍：画出来的红字，其字号必须与"那一下的伤害"对得上 */
  let mismatched = 0, reds = 0, pairBad = '';
  const sizeByDmg = new Map();
  for (let f = 0; f < b.snapshots.length; f++) {
    ctx.calls.length = 0;
    rd.draw(b, f);
    for (const c of ctx.calls) {
      if (c.name !== 'fillText' || !isRed(c.color)) continue;
      reds++;
      const dmg = Number(String(c.t).replace('-', ''));
      const want = DMG_FONT_PX * (1 + DMG_SIZE_GAIN * hitWeight(dmg));
      /* 字号是写进 font 字符串的（toFixed(1)），所以容差取最后一位的一半 */
      if (Math.abs(pxOf(c.font) - want) > 0.05) { mismatched++; pairBad = `${c.t} → ${pxOf(c.font)}px`; }
      const prev = sizeByDmg.get(dmg);
      if (prev === undefined) sizeByDmg.set(dmg, pxOf(c.font));
      else if (Math.abs(prev - pxOf(c.font)) > 1e-9) pairBad = pairBad || `同伤害字号不一致：${dmg}`;
    }
  }
  check('整局里所有红色数字都是"伤害飘字"该有的样子', reds > 0 && mismatched === 0,
    `${reds} 个红字，异常 ${mismatched} 个${pairBad ? '（' + pairBad + '）' : ''}`);
  const dmgs = [...sizeByDmg.keys()].sort((a, b2) => a - b2);
  check('不同伤害的字号确实不同（同伤害才相同）', dmgs.length >= 2,
    dmgs.map(d => `${d}:${sizeByDmg.get(d).toFixed(1)}px`).join('　'));

  /* 关掉"伤害数字"开关后就一个字都不该有 */
  rd.showDamage = false;
  let after = 0;
  for (let f = 0; f < Math.min(400, b.snapshots.length); f++) {
    ctx.calls.length = 0;
    rd.draw(b, f);
    after += ctx.calls.filter(c => c.name === 'fillText' && isRed(c.color)).length;
  }
  check('关掉"显示伤害"后一个红字都不画', after === 0, `${after} 个`);
}

/* ---------- 6) 血量代价的小字：紫色、比伤害字小 ---------- */
console.log('\n【6】血量代价（析光）的冷色小字');
{
  const b = mk(['yuncai_xiguang']);
  b.runToEnd();
  const costs = b.events.filter(e => e.type === 'hpCost');
  check('这一局产生了血量代价事件', costs.length > 0, `${costs.length} 次`);

  const { ctx, rd } = mkRenderer();
  let purple = 0, sizeMax = 0;
  for (let f = 0; f < b.snapshots.length; f++) {
    ctx.calls.length = 0;
    rd.draw(b, f);
    for (const c of ctx.calls) {
      if (c.name === 'fillText' && !isRed(c.color) && /^-\d+$/.test(c.t)) {
        purple++; sizeMax = Math.max(sizeMax, pxOf(c.font));
      }
    }
  }
  check('血量代价用的是冷色小字（和伤害的红字区分开）', purple > 0, `${purple} 个`);
  check('它比伤害飘字小（不抢主次的）', sizeMax > 0 && sizeMax < DMG_FONT_PX,
    `${sizeMax.toFixed(1)}px < ${DMG_FONT_PX}px`);
}

console.log('\n' + log.join('\n'));
console.log(`\n=========== 通过 ${pass} 项，失败 ${fail} 项 ===========`);
process.exit(fail ? 1 : 0);

/* 作者给的美术「真的画上屏了吗」自检 —— 弹道贴图版
 *
 * 这一轮作者新放了六张图（两把弓、两支箭、两枚能量弹、一只蝙蝠）。
 * 弓由 bow.mjs 盯着；这个诊断盯**弹道上的贴图**：
 * 一枚弹道只要在配置里挂了 sprite，渲染层就必须
 *   1. 真的把它 drawImage 出来（不是静默退回程序化光点）；
 *   2. 按配置的 spriteLen 画（长度不能靠 r*6 兜底）；
 *   3. 按**飞行方向**旋转（这就是"资源方向问题"的运行时那一半 ——
 *      静态那一半由 tools/make-sprites.mjs 在构建时把所有图转成朝 +X）；
 *   4. 保持原图宽高比（绝不拉伸）；
 *   5. 尺寸落在"看着像那么大"的带内 —— 图明显比判定大一个数量级
 *      或小到看不见，都算配置写错了。
 *
 * **通用**而不是逐个点名：遍历所有球种、把它们所有技能都跑一局，
 * 凡是出现过的贴图弹道都要过这五条。以后新加一张图，这里自动覆盖。
 *
 * 用法：node tests/diag/art-proj.mjs
 */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle, PROJ_STRIDE } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, SPECIES, makeUnitStats } from '../../js/balls.js';
import { preloadProjSprites, preloadStickers, Renderer } from '../../js/render.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/* ---------- 无头环境的桩件（与 bow.mjs / render-yuncai.mjs 同一套）----------
   Renderer 构造时要读 window.devicePixelRatio，贴图加载要靠 Image。
   PNG 的真实宽高从文件头里读：签名 8 字节 + IHDR 长度/类型 8 字节，
   宽高在偏移 16 / 20 —— 这样"宽高比"这条断言量的是磁盘上那张图，
   而不是桩件编出来的 64×64。 */
const DIM = new Map();
function scanDir(dir, depth = 0) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < 1) scanDir(p, depth + 1);
      continue;
    }
    if (!e.name.toLowerCase().endsWith('.png')) continue;
    const buf = readFileSync(p);
    /* 只认真正的 PNG（有些美术是别的格式改了后缀，那种读出来是垃圾值） */
    if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) continue;
    DIM.set(p.replace(/\\/g, '/'), { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
  }
}
scanDir('assets/characters');
scanDir('assets/src');

const images = new Map();
/* 每张图被 new 了几次 —— 用来验"预热有没有真的发生"：
   stickerCache 是模块私有的，但每次首次加载都会 new 一个 FakeImage。 */
const loads = new Map();
class FakeImage {
  constructor() { this._src = ''; this.width = 64; this.height = 64; this.naturalWidth = 64; this.naturalHeight = 64; }
  get src() { return this._src; }
  set src(v) {
    this._src = v;
    const d = DIM.get(v);
    if (d) { this.width = this.naturalWidth = d.w; this.height = this.naturalHeight = d.h; }
    images.set(v, this);
    loads.set(v, (loads.get(v) || 0) + 1);
    if (this.onload) this.onload();
  }
}
globalThis.Image = FakeImage;
globalThis.window = { devicePixelRatio: 1 };
globalThis.performance = globalThis.performance || { now: () => 0 };

let pass = 0, fail = 0;
const log = [];
const warns = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; log.push(`  ✅ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; log.push(`  ❌ ${name}${detail ? '  — ' + detail : ''}`); }
};
/* 软判据：**不影响退出码**，只提示"这是作者可能想调的观感问题"。
   （与 check-sticker.mjs 同一套思路：硬判据守正确性，软判据守观感。） */
const soft = (name, detail) => {
  warns.push(`  ⚠️ ${name}${detail ? '  — ' + detail : ''}`);
};

/* ---------- 记录型 2D 上下文（与 bow.mjs 同一套）---------- */
function makeCtx() {
  const calls = [];
  const ctx = {
    calls,
    globalAlpha: 1, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    lineCap: 'butt', lineDashOffset: 0, font: '', textAlign: 'left',
  };
  let curRot = 0;
  const rotStack = [];
  const rec = (n) => (...a) => {
    if (n === 'save') rotStack.push(curRot);
    if (n === 'restore') curRot = rotStack.pop() ?? 0;
    if (n === 'rotate') curRot += a[0];
    calls.push({ n, a, alpha: ctx.globalAlpha, lw: ctx.lineWidth, rot: curRot });
  };
  for (const n of ['setTransform', 'clearRect', 'save', 'restore', 'scale', 'translate',
    'rotate', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'rect', 'clip', 'fill', 'stroke',
    'fillRect', 'strokeRect', 'fillText', 'strokeText', 'setLineDash', 'drawImage']) {
    ctx[n] = rec(n);
  }
  ctx.measureText = (t) => ({ width: String(t).length * 5 });
  ctx.arc = (x, y, r, a0, a1) => calls.push({ n: 'arc', a: [x, y, r, a0, a1], alpha: ctx.globalAlpha, lw: ctx.lineWidth });
  /* 贴图弹道的"光效环绕"是椭圆（贴着图的形状），所以桩件必须有 ellipse */
  ctx.ellipse = (x, y, rx, ry, rot, a0, a1) =>
    calls.push({ n: 'ellipse', a: [x, y, rx, ry, rot, a0, a1], alpha: ctx.globalAlpha, lw: ctx.lineWidth });
  /* 渐变色标要记下来：光晕用的就是"对应颜色的半透明"，
     所以"颜色对不对"只能从色标上看。 */
  const grad = (kind) => (...a) => {
    calls.push({ n: kind, a, alpha: ctx.globalAlpha, lw: ctx.lineWidth });
    return { addColorStop: (o, c) => calls.push({ n: 'stop', a: [o, c], alpha: ctx.globalAlpha, lw: ctx.lineWidth }) };
  };
  ctx.createRadialGradient = grad('radialGrad');
  ctx.createLinearGradient = grad('linearGrad');
  return ctx;
}
const makeCanvas = (ctx) => ({
  width: 900, height: 550, clientWidth: 900, clientHeight: 550,
  style: {}, parentElement: null, getContext: () => ctx,
});

/* ---------- 要跑的对局 ----------
   每个球种把**所有**技能都装上（互斥组由引擎自己剔除），
   再补一局桃夭专用「映霞[枯]」—— 它和荣互斥，默认装配里选不到，
   但枯那支箭是作者这轮新给的美术，必须单独跑一遍才算覆盖到。 */
const RUNS = [];
for (const sp of SPECIES) {
  if (!sp.skills || !sp.skills.length) continue;
  RUNS.push({ id: sp.id, name: sp.name, skills: sp.skills, tag: `${sp.name}全技能` });
}
RUNS.push({
  id: 'taoyao', name: '桃夭', skills: ['taoyao_ku', 'taoyao_aim'], tag: '桃夭·映霞[枯]'
});
/* 再各来一局"只装一式"：专门用来验**多套弓的美术有没有按 castKind 换**。
   混装一局不行 —— 荣与枯互斥，那局只会剩下一式，就测不到"另一式不会串台"。 */
RUNS.push({ id: 'taoyao', name: '桃夭', skills: ['taoyao_rong'], tag: '桃夭·只装荣' });
RUNS.push({ id: 'taoyao', name: '桃夭', skills: ['taoyao_ku'], tag: '桃夭·只装枯' });

/* ---------- 1. 跑出每一局用到的贴图弹道 ---------- */
/* key = 贴图路径，value = 一条"证据"：哪一局、哪一帧、弹道在快照里的偏移 */
const evidence = new Map();
const speciesInPlay = new Map();   // 预热贴图用
const battles = new Map();         // run.tag → battle（下面还要重画，不重复跑）

function runOnce(run) {
  const stats = (id, sk) => ({ ...makeUnitStats(id), skills: sk });
  const b = new Battle({
    teams: [
      { units: [{ stats: stats(run.id, run.skills) }] },
      { units: [{ stats: stats('test', []) }] },
    ],
    arena: ARENA_BY_ID.rect,
    sizeScale: 1,
    rules: { ...DEFAULT_RULES, timeLimit: 6 },
    seed: 11,
  });
  b.runToEnd();
  return b;
}

for (const run of RUNS) {
  let b = null;
  try {
    b = runOnce(run);
  } catch (e) {
    check(`[${run.tag}] 能开一局`, false, String(e && e.message));
    continue;
  }
  battles.set(run.tag, b);
  speciesInPlay.set(run.id, SPECIES.find(s => s.id === run.id));
  const pal = b.projSpritePalette || [];
  for (const s of b.snapshots) {
    if (!s.proj) continue;
    for (let o = 0; o < s.proj.length; o += PROJ_STRIDE) {
      const idx = s.proj[o + 9];
      if (idx < 0) continue;
      const entry = pal[idx];
      if (!entry || !entry.src) continue;
      if (!evidence.has(entry.src)) {
        evidence.set(entry.src, { run: run.tag, frame: s.f, off: o, len: entry.len });
      }
    }
  }
}
check('跑出了贴图弹道（作者的图确实被技能用上了）', evidence.size > 0,
  [...evidence.keys()].join('、') || '一张都没用到');

/* ---------- 2. 弹道贴图必须在开战前预热（否则首次开火那一帧是空的） ----------
   这一节同时守着 ui-battle.js 里的 `preloadProjSprites(battle)` 那次调用。
   顺序很关键：**必须在任何渲染之前做** —— 渲染会顺带按需加载贴图，
   那就分不清"是预热加载的"还是"画的时候才加载的"了。
   所以这一节紧跟在收集证据之后、渲染之前。 */
{
  const b0 = battles.get(RUNS[0].tag);
  const pal = ((b0 && b0.projSpritePalette) || []).map(e => e.src).filter(Boolean);
  check('整局算完后能拿到本局用到的弹道贴图清单', pal.length > 0, pal.join('、') || '空');

  /* 只按球种配置预热一遍：能看到它**覆盖不到**技能参数里的那几张
     （蝙蝠 / 两枚能量弹）—— 这正是 preloadProjSprites 存在的理由。 */
  const before = new Map(loads);
  preloadStickers([...speciesInPlay.values()]);
  const fromSpecies = new Set([...loads.keys()].filter(k => (loads.get(k) || 0) > (before.get(k) || 0)));
  const uncovered = pal.filter(s => !fromSpecies.has(s));
  check('球种预热确实覆盖不到技能参数里的贴图（所以要单独预热弹道贴图）',
    uncovered.length > 0,
    uncovered.length ? `球种预热没覆盖到：${uncovered.join('、')}` : '全被覆盖了');

  const mid = new Map(loads);
  preloadProjSprites(b0);
  const after = new Set([...loads.keys()].filter(k => (loads.get(k) || 0) > (mid.get(k) || 0)));
  const missing = pal.filter(s => !after.has(s) && !fromSpecies.has(s));
  check('preloadProjSprites 把剩下的弹道贴图都预热了',
    missing.length === 0,
    missing.length ? `没预热到：${missing.join('、')}` : `本轮补预热 ${[...after].join('、') || '（无需补）'}`);
}

/* ---------- 3. 逐张图断言"画对了" ---------- */
const ctx = makeCtx();
const rd = new Renderer(makeCanvas(ctx));

for (const [src, ev] of evidence) {
  const { frame, off, len, run } = ev;
  const bt = battles.get(run);
  const pj = bt.snapshots[frame].proj;
  const dirX = pj[off + 7], dirY = pj[off + 8];
  const r = pj[off + 2];

  /* 先确认这一帧那一枚弹道挂的确实是这张图 ——
     证据是按 (帧, 偏移) 记的，这里回头核对一遍，
     免得偏移算串了却拿另一张图去断言（那样后面每一条都会"恰好通过"）。 */
  const palEntry = (bt.projSpritePalette || [])[pj[off + 9]];
  check(`[${src}] 快照里的贴图下标指回这张图`, !!palEntry && palEntry.src === src,
    palEntry ? palEntry.src : '无');

  ctx.calls.length = 0;
  rd.draw(bt, frame);
  /* 记下每次 drawImage 在调用序列里的**下标** —— 后面要靠它把
     "这一枚弹道自己的光晕"从同一帧里别的弹道中间切出来。 */
  const drawn = [];
  ctx.calls.forEach((c, i) => {
    if (c.n === 'drawImage' && c.a[0] && String(c.a[0].src) === src) drawn.push(Object.assign({}, c, { i }));
  });
  check(`[${src}] 上了画布（drawImage 的就是这张图）`, drawn.length > 0,
    `${run} 第 ${frame} 帧，${drawn.length} 次`);

  if (!drawn.length) continue;
  const a = drawn[0].a;
  const d = DIM.get(src);
  check(`[${src}] 磁盘上有这张图，能读出真实宽高`, !!d, d ? `${d.w}×${d.h}` : '读不到');
  if (!d) continue;

  /* 画的长度必须**正好**是配置里登记的那个 spriteLen ——
     渲染层在 len<=0 时会退回 r*6，那说明配置漏了尺寸。 */
  check(`[${src}] 按配置的 spriteLen 画（不是 r*6 兜底）`, Math.abs(a[3] - len) < 1e-6,
    `画的 ${a[3].toFixed(2)} vs 配置 ${len.toFixed(2)}`);

  check(`[${src}] 保持原图宽高比（不拉伸）`,
    Math.abs(a[4] / a[3] - d.h / d.w) < 1e-6,
    `画 ${(a[4] / a[3]).toFixed(4)} vs 原图 ${(d.h / d.w).toFixed(4)}`);

  /* 图的中心落在"判定中心 + 配置的偏移"上。
     ⚠ 这条断言原来写的是"图必须正好居中在判定中心"（dx = −图长/2）——
     作者后来要求**判定圆可以拖**（图相对判定中心可以有偏移 `spriteOffX/Y`），
     所以规则升级成带上偏移的版本；偏移为 0 时它等价于原来的居中。 */
  const palOff = palEntry.offX || 0, palOffY = palEntry.offY || 0;
  check(`[${src}] 图按（判定中心 + 偏移）绘制（偏移 0 时即居中）`,
    Math.abs(a[1] - (palOff - a[3] / 2)) < 1e-6 &&
    Math.abs(a[2] - (palOffY - a[4] / 2)) < 1e-6,
    `dx=${a[1].toFixed(2)} dy=${a[2].toFixed(2)}（期望 ${(palOff - a[3] / 2).toFixed(2)} / ${(palOffY - a[4] / 2).toFixed(2)}，本枚偏移 ${palOff}/${palOffY}）`);

  /* 方向：旋转角必须等于这一发弹道自己的 atan2(dirY, dirX)。
     这是"资源方向"的运行时那一半 —— 图朝 +X 是构建时保证的，
     运行时只要照飞行方向转，两头接上才不会出现"倒着飞的箭"。 */
  const wantRot = Math.atan2(dirY, dirX);
  const rotOk = ctx.calls.some(c => c.n === 'rotate' && Math.abs(c.a[0] - wantRot) < 1e-6);
  check(`[${src}] 按飞行方向旋转（dirX/dirY → atan2）`, rotOk,
    `${wantRot.toFixed(4)} 弧度`);

  /* 尺寸带：图的**高度**（垂直于飞行方向的那一边）不该比判定差一个数量级。
     带子给得很宽（0.25~4 倍）—— 它要抓的是"数量级写错"（比如漏了 spriteLen
     退回 r*6，或者长度多写一位），不是审美。
     "图比判定小得多"是**作者明确选过的**（魔弹减半、蝙蝠减到四分之一），
     所以那种情况单独用软判据提示，不让它变红。 */
  const dia = r * 2;
  const ratio = a[4] / dia;
  check(`[${src}] 图上屏的高度与判定直径同量级（0.25~4 倍）`,
    ratio >= 0.25 && ratio <= 4,
    `图高 ${a[4].toFixed(1)} / 判定直径 ${dia.toFixed(1)} = ${ratio.toFixed(2)}×`);
  if (ratio < 0.5) {
    soft(`[${src}] 看到的图比判定范围小得多（${ratio.toFixed(2)}×）`,
      `判定直径 ${dia.toFixed(1)} vs 图上屏高 ${a[4].toFixed(1)} —— 会觉得"没碰到却在掉血"；` +
      `要一致就把判定半径一起改小（那是平衡改动）`);
  } else if (ratio > 2.5) {
    soft(`[${src}] 图比判定大不少（${ratio.toFixed(2)}×）`,
      `快弹 / 长条视觉这么留是常规做法，嫌大就调 spriteLen`);
  }

  /* ---------- 光效环绕 ----------
     ⚠ 一帧里通常同时飞着**好几枚**弹道（蝙蝠 + 霰弹 + 箭…），
     所以不能拿"这一帧所有的渐变/椭圆"去断言 —— 第一版就是这么错的：
     拿蝙蝠那圈的椭圆去比霰弹的尺寸，报出"霰弹的椭圆不对"。
     归属办法：从这枚弹道的 drawImage 往前找，一直到**上一次 drawImage**，
     中间那一段就是它自己的光晕（渲染层正好是"先画光晕、紧接着画图"）。 */
  const own = (() => {
    let start = 0;
    for (let k = drawn[0].i - 1; k >= 0; k--) if (ctx.calls[k].n === 'drawImage') { start = k + 1; break; }
    return ctx.calls.slice(start, drawn[0].i);
  })();
  const stops = own.filter(c => c.n === 'stop').map(c => String(c.a[1]));
  const ell = own.filter(c => c.n === 'ellipse');
  check(`[${src}] 配了光晕颜色（spriteGlow）`, !!palEntry.glow, palEntry.glow || '没配');
  if (palEntry.glow) {
    /* 颜色直接从 hex 拆出来比 —— 光晕画的是 rgba(r,g,b,a)，
       所以"颜色对不对"只能在色标上比。 */
    const m = /^#([0-9a-f]{6})$/i.exec(palEntry.glow);
    const rgb = m
      ? [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)]
      : null;
    check(`[${src}] 光晕用的是配置里那个颜色（只算这一枚自己的光晕）`,
      !!rgb && stops.length > 0 &&
      stops.every(s => s.startsWith(`rgba(${rgb[0]},${rgb[1]},${rgb[2]},`)),
      rgb ? `期望 rgba(${rgb.join(',')},…) ／ 实际 ${stops.slice(0, 2).join(' ')}` : '颜色格式不是 #rrggbb');
    /* 光晕是**贴着图的形状**的椭圆：箭是长条、弹是圆球，用圆会把长箭裹成一大团 */
    check(`[${src}] 光晕是椭圆、而且贴着图的形状（半轴 ≈ 图长×0.55 / 图高×0.95）`,
      ell.length === 1 &&
      Math.abs(ell[0].a[2] - len * 0.55) < 1e-6 &&
      Math.abs(ell[0].a[3] - a[4] * 0.95) < 1e-6,
      ell.length ? `rx=${ell[0].a[2].toFixed(1)}（图长 ${len.toFixed(1)}） ry=${ell[0].a[3].toFixed(1)}（图高 ${a[4].toFixed(1)}）` : `没画椭圆（${ell.length} 个）`);
    /* 光晕峰值不该太强（作者原话："不用做太过强烈"）*/
    const peak = Math.max(...stops.map(s => {
      const mm = /,([0-9.]+)\)$/.exec(s);
      return mm ? Number(mm[1]) : 0;
    }), 0);
    check(`[${src}] 光晕不刺眼（中心不透明度 ≤ 0.45）`, peak > 0 && peak <= 0.45,
      `峰值 ${peak.toFixed(3)}`);
  }

  /* ---------- 透明度：只有配了 spritePulse 的弹道才呼吸 ----------
     作者的规则是"只有蝙蝠有透明度呼吸效果，其他特效均不要"，
     所以这里按**开关**判，不按种类点名：
       · 配了 spritePulse → 图的不透明度必须落在呼吸区间 25%~40% 里；
       · 没配 → 图必须**完全不透明**（1.0），也就是"一动不动"。
     按开关判的好处：以后谁把呼吸加到别的弹道上，这里自动跟着管。 */
  const alpha = drawn[0].alpha;
  if (palEntry.pulse) {
    check(`[${src}] 配了呼吸（spritePulse）→ 图的透明度落在 25%~40%`,
      alpha >= 0.25 - 1e-9 && alpha <= 0.40 + 1e-9, `本帧 ${alpha.toFixed(3)}`);
  } else {
    check(`[${src}] 没配呼吸（spritePulse）→ 图完全不透明（不参与透明度浮动）`,
      Math.abs(alpha - 1) < 1e-9, `本帧 ${alpha.toFixed(3)}`);
  }
  {
    /* 同一帧画两次必须一模一样 —— 相位是拿**帧号**算的，不是墙上时钟。
       用 performance.now() 的话一暂停弹道就继续明暗闪、拖进度条也回不到同一帧。 */
    ctx.calls.length = 0;
    rd.draw(bt, frame);
    const a2 = ctx.calls.find(c => c.n === 'drawImage' && c.a[0] && String(c.a[0].src) === src);
    check(`[${src}] 同一帧重画两次的透明度完全一致（跟着播放头，不跟墙上时钟）`,
      !!a2 && Math.abs(a2.alpha - alpha) < 1e-12,
      a2 ? `${a2.alpha.toFixed(6)} vs ${alpha.toFixed(6)}` : '没画');
  }
}

/* ---------- 4. 多套弓的美术真的按 castKind 换了 ----------
   弓的美术挂在**球种**上（一套球种配多套弓），而"这一发放的是哪一式"
   只有技能知道 —— 它把 castKind 写进快照，渲染层照 balls.js 的 kindArt 表查。
   这条链路一旦搭错，画面上是"放枯的技能、举着荣的粉弓"，
   既不报错也不影响任何数值，只有人盯着看才会发现。
   所以这里跑**只装荣**和**只装枯**两局，逐帧渲染后把画过的贴图收成集合：
   既要求"该出现的出现"，也要求"另一式绝不能出现"。 */
{
  const drawnOf = (tag) => {
    const bt = battles.get(tag);
    const seen = new Set();
    for (let f = 0; f < bt.snapshots.length; f++) {
      ctx.calls.length = 0;
      rd.draw(bt, f);
      for (const c of ctx.calls) {
        if (c.n === 'drawImage' && c.a[0] && c.a[0].src) {
          seen.add(String(c.a[0].src).split('/').pop());
        }
      }
    }
    return seen;
  };
  const rong = drawnOf('桃夭·只装荣');
  const ku = drawnOf('桃夭·只装枯');
  const has = (set, pre) => [...set].filter(s => s.startsWith(pre));

  check('装映霞[荣] 时画的是荣那把粉弓', has(rong, 'taoyao_bow_').length > 0,
    has(rong, 'taoyao_bow_').join('、') || '一张都没画');
  check('装映霞[荣] 时绝不该画出枯那把花枝弓', has(rong, 'taoyao_ku_bow_').length === 0,
    has(rong, 'taoyao_ku_bow_').join('、') || '没有');
  check('装映霞[枯] 时画的是枯那把花枝弓', has(ku, 'taoyao_ku_bow_').length > 0,
    has(ku, 'taoyao_ku_bow_').join('、') || '一张都没画');
  check('装映霞[枯] 时绝不该画出荣那把粉弓（kindArt 查表没串台）',
    has(ku, 'taoyao_bow_').length === 0,
    has(ku, 'taoyao_bow_').join('、') || '没有');
  check('箭矢也跟着换：荣用粉箭、枯用花枝箭',
    rong.has('taoyao_arrow.png') && !rong.has('taoyao_ku_arrow.png') &&
    ku.has('taoyao_ku_arrow.png') && !ku.has('taoyao_arrow.png'),
    `荣局 [${[...rong].filter(s => s.includes('arrow')).join('、') || '无'}] / ` +
    `枯局 [${[...ku].filter(s => s.includes('arrow')).join('、') || '无'}]`);
}

/* ---------- 4. 呼吸**只准蝙蝠有**，别的弹道必须一动不动 ----------
   上面那条只看了**某一帧**：它拦不住"某个弹道也被顺手加上了呼吸"。
   所以这里对每一种弹道扫一段时间，看它的透明度到底是常数还是真的在变：
     · 配了 spritePulse 的（目前只有蝙蝠）→ 必须真的在变，且两头都取到；
     · 其他所有弹道 → 必须**一根直线**（跨帧完全不变）。
   这条比"逐个点名"稳：以后谁把呼吸开到别的弹道上，它立刻红。 */
{
  /* 每种弹道找一个"寿命还长、没在淡出"的样本帧，然后连续扫 240 帧。
     一个 battle 里同时有蝙蝠 / 霰弹 / 魔弹 / 箭，所以直接按贴图分别收集。 */
  const tracks = new Map();      // src → alpha 数组
  const batTag = '缇娜全技能';
  const yunTag = '晕彩全技能';
  const scan = (tag, srcWanted) => {
    const bt = battles.get(tag);
    if (!bt) return;
    for (let f = 1; f < Math.min(300, bt.snapshots.length); f++) {
      const snap = bt.snapshots[f];
      const idx = (bt.projSpritePalette || []).findIndex(e => e.src === srcWanted);
      if (idx < 0) continue;
      let fresh = false;
      for (let o = 0; o < (snap.proj ? snap.proj.length : 0); o += PROJ_STRIDE) {
        if (snap.proj[o + 9] === idx && snap.proj[o + 3] >= 0.3) { fresh = true; break; }
      }
      if (!fresh) continue;
      ctx.calls.length = 0;
      rd.draw(bt, f);
      const draws = ctx.calls.filter(c => c.n === 'drawImage' && c.a[0] && String(c.a[0].src) === srcWanted);
      if (!draws.length) continue;
      const a = draws.reduce((m, c) => (c.alpha > m.alpha ? c : m), draws[0]).alpha;
      if (!tracks.has(srcWanted)) tracks.set(srcWanted, []);
      tracks.get(srcWanted).push(a);
    }
  };
  scan(batTag, 'assets/characters/tina_bat.png');
  scan(batTag, 'assets/characters/tina_bolt.png');
  scan(yunTag, 'assets/characters/yuncai_bolt.png');
  scan('桃夭全技能', 'assets/characters/taoyao_arrow.png');

  const palOf = (src) => (battles.get(batTag) || battles.get(yunTag) || {}).projSpritePalette || [];
  void palOf;

  const bat = tracks.get('assets/characters/tina_bat.png') || [];
  const batLo = Math.min(...bat), batHi = Math.max(...bat);
  check('扫到足够多帧"没在淡出"的蝙蝠用来观察呼吸', bat.length > 60, `${bat.length} 帧`);
  check('蝙蝠的透明度真的浮到了下限（≈25%）', batLo <= 0.255, `最低 ${batLo.toFixed(3)}`);
  check('蝙蝠的透明度真的浮到了上限（≈40%）', batHi >= 0.395, `最高 ${batHi.toFixed(3)}`);
  check('蝙蝠的浮动区间没有越过 25%~40%（淡出的那几帧不算）',
    batLo >= 0.25 - 1e-9 && batHi <= 0.40 + 1e-9, `实际区间 ${batLo.toFixed(3)} ~ ${batHi.toFixed(3)}`);

  /* 其余每一种都必须是常数 1（完全不透明）。注意"常数"要跨帧比，
     不能只比一帧 —— 恒定 0.3 也能通过"落在区间里"这种脆弱判据。 */
  for (const [src, list] of tracks) {
    if (src === 'assets/characters/tina_bat.png') continue;
    const lo = Math.min(...list), hi = Math.max(...list);
    check(`[${src}] 没有呼吸：跨 ${list.length} 帧的透明度恒定不动`,
      list.length > 0 && hi - lo < 1e-12 && Math.abs(lo - 1) < 1e-9,
      `区间 ${lo.toFixed(6)} ~ ${hi.toFixed(6)}`);
  }
  check('扫到的弹道种类够全（蝙蝠 + 其他至少两种）', tracks.size >= 3,
    [...tracks.keys()].map(s => s.split('/').pop()).join('、'));
}

/* ---------- 4. 贴图偏移：图相对判定中心的位置 ----------
   判定中心 = 弹道位置（物理上就是它参与碰撞）。"图偏了"记在
   spriteOffX / spriteOffY（弹道局部坐标：+x 朝前），渲染层要把**图和光晕**
   一起挪 —— 只挪图不挪光晕的话，会出现"光在一个位置、图在另一个位置"。
   编辑器里拖判定圆改的就是这两个数，所以这条链路必须钉死。 */
{
  const modan = (await import('../../js/skills.js')).YUNCAI.modan;
  const src = 'assets/characters/yuncai_bolt.png';
  const OFFS = { x: 7.5, y: -4 };
  const old = { x: modan.spriteOffX, y: modan.spriteOffY };
  modan.spriteOffX = OFFS.x;
  modan.spriteOffY = OFFS.y;

  /* 用同一局的配置重跑一次（种子固定，所以能取到同一帧） */
  const run = RUNS.find(r => r.id === 'yuncai');
  const b = new (await import('../../js/core.js')).Battle({
    teams: [
      { units: [{ stats: { ...makeUnitStats('yuncai'), skills: run.skills } }] },
      { units: [{ stats: makeUnitStats('test') }] },
    ],
    arena: ARENA_BY_ID.rect, sizeScale: 1,
    rules: { ...DEFAULT_RULES, timeLimit: 6 }, seed: 11,
  });
  b.runToEnd();

  /* 找一帧有这枚弹道的 */
  let frame = -1, off = -1;
  for (const s of b.snapshots) {
    if (!s.proj) continue;
    for (let o = 0; o < s.proj.length; o += PROJ_STRIDE) {
      const e = (b.projSpritePalette || [])[s.proj[o + 9]];
      if (e && e.src === src) { frame = s.f; off = o; break; }
    }
    if (frame >= 0) break;
  }
  check('配了偏移的弹道仍然跑得出来（改动没把技能弄坏）', frame >= 0, `第 ${frame} 帧`);

  if (frame >= 0) {
    const pal = b.projSpritePalette[b.snapshots[frame].proj[off + 9]];
    check('偏移被登记进了弹道贴图调色板',
      pal.offX === OFFS.x && pal.offY === OFFS.y,
      `offX=${pal.offX} offY=${pal.offY}`);

    const c2 = makeCtx();
    const r2 = new Renderer(makeCanvas(c2));
    preloadProjSprites(b);
    c2.calls.length = 0;
    r2.draw(b, frame);
    const callIdx = c2.calls.findIndex(c => c.n === 'drawImage' && c.a[0] && String(c.a[0].src) === src);
    const call = callIdx >= 0 ? c2.calls[callIdx] : null;
    const len = pal.len;
    const hgt = len * (278 / 354);      // yuncai_bolt 的真实宽高比
    check('图按（偏移 − 图的一半）绘制（即图的中心落在"判定中心 + 偏移"）',
      !!call &&
      Math.abs(call.a[1] - (OFFS.x - len / 2)) < 1e-6 &&
      Math.abs(call.a[2] - (OFFS.y - hgt / 2)) < 1e-6,
      call ? `dx=${call.a[1].toFixed(2)} dy=${call.a[2].toFixed(2)}（期望 ${(OFFS.x - len / 2).toFixed(2)} / ${(OFFS.y - hgt / 2).toFixed(2)}）` : '没画');

    /* 光晕要跟着一起偏：椭圆圆心必须等于偏移量 */
    let start = 0;
    for (let k = (callIdx < 0 ? 0 : callIdx) - 1; k >= 0; k--) {
      if (c2.calls[k].n === 'drawImage') { start = k + 1; break; }
    }
    const ell = c2.calls.slice(start, callIdx < 0 ? 0 : callIdx).filter(c => c.n === 'ellipse');
    check('光晕跟着图一起偏（否则光会留在一个没东西的地方）',
      ell.length === 1 && Math.abs(ell[0].a[0] - OFFS.x) < 1e-6 && Math.abs(ell[0].a[1] - OFFS.y) < 1e-6,
      ell.length ? `椭圆圆心 (${ell[0].a[0]}, ${ell[0].a[1]})` : '没画椭圆');
  }

  /* 还原：诊断不该改坏后续用例读到的配置 */
  modan.spriteOffX = old.x;
  modan.spriteOffY = old.y;
}

/* ---------- 5. 构建时转正的那份表：五张方向性贴图都在 ---------- */
{
  const want = [
    'assets/characters/taoyao_arrow.png',
    'assets/characters/taoyao_ku_arrow.png',
    'assets/characters/yuncai_bolt.png',
    'assets/characters/tina_bolt.png',
    'assets/characters/tina_bat.png',
  ];
  const got = new Set(evidence.keys());
  const missing = want.filter(w => !got.has(w));
  /* 桃夭的荣 / 枯是互斥的，两局分别覆盖；这里要求两张箭图都出现过 */
  check('五张方向性贴图全部被对局用到并上了屏',
    missing.length === 0,
    missing.length ? `没覆盖到：${missing.join('、')}` : `${got.size} 张`);
}

console.log('\n' + log.join('\n'));
console.log(`\n=========== 通过 ${pass} 项，失败 ${fail} 项 ===========`);
process.exit(fail ? 1 : 0);

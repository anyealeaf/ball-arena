/* 辉光领域（晕彩）· 展开动画自检
 *
 * 这个特效的全部时间信息都从 snap.f 推出来（暂停/拖动进度条必须对得上），
 * 所以断言集中在三件事：
 *   1. 气浪半径随时间铺开，扫到哪领域才在哪可见（裁剪圆半径 = 气浪半径）；
 *   2. 展开完成后背景真的在滚动，而且不受"画多大"影响；
 *   3. 整体不透明度落在作者要的 30%~50%。
 *
 * 用法：node tests/diag/domain.mjs
 */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, SPECIES_BY_ID, makeUnitStats, SCALE } from '../../js/balls.js';

let pass = 0, fail = 0;
const log = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; log.push(`  ✅ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; log.push(`  ❌ ${name}${detail ? '  — ' + detail : ''}`); }
};

/* ---------- 无头环境的桩件（必须在 new Renderer() 之前装好） ---------- */
const DIM = new Map([['assets/characters/yuncai_aurora.jpg', { w: 3360, h: 1440 }]]);
class FakeImage {
  constructor() { this._src = ''; this.width = 64; this.height = 64; this.naturalWidth = 64; this.naturalHeight = 64; }
  get src() { return this._src; }
  set src(v) {
    this._src = v;
    const d = DIM.get(v);
    if (d) { this.width = this.naturalWidth = d.w; this.height = this.naturalHeight = d.h; }
    if (this.onload) this.onload();
  }
}
globalThis.Image = FakeImage;
globalThis.window = { devicePixelRatio: 1 };
globalThis.performance = globalThis.performance || { now: () => 0 };

const { Renderer } = await import('../../js/render.js');

function makeCtx() {
  const calls = [];
  const ctx = {
    calls, globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
    lineCap: 'butt', font: '', textAlign: '', filter: 'none', lineDashOffset: 0,
  };
  let tx = 0, flipped = false;
  const stack = [];
  const rec = (n) => (...a) => {
    if (n === 'save') stack.push({ tx, flipped });
    if (n === 'restore') { const t = stack.pop(); if (t) { tx = t.tx; flipped = t.flipped; } }
    if (n === 'translate') tx += a[0];
    if (n === 'scale') flipped = flipped !== (a[0] < 0);
    calls.push({ n, a, tx, flipped, alpha: ctx.globalAlpha, lw: ctx.lineWidth, stroke: ctx.strokeStyle });
  };
  for (const n of ['setTransform', 'clearRect', 'save', 'restore', 'scale', 'translate',
    'rotate', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'rect', 'clip', 'fill', 'stroke',
    'fillRect', 'strokeRect', 'fillText', 'strokeText', 'setLineDash', 'drawImage']) ctx[n] = rec(n);
  ctx.measureText = (t) => ({ width: String(t).length * 5 });
  ctx.arc = (x, y, r, a0, a1) => calls.push({ n: 'arc', a: [x, y, r, a0, a1], alpha: ctx.globalAlpha, lw: ctx.lineWidth, stroke: ctx.strokeStyle });
  ctx.createRadialGradient = (...a) => { calls.push({ n: 'radialGrad', a }); return { addColorStop: () => {} }; };
  ctx.createLinearGradient = (...a) => { calls.push({ n: 'linearGrad', a }); return { addColorStop: () => {} }; };
  return ctx;
}
const makeCanvas = (ctx) => ({
  width: 900, height: 550, clientWidth: 900, clientHeight: 550,
  style: {}, parentElement: { clientWidth: 900 }, getContext: () => ctx,
});

const mk = (skills, opts = {}) => new Battle({
  teams: [
    { units: [{ stats: { ...makeUnitStats('yuncai'), skills } }] },
    { units: [{ stats: makeUnitStats(opts.foeId || 'test') }] },
  ],
  arena: ARENA_BY_ID[opts.arenaId || 'rect'], sizeScale: 1,
  rules: { ...DEFAULT_RULES, timeLimit: opts.timeLimit ?? 12 },
  seed: opts.seed ?? 7,
});

console.log('=========== 辉光领域 · 展开动画自检 ===========\n');

const CFG = SPECIES_BY_ID.yuncai.domain;

/* ============ 0. 配置 ============ */
console.log('【0】配置与美术');
{
  check('晕彩配了领域背景', !!CFG && !!CFG.src, CFG ? CFG.src : '无');
  check('背景层不透明度在作者要的 30%~50% 之间',
    CFG.opacity >= 0.30 && CFG.opacity <= 0.50, String(CFG.opacity));
  check('展开时长 / 滚动速度都是正数',
    CFG.revealSeconds > 0 && CFG.scrollUnitsPerSec > 0,
    `${CFG.revealSeconds} 秒 / ${CFG.scrollUnitsPerSec} 单位每秒`);
  check('makeUnitStats 带上了领域配置', !!makeUnitStats('yuncai').domain);
  check('别的球种没有领域配置', !makeUnitStats('taoyao').domain);
}

/* ============ 1. 激活时才画，并记下静态量 ============ */
console.log('\n【1】激活与静态量');
{
  const b = mk(['yuncai_domain']);
  check('开局即激活（辉光领域是被动）', b.aurora === true);
  check('记下了激活帧', b.auroraAt === 0, String(b.auroraAt));
  check('记下了气浪中心（= 激活时晕彩的位置，定点坐标）',
    !!b.auroraCenter && Number.isFinite(b.auroraCenter.x) && Number.isFinite(b.auroraCenter.y),
    b.auroraCenter ? `(${b.auroraCenter.x}, ${b.auroraCenter.y})` : '无');
  check('记下了美术配置', !!b.auroraStyle && b.auroraStyle.src === CFG.src);
  /* 中心必须是**固定**的：跟着晕彩跑的话，离她远的那半边永远铺不到 */
  const c0 = { ...b.auroraCenter };
  for (let i = 0; i < 120 && !b.over; i++) b.step();
  check('气浪中心不会跟着晕彩移动',
    b.auroraCenter.x === c0.x && b.auroraCenter.y === c0.y,
    `(${c0.x},${c0.y}) → (${b.auroraCenter.x},${b.auroraCenter.y})`);

  /* 没装领域的球，不该有任何领域层 */
  const b2 = mk(['yuncai_modan']);
  check('没装辉光领域时不画领域层', b2.aurora === false && !b2.auroraStyle);
}

/* ============ 1.5 析光的分身不该把领域关掉 ============ */
console.log('\n【1.5】分身出生后领域仍然在');
{
  /* 踩过的坑：析光的分身也带「辉光领域」（它继承本体的技能），
     于是分身的被动又跑一遍 —— 而早期 _spawnSummon 漏拷了 `domain` 字段，
     分身就把 battle.auroraStyle 覆盖成 null → **整场极光当场消失**，
     同时 auroraAt 被改成"现在"，气浪还会从分身那一侧重放一次。
     这条断言同时守着两件事：分身有自己的 domain、领域层不被重写。 */
  const b = mk(['yuncai_domain', 'yuncai_xiguang'], { timeLimit: 40 });
  const before = { at: b.auroraAt, style: b.auroraStyle };
  check('（前置）开局领域已激活', b.aurora === true && !!b.auroraStyle);

  let summonAt = -1;
  for (let i = 0; i < 60 * 40 && !b.over; i++) {
    b.step();
    if (summonAt < 0) {
      const ev = b.events.find(e => e.type === 'summon');
      if (ev) summonAt = ev.f;
    }
  }
  check('这一局确实召唤出了分身（否则这条测不到东西）', summonAt >= 0,
    summonAt >= 0 ? `第 ${summonAt} 帧` : '没出现 summon 事件');

  const clone = b.units.find(u => u.summoner !== undefined);
  check('分身身上带着领域配置（漏拷的话它会关掉整场极光）',
    !!clone && !!clone.domain && clone.domain.src === CFG.src,
    clone ? String(clone.domain && clone.domain.src) : '没有分身');
  check('分身出生后领域层还在（没被覆盖成 null）',
    !!b.auroraStyle && b.auroraStyle.src === before.style.src,
    b.auroraStyle ? b.auroraStyle.src : 'null');
  check('气浪不会因为分身出生而重放（auroraAt 不变）',
    b.auroraAt === before.at, `${before.at} → ${b.auroraAt}`);
}

/* ============ 2. 展开：气浪半径随时间铺开 ============ */
console.log('\n【2】气浪的展开');
{
  const b = mk(['yuncai_domain']);
  /* 必须先真的把对局跑出来：draw() 取的是 snapshots[min(frame, len-1)]，
     只有 1 张快照的话每一帧都会塌回第 0 帧 —— p 恒为 0、气浪半径恒为 2。
     第一次写这个诊断就栽在这里：7 条断言全红，看起来像"特效没实现"。 */
  b.runToEnd();
  const ctx = makeCtx();
  const rd = new Renderer(makeCanvas(ctx));
  rd.setArena(b.arena, 1);
  const box = rd._arenaBox();
  const c = b.auroraCenter;
  const cx = c.x / SCALE, cy = c.y / SCALE;
  const corner = Math.max(
    Math.hypot(cx - box.minX, cy - box.minY), Math.hypot(cx - box.maxX, cy - box.minY),
    Math.hypot(cx - box.minX, cy - box.maxY), Math.hypot(cx - box.maxX, cy - box.maxY));

  /* 从"画领域层的那次裁剪圆"里读出气浪半径 */
  const waveAt = (frame) => {
    ctx.calls.length = 0;
    rd.draw(b, frame);
    const arcs = ctx.calls.filter(x => x.n === 'arc');
    /* 最大的那个圆就是气浪圆（场地裁剪圆要么更小要么是定点圆） */
    return arcs.length ? Math.max(...arcs.map(x => x.a[2])) : -1;
  };

  const r0 = waveAt(0);
  const rHalf = waveAt(Math.round(CFG.revealSeconds / 2 * 60));
  const rFull = waveAt(Math.round(CFG.revealSeconds * 60) + 2);
  check('开局那一帧气浪半径接近 0', r0 >= 0 && r0 < 20, String(r0.toFixed(1)));
  check('中途气浪铺到一半左右',
    rHalf > corner * 0.3 && rHalf < corner, `${rHalf.toFixed(0)} / 铺满需要 ${corner.toFixed(0)}`);
  check('展开结束时气浪覆盖到最远的角',
    rFull >= corner - 1, `${rFull.toFixed(0)} ≥ ${corner.toFixed(0)}`);
  check('半径单调递增（气浪不会回缩）', r0 < rHalf && rHalf < rFull,
    `${r0.toFixed(0)} → ${rHalf.toFixed(0)} → ${rFull.toFixed(0)}`);
}

/* ============ 3. 不透明度与"不拉伸" ============ */
console.log('\n【3】不透明度与缩放');
{
  const b = mk(['yuncai_domain']);
  /* 必须先真的把对局跑出来：draw() 取的是 snapshots[min(frame, len-1)]，
     只有 1 张快照的话每一帧都会塌回第 0 帧 —— p 恒为 0、气浪半径恒为 2。
     第一次写这个诊断就栽在这里：7 条断言全红，看起来像"特效没实现"。 */
  b.runToEnd();
  const ctx = makeCtx();
  const rd = new Renderer(makeCanvas(ctx));
  rd.setArena(b.arena, 1);
  const box = rd._arenaBox();
  const w = box.maxX - box.minX, h = box.maxY - box.minY;

  const imgAt = (frame) => {
    ctx.calls.length = 0;
    rd.draw(b, frame);
    return ctx.calls.find(x => x.n === 'drawImage' && x.a[0] &&
      String(x.a[0].src).includes('yuncai_aurora'));
  };

  const mid = imgAt(30), done = imgAt(Math.round(CFG.revealSeconds * 60) + 30);
  check('展开过程中就在画背景层（气浪扫到哪画到哪）', !!mid);
  const alpha = done ? done.alpha : -1;
  check('展开完成后稳定在 30%~50%',
    alpha >= 0.30 && alpha <= 0.50, String(alpha));
  if (done) {
    /* drawImage(img, x, y, dw, dh)：高度应等于场地高度，宽度按原图比例 —— 不拉伸 */
    const dw = done.a[3], dh = done.a[4];
    check('按场地高度铺满（竖直方向不裁不留）',
      Math.abs(dh - h) < 1e-6, `dh=${dh} 场地高 ${h}`);
    const wantW = h * (3360 / 1440);
    check('宽度按原图比例算（没有拉伸）',
      Math.abs(dw - wantW) < 1e-6, `${dw.toFixed(1)} vs 原图比例 ${wantW.toFixed(1)}`);
    check('横向溢出（否则没有可滚动的余量）', dw > w,
      `图宽 ${dw.toFixed(0)} > 场地宽 ${w}`);
  }
}

/* ============ 4. 滚动 ============ */
console.log('\n【4】展开后的滚动');
{
  const b = mk(['yuncai_domain']);
  /* 必须先真的把对局跑出来：draw() 取的是 snapshots[min(frame, len-1)]，
     只有 1 张快照的话每一帧都会塌回第 0 帧 —— p 恒为 0、气浪半径恒为 2。
     第一次写这个诊断就栽在这里：7 条断言全红，看起来像"特效没实现"。 */
  b.runToEnd();
  const ctx = makeCtx();
  const rd = new Renderer(makeCanvas(ctx));
  rd.setArena(b.arena, 1);

  /* 每一格在**屏幕坐标**里的左边界。
     镜像格的真实左边界 = 累计平移 − 图宽（它在 translate(x+drawW) 之后
     用 scale(-1,1) 画，画面覆盖 [x, x+drawW]）。 */
  const tilesAt = (frame) => {
    ctx.calls.length = 0;
    rd.draw(b, frame);
    return ctx.calls.filter(x => x.n === 'drawImage' && x.a[0] &&
      String(x.a[0].src).includes('yuncai_aurora')).map(x => {
      const w = x.a[3];
      return { left: x.flipped ? x.tx - w : x.tx + x.a[1], w };
    }).sort((u, v) => u.left - v.left);
  };
  const endF = Math.round(CFG.revealSeconds * 60);
  const a = tilesAt(endF + 10).map(t => t.left), bb = tilesAt(endF + 70).map(t => t.left);
  check('展开完成后背景确实在动', a.length && bb.length && a.join() !== bb.join(),
    `[${a.map(v => v.toFixed(1)).join(', ')}] → [${bb.map(v => v.toFixed(1)).join(', ')}]`);

  const still = tilesAt(endF + 10).map(t => t.left);
  check('同一帧反复渲染完全一致（暂停时冻得住）',
    still.join() === a.join(), '拖动进度条不会跳');

  /* 滚动速度：取"盖住场地中心的那一格"，看它的左边界一秒移动了多少。
     周期是 2×图宽 = 2053 单位，7 单位/秒要 293 秒才绕一圈 —— 战斗远没这么长，
     所以窗口内可以直接按线性比。 */
  const box = rd._arenaBox();
  const midX = (box.minX + box.maxX) / 2;
  const leftAt = (frame) => {
    const t = tilesAt(frame);
    const hit = t.find(x => x.left <= midX && midX < x.left + x.w);
    return hit ? hit.left : (t.length ? t[0].left : null);
  };
  const l1 = leftAt(endF + 10), l2 = leftAt(endF + 70);
  check('背景在移动（同一格的位置变了）', l1 != null && l2 != null && l2 !== l1,
    `${l1} → ${l2}`);
  check('方向是向右（位置随时间增大）', l2 > l1, `${l1.toFixed(1)} → ${l2.toFixed(1)}`);
  check(`速度约 ${CFG.scrollUnitsPerSec} 世界单位/秒`,
    Math.abs((l2 - l1) - CFG.scrollUnitsPerSec) < 0.2,
    `实测 ${(l2 - l1).toFixed(2)} 单位/秒`);

  /* 任何时刻都不能露出空白。
     判据：最左边那格的左边界 ≤ 场地左边，同时最右边那格的右边界 ≥ 场地右边。
     格子是**首尾相接**的（步长正好一格宽），所以这两条够了。
     踩过：一开始写的是"找一格 l ≤ minX 然后要求下一格 ≥ maxX" ——
     那要求的是"这一格自己盖满全场"，而实际上常常是**下一格**在盖。 */
  const gaps = [];
  for (let f = endF; f < endF + 60 * 10; f += 31) {
    const t = tilesAt(f);
    if (!t.length) { gaps.push(f); continue; }
    const covered = t[0].left <= box.minX &&
      (t[t.length - 1].left + t[t.length - 1].w) >= box.maxX;
    if (!covered) gaps.push(f);
  }
  check('任何时刻背景都铺满整块场地（不会露出空白）', gaps.length === 0,
    gaps.length ? `${gaps.length} 帧没铺满` : '全程铺满');
}

/* ============ 5. 气浪环 ============ */
console.log('\n【5】气浪环');
{
  const b = mk(['yuncai_domain']);
  /* 必须先真的把对局跑出来：draw() 取的是 snapshots[min(frame, len-1)]，
     只有 1 张快照的话每一帧都会塌回第 0 帧 —— p 恒为 0、气浪半径恒为 2。
     第一次写这个诊断就栽在这里：7 条断言全红，看起来像"特效没实现"。 */
  b.runToEnd();
  const ctx = makeCtx();
  const rd = new Renderer(makeCanvas(ctx));
  rd.setArena(b.arena, 1);

  const ringAt = (frame) => {
    ctx.calls.length = 0;
    rd.draw(b, frame);
    /* 环：以气浪半径为半径的 stroke，线宽 = ringWidth */
    return ctx.calls.filter(x => x.n === 'stroke' && x.lw > 10);
  };
  const early = ringAt(6), late = ringAt(Math.round(CFG.revealSeconds * 60) + 5);
  check('展开过程中画出了气浪环', early.length > 0, `${early.length} 次描边`);
  check('展开完成后气浪环消失（不再描那么粗的边）', late.length === 0,
    `${late.length} 次`);
  if (early.length) {
    check('环的线宽 = 配置里的 ringWidth',
      Math.abs(early[0].lw - CFG.ringWidth) < 1e-6, String(early[0].lw));
  }
}

/* ============ 6. 兼容性与性能 ============ */
console.log('\n【6】兼容与性能');
{
  const b = mk(['yuncai_domain'], { arenaId: 'circle', timeLimit: 20 });
  b.runToEnd();
  const ctx = makeCtx();
  const rd = new Renderer(makeCanvas(ctx));
  rd.setArena(b.arena, 1);
  let err = null, drawn = 0;
  const t0 = Date.now();
  try {
    for (let f = 0; f < b.snapshots.length; f++) {
      ctx.calls.length = 0;
      rd.draw(b, f);
      drawn += ctx.calls.filter(x => x.n === 'drawImage' && x.a[0] &&
        String(x.a[0].src).includes('yuncai_aurora')).length;
    }
  } catch (e) { err = e; }
  const ms = Date.now() - t0;
  check('圆形场地整局逐帧渲染不报错', !err, err ? err.message : `${b.snapshots.length} 帧 / ${ms} ms`);
  check('背景层确实被反复绘制', drawn > 100, `${drawn} 次`);
  check('整局渲染耗时可接受（< 3 秒）', ms < 3000, `${ms} ms`);
  check('没有任何绘制调用拿到 NaN',
    ctx.calls.every(c => c.a.every(v => typeof v !== 'number' || Number.isFinite(v))));
}

console.log('\n' + log.join('\n'));
console.log(`\n=========== 通过 ${pass} 项，失败 ${fail} 项 ===========`);
process.exit(fail ? 1 : 0);

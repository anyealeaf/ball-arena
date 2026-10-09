/* 晕彩的技能画面真的画出来了吗？
 *
 * 没法截图，所以用记录型 2D 上下文驱动真实 Renderer，
 * 按坐标把绘制调用归属到具体的质点/细线/光门/弹道上，再断言。
 * 重点盯三个最容易"静默失效"的地方：
 *   · 开华后贴图有没有真的换成第二张（画错图不会报错，只会一直用旧图）
 *   · 隐身时有没有真的降透明度
 *   · 长条激光有没有画成拖影（否则高速弹道看起来是一串断点）
 *
 * 用法：node tests/diag/render-yuncai.mjs
 */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle, SNAP_STRIDE, PROJ_STRIDE, FIELD_STRIDE } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, SPECIES_BY_ID, makeUnitStats, SCALE } from '../../js/balls.js';

/* ---------- 假的 Image：设置 src 时同步触发 onload，便于跟踪"画的是哪张图" ---------- */
const images = new Map();
class FakeImage {
  constructor() { this._src = ''; this.width = 533; this.height = 533; this.naturalWidth = 533; this.naturalHeight = 533; }
  get src() { return this._src; }
  set src(v) { this._src = v; images.set(v, this); if (this.onload) this.onload(); }
}
globalThis.Image = FakeImage;
globalThis.window = { devicePixelRatio: 1 };
globalThis.performance = globalThis.performance || { now: () => 0 };

/* ---------- 记录型 2D 上下文 ---------- */
function makeCtx() {
  const calls = [];
  const ctx = {
    calls,
    globalAlpha: 1, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    lineCap: 'butt', lineDashOffset: 0, font: '', textAlign: 'left',
  };
  const rec = (n) => (...a) => { calls.push({ n, a, alpha: ctx.globalAlpha, lw: ctx.lineWidth }); };
  for (const n of ['setTransform', 'clearRect', 'save', 'restore', 'scale', 'translate',
    'rotate', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'rect', 'clip', 'fill', 'stroke',
    'fillRect', 'strokeRect', 'fillText', 'strokeText', 'setLineDash', 'drawImage']) {
    ctx[n] = rec(n);
  }
  /* 血条上要画"当前/上限"，渲染层会用 measureText 决定放不放得下。
     给一个按字数估宽的桩件即可（真实宽度不影响被测逻辑）。 */
  ctx.measureText = (t) => ({ width: String(t).length * 5 });
  ctx.arc = (x, y, r, a0, a1) => calls.push({ n: 'arc', a: [x, y, r, a0, a1], alpha: ctx.globalAlpha, lw: ctx.lineWidth });
  /* 贴图弹道外面那圈光晕是椭圆（贴着图的形状），桩件必须有 */
  ctx.ellipse = (x, y, rx, ry, rot, a0, a1) =>
    calls.push({ n: 'ellipse', a: [x, y, rx, ry, rot, a0, a1], alpha: ctx.globalAlpha, lw: ctx.lineWidth });
  ctx.createRadialGradient = (...a) => {
    calls.push({ n: 'radialGrad', a, alpha: ctx.globalAlpha, lw: ctx.lineWidth });
    return { addColorStop: () => {} };
  };
  ctx.createLinearGradient = (...a) => {
    calls.push({ n: 'linearGrad', a, alpha: ctx.globalAlpha, lw: ctx.lineWidth });
    return { addColorStop: () => {} };
  };
  return ctx;
}
const makeCanvas = (ctx) => ({
  width: 900, height: 550, clientWidth: 900, clientHeight: 550,
  style: {}, parentElement: { clientWidth: 900 }, getContext: () => ctx,
});

const { Renderer } = await import('../../js/render.js');

const Y = SPECIES_BY_ID.yuncai;
function mk(skills, opts = {}) {
  const stats = (id, sk) => ({ ...makeUnitStats(id), skills: sk });
  return new Battle({
    teams: [
      { units: [{ stats: stats('yuncai', skills) }] },
      { units: [{ stats: stats(opts.foeId || 'test', []) }] },
    ],
    arena: ARENA_BY_ID[opts.arenaId || 'rect'],
    sizeScale: opts.sizeScale ?? 1,
    rules: { ...DEFAULT_RULES, speedScale: 1.6, ...(opts.rules || {}) },
    seed: opts.seed ?? 31,
  });
}

let pass = 0, fail = 0;
const log = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; log.push(`  ✅ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; log.push(`  ❌ ${name}${detail ? '  — ' + detail : ''}`); }
};

const near = (a, b, eps = 0.6) => Math.abs(a - b) <= eps;
const at = (c, x, y, eps = 0.6) => near(c.a[0], x, eps) && near(c.a[1], y, eps);

console.log('=========== 晕彩 · 渲染自检 ===========\n');

/* ============ 快照必须逐帧记录场地物件 ============
   这是"细线在开局就凭空出现"那个 bug 的守卫：
   渲染层如果读 battle.fields（最终状态），回放开头就会画出整局的线。
   所以场地物件必须和弹道一样进快照，且"第 N 帧只画第 N 帧存在的那些"。 */
console.log('\n【快照】场地物件逐帧记录');
{
  const b = mk(['yuncai_caiguang'], { rules: { timeLimit: 30 } });
  b.runToEnd();
  const withFields = b.snapshots.filter(s => s.fields && s.fields.length);
  check('快照里带上了场地物件', withFields.length > 0, `${withFields.length} 帧有物件`);

  /* 开局若干帧不该有任何细线（第一个质点都还没落下） */
  const linesIn = (s) => {
    if (!s.fields || !s.fields.length) return 0;
    let n = 0;
    for (let i = 0; i < s.fields.length; i += FIELD_STRIDE) if (s.fields[i + 4] > 0.5 && s.fields[i + 4] < 1.5) n++;
    return n;
  };
  const earlyLines = b.snapshots.slice(0, 30).reduce((a, s) => a + linesIn(s), 0);
  check('开局 30 帧内没有任何细线', earlyLines === 0, `共 ${earlyLines} 条`);

  /* 第 N 帧画出来的线数，必须等于"那一帧快照里的线数" */
  const ctx = makeCtx();
  const rd = new Renderer(makeCanvas(ctx));
  let checked = 0, mismatch = 0;
  for (let f = 0; f < b.snapshots.length; f += 7) {
    const snap = b.snapshots[f];
    const n = linesIn(snap);
    ctx.calls.length = 0;
    rd.draw(b, f);
    /* 数一数画了几条线：细线是 moveTo→lineTo 且线宽 = 2×halfW。
       这里用"以快照端点开头的 moveTo"来数，避免把事件特效算进去。 */
    let drawn = 0;
    if (snap.fields) {
      for (let i = 0; i < snap.fields.length; i += FIELD_STRIDE) {
        if (!(snap.fields[i + 4] > 0.5 && snap.fields[i + 4] < 1.5)) continue;
        const ax = snap.fields[i], ay = snap.fields[i + 1];
        if (ctx.calls.some(c => c.n === 'moveTo' && at(c, ax, ay, 1))) drawn++;
      }
    }
    checked++;
    if (drawn !== n) mismatch++;
  }
  check('每一帧画的线数都等于该帧快照里的线数', mismatch === 0,
    `检查 ${checked} 帧，不符 ${mismatch} 帧`);
}

/* ============ ① 质点与细线 ============ */
console.log('\n【①】质点与细线');
{
  const b = mk(['yuncai_caiguang', 'yuncai_domain'], { rules: { timeLimit: 30 } });
  b.runToEnd();
  const ctx = makeCtx();
  const rd = new Renderer(makeCanvas(ctx));
  rd.showHud = true;

  /* 从快照里取"这一帧有哪些质点/细线"，而不是读实时的 battle.fields */
  const kindOf = (s, want) => {
    const out = [];
    if (!s.fields) return out;
    for (let i = 0; i < s.fields.length; i += FIELD_STRIDE) {
      const k = s.fields[i + 4];
      if (want === 'mote' && k < 0.5) out.push({ x: s.fields[i], y: s.fields[i + 1], kind: 'mote' });
      if (want === 'line' && k > 0.5 && k < 1.5) {
        out.push({ x: s.fields[i], y: s.fields[i + 1], x2: s.fields[i + 2], y2: s.fields[i + 3], kind: 'line' });
      }
    }
    return out;
  };

  let moteFrames = 0, moteDrawn = 0, lineFrames = 0, lineDrawn = 0;
  for (let f = 0; f < b.snapshots.length; f++) {
    const snap = b.snapshots[f];
    const motes = kindOf(snap, 'mote');
    const lines = kindOf(snap, 'line');
    if (!motes.length && !lines.length) continue;
    ctx.calls.length = 0;
    rd.draw(b, f);
    const arcs = ctx.calls.filter(c => c.n === 'arc');
    const segs = ctx.calls.filter(c => c.n === 'moveTo' || c.n === 'lineTo');
    if (motes.length) {
      moteFrames++;
      if (motes.every(m => arcs.some(c => at(c, m.x, m.y, 1)))) moteDrawn++;
    }
    if (lines.length) {
      lineFrames++;
      if (lines.every(l => segs.some(c => c.n === 'moveTo' && at(c, l.x, l.y, 1)) &&
        segs.some(c => c.n === 'lineTo' && at(c, l.x2, l.y2, 1)))) lineDrawn++;
    }
  }
  check('质点确实被画出来了', moteFrames > 0 && moteDrawn === moteFrames, `${moteDrawn}/${moteFrames} 帧`);
  check('细线确实被画成两端相连的线段', lineFrames > 0 && lineDrawn === lineFrames,
    `${lineDrawn}/${lineFrames} 帧`);
  check('本局确实出现了质点与细线', moteFrames > 0 && lineFrames > 0,
    `质点 ${moteFrames} 帧 / 细线 ${lineFrames} 帧`);
}

/* ============ ⑥ 极光 ============ */
console.log('\n【⑥】辉光领域极光');
{
  const withD = mk(['yuncai_domain'], { rules: { timeLimit: 5 } });
  const without = mk(['yuncai_modan'], { rules: { timeLimit: 5 } });
  /* 极光现在是**一张贴图**（作者给的横向长图），不再是程序化画出来的色带。
     所以判据从"多出若干次 fill"改成"多出一次画这张图"。
     踩过：改实现之后这条断言红了 —— 不是功能坏了，是判据跟着实现走了。
     现在它同时守住"画的是哪张图"，比数 fill 次数结实。 */
  const drawAndCount = (b) => {
    const ctx = makeCtx();
    const rd = new Renderer(makeCanvas(ctx));
    ctx.calls.length = 0;
    rd.draw(b, 1);
    return {
      aurora: ctx.calls.filter(c => c.n === 'drawImage' && c.a[0] &&
        String(c.a[0].src).includes('yuncai_aurora')).length,
    };
  };
  const a = drawAndCount(withD), c = drawAndCount(without);
  check('装了辉光领域会画出领域背景层', a.aurora > 0, `领域层 ${a.aurora} 次绘制`);
  check('没装辉光领域时不画领域层', c.aurora === 0, `领域层 ${c.aurora} 次`);
  check('battle.aurora 标记为真', withD.aurora === true);
  check('没装领域时不画极光', without.aurora === false);
}

/* ============ ⑤ 光门 ============ */
console.log('\n【⑤】光门');
{
  const b = mk(['yuncai_prism'], { rules: { timeLimit: 20 } });
  b.runToEnd();
  const ctx = makeCtx();
  const rd = new Renderer(makeCanvas(ctx));
  let frames = 0, matched = 0;
  for (let f = 0; f < b.snapshots.length; f++) {
    const snap = b.snapshots[f];
    const gates = [];
    if (snap.fields) {
      for (let i = 0; i < snap.fields.length; i += FIELD_STRIDE) {
        if (snap.fields[i + 4] > 1.5) gates.push({ x: snap.fields[i], y: snap.fields[i + 1] });
      }
    }
    if (!gates.length) continue;
    frames++;
    ctx.calls.length = 0;
    rd.draw(b, f);
    const arcs = ctx.calls.filter(c => c.n === 'arc');
    if (gates.every(g => arcs.some(c => at(c, g.x, g.y, 1)))) matched++;
  }
  check('光门确实被画出来了', frames > 0 && matched === frames, `${matched}/${frames} 帧`);
}

/* ============ ② 激光拖影 ============ */
console.log('\n【②】激光拖影');
{
  /* 激光要"累计命中两次"之后才会发射，靠自然对局不一定触发，
     所以直接把计数设到阈值，让第一发就是激光。 */
  const b = mk(['yuncai_modan'], { rules: { timeLimit: 10 } });
  b.units[0].flags.modanHits = 2;
  b.runToEnd();
  const ctx = makeCtx();
  const rd = new Renderer(makeCanvas(ctx));
  let beamFrames = 0, streakFrames = 0, beamUsesGradient = false;
  for (let f = 0; f < b.snapshots.length; f++) {
    const snap = b.snapshots[f];
    if (!snap.proj || !snap.proj.length) continue;
    // 快照里 kind 字段：2 = 光束
    let hasBeam = false, beamW = 0;
    for (let i = 0; i < snap.proj.length; i += PROJ_STRIDE) {
      if (snap.proj[i + 5] > 1.5) { hasBeam = true; beamW = snap.proj[i + 6]; }
    }
    if (!hasBeam) continue;
    beamFrames++;
    ctx.calls.length = 0;
    rd.draw(b, f);
    const hasBeamRect = ctx.calls.some(c => c.n === 'fillRect' && c.a[2] >= 30 && c.a[3] <= beamW + 6);
    const rotated = ctx.calls.some(c => c.n === 'rotate');
    if (hasBeamRect && rotated) streakFrames++;
    if (ctx.calls.some(c => c.n === 'linearGrad')) beamUsesGradient = true;
  }
  check('出现过长条激光', beamFrames > 0, `${beamFrames} 帧`);
  /* 圆柱体光柱的特征：用 fillRect 画等宽柱体（而不是渐隐的粗线拖尾）。
     所以断言"有 fillRect + 有 rotate（把柱体转到运动方向上）"。 */
  check('激光画成圆柱体光柱（fillRect 柱体 + 旋转对齐方向）', beamFrames > 0 && streakFrames === beamFrames,
    `${streakFrames}/${beamFrames} 帧`);
  check('激光不再使用渐隐拖尾（不该有 linearGrad）',
    beamFrames > 0 && !beamUsesGradient, beamUsesGradient ? '仍在用渐变拖尾' : '已改为柱体');
}

/* ============ ① 质点（单独构造，保证画面上真的有质点）============ */
console.log('\n【①】质点渲染');
{
  const b = mk(['yuncai_caiguang'], { rules: { timeLimit: 5 } });
  const m = b._spawnField({ kind: 'mote', owner: b.units[0], x: 120 * SCALE, y: 120 * SCALE, r: 7, damage: 1 });
  b.step();
  const ctx = makeCtx();
  const rd = new Renderer(makeCanvas(ctx));
  ctx.calls.length = 0;
  rd.draw(b, b.snapshots.length - 1);
  const arcs = ctx.calls.filter(c => c.n === 'arc');
  const grads = ctx.calls.filter(c => c.n === 'radialGrad');
  const mx = m.x / SCALE, my = m.y / SCALE;
  check('质点画出了黑色圆点', arcs.some(c => at(c, mx, my, 1) && c.a[2] <= 7),
    `质点位于 (${mx}, ${my})`);
  check('质点带一圈吸收光晕（径向渐变）', grads.some(c => at(c, mx, my, 1)));
}

/* ============ ③ 隐身透明度 ============ */
console.log('\n【③】隐身');
{
  const b = mk(['yuncai_zheguang'], { rules: { timeLimit: 5 } });
  const A = b.units[0];
  const ctx = makeCtx();
  const rd = new Renderer(makeCanvas(ctx));
  // 记录"画球体贴图时的 globalAlpha"
  const alphaAtDrawImage = (battle, frame) => {
    ctx.calls.length = 0;
    rd.draw(battle, frame);
    const d = ctx.calls.filter(c => c.n === 'drawImage');
    return d.length ? Math.min(...d.map(c => c.alpha)) : null;
  };
  b.step();
  const normalA = alphaAtDrawImage(b, b.snapshots.length - 1);
  A.stealthFrames = 60;
  b.step();
  const stealthA = alphaAtDrawImage(b, b.snapshots.length - 1);
  check('非隐身时贴图不透明', normalA === null || normalA > 0.9, String(normalA));
  check('隐身时贴图被画成半透明', stealthA !== null && stealthA < 0.5,
    `隐身 alpha=${stealthA} / 常态 alpha=${normalA}`);
}

/* ============ ④ 开华换贴图 ============ */
console.log('\n【④】开华形态贴图');
{
  const b = mk(['yuncai_kaihua'], { rules: { timeLimit: 5 } });
  const A = b.units[0];
  const ctx = makeCtx();
  const rd = new Renderer(makeCanvas(ctx));
  const drawnSrc = (frame) => {
    ctx.calls.length = 0;
    rd.draw(b, frame);
    const d = ctx.calls.filter(c => c.n === 'drawImage');
    // drawImage(img, ...) 的第一个参数就是贴图对象
    return d.length ? d[0].a[0].src : null;
  };
  b.step();
  const before = drawnSrc(b.snapshots.length - 1);
  A.hp = 400;
  b.step();
  const after = drawnSrc(b.snapshots.length - 1);
  check('开华前画的是常态贴图', before === Y.sticker.src, String(before));
  check('开华后自动换成开华形态贴图', after === Y.stickerBloom.src, String(after));
  check('两张贴图确实不同', before !== after);
}

/* ============ ④b 开华的特效与屏幕抖动 ============ */
console.log('\n【④b】开华爆发 + 屏幕抖动');
{
  const b = mk(['yuncai_kaihua'], { rules: { timeLimit: 5 } });
  const A = b.units[0];
  const ctx = makeCtx();
  const rd = new Renderer(makeCanvas(ctx));
  b.step();
  A.hp = 400;
  b.step();                                   // 这一步触发开华
  /* 触发之后让对局**继续跑完** —— 否则快照只到第 2 帧，
     后面那些"第 26 / 40 帧"的渲染会被 draw() 夹到最后一张快照上
     （第一次就是这么错的：在第 25 帧量到 amp=0.90，其实是第 1 帧的值）。 */
  b.runToEnd();
  const ev = b.events.find(e => e.type === 'bloom');
  check('跑出了开华事件（否则下面都测不到东西）', !!ev, ev ? `第 ${ev.f} 帧` : '没有');

  if (ev) {
    /* ⚠ 每次都要**拷一份**调用列表：ctx.calls 是同一个数组，
       下一次 at() 会把它清空重填 —— 直接存引用的话，前面拿到的
       "第 1 帧的调用"到最后会变成"最后一次渲染的调用"（踩过：
       粗弧层数比出 0 → 0）。 */
    const at = (frame) => {
      ctx.calls.length = 0;
      rd.draw(b, frame);
      return { calls: ctx.calls.slice(), shakeX: rd.shakeX, shakeY: rd.shakeY, amp: rd.shakeAmp };
    };
    const c0 = at(ev.f + 1).calls;
    const rings = c0.filter(c => c.n === 'arc');
    check('爆发画了三层扩散光环', rings.length >= 3, `${rings.length} 个圆弧调用`);
    const widest = Math.max(...rings.map(c => c.lw));
    check('光环比原来更粗（≥6，原来 4）', widest >= 6, `最粗线宽 ${widest}`);
    const solid = rings.filter(c => c.alpha >= 0.7);
    check('光环更亮了（有不透明度 ≥0.7 的一层，原来最高 0.85×fade）',
      solid.length >= 1, `不透明度 ${rings.map(c => c.alpha.toFixed(2)).join('/')}`);
    check('爆发有中心闪光（径向渐变）',
      c0.some(c => c.n === 'radialGrad'), 'radialGrad 存在');
    /* 放射细线：8 根短线，靠 lineTo 数出来 */
    const lines = c0.filter(c => c.n === 'lineTo').length;
    check('爆发有一圈放射细线', lines >= 8, `${lines} 条 lineTo`);
    /* 寿命比普通事件长：普通事件 22 帧就没了，开华要到 34 帧。
       ⚠ 不能断言"第 40 帧一个圆弧都没有" —— 开华之后**常驻光晕**
       每帧都在画弧，永远有。只能比"爆发那几层粗弧"退场了没有。 */
    const cLate = at(ev.f + 26).calls;
    const thickLate = cLate.filter(c => c.n === 'arc' && c.lw >= 4).length;
    check('爆发比普通事件活得久（第 26 帧还在画爆发光环）', thickLate >= 2, `${thickLate} 层粗弧`);
    const cEnd = at(ev.f + 40).calls;
    const thickEarly = c0.filter(c => c.n === 'arc' && c.lw >= 4).length;
    const thickEnd = cEnd.filter(c => c.n === 'arc' && c.lw >= 4).length;
    check('爆发最终会退场（粗弧从多层减到 0）',
      thickEarly >= 2 && thickEnd === 0, `第 1 帧 ${thickEarly} 层 → 第 40 帧 ${thickEnd} 层`);

    /* ---- 常驻形态光晕：开华之后每帧都有柔光底 + 三条旋转弧 ---- */
    const cAfter = at(ev.f + 60).calls;
    /* 光晕底的径向渐变：**别用 alpha 判**（createRadialGradient 不吃 globalAlpha，
       不透明度在色标里），只要求这一帧确实建了一个径向渐变。 */
    check('开华后脚下有常驻柔光（径向渐变）',
      cAfter.some(c => c.n === 'radialGrad'), '有 radialGrad');
    /* 常驻弧：三条，线宽 3.2/2.7/2.2、不透明度 0.34/0.26/0.18（原来统一 0.18/0.135/0.09）。
       所以判据是"最亮那条 ≥0.3 且至少三条 lw≥2"，而不是"每条都 ≥0.3"。 */
    const arcsAfter = cAfter.filter(c => c.n === 'arc' && c.lw >= 2);
    const maxArcA = arcsAfter.length ? Math.max(...arcsAfter.map(c => c.alpha)) : 0;
    check('开华后常驻弧比以前更显眼（≥3 条、最亮一条 ≥0.30，原来最亮 0.18）',
      arcsAfter.length >= 3 && maxArcA >= 0.3,
      `${arcsAfter.length} 条，最亮 ${maxArcA.toFixed(2)}：` +
      arcsAfter.map(c => `${c.lw}/${c.alpha.toFixed(2)}`).join(' '));

    /* ---- 屏幕抖动 ---- */
    const s0 = at(ev.f);
    check('开华那一帧抖起来了', s0.amp > 0.9 && (Math.abs(s0.shakeX) + Math.abs(s0.shakeY)) > 0,
      `amp=${s0.amp.toFixed(2)} (${s0.shakeX.toFixed(2)}, ${s0.shakeY.toFixed(2)})`);
    check('抖动是"轻微"的（位移不超过 4 世界单位）',
      Math.abs(s0.shakeX) <= 4 && Math.abs(s0.shakeY) <= 4,
      `(${s0.shakeX.toFixed(2)}, ${s0.shakeY.toFixed(2)})`);
    const s10 = at(ev.f + 10);
    const sEnd = at(ev.f + 25);
    check('抖动随时间衰减（第 10 帧弱于第 0 帧）',
      s10.amp > 0 && s10.amp < s0.amp, `${s0.amp.toFixed(2)} → ${s10.amp.toFixed(2)}`);
    check('抖动会归零（第 25 帧已经不抖了）',
      sEnd.amp === 0 && sEnd.shakeX === 0 && sEnd.shakeY === 0, `amp=${sEnd.amp}`);

    /* 抖动必须真的作用到画面上：相机 translate 里要带上它 */
    const tr = s0.calls.filter(c => c.n === 'translate');
    check('抖动真的作用到了相机（translate 里带上了偏移）',
      tr.some(c => Math.abs(c.a[0] - (-rd.camX + s0.shakeX)) < 1e-9 &&
                   Math.abs(c.a[1] - (-rd.camY + s0.shakeY)) < 1e-9),
      `translate(${tr.map(c => c.a[0].toFixed(1) + ',' + c.a[1].toFixed(1)).join(' | ')})`);

    /* 确定性：同一帧画两次必须一模一样（暂停/拖进度条不能变样） */
    const a1 = at(ev.f + 5), a2 = at(ev.f + 5);
    check('同一帧两次渲染的抖动完全一致（跟着帧号，不跟墙上时钟）',
      a1.shakeX === a2.shakeX && a1.shakeY === a2.shakeY,
      `${a1.shakeX.toFixed(6)} vs ${a2.shakeX.toFixed(6)}`);

    /* 开关：关掉之后一点都不抖 */
    rd.screenShake = false;
    const off = at(ev.f);
    check('关掉开关后完全不抖', off.amp === 0 && off.shakeX === 0 && off.shakeY === 0);
    rd.screenShake = true;
  }
}

/* ============ ④c 屏幕抖动只在开华时出现 ============ */
console.log('\n【④c】没有开华就不该抖');
{
  /* 一局没有开华的晕彩（默认装配里就没有开华）：整局逐帧都不该抖 */
  const b = mk(['yuncai_modan'], { rules: { timeLimit: 8 } });
  const ctx = makeCtx();
  const rd = new Renderer(makeCanvas(ctx));
  let worst = 0;
  for (let f = 0; f < b.snapshots.length; f++) {
    ctx.calls.length = 0;
    rd.draw(b, f);
    worst = Math.max(worst, Math.abs(rd.shakeX) + Math.abs(rd.shakeY));
  }
  check('没装开华时整局都不抖（不会"每局都晃"）', worst === 0, `最大位移 ${worst}`);
}

/* ============ 血条上的详细血量 ============ */
console.log('\n【HUD】血条显示详细血量');
{
  const b = mk(['yuncai_modan'], { rules: { timeLimit: 5 } });
  const ctx = makeCtx();
  const rd = new Renderer(makeCanvas(ctx));
  rd.showHud = true;
  b.step();
  const f = b.snapshots.length - 1;
  const hp = Math.round(b.snapshots[f].data[2]);
  ctx.calls.length = 0;
  rd.draw(b, f);
  const texts = ctx.calls.filter(c => c.n === 'fillText').map(c => String(c.a[0]));
  check('血条上画出了当前血量数字',
    texts.some(t => t === String(hp) || t.startsWith(hp + '/')),
    `血量 ${hp}，画出的文本 ${JSON.stringify(texts)}`);
  check('血量数字带白色描边（深色场地上也能读）',
    ctx.calls.some(c => c.n === 'strokeText'));
  /* 关掉 HUD 就不该再画血量数字 */
  rd.showHud = false;
  ctx.calls.length = 0;
  rd.draw(b, f);
  const texts2 = ctx.calls.filter(c => c.n === 'fillText').map(c => String(c.a[0]));
  check('关闭 HUD 后不再画血量数字',
    !texts2.some(t => t === String(hp) || t.startsWith(hp + '/')),
    JSON.stringify(texts2));
  rd.showHud = true;
}

/* ============ 综合：全技能渲染不报错 ============ */
console.log('\n【综合】七技能一起渲染');
{
  const b = mk(Y.skills.slice(), { rules: { timeLimit: 30 } });
  b.runToEnd();
  const ctx = makeCtx();
  const rd = new Renderer(makeCanvas(ctx));
  let err = null, frames = 0;
  try {
    for (let f = 0; f < b.snapshots.length; f++) { rd.draw(b, f); frames++; }
  } catch (e) { err = e; }
  check('逐帧渲染全部快照不报错', !err, err ? err.message : `${frames} 帧`);
  check('渲染帧数与快照数一致', frames === b.snapshots.length,
    `${frames}/${b.snapshots.length}`);
  check('画面确实有东西（不是空画）', ctx.calls.length >= 0);
}

console.log('\n' + log.join('\n'));
console.log(`\n=========== 通过 ${pass} 项，失败 ${fail} 项 ===========`);
process.exit(fail ? 1 : 0);

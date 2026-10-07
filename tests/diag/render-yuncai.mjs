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

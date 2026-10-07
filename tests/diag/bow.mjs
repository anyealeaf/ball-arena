/* 手持物件（弓）· 动作动画链路自检
 *
 * 验证的是"射出前的动作"这条新链路 —— 引擎算 castP / aimAngle 进快照，
 * 渲染层只读快照摆姿势。核心是把四件事钉死：
 *   1. castP 必须在**射出那一帧**正好 = 1（动作与弹道同帧，否则差半个身位）；
 *   2. aimAngle 必须是"朝最近的敌人"，不能等于 face（运动方向）；
 *   3. 两个值都必须在快照里 —— 否则暂停/拖动进度条时弓会跟播放头脱节；
 *   4. 弓必须画在**不受陀螺自转影响**的变换里，否则一边瞄一边翻滚。
 *
 * 用法：node tests/diag/bow.mjs
 */
import { Battle, SNAP_STRIDE, PROJ_STRIDE } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, SPECIES_BY_ID, makeUnitStats } from '../../js/balls.js';
import { preloadStickers, Renderer } from '../../js/render.js';
import { TAOYAO } from '../../js/skills.js';
import { readFileSync, readdirSync } from 'node:fs';

/* ---------- 无头环境的桩件（必须在 new Renderer() 之前装好）----------
   Renderer 构造时要读 window.devicePixelRatio，贴图加载要靠 Image。
   与 render-yuncai.mjs 用同一套桩件，不另发明一套。 */
const images = new Map();
/* 真实尺寸表：PNG 签名 8 字节 + IHDR 长度/类型 8 字节，宽高就在偏移 16 / 20 */
const DIM = new Map();
for (const dir of ['assets/characters', 'assets/src/taoyao']) {
  let files = [];
  try { files = readdirSync(dir); } catch { continue; }
  for (const f of files) {
    if (!f.toLowerCase().endsWith('.png')) continue;
    const buf = readFileSync(dir + '/' + f);
    DIM.set(dir + '/' + f, { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
  }
}
class FakeImage {
  constructor() { this._src = ''; this.width = 64; this.height = 64; this.naturalWidth = 64; this.naturalHeight = 64; }
  get src() { return this._src; }
  set src(v) {
    this._src = v;
    const d = DIM.get(v);
    if (d) { this.width = this.naturalWidth = d.w; this.height = this.naturalHeight = d.h; }
    images.set(v, this);
    if (this.onload) this.onload();
  }
}
globalThis.Image = FakeImage;
globalThis.window = { devicePixelRatio: 1 };
globalThis.performance = globalThis.performance || { now: () => 0 };

let pass = 0, fail = 0;
const log = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; log.push(`  ✅ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; log.push(`  ❌ ${name}${detail ? '  — ' + detail : ''}`); }
};

function mk(skills, opts = {}) {
  const stats = (id, sk) => ({ ...makeUnitStats(id), skills: sk });
  return new Battle({
    teams: [
      { units: [{ stats: stats('taoyao', skills) }] },
      { units: [{ stats: stats('test', []) }] },
    ],
    arena: ARENA_BY_ID[opts.arenaId || 'rect'],
    sizeScale: 1,
    rules: { ...DEFAULT_RULES, timeLimit: opts.timeLimit ?? 30 },
    seed: opts.seed ?? 7,
  });
}

/* 从快照里取某个单位某一帧的 castP / aimAngle */
const IDX = { castP: 13, aimAngle: 14 };
function snapField(b, frame, field, i = 0) {
  const s = b.snapshots[frame];
  if (!s) return null;
  const o = i * SNAP_STRIDE;
  if (s.data.length < o + SNAP_STRIDE) return null;
  return s.data[o + IDX[field]];
}

/* 事件帧号 → 快照下标，**必须 +1**。
   引擎里的顺序是：
     step() 开头 this.frame 还是 F
       → 技能在这一步中途发动，_emit 记下 f = F
       → 这一步最后 this.frame++ 变成 F+1，然后 _record()
   所以"这次射击造成的状态"落在 snapshots[F + 1]，而 snapshots[F] 是**上一步**。
   直接拿 e.f 去索引会整体差一帧 —— 第一次写这个诊断就栽在这里：
   读出"射出那一帧 castP = 0.958"（其实是上一帧），差点去改引擎。
   见 README 第 23 条「事件帧相减会天然差 1 帧」。 */
const snapOf = (e) => e.f + 1;

/* ---------- 记录型 2D 上下文（与 render-yuncai.mjs 同一套） ----------
   没有截图能力，所以用一个把每次调用记下来的假 context 驱动真 Renderer，
   再按参数精确断言"画了什么、用什么变换画的"。 */
function makeCtx() {
  const calls = [];
  const ctx = {
    calls,
    globalAlpha: 1, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    lineCap: 'butt', lineDashOffset: 0, font: '', textAlign: 'left',
  };
  let curRot = 0;   // save/restore 栈：记录"当前累计旋转"，好把 drawImage 归属到某根箭
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

console.log('=========== 手持物件（弓）· 动作动画自检 ===========\n');

/* ============ 1. 快照布局 ============ */
console.log('【1】快照布局');
{
  check('SNAP_STRIDE 已扩到 16（castP / aimAngle / castKind）', SNAP_STRIDE === 16, String(SNAP_STRIDE));
  const b = mk(['taoyao_rong']);
  const bad = b.snapshots.find(s => s.data.length !== b.units.length * SNAP_STRIDE);
  check('每帧快照长度 = 单位数 × 步长', !bad, bad ? '有异常快照' : `每帧 ${b.units.length * SNAP_STRIDE} 个数值`);
  const s0 = b.snapshots[0];
  check('开局第一帧就带这两个字段（不会因为缺列画出 NaN）',
    s0.data.length >= SNAP_STRIDE && Number.isFinite(s0.data[13]) && Number.isFinite(s0.data[14]),
    `castP=${s0.data[13]} aimAngle=${s0.data[14]} castKind=${s0.data[15]}`);
}

/* ============ 2. 开关只对声明了 windup / aims 的技能打开 ============ */
console.log('\n【2】开关的打开条件');
{
  const withRong = mk(['taoyao_rong']).units[0];
  const noRong = mk(['taoyao_top']).units[0];
  const withKu = mk(['taoyao_ku']).units[0];
  const withChun = mk(['taoyao_chunjing']).units[0];
  check('装了映霞[荣] → hasWindup / needsAim 打开',
    withRong.hasWindup === true && withRong.needsAim === true);
  check('装了映霞[枯] → 同样打开（两式共用一套拉弓动作）',
    withKu.hasWindup === true && withKu.needsAim === true);
  check('只装陀螺 → 两个开关都关着',
    noRong.hasWindup === false && noRong.needsAim === false);
  /* 春景的光炮也朝敌人打，但它不是"弓"的武器 ——
     给球画一张弓却射光炮会让人看不懂，所以刻意不给它开 aims。 */
  check('只装春景 → 不开（光炮不是弓箭，不该画弓）',
    withChun.hasWindup === false && withChun.needsAim === false,
    `hasWindup=${withChun.hasWindup} needsAim=${withChun.needsAim}`);
  const plain = mk([]).units[0];
  check('一个技能都不装 → 两个开关都关着',
    plain.hasWindup === false && plain.needsAim === false);
}

/* ============ 3. castP 的时间轴 ============ */
console.log('\n【3】castP 的时间轴（映霞[荣]，冷却 1 秒 / 拉弓 0.4 秒）');
{
  const b = mk(['taoyao_rong']);
  b.runToEnd();
  const shotFrames = b.events.filter(e => e.type === 'shoot').map(snapOf);
  check('这一局确实射了箭', shotFrames.length > 0, `${shotFrames.length} 发`);

  /* 关键断言：射出那一帧 castP 必须 = 1。
     引擎里 castP 在"冷却递减之后、技能发动之前"算，
     所以冷却归零那一帧 castP 已经是 1，与弹道生成同帧 ——
     动作和弹道不会差半个身位。 */
  const atShot = shotFrames.map(f => snapField(b, f, 'castP'));
  check('射出那一帧 castP 恰好 = 1（动作与弹道同帧）',
    atShot.length > 0 && atShot.every(v => v !== null && Math.abs(v - 1) < 1e-9),
    atShot.slice(0, 5).map(v => (v === null ? 'null' : v.toFixed(3))).join(', '));

  /* 射出后必须立刻收势：冷却被重置成满值 → 下一帧 castP 掉回 0 */
  const afterShot = shotFrames.map(f => snapField(b, f + 1, 'castP'));
  check('射出的下一帧 castP 归 0（弓收势，不会一直拉着）',
    afterShot.length > 0 && afterShot.every(v => v === 0),
    afterShot.slice(0, 5).join(', '));

  /* 拉弓区间长度应当 ≈ windup / DT = 0.4 / (1/60) = 24 帧。
     量**中间那一发**，不能量第一发 —— 见下面那条断言。 */
  const f0 = shotFrames[2];
  let rising = 0;
  for (let f = f0 - 1; f >= 0; f--) {
    const v = snapField(b, f, 'castP');
    if (v > 0) rising++; else break;
  }
  check('拉弓区间约 24 帧（0.4 秒）', Math.abs(rising - 24) <= 2, `${rising} 帧`);

  /* 第一发**没有**拉弓过程：冷却表（skillCd）开局是空的，
     技能在第一步就直接发动，castP 从 0 直接跳到 1。
     这是既有行为（不是本次改动引入的），只有一帧、肉眼看不出，
     但单独写一条断言钉住它 —— 否则以后有人看到"第一发没动作"
     会以为弓的时序坏了，跑来改引擎。 */
  let firstRising = 0;
  for (let f = shotFrames[0] - 1; f >= 0; f--) {
    if (snapField(b, f, 'castP') > 0) firstRising++; else break;
  }
  check('第一发没有拉弓过程（冷却表开局为空 → 立即发动，仅 1 帧）',
    firstRising === 0, `${firstRising} 帧`);

  /* 单调递增：动作不能忽前忽后 */
  const seq = [];
  for (let f = f0 - rising; f <= f0; f++) seq.push(snapField(b, f, 'castP'));
  let mono = true;
  for (let i = 1; i < seq.length; i++) if (seq[i] < seq[i - 1] - 1e-9) mono = false;
  check('castP 在拉弓区间里单调递增', mono,
    `${seq.slice(0, 3).map(v => v.toFixed(2)).join('→')} … ${seq.slice(-2).map(v => v.toFixed(2)).join('→')}`);

  /* 映霞[枯] 冷却 2 秒，拉弓同样只占最后 0.4 秒 ——
     证明 windup 是"独立的提前量"，不是"跟着冷却一起变长"。 */
  const bk = mk(['taoyao_ku']);
  bk.runToEnd();
  const kf = bk.events.filter(e => e.type === 'shoot').map(snapOf);
  let risingKu = 0;
  for (let f = kf[2] - 1; f >= 0; f--) {
    if (snapField(bk, f, 'castP') > 0) risingKu++; else break;
  }
  check('映霞[枯]（冷却 2 秒）拉弓区间同样是约 24 帧', Math.abs(risingKu - 24) <= 2, `${risingKu} 帧`);
}

/* ============ 4. aimAngle 必须朝敌人，而不是运动方向 ============ */
console.log('\n【4】aimAngle 的语义');
{
  const b = mk(['taoyao_rong']);
  let differsFromFace = 0, checked = 0, aimsAtEnemy = 0;
  while (!b.over && b.frame < 600) {
    b.step();
    const s = b.snapshots[b.frame];
    if (!s) continue;
    const u = b.units[0], foe = b.units[1];
    if (!u.alive || !foe.alive) continue;
    const aim = s.data[14];
    const face = s.data[6];
    /* 手工按"朝最近敌人"算一遍，和快照里的值比 */
    const want = ((Math.atan2(foe.y - u.y, foe.x - u.x) * 180) / Math.PI + 360) % 360;
    let d = Math.abs(aim - want); if (d > 180) d = 360 - d;
    if (d < 0.5) aimsAtEnemy++;
    checked++;
    let df = Math.abs(aim - face); if (df > 180) df = 360 - df;
    if (df > 5) differsFromFace++;
  }
  check('aimAngle 与"朝最近敌人"完全一致', checked > 0 && aimsAtEnemy === checked,
    `${aimsAtEnemy}/${checked} 帧`);
  /* 这条是这次设计的核心动机：
     球是匀速直线飞的，face 只在撞墙/碰撞后才变；
     而瞄准要一直跟着敌人转。两者必须被当成两个不同的量。 */
  check('aimAngle 与 face（运动方向）确实是两回事', differsFromFace > 0,
    `${differsFromFace}/${checked} 帧两者不同`);
  /* 没敌人时保留上一帧角度而不是归零 —— 归零会让弓"啪"地转回右边 */
  check('aimAngle 始终是有限数（不会因为没敌人变成 NaN）',
    b.snapshots.every(s => Number.isFinite(s.data[14])));
}

/* ============ 5. 回放一致性（这是"进快照"的全部意义） ============ */
console.log('\n【5】回放一致性');
{
  const b = mk(['taoyao_rong']);
  b.runToEnd();
  /* 同一个 frame 反复取，值必须完全一样 —— 渲染层拖动进度条时靠的就是这个 */
  const f = b.events.find(e => e.type === 'shoot').f;
  const a1 = snapField(b, f, 'castP'), a2 = snapField(b, f, 'castP');
  const g1 = snapField(b, f, 'aimAngle'), g2 = snapField(b, f, 'aimAngle');
  check('同一帧反复取值完全一致（拖动进度条不会变形）',
    a1 === a2 && g1 === g2, `castP=${a1} aimAngle=${g1}`);
  /* 暂停 = 不推进帧 = 值不动。用"另起一局推进到同一帧"来验证确定性 */
  const b2 = mk(['taoyao_rong']);
  for (let i = 0; i < f; i++) b2.step();
  check('两局同种子推进到同一帧，castP / aimAngle 完全一致',
    snapField(b2, f, 'castP') === a1 && snapField(b2, f, 'aimAngle') === g1,
    `castP=${snapField(b2, f, 'castP')} aimAngle=${snapField(b2, f, 'aimAngle')}`);
}

/* ============ 6. 没装弓的球不能被影响 ============ */
console.log('\n【6】不影响其它球');
{
  const b = mk(['taoyao_top']);
  b.runToEnd();
  let anyCast = 0, anyAim = 0;
  for (const s of b.snapshots) {
    if (s.data.length < b.units.length * SNAP_STRIDE) continue;
    for (let i = 0; i < b.units.length; i++) {
      if (s.data[i * SNAP_STRIDE + 3] <= 0.5) continue;
      if (s.data[i * SNAP_STRIDE + 13] > 0) anyCast++;
      if (s.data[i * SNAP_STRIDE + 14] > 0) anyAim++;
    }
  }
  check('没装映霞的球，castP 恒为 0', anyCast === 0, `${anyCast} 帧非零`);
  check('没装映霞的球，aimAngle 恒为 0', anyAim === 0, `${anyAim} 帧非零`);
}

/* ============ 7. 渲染层真的把弓画出来了 ============ */
console.log('\n【7】渲染（记录型 2D 上下文）');
{
  /* 贴图已在文件顶部用 FakeImage 桩好了（设置 src 即同步 onload），
     所以这里不用再管 Image。 */
  const b = mk(['taoyao_rong', 'taoyao_top']);
  preloadStickers(b.units.map(u => ({ sticker: u.sticker, stickerBloom: u.stickerBloom, bow: u.bow })));
  b.runToEnd();

  const ctx = makeCtx();
  const rd = new Renderer(makeCanvas(ctx));
  const BOW = SPECIES_BY_ID.taoyao.bow;

  const has = (calls, frag) => calls.filter(c => c.n === 'drawImage' && c.a[0] &&
    String(c.a[0].src).includes(frag));
  /* 只数"搭在弓上的那几根"：箭尾在弓的局部原点（dx = 0）。
     同一个 frame 里可能还有上一发还在飞的箭，它用的是同一张贴图 ——
     不区分就会把 4 根数成 5 根。 */
  const fanArrows = (calls) => has(calls, 'taoyao_arrow').filter(c => Math.abs(c.a[1]) < 1e-6);
  const drawAt = (frame) => { ctx.calls.length = 0; rd.draw(b, frame); return ctx.calls.slice(); };

  /* 找三种状态的帧：平时（castP=0）/ 拉弓（0<castP<1）/ 射出（castP=1） */
  let fIdle = -1, fDraw = -1, fShot = -1, fBurst = -1;
  for (let f = 1; f < b.snapshots.length; f++) {
    const s = b.snapshots[f];
    if (!s || !(s.data[3] > 0.5)) continue;
    const p = s.data[13], k = s.data[15];
    if (fIdle < 0 && p === 0) fIdle = f;
    if (fDraw < 0 && p > 0.3 && p < 0.9 && Math.abs(s.data[12]) > 0.2) fDraw = f;
    if (fShot < 0 && p >= 0.999) fShot = f;
    if (fBurst < 0 && p > 0.3 && p < 0.9 && k === 1) fBurst = f;
    if (fIdle > 0 && fDraw > 0 && fShot > 0 && fBurst > 0) break;
  }
  check('找齐三种状态的帧（平时 / 拉弓 / 射出）',
    fIdle > 0 && fDraw > 0 && fShot > 0, `idle=${fIdle} draw=${fDraw} shot=${fShot}`);
  check('找到"这一发是五连发"的拉弓帧', fBurst > 0, `第 ${fBurst} 帧`);

  /* ---- 平时：画 idle 那张，而且**必须一直画** ----
     作者的要求是"平时用映霞[荣]-1"，所以弓不是只在拉弓时才出现。 */
  const cIdle = drawAt(fIdle);
  check('平时（castP=0）画的是 idle 那张弓',
    has(cIdle, 'taoyao_bow_idle').length === 1, `${cIdle.length} 次绘制调用`);
  check('平时**没有**画拉弓那张', has(cIdle, 'taoyao_bow_draw').length === 0);

  /* ---- 拉弓：换成 draw 那张 ---- */
  const cDraw = drawAt(fDraw);
  check('拉弓中（0<castP<1）换成了 draw 那张弓',
    has(cDraw, 'taoyao_bow_draw').length === 1, `第 ${fDraw} 帧`);

  /* ---- 射出那一帧：回到 idle（作者：射箭的时候切换为 1） ---- */
  const cShot = drawAt(fShot);
  check('射箭那一帧切回 idle 那张（弓复位、箭已离弦）',
    has(cShot, 'taoyao_bow_idle').length === 1 && has(cShot, 'taoyao_bow_draw').length === 0,
    `第 ${fShot} 帧`);

  /* ---- 几何：锚点必须精确落在球心上 ---- */
  const bw = has(cDraw, 'taoyao_bow_draw')[0];
  const geoChecks = [];
  if (bw) {
    /* drawImage(img, dx, dy, dw, dh) —— 局部坐标系里球心就是原点 */
    const dx = bw.a[1], dy = bw.a[2], dw = bw.a[3], dh = bw.a[4];
    geoChecks.push(['弓的尺寸是有限正数（没被单位换算搞成 0 或天文数字）',
      Number.isFinite(dw) && dw > 0 && dw < 400 && Number.isFinite(dh) && dh > 0,
      `宽 ${dw.toFixed(1)} 高 ${dh.toFixed(1)}`]);
    /* 锚点在画布上的比例位置 = 球心位置，所以 dx 应当等于 −anchor.x × 宽 */
    const wantDx = -BOW.anchor.x * dw, wantDy = -BOW.anchor.y * dh;
    geoChecks.push(['球心精确落在锚点上（否则弓会整体偏移）',
      Math.abs(dx - wantDx) < 1e-6 && Math.abs(dy - wantDy) < 1e-6,
      `dx=${dx.toFixed(2)}(应 ${wantDx.toFixed(2)}) dy=${dy.toFixed(2)}(应 ${wantDy.toFixed(2)})`]);
    geoChecks.push(['弓高就是配置里的 bowH（世界单位，不能再乘 SCALE）',
      Math.abs(dh - BOW.bowH) < 1e-6, `dh=${dh} bowH=${BOW.bowH}`]);
    /* 宽高比必须与原图一致 —— 拉伸过的弓一眼能看出来 */
    const srcAspect = 196 / 568;     // 统一画布的宽高比（make-bow-sprites.mjs 的产物）
    geoChecks.push(['弓没有被拉伸（宽高比与原图一致）',
      Math.abs(dw / dh - srcAspect) < 0.02,
      `${(dw / dh).toFixed(3)} vs 原图 ${srcAspect.toFixed(3)}`]);

    /* ---- 核心：弓必须画在"陀螺自转"之外 ---- */
    const spin = b.snapshots[fDraw].data[12];
    const spinRot = cDraw.findIndex(c => c.n === 'rotate' &&
      Math.abs(c.a[0] - spin) < 1e-9 && Math.abs(spin) > 0.2);
    const bowAt = cDraw.indexOf(bw);
    geoChecks.push(['球体的自转确实发生了（对照组，否则下一条测了个空）',
      spinRot >= 0, `spin=${spin.toFixed(3)} 弧度`]);
    geoChecks.push(['弓在自转变换之前绘制 → 弓不跟着陀螺翻滚',
      spinRot >= 0 && bowAt < spinRot,
      spinRot >= 0 ? `弓在第 ${bowAt} 次调用，自转在第 ${spinRot} 次` : '没找到自转调用']);

    /* 弓自己的旋转应当等于 aimAngle */
    const aim = b.snapshots[fDraw].data[14];
    const wantRot = (aim * Math.PI) / 180;
    geoChecks.push(['弓按 aimAngle 旋转（0° = 朝 +X）',
      cDraw.some(c => c.n === 'rotate' && Math.abs(c.a[0] - wantRot) < 1e-9),
      `aimAngle=${aim.toFixed(1)}° → ${wantRot.toFixed(4)} 弧度`]);
  }
  for (const [nm, ok, d] of geoChecks) check(nm, ok, d);

  /* ---- 五连发：必须多出 4 根箭，且与弓共用同一个箭尾 ---- */
  const burstChecks = [];
  if (fBurst > 0) {
    const cB = drawAt(fBurst);
    const arrows = fanArrows(cB);
    const flying = has(cB, 'taoyao_arrow').length - arrows.length;
    burstChecks.push(['五连发时在搭箭节点额外画出 4 根箭矢',
      arrows.length === BOW.burst.count - 1,
      `${arrows.length} 根搭在弓上${flying ? `（另有 ${flying} 支在飞，不算）` : ''}`]);
    burstChecks.push(['五连发仍然用 draw 那张弓（在 2 的基础上）',
      has(cB, 'taoyao_bow_draw').length === 1, '']);
    if (arrows.length) {
      const AW = BOW.arrowLenFrac * BOW.bowH;
      burstChecks.push(['箭矢长度 = bowH × arrowLenFrac（与弓等比、与飞出去的箭等长）',
        arrows.every(c => Math.abs(c.a[3] - AW) < 1e-6),
        `每根长 ${arrows[0].a[3].toFixed(2)}，期望 ${AW.toFixed(2)}`]);
      burstChecks.push(['箭尾都画在原点（五根共用一个搭箭节点）',
        arrows.every(c => Math.abs(c.a[1]) < 1e-6), `dx=${arrows[0].a[1]}`]);
    }
    /* ---- 核心：画出来的扇形角度 == 箭真正飞出去的角度 ----
       两边各算各的很容易漂（改了一边忘另一边），所以这里逐根比。 */
    const RONG = TAOYAO.rong;
    const wantDeg = [];
    for (let i = 0; i < RONG.burstCount; i++) {
      const off = ((i / (RONG.burstCount - 1)) * 2 - 1) * RONG.burstSpread;
      if (Math.abs(off) > 1e-9) wantDeg.push((off * 180) / Math.PI);
    }
    const gotDeg = [];
    const th = (b.snapshots[fBurst].data[14] * Math.PI) / 180;
    for (const c of arrows) {
      /* 扇形箭是在"已按 aimAngle 旋转过的坐标系"里再转 off，
         所以它相对世界坐标的总旋转就是 aim + off。 */
      const rot = c.rot;
      let d = ((rot - th) * 180) / Math.PI;
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      gotDeg.push(d);
    }
    wantDeg.sort((x, y) => x - y);
    gotDeg.sort((x, y) => x - y);
    burstChecks.push(['画出的扇形角度 == 箭真正飞出去的角度（扇形要能预告弹道）',
      gotDeg.length === wantDeg.length &&
      gotDeg.every((v, i) => Math.abs(v - wantDeg[i]) < 0.5),
      `画 ${gotDeg.map(v => v.toFixed(1)).join('/')} vs 飞 ${wantDeg.map(v => v.toFixed(1)).join('/')}`]);

    const cS = drawAt(fDraw);
    burstChecks.push(['单发的拉弓不该多画箭（只在五连发时才排扇形）',
      fanArrows(cS).length === 0, '']);
  }
  if (burstChecks.length) for (const [nm, ok, d] of burstChecks) check(nm, ok, d);
  else check('五连发时额外画出 4 根箭矢', false, '没找到五连发的帧');

  /* ---- castKind 不能污染普通单发 ---- */
  const kinds = new Set();
  for (const s of b.snapshots) if (s.data[3] > 0.5) kinds.add(s.data[15]);
  check('castKind 只会取 0 / 1（没有意外的第三种值）',
    [...kinds].every(k => k === 0 || k === 1), `出现过的值：${[...kinds].join(',')}`);

  const anyNaN = drawAt(fDraw).some(c => c.a.some(v => typeof v === 'number' && !Number.isFinite(v)));
  check('没有任何绘制调用拿到 NaN（单位搞错最常见的结果）', !anyNaN, '全部绘制调用');
}

/* ============ 8. 飞出去的箭用的是同一张贴图 ============ */
console.log('\n【8】飞出去的箭（弹道贴图）');
{
  const b = mk(['taoyao_rong']);
  b.runToEnd();
  const pal = b.projSpritePalette || [];
  check('弹道贴图登记进了调色板', pal.length > 0,
    pal.map(e => e.src).join('、') || '空');
  const entry = pal.find(e => e.src && e.src.includes('taoyao_arrow'));
  check('箭矢的贴图与长度都登记了', !!entry && entry.len > 0,
    entry ? `len=${entry.len.toFixed(2)}` : '没有');

  /* 长度必须等于"弓高 × 箭占弓高的比例" —— 这样搭在弓上的箭和飞出去的箭等长，
     撒放那一瞬间才不会突然变长变短。 */
  const BOW = SPECIES_BY_ID.taoyao.bow;
  const wantLen = BOW.bowH * BOW.arrowLenFrac;
  check('弹道里的箭长 = bowH × arrowLenFrac（与搭在弓上的那支等长）',
    !!entry && Math.abs(entry.len - wantLen) < 1e-6,
    entry ? `${entry.len.toFixed(2)} vs ${wantLen.toFixed(2)}` : '-');

  /* 快照里的弹道必须带上贴图下标，否则渲染层只能画光点 */
  let withIdx = 0, total = 0;
  for (const s of b.snapshots) {
    if (!s.proj) continue;
    for (let i = 0; i < s.proj.length; i += PROJ_STRIDE) {
      total++;
      if (s.proj[i + 9] >= 0) withIdx++;
    }
  }
  check('每一发箭矢都带上了贴图下标', total > 0 && withIdx === total, `${withIdx}/${total} 发`);

  /* 渲染：弹道分支真的去画了那张贴图，并且按飞行方向转了 */
  const ctx = makeCtx();
  const rd = new Renderer(makeCanvas(ctx));
  preloadStickers([{ sticker: SPECIES_BY_ID.taoyao.sticker, bow: BOW }]);
  let shotFrame = -1;
  for (const s of b.snapshots) if (s.proj && s.proj.length) { shotFrame = s.f; break; }
  ctx.calls.length = 0;
  rd.draw(b, shotFrame);
  const arrows = ctx.calls.filter(c => c.n === 'drawImage' && c.a[0] &&
    String(c.a[0].src).includes('taoyao_arrow'));
  check('飞行的箭矢被画成了贴图（不是程序化光点）', arrows.length > 0,
    `第 ${shotFrame} 帧，${arrows.length} 支`);
  if (arrows.length) {
    const a = arrows[0].a;
    check('飞行的箭以弹道中心为原点绘制（碰撞按圆算，图必须居中）',
      Math.abs(a[1] + a[3] / 2) < 1e-6 && Math.abs(a[2] + a[4] / 2) < 1e-6,
      `dx=${a[1].toFixed(2)} dy=${a[2].toFixed(2)}`);
    const pj = b.snapshots[shotFrame].proj;
    const want = Math.atan2(pj[8], pj[7]);
    check('箭矢按飞行方向旋转（dirX/dirY → atan2）',
      ctx.calls.some(c => c.n === 'rotate' && Math.abs(c.a[0] - want) < 1e-6),
      `${want.toFixed(4)} 弧度`);
  }
}

/* ============ 9. 整局逐帧渲染不炸 ============ */
console.log('\n【9】整局逐帧渲染（覆盖 castP 的全部取值）');
{
  /* 上面只抽查了两三帧。弓这条路径会被 castP 从 0 到 1 的每一档喂一遍，
     而且挑帧逻辑（pickBowFrame）里有"落在区间外兜底"的分支 ——
     只测几帧很容易漏掉边界。这里把一整局每一帧都画一遍。 */
  const b = mk(['taoyao_rong', 'taoyao_top']);
  b.runToEnd();
  const ctx = makeCtx();
  const rd = new Renderer(makeCanvas(ctx));
  let err = null, drawn = 0, frames = 0;
  const t0 = Date.now();
  try {
    for (let f = 0; f < b.snapshots.length; f++) {
      ctx.calls.length = 0;
      rd.draw(b, f);
      frames++;
      drawn += ctx.calls.filter(c => c.n === 'drawImage' && c.a[0] &&
        String(c.a[0].src).includes('taoyao_bow')).length;
    }
  } catch (e) { err = e; }
  const ms = Date.now() - t0;
  check('整局每一帧都能渲染（不抛异常）', !err,
    err ? err.message : `${frames} 帧 / ${ms} ms`);
  check('弓在整局里被反复画出（不是偶尔才画一次）', drawn > 100, `${drawn} 次`);
  check('渲染速度可接受（整局 < 3 秒）', ms < 3000, `${ms} ms`);
}

/* ============ 10. 美术配置 ============ */
console.log('\n【10】美术配置（assets/src → tools/make-bow-sprites.mjs → assets/characters）');
{
  const bow = SPECIES_BY_ID.taoyao.bow;
  check('桃夭挂了弓配置', !!bow, bow ? '有' : '无');
  check('平时 / 拉弓 两张图都指向 assets/characters',
    !!bow.idle && !!bow.draw &&
    bow.idle.includes('assets/characters/') && bow.draw.includes('assets/characters/'),
    `${bow.idle} / ${bow.draw}`);
  /* 两张弓帧必须来自同一块统一画布 —— 原始两张图的宽度差 40px，
     不统一的话换图时弓会横跳。这里用"文件名由同一个工具产出"来守。 */
  check('两张弓帧是同一套命名（说明出自同一个规整步骤）',
    /bow_idle\.png$/.test(bow.idle) && /bow_draw\.png$/.test(bow.draw),
    'taoyao_bow_idle.png / taoyao_bow_draw.png');
  check('射箭那一帧的状态有定义（shot 留空 = 回退成平时）',
    bow.shot === null || typeof bow.shot === 'string',
    bow.shot === null ? 'null（用 idle）' : bow.shot);

  check('锚点 / 搭箭点都是 0~1 的有限数',
    [bow.anchor.x, bow.anchor.y, bow.nock.x, bow.nock.y]
      .every(v => Number.isFinite(v) && v >= 0 && v <= 1),
    `anchor(${bow.anchor.x}, ${bow.anchor.y}) nock(${bow.nock.x}, ${bow.nock.y})`);
  /* 球心必须和搭箭点同高，否则箭会从球的旁边射出去 */
  check('球心（anchor.y）与搭箭点（nock.y）同高',
    Math.abs(bow.anchor.y - bow.nock.y) < 0.01,
    `anchor.y ${bow.anchor.y} vs nock.y ${bow.nock.y}`);
  /* 尺寸：弓必须比球高，否则弓臂伸不出球外，等于没有 */
  check('弓比球高（弓臂能伸出球外）', bow.bowH > SPECIES_BY_ID.taoyao.r * 2,
    `bowH ${bow.bowH} > 球直径 ${SPECIES_BY_ID.taoyao.r * 2}`);
  check('箭长比例是有限正数', Number.isFinite(bow.arrowLenFrac) && bow.arrowLenFrac > 0,
    String(bow.arrowLenFrac));
  check('五连发的扇形参数完整（总共几发 + 张角的一半）',
    bow.burst && Number.isFinite(bow.burst.count) && bow.burst.count >= 2 &&
    Number.isFinite(bow.burst.spreadDeg) && bow.burst.spreadDeg > 0,
    bow.burst ? `共 ${bow.burst.count} 发，最大张角 ±${bow.burst.spreadDeg}°` : '无');
  /* 扇形参数必须和技能里的五连发一致 —— 画扇形就是为了预告弹道，
     两边各写一套数迟早会漂（这次收尾就是发现它们差了整整一倍）。 */
  {
    const RONG = TAOYAO.rong;
    const wantDeg = (RONG.burstSpread * 180) / Math.PI;
    check('弓配置的扇形与技能的五连发一致（数量 / 张角）',
      bow.burst.count === RONG.burstCount && Math.abs(bow.burst.spreadDeg - wantDeg) < 0.1,
      `弓 ${bow.burst.count} 发 ±${bow.burst.spreadDeg}° vs 技能 ${RONG.burstCount} 发 ±${wantDeg.toFixed(2)}°`);
  }
  check('箭矢贴图也配了', !!bow.arrow, bow.arrow || '无');

  const stats = makeUnitStats('taoyao');
  check('makeUnitStats 把弓带进了单位属性', !!stats.bow, stats.bow ? '有' : '无');
  check('没配弓的球种不受影响', !makeUnitStats('test').bow);
  const b = mk(['taoyao_rong']);
  check('装了映霞的球身上挂着弓', !!b.units[0].bow);
  /* 没装瞄准类技能的球不该举着弓 —— 这是引擎在 _initUnitSkills 里判的 */
  const b2 = mk(['taoyao_top']);
  check('只装陀螺的球不拿弓（没装映霞就放下）', !b2.units[0].bow,
    b2.units[0].bow ? '还挂着' : 'null');
  const b3 = mk(['taoyao_chunjing']);
  check('只装春景的球也不拿弓（光炮不是弓箭）', !b3.units[0].bow,
    b3.units[0].bow ? '还挂着' : 'null');
}

console.log('\n' + log.join('\n'));
console.log(`\n=========== 通过 ${pass} 项，失败 ${fail} 项 ===========`);
process.exit(fail ? 1 : 0);

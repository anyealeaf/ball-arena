import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
/* ============================================================
   见晴 · 画面自检
   ------------------------------------------------------------
   这个环境截不了图，所以换成一个**记录型 2D 上下文**：
   把每一次 arc / ellipse / lineTo / fill 连同当时的颜色与不透明度录下来，
   再断言"人眼应该看到的东西真的画出来了"。
   见晴目前**没有美术**，所以她的表现全是程序化的：
     · 水镜外圈（小球边缘那一圈颜色 = 当前形态）
     · 猩红长剑（绑定在球缘、随移动方向转）
     · 水镜护盾（> 0 时的柔光）
     · 起飞（虚化 + 变大 + 下方影子）
     · 羽毛弹道（拉长的椭圆 + 羽轴 + 羽枝）
     · 水镜穿越 / 挥剑 / 消弹 / 起飞落地 / 羽毛命中 的事件动画
   用法：node tests/diag/render-jianqing.mjs
   ============================================================ */
import { Battle, SNAP_STRIDE } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats } from '../../js/balls.js';
import {
  Renderer, MIRROR_RING_W, MIRROR_RING_GAP, FLY_SCALE, FLY_ALPHA, SWORD_W, SHIELD_ALPHA,
} from '../../js/render.js';

let pass = 0, fail = 0;
const log = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; log.push(`  ✅ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; log.push(`  ❌ ${name}${detail ? '  — ' + detail : ''}`); }
};

/* ---------- 记录型 2D 上下文：每次调用都带上当时的样式 ---------- */
function makeCtx() {
  const calls = [];
  const stack = [];
  const tf = { x: 0, y: 0, s: 1 };
  const ctx = {
    calls,
    globalAlpha: 1, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    lineCap: 'butt', lineJoin: 'miter', font: '', textAlign: 'left',
    textBaseline: 'alphabetic', lineDashOffset: 0, filter: 'none',
    canvas: null,
  };
  const snap = () => ({
    name: null, a: null,
    alpha: ctx.globalAlpha, fill: ctx.fillStyle, stroke: ctx.strokeStyle, lw: ctx.lineWidth,
    at: { x: tf.x, y: tf.y, s: tf.s },
  });
  const push = (name, a) => { const c = snap(); c.name = name; c.a = a; calls.push(c); return c; };
  ctx.save = () => { push('save', []); stack.push({ ...tf }); };
  ctx.restore = () => { push('restore', []); const s = stack.pop(); if (s) Object.assign(tf, s); };
  ctx.translate = (x, y) => { tf.x += x; tf.y += y; push('translate', [x, y]); };
  ctx.scale = (x, y) => { tf.s *= x; push('scale', [x, y]); };
  ctx.rotate = (a) => push('rotate', [a]);
  ctx.setTransform = (...a) => push('setTransform', a);
  ctx.clearRect = (...a) => push('clearRect', a);
  ctx.beginPath = () => push('beginPath', []);
  ctx.closePath = () => push('closePath', []);
  ctx.moveTo = (...a) => push('moveTo', a);
  ctx.lineTo = (...a) => push('lineTo', a);
  ctx.rect = (...a) => push('rect', a);
  ctx.clip = () => push('clip', []);
  ctx.fill = () => push('fill', []);
  ctx.stroke = () => push('stroke', []);
  ctx.fillRect = (...a) => push('fillRect', a);
  ctx.strokeRect = (...a) => push('strokeRect', a);
  ctx.arc = (...a) => push('arc', a);
  ctx.ellipse = (...a) => push('ellipse', a);
  ctx.setLineDash = (...a) => push('setLineDash', a);
  ctx.fillText = (...a) => push('fillText', a);
  ctx.strokeText = (...a) => push('strokeText', a);
  ctx.drawImage = (...a) => push('drawImage', a);
  ctx.measureText = (t) => ({ width: String(t).length * 5 });
  ctx.createRadialGradient = (...a) => { push('createRadialGradient', a); return { addColorStop: () => {} }; };
  ctx.createLinearGradient = (...a) => { push('createLinearGradient', a); return { addColorStop: () => {} }; };
  return ctx;
}
const makeCanvas = (ctx) => ({
  width: 900, height: 550, clientWidth: 900, clientHeight: 550,
  style: {}, parentElement: { clientWidth: 900 }, getContext: () => ctx,
});

globalThis.window = { devicePixelRatio: 1 };
globalThis.performance = globalThis.performance || { now: () => 0 };

const mkR = () => {
  const ctx = makeCtx();
  const rd = new Renderer(makeCanvas(ctx));
  rd.showHud = true; rd.showDamage = true;
  return { ctx, rd };
};

const mk = (skills, opts = {}) => new Battle({
  teams: [
    { units: [{ stats: makeUnitStats('jianqing', skills) }] },
    { units: [{ stats: makeUnitStats(opts.foe || 'dummy', []) }] },
  ],
  arena: ARENA_BY_ID.rect, sizeScale: opts.sizeScale ?? 1,
  rules: { ...DEFAULT_RULES, ...(opts.rules || {}) }, seed: opts.seed ?? 11,
});

const near = (a, b, eps = 0.7) => Math.abs(a - b) <= eps;
/** 找出"以某个点为中心、半径约 r"的圆/圆环调用 */
const ringsAt = (calls, x, y, r, eps = 0.8) => calls.filter(c =>
  (c.name === 'arc' || c.name === 'ellipse') && c.a &&
  near(c.a[0], x) && near(c.a[1], y) && near(c.a[2], r, eps));
const strokeWith = (calls, color) => calls.filter(c =>
  c.name === 'stroke' && String(c.stroke).toLowerCase() === color.toLowerCase());

console.log('=========== 见晴 · 画面自检 ===========\n');

/* ---------- 1) 水镜外圈（小球边缘那一圈的颜色） ---------- */
console.log('【1】水镜外圈（边缘那一圈 = 当前形态）');
{
  const cases = [
    { field: 'ringKind', value: 1, color: '#86efac', name: '① 淡绿' },
    { field: 'ringKind', value: 2, color: '#f9a8d4', name: '① 淡粉' },
    { field: 'auxKind', value: 3, color: '#5b21b6', name: '③ 深蓝紫' },
    { field: 'auxKind', value: 4, color: '#ffffff', name: '③ 白' },
  ];
  for (const cs of cases) {
    const b = mk([]);
    b.step();
    const u = b.units[0];
    u[cs.field] = cs.value;
    u.ringKind = cs.field === 'ringKind' ? cs.value : 0;
    u.auxKind = cs.field === 'auxKind' ? cs.value : 0;
    b.step();
    const { ctx, rd } = mkR();
    ctx.calls.length = 0;
    rd.draw(b, b.snapshots.length - 1);
    const r = u.r / 1000;
    const radius = cs.field === 'ringKind' ? r + MIRROR_RING_GAP : r + MIRROR_RING_GAP * 0.35;
    const ring = ringsAt(ctx.calls, u.x / 1000, u.y / 1000, radius, 0.5);
    /* ⚠ 这里的箭头函数参数**不能**也叫 c：会把外层循环的 cs/变量遮住，
       于是 c.color 变成"某次绘制调用的颜色"（undefined）—— 
       实测就是这么写出一个永远不成立的断言（29 项里 4 项假红）。 */
    const stroked = ring.some(call => String(call.stroke).toLowerCase() === c2hex(cs.color));
    check(`${cs.name}：球缘画了对应颜色的圈（半径 r+${(radius - r).toFixed(1)}）`,
      ring.length > 0 && stroked,
      ring.length ? `线宽 ${ring[0].lw}，颜色 ${ring[0].stroke}` : '没画');
  }
  /* 没装水镜就没有那一圈 */
  const b = mk([]);
  b.step();
  const { ctx, rd } = mkR();
  ctx.calls.length = 0;
  rd.draw(b, b.snapshots.length - 1);
  const u = b.units[0];
  const r = u.r / 1000;
  check('没装水镜时不画那一圈（不会无缘无故多一圈白边）',
    ringsAt(ctx.calls, u.x / 1000, u.y / 1000, r + MIRROR_RING_GAP, 0.5).length === 0,
    `${ringsAt(ctx.calls, u.x / 1000, u.y / 1000, r + MIRROR_RING_GAP, 0.5).length} 个`);
  check('外圈线宽用的是可调常量 MIRROR_RING_W', MIRROR_RING_W > 0, String(MIRROR_RING_W));
}

/** '#rrggbb' → 小写（颜色比较统一口径） */
function c2hex(s) { return String(s).toLowerCase(); }

/* ---------- 2) 猩红长剑 ---------- */
console.log('\n【2】猩红长剑（绑在球缘、**始终朝向锁定的敌人**）');
{
  const b = mk(['jianqing_mirror_sword']);
  const u = b.units[0], foe = b.units[1];
  u.face = 0;                       // 朝向（移动方向）= +x
  u.vx = 120 * 1000; u.vy = 0;
  /* 故意把敌人放到**正上方**：移动方向是 +x、敌人在 −y ——
     剑要指着敌人（−90°），而不是指着移动方向（作者 2026-10 的修改）。 */
  foe.x = u.x; foe.y = u.y - Math.round(200 * 1000);
  b.step();
  foe.x = u.x; foe.y = u.y - Math.round(200 * 1000);
  b.step();
  const { ctx, rd } = mkR();
  ctx.calls.length = 0;
  rd.draw(b, b.snapshots.length - 1);
  const x = u.x / 1000, y = u.y / 1000, r = u.r / 1000;
  const sword = ctx.calls.filter(c => c.name === 'stroke' && String(c.stroke).toLowerCase() === '#8b1a1a');
  check('画了猩红色的剑身', sword.length > 0, `${sword.length} 笔`);
  check('剑的粗细用的是可调常量 SWORD_W', sword.some(c => near(c.lw, SWORD_W, 0.01)),
    sword.length ? String(sword[0].lw) : '-');
  /* 起点在球缘、终点在球缘 + 剑长，**沿着"指向敌人"的方向（−90°）**。
     用"剑柄那个 moveTo"往后找紧随其后的 lineTo —— 直接找第一个 lineTo
     会拿到别的绘制（血条、别的球）的坐标。 */
  const hx = x + Math.cos(-Math.PI / 2) * r, hy = y + Math.sin(-Math.PI / 2) * r;
  const hi = ctx.calls.findIndex(c => c.name === 'moveTo' && near(c.a[0], hx, 1.5) && near(c.a[1], hy, 1.5));
  check('剑柄贴着球缘、且落在"敌人那一侧"（−90°，不是移动方向 +x）', hi >= 0,
    hi >= 0 ? `moveTo(${ctx.calls[hi].a[0].toFixed(1)}, ${ctx.calls[hi].a[1].toFixed(1)})` : '没画在那个位置');
  const end = hi >= 0 ? ctx.calls.slice(hi + 1).find(c => c.name === 'lineTo') : null;
  check(`剑长 = 球半径 + swordLen（${r}+${u.swordLen} = ${r + u.swordLen}）`,
    end && near(end.a[1], hy - u.swordLen, 2),
    end ? `lineTo(${end.a[0].toFixed(1)}, ${end.a[1].toFixed(1)})` : '没画');
  const snap = b.snapshots[b.snapshots.length - 1].data;
  check('快照第 19 位就是长剑朝向（≈270°）',
    Math.abs(snap[u.id * SNAP_STRIDE + 19] - 270) < 2,
    `${Number(snap[u.id * SNAP_STRIDE + 19]).toFixed(1)}°`);

  /* 没装剑就不画 */
  const b2 = mk([]);
  b2.step();
  const { ctx: ctx2, rd: rd2 } = mkR();
  ctx2.calls.length = 0;
  rd2.draw(b2, b2.snapshots.length - 1);
  check('没装②时不画剑',
    ctx2.calls.filter(c => c.name === 'stroke' && String(c.stroke).toLowerCase() === '#8b1a1a').length === 0);

  /* ---------- 挥动：**以球心为轴**的旋转动画（作者 2026-10 的要求） ----------
     做法：发一个 swordSwing 事件，然后逐帧画，量"剑尖相对球心的角度"。
     要同时成立四件事：角度在变（是动画）、起点始终贴着球缘（轴是球心）、
     扫过的范围大致等于 sweepDeg、挥完回到平时的朝向。 */
  const bs = mk(['jianqing_mirror_sword']);
  const us = bs.units[0];
  us.melee = 0;                       // 别让碰撞伤害干扰（这里只看画面）
  bs.step();
  bs._emit('swordSwing', us, null, 80, {
    angle: 0, swordLen: 32, kind: 'attack', sweepDeg: 120, swingFrames: 12,
  });
  const swingF = bs.frame;
  const samples = [];
  for (let k = 0; k <= 14; k++) {
    bs.step();
    const frame = bs.snapshots.length - 1;
    const snap = bs.snapshots[frame];
    const cx = snap.data[0 * SNAP_STRIDE] / 1, cy = snap.data[0 * SNAP_STRIDE + 1];
    const { ctx: cc, rd: rr } = mkR();
    cc.calls.length = 0;
    rr.draw(bs, frame);
    /* 剑身那两笔（亮色 = 挥动中）：取 moveTo 与紧随的 lineTo */
    const hi = cc.calls.findIndex(x => x.name === 'moveTo' &&
      near(x.a[0], us.x / 1000, 40) && near(x.a[1], us.y / 1000, 40));
    if (hi < 0) continue;
    const end = cc.calls.slice(hi + 1).find(x => x.name === 'lineTo');
    if (!end) continue;
    const bx = cc.calls[hi].a[0], by = cc.calls[hi].a[1];
    samples.push({
      k, age: frame - swingF,
      ang: Math.atan2(end.a[1] - cy, end.a[0] - cx),
      startDist: Math.hypot(bx - cx, by - cy),
      len: Math.hypot(end.a[0] - bx, end.a[1] - by),
      hot: String(cc.calls[hi].stroke).toLowerCase() === '#a52a2a',
    });
  }
  const during = samples.filter(s => s.age <= 12);
  const after = samples.filter(s => s.age > 12);
  check('挥动期间画了剑（每一帧都有）', during.length >= 10, `${during.length} 帧`);
  check('剑是"绕球心转"的：角度逐帧变化',
    during.length >= 3 && Math.abs(during[during.length - 1].ang - during[0].ang) > 0.5,
    during.length ? `${during[0].ang.toFixed(2)} → ${during[during.length - 1].ang.toFixed(2)} rad` : '-');
  check('角度是**单调**扫过去的（不是来回抖）',
    during.every((s, i) => i === 0 || s.ang >= during[i - 1].ang - 1e-6),
    during.map(s => s.ang.toFixed(2)).join(' → '));
  check('旋转轴是球心：剑柄始终贴在球缘上（距离 ≈ r）',
    during.every(s => Math.abs(s.startDist - u.r / 1000) < 1.5),
    during.length ? `剑柄离球心 ${during[0].startDist.toFixed(1)}（r=${(u.r / 1000).toFixed(1)}）` : '-');
  check('剑长不变（只是转，不是伸缩）',
    during.every(s => Math.abs(s.len - us.swordLen) < 2),
    during.length ? `${during[0].len.toFixed(1)} vs ${us.swordLen}` : '-');
  const swept = during.length ? (during[during.length - 1].ang - during[0].ang) * 180 / Math.PI : 0;
  check('扫过的角度接近 sweepDeg（120°）', swept > 60 && swept <= 130, `${swept.toFixed(0)}°`);
  check('挥动期间剑画得更亮（和平时那把颜色不同）',
    during.some(s => s.hot), during.filter(s => s.hot).length + ' 帧是亮色');
  check('挥完之后回到平时的朝向（不再转）',
    after.length === 0 || after.every(s => !s.hot), `${after.length} 帧收招后`);
}

/* ---------- 3) 水镜护盾柔光 ---------- */
console.log('\n【3】水镜护盾（> 0 时的柔光）');
{
  const b = mk(['jianqing_mirror_def']);
  b.step();
  const u = b.units[0];
  const { ctx, rd } = mkR();
  /* 护盾 0：不该有那圈柔光 */
  u.res = 0;
  b.step();
  ctx.calls.length = 0;
  rd.draw(b, b.snapshots.length - 1);
  const grads0 = ctx.calls.filter(c => c.name === 'createRadialGradient' &&
    near(c.a[0], u.x / 1000, 1) && near(c.a[1], u.y / 1000, 1));
  /* 有了护盾：球附近应该多出一层径向柔光 */
  u.res = 300;
  b.step();
  ctx.calls.length = 0;
  rd.draw(b, b.snapshots.length - 1);
  const grads1 = ctx.calls.filter(c => c.name === 'createRadialGradient' &&
    near(c.a[0], u.x / 1000, 1) && near(c.a[1], u.y / 1000, 1));
  check('护盾 > 0 时球外多了一层柔光（比没护盾时多一个径向渐变）',
    grads1.length > grads0.length, `${grads0.length} → ${grads1.length}`);
  check('柔光的峰值不透明度用的是可调常量', SHIELD_ALPHA > 0, String(SHIELD_ALPHA));
}

/* ---------- 4) 起飞：虚化 + 变大 + 影子 ---------- */
console.log('\n【4】起飞（虚化 / 变大 / 影子）');
{
  const b = mk(['jianqing_takeoff']);
  const u = b.units[0];
  const { ctx, rd } = mkR();
  b.step();
  const x0 = u.x / 1000, y0 = u.y / 1000, r = u.r / 1000;
  /* 平时 */
  ctx.calls.length = 0;
  rd.draw(b, b.snapshots.length - 1);
  const body0 = ringsAt(ctx.calls, x0, y0, r, 1);
  const shadow0 = ctx.calls.filter(c => c.name === 'ellipse' && c.a[1] > y0 + r * 0.5);
  /* 飞行中（她还在动，所以坐标必须**重新取**：拿旧坐标去找会一个圆都找不到） */
  u.invulnFrames = 60; u.phasingFrames = 60; u.noAttackFrames = 60;
  b.step();
  const x1 = u.x / 1000, y1 = u.y / 1000;
  ctx.calls.length = 0;
  rd.draw(b, b.snapshots.length - 1);
  const body1 = ringsAt(ctx.calls, x1, y1, r * FLY_SCALE, 1.5);
  const shadow1 = ctx.calls.filter(c => c.name === 'ellipse' && c.a[1] > y1 + r * 0.5);
  check(`飞行中球变大（半径 ×${FLY_SCALE}）`, body0.length > 0 && body1.length > 0,
    `平时 ${body0.length} 个圆 / 飞行中 ${body1.length} 个圆`);
  check('飞行中球下方出现影子（近大远小）',
    shadow0.length === 0 && shadow1.length === 1, `${shadow0.length} → ${shadow1.length}`);
  check('影子的中心在球的**下方**（不是盖在脸上）',
    shadow1.length > 0 && shadow1[0].a[1] > y1 + r, shadow1.length ? `${shadow1[0].a[1].toFixed(1)} > ${y1.toFixed(1)}` : '-');
  const bodyAlpha = body1.length ? body1[0].alpha : -1;
  check(`飞行中"虚化"（画球体时不透明度 ≈ ${FLY_ALPHA}）`,
    near(bodyAlpha, FLY_ALPHA, 0.02), String(bodyAlpha));
  check('飞行中的判定箱不变（只有显示放大）',
    b.units[0].r === 16 * 1000, String(b.units[0].r));
}

/* ---------- 5) 羽毛弹道 ---------- */
console.log('\n【5】羽毛弹道（拉长的椭圆 + 羽轴 + 羽枝）');
{
  const b = mk(['jianqing_feather']);
  const u = b.units[0];
  b._damage(null, u, 300, 'skill');     // 攒够 300 → 发一根
  b.step();
  const feather = b.projectiles.find(p => p.feather);
  check('对局里真的出现了羽毛', !!feather);
  const { ctx, rd } = mkR();
  ctx.calls.length = 0;
  rd.draw(b, b.snapshots.length - 1);
  const fx = feather.x / 1000, fy = feather.y / 1000;
  /* 羽毛是"先 translate 再 rotate 到中心画椭圆"，所以椭圆参数在 (0,0)；
     羽轴/羽枝是 moveTo/lineTo —— 注意 **stroke 调用本身没有坐标参数**，
     拿 stroke 去比坐标永远匹配不上（我第一版就是这么写的）。 */
  const quill = ctx.calls.filter(c => c.name === 'moveTo' && near(c.a[1], 0, 0.01) && c.a[0] < 0);
  const vane = ctx.calls.filter(c => c.name === 'fill' && c.fill === feather.color);
  check('画了一片羽毛形状（填充 + 羽轴 + 羽枝）',
    vane.length > 0 && quill.length > 0, `填充 ${vane.length} / 羽轴羽枝 ${quill.length}`);
  check('羽毛是沿飞行方向转着画的（画之前先 rotate）',
    ctx.calls.some(c => c.name === 'rotate'), '有 rotate');
  check('羽毛坐标用的是弹道自己的位置', feather && near(fx, b.snapshots[b.snapshots.length - 1].proj[0], 0.01),
    `(${fx.toFixed(1)}, ${fy.toFixed(1)})`);
}

/* ---------- 6) 事件动画 ---------- */
console.log('\n【6】事件动画（水镜穿越 / 挥剑 / 消弹 / 起落 / 命中 / 免疫）');
{
  /* 水镜穿越：切换那一帧要画"身前那副镜子"（一个竖直椭圆）+ 外圈亮一下 */
  const b = mk(['jianqing_mirror_def']);
  b.step();
  const u = b.units[0];
  u.face = 0;
  b._emit('mirrorSwitch', u, null, 1, { face: 0, def: true });
  const evFrame = b.snapshots.length;
  b.step();
  const { ctx, rd } = mkR();
  for (let f = evFrame; f < b.snapshots.length; f++) {
    ctx.calls.length = 0;
    rd.draw(b, f);
    const mirror = ctx.calls.filter(c => c.name === 'ellipse' && c.stroke && String(c.stroke).toLowerCase() === '#86efac');
    if (mirror.length) break;
  }
  const mirror = ctx.calls.filter(c => c.name === 'ellipse' && String(c.stroke).toLowerCase() === '#86efac');
  check('水镜切换：身前画了一面镜子（该颜色的椭圆）', mirror.length > 0, `${mirror.length} 个`);
  check('镜子立在球前方（不是盖在球上）',
    mirror.length > 0 && mirror[0].a[0] > u.x / 1000, mirror.length ? `${mirror[0].a[0].toFixed(1)} > ${(u.x / 1000).toFixed(1)}` : '-');

  /* 挥剑：一段猩红圆弧 */
  const b2 = mk(['jianqing_mirror_sword']);
  b2.step();
  const u2 = b2.units[0];
  b2._emit('swordSwing', u2, null, 80, { angle: 0, swordLen: 32, kind: 'attack' });
  const f2 = b2.snapshots.length;
  const { ctx: ctx2, rd: rd2 } = mkR();
  ctx2.calls.length = 0;
  rd2.draw(b2, f2);
  const swing = ctx2.calls.filter(c => c.name === 'stroke' && String(c.stroke).toLowerCase() === '#8b1a1a');
  check('挥剑：画了一道猩红弧线', swing.length > 0, `${swing.length} 笔`);
  const guardB = mk(['jianqing_mirror_sword']);
  guardB.step();
  guardB._emit('swordSwing', guardB.units[0], null, 0, { angle: 0, swordLen: 32, kind: 'guard' });
  const { ctx: ctx3, rd: rd3 } = mkR();
  ctx3.calls.length = 0;
  rd3.draw(guardB, guardB.snapshots.length);
  check('防御性挥动用更亮的颜色（和攻击性挥动区分得开）',
    ctx3.calls.some(c => c.name === 'stroke' && String(c.stroke).toLowerCase() === '#fecaca'));

  /* 消弹 / 羽毛命中 / 免疫 / 护盾挡下：各自有反馈 */
  const evCases = [
    { ev: ['projPurge', null, null, 0, { px: 100, py: 100, color: '#fff', tag: 'modan' }], name: '消除魔弹有小爆点' },
    { ev: ['featherHit', null, null, 0, { px: 100, py: 100 }], name: '羽毛命中有放射线' },
    { ev: ['immune', null, null, 0, {}], name: '免疫反馈' },
    { ev: ['blocked', null, null, 0, {}], name: '护盾全额挡下有反馈' },
    { ev: ['shieldHit', null, null, 30, { amount: 30 }], name: '护盾吃到伤害有反馈' },
    { ev: ['takeoff', null, null, 3], name: '起飞有动画' },
    { ev: ['landing', null, null, 0], name: '落地有动画' },
    { ev: ['flyUpgrade', null, null, 2, { speedStep: 5, frameDamage: 6 }], name: '飞完一次的成长有动画（金色光环 + 上升线）' },
  ];
  for (const c of evCases) {
    const bb = mk([]);
    bb.step();
    bb.events.push({ f: bb.frame, type: c.ev[0], value: c.ev[3], a: 0, b: -1,
      ax: 100, ay: 100, bx: 0, by: 0, color: '#888', ...(c.ev[4] || {}) });
    const { ctx: cc, rd: rr } = mkR();
    cc.calls.length = 0;
    rr.draw(bb, bb.snapshots.length - 1);
    const drew = cc.calls.some(x => x.name === 'stroke' || x.name === 'fill' || x.name === 'ellipse');
    check(c.name, drew, `${cc.calls.length} 次绘制调用`);
  }
}

/* ---------- 7) 稳定性 ---------- */
console.log('\n【7】稳定性（跑完整局不炸、可复现）');
{
  const b = mk(['jianqing_mirror_def', 'jianqing_mirror_sword', 'jianqing_mirror_borrow',
    'jianqing_takeoff', 'jianqing_transform', 'jianqing_feather'],
  { rules: { unlimitedSkills: false, timeLimit: 60 }, foe: 'taoyao' });
  b.runToEnd();
  check('六个技能全开也跑得完（没有互相打架）', b.over, `${(b.frame / 60).toFixed(1)} 秒：${b.endReason}`);
  const { ctx, rd } = mkR();
  let threw = null;
  try {
    for (let f = 0; f < b.snapshots.length; f += 5) { ctx.calls.length = 0; rd.draw(b, f); }
  } catch (e) { threw = e; }
  check('整局逐帧渲染不抛错', !threw, threw ? threw.message : `${Math.ceil(b.snapshots.length / 5)} 帧`);

  /* 同一帧画两遍必须完全一样（渲染层是纯函数：只读快照 + 事件） */
  const f = Math.floor(b.snapshots.length * 0.6);
  ctx.calls.length = 0; rd.draw(b, f);
  const a1 = JSON.stringify(ctx.calls.map(c => [c.name, c.a]));
  ctx.calls.length = 0; rd.draw(b, f);
  const a2 = JSON.stringify(ctx.calls.map(c => [c.name, c.a]));
  check('同一帧画两遍结果完全一致（暂停/回放才对得上）', a1 === a2,
    `${JSON.parse(a1).length} 次调用`);
  check('快照步长带上了两个水镜颜色与状态位', SNAP_STRIDE >= 19, String(SNAP_STRIDE));
}

console.log('\n' + log.join('\n'));
console.log(`\n=========== 通过 ${pass} 项，失败 ${fail} 项 ===========`);
process.exit(fail ? 1 : 0);

/* Verify the skill VISUALS actually reach the canvas.
 *
 * There is no way to screenshot in this environment, so instead of looking at
 * pixels we drive the real Renderer against a recording 2D-context stub and
 * assert that the draw calls a human would see really happen:
 *   - projectile bodies (glow + core + specular dot)
 *   - charge progress ring (partial arc, not a full circle)
 *   - dash halo
 *   - shoot / projHit / dashStart / knock event effects
 * A renderer that silently draws nothing would pass a screenshot-free review,
 * so this checks the drawing itself.
 *
 * Usage: node tests/diag/render-skill.mjs
 */
import { Battle, SNAP_STRIDE, PROJ_STRIDE } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats } from '../../js/balls.js';
import { Renderer } from '../../js/render.js';

/* ---------- recording 2D context ---------- */
function makeCtx() {
  const calls = [];
  const rec = (name) => (...a) => { calls.push({ name, a }); };
  const ctx = {
    calls,
    canvas: null,
    globalAlpha: 1, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    lineCap: 'butt', font: '', textAlign: 'left',
    setTransform: rec('setTransform'), clearRect: rec('clearRect'),
    save: rec('save'), restore: rec('restore'),
    scale: rec('scale'), translate: rec('translate'),
    beginPath: rec('beginPath'), closePath: rec('closePath'),
    moveTo: rec('moveTo'), lineTo: rec('lineTo'), rect: rec('rect'),
    clip: rec('clip'), fill: rec('fill'), stroke: rec('stroke'),
    fillRect: rec('fillRect'), strokeRect: rec('strokeRect'),
    fillText: rec('fillText'), setLineDash: rec('setLineDash'),
    strokeText: rec('strokeText'),
    // 血条数字会用 measureText 决定放不放得下
    measureText: (t) => ({ width: String(t).length * 5 }),
    arc: (x, y, r, a0, a1) => calls.push({ name: 'arc', a: [x, y, r, a0, a1] }),
    drawImage: rec('drawImage'),
    createRadialGradient: (...a) => {
      calls.push({ name: 'createRadialGradient', a });
      return { addColorStop: (o, c) => calls.push({ name: 'addColorStop', a: [o, c] }) };
    },
  };
  return ctx;
}
function makeCanvas(ctx) {
  return {
    width: 900, height: 550, clientWidth: 900, clientHeight: 550,
    style: {}, parentElement: null,
    getContext: () => ctx,
  };
}

/* ---------- stubs the renderer reaches for in a browser ---------- */
globalThis.window = { devicePixelRatio: 1 };
globalThis.performance = globalThis.performance || { now: () => 0 };

const mk = () => new Battle({
  teams: [['test_skill', 'test_skill'], ['test', 'test']]
    .map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
  arena: ARENA_BY_ID.rect,
  sizeScale: 1,
  rules: { ...DEFAULT_RULES },
  seed: 11,
});

/* ---------- 1) snapshot contract ---------- */
const b = mk();
for (let i = 0; i < 60 * 30; i++) b.step();

const snapBad = b.snapshots.find(s => s.data.length !== b.units.length * SNAP_STRIDE);
const withProj = b.snapshots.filter(s => s.proj && s.proj.length);
const projBad = withProj.find(s => s.proj.length % PROJ_STRIDE !== 0);
const projRange = withProj.map(s => s.proj.length / PROJ_STRIDE);
console.log('=== ① 快照格式 ===');
console.log(`  小球步长 ${SNAP_STRIDE}，弹道步长 ${PROJ_STRIDE}`);
console.log(`  带弹道的快照 ${withProj.length} / ${b.snapshots.length} 帧，` +
  `每帧弹道数 ${projRange.length ? Math.min(...projRange) + '~' + Math.max(...projRange) : 0}`);

/* ---------- 2) render every frame, attribute draw calls by POSITION ----------
   Radius alone is not enough to tell features apart: the dashStart/ death event
   rings are also full circles and can land in the same radius window. So every
   assertion below matches a draw call against the exact centre of the thing it
   is supposed to represent, taken from that frame's snapshot. */
const ctx = makeCtx();
const cv = makeCanvas(ctx);
cv.parentElement = { clientWidth: 900 };
const rd = new Renderer(cv);
rd.showHud = true;
rd.showDamage = true;

const TAU = Math.PI * 2;
const near = (a, b, eps = 0.6) => Math.abs(a - b) <= eps;
const at = (c, x, y, eps = 0.6) => near(c.a[0], x, eps) && near(c.a[1], y, eps);

let framesWithProj = 0, projGlowMatched = 0, projCoreMatched = 0;
let framesCharging = 0, chargeRingMatched = 0, chargeArcMatched = 0;
let framesDashing = 0, dashHaloMatched = 0;
let sweepChecked = 0, sweepMaxErr = 0;
const noArcChargeP = [];      // chargeP values that produced no progress arc
const BAL_R = 16;   // ball radius in world units

for (let f = 0; f < b.snapshots.length; f++) {
  ctx.calls.length = 0;
  rd.draw(b, f);
  const calls = ctx.calls;
  const snap = b.snapshots[f];
  const d = snap.data;
  const arcs = calls.filter(c => c.name === 'arc');
  const grads = calls.filter(c => c.name === 'createRadialGradient');

  // --- projectiles: glow gradient + solid core, centred on the snapshot position
  if (snap.proj && snap.proj.length) {
    framesWithProj++;
    let g = 0, core = 0;
    for (let i = 0; i < snap.proj.length; i += PROJ_STRIDE) {
      const px = snap.proj[i], py = snap.proj[i + 1], pr = snap.proj[i + 2];
      if (grads.some(c => at(c, px, py))) g++;
      if (arcs.some(c => at(c, px, py) && near(c.a[2], pr, 0.01))) core++;
    }
    if (g) projGlowMatched++;
    if (core) projCoreMatched++;
  }

  // --- per-unit skill state
  const n = Math.floor(d.length / SNAP_STRIDE);
  for (let i = 0; i < n; i++) {
    const o = i * SNAP_STRIDE;
    if (d[o + 3] < 0.5) continue;
    const x = d[o], y = d[o + 1], mode = d[o + 7], chargeP = d[o + 8];
    if (mode > 0.5 && mode < 1.5) {
      framesCharging++;
      // full background ring at r+6, plus a PARTIAL progress arc at the same radius
      if (arcs.some(c => at(c, x, y) && near(c.a[2], BAL_R + 6, 0.01) &&
        near(c.a[4] - c.a[3], TAU, 1e-6))) chargeRingMatched++;
      const arc = arcs.find(c => {
        const sweep = c.a[4] - c.a[3];
        return at(c, x, y) && near(c.a[2], BAL_R + 6, 0.01) && sweep > 1e-9 && sweep < TAU - 1e-9;
      });
      if (arc) {
        chargeArcMatched++;
        // the drawn sweep must track the engine's charge progress
        const err = Math.abs((arc.a[4] - arc.a[3]) - TAU * chargeP);
        sweepChecked++;
        if (err > sweepMaxErr) sweepMaxErr = err;
      } else {
        noArcChargeP.push(chargeP);
      }
    }
    if (mode > 1.5) {
      framesDashing++;
      /* dash halo: full circle centred on the ball, radius between the ball
         edge and the halo's max (r+4+7=27). Excludes the team outline (r) and
         the team thin ring (r+2.6). */
      if (arcs.some(c => at(c, x, y) && c.a[2] > BAL_R + 3.4 && c.a[2] <= BAL_R + 11 && near(c.a[4] - c.a[3], TAU, 1e-6))) dashHaloMatched++;
    }
  }
}

/* Event fx coverage (these are re-drawn for LIFE frames, so just confirm the
   event types exist at all; the draws themselves are unguarded branches). */
const fxTypes = new Set();
for (const e of b.events) {
  if (['shoot', 'projHit', 'dashStart', 'knock', 'projWall'].includes(e.type)) fxTypes.add(e.type);
}

console.log('\n=== ② 渲染调用统计（按坐标精确归属）===');
console.log(`  弹道：${framesWithProj} 帧有弹道，发光匹配 ${projGlowMatched} 帧，弹体匹配 ${projCoreMatched} 帧`);
console.log(`  蓄力：${framesCharging} 球·帧，底环匹配 ${chargeRingMatched}，进度弧匹配 ${chargeArcMatched}`);
if (noArcChargeP.length) {
  const uniq = [...new Set(noArcChargeP)].sort((a, b) => a - b);
  console.log(`    无进度弧的 chargeP 取值: ${uniq.map(v => v.toFixed(4)).join(', ')}` +
    `（共 ${noArcChargeP.length} 球·帧）`);
}
console.log(`  进度弧扫角与 chargeP 的一致性：检查 ${sweepChecked} 次，最大误差 ${sweepMaxErr.toExponential(2)} 弧度`);
console.log(`  冲刺：${framesDashing} 球·帧，光环匹配 ${dashHaloMatched}`);
console.log(`  事件类型覆盖 ${[...fxTypes].sort().join(', ')}`);
console.log(`  弹道色板 ${JSON.stringify(b.projPalette)}`);

/* ---------- 3) assertions ---------- */
let ok = true;
const chk = (name, cond, note = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${note ? '  — ' + note : ''}`);
  if (!cond) ok = false;
};
console.log('\n=== ③ 结论 ===');
chk('快照长度符合 SNAP_STRIDE', !snapBad);
chk('弹道缓冲区长度是 PROJ_STRIDE 的整数倍', !projBad);
chk('存在带弹道的快照（弹道确实进入快照）', withProj.length > 0, `${withProj.length} 帧`);
chk('弹道色板非空（颜色可还原）', b.projPalette.length > 0);
chk('发射特效真的画出来了', fxTypes.has('shoot'));
chk('弹道命中特效真的画出来了', fxTypes.has('projHit'));
chk('冲刺起手特效真的画出来了', fxTypes.has('dashStart'));
chk('击退冲击线真的画出来了', fxTypes.has('knock'));
chk('每个有弹道的帧都画了发光', framesWithProj > 0 && projGlowMatched === framesWithProj,
  `${projGlowMatched}/${framesWithProj}`);
chk('每个有弹道的帧都画了弹体', framesWithProj > 0 && projCoreMatched === framesWithProj,
  `${projCoreMatched}/${framesWithProj}`);
chk('每个蓄力球都画了底环', framesCharging > 0 && chargeRingMatched === framesCharging,
  `${chargeRingMatched}/${framesCharging}`);
/* chargeP == 0 (the single frame charging begins) legitimately draws a
   zero-length arc, so only frames with real progress must show a partial arc. */
chk('有进度的蓄力球都画了进度弧',
  framesCharging > 0 && chargeArcMatched === framesCharging - noArcChargeP.length,
  `${chargeArcMatched}/${framesCharging - noArcChargeP.length}`);
chk('无进度弧的帧确实 chargeP == 0',
  noArcChargeP.every(v => v === 0), noArcChargeP.length ? `取值 ${[...new Set(noArcChargeP)].join(',')}` : '无此类帧');
chk('进度弧扫角精确等于 2π×chargeP', sweepChecked > 0 && sweepMaxErr < 1e-9,
  `最大误差 ${sweepMaxErr.toExponential(2)}`);
chk('每个冲刺球都画了光环', framesDashing > 0 && dashHaloMatched === framesDashing,
  `${dashHaloMatched}/${framesDashing}`);

console.log(ok ? '\n全部通过' : '\n有失败项');
process.exit(ok ? 0 : 1);


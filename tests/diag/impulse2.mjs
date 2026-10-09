/* Diagnostic: why is the collision impulse only partially applied?
   Instrument one specific failing case frame by frame.
   (ASCII only.) */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

const b = new Battle({
  teams: [['test', 'test'], ['test', 'test']].map(u =>
    ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
  arena: ARENA_BY_ID['rect'],
  sizeScale: 0.5,
  rules: { ...DEFAULT_RULES },
  seed: 31
});

// 记录 _resolveCollision 的每次调用
const orig = b._resolveCollision.bind(b);
const log = [];
b._resolveCollision = function (A, B, e) {
  const dx = B.x - A.x, dy = B.y - A.y;
  const d = Math.hypot(dx, dy);
  const rr = A.r + B.r;
  if (d >= rr) return orig(A, B, e);       // 不重叠的直接跳过，别记录

  const n = { x: dx / d, y: dy / d };
  const relBefore = ((B.vx - A.vx) * n.x + (B.vy - A.vy) * n.y) / SCALE;
  const vnFixed = Math.round(((B.vx - A.vx) * Math.round(n.x * SCALE) + (B.vy - A.vy) * Math.round(n.y * SCALE)) / SCALE);
  const r = orig(A, B, e);
  const relAfter = ((B.vx - A.vx) * n.x + (B.vy - A.vy) * n.y) / SCALE;
  log.push({ f: b.frame, A: A.id, B: B.id, d: (d / SCALE).toFixed(2),
    relBefore: relBefore.toFixed(1), vnFixed, relAfter: relAfter.toFixed(1) });
  return r;
};

while (!b.over && b.frame < b.maxFrames) b.step();

console.log(`total _resolveCollision calls with overlap: ${log.length}`);
console.log('\nframes where the pair was approaching but did NOT end up separating:');
const bad = log.filter(x => x.relBefore < -8 && x.relAfter <= 0);
console.log(`  count: ${bad.length} / ${log.filter(x => x.relBefore < -8).length} approaching calls`);
for (const x of bad.slice(0, 10)) {
  console.log(`  f=${x.f} #${x.A}->#${x.B} dist=${x.d} relBefore=${x.relBefore} vnFixed=${x.vnFixed} relAfter=${x.relAfter}`);
}

console.log('\nsample of normal calls:');
for (const x of log.filter(y => y.relBefore < -8).slice(0, 6)) {
  console.log(`  f=${x.f} #${x.A}->#${x.B} dist=${x.d} rel ${x.relBefore} -> ${x.relAfter}`);
}

console.log('\n--- how many times is the SAME pair resolved within one frame? ---');
const perFrame = new Map();
for (const x of log) {
  const k = `${x.f}:${Math.min(x.A, x.B)}-${Math.max(x.A, x.B)}`;
  perFrame.set(k, (perFrame.get(k) || 0) + 1);
}
const multi = [...perFrame.entries()].filter(([, v]) => v > 1);
console.log(`  pairs resolved more than once in a frame: ${multi.length}`);
for (const [k, v] of multi.slice(0, 6)) console.log(`    ${k} -> ${v} times`);

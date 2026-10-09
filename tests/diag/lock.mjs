/* Diagnostic: in a clean 1v1, balls stay locked at exactly 32.0 after contact.
   Instrument _resolveCollision for that case.
   (ASCII only.) */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

const b = new Battle({
  teams: [['test'], ['test']].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
  arena: ARENA_BY_ID['rect'],
  sizeScale: 0.5,
  rules: { ...DEFAULT_RULES },
  seed: 7
});

let n = 0;
const orig = b._resolveCollision.bind(b);
b._resolveCollision = function (A, B, e) {
  const dx = B.x - A.x, dy = B.y - A.y;
  const d0 = Math.hypot(dx, dy);
  const rr = A.r + B.r;
  if (d0 >= rr) return orig(A, B, e);

  const before = {
    A: `v(${A.vx},${A.vy})`, B: `v(${B.vx},${B.vy})`,
    d: (d0 / SCALE).toFixed(2)
  };
  const r = orig(A, B, e);
  const d1 = Math.hypot(B.x - A.x, B.y - A.y);
  n++;
  if (n <= 14) {
    const nx = (B.x - A.x) / (d1 || 1), ny = (B.y - A.y) / (d1 || 1);
    const rel = ((B.vx - A.vx) * nx + (B.vy - A.vy) * ny) / SCALE;
    console.log(`call ${n} f=${b.frame} dist ${before.d} -> ${(d1 / SCALE).toFixed(2)}`);
    console.log(`   pre  A=${before.A} B=${before.B}`);
    console.log(`   post A=v(${A.vx},${A.vy}) B=v(${B.vx},${B.vy})`);
    console.log(`   post relative speed along normal = ${rel.toFixed(1)}  ${rel > 0 ? '(separating)' : '(STILL APPROACHING)'}`);
  }
  return r;
};

while (!b.over && b.frame < 6000) b.step();
console.log(`\ntotal resolve calls with overlap: ${n}`);
console.log(`final: frame=${b.frame} reason=${b.endReason}`);

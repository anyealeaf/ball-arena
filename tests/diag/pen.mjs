/* Diagnostic: at end of frame, are there pairs that are DEEPLY overlapping
   while still closing fast? A tiny tangent contact is fine; deep penetration
   with high closing speed means the impulse was missed.
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

const rows = [];
while (!b.over && b.frame < b.maxFrames) {
  b.step();
  const alive = b.units.filter(u => u.alive);
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const A = alive[i], B = alive[j];
      const dx = B.x - A.x, dy = B.y - A.y;
      const d = Math.hypot(dx, dy);
      const rr = A.r + B.r;
      const pen = (rr - d) / SCALE;                       // 穿透深度（世界单位）
      if (pen <= 0) continue;
      const rel = ((B.vx - A.vx) * dx + (B.vy - A.vy) * dy) / (d || 1) / SCALE;
      rows.push({ f: b.frame, pair: `${A.id}-${B.id}`, pen, rel });
    }
  }
}

console.log(`frames with any overlap: ${rows.length}`);
console.log(`\npenetration depth distribution:`);
const depths = rows.map(r => r.pen).sort((a, b) => a - b);
if (depths.length) {
  console.log(`  min=${depths[0].toFixed(2)}  median=${depths[Math.floor(depths.length / 2)].toFixed(2)}  max=${depths[depths.length - 1].toFixed(2)}`);
}
console.log(`\ndeep penetration (> 1.0 unit) AND closing fast (rel < -20):`);
const bad = rows.filter(r => r.pen > 1.0 && r.rel < -20);
console.log(`  count: ${bad.length}`);
for (const r of bad.slice(0, 12)) {
  console.log(`  f=${r.f} pair ${r.pair} pen=${r.pen.toFixed(2)} rel=${r.rel.toFixed(1)}`);
}
console.log(`\nany penetration with closing speed:`);
const closing = rows.filter(r => r.rel < -20);
console.log(`  count: ${closing.length}`);
for (const r of closing.slice(0, 8)) {
  console.log(`  f=${r.f} pair ${r.pair} pen=${r.pen.toFixed(3)} rel=${r.rel.toFixed(1)}`);
}

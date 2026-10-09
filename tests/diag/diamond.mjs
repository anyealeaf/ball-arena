/* Diagnostic: diamond arena loses speed on wall bounces. Find where.
   (ASCII only.) */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID, effectiveShape } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

const b = new Battle({
  teams: [['test'], ['test']].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
  arena: ARENA_BY_ID['diamond'],
  rules: { ...DEFAULT_RULES },
  seed: 8888
});

const u = b.units[0];
console.log('diamond arena points:', JSON.stringify(effectiveShape(ARENA_BY_ID['diamond'], 0).points));
console.log(`start speed=${(Math.hypot(u.vx, u.vy) / SCALE).toFixed(3)}\n`);

let prevSpeed = Math.hypot(u.vx, u.vy);
console.log('frame | speed      | delta     | pos | event');
for (let f = 0; f < 2400 && !b.over; f++) {
  const before = b.events.length;
  b.step();
  const speed = Math.hypot(u.vx, u.vy);
  const evs = b.events.slice(before).filter(e => e.a === u.id || e.b === u.id);
  const delta = speed - prevSpeed;
  if (Math.abs(delta) > 1 || evs.length) {
    console.log(
      `${String(f).padStart(5)} | ${speed.toFixed(3).padStart(10)} | ${delta.toFixed(3).padStart(9)} | ` +
      `(${(u.x / SCALE).toFixed(0)},${(u.y / SCALE).toFixed(0)}) | ${evs.map(e => e.type).join(',') || '-'}`
    );
  }
  prevSpeed = speed;
}
console.log(`\nfinal speed=${(Math.hypot(u.vx, u.vy) / SCALE).toFixed(3)} (expected 120.000)`);

// Check the normal magnitudes for diamond edges
console.log('\n--- diamond edge normals (should be unit length) ---');
{
  const shape = effectiveShape(ARENA_BY_ID['diamond'], 0);
  const pts = shape.points;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    const ex = x2 - x1, ey = y2 - y1;
    const len = Math.sqrt(ex * ex + ey * ey);
    const nx = Math.round((-ey * SCALE) / len), ny = Math.round((ex * SCALE) / len);
    const mag = Math.hypot(nx, ny) / SCALE;
    console.log(`  edge ${i} len=${len.toFixed(2)} n=(${nx},${ny}) |n|=${mag.toFixed(4)}`);
  }
}

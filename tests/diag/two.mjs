/* Diagnostic: 1v1 in a rect arena never collides. Trace both balls.
   (ASCII only.) */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

const cfg = {
  teams: [['test'], ['test']].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
  arena: ARENA_BY_ID['rect'],
  rules: { ...DEFAULT_RULES },
  seed: 31
};

const b = new Battle(cfg);
console.log('two balls, rect 720x440, r=16, speed=120');
for (const u of b.units) {
  console.log(`  #${u.id} start=(${(u.x / SCALE).toFixed(0)},${(u.y / SCALE).toFixed(0)}) v=(${u.vx},${u.vy}) ` +
    `speed=${(Math.hypot(u.vx, u.vy) / SCALE).toFixed(0)} angle=${u.spawnAngle?.toFixed(0)}`);
}

let minDist = Infinity, minAt = -1;
let walls = 0, bounces = 0;
console.log('\nframe | ball0 pos/v | ball1 pos/v | dist');
for (let f = 0; f < 1800; f++) {
  b.step();
  const A = b.units[0], B = b.units[1];
  const d = Math.hypot(A.x - B.x, A.y - B.y) / SCALE;
  if (d < minDist) { minDist = d; minAt = f; }
  walls += b.events.filter(e => e.f === f && e.type === 'wall').length;
  bounces += b.events.filter(e => e.f === f && e.type === 'bounce').length;
  if (f % 120 === 0 || f < 3) {
    console.log(`${String(f).padStart(5)} | (${(A.x / SCALE).toFixed(0).padStart(3)},${(A.y / SCALE).toFixed(0).padStart(3)}) ` +
      `v=(${String(A.vx).padStart(7)},${String(A.vy).padStart(7)}) | ` +
      `(${(B.x / SCALE).toFixed(0).padStart(3)},${(B.y / SCALE).toFixed(0).padStart(3)}) ` +
      `v=(${String(B.vx).padStart(7)},${String(B.vy).padStart(7)}) | ${d.toFixed(1)}`);
  }
}
console.log(`\nclosest approach: ${minDist.toFixed(2)} at frame ${minAt} (contact needs <= ${(32 + 6).toFixed(1)})`);
console.log(`wall bounces: ${walls}, ball-ball collisions: ${bounces}`);
console.log(`\nobservation: if the two balls stay ~150 units apart and bounce off walls`);
console.log(`smoothly, they are on trajectories that never intersect (possible but unlikely).`);
console.log(`if positions jump or velocities look wrong at walls, the reflection has an issue.`);

// Are their speeds still the same as at spawn?
const A = b.units[0], B = b.units[1];
console.log(`\nfinal speeds: #0=${(Math.hypot(A.vx, A.vy) / SCALE).toFixed(0)} #1=${(Math.hypot(B.vx, B.vy) / SCALE).toFixed(0)} (expected 120 both)`);

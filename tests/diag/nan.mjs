/* Diagnostic: why does steering produce NaN? Test the math in isolation.
   (ASCII only.) */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

const b = new Battle({
  teams: [['test'], ['test']].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
  arena: ARENA_BY_ID['rect'],
  rules: { ...DEFAULT_RULES, steerDegPerSec: 30 },
  seed: 31
});

const A = b.units[0];
console.log('A before anything: vx=', A.vx, 'vy=', A.vy, 'x=', A.x, 'y=', A.y);
console.log('typeof vx:', typeof A.vx, 'isFinite:', Number.isFinite(A.vx));

// Reproduce rotateVel's math by hand
const sinTable = [];
for (let i = 0; i <= 90; i++) sinTable[i] = Math.round(Math.sin((i * Math.PI) / 180) * SCALE);
console.log('\nsin table sample: sin[0]=', sinTable[0], 'sin[45]=', sinTable[45], 'sin[90]=', sinTable[90]);

console.log('\nA.face =', A.face, '  A.spawnAngle =', A.spawnAngle);
const curDeg = ((Math.atan2(A.vy, A.vx) * 180) / Math.PI + 360) % 360;
console.log('curDeg computed =', curDeg);

const B = b.units[1];
const wantDeg = ((Math.atan2(B.y - A.y, B.x - A.x) * 180) / Math.PI + 360) % 360;
console.log('wantDeg computed =', wantDeg);
console.log('B pos =', B.x / SCALE, B.y / SCALE, ' A pos =', A.x / SCALE, A.y / SCALE);

let diff = wantDeg - curDeg;
while (diff > 180) diff -= 360;
while (diff < -180) diff += 360;
console.log('diff =', diff, ' steer for one frame =', 30 / 60);

const applied = Math.max(-0.5, Math.min(0.5, diff));
console.log('applied =', applied, ' Math.abs(applied) < 0.5 ?', Math.abs(applied) < 0.5);

// try the rotation
const c = sinTable[Math.round(((applied + 90) % 360 + 360) % 360)] ?? 'OUT OF RANGE';
console.log('cosDeg lookup index =', Math.round(((applied + 90) % 360 + 360) % 360), '-> c =', c);
console.log('  (applied + 90) =', applied + 90);

// Manual replicate of cosDeg with a fractional degree to expose the bug
function sinDeg(deg) {
  let d = ((deg % 360) + 360) % 360;
  if (d <= 90) return sinTable[d];
  if (d <= 180) return sinTable[180 - d];
  if (d <= 270) return -sinTable[d - 180];
  return -sinTable[360 - d];
}
console.log('\nsinDeg(0.5) =', sinDeg(0.5), '  <- fractional index!');
console.log('sinTable[0.5] =', sinTable[0.5]);
console.log('cosDeg(0.5) =', sinDeg(90.5), ' sinTable[90.5] =', sinTable[90.5]);
console.log('\nCONCLUSION: if the table is indexed with a non-integer, the lookup');
console.log('returns undefined -> arithmetic yields NaN. Steering uses a fractional');
console.log('per-frame angle (degPerSec * DT), which is exactly that case.');

/* Diagnostic: why does the hand-placed ball never move?
   (ASCII only.) */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

const b = new Battle({
  teams: [['test'], ['test']].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
  arena: ARENA_BY_ID['rect'],
  sizeScale: 1,
  rules: { ...DEFAULT_RULES, steerDegPerSec: 0, wallDeflectDeg: 0 },
  seed: 1
});
const [A, B] = b.units;
const cx = 360 * SCALE, cy = 220 * SCALE;
A.x = cx - 16 * SCALE; A.y = cy; A.vx = 0; A.vy = 0;
B.x = cx + 16 * SCALE + 2000; B.y = cy; B.vx = -120 * SCALE; B.vy = 0;

console.log('before any step:');
console.log(`  over=${b.over} frame=${b.frame} winner=${b.winner} endReason="${b.endReason}"`);
console.log(`  B.x=${B.x / SCALE} B.vx=${B.vx}`);

b.step();
console.log('after 1 step:');
console.log(`  over=${b.over} frame=${b.frame} endReason="${b.endReason}"`);
console.log(`  B.x=${B.x / SCALE} B.vx=${B.vx}`);
console.log(`  events: ${b.events.map(e => e.type).join(',') || '(none)'}`);

// Note: the constructor may already have ended the battle before we placed the balls,
// because the ORIGINAL spawn positions are used for the first _checkEnd.
console.log('\n--- what were the original spawn positions? ---');
const b2 = new Battle({
  teams: [['test'], ['test']].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
  arena: ARENA_BY_ID['rect'],
  sizeScale: 1,
  rules: { ...DEFAULT_RULES, steerDegPerSec: 0, wallDeflectDeg: 0 },
  seed: 1
});
for (const u of b2.units) {
  console.log(`  #${u.id} team=${u.team} pos=(${(u.x / SCALE).toFixed(1)},${(u.y / SCALE).toFixed(1)}) ` +
    `v=(${u.vx},${u.vy}) r=${u.r / SCALE}`);
}
const d = Math.hypot(b2.units[0].x - b2.units[1].x, b2.units[0].y - b2.units[1].y) / SCALE;
console.log(`  distance=${d.toFixed(1)} (sum of radii = ${(b2.units[0].r + b2.units[1].r) / SCALE})`);

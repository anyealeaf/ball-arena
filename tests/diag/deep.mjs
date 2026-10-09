/* Diagnostic: at the exact frame of deep penetration, inspect grid matching
   and whether _collide even sees the pair.
   (ASCII only.) */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

const b = new Battle({
  teams: [['test', 'test'], ['test', 'test']].map(u =>
    ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
  arena: ARENA_BY_ID['rect'],
  sizeScale: 1,
  rules: { ...DEFAULT_RULES },
  seed: 31
});

const TARGET = 953;
for (let f = 0; f < TARGET; f++) b.step();

console.log(`=== frame ${b.frame} (after stepping to ${TARGET}) ===`);
const alive = b.units.filter(u => u.alive);
for (const u of alive) {
  console.log(`  #${u.id} pos=(${(u.x / SCALE).toFixed(1)},${(u.y / SCALE).toFixed(1)}) ` +
    `v=(${u.vx},${u.vy}) r=${u.r / SCALE}`);
}

const cellSize = 40 * SCALE;
function cellOf(u) { return [Math.floor(u.x / cellSize), Math.floor(u.y / cellSize)]; }
function keyOf(u) { const [a, c] = cellOf(u); return a * 100003 + c; }

console.log('\npairs analysis:');
for (let i = 0; i < alive.length; i++) {
  for (let j = i + 1; j < alive.length; j++) {
    const A = alive[i], B = alive[j];
    const d = Math.hypot(A.x - B.x, A.y - B.y) / SCALE;
    const rr = (A.r + B.r) / SCALE;
    if (d >= rr) continue;
    const [ax, ay] = cellOf(A), [bx, by] = cellOf(B);
    console.log(`  #${A.id} vs #${B.id}: dist=${d.toFixed(1)} overlap=${(rr - d).toFixed(1)}`);
    console.log(`     cell A=(${ax},${ay})  cell B=(${bx},${by})  delta=(${bx - ax},${by - ay})`);
    console.log(`     same cell: ${keyOf(A) === keyOf(B)}   neighbours within 1: ` +
      `${Math.abs(bx - ax) <= 1 && Math.abs(by - ay) <= 1}`);
    // 触发一次 _collide 看看会不会处理
    const beforeA = { x: A.x, y: A.y };
    b._collide();
    const movedA = Math.hypot(A.x - beforeA.x, A.y - beforeA.y) / SCALE;
    console.log(`     after manual _collide: #${A.id} moved ${movedA.toFixed(2)} units ` +
      `${movedA > 0.01 ? '=> RESOLVED' : '=> NOT RESOLVED'}`);
  }
}

console.log('\n--- is the battle already over? ---');
console.log(`  over=${b.over} reason="${b.endReason}"`);
console.log(`  alive=${alive.length}`);

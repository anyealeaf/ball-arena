/* Diagnostic: reproduce the missed collision and inspect the grid matching.
   (ASCII only.) */
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

// instrument
let resolveCalls = 0;
const origResolve = b._resolveCollision.bind(b);
b._resolveCollision = function (A, B, e) { resolveCalls++; return origResolve(A, B, e); };

let collideCalls = 0;
const origCollide = b._collide.bind(b);
b._collide = function () { collideCalls++; return origCollide(); };

for (let f = 0; f < 280; f++) {
  const before = resolveCalls;
  b.step();
  const A = b.units[0], D = b.units[3];
  if (!A.alive || !D.alive) continue;
  const d = Math.hypot(A.x - D.x, A.y - D.y);
  const rr = A.r + D.r;
  const pen = (rr - d) / SCALE;
  if (f >= 270 && f <= 280) {
    const rel = ((D.vx - A.vx) * (D.x - A.x) + (D.vy - A.vy) * (D.y - A.y)) / (d || 1) / SCALE;
    console.log(`f=${f} pen=${pen.toFixed(2)} rel=${rel.toFixed(1)} ` +
      `resolveCallsThisFrame=${resolveCalls - before} ` +
      `A#0=(${(A.x / SCALE).toFixed(1)},${(A.y / SCALE).toFixed(1)}) D#3=(${(D.x / SCALE).toFixed(1)},${(D.y / SCALE).toFixed(1)}) ` +
      `aliveA=${A.alive} aliveD=${D.alive}`);
  }
}

console.log(`\ntotal _collide calls: ${collideCalls}`);
console.log(`total _resolveCollision calls: ${resolveCalls}`);

console.log('\n--- now check grid matching for the overlapping pair ---');
{
  const A = b.units[0], D = b.units[3];
  const cellSize = 40 * SCALE;
  const ka = ((A.x / cellSize) | 0) * 100003 + ((A.y / cellSize) | 0);
  const kd = ((D.x / cellSize) | 0) * 100003 + ((D.y / cellSize) | 0);
  console.log(`  cell size=${cellSize}`);
  console.log(`  A cell=(${(A.x / cellSize) | 0},${(A.y / cellSize) | 0}) key=${ka}`);
  console.log(`  D cell=(${(D.x / cellSize) | 0},${(D.y / cellSize) | 0}) key=${kd}`);
  console.log(`  same bucket: ${ka === kd}`);
  console.log(`  distance=${(Math.hypot(A.x - D.x, A.y - D.y) / SCALE).toFixed(1)}  sumR=${((A.r + D.r) / SCALE).toFixed(1)}`);
  console.log(`  overlapping: ${Math.hypot(A.x - D.x, A.y - D.y) < A.r + D.r}`);
  console.log(`  alive: A=${A.alive} D=${D.alive}`);
}

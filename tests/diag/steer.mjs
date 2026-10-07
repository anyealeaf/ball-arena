/* Diagnostic: with steering on, something impossible happens (a death with no
   damage source). Trace the first frames in detail.
   (ASCII only.) */
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

const b = new Battle({
  teams: [['test'], ['test']].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
  arena: ARENA_BY_ID['rect'],
  rules: { ...DEFAULT_RULES, steerDegPerSec: 30 },
  seed: 31
});

const [A, B] = b.units;
console.log(`A start=(${(A.x / SCALE).toFixed(0)},${(A.y / SCALE).toFixed(0)}) v=(${A.vx},${A.vy}) speed=${(Math.hypot(A.vx, A.vy) / SCALE).toFixed(2)}`);
console.log(`B start=(${(B.x / SCALE).toFixed(0)},${(B.y / SCALE).toFixed(0)}) v=(${B.vx},${B.vy}) speed=${(Math.hypot(B.vx, B.vy) / SCALE).toFixed(2)}\n`);

console.log('frame | A pos | A speed | B pos | B speed | dist');
for (let f = 0; f < 60; f++) {
  b.step();
  const d = Math.hypot(A.x - B.x, A.y - B.y) / SCALE;
  const sA = Math.hypot(A.vx, A.vy) / SCALE;
  const sB = Math.hypot(B.vx, B.vy) / SCALE;
  if (f < 8 || f % 10 === 0) {
    console.log(
      `${String(f).padStart(5)} | (${(A.x / SCALE).toFixed(0).padStart(4)},${(A.y / SCALE).toFixed(0).padStart(4)}) | ` +
      `${sA.toFixed(2).padStart(7)} | (${(B.x / SCALE).toFixed(0).padStart(4)},${(B.y / SCALE).toFixed(0).padStart(4)}) | ` +
      `${sB.toFixed(2).padStart(7)} | ${d.toFixed(1).padStart(6)}`
    );
  }
  // detect invalid numbers immediately
  if (!isFinite(A.x) || !isFinite(A.y) || !isFinite(A.vx) || !isFinite(A.vy)) {
    console.log(`*** frame ${f}: ball A became non-finite! x=${A.x} y=${A.y} vx=${A.vx} vy=${A.vy}`);
    break;
  }
  if (!isFinite(sA) === false && sA > 1000) {
    console.log(`*** frame ${f}: ball A speed exploded: ${sA}`);
    break;
  }
}

console.log(`\nafter 60 frames: A.hp=${A.hp} B.hp=${B.hp} A.alive=${A.alive} B.alive=${B.alive}`);
console.log(`events so far:`, JSON.stringify(b.events.reduce((m, e) => (m[e.type] = (m[e.type] || 0) + 1, m), {})));

// run to the end and report
b.runToEnd();
console.log(`\nfinal: frame=${b.frame} (${(b.frame / 60).toFixed(1)}s) reason=${b.endReason}`);
console.log(`A: hp=${Math.round(A.hp)} alive=${A.alive} taken=${Math.round(A.taken)} damageFrom=${JSON.stringify(A.damageFrom)}`);
console.log(`B: hp=${Math.round(B.hp)} alive=${B.alive} taken=${Math.round(B.taken)} damageFrom=${JSON.stringify(B.damageFrom)}`);
console.log(`all events:`, JSON.stringify(b.events.reduce((m, e) => (m[e.type] = (m[e.type] || 0) + 1, m), {})));

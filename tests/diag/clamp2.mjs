/* Diagnostic: call the REAL clampToShape and see exactly what it returns.
   (ASCII only.) */
import { clampToShapeForTest } from '../../js/core.js';
import { effectiveShape, ARENA_BY_ID } from '../../js/arenas.js';
import { SCALE } from '../../js/balls.js';

const shape = effectiveShape(ARENA_BY_ID['rect'], 0);
const R = 16 * SCALE;

console.log('rect arena points:', JSON.stringify(shape.points));
console.log('radius (fixed):', R, '=', R / SCALE, 'world units\n');

console.log('ball near BOTTOM wall, x=360:');
for (const y of [400, 415, 420, 423, 424, 425, 430, 435, 437, 439, 441]) {
  const r = clampToShapeForTest(shape, 360 * SCALE, y * SCALE, R);
  console.log(`  y=${String(y).padStart(3)} -> hit=${String(r.hit).padEnd(5)} ` +
    `newPos=(${(r.x / SCALE).toFixed(1)},${(r.y / SCALE).toFixed(1)}) n=(${r.nx},${r.ny})`);
}

console.log('\nball near LEFT wall, y=220:');
for (const x of [5, 10, 15, 16, 17, 18, 20]) {
  const r = clampToShapeForTest(shape, x * SCALE, 220 * SCALE, R);
  console.log(`  x=${String(x).padStart(3)} -> hit=${String(r.hit).padEnd(5)} ` +
    `newPos=(${(r.x / SCALE).toFixed(1)},${(r.y / SCALE).toFixed(1)}) n=(${r.nx},${r.ny})`);
}

console.log('\nball near CORNER (bottom-left), the case seen in the trace:');
for (const [x, y] of [[28, 435], [28, 424], [20, 430], [16, 424], [16, 437]]) {
  const r = clampToShapeForTest(shape, x * SCALE, y * SCALE, R);
  console.log(`  (${x},${y}) -> hit=${String(r.hit).padEnd(5)} ` +
    `newPos=(${(r.x / SCALE).toFixed(1)},${(r.y / SCALE).toFixed(1)}) n=(${r.nx},${r.ny})`);
}

console.log('\nKEY QUESTION: for a ball resting exactly at dist == radius,');
console.log('does hit come back true? If false, the velocity never reflects.');

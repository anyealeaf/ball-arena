/* Diagnostic: wall reflection. Does the ball bounce off walls, or get stuck?
   (ASCII only.) */
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';
import { effectiveShape } from '../../js/arenas.js';

const cfg = {
  teams: [['test'], ['test']].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
  arena: ARENA_BY_ID['rect'],
  rules: { ...DEFAULT_RULES },
  seed: 1
};

const b = new Battle(cfg);
const A = b.units[0];
console.log(`rect arena. ball r=${A.r / SCALE} speed=${A.speed / SCALE}`);
console.log(`start pos=(${(A.x / SCALE).toFixed(0)},${(A.y / SCALE).toFixed(0)}) v=(${A.vx},${A.vy})`);

let wallEvents = 0;
const origEmit = b._emit.bind(b);
b._emit = (type, ...rest) => { if (type === 'wall') wallEvents++; return origEmit(type, ...rest); };

console.log('\nframe | pos | v | speed | walls so far');
for (let f = 0; f < 400; f++) {
  b.step();
  if (f % 25 === 0 || f < 8) {
    console.log(`${String(f).padStart(5)} | (${(A.x / SCALE).toFixed(0)},${(A.y / SCALE).toFixed(0)}) | ` +
      `(${String(A.vx).padStart(8)},${String(A.vy).padStart(8)}) | ${Math.hypot(A.vx, A.vy).toFixed(0).padStart(7)} | ${wallEvents}`);
  }
}

console.log(`\ntotal wall events: ${wallEvents}`);
console.log(`final pos=(${(A.x / SCALE).toFixed(0)},${(A.y / SCALE).toFixed(0)}) v=(${A.vx},${A.vy})`);

// check if it's outside the arena
const shape = effectiveShape(b.arena, b.time);
if (shape.type === 'poly') {
  const inside = (() => {
    const pts = shape.points, n = pts.length;
    for (let i = 0; i < n; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
      const cross = (x2 - x1) * (A.y / SCALE - y1) - (y2 - y1) * (A.x / SCALE - x1);
      if (cross < 0) return false;
    }
    return true;
  })();
  console.log(`is ball inside arena? ${inside ? 'YES' : 'NO  <-- BUG'}`);
  console.log(`arena points: ${JSON.stringify(pts)}`);
}

// now test reflection math directly
console.log('\n--- direct reflection test ---');
const testV = [
  { vx: 0, vy: 100, nx: 0, ny: -1000, label: 'moving down, normal up (should flip vy negative)' },
  { vx: 100, vy: 0, nx: -1000, ny: 0, label: 'moving right, normal left (should flip vx negative)' },
  { vx: 100, vy: 100, nx: 0, ny: -1000, label: 'diagonal, normal up (vy should flip, vx keep)' }
];
for (const t of testV) {
  const vn = Math.round((t.vx * t.nx + t.vy * t.ny) / SCALE);
  const nvx = t.vx - Math.round((2 * t.nx * vn) / SCALE);
  const nvy = t.vy - Math.round((2 * t.ny * vn) / SCALE);
  console.log(`  ${t.label}`);
  console.log(`    v=(${t.vx},${t.vy}) n=(${t.nx},${t.ny}) vn=${vn} -> v'=(${nvx},${nvy})`);
}

/* Diagnostic: are the balls moving at all? Trace per-ball velocity.
   (ASCII only.) */
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

const cfg = {
  teams: [['test', 'test'], ['test', 'test']].map(u =>
    ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
  arena: ARENA_BY_ID['octagon'],
  rules: { ...DEFAULT_RULES },
  seed: 99
};

const b = new Battle(cfg);
console.log('--- after construction (before any step) ---');
for (const u of b.units) {
  console.log(`  #${u.id} team=${u.team} pos=(${(u.x / SCALE).toFixed(0)},${(u.y / SCALE).toFixed(0)}) ` +
    `v=(${u.vx},${u.vy}) speed=${Math.hypot(u.vx, u.vy).toFixed(0)} spawnAngle=${u.spawnAngle?.toFixed(0)} r=${u.r / SCALE}`);
}

// check initial overlaps
console.log('\n--- initial overlaps ---');
for (let i = 0; i < b.units.length; i++) {
  for (let j = i + 1; j < b.units.length; j++) {
    const A = b.units[i], B = b.units[j];
    const d = Math.hypot(A.x - B.x, A.y - B.y);
    const rr = A.r + B.r;
    if (d < rr) console.log(`  #${A.id}(t${A.team}) overlaps #${B.id}(t${B.team}) by ${((rr - d) / SCALE).toFixed(1)}`);
  }
}

console.log('\n--- stepping 5 frames, show positions/velocities ---');
for (let f = 0; f < 5; f++) {
  b.step();
  console.log(`  frame ${f}: ` + b.units.map(u =>
    `#${u.id}(${(u.x / SCALE).toFixed(0)},${(u.y / SCALE).toFixed(0)})|v=${Math.hypot(u.vx, u.vy).toFixed(0)}`
  ).join('  '));
}

console.log('\n--- run 600 frames, then look at state ---');
for (let f = 0; f < 600; f++) b.step();
console.log('  events:', JSON.stringify(Object.fromEntries(
  Object.entries(b.events.reduce((m, e) => (m[e.type] = (m[e.type] || 0) + 1, m), {})))));
for (const u of b.units) {
  console.log(`  #${u.id} team=${u.team} pos=(${(u.x / SCALE).toFixed(0)},${(u.y / SCALE).toFixed(0)}) ` +
    `v=(${u.vx},${u.vy}) speed=${Math.hypot(u.vx, u.vy).toFixed(0)} hp=${Math.round(u.hp)}`);
}

console.log('\n--- who is touching whom right now ---');
for (let i = 0; i < b.units.length; i++) {
  for (let j = i + 1; j < b.units.length; j++) {
    const A = b.units[i], B = b.units[j];
    const d = Math.hypot(A.x - B.x, A.y - B.y) / SCALE;
    const rr = (A.r + B.r) / SCALE;
    if (d < rr + 8) {
      console.log(`  #${A.id}(t${A.team}) <-> #${B.id}(t${B.team}): dist=${d.toFixed(1)} sumR=${rr.toFixed(1)} ` +
        `overlap=${(rr - d).toFixed(1)}`);
    }
  }
}

/* Diagnostic: ball has speed 120 but its position never changes.
   Instrument each stage of step() around the frozen frames.
   (ASCII only.) */
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

const b = new Battle({
  teams: [['test'], ['test']].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
  arena: ARENA_BY_ID['circle'],
  sizeScale: 1,
  rules: { ...DEFAULT_RULES },
  seed: 8888
});

const origRelieve = b._relieveOverlap.bind(b);
b._relieveOverlap = function () {
  const before = b.units.map(u => ({ x: u.x, y: u.y }));
  const r = origRelieve();
  const after = b.units.map(u => ({ x: u.x, y: u.y }));
  if (b.frame >= 1880 && b.frame <= 1890) {
    console.log(`  _relieveOverlap f=${b.frame}: ` + b.units.map((u, i) =>
      `#${u.id} Δ=(${((after[i].x - before[i].x) / SCALE).toFixed(2)},${((after[i].y - before[i].y) / SCALE).toFixed(2)})`
    ).join('  '));
  }
  return r;
};

const origCollide = b._collide.bind(b);
b._collide = function () {
  const before = b.units.map(u => ({ x: u.x, y: u.y }));
  const r = origCollide();
  const after = b.units.map(u => ({ x: u.x, y: u.y }));
  if (b.frame >= 1880 && b.frame <= 1890) {
    console.log(`  _collide         f=${b.frame}: ` + b.units.map((u, i) =>
      `#${u.id} Δ=(${((after[i].x - before[i].x) / SCALE).toFixed(2)},${((after[i].y - before[i].y) / SCALE).toFixed(2)})`
    ).join('  '));
  }
  return r;
};

console.log('frame | pos before step | pos after step | v after');
for (let f = 0; f < 1900 && !b.over; f++) {
  const u = b.units[0];
  const before = { x: u.x / SCALE, y: u.y / SCALE };
  const vBefore = { x: u.vx, y: u.vy };
  if (f >= 1880 && f <= 1890) {
    console.log(`--- frame ${f} (pre-step) ---`);
    console.log(`  #0 pos=(${before.x.toFixed(2)},${before.y.toFixed(2)}) v=(${vBefore.x},${vBefore.y})`);
    b.step();
    const after = { x: u.x / SCALE, y: u.y / SCALE };
    console.log(`  #0 pos=(${after.x.toFixed(2)},${after.y.toFixed(2)}) ` +
      `Δ=(${(after.x - before.x).toFixed(3)},${(after.y - before.y).toFixed(3)}) ` +
      `expected Δ=(${(vBefore.x / SCALE / 60).toFixed(3)},${(vBefore.y / SCALE / 60).toFixed(3)})`);
  } else {
    b.step();
  }
}

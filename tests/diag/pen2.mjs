/* Diagnostic: with doubled speed (4 units/frame) does the collision
   resolution keep up? Measure leftover penetration.
   (ASCII only.) */
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

const st = makeUnitStats('test');
console.log(`ball r=${st.r} speed=${st.speed} -> ${(st.speed / 60).toFixed(2)} world units per frame`);
console.log(`diameter=${st.r * 2}\n`);

const pens = [];
const bad = [];
while (!b.over && b.frame < b.maxFrames) {
  b.step();
  const alive = b.units.filter(u => u.alive);
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const A = alive[i], B = alive[j];
      const dx = B.x - A.x, dy = B.y - A.y;
      const d = Math.hypot(dx, dy);
      const pen = (A.r + B.r - d) / SCALE;
      if (pen <= 0) continue;
      const rel = ((B.vx - A.vx) * dx + (B.vy - A.vy) * dy) / (d || 1) / SCALE;
      pens.push(pen);
      if (pen > 2 && rel < -20) bad.push({ f: b.frame, pen, rel, d: d / SCALE });
    }
  }
}

pens.sort((a, b2) => a - b2);
console.log(`overlap samples: ${pens.length}`);
if (pens.length) {
  console.log(`  median=${pens[Math.floor(pens.length / 2)].toFixed(2)}  ` +
    `p90=${pens[Math.floor(pens.length * 0.9)].toFixed(2)}  max=${ pens[pens.length - 1].toFixed(2)}`);
}
console.log(`\npenetration > 2 units while still closing: ${bad.length}`);
for (const x of bad.slice(0, 8)) {
  console.log(`  f=${x.f} pen=${x.pen.toFixed(1)} rel=${x.rel.toFixed(0)} dist=${x.d.toFixed(1)}`);
}
console.log('\nnote: with speed 240 (4 units/frame) a pair can move 8 units');
console.log('      relative per frame, so deeper transient penetration is expected.');

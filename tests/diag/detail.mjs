/* Diagnostic: examine the two failing assertions in detail.
   (ASCII only.) */
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

function mk(arenaId, sizeScale, seed) {
  return new Battle({
    teams: [['test', 'test'], ['test', 'test']].map(u =>
      ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
    arena: ARENA_BY_ID[arenaId],
    sizeScale,
    rules: { ...DEFAULT_RULES },
    seed
  });
}

console.log('=== A. strong impacts that barely turned ===');
for (const [arenaId, sizeScale, seed] of [['octagon', 0.5, 7], ['circle', 0.5, 555]]) {
  const b = mk(arenaId, sizeScale, seed);
  while (!b.over && b.frame < b.maxFrames) {
    const evStart = b.events.length;
    const pre = new Map();
    for (const u of b.units) if (u.alive) pre.set(u.id, { vx: u.vx, vy: u.vy });
    b.step();
    for (const e of b.events.slice(evStart)) {
      if (e.type !== 'bounce' || Math.abs(e.value) <= 40) continue;
      for (const id of [e.a, e.b]) {
        const u = b.units[id];
        if (!u || !u.alive) continue;
        const p = pre.get(id);
        const a0 = ((Math.atan2(p.vy, p.vx) * 180) / Math.PI + 360) % 360;
        const a1 = ((Math.atan2(u.vy, u.vx) * 180) / Math.PI + 360) % 360;
        let d = Math.abs(a1 - a0) % 360; if (d > 180) d = 360 - d;
        if (d < 5) {
          console.log(`  ${arenaId}/${Math.round(sizeScale * 100)}%/seed${seed} f=${b.frame} ball#${id}`);
          console.log(`    impact=${e.value.toFixed(0)}  turn=${d.toFixed(1)}deg`);
          console.log(`    pre  v=(${p.vx},${p.vy}) ang=${a0.toFixed(1)} speed=${(Math.hypot(p.vx, p.vy) / SCALE).toFixed(1)}`);
          console.log(`    post v=(${u.vx},${u.vy}) ang=${a1.toFixed(1)} speed=${(Math.hypot(u.vx, u.vy) / SCALE).toFixed(1)}`);
          console.log(`    normal=(${e.nx},${e.ny})  n-angle=${(((Math.atan2(e.ny, e.nx) * 180) / Math.PI + 360) % 360).toFixed(1)}`);
        }
      }
    }
  }
}

console.log('\n=== B. head-on collisions that did not recede ===');
let checked = 0, wrong = 0;
const samples = [];
for (const arenaId of ['rect', 'octagon', 'circle']) {
  for (const seed of [31, 7, 555, 12]) {
    const b = mk(arenaId, 0.5, seed);
    while (!b.over && b.frame < b.maxFrames) {
      const evStart = b.events.length;
      b.step();
      for (const e of b.events.slice(evStart)) {
        if (e.type !== 'bounce' || Math.abs(e.value) < 60) continue;
        const A = b.units[e.a], B = b.units[e.b];
        if (!A || !B) continue;
        const aR = A.vx * e.nx + A.vy * e.ny;
        const bR = B.vx * e.nx + B.vy * e.ny;
        checked++;
        const ok = aR < 0 && bR > 0;
        if (!ok) {
          wrong++;
          if (samples.length < 6) {
            samples.push({ arenaId, seed, f: b.frame, impact: e.value, aR, bR,
              A: `(${A.vx},${A.vy})`, B: `(${B.vx},${B.vy})`, n: `(${e.nx},${e.ny})`,
              dist: (Math.hypot(A.x - B.x, A.y - B.y) / SCALE).toFixed(1) });
          }
        }
      }
    }
  }
}
console.log(`  ${wrong}/${checked} suspicious`);
for (const s of samples) {
  console.log(`  ${s.arenaId}/seed${s.seed} f=${s.f} impact=${s.impact.toFixed(0)} dist=${s.dist}`);
  console.log(`    vA=${s.A} vB=${s.B} n=${s.n}`);
  console.log(`    along-normal: A=${s.aR.toFixed(0)} (want <0)  B=${s.bR.toFixed(0)} (want >0)`);
}
console.log('\nnote: if dist > 32 the pair was already separated when the event fired;');
console.log('      if the normal is stale the classification is wrong, not the physics.');

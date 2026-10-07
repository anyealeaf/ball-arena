/* Diagnostic: duel convergence, with accurate minimum-distance tracking.
   Also reports whether the win came from real contact or from the fallback.
   (ASCII only.) */
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

const CONTACT = 32 + 6;   // 2r + 6

function duel(arenaId, seed, extraRules = {}) {
  return new Battle({
    teams: [['test'], ['test']].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
    arena: ARENA_BY_ID[arenaId],
    rules: { ...DEFAULT_RULES, ...extraRules },
    seed
  });
}

function run(arenaId, seed, extraRules) {
  const b = duel(arenaId, seed, extraRules);
  let minDist = Infinity, contactHits = 0, phantomHits = 0, contactFrames = 0;
  while (!b.over && b.frame < b.maxFrames) {
    const evStart = b.events.length;
    b.step();
    const alive = b.units.filter(u => u.alive);
    if (alive.length === 2) {
      const d = Math.hypot(alive[0].x - alive[1].x, alive[0].y - alive[1].y) / SCALE;
      if (d < minDist) minDist = d;
      if (d <= CONTACT) contactFrames++;
    }
    for (const e of b.events.slice(evStart)) {
      if (e.type !== 'hit') continue;
      // use the positions recorded on the event itself (units may be dead later)
      const d = Math.hypot(e.bx - e.ax, e.by - e.ay);
      if (d <= CONTACT + 0.5) contactHits++; else phantomHits++;
    }
  }
  return { b, minDist, contactHits, phantomHits, contactFrames };
}

/* 破解器已移除，"starve on/off" 这组对照已经没有意义了，
   改成对照"转向角速度"对收敛速度的影响。 */
const modes = [
  ['steer 30 (default)  ', {}],
  ['steer 60            ', { steerDegPerSec: 60 }],
  ['steer 0 (pure)      ', { steerDegPerSec: 0 }]
];

for (const [label, rules] of modes) {
  console.log(`\n===== ${label} =====`);
  console.log('arena      seed  seconds  reason                  minDist  contactHits  phantomHits  contactFrames');
  let phantoms = 0, resolved = 0, total = 0;
  for (const arenaId of ['rect', 'octagon', 'circle', 'triangle']) {
    for (const seed of [31, 7, 555]) {
      const r = run(arenaId, seed, rules);
      total++;
      phantoms += r.phantomHits;
      const natural = r.b.endReason.includes('阵亡');
      if (natural) resolved++;
      console.log(
        `${arenaId.padEnd(10)} ${String(seed).padStart(4)}  ${(r.b.frame / 60).toFixed(1).padStart(7)}  ` +
        `${r.b.endReason.padEnd(22)}  ${(r.minDist === Infinity ? '-' : r.minDist.toFixed(0)).padStart(7)}  ` +
        `${String(r.contactHits).padStart(11)}  ${String(r.phantomHits).padStart(11)}  ${String(r.contactFrames).padStart(13)}`
      );
    }
  }
  console.log(`  --> phantom hits total: ${phantoms}   natural finishes: ${resolved}/${total}`);
}

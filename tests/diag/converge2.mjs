/* Diagnostic v2: separate hit kinds, track real contact, compare steering modes.
   (ASCII only.) */
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

const CONTACT = 32 + 6;   // 2r + 6

function run(arenaId, seed, extraRules) {
  const b = new Battle({
    teams: [['test'], ['test']].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
    arena: ARENA_BY_ID[arenaId],
    rules: { ...DEFAULT_RULES, ...extraRules },
    seed
  });
  let minDist = Infinity, contactHits = 0, starveHits = 0, contactFrames = 0;
  const dmgValues = new Set();
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
      if (e.type === 'hit') {
        const d = Math.hypot(e.bx - e.ax, e.by - e.ay);
        if (d <= CONTACT + 0.5) { contactHits++; dmgValues.add(e.value); }
        else contactHits += 0;       // same event type, only counted if in contact
      } else if (e.type === 'starve') starveHits++;
    }
  }
  return { b, minDist, contactHits, starveHits, contactFrames, dmgValues: [...dmgValues] };
}

/* 破解器（伤害倍率 + 全场"饥饿"掉血）已移除，所以不再有 starve 计数对照。
   这里只对照"转向角速度"对收敛的影响。 */
const modes = [
  ['pure (steer 0)      ', { steerDegPerSec: 0 }],
  ['steer 30 (default)  ', {}],
  ['steer 60            ', { steerDegPerSec: 60 }]
];

for (const [label, rules] of modes) {
  console.log(`\n===== ${label} =====`);
  console.log('arena      seed  seconds  reason                minDist  接触命中  contactFr  dmgValues');
  let allDmg = new Set(), cHits = 0, sHits = 0, resolved = 0;
  for (const arenaId of ['rect', 'octagon', 'circle', 'triangle']) {
    for (const seed of [31, 7, 555]) {
      const r = run(arenaId, seed, rules);
      cHits += r.contactHits; sHits += r.starveHits;
      r.dmgValues.forEach(v => allDmg.add(v));
      if (r.b.endReason.includes('阵亡')) resolved++;
      console.log(
        `${arenaId.padEnd(10)} ${String(seed).padStart(4)}  ${(r.b.frame / 60).toFixed(1).padStart(7)}  ` +
        `${r.b.endReason.padEnd(20)}  ${(r.minDist === Infinity ? '-' : r.minDist.toFixed(0)).padStart(7)}  ` +
        `${String(r.contactHits).padStart(8)}  ` +
        `${String(r.contactFrames).padStart(9)}  ${r.dmgValues.slice(0, 4).join(',')}`
      );
    }
  }
  console.log(`  --> real-contact hits: ${cHits}   natural finishes: ${resolved}/12`);
  console.log(`  --> damage values observed (must all be 100): ${[...allDmg].sort((a, b) => a - b).join(', ')}`);
}

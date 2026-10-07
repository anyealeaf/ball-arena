/* Diagnostic: is wall deflection / steering actually being applied?
   Count wall events, sum the deflection angles, and compare duel timings.
   (ASCII only.) */
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

function duel(arenaId, seed, rules) {
  return new Battle({
    teams: [['test'], ['test']].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
    arena: ARENA_BY_ID[arenaId],
    rules: { ...DEFAULT_RULES, ...rules },
    seed
  });
}

console.log('=== wall deflection accounting ===');
for (const [label, rules] of [
  ['default (wallDeflect 10, steer 30)', {}],
  ['no wall deflect, steer 0          ', { wallDeflectDeg: 0, steerDegPerSec: 0 }],
  ['no wall deflect, steer 30         ', { wallDeflectDeg: 0, steerDegPerSec: 30 }],
  ['wall deflect 10, steer 0          ', { wallDeflectDeg: 10, steerDegPerSec: 0 }]
]) {
  let walls = 0, turnedEvents = 0, sumTurn = 0, secs = 0, resolved = 0, contacts = 0;
  for (const arenaId of ['rect', 'octagon', 'circle', 'triangle']) {
    for (const seed of [31, 7, 555]) {
      const b = duel(arenaId, seed, rules);
      while (!b.over && b.frame < b.maxFrames) b.step();
      const w = b.events.filter(e => e.type === 'wall');
      walls += w.length;
      for (const e of w) if (e.turned) { turnedEvents++; sumTurn += Math.abs(e.turned); }
      contacts += b.events.filter(e => e.type === 'hit').length;
      secs += b.frame / 60;
      if (b.endReason.includes('阵亡')) resolved++;
    }
  }
  console.log(`${label.padEnd(34)} walls=${String(walls).padStart(5)}  turned=${String(turnedEvents).padStart(5)}  ` +
    `sumTurn=${sumTurn.toFixed(0).padStart(6)}  avgSec=${(secs / 12).toFixed(1).padStart(5)}  ` +
    `contacts=${String(contacts).padStart(4)}  resolved=${resolved}/12`);
}

console.log('\n=== per-duel timing across modes ===');
console.log('arena      seed | steer0  steer30  steer60 | wallDeflect10');
for (const arenaId of ['rect', 'octagon', 'circle', 'triangle']) {
  for (const seed of [31, 7, 555]) {
    const t = (rules) => {
      const b = duel(arenaId, seed, rules);
      while (!b.over && b.frame < b.maxFrames) b.step();
      return b.frame / 60;
    };
    const a = t({ steerDegPerSec: 0 });
    const b2 = t({ steerDegPerSec: 30 });
    const c = t({ steerDegPerSec: 60 });
    const d = t({ steerDegPerSec: 0, wallDeflectDeg: 10 });
    const f = (v) => v.toFixed(1).padStart(7);
    console.log(`${arenaId.padEnd(10)} ${String(seed).padStart(4)} | ${f(a)}  ${f(b2)}  ${f(c)} | ${f(d)}`);
  }
}

/* Measure real arena-size effects with a large sample, for the README.
   Earlier numbers were drawn from only 9 games and were dominated by noise
   (the 75% case even looked slower than 100%, which is nonsense).
   (ASCII only.) */
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats } from '../../js/balls.js';

function run(arenaId, sizeScale, seed) {
  return new Battle({
    teams: [['test'], ['test']].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
    arena: ARENA_BY_ID[arenaId],
    sizeScale,
    rules: { ...DEFAULT_RULES },
    seed
  });
}

const ARENAS = ['rect', 'octagon', 'circle', 'triangle', 'diamond'];
const SEEDS = [31, 7, 555, 12, 99, 1234, 88, 4242, 2024, 77];

console.log('size | games | bounce/sec | contacts/sec | median duration | mean duration');
for (const sizeScale of [1.0, 0.75, 0.5, 0.35]) {
  let secs = 0, bounces = 0, contacts = 0;
  const durations = [];
  for (const arenaId of ARENAS) {
    for (const seed of SEEDS) {
      const b = run(arenaId, sizeScale, seed);
      while (!b.over && b.frame < b.maxFrames) b.step();
      const s = b.frame / 60;
      durations.push(s);
      secs += s;
      bounces += b.events.filter(e => e.type === 'bounce').length;
      contacts += b.events.filter(e => e.type === 'hit').length;
    }
  }
  durations.sort((a, b) => a - b);
  const median = durations[Math.floor(durations.length / 2)];
  const n = durations.length;
  console.log(
    `${String(Math.round(sizeScale * 100)).padStart(3)}% | ${String(n).padStart(5)} | ` +
    `${(bounces / secs).toFixed(3).padStart(10)} | ${(contacts / secs).toFixed(3).padStart(12)} | ` +
    `${median.toFixed(1).padStart(15)} | ${(secs / n).toFixed(1).padStart(13)}`
  );
}
console.log('\nnote: duration is noisy because it depends on random trajectories;');
console.log('      bounce/sec (collision frequency) is the meaningful metric.');

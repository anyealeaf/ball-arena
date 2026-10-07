/* Diagnostic: with doubled ball radius, check (a) no spawn overlap,
   (b) collision frequency, (c) match pacing.
   (ASCII only.) */
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, BALL_SCALE, SCALE } from '../../js/balls.js';

console.log(`BALL_SCALE = ${BALL_SCALE}`);
const st = makeUnitStats('test');
console.log(`test ball: r=${st.r} speed=${st.speed} hp=${st.maxHp} melee=${st.melee}`);
console.log(`contact range = 2r + 6 = ${st.r * 2 + 6}\n`);

function mk(teamA, teamB, arenaId = 'rect', seed = 31) {
  return new Battle({
    teams: [teamA, teamB].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
    arena: ARENA_BY_ID[arenaId],
    sizeScale: 1,
    rules: { ...DEFAULT_RULES },
    seed
  });
}

console.log('=== (a) spawn overlap check (per team size, 2 teams) ===');
for (const n of [1, 2, 3, 4, 5, 6, 8]) {
  let worst = Infinity, bad = 0;
  for (const arenaId of ['rect', 'octagon', 'circle', 'triangle']) {
    for (const seed of [31, 7, 555]) {
      const b = mk(Array(n).fill('test'), Array(n).fill('test'), arenaId, seed);
      const alive = b.units;
      for (let i = 0; i < alive.length; i++) {
        for (let j = i + 1; j < alive.length; j++) {
          const A = alive[i], B = alive[j];
          const d = Math.hypot(A.x - B.x, A.y - B.y) / SCALE;
          const gap = d - (A.r + B.r) / SCALE;   // 负值 = 重叠
          if (gap < worst) worst = gap;
          if (gap < 0) bad++;
        }
      }
    }
  }
  console.log(`  ${String(n).padStart(2)} per team: worst gap = ${worst.toFixed(1)}  ` +
    `${bad === 0 ? 'OK' : `OVERLAPPING PAIRS: ${bad}`}`);
}

console.log('\n=== (b) collision frequency & pacing ===');
console.log('teams   arena      seconds  contacts  collisions  contacts/sec');
for (const [a, bm, label] of [
  [['test'], ['test'], '1v1'],
  [['test', 'test'], ['test', 'test'], '2v2'],
  [['test', 'test', 'test'], ['test', 'test', 'test'], '3v3']
]) {
  let secs = 0, hits = 0, bounces = 0, n = 0;
  for (const arenaId of ['rect', 'octagon', 'circle']) {
    for (const seed of [31, 7, 555]) {
      const bt = mk(a, bm, arenaId, seed);
      while (!bt.over && bt.frame < bt.maxFrames) bt.step();
      secs += bt.frame / 60;
      hits += bt.events.filter(e => e.type === 'hit').length;
      bounces += bt.events.filter(e => e.type === 'bounce').length;
      n++;
    }
  }
  console.log(`${label.padEnd(7)} (9 games) ${(secs / n).toFixed(1).padStart(8)}  ` +
    `${(hits / n).toFixed(1).padStart(8)}  ${(bounces / n).toFixed(1).padStart(10)}  ${(hits / secs).toFixed(2).padStart(12)}`);
}

console.log('\n=== (c) all arena types still resolve ===');
for (const arenaId of ['rect', 'circle', 'octagon', 'triangle', 'diamond', 'lava_center', 'shrink_ring', 'chaos']) {
  const bt = mk(['test', 'test'], ['test', 'test'], arenaId, 31);
  while (!bt.over && bt.frame < bt.maxFrames) bt.step();
  console.log(`  ${arenaId.padEnd(13)} ${(bt.frame / 60).toFixed(1).padStart(6)}s  ${bt.endReason}`);
}

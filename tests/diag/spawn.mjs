/* Diagnostic: why does the spawn relaxation loop make overlap WORSE?
   (ASCII only.) */
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

function mk(teamA, teamB, arenaId = 'rect', seed = 31) {
  return new Battle({
    teams: [teamA, teamB].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
    arena: ARENA_BY_ID[arenaId],
    sizeScale: 1,
    rules: { ...DEFAULT_RULES },
    seed
  });
}

function worstGap(b) {
  let worst = Infinity;
  for (let i = 0; i < b.units.length; i++) {
    for (let j = i + 1; j < b.units.length; j++) {
      const A = b.units[i], B = b.units[j];
      const d = Math.hypot(A.x - B.x, A.y - B.y) / SCALE;
      const gap = d - (A.r + B.r) / SCALE;
      if (gap < worst) worst = gap;
    }
  }
  return worst;
}

console.log('=== worst gap right after construction (no steps) ===');
for (const n of [2, 3, 4]) {
  const b = mk(Array(n).fill('test'), Array(n).fill('test'));
  console.log(`  ${n} per team: worstGap = ${worstGap(b).toFixed(1)}  ` +
    `(ball r=${b.units[0].r / SCALE}, so gap should be > 0)`);
}

console.log('\n=== positions of a 3-per-team spawn ===');
{
  const b = mk(Array(3).fill('test'), Array(3).fill('test'));
  for (const u of b.units) {
    console.log(`  #${u.id} team=${u.team} pos=(${(u.x / SCALE).toFixed(1)},${(u.y / SCALE).toFixed(1)}) ` +
      `r=${u.r / SCALE}`);
  }
  const arena = ARENA_BY_ID['rect'];
  console.log(`  arena bounds: x 0..720  y 0..440`);
}

console.log('\n=== is anything outside the arena? ===');
{
  const b = mk(Array(4).fill('test'), Array(4).fill('test'));
  let outside = 0;
  for (const u of b.units) {
    const x = u.x / SCALE, y = u.y / SCALE, r = u.r / SCALE;
    const ok = x >= r - 1 && x <= 720 - r + 1 && y >= r - 1 && y <= 440 - r + 1;
    if (!ok) { outside++; console.log(`  #${u.id} OUTSIDE: (${x.toFixed(1)},${y.toFixed(1)}) r=${r}`); }
  }
  console.log(`  outside count: ${outside}`);
}

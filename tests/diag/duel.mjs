/* Diagnostic: does a 1v1 duel (which can miss each other for a long time in a
   big arena) eventually resolve on its own? There is no stalemate breaker any
   more, so "resolves naturally" is now a hard requirement, not a nice-to-have.
   (ASCII only.) */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

function duel(arenaId, seed, rules = {}) {
  return new Battle({
    teams: [['test'], ['test']].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
    arena: ARENA_BY_ID[arenaId],
    rules: { ...DEFAULT_RULES, ...rules },
    seed
  });
}

console.log('=== 1v1 duels across arenas/seeds: do they resolve without any fallback? ===');
console.log('arena       seed   frames   seconds  reason                    minDist  contactRange');
const CONTACT = makeUnitStats('test').r * 2 + 6;
let stuck = 0, total = 0;
for (const arenaId of ['rect', 'octagon', 'circle', 'triangle']) {
  for (const seed of [31, 7, 555]) {
    const b = duel(arenaId, seed);
    let minDist = Infinity;
    while (!b.over && b.frame < b.maxFrames) {
      b.step();
      const A = b.units[0], B = b.units[1];
      if (A.alive && B.alive) {
        const d = Math.hypot(A.x - B.x, A.y - B.y) / SCALE;
        if (d < minDist) minDist = d;
      }
    }
    total++;
    if (!b.endReason.includes('阵亡')) stuck++;
    console.log(
      `${arenaId.padEnd(11)} ${String(seed).padStart(4)}  ${String(b.frame).padStart(6)}  ` +
      `${(b.frame / 60).toFixed(1).padStart(7)}  ${b.endReason.padEnd(24)}  ` +
      `${minDist.toFixed(1).padStart(7)}  ${String(CONTACT).padStart(12)}`
    );
  }
}
console.log(`  --> ${total - stuck}/${total} 自然打出结果 ${stuck === 0 ? '✅' : `❌ ${stuck} 场没打完`}`);

console.log('\n=== how many encounters does a duel actually get? ===');
{
  const b = duel('rect', 31);
  let hits = 0, bounces = 0;
  while (!b.over && b.frame < b.maxFrames) {
    const before = b.events.length;
    b.step();
    for (const e of b.events.slice(before)) {
      if (e.type === 'hit') hits++;
      if (e.type === 'bounce') bounces++;
    }
  }
  console.log(`  rect seed=31: frames=${b.frame} (${(b.frame / 60).toFixed(1)}s) hits=${hits} ballCollisions=${bounces} :: ${b.endReason}`);
}

console.log('\n=== scaling: 1v1 in a small arena should be fast ===');
for (const arenaId of ['triangle', 'diamond']) {
  const b = duel(arenaId, 3);
  b.runToEnd();
  console.log(`  ${arenaId.padEnd(10)} frames=${String(b.frame).padStart(5)} (${(b.frame / 60).toFixed(1)}s) :: ${b.endReason}`);
}

/* Diagnostic: pacing of the pure-elastic-bounce model.
   Why do matches never finish? Measure collision frequency and damage cadence.
   (ASCII only on purpose: avoids shell re-encoding issues.) */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

function mk(teams, arenaId = 'octagon', extra = {}, seed = 99) {
  return {
    teams: teams.map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
    arena: ARENA_BY_ID[arenaId],
    rules: { ...DEFAULT_RULES, ...extra },
    seed
  };
}

function report(tag, cfg) {
  const b = new Battle(cfg);
  b.runToEnd();
  const bounces = b.events.filter(e => e.type === 'bounce').length;
  const hits = b.events.filter(e => e.type === 'hit').length;
  const walls = b.events.filter(e => e.type === 'wall').length;
  const alive = b.units.filter(u => u.alive);
  const collisionHz = bounces / (b.frame / 60);
  console.log(
    `${tag.padEnd(26)} frame=${String(b.frame).padStart(5)} (${(b.frame / 60).toFixed(0)}s) ` +
    `bounce=${String(bounces).padStart(5)} hit=${String(hits).padStart(4)} wall=${String(walls).padStart(5)} ` +
    `collHz=${collisionHz.toFixed(2)} alive=${alive.length}/${b.units.length} :: ${b.endReason}`
  );
  return b;
}

console.log('=== baseline: pure elastic, no drag ===');
for (const n of [2, 3, 4]) {
  report(`${n}v${n} octagon`, mk(Array.from({ length: n }, () => ['test', 'test'])));
}

console.log('\n=== variants (2v2, octagon) ===');
report('speedScale 2', mk([['test', 'test'], ['test', 'test']], 'octagon', { speedScale: 2 }));
report('speedScale 3', mk([['test', 'test'], ['test', 'test']], 'octagon', { speedScale: 3 }));
report('small arena (triangle)', mk([['test', 'test'], ['test', 'test']], 'triangle'));
report('drag 0.15', mk([['test', 'test'], ['test', 'test']], 'octagon', { drag: 0.15 }));
report('drag 0.4', mk([['test', 'test'], ['test', 'test']], 'octagon', { drag: 0.4 }));
report('restitution 0.75', mk([['test', 'test'], ['test', 'test']], 'octagon', { restitution: 0.75 }));
report('restitution 0.5', mk([['test', 'test'], ['test', 'test']], 'octagon', { restitution: 0.5 }));

console.log('\n=== HP curve over time (2v2 octagon baseline) ===');
{
  const b = new Battle(mk([['test', 'test'], ['test', 'test']]));
  for (let f = 0; f < 5400; f++) {
    b.step();
    if (f % 600 === 0) {
      console.log(`  t=${String((f / 60).toFixed(0)).padStart(3)}s  hp=${b.units.map(u => Math.round(u.hp)).join('/')}`);
    }
  }
}

console.log('\n=== contact frames vs damage events (2v2 octagon, 60s) ===');
{
  const b = new Battle(mk([['test', 'test'], ['test', 'test']]));
  let contactFrames = 0, dmgFrames = 0;
  for (let f = 0; f < 3600; f++) {
    b.step();
    let touching = false;
    for (let i = 0; i < b.units.length; i++) {
      for (let j = i + 1; j < b.units.length; j++) {
        const A = b.units[i], B = b.units[j];
        if (!A.alive || !B.alive || A.team === B.team) continue;
        const d = Math.hypot(A.x - B.x, A.y - B.y);
        if (d <= A.r + B.r + 6 * SCALE) touching = true;
      }
    }
    if (touching) contactFrames++;
    if (b.events.some(e => e.type === 'hit' && e.f === f)) dmgFrames++;
  }
  console.log(`  contact frames: ${contactFrames}/3600  (${(contactFrames / 60).toFixed(1)}s of 60s)`);
  console.log(`  damage frames:  ${dmgFrames}  (pair cooldown 0.5s -> theoretical max ~120)`);
}

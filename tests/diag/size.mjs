/* Diagnostic: does scaling the arena actually increase collision frequency?
   Theory: collision rate scales with 1/area = 1/size^2.
   (ASCII only.) */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

function duel(arenaId, seed, sizeScale, extraRules = {}) {
  return new Battle({
    teams: [['test'], ['test']].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
    arena: ARENA_BY_ID[arenaId],
    sizeScale,
    rules: { ...DEFAULT_RULES, ...extraRules },
    seed
  });
}

console.log('=== verify the arena really is scaled ===');
{
  const b = duel('rect', 31, 0.5);
  console.log(`  sizeScale=${b.sizeScale}`);
  const sh = b.arena.shape;
  const xs = sh.points.map(p => p[0]), ys = sh.points.map(p => p[1]);
  console.log(`  scaled bounds: x ${Math.min(...xs)}..${Math.max(...xs)}  y ${Math.min(...ys)}..${Math.max(...ys)}`);
  console.log(`  (original rect was 0..720 x 0..440, centre 360,220)`);
  const u = b.units[0];
  console.log(`  spawn positions inside: A=(${(u.x / SCALE).toFixed(0)},${(u.y / SCALE).toFixed(0)})`);
}

console.log('\n=== duel timing and contact count vs arena size ===');
console.log('size  area%   arena      seed  seconds   contacts  collisions  walls');
for (const sizeScale of [1.0, 0.75, 0.5, 0.35]) {
  let secs = 0, contacts = 0, bounces = 0, walls = 0, n = 0;
  for (const arenaId of ['rect', 'octagon', 'circle']) {
    for (const seed of [31, 7, 555]) {
      const b = duel(arenaId, seed, sizeScale);
      while (!b.over && b.frame < b.maxFrames) b.step();
      secs += b.frame / 60;
      contacts += b.events.filter(e => e.type === 'hit').length;
      bounces += b.events.filter(e => e.type === 'bounce').length;
      walls += b.events.filter(e => e.type === 'wall').length;
      n++;
    }
  }
  console.log(
    `${sizeScale.toFixed(2)}  ${String(Math.round(sizeScale * sizeScale * 100)).padStart(4)}%   ` +
    `${'(9 duels)'.padEnd(10)}       ${(secs / n).toFixed(1).padStart(6)}   ` +
    `${(contacts / n).toFixed(1).padStart(8)}  ${(bounces / n).toFixed(1).padStart(10)}  ${(walls / n).toFixed(1).padStart(5)}`
  );
}

console.log('\n=== per-arena detail at 50% vs 100% ===');
console.log('arena      seed | 100%: sec/contacts |  50%: sec/contacts');
for (const arenaId of ['rect', 'octagon', 'circle', 'triangle']) {
  for (const seed of [31, 7, 555]) {
    const run = (sz) => {
      const b = duel(arenaId, seed, sz);
      while (!b.over && b.frame < b.maxFrames) b.step();
      return { s: b.frame / 60, c: b.events.filter(e => e.type === 'hit').length };
    };
    const a = run(1.0), c = run(0.5);
    console.log(`${arenaId.padEnd(10)} ${String(seed).padStart(4)} | ` +
      `${a.s.toFixed(1).padStart(6)}s / ${String(a.c).padStart(3)}      | ` +
      `${c.s.toFixed(1).padStart(6)}s / ${String(c.c).padStart(3)}`);
  }
}

console.log('\n=== determinism must still hold with scaling ===');
{
  const cfg = { teams: null };
  void cfg;
  const mk = () => duel('octagon', 20260930, 0.5);
  const fps = [0, 1, 2].map(() => {
    const b = mk();
    while (!b.over && b.frame < b.maxFrames) b.step();
    return b.fingerprint();
  });
  console.log(`  three runs: ${fps.join(' / ')} -> ${fps.every(f => f === fps[0]) ? 'PASS' : 'FAIL'}`);
}

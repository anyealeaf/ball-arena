/* Diagnostic: which frame has a small displacement, and why?
   Is it a real stall or a legitimate boundary-clamp frame?
   (ASCII only.) */
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

for (const arenaId of ['rect', 'circle']) {
  const b = new Battle({
    teams: [['test'], ['test']].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
    arena: ARENA_BY_ID[arenaId],
    rules: { ...DEFAULT_RULES },
    seed: 8888
  });
  const u = b.units[0];
  console.log(`\n===== ${arenaId} =====`);
  let last = null;
  for (let i = 0; i < 2400 && !b.over && u.alive; i++) {
    const evStart = b.events.length;
    const px = u.x / SCALE, py = u.y / SCALE;
    b.step();
    const x = u.x / SCALE, y = u.y / SCALE;
    const moved = last ? Math.hypot(x - last[0], y - last[1]) : 99;
    const evs = b.events.slice(evStart).map(e => e.type + (e.turned ? `(turn ${e.turned.toFixed(1)})` : ''));
    if (moved < 0.6) {
      console.log(`  frame ${i}: moved=${moved.toFixed(3)}  pos=(${px.toFixed(2)},${py.toFixed(2)}) -> (${x.toFixed(2)},${y.toFixed(2)})  events=[${evs.join(',')}]`);
      console.log(`    v=(${u.vx},${u.vy}) speed=${(Math.hypot(u.vx, u.vy) / SCALE).toFixed(2)}`);
      // was this frame's displacement dominated by a clamp?
      const dx = x - px, dy = y - py;
      console.log(`    actual delta=(${dx.toFixed(3)},${dy.toFixed(3)})  expected from velocity=(${(u.vx / SCALE / 60).toFixed(3)},${(u.vy / SCALE / 60).toFixed(3)})`);
    }
    last = [x, y];
  }
}
console.log('\nIf the delta is much smaller than velocity/60 and the frame coincides');
console.log('with a clamp back inside the arena, it is a legitimate boundary frame.');

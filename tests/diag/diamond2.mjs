/* Diagnostic: diamond arena - is the ball really frozen, or oscillating
   in a tiny loop (which nets near-zero displacement but is NOT stuck)?
   (ASCII only.) */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

const cfg = {
  teams: [['test'], ['test']].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
  arena: ARENA_BY_ID['diamond'],
  sizeScale: 1,
  rules: { ...DEFAULT_RULES },
  seed: 8888
};
const b = new Battle(cfg);
const u = b.units[0];

const pos = [];
const speeds = [];
for (let i = 0; i < 2400 && !b.over && u.alive; i++) {
  b.step();
  pos.push([u.x / SCALE, u.y / SCALE]);
  speeds.push(Math.hypot(u.vx, u.vy) / SCALE);
}

// sliding 60-frame windows with near-zero net displacement
console.log('windows where net displacement < 3 units:');
let found = 0;
for (let i = 60; i < pos.length; i++) {
  const dx = pos[i][0] - pos[i - 60][0];
  const dy = pos[i][1] - pos[i - 60][1];
  const net = Math.hypot(dx, dy);
  if (net < 3) {
    found++;
    // how far did it actually travel (sum of per-frame steps)?
    let path = 0;
    for (let k = i - 59; k <= i; k++) {
      path += Math.hypot(pos[k][0] - pos[k - 1][0], pos[k][1] - pos[k - 1][1]);
    }
    const minS = Math.min(...speeds.slice(i - 60, i + 1));
    const maxS = Math.max(...speeds.slice(i - 60, i + 1));
    console.log(`  frame ${i}: net=${net.toFixed(2)}  pathLength=${path.toFixed(1)}  ` +
      `speed ${minS.toFixed(1)}~${maxS.toFixed(1)}  pos=(${pos[i][0].toFixed(1)},${pos[i][1].toFixed(1)})`);
    if (found > 4) break;
  }
}
console.log(`total such windows: ${found}`);
console.log('\ninterpretation:');
console.log('  pathLength large + net small => oscillating, NOT stuck (fine)');
console.log('  pathLength ~ 0               => genuinely frozen (bug)');

/* Diagnostic: (a) hand-placed head-on setup - does a bounce fire?
                (b) which ball is e.a in practice?
   (ASCII only.) */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

console.log('=== A. hand-placed head-on collision ===');
{
  const b = new Battle({
    teams: [['test'], ['test']].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
    arena: ARENA_BY_ID['rect'],
    sizeScale: 1,
    rules: { ...DEFAULT_RULES, steerDegPerSec: 0, wallDeflectDeg: 0 },
    seed: 1
  });
  const [A, B] = b.units;
  const cx = 360 * SCALE, cy = 220 * SCALE;
  // A 静止，B 从右侧以 120 向左冲
  A.x = cx - 16 * SCALE; A.y = cy; A.vx = 0; A.vy = 0;
  B.x = cx + 16 * SCALE + 2000; B.y = cy; B.vx = -120 * SCALE; B.vy = 0;
  console.log(`  A#${A.id} pos=(${A.x / SCALE},${A.y / SCALE}) v=(${A.vx},${A.vy})  r=${A.r / SCALE}`);
  console.log(`  B#${B.id} pos=(${B.x / SCALE},${B.y / SCALE}) v=(${B.vx},${B.vy})  r=${B.r / SCALE}`);

  let fired = null;
  for (let i = 0; i < 300 && !fired; i++) {
    const evStart = b.events.length;
    b.step();
    const ev = b.events.slice(evStart);
    const bo = ev.find(e => e.type === 'bounce');
    if (bo) fired = { ...bo, frame: i };
    if (i % 40 === 0 || bo) {
      const d = Math.hypot(A.x - B.x, A.y - B.y) / SCALE;
      console.log(`  f${String(i).padStart(3)} dist=${d.toFixed(1)} vA=(${A.vx},${A.vy}) vB=(${B.vx},${B.vy})` +
        (bo ? `  <== bounce a=${bo.a} b=${bo.b} n=(${bo.nx},${bo.ny}) impact=${bo.value.toFixed(0)}` : ''));
    }
  }
  console.log(`  bounce fired: ${fired ? 'YES at frame ' + fired.frame : 'NO'}`);
  if (fired) {
    const na = (A.vx * fired.nx + A.vy * fired.ny) / SCALE;
    const nb = (B.vx * fired.nx + B.vy * fired.ny) / SCALE;
    console.log(`  after: vA=(${A.vx},${A.vy}) vB=(${B.vx},${B.vy})`);
    console.log(`  A along n = ${na.toFixed(1)}   B along n = ${nb.toFixed(1)}`);
    console.log(`  (n points from #${fired.a} to #${fired.b})`);
  }
}

console.log('\n=== B. is e.a always the lower index? ===');
{
  const b = new Battle({
    teams: [['test', 'test'], ['test', 'test']].map(u =>
      ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
    arena: ARENA_BY_ID['rect'],
    sizeScale: 0.5,
    rules: { ...DEFAULT_RULES },
    seed: 31
  });
  let aLower = 0, aHigher = 0;
  while (!b.over && b.frame < b.maxFrames) {
    const evStart = b.events.length;
    b.step();
    for (const e of b.events.slice(evStart)) {
      if (e.type !== 'bounce') continue;
      if (e.a < e.b) aLower++; else aHigher++;
    }
  }
  console.log(`  e.a < e.b : ${aLower}   e.a > e.b : ${aHigher}`);
  console.log('  -> if both occur, the sign assumption "e.a is always the same ball" is wrong.');
}

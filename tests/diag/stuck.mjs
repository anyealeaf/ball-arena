/* Diagnostic: is the remaining overlap TRANSIENT (a collision frame)
   or PERSISTENT (balls stuck inside each other)?
   Transient is normal physics; persistent is the bug the user reported.
   (ASCII only.) */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

function run(arenaId, sizeScale, seed, n = 1) {
  const teams = n === 1
    ? [['test'], ['test']]
    : [Array(n).fill('test'), Array(n).fill('test')];
  return new Battle({
    teams: teams.map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
    arena: ARENA_BY_ID[arenaId],
    sizeScale,
    rules: { ...DEFAULT_RULES },
    seed
  });
}

console.log('=== consecutive overlap runs (per pair) ===');
console.log('arena     size  seed | longestRun  runs>=15f(0.25s)  maxOverlap');
for (const arenaId of ['rect', 'octagon', 'circle', 'triangle']) {
  for (const sizeScale of [0.5, 1.0]) {
    for (const seed of [31, 7]) {
      const b = run(arenaId, sizeScale, seed);
      // 每个球对维护"已经连续重叠多少帧"
      const streak = new Map();
      let longest = 0, longRuns = 0, maxOv = 0;
      while (!b.over && b.frame < b.maxFrames) {
        b.step();
        const alive = b.units.filter(u => u.alive);
        const seen = new Set();
        for (let i = 0; i < alive.length; i++) {
          for (let j = i + 1; j < alive.length; j++) {
            const A = alive[i], B = alive[j];
            const key = Math.min(A.id, B.id) * 100 + Math.max(A.id, B.id);
            const d = Math.hypot(A.x - B.x, A.y - B.y);
            const rr = A.r + B.r;
            if (d < rr - 0.5) {          // 真重叠（留 0.5 单位容差）
              seen.add(key);
              const v = (streak.get(key) || 0) + 1;
              streak.set(key, v);
              if (v > longest) longest = v;
              if (v === 15) longRuns++;   // 刚好跨过 0.25 秒的阈值
              const ov = (rr - d) / SCALE;
              if (ov > maxOv) maxOv = ov;
            }
          }
        }
        // 未重叠的球对清零
        for (const key of [...streak.keys()]) {
          if (!seen.has(key)) streak.delete(key);
        }
      }
      console.log(`${arenaId.padEnd(9)} ${String(Math.round(sizeScale * 100)).padStart(3)}%  ${String(seed).padStart(4)} | ` +
        `${String(longest).padStart(9)}f  ${String(longRuns).padStart(16)}  ${maxOv.toFixed(1).padStart(9)}`);
    }
  }
}

console.log('\n=== interpretation ===');
console.log('longestRun of a few frames = a normal collision (transient overlap).');
console.log('longestRun of hundreds of frames = balls genuinely stuck together.');

console.log('\n=== arena size vs match duration (re-check) ===');
console.log('size | avg seconds | avg contacts | avg bounce');
for (const sizeScale of [1.0, 0.75, 0.5, 0.35]) {
  let secs = 0, contacts = 0, bounce = 0, n = 0;
  for (const arenaId of ['rect', 'octagon', 'circle']) {
    for (const seed of [31, 7, 555]) {
      const b = run(arenaId, sizeScale, seed);
      while (!b.over && b.frame < b.maxFrames) b.step();
      secs += b.frame / 60;
      contacts += b.events.filter(e => e.type === 'hit').length;
      bounce += b.events.filter(e => e.type === 'bounce').length;
      n++;
    }
  }
  console.log(`${String(Math.round(sizeScale * 100)).padStart(3)}% | ${(secs / n).toFixed(1).padStart(11)} | ` +
    `${(contacts / n).toFixed(1).padStart(12)} | ${(bounce / n).toFixed(1).padStart(10)}`);
}

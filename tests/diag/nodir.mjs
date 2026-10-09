/* Diagnostic: after a ball-ball collision, how much does each ball's
   direction actually change? Flag cases where a significant impact
   produces almost no turning.
   (ASCII only.) */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

function angleDeg(vx, vy) { return ((Math.atan2(vy, vx) * 180) / Math.PI + 360) % 360; }
function deltaDeg(a, b) {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const buckets = { '<2': 0, '2-10': 0, '10-45': 0, '45-135': 0, '>135': 0 };
let total = 0;
const examples = [];

for (const arenaId of ['rect', 'octagon', 'circle', 'triangle', 'diamond']) {
  for (const sizeScale of [0.5, 1.0]) {
    for (const seed of [31, 7, 555, 12, 99]) {
      const b = new Battle({
        teams: [['test', 'test'], ['test', 'test']].map(u =>
          ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
        arena: ARENA_BY_ID[arenaId],
        sizeScale,
        rules: { ...DEFAULT_RULES },
        seed
      });

      // 记录每个球在碰撞前的速度方向
      const prevDir = new Map();
      while (!b.over && b.frame < b.maxFrames) {
        const evStart = b.events.length;
        // 碰撞前方向
        for (const u of b.units) if (u.alive && (u.vx || u.vy)) prevDir.set(u.id, angleDeg(u.vx, u.vy));
        b.step();
        for (const e of b.events.slice(evStart)) {
          if (e.type !== 'bounce') continue;
          // 碰撞严重程度：事件里记的是相对法向速度
          const impact = Math.abs(e.value);
          for (const id of [e.a, e.b]) {
            if (id < 0) continue;
            const u = b.units[id];
            if (!u || !u.alive) continue;
            const before = prevDir.get(id);
            if (before === undefined) continue;
            const after = angleDeg(u.vx, u.vy);
            const d = deltaDeg(before, after);
            total++;
            if (d < 2) buckets['<2']++;
            else if (d < 10) buckets['2-10']++;
            else if (d < 45) buckets['10-45']++;
            else if (d < 135) buckets['45-135']++;
            else buckets['>135']++;
            // 只记录"有实际撞击强度但几乎没转向"的可疑案例
            if (d < 10 && impact > 40 && examples.length < 8) {
              examples.push({ arenaId, sizeScale, seed, id, d, impact,
                before: before.toFixed(1), after: after.toFixed(1) });
            }
          }
        }
      }
    }
  }
}

console.log(`total bounce-side samples: ${total}`);
console.log('direction change distribution:');
for (const [k, v] of Object.entries(buckets)) {
  console.log(`  ${k.padEnd(8)} deg : ${String(v).padStart(5)}  (${(v / total * 100).toFixed(1)}%)`);
}
console.log('\nsuspicious cases (impact > 40 but turned < 10 deg):');
if (!examples.length) console.log('  none');
for (const e of examples) {
  console.log(`  ${e.arenaId}/${Math.round(e.sizeScale * 100)}%/seed${e.seed} ball#${e.id} ` +
    `impact=${e.impact.toFixed(0)} dir ${e.before} -> ${e.after} (turned ${e.d.toFixed(1)} deg)`);
}
console.log('\nnote: a near-zero turn is PHYSICALLY CORRECT for a grazing hit');
console.log('      (impact speed along the normal is tiny). What matters is whether');
console.log('      strong impacts (large normal speed) still turn the ball.');

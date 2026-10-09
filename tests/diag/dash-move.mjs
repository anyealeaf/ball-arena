/* Does the dashing ball actually MOVE?
 *
 * Reason this exists: earlier checks sampled u.vx/u.vy, which the dash state
 * machine sets correctly, so they reported a healthy decaying speed curve while
 * the ball might never have been displaced at all. Velocity is not movement.
 * This probe reads the snapshot POSITIONS the renderer uses, so it measures what
 * a viewer would actually see.
 *
 * Usage: node tests/diag/dash-move.mjs
 */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle, SNAP_STRIDE } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';
import { CHARGE_FRAMES, DASH_FRAMES } from '../../js/skills.js';

const b = new Battle({
  teams: [['test_skill'], ['test']]
    .map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
  arena: ARENA_BY_ID.rect,
  sizeScale: 1,
  rules: { ...DEFAULT_RULES },
  seed: 31,
});

let rows = [];
let started = false;
while (!b.over && b.frame < b.maxFrames) {
  b.step();
  const u = b.units[0];
  const d = b.snapshots[b.snapshots.length - 1].data;   // the frame just recorded
  const sx = d[0], sy = d[1];
  if (u.mode === 'dashing' || u.mode === 'charging') {
    started = true;
    rows.push({
      f: b.frame, mode: u.mode,
      sx, sy,
      spd: +(Math.hypot(u.vx, u.vy) / SCALE).toFixed(1),
      dx: rows.length ? +(sx - rows[rows.length - 1].sx).toFixed(2) : 0,
      dy: rows.length ? +(sy - rows[rows.length - 1].sy).toFixed(2) : 0,
    });
  } else if (started) break;
}

const charge = rows.filter(r => r.mode === 'charging');
const dash = rows.filter(r => r.mode === 'dashing');
console.log(`蓄力帧 ${charge.length}（期望 ${CHARGE_FRAMES}）`);
console.log(`冲刺帧 ${dash.length}（期望 ${DASH_FRAMES}）`);

const dist = (list) => {
  let s = 0;
  for (let i = 1; i < list.length; i++) s += Math.hypot(list[i].sx - list[i - 1].sx, list[i].sy - list[i - 1].sy);
  return s;
};
const chargeDist = dist(charge), dashDist = dist(dash);
console.log(`\n蓄力期间总位移 ${chargeDist.toFixed(2)} 单位（应当 ≈ 0）`);
console.log(`冲刺期间总位移 ${dashDist.toFixed(2)} 单位（3 倍速跑 2 秒，应当有几百单位）`);

console.log('\n冲刺逐帧（位置来自快照，即玩家看到的位置）：');
console.log('   帧  模式      快照x     快照y    速度   每帧位移');
for (const r of dash.filter((_, i) => i < 6 || i % 30 === 0 || i > dash.length - 4)) {
  const step = Math.hypot(r.dx, r.dy).toFixed(2);
  console.log(`  ${String(r.f).padStart(4)}  ${r.mode.padEnd(8)} ${String(r.sx).padStart(8)} ${String(r.sy).padStart(8)} ` +
    `${String(r.spd).padStart(6)}  ${String(step).padStart(6)}`);
}

let ok = true;
const chk = (n, c, note = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${note ? '  — ' + note : ''}`); if (!c) ok = false; };
console.log('\n结论：');
chk('蓄力时长 = CHARGE_FRAMES', charge.length === CHARGE_FRAMES, `${charge.length}`);
chk('冲刺时长 = DASH_FRAMES', dash.length === DASH_FRAMES, `${dash.length}`);
chk('蓄力期间几乎不动', chargeDist < 1, `${chargeDist.toFixed(2)} 单位`);
chk('冲刺期间确实在移动', dashDist > 100, `${dashDist.toFixed(2)} 单位`);
const movingFrames = dash.filter((r, i) => i > 0 && (r.dx !== 0 || r.dy !== 0)).length;
chk('冲刺每一帧都在位移', movingFrames === dash.length - 1,
  `${movingFrames}/${dash.length - 1} 帧`);
console.log(ok ? '\n全部通过' : '\n有失败项');
process.exit(ok ? 0 : 1);

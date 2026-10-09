/* 冲刺撞墙之后到底发生了什么？
 *
 * 现象（用户报告）：技能球冲刺撞到墙壁后，在墙上"抽搐"一下，然后进入"吸附"状态。
 * 推测：撞墙时没有把技能给的速度一起归零。
 *
 * 判定标准（只看快照位置，不看速度 —— 速度被覆盖过就说明不了问题）：
 *   · 冲刺期间球是否被"钉"在墙面上（多帧位置不变 / 只在墙面上来回抖）
 *   · 被钉住的帧数
 *   · 每帧的位移方向：撞墙后应当离开墙面，而不是继续贴回去
 *
 * 用法：node tests/diag/dash-wall.mjs
 */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle, SNAP_STRIDE } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

function run(arenaId, seed) {
  const b = new Battle({
    teams: [['test_skill'], ['test']].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
    arena: ARENA_BY_ID[arenaId],
    sizeScale: 1,
    rules: { ...DEFAULT_RULES },
    seed,
  });
  const u = b.units[0];
  const rows = [];
  let prev = null;
  while (!b.over && b.frame < b.maxFrames) {
    const wallStart = b.events.length;
    b.step();
    const d = b.snapshots[b.snapshots.length - 1].data;
    const x = d[0], y = d[1];
    /* 快照里 mode 是数字：0 普通 / 1 蓄力 / 2 冲刺（见 SNAP_STRIDE 说明）。
       这里统一转成字符串，免得又拿数字去和 'dashing' 比。 */
    const modeNum = d[7];
    const mode = modeNum > 1.5 ? 'dashing' : (modeNum > 0.5 ? 'charging' : 'normal');
    const wall = b.events.slice(wallStart).filter(e => e.type === 'wall').length;
    const wallN = b.events.slice(wallStart).find(e => e.type === 'wall');
    rows.push({
      f: b.frame, mode, x, y, wall,
      vx: u.vx, vy: u.vy,
      nx: wallN ? wallN.nx : 0, ny: wallN ? wallN.ny : 0,
      turned: wallN ? wallN.turned : 0,
      spd: +(Math.hypot(u.vx, u.vy) / SCALE).toFixed(1),
      dx: prev ? +(x - prev.x).toFixed(3) : 0,
      dy: prev ? +(y - prev.y).toFixed(3) : 0,
      step: prev ? +Math.hypot(x - prev.x, y - prev.y).toFixed(3) : 0,
    });
    prev = { x, y };
  }
  return { b, u, rows };
}

/* 球半径 16；场地边界内缩，所以"贴墙"= 球心到边界 16 以内。
   这里用"本帧位置和上一帧几乎没变"来判断被钉住，与场地形状无关。 */
let totalPinned = 0, totalDashFrames = 0, totalWallHits = 0;
const STUCK_EPS = 0.02;

for (const [arenaId, seed] of [['rect', 31], ['rect', 7], ['octagon', 31], ['circle', 31]]) {
  const { b, u, rows } = run(arenaId, seed);
  const dash = rows.filter(r => r.mode === 'dashing');
  const pinned = dash.filter(r => r.step < STUCK_EPS);
  totalPinned += pinned.length;
  totalDashFrames += dash.length;
  totalWallHits += rows.filter(r => r.wall > 0).length;

  console.log(`=== ${arenaId} seed=${seed} : 冲刺 ${dash.length} 帧，其中被钉住 ${pinned.length} 帧，` +
    `撞墙 ${rows.filter(r => r.wall > 0).length} 次 ===`);

  /* 找出"冲刺中撞墙"的那一段，把前后 6 帧打出来 */
  const hit = dash.find(r => r.wall > 0);
  if (hit) {
    const i = rows.indexOf(hit);
    console.log('  冲刺中撞墙前后（位置来自快照）：');
    console.log('     帧  模式       x        y      速度   本帧位移  撞墙');
    for (const r of rows.slice(Math.max(0, i - 3), i + 7)) {
      const mark = r.step < STUCK_EPS ? '  <= 位置没变' : '';
      console.log(`  ${String(r.f).padStart(5)}  ${r.mode.padEnd(8)} ${String(r.x).padStart(8)} ${String(r.y).padStart(8)} ` +
        `${String(r.spd).padStart(6)}  ${String(r.step).padStart(7)}  ${r.wall ? 'YES' : '   '}${mark}`);
    }
  } else {
    console.log('  （本次冲刺没有撞到墙）');
  }
  console.log('');
}

/* 把"位置完全没变"的帧单独摊开：要看清它是被墙钉住，还是被别的球挤住。
   同时打出速度方向与墙面内法线的点积 —— 点积为负说明速度正朝着墙里，
   也就是"冲刺速度把撞墙反弹整个覆盖掉了"。 */
console.log('=== 被钉住的帧逐帧细节（位置没变的冲刺帧）===');
for (const [arenaId, seed] of [['circle', 31], ['rect', 31], ['octagon', 31]]) {
  const { rows } = run(arenaId, seed);
  const pinned = rows.filter(r => r.mode === 'dashing' && r.step < STUCK_EPS);
  if (!pinned.length) { console.log(`  ${arenaId} seed=${seed}: 没有被钉住的帧`); continue; }
  const i = rows.indexOf(pinned[0]);
  console.log(`  --- ${arenaId} seed=${seed}：共 ${pinned.length} 帧被钉住，下面是第一段 ---`);
  console.log('     帧  模式       x        y      vx     vy    速度  本帧位移  撞墙  内法线(v·n)');
  for (const r of rows.slice(Math.max(0, i - 2), i + 6)) {
    const vn = r.wall ? ((r.vx * r.nx + r.vy * r.ny) / SCALE).toFixed(1) : '-';
    const mark = r.step < STUCK_EPS ? ' <== 位置没变' : '';
    console.log(`  ${String(r.f).padStart(5)}  ${r.mode.padEnd(8)} ${String(r.x).padStart(8)} ${String(r.y).padStart(8)} ` +
      `${String(r.vx).padStart(6)} ${String(r.vy).padStart(6)} ${String(r.spd).padStart(6)}  ` +
      `${String(r.step).padStart(7)}  ${r.wall ? 'YES' : '   '}  ${String(vn).padStart(9)}${mark}`);
  }
}

console.log('=== 汇总 ===');
console.log(`  冲刺总帧数 ${totalDashFrames}`);
console.log(`  冲刺期间"位置完全没变"的帧数 ${totalPinned}` +
  `  ${totalPinned === 0 ? '✅ 没有吸附/抽搐' : '❌ 存在吸附或抽搐'}`);

process.exit(totalPinned === 0 ? 0 : 1);

/* 为什么冲刺中的球速度 162 却一帧都不动？
 *
 * 上一个脚本（dash-wall.mjs）发现圆场里有 20 帧"速度很大但位移恰好为 0"。
 * 这个脚本把当帧的几何摊开：球心到圆心的距离、场地可活动半径、夹紧函数的
 * 返回值、以及另一个球在哪 —— 用来区分下面几种可能：
 *   (a) 球被判成在场外，每帧先移动再被夹回原地（净位移 0）
 *   (b) 球在场内，但被另一个球的碰撞分离推回原地
 *   (c) 别的什么原因
 *
 * 用法：node tests/diag/dash-wall2.mjs
 */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle, SNAP_STRIDE } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

const b = new Battle({
  teams: [['test_skill'], ['test']].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
  arena: ARENA_BY_ID.circle,
  sizeScale: 1,
  rules: { ...DEFAULT_RULES },
  seed: 31,
});

const u = b.units[0], foe = b.units[1];
const shape = b.shape();
console.log('场地几何：', JSON.stringify(shape));
console.log(`球半径 r=${u.r / SCALE}\n`);

const rows = [];
let prev = null;
while (!b.over && b.frame < b.maxFrames) {
  const wallStart = b.events.length;
  b.step();
  const d = b.snapshots[b.snapshots.length - 1].data;
  const x = d[0], y = d[1];
  const modeNum = d[7];
  const mode = modeNum > 1.5 ? 'dashing' : (modeNum > 0.5 ? 'charging' : 'normal');
  const wallEv = b.events.slice(wallStart).find(e => e.type === 'wall');
  const step = prev ? Math.hypot(x - prev.x, y - prev.y) : 0;

  // 自己算一遍"球心到圆圆心的距离"和"允许的最大距离"
  const dxc = x - shape.cx, dyc = y - shape.cy;
  const distC = Math.hypot(dxc, dyc);
  const limit = shape.r - u.r / SCALE;
  const dFoe = Math.hypot(foe.x / SCALE - x, foe.y / SCALE - y);
  const touchingFoe = dFoe <= (u.r + foe.r) / SCALE + 1;

  rows.push({
    f: b.frame, mode, x, y, step,
    distC, limit, outside: distC > limit + 1e-9,
    vx: u.vx, vy: u.vy,
    spd: +(Math.hypot(u.vx, u.vy) / SCALE).toFixed(1),
    dFoe: +dFoe.toFixed(1), touchingFoe,
    wall: wallEv ? 1 : 0,
  });
  prev = { x, y };
}

const pinned = rows.filter(r => r.mode === 'dashing' && r.step < 0.02);
console.log(`冲刺帧 ${rows.filter(r => r.mode === 'dashing').length}，其中位移为 0 的 ${pinned.length} 帧\n`);

if (pinned.length) {
  const i = rows.indexOf(pinned[0]);
  console.log('     帧  模式       x        y    速度  本帧位移  到圆心  可活动上限  判定在场外  到敌球  贴着敌球  撞墙');
  for (const r of rows.slice(Math.max(0, i - 2), i + 6)) {
    console.log(`  ${String(r.f).padStart(5)}  ${r.mode.padEnd(8)} ${String(r.x).padStart(8)} ${String(r.y).padStart(8)} ` +
      `${String(r.spd).padStart(6)}  ${String(r.step.toFixed(3)).padStart(8)}  ` +
      `${r.distC.toFixed(2).padStart(7)}  ${r.limit.toFixed(2).padStart(10)}  ` +
      `${(r.outside ? 'YES' : 'no').padStart(10)}  ${String(r.dFoe).padStart(6)}  ` +
      `${(r.touchingFoe ? 'YES' : 'no').padStart(8)}  ${r.wall ? 'YES' : ''}`);
  }

  const outs = pinned.filter(r => r.outside).length;
  const foes = pinned.filter(r => r.touchingFoe).length;
  console.log(`\n被钉住的 ${pinned.length} 帧中：`);
  console.log(`  球心超出可活动半径的: ${outs}`);
  console.log(`  正贴着敌球的:        ${foes}`);
  console.log(`  速度非零的:          ${pinned.filter(r => r.spd > 1).length}`);
  console.log(`\n结论倾向：${outs > foes ? '(a) 被场地边界夹回原地' : foes > 0 ? '(b) 被另一个球挤住' : '(c) 其他原因'}`);
}

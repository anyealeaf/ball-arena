/* 逐阶段追踪：冲刺中被钉在墙上的那一帧，位置到底在哪一步被改回去了？
 *
 * 这个脚本当初是用来抓"冲刺撞墙后被钉住"的（用户报告的抽搐+吸附）。
 * 现在它兼作守卫：**如果又出现"冲刺中位移为 0"的帧，它会复现并把
 * 每个阶段的位置/速度摊开，直接指出是哪一步把位移抹掉的。**
 * 复现不到（bug 已修）视为通过。
 *
 * 用法：node tests/diag/dash-wall3.mjs
 */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

const b = new Battle({
  teams: [['test_skill'], ['test']].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
  arena: ARENA_BY_ID.circle,
  sizeScale: 1,
  rules: { ...DEFAULT_RULES },
  seed: 31,
});

const u = b.units[0];
const shape = b.shape();
const R = shape.r, LIMIT = shape.r - u.r / SCALE;
const dist = (x, y) => Math.hypot(x / SCALE - shape.cx, y / SCALE - shape.cy);
const W = (v) => +(v / SCALE).toFixed(3);

/* 每个阶段取一次位置。phase 记录格式：[阶段名, x, y, vx, vy] */
let trace = [];
let tracing = false;
const samples = [];
const snap = (label) => {
  if (!tracing) return;
  samples.push({ label, x: u.x, y: u.y, vx: u.vx, vy: u.vy, d: dist(u.x, u.y) });
};

/* onMove 钩子正好打在"位置积分之前" */
u.hooks = u.hooks || {};
u.hooks.onMove = [() => snap('积分前')];

/* 包住会改位置的两个阶段 */
const wrap = (name) => {
  const orig = b[name].bind(b);
  b[name] = (...a) => {
    snap(`${name} 之前`);
    const r = orig(...a);
    snap(`${name} 之后`);
    return r;
  };
};
wrap('_collide');
wrap('_relieveOverlap');
wrap('_resolveAttacks');

/* 跑到第一次"冲刺中位移为 0"的帧为止 */
let prev = null, target = -1;
while (!b.over && b.frame < b.maxFrames) {
  const dPrev = { x: u.x, y: u.y };
  const wasDashing = u.mode === 'dashing';
  samples.length = 0;
  tracing = wasDashing;
  snap('step 开始');
  b.step();
  snap('step 结束');
  tracing = false;

  const moved = Math.hypot(u.x - dPrev.x, u.y - dPrev.y) / SCALE;
  if (wasDashing && moved < 0.02) { target = b.frame; break; }
}

if (target < 0) {
  console.log('✅ 没有出现"冲刺中位移为 0"的帧 —— 贴墙抽搐的问题不复现（这就是期望结果）');
  console.log(`   （已跑完 ${b.frame} 帧，${b.endReason || '未结束'}）`);
  process.exit(0);
}

console.log(`=== ❌ 复现到第 ${target} 帧：冲刺中位移为 0 ===`);
console.log(`场地 circle 圆心=(${shape.cx},${shape.cy}) r=${R}，球半径=${u.r / SCALE}，可活动上限=${LIMIT.toFixed(2)}\n`);
console.log('阶段             x         y      vx        vy      到圆心   是否在场外');
for (const s of samples) {
  const out = s.d > LIMIT + 1e-9;
  console.log(`${s.label.padEnd(16)} ${String(W(s.x)).padStart(8)} ${String(W(s.y)).padStart(8)} ` +
    `${String(s.vx).padStart(9)} ${String(s.vy).padStart(9)}  ${s.d.toFixed(3).padStart(8)}  ${out ? 'YES' : 'no'}`);
}

/* 找出位置发生变化的相邻阶段 */
console.log('\n位置变化发生在哪一段：');
let changed = false;
for (let i = 1; i < samples.length; i++) {
  const a = samples[i - 1], c = samples[i];
  if (a.x !== c.x || a.y !== c.y) {
    const d = Math.hypot(c.x - a.x, c.y - a.y) / SCALE;
    console.log(`  ${a.label} → ${c.label}: 位移 ${d.toFixed(3)}  (到圆心 ${a.d.toFixed(3)} → ${c.d.toFixed(3)})`);
    changed = true;
  }
}
if (!changed) console.log('  （整帧位置没有任何变化 —— 说明"球根本没被积分"，而不是被夹回来）');

console.log('\n❌ 贴墙抽搐复现了，需要修 —— 上面就是它被抹掉位移的那一步');
process.exit(1);

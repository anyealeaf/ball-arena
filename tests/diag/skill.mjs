/* 验证技能机制是否符合规格。
 * 用法：node tests/diag/skill.mjs
 */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';
import { SKILL_PARAMS, CHARGE_FRAMES, DASH_FRAMES } from '../../js/skills.js';

function mk(teamA, teamB, arenaId = 'rect', seed = 31) {
  return new Battle({
    teams: [teamA, teamB].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
    arena: ARENA_BY_ID[arenaId],
    sizeScale: 1,
    rules: { ...DEFAULT_RULES },
    seed
  });
}

const P = SKILL_PARAMS;
console.log('=== 参数 ===');
console.log(`  射击：每 ${P.shot.cooldown}s 一发，伤害 ${P.shot.damage}，速度 ${P.shot.speed}，半径 ${P.shot.radius}`);
console.log(`  冲刺：蓄力 ${P.dash.chargeTime}s，持续 ${P.dash.dashTime}s，` +
  `初速 ${P.dash.startSpeedMul}×→${P.dash.endSpeedMul}×，伤害 ${P.dash.damage}，击退 ${P.dash.knockback}\n`);

console.log('=== ① 定点射击：是否每 2.5 秒发射一次 ===');
{
  const b = mk(['test_skill'], ['test'], 'rect', 31);
  const shots = [];
  const hits = [];
  while (!b.over && b.frame < b.maxFrames) {
    const n0 = b.events.length;
    b.step();
    for (const e of b.events.slice(n0)) {
      if (e.type === 'shoot') shots.push(b.frame / 60);
      if (e.type === 'projHit') hits.push({ t: b.frame / 60, dmg: e.value });
    }
  }
  console.log(`  发射 ${shots.length} 次，时刻: ${shots.slice(0, 8).map(t => t.toFixed(2)).join(', ')}${shots.length > 8 ? ' ...' : ''}`);
  if (shots.length >= 2) {
    const gaps = shots.slice(1).map((t, i) => t - shots[i]);
    const avg = gaps.reduce((a, c) => a + c, 0) / gaps.length;
    console.log(`  平均间隔 ${avg.toFixed(3)}s（期望 ${P.shot.cooldown}）  ${Math.abs(avg - P.shot.cooldown) < 0.1 ? '✅' : '❌'}`);
  }
  console.log(`  命中 ${hits.length} 次，单次伤害 ${hits.length ? [...new Set(hits.map(h => h.dmg))].join(',') : '-'}（期望 ${P.shot.damage}）` +
    `  ${hits.length && hits.every(h => h.dmg === P.shot.damage) ? '✅' : '（可能未命中，见下）'}`);
  console.log(`  对局 ${(b.frame / 60).toFixed(1)}s 结束：${b.endReason}`);
}

console.log('\n=== ② 撞墙蓄力冲刺：状态机时间线 ===');
{
  const b = mk(['test_skill'], ['test'], 'rect', 31);
  const timeline = [];
  const projAt = [];
  /* 用「状态占用的帧数」来量时长，而不是用 chargeStart / dashStart 事件帧相减。
     事件标记的是瞬时时刻（撞墙那一帧蓄力开始、冲刺第一帧开始、冲刺最后一帧结束），
     相减天然差 1 帧，容易把正确的实现误判成差一帧。
     直接数"这一帧球处于什么状态、有没有动"，是无歧义的口径。 */
  const segs = [];            // [{ mode, frames, moved, contactMoved, d0, d1 }]
  const wallFrames = new Set();   // 发生过撞墙的帧号（用于判断冲刺是不是被墙终止的）
  let prevMode = 'normal';
  let prevPos = null;
  while (!b.over && b.frame < b.maxFrames) {
    const n0 = b.events.length;
    b.step();
    const u = b.units[0];
    /* 用「位置有没有变」判断动没动，不要用速度：
       蓄力中的球被别的球撞到时速度会瞬间非零（下一帧就被状态机清零），
       但它并没有真的移动。位置变化才是物理事实。 */
    const moved = prevPos ? (u.x !== prevPos.x || u.y !== prevPos.y) : false;
    prevPos = { x: u.x, y: u.y };
    /* 蓄力中的球自己不动，但可能被别的球"挤"开 —— 那是碰撞分离，是合法的。
       所以还要记录"这一帧是否有别的球和它接触"。 */
    const touched = b.units.some(o =>
      o !== u && o.alive &&
      Math.hypot(o.x - u.x, o.y - u.y) <= o.r + u.r + 2);
    const last = segs[segs.length - 1];
    if (last && last.mode === u.mode) {
      last.frames++;
      last.d1 = b.frame;
      if (moved) last.moved++;
      if (moved && !touched) last.selfMoved++;
    } else {
      segs.push({
        mode: u.mode, frames: 1, moved: moved ? 1 : 0, selfMoved: 0,
        d0: b.frame, d1: b.frame
      });
      if (moved && !touched) segs[segs.length - 1].selfMoved = 1;
    }
    if (u.mode !== prevMode) {
      timeline.push(`${(b.frame / 60).toFixed(2)}s  ${prevMode} → ${u.mode}`);
      prevMode = u.mode;
    }
    for (const e of b.events.slice(n0)) {
      if (e.type === 'shoot') projAt.push(b.frame);
      if (e.type === 'wall') wallFrames.add(b.frame);
    }
  }

  /* 对局在第 10 步判定胜负后就停止推进，此时若球正处于某状态，
     最后一段是被"截断"的，不能拿它跟完整时长比。 */
  const truncated = segs[segs.length - 1];
  if (segs.length) segs.pop();
  console.log(`  状态变化（末段 ${truncated.mode} ${truncated.frames} 帧因对局结束被截断，不计入统计）：`);
  for (const t of timeline.slice(0, 12)) console.log('    ' + t);

  const chargeSegs = segs.filter(s => s.mode === 'charging');
  const dashSegs = segs.filter(s => s.mode === 'dashing');
  console.log(`\n  蓄力段 ${chargeSegs.length} 段，冲刺段 ${dashSegs.length} 段`);
  const cFrames = chargeSegs.map(s => s.frames);
  const dFrames = dashSegs.map(s => s.frames);
  if (cFrames.length) {
    const allExact = cFrames.every(f => f === CHARGE_FRAMES);
    console.log(`  每段蓄力帧数 ${[...new Set(cFrames)].join(',')}（期望 ${CHARGE_FRAMES} = ${P.dash.chargeTime}s）` +
      `  ${allExact ? '✅ 精确' : '❌'}`);
    /* 蓄力期间小球不能"自己"移动；被别的球挤开属于碰撞分离，是合法的。
       所以判据是"没有任何一帧是在没接触的情况下位移的"。 */
    const selfMoved = chargeSegs.reduce((a, s) => a + s.selfMoved, 0);
    const shoved = chargeSegs.reduce((a, s) => a + (s.moved - s.selfMoved), 0);
    console.log(`  蓄力期间自主位移帧数 ${selfMoved}（期望 0）  ${selfMoved === 0 ? '✅ 没有自己动' : '❌'}` +
      `；被撞开帧数 ${shoved}（合法）`);
  }
  if (dFrames.length) {
    /* 冲刺时长是"上限"而不是"定长"：撞墙会立刻终止冲刺（然后由 onWall 技能接手蓄力）。
       所以判据是：每一段都不超过 DASH_FRAMES，且"提前结束的那些段"结尾必须是撞墙。

       注意差 1 帧：撞墙那一帧球仍然是按冲刺速度移动的，但 `_onWallTouch` 在同一帧里
       就把 mode 改成了 normal（否则下一帧收尾分支会把速度还原成冲刺方向，又贴回墙上），
       所以按 mode 采样时，这一帧被算进"normal"，段末 d1 的下一帧 d1+1 才是撞墙帧。 */
    const tooLong = dFrames.filter(f => f > DASH_FRAMES);
    const shortSegs = dashSegs.filter(s => s.frames < DASH_FRAMES);
    const shortWithoutWall = shortSegs.filter(s => !wallFrames.has(s.d1 + 1));
    console.log(`  每段冲刺帧数 ${[...new Set(dFrames)].join(',')}` +
      `（上限 ${DASH_FRAMES} = ${P.dash.dashTime}s）  ${tooLong.length === 0 ? '✅ 都不超上限' : '❌ 有超长段'}`);
    console.log(`  提前结束的冲刺 ${shortSegs.length} 段，其中结尾确实撞墙的 ` +
      `${shortSegs.length - shortWithoutWall.length} 段  ` +
      `${shortWithoutWall.length === 0 ? '✅ 都是撞墙终止' : '❌ 有非撞墙中断'}`);
    if (shortWithoutWall.length) {
      console.log(`    非撞墙中断的段：${shortWithoutWall.map(s => `帧${s.d0}-${s.d1}(${s.frames}帧)`).join('、')}`);
    }
    const allMoved = dashSegs.every(s => s.moved === s.frames);
    console.log(`  冲刺期间是否全程位移  ${allMoved ? '✅ 是' : '❌ 出现静止帧'}`);
    /* 最关键的一条：撞墙那几帧不能"原地不动"。以前正是这里出现
       "速度 162 但位移恰好为 0"的贴墙抽搐，现在必须彻底消失。 */
    const pinned = dashSegs.reduce((a, s) => a + (s.frames - s.moved), 0);
    console.log(`  冲刺中被钉住（位置没变）的帧数 ${pinned}（期望 0）  ${pinned === 0 ? '✅ 没有贴墙抽搐' : '❌'}`);
  }

  // 检查蓄力时长与冲刺时长
  const chargeStarts = [];
  const dashStarts = [];
  const dashEnds = [];
  for (const e of b.events) {
    if (e.type === 'chargeStart') chargeStarts.push(e.f);
    if (e.type === 'dashStart') dashStarts.push(e.f);
    if (e.type === 'dashEnd') dashEnds.push(e.f);
  }
  console.log(`\n  蓄力 ${chargeStarts.length} 次，冲刺 ${dashStarts.length} 次`);
  if (chargeStarts.length && dashStarts.length) {
    // 配对：每次蓄力后第一次冲刺
    const pairs = [];
    for (const c of chargeStarts) {
      const d = dashStarts.find(x => x >= c);
      if (d) pairs.push((d - c) / 60);
    }
    if (pairs.length) {
      const avg = pairs.reduce((a, c) => a + c, 0) / pairs.length;
      /* 事件帧相减仅供参考：chargeStart 打在撞墙那一帧，dashStart 打在冲刺第一帧，
         两者之间比"静止蓄力帧数"多 1 帧（撞墙帧本身球还在墙上）。 */
      console.log(`  [参考] chargeStart→dashStart 平均 ${avg.toFixed(4)}s（= 蓄力帧数 + 1 帧，属正常）`);
    }
  }
  if (dashEnds.length && dashStarts.length) {
    const pairs = [];
    for (const s of dashStarts) {
      const e = dashEnds.find(x => x >= s);
      if (e) pairs.push(e - s);   // dashEnd 打在冲刺结束后的那一帧 → 差值为完整帧数
    }
    if (pairs.length) {
      /* 撞墙会提前终止冲刺，所以这里只要求"不超过上限"，
         且每一段都必须由撞墙或自然到期收尾（前者上面已经核对过）。 */
      const tooLong = pairs.filter(p => p > DASH_FRAMES);
      console.log(`  [参考] dashStart→dashEnd 相隔 ${[...new Set(pairs)].join(',')} 帧` +
        `（上限 ${DASH_FRAMES}）  ${tooLong.length === 0 ? '✅ 均未超上限' : '❌ 有超长段'}`);
    }
  }
  const dashes = b.events.filter(e => e.type === 'hit' && e.kind === 'dash');
  console.log(`  冲刺命中 ${dashes.length} 次，伤害 ${dashes.length ? [...new Set(dashes.map(d => d.value))].join(',') : '-'}（期望 ${P.dash.damage}）`);
  const knocks = b.events.filter(e => e.type === 'knock');
  console.log(`  击退事件 ${knocks.length} 次（期望与冲刺命中次数一致）`);
  console.log(`  对局 ${(b.frame / 60).toFixed(1)}s 结束：${b.endReason}`);
}

console.log('\n=== ③ 冲刺期间速度是否线性衰减 ===');
{
  const b = mk(['test_skill'], ['test'], 'rect', 12345);
  const samples = [];
  let prev = 'normal';
  while (!b.over && b.frame < b.maxFrames && samples.length < 3) {
    b.step();
    const u = b.units[0];
    if (u.mode === 'dashing') {
      if (prev !== 'dashing') samples.push([]);
      samples[samples.length - 1].push({
        t: (DASH_FRAMES - u.dashFrames) / 60,   // 整数帧计时 → 秒，仅供观察
        spd: Math.hypot(u.vx, u.vy) / SCALE
      });
    }
    prev = u.mode;
  }
  for (const s of samples.slice(0, 2)) {
    if (s.length < 10) continue;
    const first = s[0], mid = s[Math.floor(s.length / 2)], last = s[s.length - 1];
    console.log(`  冲刺初期 ${first.spd.toFixed(0)} → 中期 ${mid.spd.toFixed(0)} → 末期 ${last.spd.toFixed(0)}` +
      `（常速 ${b.units[0].speed / SCALE}）  ${first.spd > mid.spd && mid.spd > last.spd ? '✅ 递减' : '❌'}`);
  }
}

console.log('\n=== ④ 确定性：加入技能后仍可复现 ===');
{
  const fps = [0, 1, 2].map(() => {
    const b = mk(['test_skill', 'test'], ['test', 'test_skill'], 'octagon', 20260930);
    b.runToEnd();
    return b.fingerprint();
  });
  console.log(`  三次指纹: ${fps.join(' / ')}  ${fps.every(f => f === fps[0]) ? '✅ PASS' : '❌ FAIL'}`);
}

console.log('\n=== ⑤ 性能：技能小球不影响模拟速度 ===');
{
  const t0 = process.hrtime.bigint();
  const b = mk(Array(6).fill('test_skill'), Array(6).fill('test'), 'octagon', 7);
  b.runToEnd();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  6v6（含技能与弹道）${b.frame} 帧 / ${(b.frame / 60).toFixed(1)}s，耗时 ${ms.toFixed(0)}ms`);
}

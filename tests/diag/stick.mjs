/* Diagnostic: (a) do balls stay overlapped / stick together?
                (b) are there touches that deal no damage?
   (ASCII only.) */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

function run(arenaId, sizeScale, seed, teams = [['test'], ['test']]) {
  return new Battle({
    teams: teams.map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
    arena: ARENA_BY_ID[arenaId],
    sizeScale,
    rules: { ...DEFAULT_RULES },
    seed
  });
}

console.log('=== (a) overlap: how long do balls stay inside each other? ===');
for (const [arenaId, sizeScale] of [['rect', 0.5], ['octagon', 0.5], ['circle', 0.5], ['rect', 1.0]]) {
  const b = run(arenaId, sizeScale, 31);
  let overlapFrames = 0, totalFrames = 0, maxOverlap = 0, deepFrames = 0;
  const overlaps = [];
  while (!b.over && b.frame < b.maxFrames) {
    b.step();
    totalFrames++;
    const alive = b.units.filter(u => u.alive);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const A = alive[i], B = alive[j];
        const d = Math.hypot(A.x - B.x, A.y - B.y);
        const rr = A.r + B.r;
        if (d < rr) {
          const ov = (rr - d) / SCALE;
          overlapFrames++;
          if (ov > maxOverlap) maxOverlap = ov;
          if (ov > 3) deepFrames++;
          overlaps.push(ov);
        }
      }
    }
  }
  const avg = overlaps.length ? overlaps.reduce((s, v) => s + v, 0) / overlaps.length : 0;
  console.log(`${arenaId.padEnd(9)} ${String(Math.round(sizeScale * 100)).padStart(3)}%  ` +
    `frames=${String(totalFrames).padStart(5)}  overlappedFrames=${String(overlapFrames).padStart(4)} ` +
    `(${(overlapFrames / totalFrames * 100).toFixed(1)}%)  avgOverlap=${avg.toFixed(2)}  maxOverlap=${maxOverlap.toFixed(2)}  deep(>3)=${deepFrames}`);
}

console.log('\n=== (b) touches without damage ===');
for (const [arenaId, sizeScale] of [['rect', 0.5], ['octagon', 0.5]]) {
  const b = run(arenaId, sizeScale, 31);
  /* 逐帧记录：距离进入"接触判定范围"(2r+6=38) 时，是否产生了伤害。
     判定用瞬时距离，不做连续帧去重，直接看"接触帧 vs 伤害帧"的对应关系。 */
  let contactFrames = 0, dmgFrames = 0, contactsWithoutDmg = 0;
  const CONTACT = 32 + 6;
  while (!b.over && b.frame < b.maxFrames) {
    const evStart = b.events.length;
    b.step();
    const alive = b.units.filter(u => u.alive);
    let touching = false;
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const A = alive[i], B = alive[j];
        if (A.team === B.team && !b.rules.friendlyFire) continue;
        const d = Math.hypot(A.x - B.x, A.y - B.y) / SCALE;
        if (d <= CONTACT) touching = true;
      }
    }
    const didHit = b.events.slice(evStart).some(e => e.type === 'hit');
    if (touching) contactFrames++;
    if (didHit) dmgFrames++;
    if (touching && !didHit) contactsWithoutDmg++;
  }
  console.log(`${arenaId} ${Math.round(sizeScale * 100)}%: contactFrames=${contactFrames}  ` +
    `damageFrames=${dmgFrames}  framesWithContactButNoDamage=${contactsWithoutDmg}`);
  console.log(`   (pair cooldown is 0.5s = 30 frames, so most contact frames SHOULD be damage-free)`);
}

console.log('\n=== (c) balls that end up exactly touching (distance == r1+r2) forever? ===');
{
  const b = run('rect', 0.5, 31);
  let stuckFrames = 0, worst = 0;
  while (!b.over && b.frame < b.maxFrames) {
    b.step();
    const alive = b.units.filter(u => u.alive);
    let stuckNow = false;
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const A = alive[i], B = alive[j];
        const d = Math.hypot(A.x - B.x, A.y - B.y);
        const rr = A.r + B.r;
        // 几乎正好相切：既没穿透也没分开
        if (Math.abs(d - rr) < 0.5 * SCALE) stuckNow = true;
      }
    }
    if (stuckNow) { stuckFrames++; worst = Math.max(worst, stuckFrames); }
    else stuckFrames = 0;
  }
  console.log(`  longest run of frames spent exactly tangent: ${worst} frames (${(worst / 60).toFixed(1)}s)`);
}

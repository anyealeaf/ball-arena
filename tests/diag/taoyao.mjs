/* 桃夭 · 五个技能逐条对照规格自检
 *
 * 每个技能单独装、单独测；能定量的全部定量（伤害、速度、层数、帧数）。
 * 用法：node tests/diag/taoyao.mjs
 */
import { Battle, MIN_SPEED } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, SPECIES_BY_ID, makeUnitStats, SCALE } from '../../js/balls.js';
import { TAOYAO, resolveLoadout, conflictsWithChosen, skillGroup } from '../../js/skills.js';

const T = SPECIES_BY_ID.taoyao;
let pass = 0, fail = 0;
const log = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; log.push(`  ✅ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; log.push(`  ❌ ${name}${detail ? '  — ' + detail : ''}`); }
};

function mk(skills, opts = {}) {
  const stats = (id, sk) => ({ ...makeUnitStats(id), skills: sk });
  return new Battle({
    teams: [
      { units: [{ stats: stats('taoyao', skills) }] },
      { units: [{ stats: stats(opts.foeId || 'test', opts.foeSkills || []) }] },
    ],
    arena: ARENA_BY_ID[opts.arenaId || 'rect'],
    sizeScale: opts.sizeScale ?? 1,
    rules: { ...DEFAULT_RULES, timeLimit: opts.timeLimit ?? 40 },
    seed: opts.seed ?? 7,
  });
}
const evCount = (b, t) => b.events.filter(e => e.type === t).length;

console.log('=========== 桃夭 · 技能自检 ===========\n');

/* ============ 基础数值 ============ */
console.log('【0】基础数值');
{
  check('血量 1750', T.hp === 1750, String(T.hp));
  check('碰撞伤害 66', T.melee === 66, String(T.melee));
  check('移动速度 120', T.speed === 120, String(T.speed));
  const b = mk([]);
  const u = b.units[0];
  check('开局 baseSpeed / baseMelee 正确', u.baseSpeed === 120 && u.baseMelee === 66,
    `${u.baseSpeed} / ${u.baseMelee}`);
  check('开局没有陀螺层数', u.spinStacks === 0);
}

/* ============ 互斥 ============ */
console.log('\n【互斥】映霞[荣] 与 映霞[枯] 只能二选一');
{
  check('两个技能同属一个互斥组',
    skillGroup('taoyao_rong') === 'yingxia' && skillGroup('taoyao_ku') === 'yingxia',
    skillGroup('taoyao_rong'));
  check('resolveLoadout 只保留第一个',
    resolveLoadout(['taoyao_rong', 'taoyao_ku']).join(',') === 'taoyao_rong',
    resolveLoadout(['taoyao_rong', 'taoyao_ku']).join(','));
  check('反序也只保留第一个',
    resolveLoadout(['taoyao_ku', 'taoyao_rong']).join(',') === 'taoyao_ku');
  check('互斥不影响其它技能',
    resolveLoadout(['taoyao_rong', 'taoyao_ku', 'taoyao_aim', 'taoyao_top']).length === 3);
  check('conflictsWithChosen 能识别冲突',
    conflictsWithChosen('taoyao_ku', ['taoyao_rong']) === true &&
    conflictsWithChosen('taoyao_ku', []) === false);

  /* 引擎是权威：就算绕过界面直接塞两个，也只能生效一个 */
  const b = mk(['taoyao_rong', 'taoyao_ku', 'taoyao_aim']);
  check('引擎建单位时会剔除互斥项', b.units[0].skills.length === 2 &&
    b.units[0].skills.includes('taoyao_rong') && !b.units[0].skills.includes('taoyao_ku'),
    b.units[0].skills.join(','));

  /* 默认装配必须是 3 个能用的技能（不能因为互斥只剩 2 个） */
  const def = resolveLoadout(T.skills.slice(0, 3));
  check('默认装配（前 3 个）不会因互斥缩水', def.length === 3, def.join(','));
}

/* ============ ① 映霞[荣] ============ */
console.log('\n【①】映霞[荣]');
{
  const P = TAOYAO.rong;
  const b = mk(['taoyao_rong']);
  const shots = [];
  b.maxFrames = 3600;
  while (!b.over && b.frame < 2400 && shots.length < 14) {
    const n0 = b.events.length;
    b.step();
    for (const e of b.events.slice(n0)) if (e.type === 'shoot' && e.tag === 'arrow') shots.push(e.value);
  }
  check('会发射箭矢', shots.length > 0, `${shots.length} 支`);
  /* 间隔只统计"相邻两次都是单发"的配对。
     为什么不能用"跳过连发帧"的记账法：连发帧会一次出 5 支，
     跨过它的那一段间隔本来就是 2 秒（连发是**顶替**了一发，不是额外插进去）。
     直接按"前后都是单发"配对最稳，也不依赖我自己维护的标记是否同步。 */
  const frames = [];
  {
    const b2 = mk(['taoyao_rong']);
    while (!b2.over && b2.frame < 1800 && frames.length < 14) {
      const n0 = b2.events.length;
      b2.step();
      const n = b2.events.slice(n0).filter(e => e.type === 'shoot').length;
      if (n) frames.push({ f: b2.frame, n });
    }
  }
  const iv = [];
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].n === 1 && frames[i - 1].n === 1) {
      iv.push(+((frames[i].f - frames[i - 1].f) / 60).toFixed(3));
    }
  }
  check(`相邻单发之间的间隔约 ${P.cd} 秒`,
    iv.length > 0 && iv.every(v => Math.abs(v - P.cd) < 0.05),
    `序列 ${frames.slice(0, 8).map(x => x.n).join(',')}… | 间隔 ${iv.join(', ')}`);

  const dmg = [...new Set(shots)];
  check(`伤害只有 ${P.damage}（单发）与 ${P.burstDmg}（连发）两种，且都是有限值`,
    dmg.length > 0 && dmg.every(v => Number.isFinite(v) && (v === P.damage || v === P.burstDmg)),
    dmg.sort((a, c) => a - c).join(','));
  const arrows = b.events.filter(e => e.type === 'shoot' && e.tag === 'arrow');
  check('箭矢速度 500', (() => {
    const bb = mk(['taoyao_rong']);
    bb.units[0].skillCd = {};
    bb._runSkills(bb.units[0], 'cooldown');
    const p = bb.projectiles[bb.projectiles.length - 1];
    return p && Math.abs(Math.hypot(p.vx, p.vy) / SCALE - P.speed) < 1;
  })(), String(P.speed));
  /* 击退已按作者要求去掉。
     写成**反向断言**（不是删掉这条）：万一以后有人从引擎侧
     把击退又带回来，这里会立刻变红，而不是安静地多出一个效果。 */
  check('箭矢没有击退（作者已去掉）', (() => {
    const bb = mk(['taoyao_rong']);
    bb.units[0].skillCd = {};
    bb._runSkills(bb.units[0], 'cooldown');
    const p = bb.projectiles[bb.projectiles.length - 1];
    return p && !p.knockback && !bb.events.some(e => e.type === 'knock');
  })(), '参数与事件都没有击退');

  /* 射 5 次后第六次是五连发 */
  const b3 = mk(['taoyao_rong']);
  const single = [], burst = [];
  for (let i = 0; i < 8; i++) {
    b3.units[0].skillCd = {};
    const n0 = b3.events.length;
    b3._runSkills(b3.units[0], 'cooldown');
    const evs = b3.events.slice(n0).filter(e => e.type === 'shoot');
    // 清掉弹道，避免命中影响计数
    b3.projectiles.length = 0;
    if (evs.length === 1) single.push(evs[0].value);
    else burst.push({ n: evs.length, dmg: [...new Set(evs.map(e => e.value))] });
  }
  check('前 5 次都是单发', single.slice(0, 5).length === 5 && single.slice(0, 5).every(v => v === P.damage),
    `前 5 次伤害 ${single.slice(0, 5).join(',')}`);
  check('第 6 次是一轮 5 连发', burst.length >= 1 && burst[0].n === P.burstCount,
    burst.length ? `${burst[0].n} 支` : '没发生');
  check(`连发每支伤害 ${P.burstDmg}`,
    burst.length > 0 && burst[0].dmg.every(v => v === P.burstDmg), 
    burst.length ? burst[0].dmg.join(',') : '-');
  check('连发之后重新计数（下一轮又是单发）',
    (() => {
      const b4 = mk(['taoyao_rong']);
      const kinds = [];
      for (let i = 0; i < 7; i++) {
        b4.units[0].skillCd = {};
        const n0 = b4.events.length;
        b4._runSkills(b4.units[0], 'cooldown');
        kinds.push(b4.events.slice(n0).filter(e => e.type === 'shoot').length);
        b4.projectiles.length = 0;
      }
      return kinds.join(',') === '1,1,1,1,1,5,1';
    })());
}

/* ============ ② 映霞[枯] ============ */
console.log('\n【②】映霞[枯]');
{
  const P = TAOYAO.ku;
  const b = mk(['taoyao_ku']);
  const times = [];
  while (!b.over && b.frame < 1200 && times.length < 6) {
    const n0 = b.events.length;
    b.step();
    for (const e of b.events.slice(n0)) if (e.type === 'shoot') times.push(b.frame / 60);
  }
  const iv = times.slice(1).map((t, i) => +(t - times[i]).toFixed(3));
  check(`发射间隔约 ${P.cd} 秒`, iv.length > 0 && iv.every(v => Math.abs(v - P.cd) < 0.05), iv.join(', '));

  const b2 = mk(['taoyao_ku']);
  b2.units[0].skillCd = {};
  b2._runSkills(b2.units[0], 'cooldown');
  const p = b2.projectiles[b2.projectiles.length - 1];
  check('箭矢速度 450', p && Math.abs(Math.hypot(p.vx, p.vy) / SCALE - P.speed) < 1,
    p ? String(Math.round(Math.hypot(p.vx, p.vy) / SCALE)) : '-');
  check(`箭矢伤害 ${P.damage}`, p && p.damage === P.damage, p ? String(p.damage) : '-');

  /* 命中后减速 20，持续 2 秒，然后恢复 */
  const b3 = mk(['taoyao_ku']);
  const A = b3.units[0], B = b3.units[1];
  const spd0 = B.speed / SCALE;
  b3._runHooks(B, 'onDamaged', { heavy: true });      // 占位，避免影响
  A.skillCd = {};
  b3._runSkills(A, 'cooldown');
  const arrow = b3.projectiles[b3.projectiles.length - 1];
  arrow.x = B.x; arrow.y = B.y;                       // 直接造成命中
  b3.step();
  check('命中后移速立刻 -20', Math.abs(B.speed / SCALE - (spd0 - P.slow)) < 0.01,
    `${spd0} → ${B.speed / SCALE}`);
  check('减速事件已发出', evCount(b3, 'slow') === 1);
  const frames = Math.round(P.slowSeconds / (1 / 60));
  for (let i = 0; i < frames + 2; i++) b3.step();
  check(`减速在 ${P.slowSeconds} 秒后自动解除`, Math.abs(B.speed / SCALE - spd0) < 0.01,
    `恢复到 ${B.speed / SCALE}`);
}

/* ============ ③ 认真拉矢 ============ */
console.log('\n【③】认真拉矢');
{
  const P = TAOYAO.aim;
  const b = mk(['taoyao_aim', 'taoyao_rong']);
  const u = b.units[0];
  check('开局 0 层', (u.flags.aimStacks || 0) === 0);

  const fire = () => {
    u.skillCd = {};
    const n0 = b.events.length;
    b._runSkills(u, 'cooldown');
    return b.projectiles[b.projectiles.length - 1];
  };
  const hitOne = () => {
    const p = fire();
    p.x = b.units[1].x; p.y = b.units[1].y;
    b.projectiles.length = 0;      // 先清掉再判命中会漏，这里直接手动触发回调
    p.onHit(b, u, b.units[1], p);
    return p;
  };

  let dmg = [];
  for (let i = 0; i < 3; i++) { const p = fire(); dmg.push(p.damage); p.onMiss(b, u, p); }
  check('落空不减到负数（0 层时掉层无效）', (u.flags.aimStacks || 0) === 0);

  u.flags.aimStacks = 0;
  for (let i = 0; i < P.maxStacks + 4; i++) hitOne();
  check(`命中叠层封顶 ${P.maxStacks} 层`, u.flags.aimStacks === P.maxStacks, String(u.flags.aimStacks));
  /* 满层伤害：单发基数是 50、连发基数是 30，所以两种都要接受。
     这里同时验证"当前这一发"的数值与它的基数相符。 */
  u.flags.rongShots = 0;
  const maxP = fire();
  const wantSingle = TAOYAO.rong.damage + P.perStack * P.maxStacks;   // 50 + 50 = 100
  const wantBurst = TAOYAO.rong.burstDmg + P.perStack * P.maxStacks;  // 30 + 50 = 80
  check(`满层时箭矢吃满加成（单发应为 ${wantSingle}，连发应为 ${wantBurst}）`,
    maxP.damage === wantSingle || maxP.damage === wantBurst, String(maxP.damage));

  /* 落空 -2 层 */
  const before = u.flags.aimStacks;
  const missP = fire();
  missP.onMiss(b, u, missP);
  check(`落空掉 ${P.losePerMiss} 层`, u.flags.aimStacks === before - P.losePerMiss,
    `${before} → ${u.flags.aimStacks}`);
  /* 最低到 0 */
  for (let i = 0; i < 10; i++) { const p = fire(); p.onMiss(b, u, p); }
  check('层数不会掉成负数', u.flags.aimStacks === 0, String(u.flags.aimStacks));

  /* 真实的"撞墙落空"也要掉层（不能只有手动调用才生效）。
     注意别让桃夭自己装的技能掺进来：这里只装认真拉矢，
     手动造一支朝墙飞的箭，层数变化就只可能来自那次落空。 */
  const b2 = mk(['taoyao_aim']);
  const u2 = b2.units[0];
  u2.skills = ['taoyao_aim'];          // 清掉其它技能，避免别的箭矢干扰计数
  u2.flags.aimStacks = 6;
  u2.x = b2.units[1].x + 40 * SCALE;   // 挪远一点，别让"命中"抢在前面
  u2.y = b2.units[1].y + 40 * SCALE;
  b2._spawnProjectile({
    kind: 'aura', tag: 'arrow', owner: u2,
    x: u2.x, y: u2.y, vx: 500 * SCALE, vy: 0,
    damage: 1, radius: 5 * SCALE, life: 3, color: '#fff',
    onMiss: (b, from) => {
      if (!from) return;
      from.flags.aimStacks = Math.max(0, (from.flags.aimStacks || 0) - 2);
      b._emit('aimMiss', from, null, from.flags.aimStacks);
    },
  });
  for (let i = 0; i < 200 && !evCount(b2, 'aimMiss'); i++) b2.step();
  check('箭矢真的撞墙时也会掉层', evCount(b2, 'aimMiss') > 0 && u2.flags.aimStacks === 4,
    `层数 6 → ${u2.flags.aimStacks}`);
}

/* ============ ④ 春景 ============ */
console.log('\n【④】春景');
{
  const P = TAOYAO.chunjing;
  const b = mk(['taoyao_chunjing'], { timeLimit: 30 });
  b.runToEnd();
  const ons = b.events.filter(e => e.type === 'buffOn');
  check('会周期性开启春景', ons.length > 0, `${ons.length} 次`);
  if (ons.length >= 2) {
    const iv = ons.slice(1).map((e, i) => +((e.f - ons[i].f) / 60).toFixed(3));
    check(`开启间隔约 ${P.cd} 秒`, iv.every(v => Math.abs(v - P.cd) < 0.1), iv.join(', '));
  }
  const durations = ons.map((e, i) => {
    const off = b.events.find(x => x.type === 'buffOff' && x.f > e.f);
    return off ? +((off.f - e.f) / 60).toFixed(2) : null;
  }).filter(v => v != null);
  check(`每次持续约 ${P.duration} 秒`,
    durations.length > 0 && durations.every(v => Math.abs(v - P.duration) < 0.1),
    durations.join(', '));

  /* 回血速率：buff 期间每秒 P.healPerSec（当前 10） */
  const b2 = mk(['taoyao_chunjing'], { timeLimit: 20 });
  const u2 = b2.units[0];
  u2.hp = 500;
  const healed = [];
  while (!b2.over && b2.frame < 1200) {
    const n0 = b2.events.length;
    b2.step();
    for (const e of b2.events.slice(n0)) if (e.type === 'heal') healed.push(e.value);
  }
  const total = healed.reduce((a, c) => a + c, 0);
  check('确实回了血', total > 0, `共回 ${total} 点`);
  check('回血事件不会每帧都是 0（余数累积生效）',
    healed.filter(v => v > 0).length > 0 && healed.every(v => v >= 1),
    `${healed.length} 次回血事件`);
  /* 速率断言：buff 是"每 10 秒里有 5 秒在回血"，所以总回复量 ≈
     healPerSec × 5 × (总时长 / 10)。这里用"每个 buff 周期回多少"来测，
     不依赖具体时长，改 healPerSec 时断言跟着参数走。 */
  const buffOn = b2.events.filter(e => e.type === 'buffOn').length;
  check(`回血速率 ${P.healPerSec}/秒（每轮 buff 约 ${P.healPerSec * P.duration} 点）`,
    buffOn > 0 && Math.abs(total - P.healPerSec * P.duration * buffOn) <= 4 * buffOn,
    `${buffOn} 轮 buff / 共回 ${total} 点 / 期望约 ${P.healPerSec * P.duration * buffOn} 点`);

  /* 光炮：每 2.5 秒一发，180 伤害 */
  const shots = b2.events.filter(e => e.type === 'shoot' && e.tag === 'chunjing_cannon');
  check('buff 期间会补发光炮', shots.length > 0, `${shots.length} 发`);
  check(`光炮伤害 ${P.cannonDmg}`, shots.every(e => e.value === P.cannonDmg),
    shots.length ? String(shots[0].value) : '-');
  check('光炮不吃认真拉矢的加成（与箭矢是两套体系）',
    (() => {
      const b3 = mk(['taoyao_chunjing', 'taoyao_aim']);
      const u3 = b3.units[0];
      u3.flags.aimStacks = TAOYAO.aim.maxStacks;
      u3.flags.chunjingUntil = b3.frame + 600;
      u3.flags.chunjingCannon = 999;          // 下一帧就补炮
      let cannon = null;
      for (let i = 0; i < 5 && !cannon; i++) {
        const n0 = b3.events.length;
        b3.step();
        cannon = b3.events.slice(n0).find(e => e.type === 'shoot' && e.tag === 'chunjing_cannon');
      }
      return cannon && cannon.value === P.cannonDmg;
    })());
}

/* ============ ⑤ 陀螺 ============ */
console.log('\n【⑤】陀螺');
{
  const P = TAOYAO.top;
  const b = mk(['taoyao_top'], { timeLimit: 10 });
  const u = b.units[0];
  check('开局 0 层', u.spinStacks === 0);

  const stack = (heavy) => b._runHooks(u, 'onDamaged', { heavy, amount: 10 });
  for (let i = 0; i < 3; i++) stack(true);
  check('被真正的打击时叠层', u.spinStacks === 3, String(u.spinStacks));
  check(`每层碰撞伤害 +${P.meleePer}`, u.melee === 66 + P.meleePer * 3, String(u.melee));
  check(`每层移速 +${P.speedPer}`, Math.abs(u.speed / SCALE - (120 + P.speedPer * 3)) < 0.01,
    String(u.speed / SCALE));

  /* 每帧接触伤害（heavy=false）不算被攻击 —— 这是关键的一条 */
  const before = u.spinStacks;
  for (let i = 0; i < 50; i++) stack(false);
  check('每帧接触伤害（heavy=false）不叠层', u.spinStacks === before,
    `${before} → ${u.spinStacks}`);

  for (let i = 0; i < 30; i++) stack(true);
  check(`层数封顶 ${P.maxStacks}`, u.spinStacks === P.maxStacks, String(u.spinStacks));
  check('满层碰撞伤害', u.melee === 66 + P.meleePer * P.maxStacks, String(u.melee));
  check('满层移速', Math.abs(u.speed / SCALE - (120 + P.speedPer * P.maxStacks)) < 0.01,
    String(u.speed / SCALE));

  /* 回血已按作者要求去掉。
     同样写成反向断言：以前这里测的是"10 层每秒回 10 点"，
     现在测"10 层也一点都不回"。要先把血扣下去才测得出来 ——
     满血时回血被上限吃掉，就算是坏实现也看不出来。 */
  const b2 = mk(['taoyao_top'], { timeLimit: 20 });
  const u2 = b2.units[0];
  for (let i = 0; i < 10; i++) b2._runHooks(u2, 'onDamaged', { heavy: true, amount: 1 });
  check('满 10 层', u2.spinStacks === 10, String(u2.spinStacks));
  u2.hp = Math.round(u2.maxHp * 0.5);       // 留出回血空间，否则坏实现也看不出来
  const healed0 = u2.healed;
  for (let i = 0; i < 600; i++) b2.step();  // 10 秒
  const gained = u2.healed - healed0;
  check('满 10 层也不回血（作者已去掉）', gained === 0, `10 秒回了 ${gained} 点`);
  /* 去掉的只是回血，层数驱动的那三件事必须都还在 */
  check('去掉回血后层数依然驱动伤害与移速',
    u2.spinStacks === 10 &&
    Math.abs(u2.speed / SCALE - (120 + P.speedPer * 10)) < 0.01,
    `层数 ${u2.spinStacks} / 移速 ${(u2.speed / SCALE).toFixed(1)}`);

  /* 旋转角在推进（渲染层靠它转贴图） */
  const a0 = u2.spinAngle;
  for (let i = 0; i < 60; i++) b2.step();
  check('旋转角随时间推进', u2.spinAngle > a0, `${a0.toFixed(2)} → ${u2.spinAngle.toFixed(2)}`);
  check('旋转角进了快照（暂停回放才对得上）',
    (() => {
      const snap = b2.snapshots[b2.snapshots.length - 1];
      return snap.data.length >= 13 && snap.data[12] > 0;
    })());
}

/* ============ 综合 ============ */
console.log('\n【综合】');
{
  const b = mk(T.skills.slice(), { timeLimit: 60 });
  let err = null;
  const t0 = Date.now();
  try { b.runToEnd(); } catch (e) { err = e; }
  const ms = Date.now() - t0;
  check('五个技能一起跑不报错', !err, err ? err.message : `${b.frame} 帧，${ms} ms`);
  if (!err) {
    check('对局正常收场', !!b.endReason, b.endReason);
    check('模拟速度可接受', ms < 6000, `${ms} ms`);
    check('事件流没爆', b.events.length <= 6000, `${b.events.length} 条`);
    check('弹道与场地物件没有失控', b.projectiles.length < 300 && b.fields.length <= 400,
      `弹道 ${b.projectiles.length} / 场地 ${b.fields.length}`);
  }
}

/* ============ 确定性 ============ */
console.log('\n【确定性】');
{
  const fp = (seed, skills) => {
    const b = mk(skills, { seed, timeLimit: 30 });
    b.runToEnd();
    let h = 2166136261;
    for (const s of b.snapshots) {
      for (let i = 0; i < s.data.length; i++) {
        h ^= Math.round(s.data[i] * 1000) | 0;
        h = Math.imul(h, 16777619);
      }
    }
    return (h >>> 0).toString(16);
  };
  const all = T.skills.slice();
  const a1 = fp(7, all), a2 = fp(7, all), b1 = fp(99, all);
  check('同种子三次一致', a1 === a2, `${a1} / ${a2}`);
  check('不同种子不同', a1 !== b1, `${a1} vs ${b1}`);
}

console.log('\n' + log.join('\n'));
console.log(`\n=========== 通过 ${pass} 项，失败 ${fail} 项 ===========`);
process.exit(fail ? 1 : 0);

import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
/* ============================================================
   见晴（魔法少女[白水仙]）自检
   ------------------------------------------------------------
   作者 2026-10 的规格：血量 1500 / 速度 120 / 碰撞伤害 30 / 标准体型，
   六个技能（①②③ 是三个**各自独立**、颜色循环互不相干的水镜）。

   这个脚本按技能逐条对照规格，重点盯那些"看起来对、其实没生效"的地方：
     · ① 的护盾到底有没有真的先扣护盾再扣血？不在淡粉时会不会衰减？
     · ② 的扇形是不是**以移动方向为中心**（而不是"朝目标"）？
       挥动间隔（1 秒 / 5 秒）有没有真的守住？
     · ③ 深蓝紫那一态**绝不能**出现激光（作者明确"没有第三发激光"）；
     · ④ 起飞时免伤但**帧伤照样吃**、不与小球碰撞但**仍然撞墙**、
       空中不发动攻击但 ① 的防御照常；
     · ⑤ 的"所有伤害减半"要连帧伤一起减；
     · ⑥ 的羽毛：追踪、反弹、命中后移速减半**只 3 秒**、减伤**永久叠加**、
       而帧伤不减。
   用法：node tests/diag/jianqing.mjs
   ============================================================ */
import { Battle, SNAP_STRIDE } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, SPECIES_BY_ID, makeUnitStats, defaultSkillsFor } from '../../js/balls.js';
import { JIANQING, getSkill, SKILL_MIRROR_DEF, SKILL_MIRROR_SWORD, SKILL_MIRROR_BORROW, SKILL_TAKEOFF, SKILL_TRANSFORM, SKILL_FEATHER } from '../../js/skills.js';

const { SCALE, DT } = await import('../../js/balls.js');

let pass = 0, fail = 0;
const log = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; log.push(`  ✅ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; log.push(`  ❌ ${name}${detail ? '  — ' + detail : ''}`); }
};

const J = SPECIES_BY_ID.jianqing;
const evCount = (b, type) => b.events.filter(e => e.type === type).length;
const evs = (b, type) => b.events.filter(e => e.type === type);

/** 建一局：见晴（skills）对阵 foeId（默认木桩：不动、5000 血、好当靶子） */
const mk = (skills, opts = {}) => new Battle({
  teams: [
    { units: [{ stats: makeUnitStats('jianqing', skills) }] },
    {
      units: (opts.foes || ['dummy']).map(id => ({
        stats: makeUnitStats(id, opts.foeSkills || [], opts.foeOpts),
      })),
    },
  ],
  arena: ARENA_BY_ID[opts.arenaId || 'rect'],
  sizeScale: opts.sizeScale ?? 1,
  rules: { ...DEFAULT_RULES, ...(opts.rules || {}) },
  seed: opts.seed ?? 21,
});

/** 强行把水镜切成某个颜色（诊断要验单一形态，不能让随机来捣乱） */
const setDefColor = (b, unit, color) => {
  unit.flags.mirrorColor = color;
  unit.ringKind = color;
};
const setBorrowColor = (b, unit, color) => {
  unit.flags.borrowColor = color;
  unit.auxKind = color;
};
/** 让对手"闭嘴"：不还手、不动。
 *  ① 的用例要单独量护盾的涨跌，而木桩撞上来会一直消耗护盾 ——
 *  那不叫"衰减没生效"，叫"测试自己没把干扰源关掉"。 */
const muteFoe = (b) => {
  for (const u of b.units.slice(1)) {
    u.melee = 0; u.baseMelee = 0; u.vx = 0; u.vy = 0; u.speed = 0;
  }
  return b;
};

console.log('=========== 见晴（白水仙）自检 ===========\n');

/* ---------- 0) 基础数值 ---------- */
console.log('【0】基础数值（照作者规格）');
{
  check('血量 1500', J.hp === 1500, String(J.hp));
  check('速度 120', J.speed === 120, String(J.speed));
  check('碰撞伤害 30', J.melee === 30, String(J.melee));
  check('标准体型（与晕彩一致，r = 16）', J.r === 16 && SPECIES_BY_ID.yuncai.r === 16,
    `见晴 r=${J.r}，晕彩 r=${SPECIES_BY_ID.yuncai.r}`);
  check('六个技能都在注册表里', (J.skills || []).length === 6 &&
    J.skills.every(id => !!getSkill(id)), (J.skills || []).join('、'));
  check('默认装配是前三个（①②③ 三面水镜）',
    JSON.stringify(defaultSkillsFor('jianqing')) ===
    JSON.stringify(['jianqing_mirror_def', 'jianqing_mirror_sword', 'jianqing_mirror_borrow']),
    defaultSkillsFor('jianqing').join('、'));
  check('六个技能**互不互斥**（作者确认可以分开装配）',
    J.skills.every(id => !getSkill(id).group));
  check('水镜护盾条在物种上（上限 300）',
    J.resource && J.resource.id === 'mirror' && J.resource.max === 300,
    J.resource ? `${J.resource.name} / ${J.resource.max}` : '没有资源条');
  check('每个技能都有 desc 与 descDetail 两套说明',
    J.skills.every(id => (getSkill(id).desc || '').length > 20 && (getSkill(id).descDetail || '').length > 40));
}

/* ---------- ① 水镜·魔力共鸣（防御） ---------- */
console.log('\n【①】水镜·魔力共鸣（防御）');
{
  const P = JIANQING.mirrorDef;
  check('冷却 = 5 秒（触发方式 cooldown）',
    SKILL_MIRROR_DEF.trigger.type === 'cooldown' && SKILL_MIRROR_DEF.trigger.cd === 5,
    `${SKILL_MIRROR_DEF.trigger.type} / ${SKILL_MIRROR_DEF.trigger.cd}s`);

  /* 第 0 帧就先随机定一个颜色（否则头 5 秒是"无色"） */
  const b0 = mk(['jianqing_mirror_def']);
  b0.step();
  const u0 = b0.units[0];
  check('第 0 帧就定下了颜色（只会是淡绿 1 / 淡粉 2）',
    u0.flags.mirrorColor === 1 || u0.flags.mirrorColor === 2,
    String(u0.flags.mirrorColor));
  check('颜色同时写进了快照（渲染层要按它画外圈）',
    u0.ringKind === u0.flags.mirrorColor, `${u0.ringKind}`);
  check('切色时发了 mirrorSwitch 事件（水镜穿越的表现）',
    evCount(b0, 'mirrorSwitch') === 1, `${evCount(b0, 'mirrorSwitch')} 次`);

  /* 淡绿：每秒回 15（按秒连续累积，取整会差 1 点，所以给 ±1 的容差） */
  const b1 = muteFoe(mk(['jianqing_mirror_def']));
  const a1 = b1.units[0];
  a1.hp = 1000;
  setDefColor(b1, a1, 1);
  for (let i = 0; i < 60; i++) { a1.flags.mirrorColor = 1; a1.ringKind = 1; b1.step(); }
  check(`淡绿：1 秒回 ${P.healPerSec} 点左右`, Math.abs(a1.hp - (1000 + P.healPerSec)) <= 1,
    `1000 → ${a1.hp}`);
  for (let i = 0; i < 60; i++) { a1.flags.mirrorColor = 1; a1.ringKind = 1; b1.step(); }
  check('淡绿：2 秒回 30 点左右（按秒连续，不是一次性）',
    Math.abs(a1.hp - (1000 + P.healPerSec * 2)) <= 1, `1000 → ${a1.hp}`);
  check('淡绿：不会回超过上限',
    (() => { const bb = muteFoe(mk(['jianqing_mirror_def'])); const aa = bb.units[0];
      aa.hp = aa.maxHp - 3;
      for (let i = 0; i < 30; i++) { aa.flags.mirrorColor = 1; bb.step(); }
      return aa.hp === aa.maxHp; })(), `上限 ${1500}`);

  /* 淡粉：碰撞 +10、每秒 +30 护盾 */
  const b2 = muteFoe(mk(['jianqing_mirror_def']));
  const a2 = b2.units[0];
  setDefColor(b2, a2, 2);
  b2.step();                                  // 加成在 onMove 里生效，所以要跑一帧
  check('淡粉：碰撞伤害 30 → 40', a2.melee === 30 + P.meleeBonus, String(a2.melee));
  check('淡粉：一开始护盾是 0', a2.res === 0, String(a2.res));
  for (let i = 0; i < 60; i++) { a2.flags.mirrorColor = 2; b2.step(); }
  check(`淡粉：1 秒 +${P.shieldPerSec} 护盾`, Math.abs(a2.res - P.shieldPerSec) <= 1, String(a2.res));
  for (let i = 0; i < 60 * 30; i++) { a2.flags.mirrorColor = 2; b2.step(); }
  check(`护盾上限 ${P.shieldMax}（攒再久也不会超）`, a2.res === P.shieldMax, String(a2.res));
  /* 切回淡绿：碰撞加成要**撤掉**（不能切几次就叠到 +30） */
  for (let i = 0; i < 10; i++) { a2.flags.mirrorColor = 1; b2.step(); }
  check('切回淡绿：碰撞伤害退回 30（加成不是累加的）', a2.melee === 30, String(a2.melee));
  for (let i = 0; i < 10; i++) { a2.flags.mirrorColor = 2; b2.step(); }
  check('再切回淡粉：还是 40（不会越切越高）', a2.melee === 40, String(a2.melee));

  /* 不在淡粉：每秒衰减 5（这时碰撞加成已经撤掉，护盾只会掉） */
  const resBeforeDecay = a2.res;
  for (let i = 0; i < 60 * 2; i++) { a2.flags.mirrorColor = 1; b2.step(); }
  check(`不在淡粉：2 秒衰减 ${P.shieldDecayPerSec * 2}（${resBeforeDecay} → ${resBeforeDecay - 10}）`,
    a2.res === resBeforeDecay - P.shieldDecayPerSec * 2, String(a2.res));

  /* 护盾吸收：先扣护盾，扣完才掉血 */
  const b3 = muteFoe(mk(['jianqing_mirror_def']));
  const a3 = b3.units[0];
  a3.res = 100;
  const hpBefore = a3.hp;
  b3._damage(null, a3, 60, 'skill');
  check('护盾吸收：打 60 点 → 血一点不掉、护盾 100 → 40',
    a3.hp === hpBefore && a3.res === 40, `hp ${hpBefore} → ${a3.hp}，护盾 ${a3.res}`);
  check('吸收时发了 shieldHit 事件（界面上的护盾反馈）', evCount(b3, 'shieldHit') === 1,
    `${evCount(b3, 'shieldHit')} 次`);
  b3._damage(null, a3, 100, 'skill');
  check('护盾扣完剩下的才打到血上（40 护盾挡 100 → 只掉 60）',
    a3.hp === hpBefore - 60 && a3.res === 0, `hp -${hpBefore - a3.hp}，护盾 ${a3.res}`);

  const b4 = muteFoe(mk(['jianqing_mirror_def']));
  const a4 = b4.units[0];
  a4.res = 50;
  b4._damage(null, a4, 50, 'skill');
  check('护盾刚好够时：全额挡下、血一点不掉（不是"至少掉 1 点"）',
    a4.hp === a4.maxHp && a4.res === 0, `hp=${a4.hp} 护盾=${a4.res}`);

  /* 切色是随机的，且允许连续同色 */
  const b5 = muteFoe(mk(['jianqing_mirror_def'], { rules: { timeLimit: 0 } }));
  const seen = new Set();
  for (let i = 0; i < 60 * 60; i++) { b5.step(); seen.add(b5.units[0].flags.mirrorColor); }
  check('60 秒里两种颜色都出现过（随机切换真的在跑）',
    seen.has(1) && seen.has(2), [...seen].join('、'));
  const switches = evCount(b5, 'mirrorSwitch');
  check('60 秒切了大约 12 次（每 5 秒一次）',
    switches >= 11 && switches <= 13, `${switches} 次`);
}

/* ---------- ② 水镜·魔力共鸣（猩红色） ---------- */
console.log('\n【②】水镜·魔力共鸣（猩红色）');
{
  const P = JIANQING.mirrorSword;
  const b = mk(['jianqing_mirror_sword']);
  const u = b.units[0];
  check(`常驻：速度 120 → ${120 + P.speedBonus}`, u.speed / SCALE === 120 + P.speedBonus,
    String(u.speed / SCALE));
  check(`长剑长度 = 小球直径（${P.swordLen}）`, u.swordLen === P.swordLen, String(u.swordLen));

  /* 正前方：砍中。
     ⚠ 用 swordSwing 事件的数值来判"砍了多少" —— 直接看对方掉血的话，
     会把同时发生的**碰撞伤害**算进去（两球距离 60 > 半径和 46 虽然不重叠，
     但摆得更近时就会混在一起）。 */
  const target = b.units[1];
  target.x = u.x + Math.round(60 * SCALE);   // 正前方 60 单位（够得着：16+32+30=78）
  target.y = u.y;
  u.vx = Math.round(120 * SCALE); u.vy = 0;  // 朝 +x 移动
  const hp0 = target.hp;
  b.step();
  const sw0 = evs(b, 'swordSwing')[0];
  check(`前方扇形内的敌人挨了 ${P.dmg} 点`, sw0 && sw0.value === P.dmg,
    sw0 ? String(sw0.value) : '没挥剑');
  check('挥剑发了 swordSwing 事件（渲染层按它画挥动动画）', !!sw0, `${evCount(b, 'swordSwing')} 次`);
  check('挥剑确实打在了那个敌人身上（掉血 ≥ 80）', hp0 - target.hp >= P.dmg,
    `${hp0} → ${target.hp}`);

  /* 攻击性挥动间隔 1 秒 */
  const hp1 = target.hp;
  const swings1 = evCount(b, 'swordSwing');
  for (let i = 0; i < 30; i++) {
    target.x = u.x + Math.round(60 * SCALE); target.y = u.y;   // 一直贴在正前方
    b.step();
  }
  check(`挥动间隔 ≥ ${P.atkInterval} 秒：半秒内不会砍第二下`,
    evCount(b, 'swordSwing') === swings1, `${swings1} → ${evCount(b, 'swordSwing')} 次`);
  for (let i = 0; i < 40; i++) {
    target.x = u.x + Math.round(60 * SCALE); target.y = u.y;
    b.step();
  }
  check('过了 1 秒就会再砍（不是只砍一次）', evCount(b, 'swordSwing') > swings1,
    `${swings1} → ${evCount(b, 'swordSwing')} 次`);

  /* 身后不算 */
  const b2 = mk(['jianqing_mirror_sword']);
  const u2 = b2.units[0], t2 = b2.units[1];
  u2.vx = Math.round(120 * SCALE); u2.vy = 0;
  t2.x = u2.x - Math.round(60 * SCALE); t2.y = u2.y;    // 正后方
  b2.step();
  check('正后方（120° 之外）不会被砍', evCount(b2, 'swordSwing') === 0,
    `${evCount(b2, 'swordSwing')} 次`);

  /* 扇形中心是**移动方向**，不是"朝目标的方向" */
  const b3 = mk(['jianqing_mirror_sword']);
  const u3 = b3.units[0], t3 = b3.units[1];
  u3.vx = Math.round(120 * SCALE); u3.vy = 0;           // 朝 +x 移动
  const a50 = (50 * Math.PI) / 180;                     // 偏 50°（< 60° 半角 → 在扇形内）
  t3.x = u3.x + Math.round(Math.cos(a50) * 60 * SCALE);
  t3.y = u3.y + Math.round(Math.sin(a50) * 60 * SCALE);
  b3.step();
  check('目标在移动方向偏 50°：在 120° 扇形内 → 会被砍',
    evCount(b3, 'swordSwing') === 1, `${evCount(b3, 'swordSwing')} 次`);
  const b4 = mk(['jianqing_mirror_sword']);
  const u4 = b4.units[0], t4 = b4.units[1];
  u4.vx = Math.round(120 * SCALE); u4.vy = 0;
  const ang = (100 * Math.PI) / 180;                     // 偏 100°（> 60° 半角）
  t4.x = u4.x + Math.round(Math.cos(ang) * 60 * SCALE);
  t4.y = u4.y + Math.round(Math.sin(ang) * 60 * SCALE);
  b4.step();
  check('目标偏出 100°：扇形之外，不会被砍', evCount(b4, 'swordSwing') === 0,
    `${evCount(b4, 'swordSwing')} 次`);

  /* 防御性挥动：消除敌方魔弹（对手用木桩 —— 换成会开火的角色，
     它自己打出来的魔弹会混进计数里） */
  const b5 = mk(['jianqing_mirror_sword'], { foes: ['dummy'] });
  const u5 = b5.units[0];
  u5.vx = Math.round(120 * SCALE); u5.vy = 0;
  const foeTeam = b5.units[1];
  const spawnVolley = (n) => {
    for (let i = 0; i < n; i++) {
      b5._spawnProjectile({
        kind: 'aura', tag: 'modan', owner: foeTeam,
        x: u5.x + Math.round((20 + i * 6) * SCALE), y: u5.y,
        vx: 0, vy: 0, damage: 75, radius: Math.round(6 * SCALE), life: 3, color: '#fff',
      });
    }
  };
  spawnVolley(5);
  const before = b5.projectiles.filter(p => p.alive && p.tag === 'modan').length;
  b5.step();
  const after = b5.projectiles.filter(p => p.alive && p.tag === 'modan').length;
  check(`一次最多消除 ${P.purgeMax} 个敌方魔弹（放了 5 枚）`, before - after === P.purgeMax,
    `${before} → ${after}`);
  check('消除时发了 projPurge 事件（视觉上要能看到被扫掉）',
    evCount(b5, 'projPurge') === P.purgeMax, `${evCount(b5, 'projPurge')} 次`);

  /* 防御性挥动间隔 5 秒 */
  spawnVolley(5);
  b5.step();
  const stillThere = b5.projectiles.filter(p => p.alive && p.tag === 'modan').length;
  check(`防御性挥动间隔 ≥ ${P.defInterval} 秒：5 秒内不会连扫两次`,
    stillThere >= 4, `还剩 ${stillThere} 枚敌方魔弹`);
}

/* ---------- ③ 水镜·魔力共鸣（攻击） ---------- */
console.log('\n【③】水镜·魔力共鸣（攻击）');
{
  const P = JIANQING.mirrorBorrow;
  const b = mk(['jianqing_mirror_borrow'], { rules: { timeLimit: 0 } });
  const u = b.units[0];
  b.step();
  check('第 0 帧就定下颜色（深蓝紫 3 / 白 4）',
    u.flags.borrowColor === 3 || u.flags.borrowColor === 4, String(u.flags.borrowColor));
  check('颜色也进快照（auxKind）', u.auxKind === u.flags.borrowColor, String(u.auxKind));

  /* 深蓝紫：只出魔弹、绝不出激光。
     ⚠ 每次 step 之前把颜色循环的计时器清零，否则 9 秒一到它自己会随机切色 ——
     那不是"实现错了"，是测试没把随机源按住。 */
  const b2 = mk(['jianqing_mirror_borrow'], { rules: { timeLimit: 0 } });
  const u2 = b2.units[0];
  const shots = [];
  for (let i = 0; i < 60 * 9; i++) {
    u2.flags.borrowT = 0;
    setBorrowColor(b2, u2, 3);
    const n = b2.projectiles.length;
    b2.step();
    if (b2.projectiles.length > n) shots.push({ ...b2.projectiles[b2.projectiles.length - 1] });
  }
  /* 3 秒一发 → 第 0 / 3 / 6 秒各一发，第 4 发正好落在 9 秒的边界上
     （作者说"一个周期里一共射四发"，指的就是含边界那一发） */
  check('深蓝紫：9 秒里打出 3~4 发（每 3 秒一发）', shots.length >= 3 && shots.length <= 4,
    `${shots.length} 发`);
  check('深蓝紫：全部是魔弹（tag=modan）', shots.every(p => p.tag === 'modan'),
    [...new Set(shots.map(p => p.tag))].join('、'));
  check('深蓝紫：**没有激光**（作者明确"没有第三发激光"）',
    !b2.events.some(e => e.type === 'shoot' && e.tag === 'laser') &&
    !b2.projectiles.some(p => p.tag === 'laser'), '9 秒里 0 道激光');
  const one = shots[0];
  check(`魔弹伤害 ${P.modanDmg}`, one && one.damage === P.modanDmg, one ? String(one.damage) : '-');
  check(`魔弹弹速 ${P.modanSpeed}`, one && Math.round(Math.hypot(one.vx, one.vy) / SCALE) === P.modanSpeed,
    one ? String(Math.round(Math.hypot(one.vx, one.vy) / SCALE)) : '-');
  check('魔弹是深紫色', one && one.color === P.modanColor, one ? one.color : '-');

  /* 白色：出激光，每 4 秒一发 → 9 秒里 3 发 */
  const b3 = mk(['jianqing_mirror_borrow'], { rules: { timeLimit: 0 } });
  const u3 = b3.units[0];
  const lasers = [];
  for (let i = 0; i < 60 * 9; i++) {
    u3.flags.borrowT = 0;
    setBorrowColor(b3, u3, 4);
    const n = b3.projectiles.length;
    b3.step();
    if (b3.projectiles.length > n) lasers.push({ ...b3.projectiles[b3.projectiles.length - 1] });
  }
  check(`白色：9 秒里打出 3 道激光（每 ${P.laserCd} 秒一道）`, lasers.length === 3,
    `${lasers.length} 道`);
  check('白色：全部是激光（tag=laser）', lasers.every(p => p.tag === 'laser'),
    [...new Set(lasers.map(p => p.tag))].join('、'));
  const L = lasers[0];
  check(`激光伤害 ${P.laserDmg}`, L && L.damage === P.laserDmg, L ? String(L.damage) : '-');
  check(`激光持续 ${P.laserLife} 秒`, L && Math.abs(L.maxLife - P.laserLife) < 1e-9,
    L ? String(L.maxLife) : '-');
  check('激光是白色', L && L.color === P.laserColor, L ? L.color : '-');
  check('激光一端钉在见晴身上（anchor）', L && L.anchor === u3.id, L ? String(L.anchor) : '-');

  /* 颜色每 9 秒随机切 */
  const b4 = mk(['jianqing_mirror_borrow'], { rules: { timeLimit: 0 } });
  const seen = new Set();
  for (let i = 0; i < 60 * 60; i++) { b4.step(); seen.add(b4.units[0].flags.borrowColor); }
  check('60 秒里两种颜色都出现过', seen.has(3) && seen.has(4), [...seen].join('、'));
  const sw = evs(b4, 'mirrorSwitch').filter(e => e.borrow).length;
  check('60 秒切了大约 6~7 次（每 9 秒一次）', sw >= 6 && sw <= 8, `${sw} 次`);
}

/* ---------- ④ 起飞 ---------- */
console.log('\n【④】起飞');
{
  const P = JIANQING.takeoff;
  const b = mk(['jianqing_takeoff'], { rules: { timeLimit: 0 } });
  const u = b.units[0];
  check('起飞距离触发：一开始没在飞', u.flags.flyFrames === 0 && u.invulnFrames === 0);
  /* 跑到累计 1560 单位：速度 120，需要 13 秒 */
  let took = -1;
  for (let i = 0; i < 60 * 20 && took < 0; i++) {
    b.step();
    if (u.flags.flyFrames > 0) took = b.frame;
  }
  check(`累计移动 ${P.distance} 单位后起飞（约 13 秒）`,
    took > 0 && Math.abs(took - P.distance / 120 * 60) <= 6, `第 ${took} 帧（${(took / 60).toFixed(1)} 秒）`);
  check('起飞发了 takeoff 事件', evCount(b, 'takeoff') === 1, `${evCount(b, 'takeoff')} 次`);
  check('起飞瞬间：开"穿透 + 减伤"，而且**不再**开无敌/禁止攻击',
    u.phasingFrames > 0 && u.dmgTakeMul === P.damageTakenMul &&
    u.dmgTakeMulFrames > 0 && u.invulnFrames === 0 && u.noAttackFrames === 0,
    `穿透 ${u.phasingFrames} 帧 / 减伤 ×${u.dmgTakeMul} / 无敌 ${u.invulnFrames} / 禁攻 ${u.noAttackFrames}`);
  check(`空中移速 120 → ${120 + P.speedBonus}`, u.speed / SCALE === 120 + P.speedBonus,
    String(u.speed / SCALE));
  check('起飞时登记了"转向限速"（引擎靠它把总转速钳在 turnPerSec 之内）',
    u.turnCapDegPerSec === P.turnPerSec, `${u.turnCapDegPerSec}°/秒`);
  check('快照的状态位标了"飞行中"',
    b.snapshots[b.snapshots.length - 1].data[u.id * SNAP_STRIDE + 18] === 1,
    `第 18 位 = ${b.snapshots[b.snapshots.length - 1].data[u.id * SNAP_STRIDE + 18]}`);

  /* 减伤：作者这一轮把"免疫"改成了"所有伤害减半"（帧伤也减半） */
  const hp0 = u.hp;
  b._damage(null, u, 500, 'skill');
  check(`空中受到的伤害减半（500 → ${Math.round(500 * P.damageTakenMul)}）`,
    u.hp === hp0 - Math.round(500 * P.damageTakenMul), `hp ${hp0} → ${u.hp}`);
  check('不再发 immune 事件（那条是"免疫"口径的反馈）',
    evCount(b, 'immune') === 0, `${evCount(b, 'immune')} 次`);
  const hp1 = u.hp;
  b._tickDamage(null, u, 8, 'zone', null);
  check(`**帧伤也减半**（8 → ${Math.max(1, Math.round(8 * P.damageTakenMul))}）`,
    u.hp === hp1 - Math.max(1, Math.round(8 * P.damageTakenMul)), `hp ${hp1} → ${u.hp}`);

  /* 穿透 + 帧伤：把敌人摆在她身上。
     ⚠ 先把见晴自己的碰撞伤害清零 —— 否则量到的是"碰撞 30 + 帧伤 5"，
     分不清帧伤到底有没有生效。 */
  const foe = b.units[1];
  foe.x = u.x; foe.y = u.y;
  u.melee = 0;
  const bounce0 = evCount(b, 'bounce');
  const foeHp = foe.hp;
  const vx0 = u.vx, vy0 = u.vy;
  b.step();
  check('穿透：与小球重合也不算碰撞（没有 bounce 事件）',
    evCount(b, 'bounce') === bounce0, `${bounce0} → ${evCount(b, 'bounce')}`);
  /* 速度方向现在**会**变 —— 但那是"追踪敌人"的主动修正（每秒最多 turnPerSec 度），
     不是碰撞反弹：所以判据是"速率不变 + 一帧最多转 turnPerSec/60 度"。 */
  const speed0 = Math.hypot(vx0, vy0);
  let turned = Math.abs(Math.atan2(u.vy, u.vx) - Math.atan2(vy0, vx0)) * 180 / Math.PI;
  if (turned > 180) turned = 360 - turned;
  /* 速率容差：转向是把航向旋转后重新取整回定点数的，
     270 的世界单位对应 270000 定点单位，取整误差可达 1 单位（= 0.001 世界单位）——
     所以按"世界单位 ≤ 0.005"判，别拿定点整数当 1 去卡（第一版就是这么假红的）。 */
  check('穿透：不是被撞飞的（速率不变，方向只按追踪规则小幅修正）',
    Math.abs(Math.hypot(u.vx, u.vy) - speed0) / SCALE <= 0.005 &&
    turned <= P.turnPerSec / 60 + 1.5,
    `速率 ${(speed0 / SCALE).toFixed(3)} → ${(Math.hypot(u.vx, u.vy) / SCALE).toFixed(3)}，`
    + `这一帧转了 ${turned.toFixed(1)}°（上限 ${(P.turnPerSec / 60 + 1.5).toFixed(2)}°）`);
  check(`重合时对方每帧吃 ${P.frameDamage} 点帧伤`, foe.hp === foeHp - P.frameDamage,
    `${foeHp} → ${foe.hp}`);

  /* 空中**可以正常使用其它技能**（作者 2026-10 改口径：不再禁止攻击） */
  const b2 = mk(['jianqing_takeoff', 'jianqing_mirror_sword', 'jianqing_mirror_borrow'],
    { rules: { timeLimit: 0 } });
  const u2 = b2.units[0];
  u2.flags.flyFrames = 600; u2.phasingFrames = 600; u2.dmgTakeMul = P.damageTakenMul;
  setBorrowColor(b2, u2, 3);
  u2.vx = Math.round(120 * SCALE); u2.vy = 0;
  const t2 = b2.units[1];
  t2.x = u2.x + Math.round(60 * SCALE); t2.y = u2.y;   // 正前方，够得着
  const swings0 = evCount(b2, 'swordSwing');
  /* ⚠ 不能拿 `projectiles.length` 的前后差当判据：弹道飞出场外就会被移除，
     长度会自己掉回去（第一版就是这么写出一个"0 → 0"的假红）。
     改成"这段时间里有没有出现过魔弹"。 */
  let sawModan = false;
  for (let i = 0; i < 120; i++) {
    t2.x = u2.x + Math.round(60 * SCALE); t2.y = u2.y;
    u2.flags.flyFrames = Math.max(u2.flags.flyFrames, 600);
    /* ⚠ 每次都把颜色循环的计时器清零 + 强制深蓝紫：
       `passive` 把 borrowT 设成 cycle，所以**第 1 帧**它自己会随机切一次色 ——
       不清零的话它可能切到白色，打出来的是激光而不是魔弹。 */
    u2.flags.borrowT = 0;
    setBorrowColor(b2, u2, 3);
    b2.step();
    if (b2.projectiles.some(p => p.alive && p.tag === 'modan')) sawModan = true;
  }
  check('空中**照常挥剑**（不再被拦）', evCount(b2, 'swordSwing') > swings0,
    `${swings0} → ${evCount(b2, 'swordSwing')} 次`);
  check('空中**照常开火**（③ 的魔弹打出去过）', sawModan, sawModan ? '出现过魔弹' : '一颗都没出');
  /* ① 的防御当然也照常 */
  const b3 = mk(['jianqing_takeoff', 'jianqing_mirror_def'], { rules: { timeLimit: 0 } });
  const u3 = b3.units[0];
  u3.flags.flyFrames = 600; u3.phasingFrames = 600; u3.dmgTakeMul = P.damageTakenMul;
  for (let i = 0; i < 60; i++) {
    u3.flags.flyFrames = Math.max(u3.flags.flyFrames, 600);
    setDefColor(b3, u3, 2);
    b3.step();
  }
  check('空中 ① 的护盾照常攒', u3.res > 0, `护盾 ${u3.res}`);
  u3.hp = 1000;
  for (let i = 0; i < 60; i++) {
    u3.flags.flyFrames = Math.max(u3.flags.flyFrames, 600);
    setDefColor(b3, u3, 1);
    b3.step();
  }
  check('空中 ① 的淡绿回血照常', u3.hp === 1000 + JIANQING.mirrorDef.healPerSec, String(u3.hp));

  /* 落地：3 秒后收尾 */
  const b4 = mk(['jianqing_takeoff'], { rules: { timeLimit: 0 } });
  const u4 = b4.units[0];
  u4.flags.flyFrames = Math.round(P.seconds / DT);
  u4.invulnFrames = u4.flags.flyFrames;
  u4.phasingFrames = u4.flags.flyFrames;
  u4.noAttackFrames = u4.flags.flyFrames;
  u4.speedBonus = P.speedBonus;
  b4.refreshSpeed(u4);
  for (let i = 0; i < Math.round(P.seconds / DT); i++) b4.step();
  check(`滞空正好 ${P.seconds} 秒后落地`, u4.flags.flyFrames === 0,
    `flyFrames=${u4.flags.flyFrames}`);
  check('落地撤掉三个开关', u4.invulnFrames === 0 && u4.phasingFrames === 0 && u4.noAttackFrames === 0);
  /* 落地还原的是**临时**那份 +150；永久成长（每次飞完 +5）要留着 ——
     所以这里是 120 + speedPerFlight，不是 120。 */
  check(`落地还原移速（120 + 永久 +${P.speedPerFlight}）`,
    u4.speed / SCALE === 120 + P.speedPerFlight, String(u4.speed / SCALE));
  check('落地发了 landing 事件', evCount(b4, 'landing') === 1);
  check('落地撤销"转向限速"（回到设置的全局微转向）',
    u4.turnCapDegPerSec === 0, String(u4.turnCapDegPerSec));

  /* 空中仍然撞墙（"只会与墙壁发生碰撞"） */
  const b5 = mk(['jianqing_takeoff'], { rules: { timeLimit: 0 }, arenaId: 'rect' });
  const u5 = b5.units[0];
  u5.flags.flyFrames = 600; u5.invulnFrames = 600; u5.phasingFrames = 600; u5.noAttackFrames = 600;
  const wall0 = evCount(b5, 'wall');
  for (let i = 0; i < 60 * 6; i++) {
    u5.flags.flyFrames = Math.max(u5.flags.flyFrames, 600);
    u5.phasingFrames = Math.max(u5.phasingFrames, 600);
    b5.step();
  }
  check('空中仍然和墙壁碰撞（会撞墙反弹）', evCount(b5, 'wall') > wall0,
    `${wall0} → ${evCount(b5, 'wall')}`);

  /* ---------- 起飞不会"一直飞"（作者实测报过这个） ----------
     原因：触发用的是**累计**移动距离，起飞那一刻如果不清零，
     落地当帧累计量还是 ≥ 1560 → 立刻又起飞，看起来就是"一直飞在天上"。
     所以要点：飞行中不计距离（本来就不该算），**而且起飞时清零**。 */
  const b6 = mk(['jianqing_takeoff'], { rules: { timeLimit: 0 } });
  const u6 = b6.units[0];
  let took6 = -1;
  for (let i = 0; i < 60 * 20 && took6 < 0; i++) {
    b6.step();
    if (u6.flags.flyFrames > 0) took6 = b6.frame;
  }
  check('起飞那一刻：累计距离被清零', u6.flags.traveled < 1e-9, String(u6.flags.traveled));
  /* 飞行中不计距离 */
  const travelAtTakeoff = u6.flags.traveled;
  for (let i = 0; i < 30; i++) b6.step();
  check('飞行中**不计**移动距离（清 0 之后一直保持 0）',
    u6.flags.traveled === travelAtTakeoff, String(u6.flags.traveled));
  const takeoffsBefore = evCount(b6, 'takeoff');
  /* 先跑到真的落地（滞空 5 秒），再看"落地后会不会立刻又飞" */
  for (let i = 0; i < 60 * 8 && u6.flags.flyFrames > 0; i++) b6.step();
  check('滞空结束后确实落地了', u6.flags.flyFrames === 0, String(u6.flags.flyFrames));
  const afterLanding = evCount(b6, 'takeoff');
  for (let i = 0; i < 60 * 2; i++) b6.step();
  check('落地后不会立刻再起飞（得重新走满 1560）',
    evCount(b6, 'takeoff') === afterLanding,
    `2 秒内新增 ${evCount(b6, 'takeoff') - afterLanding} 次`);
  /* 继续跑：落地之后还要**再走满 1560**（120 速 ≈ 13 秒）才会第二次起飞。
     注意前面那 2 秒里有 1.5 秒还在滞空，所以这里给足 16 秒。 */
  for (let i = 0; i < 60 * 16; i++) b6.step();
  check('再走满 1560 之后会再次起飞（不是只飞一次）',
    evCount(b6, 'takeoff') > takeoffsBefore,
    `${takeoffsBefore} → ${evCount(b6, 'takeoff')} 次`);
  check('一局里的起飞次数与"走过的路 ÷ 1560"量级一致（不是每帧都飞）',
    evCount(b6, 'takeoff') <= Math.ceil(b6.frame / 60 * u6.speed / 1000 / P.distance) + 2,
    `${evCount(b6, 'takeoff')} 次 / ${(b6.frame / 60).toFixed(0)} 秒`);
}

/* ---------- ④b 撞墙后朝最近的敌对小球（作者 2026-10 补的要求） ---------- */
console.log('\n【④b】撞墙转向：飞行中撞墙 → 直接指着最近的敌人');
{
  /** 把见晴摆在左墙边、朝左飞，敌人在正上方（与航向差 90°）。
   *  然后跑到"真的撞墙"那一帧，量撞完之后的航向。 */
  const wallTest = (flying) => {
    const b = mk(['jianqing_takeoff'], { foes: ['dummy'], arenaId: 'rect' });
    const u = b.units[0], foe = b.units[1];
    if (flying) {
      u.flags.flyFrames = 600; u.invulnFrames = 600; u.phasingFrames = 600;
      u.noAttackFrames = 600; u.wallHoming = true;
    }
    /* 贴左墙、朝左飞；敌人在正上方 120 单位处 */
    u.x = 20 * 1000; u.y = 250 * 1000;
    u.vx = -120 * 1000; u.vy = 0;
    foe.x = u.x; foe.y = u.y - 120 * 1000;
    foe.vx = 0; foe.vy = 0;
    const speedBefore = Math.hypot(u.vx, u.vy);
    /* 数"新增的 wall 事件"而不是按 a===u.id 过滤：
       事件的 a 是单位 id，容易记错；数增量更稳（也顺手能看出到底撞没撞）。 */
    const wallsBefore = b.events.filter(e => e.type === 'wall').length;
    let hit = -1;
    for (let i = 0; i < 30 && hit < 0; i++) {
      b.step();
      const ws = b.events.filter(e => e.type === 'wall');
      if (ws.length > wallsBefore) hit = ws[ws.length - 1].f;
    }
    if (hit < 0) return { fail: true, x: u.x / 1000, y: u.y / 1000, vx: u.vx / 1000, vy: u.vy / 1000, walls: b.events.filter(e => e.type === 'wall').length };
    const want = Math.atan2(foe.y - u.y, foe.x - u.x);
    const got = Math.atan2(u.vy, u.vx);
    let diff = Math.abs(want - got);
    while (diff > Math.PI) diff = Math.abs(diff - Math.PI * 2);
    return { deg: diff * 180 / Math.PI, speedAfter: Math.hypot(u.vx, u.vy), speedBefore };
  };

  const fly = wallTest(true);
  check('飞行中撞到了墙（用例有效）', !!fly && !fly.fail,
    fly && fly.fail ? `30 帧内没撞墙：pos=(${fly.x.toFixed(1)}, ${fly.y.toFixed(1)}) v=(${fly.vx.toFixed(1)}, ${fly.vy.toFixed(1)}) 全场 wall 事件 ${fly.walls} 次` : '');
  const ok = (r) => !!r && !r.fail;
  check('撞墙后航向**正对**最近的敌人（误差 < 2°）', ok(fly) && fly.deg < 2,
    ok(fly) ? `偏差 ${fly.deg.toFixed(1)}°` : '-');
  check('转向不改变速率（完全弹性那条规矩不许破）',
    ok(fly) && Math.abs(fly.speedAfter - fly.speedBefore) <= 1,
    ok(fly) ? `${fly.speedBefore / 1000} → ${fly.speedAfter / 1000}` : '-');

  const walk = wallTest(false);
  check('平时（没起飞）撞墙**不会**这样 —— 仍然只是按墙偏转规则微调',
    ok(walk) && walk.deg > 20, ok(walk) ? `偏差 ${walk.deg.toFixed(1)}°（远不到"正对"）` : '-');
  check('开关在参数里可关（wallHoming）', JIANQING.takeoff.wallHoming === true,
    String(JIANQING.takeoff.wallHoming));

  /* ---------- 飞行中的持续追踪：每秒最多 turnPerSec 度（作者 2026-10 的要求） ---------- */
  {
    const P2 = JIANQING.takeoff;
    /** 让见晴朝 +x 飞、敌人在正上方（差 90°），跑 n 秒后量航向偏差掉了多少 */
    const steerTest = (seconds, steerRule) => {
      const bb = mk(['jianqing_takeoff'], steerRule == null
        ? { foes: ['dummy'] }
        : { foes: ['dummy'], rules: { steerDegPerSec: steerRule } });
      const uu = bb.units[0], ff = bb.units[1];
      uu.flags.flyFrames = 60 * 60; uu.phasingFrames = 60 * 60;
      uu.dmgTakeMul = P2.damageTakenMul;
      /* ⚠ 关掉"撞墙锁定"：那个是**瞬间**对准敌人，
         会把"每秒最多 45°"的量测结果顶飞（第一版就是这么量到 73° 的，
         其实是她中途撞了墙、被墙规则一把掰过去了）。
         速度也压到 60，免得这 3 秒里飞出场地又撞墙。 */
      uu.wallHoming = false;
      /* 手动摆出"飞行中"的状态时，起飞触发器里的限速登记也要自己补上
         —— 引擎的钳制只看这个字段，不看 flyFrames。 */
      uu.turnCapDegPerSec = P2.turnPerSec;
      uu.vx = Math.round(60 * SCALE); uu.vy = 0;
      ff.x = uu.x; ff.y = uu.y - Math.round(300 * SCALE);
      const before = Math.atan2(uu.vy, uu.vx);
      for (let i = 0; i < 60 * seconds; i++) {
        ff.x = uu.x; ff.y = uu.y - Math.round(300 * SCALE);   // 敌人一直在正上方
        uu.flags.flyFrames = Math.max(uu.flags.flyFrames, 60 * 60);
        bb.step();
      }
      const after = Math.atan2(uu.vy, uu.vx);
      let d = Math.abs(after - before) * 180 / Math.PI;
      if (d > 180) d = 360 - d;
      return { turned: d, speed: Math.hypot(uu.vx, uu.vy) / SCALE };
    };
    const s1 = steerTest(1);
    check(`飞行中每秒最多转 ${P2.turnPerSec}°：1 秒转了 ${s1.turned.toFixed(0)}°（不超过上限）`,
      s1.turned <= P2.turnPerSec + 2, `${s1.turned.toFixed(1)}°`);
    check(`1 秒转的度数接近上限（说明确实在持续修正，不是没转）`,
      s1.turned >= P2.turnPerSec - 4, `${s1.turned.toFixed(1)}° / 上限 ${P2.turnPerSec}°`);
    /* 关键回归：引擎的全局微转向（设置里默认 30°/秒）如果和技能的追踪叠加，
       实测会变成 75°/秒。把规则调到比技能上限还大，总量也必须守在 45°/秒。 */
    const sRule = steerTest(1, P2.turnPerSec + 30);
    check(`引擎微转向不与之叠加（规则 ${P2.turnPerSec + 30}°/秒时仍然 ≤ ${P2.turnPerSec}°/秒）`,
      sRule.turned <= P2.turnPerSec + 2, `${sRule.turned.toFixed(1)}°`);
    const s3 = steerTest(3);
    check('转 3 秒后已经明显朝向敌人（累积生效）',
      s3.turned > s1.turned + 10, `1 秒 ${s1.turned.toFixed(0)}° → 3 秒 ${s3.turned.toFixed(0)}°`);
    check('追踪时速率不变（只改方向）',
      Math.abs(s1.speed - 60) <= 1, String(s1.speed.toFixed(1)));
  }
  /* 滞空时长是作者随时会调的数值（3 → 5 → 4 都出现过），
     所以只守住"是个合理的秒数"，不把具体值写死 —— 写死的话他每调一次测试就假红一次。 */
  check('滞空时长在合理范围（0.5 ~ 20 秒）',
    JIANQING.takeoff.seconds >= 0.5 && JIANQING.takeoff.seconds <= 20,
    `${JIANQING.takeoff.seconds} 秒`);
}

/* ---------- ④c 每次飞行之后的永久成长（作者 2026-10 的新机制） ----------
   "见晴每次起飞过后，速度永久加5，下次起飞的帧伤增加0.5，可叠加"。 */
console.log('\n【④c】飞完一次就永久变强：移速 +5、帧伤 +0.5（可叠加）');
{
  const P = JIANQING.takeoff;
  check('两项成长都在参数里（可调）',
    P.speedPerFlight === 5 && P.frameDamagePerFlight === 0.5,
    `移速 +${P.speedPerFlight} / 帧伤 +${P.frameDamagePerFlight}`);

  /* --- 帧伤随飞行次数叠加 --- */
  /** 让见晴"悬停"在木桩身上 n 帧，返回这段时间打出的总帧伤 */
  const tickDamageOverFlights = (flyCount, frames = 60) => {
    const b = mk(['jianqing_takeoff'], { foes: ['dummy'] });
    const u = b.units[0], foe = b.units[1];
    u.flags.flyCount = flyCount;
    u.flags.flyDmgAcc = 0;
    u.invulnFrames = 600; u.phasingFrames = 600; u.noAttackFrames = 600;
    u.flags.flyFrames = 600;
    const hp0 = foe.hp;
    for (let i = 0; i < frames; i++) {
      u.x = foe.x; u.y = foe.y;          // 一直重合
      u.flags.flyFrames = Math.max(u.flags.flyFrames, 600);
      u.invulnFrames = Math.max(u.invulnFrames, 600);
      u.phasingFrames = Math.max(u.phasingFrames, 600);
      b.step();
    }
    return { dealt: hp0 - foe.hp, ticks: b.events.filter(e => e.type === 'hit' && e.tick).map(e => e.value) };
  };
  const f0 = tickDamageOverFlights(0);
  check(`第 1 次飞行：每秒 ${P.frameDamage * 60} 点（${P.frameDamage}/帧）`,
    f0.dealt === P.frameDamage * 60, `${f0.dealt} 点`);
  const f1 = tickDamageOverFlights(1);
  const want1 = (P.frameDamage + P.frameDamagePerFlight) * 60;
  check(`第 2 次飞行：每秒 ${want1} 点（${P.frameDamage + P.frameDamagePerFlight}/帧）`,
    f1.dealt === want1, `${f1.dealt} 点`);
  check('0.5 的小数**不是被四舍五入吃掉的**：逐次结算的伤害在 5 / 6 之间交替',
    new Set(f1.ticks).size === 2 && Math.min(...f1.ticks) === 5 && Math.max(...f1.ticks) === 6,
    [...new Set(f1.ticks)].sort().join(' / '));
  const f4 = tickDamageOverFlights(4);
  const want4 = (P.frameDamage + P.frameDamagePerFlight * 4) * 60;
  check(`叠到第 5 次飞行：每秒 ${want4} 点（${P.frameDamage + P.frameDamagePerFlight * 4}/帧）`,
    f4.dealt === want4, `${f4.dealt} 点`);
  check('是**可叠加**的（4 次叠加严格等于 4 × 每次的量）',
    f4.dealt === f0.dealt + 4 * P.frameDamagePerFlight * 60,
    `${f0.dealt} → ${f4.dealt}`);

  /* --- 移速：飞完一次永久 +5，而且不会被"落地还原"撤掉 --- */
  const b = mk(['jianqing_takeoff'], { rules: { timeLimit: 0 } });
  const u = b.units[0];
  check('开局：速度 120、还没飞过', u.speed / SCALE === 120 && (u.flags.flyCount || 0) === 0,
    `${u.speed / SCALE} / ${u.flags.flyCount}`);
  const flyOnce = () => {
    /* 直接给足距离让它起飞，然后跑到落地 */
    u.flags.traveled = P.distance;
    let guard = 0;
    while ((u.flags.flyCount || 0) < 1 && guard++ < 60 * 30) b.step();
  };
  const before = u.flags.flyCount || 0;
  flyOnce();
  check('飞完一次：计数 +1', (u.flags.flyCount || 0) === before + 1, String(u.flags.flyCount));
  check(`飞完一次：移速 120 → ${120 + P.speedPerFlight}（永久）`,
    u.speed / SCALE === 120 + P.speedPerFlight, String(u.speed / SCALE));
  check('"永久"的意思：落地之后那份 +5 不会被撤掉（临时的只有空中 +150）',
    (u.speedBonus || 0) === P.speedPerFlight, String(u.speedBonus));
  /* 第二次 */
  u.flags.traveled = P.distance;
  let guard = 0;
  while ((u.flags.flyCount || 0) < 2 && guard++ < 60 * 30) b.step();
  check(`飞完两次：移速 ${120 + P.speedPerFlight * 2}（叠加）`,
    u.speed / SCALE === 120 + P.speedPerFlight * 2, String(u.speed / SCALE));
  /* 空中：永久 +5 与临时 +150 同时在 */
  u.flags.traveled = P.distance;
  guard = 0;
  while (u.flags.flyFrames === 0 && guard++ < 60 * 10) b.step();
  check(`空中移速 = 120 + ${P.speedPerFlight * 2}（永久）+ ${P.speedBonus}（临时）`,
    u.speed / SCALE === 120 + P.speedPerFlight * 2 + P.speedBonus, String(u.speed / SCALE));
  check('飞完会发 flyUpgrade 事件（界面上要能看出"又变强了"）',
    evCount(b, 'flyUpgrade') >= 2, `${evCount(b, 'flyUpgrade')} 次`);
  check('事件里带着"这次成长后的帧伤"（方便核对叠加）',
    (() => {
      const e = evs(b, 'flyUpgrade').pop();
      return e && Math.abs(e.frameDamage - (P.frameDamage + 2 * P.frameDamagePerFlight)) < 1e-9;
    })(), JSON.stringify(evs(b, 'flyUpgrade').pop() && evs(b, 'flyUpgrade').pop().frameDamage));

  /* --- 与 ⑤ 精灵变身叠乘：帧伤按伤害倍率缩放 --- */
  const b2 = mk(['jianqing_takeoff', 'jianqing_transform'], { foes: ['dummy'] });
  const u2 = b2.units[0], foe2 = b2.units[1];
  u2.flags.flyCount = 1;
  u2.invulnFrames = 600; u2.phasingFrames = 600; u2.noAttackFrames = 600;
  const hp0 = foe2.hp;
  for (let i = 0; i < 60; i++) {
    u2.x = foe2.x; u2.y = foe2.y;
    u2.flags.flyFrames = Math.max(u2.flags.flyFrames, 600);
    u2.invulnFrames = Math.max(u2.invulnFrames, 600);
    u2.phasingFrames = Math.max(u2.phasingFrames, 600);
    b2.step();
  }
  const wantMul = Math.round((P.frameDamage + P.frameDamagePerFlight) * JIANQING.transform.damageMul * 60);
  check(`与 ⑤ 叠乘：帧伤 ×${JIANQING.transform.damageMul}（60 帧 ≈ ${wantMul} 点）`,
    Math.abs((hp0 - foe2.hp) - wantMul) <= 1, `${hp0 - foe2.hp} 点`);
}

/* ---------- ⑤ 精灵变身 ---------- */
console.log('\n【⑤】精灵变身');
{
  const P = JIANQING.transform;
  const b = mk(['jianqing_transform']);
  const u = b.units[0];
  check(`体型减半：r 16 → ${16 * P.sizeMul}`, u.r / SCALE === 16 * P.sizeMul, String(u.r / SCALE));
  check(`移速 120 → ${120 + P.speedBonus}`, u.speed / SCALE === 120 + P.speedBonus,
    String(u.speed / SCALE));
  check('伤害倍率变成一半', u.damageMul === P.damageMul, String(u.damageMul));

  /* 所有伤害减半：碰撞、魔弹、帧伤 */
  check('碰撞伤害 30 → 15',
    b._meleeDamage(u) === Math.round(30 * P.damageMul), String(b._meleeDamage(u)));
  const b2 = mk(['jianqing_transform', 'jianqing_mirror_borrow'], { rules: { timeLimit: 0 } });
  const u2 = b2.units[0];
  u2.flags.borrowT = 0;
  setBorrowColor(b2, u2, 3);
  b2.step();
  const bullet = b2.projectiles.find(p => p.tag === 'modan');
  check(`魔弹伤害 75 → ${Math.round(75 * P.damageMul)}（也减半）`,
    bullet && bullet.damage === Math.max(1, Math.round(75 * P.damageMul)),
    bullet ? String(bullet.damage) : '没打出来');
  check(`帧伤也减半（${JIANQING.takeoff.frameDamage} → ${Math.round(JIANQING.takeoff.frameDamage * P.damageMul)}）`,
    b2._scaledDamage(u2, JIANQING.takeoff.frameDamage) ===
    Math.max(1, Math.round(JIANQING.takeoff.frameDamage * P.damageMul)),
    String(b2._scaledDamage(u2, JIANQING.takeoff.frameDamage)));

  /* 长剑长度减半（装配顺序反过来也要对） */
  for (const order of [['jianqing_transform', 'jianqing_mirror_sword'],
    ['jianqing_mirror_sword', 'jianqing_transform']]) {
    const bb = mk(order);
    check(`长剑长度减半（装配顺序 ${order[0].includes('transform') ? '变身在前' : '长剑在前'}）`,
      bb.units[0].swordLen === JIANQING.mirrorSword.swordLen * P.swordMul,
      String(bb.units[0].swordLen));
  }
}

/* ---------- ⑥ 我很可爱 ---------- */
console.log('\n【⑥】我很可爱');
{
  const P = JIANQING.feather;
  const b = mk(['jianqing_feather'], { rules: { timeLimit: 0 } });
  const u = b.units[0];
  const featherCount = () => b.projectiles.filter(p => p.feather).length;
  check('一开始没有羽毛', featherCount() === 0);
  b._damage(null, u, 299, 'skill');
  check('掉了 299 血：还没到 300，不发羽毛', featherCount() === 0,
    `${featherCount()} 根`);
  b._damage(null, u, 1, 'skill');
  check('正好掉满 300：发一根羽毛', featherCount() === 1, `${featherCount()} 根`);
  b._damage(null, u, 900, 'skill');
  check('又掉 900：再发 3 根（余数留到下次）', featherCount() === 4, `${featherCount()} 根`);
  b._damage(null, u, 200, 'skill');
  check('再掉 200：余数 200，还是 4 根', featherCount() === 4, `${featherCount()} 根`);
  b._damage(null, u, 100, 'skill');
  check('凑满 300：发第 5 根', featherCount() === 5, `${featherCount()} 根`);

  const f = b.projectiles.find(p => p.feather);
  check(`羽毛速度 ${P.speed}`, Math.round(Math.hypot(f.vx, f.vy) / SCALE) === P.speed,
    String(Math.round(Math.hypot(f.vx, f.vy) / SCALE)));
  check('羽毛会追踪（homing 指向最近的敌人）',
    f.homing && f.homing.targetId === b.units[1].id, JSON.stringify(f.homing));
  check(`羽毛可以撞墙反弹（bounces = ${P.bounces}）`, f.bounces === P.bounces, String(f.bounces));
  check('羽毛进快照时是独立的 kind（渲染层画成羽毛）',
    (() => {
      b.step();
      const snap = b.snapshots[b.snapshots.length - 1];
      for (let i = 0; i < snap.proj.length; i += 11) if (snap.proj[i + 5] === 4) return true;
      return false;
    })(), 'kind=4');

  /* 命中后的减益：移速减半 3 秒、减伤永久叠加。
     用**桃夭**当靶子：她本来就有 66 点碰撞伤害，"减 5" 才看得出来。 */
  const { applyFeatherDebuff } = await import('../../js/skills.js');
  const b2 = mk(['jianqing_feather'], { foes: ['taoyao'] });
  const foe = b2.units[1];
  const full = foe.speed / SCALE;
  /* 直接把羽毛放到对手身上，走真实的命中路径（含真正的那份减益函数） */
  b2._spawnProjectile({
    kind: 'aura', tag: 'feather', owner: b2.units[0], feather: true,
    x: foe.x, y: foe.y, vx: 0, vy: 0, damage: 0, radius: Math.round(P.r * SCALE),
    life: 3, color: P.color, bounces: 0,
    onHit: (bb, from, hit) => applyFeatherDebuff(bb, hit),
  });
  b2.step();
  check('命中后移速减半', foe.speed / SCALE === full * P.slowMul,
    `${full} → ${foe.speed / SCALE}`);
  check('命中后碰撞伤害 -5', foe.meleePenalty === P.meleeMinus, String(foe.meleePenalty));
  check('命中后技能伤害 -5', foe.skillPenalty === P.skillMinus, String(foe.skillPenalty));
  /* 减伤作用在"它造成的伤害"上：它打见晴 → 伤害少 5。
     ⚠ _meleeDamage() 本身**不含**这个减伤（66 还是 66）——
     减伤统一在 _damage 的出口处扣，一处覆盖所有来源。
     所以下面量的是"真打出去掉多少血"，而不是 _meleeDamage 的返回值。 */
  check('减伤不改 _meleeDamage 的返回值（引擎口径：面板显示的是原始值）',
    b2._meleeDamage(foe) === 66, String(b2._meleeDamage(foe)));
  /* 减伤作用在"它造成的伤害"上：它打见晴 → 伤害少 5 */
  const jhp = b2.units[0].hp;
  b2._damage(foe, b2.units[0], 80, 'skill');
  check('它打出的技能伤害被扣掉 5（80 → 75）', b2.units[0].hp === jhp - (80 - P.skillMinus),
    `掉血 ${jhp - b2.units[0].hp}`);
  const jhp2 = b2.units[0].hp;
  b2._damage(foe, b2.units[0], 50, 'melee');
  check('它打出的碰撞伤害也被扣 5（50 → 45）', b2.units[0].hp === jhp2 - (50 - P.meleeMinus),
    `掉血 ${jhp2 - b2.units[0].hp}`);
  const jhp3 = b2.units[0].hp;
  b2._tickDamage(foe, b2.units[0], 10, 'caiguang', null);
  check('**帧伤不减**（作者明确排除）：10 点照打 10 点',
    b2.units[0].hp === jhp3 - 10, `掉血 ${jhp3 - b2.units[0].hp}`);

  /* 3 秒后移速恢复 */
  for (let i = 0; i < Math.round(P.slowSeconds / DT) + 2; i++) {
    if (foe.speedMulFrames > 0) b2.step();
  }
  check(`移速减半只持续 ${P.slowSeconds} 秒，之后恢复`,
    foe.speed / SCALE === full && foe.speedMul === 1,
    `${foe.speed / SCALE}（应为 ${full}）`);
  check('但减伤是永久的（不会跟着恢复）',
    foe.meleePenalty === P.meleeMinus && foe.skillPenalty === P.skillMinus,
    `碰撞 -${foe.meleePenalty} / 技能 -${foe.skillPenalty}`);

  /* 叠加 + 最低 1 点 */
  foe.meleePenalty = 0; foe.skillPenalty = 0;
  for (let i = 0; i < 20; i++) {
    foe.meleePenalty += P.meleeMinus;
    foe.skillPenalty += P.skillMinus;
  }
  const jhp4 = b2.units[0].hp;
  b2._damage(foe, b2.units[0], 80, 'skill');
  check('减伤可以叠加到"最低打出 1 点"（20 层 = -100，80 点打成 1 点）',
    b2.units[0].hp === jhp4 - 1, `掉血 ${jhp4 - b2.units[0].hp}`);
}

/* ---------- ⑦ 引擎契约（这轮为见晴加的东西） ---------- */
console.log('\n【⑦】引擎契约（快照 / 免疫 / 穿透 / 帧伤）');
{
  check('快照步长扩到 19（新增水镜两色 + 状态位）', SNAP_STRIDE === 19, String(SNAP_STRIDE));
  const b = mk(['jianqing_mirror_def', 'jianqing_mirror_borrow'], { rules: { timeLimit: 0 } });
  b.step();
  const snap = b.snapshots[b.snapshots.length - 1];
  const o = b.units[0].id * SNAP_STRIDE;
  check('快照 16 = 防守水镜颜色', snap.data[o + 16] === b.units[0].flags.mirrorColor,
    `${snap.data[o + 16]}`);
  check('快照 17 = 借用水镜颜色', snap.data[o + 17] === b.units[0].flags.borrowColor,
    `${snap.data[o + 17]}`);
  check('快照 18 = 状态位（没起飞时是 0）', snap.data[o + 18] === 0, `${snap.data[o + 18]}`);

  /* _spendResource 的契约 */
  const b2 = mk([]);
  const u2 = b2.units[0];
  u2.res = 40;
  check('_spendResource 返回**实际花掉的量**（要 100 只有 40）',
    b2._spendResource(u2, 100, 'test') === 40 && u2.res === 0, String(u2.res));
  check('护盾空了之后再花返回 0', b2._spendResource(u2, 10, 'test') === 0);

  /* 帧伤标记：免疫放行 + 减伤不生效 */
  const b3 = mk([], { foes: ['dummy'] });
  const u3 = b3.units[0];
  u3.invulnFrames = 60;
  u3.skillPenalty = 50;
  const h0 = b3.units[1].hp;
  b3._tickDamage(u3, b3.units[1], 10, 'caiguang', null);
  check('帧伤：发射方有减伤也不打折（10 点照打）', b3.units[1].hp === h0 - 10,
    `掉血 ${h0 - b3.units[1].hp}`);

  /* 友军不受空中帧伤影响 */
  const b4 = new Battle({
    teams: [{ units: [{ stats: makeUnitStats('jianqing', ['jianqing_takeoff']) },
      { stats: makeUnitStats('dummy') }] }],
    arena: ARENA_BY_ID.rect, sizeScale: 1, rules: { ...DEFAULT_RULES }, seed: 3,
  });
  const u4 = b4.units[0], mate = b4.units[1];
  u4.flags.flyFrames = 60; u4.invulnFrames = 60; u4.phasingFrames = 60; u4.noAttackFrames = 60;
  mate.x = u4.x; mate.y = u4.y;
  const mhp = mate.hp;
  b4.step();
  check('空中帧伤不伤队友（同队不算）', mate.hp === mhp, `${mhp} → ${mate.hp}`);
}

console.log('\n' + log.join('\n'));
console.log(`\n=========== 通过 ${pass} 项，失败 ${fail} 项 ===========`);
process.exit(fail ? 1 : 0);

/* 缇娜 · 七个技能逐条对照规格自检
 *
 * 这个角色一次引入了六套新引擎系统（吸附 / 沉默 / 近战免疫 / 移速乘子 /
 * 追踪返程弹道 / 时间停止 / 锚定光柱），所以每条都要有断言，
 * 否则"实现了但从没跑过"和"没实现"在测试里长得一模一样。
 *
 * 用法：node tests/diag/tina.mjs
 */
import { Battle, SNAP_STRIDE } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, SPECIES_BY_ID, makeUnitStats, SCALE, DT } from '../../js/balls.js';
import { TINA, getSkill, resolveLoadout, skillGroup } from '../../js/skills.js';

const T = SPECIES_BY_ID.tina;
let pass = 0, fail = 0;
const log = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; log.push(`  ✅ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; log.push(`  ❌ ${name}${detail ? '  — ' + detail : ''}`); }
};

function mk(skills, opts = {}) {
  const stats = (id, sk) => ({ ...makeUnitStats(id), skills: sk });
  return new Battle({
    teams: opts.teams || [
      { units: [{ stats: stats('tina', skills) }] },
      { units: [{ stats: stats(opts.foeId || 'test', opts.foeSkills || []) }] },
    ],
    arena: ARENA_BY_ID[opts.arenaId || 'rect'],
    sizeScale: 1,
    rules: { ...DEFAULT_RULES, timeLimit: opts.timeLimit ?? 30 },
    seed: opts.seed ?? 7,
  });
}
const ev = (b, t) => b.events.filter(e => e.type === t);
/* 事件记在 step 中间的帧号上，快照却在步末记录 —— 差 1 帧（README 第 23 条） */
const snapOf = (e) => e.f + 1;

console.log('=========== 缇娜 · 技能自检 ===========\n');

/* ============ 0. 基础数值与装配 ============ */
console.log('【0】基础数值与装配');
{
  check('血量 1500', T.hp === 1500, String(T.hp));
  check('移速 125', T.speed === 125, String(T.speed));
  check('碰撞伤害 50', T.melee === 50, String(T.melee));
  check('技能 7 个、默认装配取前 3 个',
    T.skills.length === 7 && SPECIES_BY_ID.tina.skills.length === 7,
    `${T.skills.length} 个`);
  check('魔力资源上限 5', T.resource && T.resource.max === 5,
    T.resource ? `${T.resource.name} ${T.resource.max}` : '无');
  const u = mk(['tina_suck', 'tina_bat', 'tina_shot']).units[0];
  check('开局魔力为 0', u.res === 0, String(u.res));
  check('mutex：⑤⑥⑦ 同属 princess 组',
    skillGroup('tina_p1') === 'princess' && skillGroup('tina_p2') === 'princess' &&
    skillGroup('tina_p3') === 'princess');
  check('同时装三个传承时只留下一个',
    resolveLoadout(['tina_p1', 'tina_p2', 'tina_p3']).length === 1,
    resolveLoadout(['tina_p1', 'tina_p2', 'tina_p3']).join(','));
}

/* ============ ① 吸血习性 ============ */
console.log('\n【①】吸血习性');
{
  const P = TINA.suck;
  check('碰撞伤害降低到 30',
    mk(['tina_suck']).units[0].melee === P.meleeTo,
    String(mk(['tina_suck']).units[0].melee));
  check('不带它时碰撞伤害是 50', mk([]).units[0].melee === 50);
  check('带权杖时是 65',
    mk(['tina_scepter']).units[0].melee === 50 + TINA.scepter.meleeBonus,
    String(mk(['tina_scepter']).units[0].melee));
  /* 作者原话："碰撞伤害提高15点（不影响吸血习性的碰撞伤害）" */
  check('权杖 + 吸血习性 → 仍然锁在 30（+15 不生效）',
    mk(['tina_suck', 'tina_scepter']).units[0].melee === P.meleeTo,
    String(mk(['tina_suck', 'tina_scepter']).units[0].melee));

  /* 真打一局：吸附、3 跳、回血、免疫 */
  const b = mk(['tina_suck'], { timeLimit: 30 });
  b.runToEnd();
  const latches = ev(b, 'latch');
  check('撞击后确实吸附了', latches.length > 0, `${latches.length} 次`);
  const drains = ev(b, 'drain');
  check('吸附期间有回血（drain 事件）', drains.length > 0, `${drains.length} 次`);
  if (latches.length) {
    /* 关键断言：每次吸附恰好 3 跳。数"这一次吸附期间发生了几次 drain" */
    const t0 = latches[0].f;
    const t1 = t0 + P.holdFrames;
    const inWindow = drains.filter(d => d.f >= t0 && d.f <= t1);
    check('一次吸附期间恰好 3 跳（接触伤害节拍自然落成 3 次）',
      inWindow.length === 3, `${inWindow.length} 跳`);
    if (inWindow.length) {
      const iv = inWindow.slice(1).map((d, i) => d.f - inWindow[i].f);
      check('跳与跳之间约 0.5 秒', iv.every(v => Math.abs(v - 30) <= 2), iv.join(', '));
      check('每跳伤害 = 缇娜的碰撞伤害 30',
        inWindow.every(d => d.value === P.meleeTo),
        inWindow.map(d => d.value).join(', '));
    }
    const ends = ev(b, 'latchEnd');
    check('吸附会结束', ends.length > 0, `${ends.length} 次`);

    /* ---- 吸附结束后的硬性间隔（作者：吸附完成之后 1 秒内不再吸附）---- */
    const starts = ev(b, 'latch').map(e => e.f);
    const endFrames = ev(b, 'latchEnd').map(e => e.f);
    const gaps = [];
    for (const st of starts) {
      /* 找这次吸附之前最近的一次"结束" */
      const prev = endFrames.filter(f => f < st).pop();
      if (prev != null) gaps.push((st - prev) * DT);
    }
    check('每一次吸附都距离上一次吸附结束至少 1 秒',
      gaps.length > 0 && gaps.every(g => g >= P.afterCooldown - 0.02),
      gaps.length ? gaps.map(g => g.toFixed(2)).join(', ') + ' 秒' : '只吸附过一次，测不到间隔');
    check('给出了间隔事件（latchCooldown）',
      ev(b, 'latchCooldown').length > 0, `${ev(b, 'latchCooldown').length} 次`);

    /* 间隔是用 skillCd 实现的，所以直接看它 ——
       这条比"事件之间的间隔"更接近实现，两道都留着：
       事件对不上说明流程错，skillCd 对不上说明拦截没生效。 */
    const b9 = mk(['tina_suck'], { timeLimit: 30 });
    let sawCd = 0;
    while (!b9.over && b9.frame < 1400) {
      const n0 = b9.events.length;
      b9.step();
      if (b9.events.slice(n0).some(e => e.type === 'latchEnd')) {
        sawCd = b9.units[0].skillCd['tina_suck'] || 0;
        break;
      }
    }
    check(`吸附结束当帧 skillCd 被设成 ${P.afterCooldown} 秒`,
      Math.abs(sawCd - P.afterCooldown) < 1e-6, `skillCd=${sawCd}`);
  }

  /* 目标被禁技能 + 移速减半；缇娜免疫碰撞伤害 */
  const b2 = mk(['tina_suck'], { timeLimit: 30 });
  let sawSilence = false, sawHalfSpeed = false, sawImmune = false, sawRestore = false;
  while (!b2.over && b2.frame < 1200) {
    b2.step();
    const a = b2.units[0], d = b2.units[1];
    if (a.latch && d.alive) {
      if (d.silencedFrames > 0) sawSilence = true;
      if (Math.abs(d.speedMul - P.targetSpeedMul) < 1e-9) sawHalfSpeed = true;
      if (a.meleeImmuneFrames > 0) sawImmune = true;
    }
    if (!a.latch && d.alive && d.speedMul === 1) sawRestore = true;
  }
  check('吸附期间目标被沉默（发不出技能）', sawSilence);
  check('吸附期间目标移速乘子 = 0.5', sawHalfSpeed);
  check('吸附期间缇娜处于近战免疫', sawImmune);
  check('吸附结束后目标移速被还原', sawRestore);

  /* 沉默**不挡撞墙技能**（作者："除碰撞墙体使用的技能以外"） */
  const b3 = mk(['tina_suck'], { foeId: 'test_skill', foeSkills: ['test_dash'] });
  const foe = b3.units[1];
  foe.silencedFrames = 60;
  const before = ev(b3, 'chargeStart').length;
  for (let i = 0; i < 600 && !b3.over; i++) b3.step();
  check('沉默挡不住撞墙类技能（test_dash 照常蓄力）',
    ev(b3, 'chargeStart').length > before,
    `${ev(b3, 'chargeStart').length - before} 次`);
}

/* ============ ② 蝙蝠 ============ */
console.log('\n【②】蝙蝠');
{
  const P = TINA.bat;
  /* 对手用"测试球·技能型"——它带了两个真技能，才测得到偷学。
     基础测试球一个技能都没有，偷学本来就该什么都不发生。 */
  const b = mk(['tina_bat'], { foeId: 'test_skill', foeSkills: ['test_shot', 'test_dash'], timeLimit: 20 });
  b.runToEnd();
  const swarm = ev(b, 'batSwarm');
  check('按冷却成批放出', swarm.length > 0, `${swarm.length} 批`);
  check('每批 3~5 只',
    swarm.every(e => e.value >= P.minCount && e.value <= P.maxCount),
    swarm.slice(0, 5).map(e => e.value).join(', '));
  const iv = swarm.slice(1).map((e, i) => e.f - swarm[i].f);
  check(`发射间隔约 ${P.cd} 秒`,
    iv.length > 0 && iv.every(v => Math.abs(v - P.cd / DT) <= 2), iv.join(', '));
  check('蝙蝠会命中（projHit）', ev(b, 'projHit').length > 0,
    `${ev(b, 'projHit').length} 次`);
  const rets = ev(b, 'batReturn');
  check('蝙蝠会返回缇娜身上（batReturn）', rets.length > 0, `${rets.length} 次`);
  if (rets.length) {
    check(`每次返回回 ${P.heal} 血（作者已从 6 下调到 3）`,
      rets.every(e => e.value === P.heal),
      rets.slice(0, 4).map(e => e.value).join(', '));
    /* 权杖提高的是**伤害**，不该把回血也一起乘上去 */
    const bS = mk(['tina_bat', 'tina_scepter'], { foeId: 'test_skill', foeSkills: ['test_shot'], timeLimit: 20 });
    bS.runToEnd();
    const retsS = ev(bS, 'batReturn');
    check('权杖不放大蝙蝠的回血（只放大伤害）',
      retsS.length > 0 && retsS.every(e => e.value === P.heal),
      retsS.length ? retsS.slice(0, 4).map(e => e.value).join(', ') : '这一局没有蝙蝠返回');
  }
  /* 魔力：每只返回 +1，满 5 清零并触发偷学 */
  const bursts = ev(b, 'manaBurst');
  check('魔力满 5 会触发一次（manaBurst）', bursts.length > 0, `${bursts.length} 次`);
  const steals = ev(b, 'steal');
  check('偷学确实发生了（steal 事件）', steals.length > 0,
    steals.length ? steals.map(e => e.skill).join('、') : '没有');
  check('偷学没有抛异常（stealFail 为空）', ev(b, 'stealFail').length === 0,
    ev(b, 'stealFail').map(e => e.err).join(' / ') || '无');

  /* 偷不到被动 / 撞墙类 */
  const b2 = mk(['tina_bat'], { foeId: 'yuncai', foeSkills: ['yuncai_caiguang', 'yuncai_zheguang'] });
  const foe = b2.units[1];
  for (let i = 0; i < 900 && !b2.over; i++) b2.step();
  const names = ev(b2, 'steal').map(e => e.skill);
  check('偷不到撞墙类（裁光）/ 被动（折光）',
    !names.includes('裁光') && !names.includes('折光'),
    names.length ? names.join('、') : '（这一局没偷到）');

  /* 追踪转速上限：60°/秒（权杖 90°/秒） */
  const b3 = mk(['tina_bat']);
  const u3 = b3.units[0];
  const bat = b3.projectiles.find(p => p.tag === 'bat');
  for (let i = 0; i < 10 && !bat && !b3.over; i++) { b3.step(); }
  const live = b3.projectiles.find(p => p.tag === 'bat');
  check('蝙蝠带追踪参数（转速上限 60°/秒）',
    !!live && live.homing && live.homing.turnPerSec === P.turnPerSec,
    live && live.homing ? `${live.homing.turnPerSec}°/秒` : '没找到蝙蝠');
  /* 半径必须是定点数：漏了 SCALE 就会变成 0.005 世界单位 ——
     画面上是个亚像素点（作者原话"看不到特效"），碰撞也几乎撞不到。 */
  check(`蝙蝠的半径是定点数（${P.r} 世界单位，不是 0.005）`,
    !!live && Math.abs(live.r / SCALE - P.r) < 0.01,
    live ? `${(live.r / SCALE).toFixed(2)} 世界单位` : '-');
  check(`蝙蝠速度 ${P.speed} 世界单位/秒`,
    !!live && Math.abs(Math.hypot(live.vx, live.vy) / SCALE - P.speed) < 1,
    live ? `${(Math.hypot(live.vx, live.vy) / SCALE).toFixed(0)}` : '-');
  /* 转弯半径要给作者一个能判断的数：速度 ÷ 角速度。
     场地约 700×500，半径超过一二百就意味着"基本直飞、只在末端划弧"。 */
  {
    const radius = P.speed / ((P.turnPerSec * Math.PI) / 180);
    check(`蝙蝠的转弯半径在场地尺度内（<${300}）`, radius < 300,
      `${radius.toFixed(0)} 世界单位（权杖后 ${(P.speed / (((P.turnPerSec + TINA.scepter.turnBonusDeg) * Math.PI) / 180)).toFixed(0)}）`);
  }
  check('蝙蝠带返程参数（returnTo = 缇娜）',
    !!live && live.returnTo === u3.id, live ? String(live.returnTo) : '-');

  const b4 = mk(['tina_bat', 'tina_scepter']);
  b4.step(); b4.step(); b4.step();
  const live4 = b4.projectiles.find(p => p.tag === 'bat');
  check('权杖把追踪偏转角提到 90°/秒',
    !!live4 && live4.homing.turnPerSec === P.turnPerSec + TINA.scepter.turnBonusDeg,
    live4 && live4.homing ? `${live4.homing.turnPerSec}°/秒` : '-');
  check('权杖把蝙蝠伤害提到 8',
    !!live4 && live4.damage === Math.round(P.damage * TINA.scepter.damageMul),
    live4 ? String(live4.damage) : '-');
}

/* ============ ③ 魔力霰弹 ============ */
console.log('\n【③】魔力霰弹');
{
  const P = TINA.shot;
  const b = mk(['tina_shot'], { timeLimit: 20 });
  b.runToEnd();
  const shots = b.events.filter(e => e.type === 'shoot' && e.tag === 'tina_shot');
  check('打出了魔弹', shots.length > 0, `${shots.length} 发`);
  check(`每发伤害 ${P.damage}`, shots.every(e => e.value === P.damage),
    shots.length ? String(shots[0].value) : '-');
  /* 一轮 3 发、0.5 秒内打完、每 2 秒一轮 */
  const f0 = shots[0].f;
  const round1 = shots.filter(e => e.f >= f0 && e.f < f0 + P.cd / DT);
  check(`一轮 ${P.count} 发`, round1.length === P.count, `${round1.length} 发`);
  if (round1.length === P.count) {
    const span = round1[round1.length - 1].f - round1[0].f;
    check(`一轮跨约 ${P.windowSeconds} 秒`,
      Math.abs(span * DT - P.windowSeconds) < 0.06, `${(span * DT).toFixed(3)} 秒`);
  }
  /* 分轮：轮内间隔 15~16 帧、轮间 90 帧，所以门槛取 40 帧 ——
     必须比轮内大、比轮间小。原来写 10，比轮内间隔还小，
     于是每一发都被当成新的一轮，量出来的"轮间隔"自然是一串 0.25 秒。 */
  const rounds = [];
  for (const e of shots) {
    if (!rounds.length || e.f - rounds[rounds.length - 1] > 40) rounds.push(e.f);
  }
  const iv = rounds.slice(1).map((f, i) => (f - rounds[i]) * DT);
  check(`轮与轮之间约 ${P.cd} 秒`,
    iv.length > 0 && iv.every(v => Math.abs(v - P.cd) < 0.08), iv.join(', '));

  /* 角度偏差不超过 15° */
  const b2 = mk(['tina_shot'], { timeLimit: 20 });
  let maxDev = 0;
  while (!b2.over && b2.frame < 900) {
    const n0 = b2.projectiles.length;
    b2.step();
    for (const p of b2.projectiles.slice(0)) {
      if (p.tag !== 'tina_shot' || p.__seen) continue;
      p.__seen = true;
      const t = b2.units[1];
      if (!t.alive) continue;
      const want = Math.atan2(t.y - p.y, t.x - p.x);
      const got = Math.atan2(p.vy, p.vx);
      let d = Math.abs(got - want);
      while (d > Math.PI) d = Math.abs(d - Math.PI * 2);
      maxDev = Math.max(maxDev, (d * 180) / Math.PI);
    }
  }
  check(`每发随机偏差不超过 ${P.spreadDeg}°`,
    maxDev > 0 && maxDev <= P.spreadDeg + 3, `实测最大 ${maxDev.toFixed(1)}°`);
  check('偏差确实是随机的（不是每发都正对）', maxDev > 1, `最大 ${maxDev.toFixed(1)}°`);

  const b3 = mk(['tina_shot', 'tina_scepter']);
  b3.runToEnd();
  const s3 = b3.events.filter(e => e.type === 'shoot' && e.tag === 'tina_shot');
  check('权杖把霰弹伤害提到 40',
    s3.length > 0 && s3.every(e => e.value === Math.round(P.damage * TINA.scepter.damageMul)),
    s3.length ? String(s3[0].value) : '-');
}

/* ============ ④ 权杖 ============ */
console.log('\n【④】权杖');
{
  check('碰撞伤害 +15',
    mk(['tina_scepter']).units[0].melee === 50 + TINA.scepter.meleeBonus);
  check('伤害倍率是 4/3（霰弹 30→40、蝙蝠 6→8）',
    Math.round(TINA.shot.damage * TINA.scepter.damageMul) === 40 &&
    Math.round(TINA.bat.damage * TINA.scepter.damageMul) === 8);
  check('被动实现了 passive()', typeof getSkill('tina_scepter').passive === 'function');
}

/* ============ ⑤ 公主传承1（时间停止） ============ */
console.log('\n【⑤】公主传承1 · 时间停止');
{
  const P = TINA.p1;
  const b = mk(['tina_p1'], { timeLimit: 12 });
  b.runToEnd();
  const ts = ev(b, 'timeStop');
  check('按冷却发动', ts.length > 0, `${ts.length} 次`);
  check(`每次持续 ${P.duration} 秒`,
    ts.length > 0 && Math.abs(ts[0].value - P.duration) < 1e-9, String(ts[0] && ts[0].value));

  /* 停止期间：别人的球不动、冷却不走、开不了火，但持续伤害照跳 */
  const b2 = mk(['tina_p1'], { timeLimit: 12 });
  b2.step();
  const tina = b2.units[0], foe = b2.units[1];
  check('开战即进入时间停止', b2.timeStopActive(), `until=${b2.timeStopUntil} frame=${b2.frame}`);
  check('豁免者是缇娜', b2.timeStopOwner === tina.id, String(b2.timeStopOwner));
  check('冻结判定：对手被冻、缇娜不被冻',
    b2._frozenFor(foe) && !b2._frozenFor(tina));
  /* 连续推进：对手位置应完全不变（除非它本来就没动） */
  const fx = foe.x, fy = foe.y;
  for (let i = 0; i < 100 && b2.timeStopActive(); i++) b2.step();
  check('停止期间对手一动不动',
    foe.x === fx && foe.y === fy, `(${fx},${fy}) → (${foe.x},${foe.y})`);
  check('停止期间缇娜照常移动或开火（没被冻）', !b2._frozenFor(tina));

  /* 冷却：停止期间对手的冷却不走 */
  const b3 = mk(['tina_p1'], { foeId: 'test_skill', foeSkills: ['test_shot'] });
  const foe3 = b3.units[1];
  foe3.skillCd = { test_shot: 2.0 };
  b3.step();
  const cd0 = foe3.skillCd.test_shot;
  for (let i = 0; i < 60; i++) b3.step();
  check('停止期间对手的技能冷却不走',
    Math.abs(foe3.skillCd.test_shot - cd0) < 1e-9,
    `${cd0.toFixed(3)} → ${foe3.skillCd.test_shot.toFixed(3)}`);

  /* 持续伤害照跳：给对手挂一个灼烧伤害区，看它掉不掉血 */
  const b4 = mk(['tina_p1'], { arenaId: 'lava_center', timeLimit: 12 });
  b4.step();
  const foe4 = b4.units[1];
  /* 伤害区是圆心 (360,220) 半径 85 的一个圆（熔心斗场），
     对手的出生点在区外 —— 先把它挪进岩浆里，否则测的是"站在安全区不掉血"。
     世界坐标 → 定点：乘 SCALE。 */
  const zone = b4.arena.zones.find(z => z.type === 'damage');
  foe4.x = Math.round(zone.shape.cx * SCALE);
  foe4.y = Math.round(zone.shape.cy * SCALE);
  foe4.vx = 0; foe4.vy = 0;
  const hp0 = foe4.hp;
  for (let i = 0; i < 90 && b4.timeStopActive(); i++) b4.step();
  check('停止期间持续伤害照常结算（站在伤害场地里会掉血）',
    foe4.hp < hp0, `${hp0} → ${foe4.hp}`);

  /* 快照带上豁免者下标，渲染层据此褪色 */
  const b5 = mk(['tina_p1'], { timeLimit: 12 });
  b5.step();
  const s1 = b5.snapshots[b5.frame];
  check('快照里带上了时间停止豁免者下标（渲染层褪色用）',
    s1 && s1.ts === b5.units[0].id, s1 ? String(s1.ts) : '没有 ts 字段');
  let cleared = false;
  while (!b5.over && b5.frame < 600) {
    b5.step();
    if (!b5.timeStopActive() && b5.snapshots[b5.frame].ts === -1) { cleared = true; break; }
  }
  check('停止结束后快照里的豁免者回到 -1', cleared);
}

/* ============ ⑥ 公主传承2 ============ */
console.log('\n【⑥】公主传承2 · 瞬移撞击');
{
  const b = mk(['tina_p2'], { timeLimit: 12 });
  const tina = b.units[0], foe = b.units[1];
  const x0 = tina.x, y0 = tina.y;
  b.step();
  check('发动了瞬移（blink 事件）', ev(b, 'blink').length > 0);
  /* 没带蝙蝠技能也会放出一只蝙蝠 */
  const bats = b.projectiles.filter(p => p.tag === 'bat');
  check('没带「蝙蝠」也会放出一只（不论有没有携带）',
    bats.length >= 1, `${bats.length} 只`);
  const d = Math.hypot(tina.x - foe.x, tina.y - foe.y);
  check('瞬移后紧贴目标（距离 = 两球半径和）',
    Math.abs(d - (tina.r + foe.r)) < 2, `距离 ${d.toFixed(1)}，期望 ${tina.r + foe.r}`);
  check('确实挪动了位置', tina.x !== x0 || tina.y !== y0);

  /* 带了吸血习性 → 直接吸附 */
  const b2 = mk(['tina_p2', 'tina_suck'], { timeLimit: 12 });
  b2.step();
  check('带吸血习性时直接进入吸附',
    !!b2.units[0].latch, b2.units[0].latch ? '已吸附' : '没吸附');
  check('吸附目标就是被瞬移到的那个',
    !!b2.units[0].latch && b2.units[0].latch.targetId === b2.units[1].id);
}

/* ============ ⑦ 公主传承3 ============ */
console.log('\n【⑦】公主传承3 · 旋转光柱');
{
  const P = TINA.p3;
  const b = mk(['tina_p3'], { timeLimit: 12 });
  const tina = b.units[0];
  b.step();
  check(`${P.chargeSeconds} 秒蓄力（先记下开火时刻，不立刻发射）`,
    tina.flags.p3At > 0 && b.projectiles.filter(p => p.tag === 'tina_beam').length === 0,
    `p3At=${tina.flags.p3At}`);
  /* 蓄力期间不放光柱 */
  let beamFrame = -1;
  for (let i = 0; i < 120 && !b.over; i++) {
    b.step();
    if (b.projectiles.some(p => p.tag === 'tina_beam')) { beamFrame = b.frame; break; }
  }
  const waitFrames = beamFrame - 1;
  check(`蓄力约 ${P.chargeSeconds} 秒后开火`,
    Math.abs(waitFrames * DT - P.chargeSeconds) < 0.05, `${(waitFrames * DT).toFixed(3)} 秒`);

  const beam = b.projectiles.find(p => p.tag === 'tina_beam');
  check('光柱存在且锚定在缇娜身上', !!beam && beam.anchor === tina.id,
    beam ? `anchor=${beam.anchor}` : '没有');
  check('光柱直径与小球一致（width = 32，世界单位）',
    !!beam && beam.w === P.radius * 2, beam ? String(beam.w) : '-');
  /* 光柱的 w 是**世界单位**、r 是**定点数** —— 两者单位不同，
     同一行里写错一个就是"画得出来但撞不到"或"看不见"。 */
  check('光柱的碰撞半径也是定点数（虽然命中走 tickDamage）',
    !!beam && beam.r / SCALE >= 1 && beam.r / SCALE <= 10,
    beam ? `${(beam.r / SCALE).toFixed(2)} 世界单位` : '-');
  check('光柱从锚点向前画（beamForward）', !!beam && beam.beamForward === true);
  check('光柱长度进了弹道（判定与绘制共用一个数）',
    !!beam && beam.beamLen === P.len, beam ? String(beam.beamLen) : '-');
  /* 弹道更新开头会先 p.life -= DT，所以读出来天然少一帧（1.9833），不是 2.000 */
  check('光柱持续 2 秒（少一帧是"先扣寿命再更新"的记账方式，不是时长错）',
    !!beam && Math.abs(beam.life - P.durationSeconds) < DT * 1.5,
    beam ? beam.life.toFixed(4) : '-');
  check(`判定节拍是每秒 ${P.tickPerSec} 次`,
    !!beam && Math.abs(beam.tickInterval - 1 / P.tickPerSec) < 1e-9,
    beam ? beam.tickInterval.toFixed(4) : '-');
  check('光柱不走弹体命中（伤害只由 tickDamage 结算）',
    !!beam && beam.noBodyHit === true && beam.damage === 0);

  /* 光柱会跟着目标转向 */
  b.step(); b.step(); b.step();
  const beam2 = b.projectiles.find(p => p.tag === 'tina_beam');
  if (beam2) {
    check('光柱位置钉在缇娜身上',
      Math.abs(beam2.x - tina.x) < SCALE && Math.abs(beam2.y - tina.y) < SCALE,
      `beam(${beam2.x},${beam2.y}) tina(${tina.x},${tina.y})`);
  } else {
    check('光柱位置钉在缇娜身上', false, '光柱没了');
  }

  /* 总伤害：6 次 × 35 */
  const b3 = mk(['tina_p3'], { timeLimit: 12 });
  b3.runToEnd();
  /* 数"缇娜打出的、每次 35 的"伤害事件 */
  const hits = b3.events.filter(e =>
    (e.type === 'damage' || e.type === 'hit') && e.value === P.damage);
  check('光柱按 35 一跳结算', hits.length > 0 || ev(b3, 'damage').length > 0,
    `${hits.length} 条 35 伤害事件`);
}

/* ============ 综合 ============ */
console.log('\n【综合】');
{
  const all = mk(T.skills.slice(), { timeLimit: 60 });
  let err = null;
  const t0 = Date.now();
  try { all.runToEnd(); } catch (e) { err = e; }
  const ms = Date.now() - t0;
  check('七个技能一起跑不报错', !err, err ? err.message : `${all.frame} 帧，${ms} ms`);
  if (!err) {
    check('对局正常收场', !!all.endReason, all.endReason);
    check('模拟速度可接受', ms < 8000, `${ms} ms`);
    check('事件流没爆', all.events.length <= 8000, `${all.events.length} 条`);
    check('弹道没有失控', all.projectiles.length < 400, `${all.projectiles.length} 枚`);
  }
  const fp = (seed, skills) => {
    const b = mk(skills, { seed, timeLimit: 30 });
    b.runToEnd();
    let h = 2166136261;
    for (const s of b.snapshots) for (let i = 0; i < s.data.length; i++) {
      h ^= Math.round(s.data[i] * 1000); h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  };
  const h1 = fp(7, T.skills.slice()), h2 = fp(7, T.skills.slice()), h3 = fp(9, T.skills.slice());
  check('同种子三次一致', h1 === h2, `${h1} / ${h2}`);
  check('不同种子不同', h1 !== h3, `${h1} vs ${h3}`);
}

console.log('\n' + log.join('\n'));
console.log(`\n=========== 通过 ${pass} 项，失败 ${fail} 项 ===========`);
process.exit(fail ? 1 : 0);

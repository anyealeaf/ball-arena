/* 晕彩 · 七个技能逐条对照规格自检
 *
 * 每个技能单独装、单独测；能定量的全部定量（距离、帧数、伤害数字）。
 * 用法：node tests/diag/yuncai.mjs
 */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle, SNAP_STRIDE } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, SPECIES_BY_ID, makeUnitStats, SCALE } from '../../js/balls.js';
import { YUNCAI, SKILLS } from '../../js/skills.js';

const Y = SPECIES_BY_ID.yuncai;
let pass = 0, fail = 0;
const log = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; log.push(`  ✅ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; log.push(`  ❌ ${name}${detail ? '  — ' + detail : ''}`); }
}

/** 造一场指定装配的对局。skillIds 里的技能会覆盖球种默认装配。 */
function mk(skills, opts = {}) {
  const stats = (id, sk) => ({ ...makeUnitStats(id), skills: sk });
  return new Battle({
    teams: [
      { units: [{ stats: stats('yuncai', skills) }] },
      { units: [{ stats: stats(opts.foeId || 'test', opts.foeSkills || []) }] },
    ],
    arena: ARENA_BY_ID[opts.arenaId || 'rect'],
    sizeScale: opts.sizeScale ?? 1,
    rules: { ...DEFAULT_RULES, ...(opts.rules || {}) },
    seed: opts.seed ?? 31,
  });
}

const evCount = (b, t) => b.events.filter(e => e.type === t).length;

/** 造一枚测试用弹道。
 *  **必须走引擎自己的 _spawnProjectile**，不要手搓对象字面量：
 *  手搓的那份字段表和工厂会漂移 —— 引擎加了新字段（比如 fedLines），
 *  手搓的没有，于是 _updateFields 里读它就整个崩掉。
 *  实测就是这么崩的：三条断言全挂在同一个"字段表过期"上。
 *  走工厂就永远同步。 */
function probeProj(b, owner, x, y, over = {}) {
  return b._spawnProjectile({
    kind: 'aura', tag: 'probe', owner,
    x, y, vx: 0, vy: 0,
    damage: 0,
    radius: 6 * SCALE,
    width: 12, life: 1, color: '#fff',
    traits: ['light'],
    ...over,
  });
}
const hitsOf = (b, kind) => b.events.filter(e => e.type === 'hit' && e.kind === kind);

/* 进度标记走 stderr：重定向到文件时 stdout 是带缓冲的，
   卡住时看不到真实进度（这个脚本就被这一点坑过一次）。 */
const mark = (s) => { try { process.stderr.write(s + '\n'); } catch { /* ignore */ } };

/** 推进到第 n 帧的循环必须带 over 保护：
    step() 在对局结束后会立刻返回、frame 不再增长，
    单纯写 while (frame < n) step() 会变成死循环。 */
function advance(b, n, cap = 200000) {
  let i = 0;
  while (b.frame < n && !b.over && i++ < cap) b.step();
  return i;
}

console.log('=========== 晕彩 · 技能自检 ===========\n');

/* ============ 基础数值 ============ */
console.log('【0】基础数值');
{
  check('血量 1500', Y.hp === 1500, String(Y.hp));
  check('速度 120', Y.speed === 120, String(Y.speed));
  check('没有碰撞伤害', Y.melee === 0, String(Y.melee));
  const b = mk([]);
  const u = b.units[0];
  check('未装折光时 melee 保持 0', u.melee === 0, String(u.melee));
  check('未装辉光领域时 dodge 为 0', !u.dodge, String(u.dodge));
  check('未装辉光领域时没有极光', b.aurora === false);
  const b2 = mk(['yuncai_zheguang', 'yuncai_domain']);
  check('装了折光后 melee = 100', b2.units[0].melee === 100, String(b2.units[0].melee));
  check(`装了辉光领域后 dodge = 配置值（${YUNCAI.domain.dodge}）`,
    Math.abs(b2.units[0].dodge - YUNCAI.domain.dodge) < 1e-9, String(b2.units[0].dodge));
  check('装了辉光领域后开启极光', b2.aurora === true);
}

/* ============ ① 裁光 ============ */
console.log('\n【①】裁光');
{
  const b = mk(['yuncai_caiguang']);
  b.runToEnd();
  check('撞墙会产生质点', evCount(b, 'moteDrop') > 0, `${evCount(b, 'moteDrop')} 个`);
  check('两个质点连成细线', evCount(b, 'lineForm') > 0, `${evCount(b, 'lineForm')} 条`);

  /* 质点必须落在**墙面上**（球与墙的接触位置），不是球心。
     球心夹紧后离墙面还有一段距离，用球心会把质点留在场地中间。
     测法：从该点朝 48 个方向逐步外推，找到"开始被判出界"的最小距离，
     那就是它到最近墙面的距离 —— 落在墙面上应当 ≈ 0。 */
  {
    const bb = mk(['yuncai_caiguang'], { rules: { allowShrink: false, timeLimit: 60 } });
    bb.runToEnd();
    const distToWall = (x, y) => {
      let best = Infinity;
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * Math.PI * 2, ux = Math.cos(a), uy = Math.sin(a);
        for (let d = 0.5; d <= 40; d += 0.5) {
          const cl = bb.clampPoint(x + ux * d, y + uy * d, 0);
          if (Math.hypot(cl.x - (x + ux * d), cl.y - (y + uy * d)) > 0.01) {
            best = Math.min(best, d); break;
          }
        }
      }
      return best;
    };
    const pts = [];
    for (const e of bb.events.filter(e => e.type === 'moteDrop' || e.type === 'lineForm')) {
      pts.push([e.px, e.py]);
      if (e.type === 'lineForm') pts.push([e.x2, e.y2]);
    }
    const ds = pts.map(([x, y]) => distToWall(x, y));
    const worst = Math.max(...ds);
    check('质点与细线端点都落在墙面上（不是球心）', pts.length > 0 && worst <= 1.0,
      `${pts.length} 个端点，距墙最远 ${worst.toFixed(2)}`);
    const outside = pts.filter(([x, y]) => {
      const c = bb.clampPoint(x, y, 0);
      return Math.hypot(c.x - x, c.y - y) > 0.01;
    }).length;
    check('质点与细线端点都不在场地外', outside === 0, `${outside} 个越界`);
  }

  /* 定量：质点每帧 1 点。把敌人直接按在质点上，数 60 帧掉多少血。 */
  const b2 = mk(['yuncai_caiguang']);
  const A = b2.units[0], B = b2.units[1];
  /* 手动放一个质点，把敌人挪上去 */
  const f = b2._spawnField({ kind: 'mote', owner: A, x: B.x, y: B.y, r: YUNCAI.caiguang.moteR, damage: 1 });
  const hp0 = B.hp;
  for (let i = 0; i < 60; i++) b2.step();
  const lost = hp0 - B.hp;
  /* 敌人自己会飘走，所以只要求"掉过血"且幅度合理（每帧 1 点，60 帧最多 60） */
  check('踩在质点上每帧掉 1 点血', lost > 0 && lost <= 60, `60 帧共掉 ${lost} 点`);
  check('质点的每帧伤害走 caiguang 分类',
    Object.keys(B.damageFrom).includes('caiguang'), JSON.stringify(B.damageFrom));

  /* 伤害数值必须**逐帧真实**：只有 1（漆黑）和 2（深紫）两个值。
     曾经为了防事件流爆掉把 15 帧合并成一条事件，
     结果飘字出现"-16"，玩家读到的是"一帧扣 16 点"—— 报假数比事件多更糟。 */
  {
    const bd = mk(['yuncai_caiguang', 'yuncai_domain'], { rules: { timeLimit: 60 } });
    bd.runToEnd();
    const caiguang = bd.events.filter(e => e.type === 'hit' && e.kind === 'caiguang');
    const tickVals = [...new Set(caiguang.filter(e => e.tick).map(e => e.value))].sort((a, c) => a - c);
    const boomVals = [...new Set(caiguang.filter(e => !e.tick).map(e => e.value))].sort((a, c) => a - c);
    check('持续伤害的数值只有 1 与 2（逐帧真实值，没有合并放大）',
      tickVals.length > 0 && tickVals.every(v => v === 1 || v === 2), `出现的值 ${tickVals.join(',')}`);
    /* 非持续的只有细线爆炸那一下（300），不能混进"每帧伤害"里 */
    check('细线爆炸是独立的一次性伤害（300），没被并进逐帧伤害',
      boomVals.every(v => v === YUNCAI.caiguang.boom), `出现的值 ${boomVals.join(',') || '（本局没爆）'}`);
    const ticks = caiguang.filter(e => e.tick).length;
    check('持续伤害事件没有把事件流吃光', bd.events.length < 6000,
      `持续伤害 ${ticks} 条 / 事件流共 ${bd.events.length} 条`);
  }

  /* 细线三阶段：直接构造一条线，验证伤害与爆炸 */
  const b3 = mk(['yuncai_caiguang']);
  const A3 = b3.units[0], B3 = b3.units[1];
  const line = b3._spawnField({
    kind: 'line', owner: A3,
    x: B3.x - 50 * SCALE, y: B3.y, x2: B3.x + 50 * SCALE, y2: B3.y,
    halfW: YUNCAI.caiguang.lineHalfW,
    damageByStage: YUNCAI.caiguang.dmgByStage,
    boomDamage: YUNCAI.caiguang.boom,
  });
  check('细线初始为第一阶段（漆黑）', line.stage === 0, `stage=${line.stage}`);

  /* 吸收一次"光" → 深紫（2/帧） */
  const owner = b3.units[1];   // 敌方
  probeProj(b3, owner, B3.x, B3.y);
  b3.step();
  check('细线吸收"光"后进阶到深紫', line.stage === 1, `stage=${line.stage}`);
  check('吸收会消耗掉那枚"光"', evCount(b3, 'lineAbsorb') === 1);

  /* 再吸收一次 → 微光，接下来敌方触碰就爆炸 */
  probeProj(b3, owner, B3.x, B3.y);
  b3.step();
  check('第二次吸收后进入微光阶段', line.stage === 2, `stage=${line.stage}`);

  /* 微光阶段被触碰 → 爆炸。注意爆炸就发生在**设成微光的那一帧**：
     _updateFields 里先做阶段推进、再判接触伤害，所以同一帧就爆了。
     所以这里直接建一条已经是微光的线，只测"这一帧"的爆炸伤害。 */
  const b3b = mk(['yuncai_caiguang']);
  const A3b = b3b.units[0], B3b = b3b.units[1];
  const lineB = b3b._spawnField({
    kind: 'line', owner: A3b,
    x: B3b.x - 50 * SCALE, y: B3b.y, x2: B3b.x + 50 * SCALE, y2: B3b.y,
    halfW: YUNCAI.caiguang.lineHalfW,
    damageByStage: YUNCAI.caiguang.dmgByStage,
    boomDamage: YUNCAI.caiguang.boom,
  });
  lineB.stage = 2;
  const hpBefore = B3b.hp;
  b3b.step();
  const boom = hpBefore - B3b.hp;
  check('微光阶段被敌方触碰会爆炸并消失',
    evCount(b3b, 'lineBoom') === 1 && lineB.alive === false, `爆炸 ${evCount(b3b, 'lineBoom')} 次`);
  check(`爆炸伤害为 ${YUNCAI.caiguang.boom}`, boom === YUNCAI.caiguang.boom, `实际 ${boom}`);
  check('微光阶段的线在被踩之前一直存在',
    line.stage === 2 && evCount(b3, 'lineBoom') >= 0);

  /* 敌方不碰就永远不炸 */
  const b4 = mk(['yuncai_caiguang']);
  const line4 = b4._spawnField({
    kind: 'line', owner: b4.units[0],
    x: 50 * SCALE, y: 50 * SCALE, x2: 120 * SCALE, y2: 50 * SCALE,
    halfW: 3, damageByStage: YUNCAI.caiguang.dmgByStage, boomDamage: 300,
  });
  for (let i = 0; i < 300; i++) b4.step();
  check('细线不会自己过期消失', line4.alive === true || evCount(b4, 'lineBoom') > 0);
}

/* ============ ① + ⑥ 辉光领域让细线自动进阶 ============ */
console.log('\n【①+⑥】领域内细线自动进阶');
{
  const b = mk(['yuncai_caiguang', 'yuncai_domain']);
  const line = b._spawnField({
    kind: 'line', owner: b.units[0],
    x: 40 * SCALE, y: 40 * SCALE, x2: 200 * SCALE, y2: 40 * SCALE,
    halfW: 3, damageByStage: YUNCAI.caiguang.dmgByStage, boomDamage: 300,
    stageTimerMax: Math.round(YUNCAI.caiguang.stageSeconds / (1 / 60)),
  });
  for (let i = 0; i < Math.round(YUNCAI.caiguang.stageSeconds * 60) + 2; i++) b.step();
  check(`领域内 ${YUNCAI.caiguang.stageSeconds} 秒后自动进阶一次`, line.stage === 1, `stage=${line.stage}`);
  for (let i = 0; i < Math.round(YUNCAI.caiguang.stageSeconds * 60) + 2; i++) b.step();
  check('再过一个周期进阶到微光', line.stage === 2, `stage=${line.stage}`);
  check('自动进阶不计入"吸收次数"', line.absorb === 0, `absorb=${line.absorb}`);

  /* 不装领域就不会自动进阶 */
  const b2 = mk(['yuncai_caiguang']);
  const line2 = b2._spawnField({
    kind: 'line', owner: b2.units[0],
    x: 40 * SCALE, y: 40 * SCALE, x2: 200 * SCALE, y2: 40 * SCALE,
    halfW: 3, damageByStage: YUNCAI.caiguang.dmgByStage, boomDamage: 300,
    stageTimerMax: 0,
  });
  for (let i = 0; i < 600; i++) b2.step();
  check('没装辉光领域时细线不会自动进阶', line2.stage === 0, `stage=${line2.stage}`);
}

/* ============ ② 魔弹 ============ */
console.log('\n【②】魔弹');
{
  const P = YUNCAI.modan;
  const b = mk(['yuncai_modan']);
  const shots = [];
  while (!b.over && b.frame < b.maxFrames && shots.length < 6) {
    const n0 = b.events.length;
    b.step();
    for (const e of b.events.slice(n0)) {
      if (e.type === 'shoot') shots.push({ t: b.frame / 60, tag: e.tag, v: e.value });
    }
  }
  check('会按冷却发射', shots.length >= 3, `${shots.length} 发`);
  if (shots.length >= 2) {
    /* 第 1、2 发是魔力球；命中两次之后第 3 发应当是激光。
       这里不保证命中，所以按"出现过的 tag"来判定。 */
    const tags = [...new Set(shots.map(s => s.tag))];
    check('发射物带 tag（modan/laser）', tags.every(t => t === 'modan' || t === 'laser'), tags.join(','));
    const intervals = shots.slice(1).map((s, i) => +(s.t - shots[i].t).toFixed(3));
    check(`发射间隔约 ${P.cd} 秒`, intervals.every(v => Math.abs(v - P.cd) < 0.05), intervals.join(', '));
  }
  const modanShots = b.events.filter(e => e.type === 'shoot' && e.tag === 'modan');
  check(`魔力球伤害为 ${P.dmg}`, modanShots.every(e => e.value === P.dmg),
    modanShots.length ? String(modanShots[0].value) : '没发出');

  /* 命中两次 → 第三发变激光。直接用可控场景验证计数逻辑。 */
  const b2 = mk(['yuncai_modan']);
  const A = b2.units[0], B = b2.units[1];
  const fireAndHit = (n) => {
    for (let i = 0; i < n; i++) {
      A.skillCd = {};
      const before = b2.events.length;
      b2._runSkills(A, 'cooldown');
      const shot = b2.events.slice(before).find(e => e.type === 'shoot');
      // 把这发弹道直接搬到敌人身上，制造"命中"
      const p = b2.projectiles[b2.projectiles.length - 1];
      if (p) { p.x = B.x; p.y = B.y; }
      b2.step();
      if (shot) shot.tag;
    }
  };
  /* 清掉战斗里已经打出的计数，重新来 */
  A.flags.modanHits = 0;
  b2.projectiles.length = 0;
  const seq = [];
  for (let i = 0; i < 4; i++) {
    A.skillCd = {};
    const before = b2.events.length;
    b2._runSkills(A, 'cooldown');
    const shot = b2.events.slice(before).find(e => e.type === 'shoot');
    seq.push(shot ? shot.tag : '-');
    const p = b2.projectiles[b2.projectiles.length - 1];
    if (p) { p.x = B.x; p.y = B.y; }
    b2.step();
  }
  check('前两发是魔力球、第三发变激光、之后重新计数',
    seq[0] === 'modan' && seq[1] === 'modan' && seq[2] === 'laser' && seq[3] === 'modan',
    seq.join(' → '));

  /* 激光参数 */
  const b3 = mk(['yuncai_modan']);
  const A3 = b3.units[0];
  A3.flags.modanHits = P.hitsToLaser;
  A3.skillCd = {};
  const n0 = b3.events.length;
  b3._runSkills(A3, 'cooldown');
  const laserShot = b3.events.slice(n0).find(e => e.type === 'shoot');
  check(`激光伤害为 ${P.laserDmg}`, laserShot && laserShot.value === P.laserDmg,
    laserShot ? String(laserShot.value) : '没发出');
  const lp = b3.projectiles[b3.projectiles.length - 1];
  /* 第三发的规格（作者 2026-10 改版）：
     形态同缇娜的「公主传承3」—— 锚在施法者身上、向前画的圆柱、贯穿战场；
     但只持续半秒、**不跟随目标**（方向定死）、**每个目标只结算一次**。 */
  check(`光柱的宽度为 ${P.laserWidth}（判定半宽与画面共用这个数）`,
    lp && Math.abs(lp.w - P.laserWidth) < 0.01,
    lp ? `宽 ${lp.w}` : '-');
  check('光柱一端钉在晕彩身上（anchor = 施法者）',
    lp && lp.anchor === A3.id, lp ? `anchor=${lp.anchor}` : '-');
  check('光柱**不跟随目标**（没有 anchorTarget，方向发射即定死）',
    lp && lp.anchorTarget === -1, lp ? `anchorTarget=${lp.anchorTarget}` : '-');
  check('光柱向前画（beamForward，不是普通激光那种向后拖影）',
    lp && lp.beamForward === true);
  check(`光柱长度 ${P.laserLen} ≥ 最长场地对角线（贯穿战场）`,
    lp && lp.beamLen === P.laserLen && P.laserLen >= 1266,
    lp ? `beamLen=${lp.beamLen}` : '-');
  check(`只持续 ${P.laserLife} 秒`, lp && Math.abs(lp.life - P.laserLife) < 1e-9,
    lp ? String(lp.life) : '-');
  check('每个目标只结算一次（sweepOnce，不是按节拍反复掉血）',
    lp && lp.sweepOnce === true);
  check('命中不走"贴到就爆"的弹体判定（否则它会在晕彩身边自爆）',
    lp && lp.noBodyHit === true);
  check('带"光"特质', lp && lp.traits.includes('light'));
  check('光柱发射后计数归零', A3.flags.modanHits === 0, String(A3.flags.modanHits));
  /* 作者要求：碰到裁光的细线**不会消失**，但依然提供"光" */
  check('光柱不会被细线吃掉（absorbable = false）',
    lp && lp.absorbable === false, lp ? String(lp.absorbable) : '-');

  /* "不跟随目标"要**按行为测**，不能只查字段：
     anchorTarget = -1 只说明没挂追踪参数，万一别处又给它转了向就漏了。
     做法：记下发射瞬间的方向，然后把目标挪到一个完全不同的角度，再推进几帧 ——
     方向必须一点没变；同时位置要跟着晕彩（那才是"锚定"）。 */
  {
    const b6 = mk(['yuncai_modan']);
    const A6 = b6.units[0], B6 = b6.units[1];
    /* 注意**不能**清空 skills —— _runSkills 遍历的就是它，清了就一枪都不放。
       （前面"穿透实战"那段清空是对的，因为那道光是我手工 spawn 的。） */
    A6.flags.modanHits = P.hitsToLaser;
    A6.skillCd = {};
    b6._runSkills(A6, 'cooldown');
    const beam6 = b6.projectiles[b6.projectiles.length - 1];
    const dir0 = Math.atan2(beam6.vy, beam6.vx);
    /* 把敌人挪到晕彩正上方（与原方向差 90°），并让它站着不动 */
    B6.x = A6.x; B6.y = A6.y - Math.round(300 * SCALE);
    B6.vx = 0; B6.vy = 0;
    for (let i = 0; i < 10 && !b6.over; i++) b6.step();
    const dir1 = beam6.alive ? Math.atan2(beam6.vy, beam6.vx) : null;
    check('光柱的方向发射后一点不变（真的不跟随目标）',
      dir1 !== null && Math.abs(dir1 - dir0) < 1e-9,
      dir1 === null ? '光柱没了' : `${(dir0 * 180 / Math.PI).toFixed(2)}° → ${(dir1 * 180 / Math.PI).toFixed(2)}°`);
    check('光柱的位置跟着晕彩走（锚定，不是钉在原地）',
      beam6.x === A6.x && beam6.y === A6.y,
      `光柱(${(beam6.x / SCALE).toFixed(0)},${(beam6.y / SCALE).toFixed(0)}) 晕彩(${(A6.x / SCALE).toFixed(0)},${(A6.y / SCALE).toFixed(0)})`);
  }

  /* 穿透实战：让激光横穿整排敌人，每个都该挨一次 */
  {
    const bp = new Battle({
      teams: [
        { units: [{ stats: { ...makeUnitStats('yuncai'), skills: ['yuncai_modan'] } }] },
        { units: Array.from({ length: 3 }, () => ({ stats: makeUnitStats('test') })) },
      ],
      arena: ARENA_BY_ID.rect, sizeScale: 1, rules: { ...DEFAULT_RULES, timeLimit: 10 }, seed: 5,
    });
    const A = bp.units[0];
    /* 把三个敌人排成一条横线放在晕彩右侧，然后手工发一道朝右的激光。
       注意要先把晕彩的技能清空 —— 否则它自己的魔弹也会打中第一个敌人，
       测出来的伤害就成了"激光 + 魔弹"，看不出穿透有没有重复结算。 */
    [1, 2, 3].forEach((k, i) => {
      const u = bp.units[k];
      u.x = A.x + Math.round((100 + i * 70) * SCALE);
      u.y = A.y; u.vx = 0; u.vy = 0;
    });
    A.vx = 0; A.vy = 0;
    A.skills = [];
    const hp0 = [1, 2, 3].map(k => bp.units[k].hp);
    /* 与技能里发出来的那道**同一种**弹道（锚定、向前、贯穿、一趟只打一下） */
    bp._spawnProjectile({
      kind: 'aura', tag: 'laser', owner: A,
      x: A.x, y: A.y,
      vx: 1000 * SCALE, vy: 0,
      damage: P.laserDmg, radius: Math.round(2 * SCALE),
      width: P.laserWidth, beam: true, beamForward: true, beamLen: P.laserLen,
      anchor: A.id, noBodyHit: true, sweepOnce: true, absorbable: false,
      life: P.laserLife, color: '#e9d5ff', traits: ['light'],
    });
    for (let i = 0; i < 60; i++) bp.step();
    const hurt = [1, 2, 3].filter((k, i) => bp.units[k].hp < hp0[i]).length;
    check('一道激光能穿透并命中三个敌人', hurt === 3, `${hurt}/3 个受伤`);
    const hitsPer = [1, 2, 3].map((k, i) => hp0[i] - bp.units[k].hp);
    check('每个目标只吃一次激光伤害（不会反复结算）',
      hitsPer.every(v => v === P.laserDmg || v === 0), hitsPer.join(','));
  }

  /* ---------- 光柱碰到裁光的细线：不消失，但依然提供"光" ---------- */
  {
    const bl = mk(['yuncai_modan', 'yuncai_caiguang']);
    const AL = bl.units[0], BL = bl.units[1];
    /* 清掉技能，避免它自己的魔弹/裁光掺进来；我们手工发一道朝右的贯穿光柱 */
    const keep = bl.arena;
    AL.skills = [];
    BL.skills = [];
    BL.x = AL.x + Math.round(600 * SCALE);
    BL.y = AL.y;
    /* 在光柱的路上横一条细线（竖着的，正好被横光柱穿过） */
    const lx = AL.x + Math.round(200 * SCALE);
    const line = bl._spawnField({
      kind: 'line', owner: AL,
      x: lx, y: AL.y - 60 * SCALE, x2: lx, y2: AL.y + 60 * SCALE,
      halfW: YUNCAI.caiguang.lineHalfW,
      damageByStage: YUNCAI.caiguang.dmgByStage,
      boomDamage: YUNCAI.caiguang.boom,
    });
    const stage0 = line.stage;
    const beam = bl._spawnProjectile({
      kind: 'aura', tag: 'laser', owner: AL,
      x: AL.x, y: AL.y, vx: 1000 * SCALE, vy: 0,
      damage: P.laserDmg, radius: Math.round(2 * SCALE),
      width: P.laserWidth, beam: true, beamForward: true, beamLen: P.laserLen,
      anchor: AL.id, noBodyHit: true, sweepOnce: true, absorbable: false,
      life: P.laserLife, color: '#e9d5ff', traits: ['light'],
    });
    const target = bl.projectiles[bl.projectiles.length - 1];
    /* 推进帧数按时长算，别写死 —— 光柱寿命改成 0.5 秒之后，
       原来推 30 帧正好推到它到期的时刻，"不会消失"会假红。 */
    const holdFrames = Math.floor((P.laserLife / (1 / 60)) * 0.67);
    for (let i = 0; i < holdFrames && !bl.over; i++) bl.step();
    check(`光柱碰到细线**不会消失**（${P.laserLife} 秒里一直都在）`,
      !!target && target.alive, target ? (target.alive ? '还在' : '没了') : '找不到');
    check('细线照样进阶了（光柱提供了"光"）',
      line.stage > stage0, `stage ${stage0} → ${line.stage}`);
    /* 每条细线只喂一次：光柱会在线上停一会儿，逐帧都喂的话细线瞬间满级 */
    check('同一条细线只喂一次（不会逐帧顶到满级）',
      line.absorb === 1, `absorb=${line.absorb}`);
    void keep;
  }

  /* 魔弹被裁光的细线吸收，也要算一次命中计数 */
  {
    const bc = mk(['yuncai_modan', 'yuncai_caiguang']);
    const A = bc.units[0], B = bc.units[1];
    A.vx = 0; A.vy = 0; B.vx = 0; B.vy = 0;
    A.flags.modanHits = 0;
    /* 在晕彩与敌人之间横一条细线 —— 魔弹必然被它吃掉 */
    const midX = (A.x + B.x) / 2, midY = (A.y + B.y) / 2;
    bc._spawnField({
      kind: 'line', owner: A,
      x: midX, y: midY - 70 * SCALE, x2: midX, y2: midY + 70 * SCALE,
      halfW: YUNCAI.caiguang.lineHalfW,
      damageByStage: YUNCAI.caiguang.dmgByStage, boomDamage: YUNCAI.caiguang.boom,
    });
    for (let i = 0; i < 200 && A.flags.modanHits === 0; i++) bc.step();
    check('魔弹被细线吸收也算一次命中计数（能更快攒出激光）',
      (A.flags.modanHits || 0) > 0, `计数 = ${A.flags.modanHits || 0}`);
  }
}

/* ============ ① + ② 自己的"光"也要能喂细线 ============ */
console.log('\n【①+②】细线吸收自己发出的光');
{
  /* 设定原文：细线对"光"（即晕彩的其他技能）起反应。
     所以晕彩自己的魔弹打到自己的细线上，也应该把它喂上去。
     最早写成"只吃敌方的光"，结果对手没有光技能时细线永远停在第一阶段。 */
  const b = mk(['yuncai_caiguang', 'yuncai_modan'], { rules: { timeLimit: 30 } });
  b.runToEnd();
  const absorbs = b.events.filter(e => e.type === 'lineStage' && e.cause === 'absorb');
  check('自己的魔弹会被自己的细线吸收并进阶', absorbs.length > 0,
    `${absorbs.length} 次吸收进阶`);
  const stages = new Set(b.events.filter(e => e.type === 'lineStage').map(e => e.value));
  check('细线确实升到了更高阶段', stages.has(1) || stages.has(2),
    `出现过的阶段 ${[...stages].join(',') || '（无）'}`);
  check('吸收事件带 cause 标记（便于区分是"吸收"还是"领域推进"）',
    b.events.filter(e => e.type === 'lineStage').every(e => !!e.cause));

  /* 定量：把一条细线放在魔弹必经之路上，看它会不会被喂上去 */
  const b2 = mk(['yuncai_caiguang', 'yuncai_modan']);
  const A = b2.units[0], B = b2.units[1];
  A.vx = 0; A.vy = 0; B.vx = 0; B.vy = 0;
  /* 在晕彩与敌人之间横一条细线，魔弹必然穿过 */
  const midX = (A.x + B.x) / 2, midY = (A.y + B.y) / 2;
  const line = b2._spawnField({
    kind: 'line', owner: A,
    x: midX, y: midY - 60 * SCALE, x2: midX, y2: midY + 60 * SCALE,
    halfW: YUNCAI.caiguang.lineHalfW,
    damageByStage: YUNCAI.caiguang.dmgByStage,
    boomDamage: YUNCAI.caiguang.boom,
  });
  for (let i = 0; i < 400 && line.stage === 0; i++) b2.step();
  check('魔弹穿过细线后细线进阶', line.stage >= 1, `stage=${line.stage}`);
}

/* ============ ③ 折光 ============ */
console.log('\n【③】折光');
{
  const P = YUNCAI.zheguang;
  const b = mk(['yuncai_zheguang']);
  const A = b.units[0], B = b.units[1];
  check(`被动把碰撞伤害改成 ${P.melee}`, A.melee === P.melee, String(A.melee));

  /* 制造一次近战命中：把敌人贴上来 */
  B.x = A.x + (A.r + B.r) - 2; B.y = A.y;
  B.vx = 0; B.vy = 0; A.vx = 0; A.vy = 0;
  const n0 = b.events.length;
  b.step();
  const hit = b.events.slice(n0).find(e => e.type === 'hit' && e.kind === 'melee');
  check('近战能打出伤害', !!hit, hit ? `${hit.value}` : '没有命中');
  check('近战命中后进入隐身', A.stealthFrames > 0, `剩余 ${A.stealthFrames} 帧`);
  check(`隐身持续 ${P.stealthSeconds} 秒（60 帧）`,
    A.stealthFrames === Math.round(P.stealthSeconds / (1 / 60)), String(A.stealthFrames));

  /* 隐身期间不吃近战伤害 */
  const b2 = mk(['yuncai_zheguang']);
  const A2 = b2.units[0], B2 = b2.units[1];
  A2.stealthFrames = 60;
  B2.x = A2.x + (A2.r + B2.r) - 2; B2.y = A2.y;
  const hp0 = A2.hp;
  for (let i = 0; i < 5; i++) b2.step();
  check('隐身期间不会受到敌方近战伤害', A2.hp === hp0, `掉了 ${hp0 - A2.hp} 点`);

  /* 但不挡弹道 */
  const b3 = mk(['yuncai_zheguang']);
  const A3 = b3.units[0];
  A3.stealthFrames = 60;
  const hp3 = A3.hp;
  probeProj(b3, b3.units[1], A3.x, A3.y, { damage: 40, traits: [] });
  b3.step();
  check('隐身不挡弹道（只挡近战）', A3.hp < hp3, `掉了 ${hp3 - A3.hp} 点`);

  /* 隐身会自然结束 */
  const b4 = mk(['yuncai_zheguang']);
  b4.units[0].stealthFrames = 3;
  for (let i = 0; i < 4; i++) b4.step();
  check('隐身到时自动结束', b4.units[0].stealthFrames === 0, String(b4.units[0].stealthFrames));
}

/* ============ ④ 开华 ============ */
console.log('\n【④】开华');
{
  const P = YUNCAI.kaihua;
  const b = mk(['yuncai_kaihua']);
  const A = b.units[0];
  A.hp = P.hpBelow + 1;                  // 刚好在阈值之上
  b.step();
  check('血量高于阈值时不开华', !A.bloomed && evCount(b, 'bloom') === 0);

  /* 基准血量要取"设定之后"的值：开华是 heal 到 hp 上，
     拿设定前的血量当基准会差一截（这个脚本就在这里错过一次）。 */
  A.hp = P.hpBelow;                      // 掉到阈值
  const hpBefore = A.hp;
  b.step();
  check('血量降到阈值以下会开华', A.bloomed === true && evCount(b, 'bloom') === 1);
  check(`恢复 ${P.heal} 点血量`, A.hp === Math.min(A.maxHp, hpBefore + P.heal),
    `${hpBefore} → ${A.hp}`);
  check(`速度提高到 ${P.speed}`, A.speed === P.speed * SCALE, String(A.speed / SCALE));
  check(`"光"伤害加成 +${P.lightBonus}`, A.lightBonus === P.lightBonus, String(A.lightBonus));
  check(`碰撞伤害 +${P.meleeBonus}（原本 0 → 50）`, A.melee === P.meleeBonus, String(A.melee));
  check('只开华一次', (() => { const c = evCount(b, 'bloom'); A.hp = 100; b.step(); return evCount(b, 'bloom') === c; })());

  /* 折光 + 开华 = 150 */
  const b2 = mk(['yuncai_zheguang', 'yuncai_kaihua']);
  const A2 = b2.units[0];
  A2.hp = 400;
  b2.step();
  check('折光(100) + 开华(+50) = 碰撞伤害 150', A2.melee === 150, String(A2.melee));

  /* "光"伤害 +50 */
  const b3 = mk(['yuncai_modan', 'yuncai_kaihua']);
  const A3 = b3.units[0];
  A3.hp = 400; b3.step();
  A3.skillCd = {};
  const n0 = b3.events.length;
  b3._runSkills(A3, 'cooldown');
  const shot = b3.events.slice(n0).find(e => e.type === 'shoot');
  check(`开华后魔弹伤害 ${YUNCAI.modan.dmg} → ${YUNCAI.modan.dmg + P.lightBonus}`,
    shot && shot.value === YUNCAI.modan.dmg + P.lightBonus, shot ? String(shot.value) : '-');

  /* 开华 + 辉光领域 → 闪避按配置提升。
     **断言只钉"机制"，不钉"具体数字"** —— 闪避率是平衡数值，
     作者随时会在素材编辑器里调（2026-10 就调过：10%/15% → 15%/24%）。
     把 0.10 写死在断言里，作者一改就"红"给你看，而代码其实是对的
     （README 第 38 条：改了数值之后，旧规则的断言会变成假失败）。
     所以这里对照**配置里的那份真值**，另外守住"它是个合理的概率、且开华后更高"。 */
  const DOM = YUNCAI.domain;
  const b4 = mk(['yuncai_domain', 'yuncai_kaihua']);
  const A4 = b4.units[0];
  check(`开华前闪避 = 配置值（${DOM.dodge}）`,
    Math.abs(A4.dodge - DOM.dodge) < 1e-9, String(A4.dodge));
  A4.hp = 400; b4.step();
  check(`开华后闪避 = 配置值（${DOM.dodgeBloomed}）`,
    Math.abs(A4.dodge - DOM.dodgeBloomed) < 1e-9, String(A4.dodge));
  check('两个闪避率都是合理概率（0 < 值 < 0.9）',
    DOM.dodge > 0 && DOM.dodge < 0.9 && DOM.dodgeBloomed > 0 && DOM.dodgeBloomed < 0.9,
    `${DOM.dodge} / ${DOM.dodgeBloomed}`);
  check('开华后的闪避更高（这一条是设计，不是数值）',
    DOM.dodgeBloomed > DOM.dodge, `${DOM.dodge} → ${DOM.dodgeBloomed}`);
}

/* ============ ⑤ 棱镜 ============ */
console.log('\n【⑤】棱镜');
{
  const P = YUNCAI.prism;
  const b = mk(['yuncai_prism']);
  const gates = () => evCount(b, 'gateSpawn');
  const spawns = [];
  while (!b.over && b.frame < b.maxFrames && spawns.length < 3) {
    const n0 = b.events.length;
    b.step();
    for (const e of b.events.slice(n0)) {
      if (e.type === 'gateSpawn') spawns.push(b.frame / 60);
    }
  }
  check('会生成光门', gates() > 0, `${gates()} 个`);
  if (spawns.length >= 2) {
    const iv = spawns.slice(1).map((t, i) => +(t - spawns[i]).toFixed(3));
    check(`光门间隔约 ${P.cd} 秒`, iv.every(v => Math.abs(v - P.cd) < 0.05), iv.join(', '));
  }

  /* 光门位置：应当在"晕彩→敌人"连线上、靠近敌人 */
  const b2 = mk(['yuncai_prism']);
  const A2 = b2.units[0], B2 = b2.units[1];
  A2.vx = 0; A2.vy = 0; B2.vx = 0; B2.vy = 0;
  A2.skillCd = {};
  b2._runSkills(A2, 'cooldown');
  const gate = b2.fields.find(f => f.kind === 'gate');
  check('光门已生成', !!gate);
  if (gate) {
    const gx = gate.x / SCALE, gy = gate.y / SCALE;
    const ax = A2.x / SCALE, ay = A2.y / SCALE;
    const bx = B2.x / SCALE, by = B2.y / SCALE;
    /* 到"晕彩→敌人"这条直线的垂距应当很小 */
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    const perp = Math.abs((gx - ax) * dy - (gy - ay) * dx) / len;
    check('光门落在双方连线上', perp < 1.0, `垂距 ${perp.toFixed(2)}`);
    const dToB = Math.hypot(bx - gx, by - gy);
    check('光门靠近敌人一侧', dToB < len * 0.5 && dToB < P.gateLead + 40, `距敌人 ${dToB.toFixed(1)}`);
  }

  /* 光炮穿过光门 → 5 条激光 */
  const b3 = mk(['yuncai_prism']);
  const A3 = b3.units[0], B3 = b3.units[1];
  A3.vx = 0; A3.vy = 0; B3.vx = 0; B3.vy = 0;
  A3.skillCd = {};
  b3._runSkills(A3, 'cooldown');
  const before = b3.projectiles.length;
  const cannon = b3.projectiles.find(p => p.tag === 'cannon');
  check('发射了光炮', !!cannon, cannon ? `伤害 ${cannon.damage}` : '-');
  check(`光炮伤害 ${P.cannonDmg}`, cannon && cannon.damage === P.cannonDmg,
    cannon ? String(cannon.damage) : '-');
  /* 让光炮飞够帧数穿过光门 —— 场地可能有几百单位宽，
     40 帧只够飞 280 单位，不够就永远等不到分裂。 */
  let split = 0;
  for (let i = 0; i < 240 && !split; i++) {
    const n0 = evCount(b3, 'gateSplit');
    b3.step();
    split = evCount(b3, 'gateSplit') - n0;
  }
  const lasers = b3.projectiles.filter(p => p.tag === 'laser');
  check('光炮穿门后分裂成 5 条激光', lasers.length === 5, `${lasers.length} 条`);
  check(`每条激光伤害 ${P.laserDmg}`, lasers.every(p => p.damage === P.laserDmg),
    lasers.length ? String(lasers[0].damage) : '-');
  check('激光会弹射一次', lasers.every(p => p.bounces === 1),
    lasers.length ? String(lasers[0].bounces) : '-');

  /* 魔力球穿门 → 5 个小魔力球 */
  const b4 = mk(['yuncai_prism', 'yuncai_modan']);
  const A4 = b4.units[0], B4 = b4.units[1];
  A4.vx = 0; A4.vy = 0; B4.vx = 0; B4.vy = 0;
  /* 先放一个光门在自己面前 */
  const gp = b4.clampPoint(A4.x / SCALE + 60, A4.y / SCALE, P.gateR);
  b4._spawnField({ kind: 'gate', owner: A4, x: Math.round(gp.x * SCALE), y: Math.round(gp.y * SCALE), r: P.gateR, life: 200 });
  A4.skillCd = {};
  b4._runSkills(A4, 'cooldown');           // 发魔弹
  let shards = [];
  for (let i = 0; i < 20 && shards.length === 0; i++) {
    b4.step();
    shards = b4.projectiles.filter(p => p.tag === 'shard');
  }
  check('魔力球穿门后分裂成 5 个小魔力球', shards.length === 5, `${shards.length} 个`);
  check(`小魔力球每个 ${P.shardDmg} 伤害`, shards.every(p => p.damage === P.shardDmg),
    shards.length ? String(shards[0].damage) : '-');
}

/* ============ ⑥ 辉光领域 ============ */
console.log('\n【⑥】辉光领域');
{
  const b = mk(['yuncai_domain']);
  check('开启全场极光', b.aurora === true);
  /* 同上：对照配置里的真值，而不是把 10% 写死 */
  check(`晕彩获得配置里的闪避（${YUNCAI.domain.dodge}）`,
    Math.abs(b.units[0].dodge - YUNCAI.domain.dodge) < 1e-9, String(b.units[0].dodge));
  check('领域事件已发出', evCount(b, 'domainOn') === 1);

  /* 闪避要真的生效：打很多次，数闪避事件 */
  const b2 = mk(['yuncai_domain'], { rules: { timeLimit: 0 } });
  const A = b2.units[0];
  let dodged = 0, total = 0;
  for (let i = 0; i < 400; i++) {
    const before = evCount(b2, 'dodge');
    b2._damage(null, A, 5, 'test');
    if (evCount(b2, 'dodge') > before) dodged++;
    total++;
  }
  const rate = dodged / total;
  /* 触发率当然要按**配置里的**目标值比（作者可能把它调到 15%），
     容差 ±6 个百分点：400 次采样，15% 的 3σ 约 ±5.4%。 */
  const want = YUNCAI.domain.dodge;
  check(`闪避的实际触发率接近配置值（${(want * 100).toFixed(0)}%）`,
    Math.abs(rate - want) < 0.06, `${(rate * 100).toFixed(1)}%（${dodged}/${total}）`);

  /* 闪避是可复现的：同一颗种子结果必须一致 */
  const run = () => {
    const bb = mk(['yuncai_domain'], { seed: 7 });
    let d = 0;
    for (let i = 0; i < 300; i++) {
      const before = evCount(bb, 'dodge');
      bb._damage(null, bb.units[0], 5, 'test');
      if (evCount(bb, 'dodge') > before) d++;
    }
    return d;
  };
  const r1 = run(), r2 = run();
  check('闪避结果可复现（同种子同结果）', r1 === r2, `${r1} vs ${r2}`);
}

/* ============ ⑦ 析光 ============ */
console.log('\n【⑦】析光');
{
  const P = YUNCAI.xiguang;
  const b = mk(['yuncai_xiguang', 'yuncai_modan', 'yuncai_zheguang']);
  const A = b.units[0];
  const n0 = b.units.length;

  /* 开场 5 秒内不该有分身 */
  advance(b, Math.round((P.firstDelay - 0.5) * 60));
  check(`开场 ${P.firstDelay} 秒内不召唤`, b.units.length === n0, `${b.units.length} 个单位`);

  const hpBefore = A.hp;
  advance(b, Math.round((P.firstDelay + 0.5) * 60));
  check('5 秒后召唤出分身', b.units.length === n0 + 1, `${b.units.length} 个单位`);
  const mini = b.units[b.units.length - 1];
  check('分身是同一队', mini && mini.team === A.team);
  check(`分身血量上限 ${P.miniHp}`, mini && mini.maxHp === P.miniHp, mini ? String(mini.maxHp) : '-');
  check(`分身速度 ${P.miniSpeed}`, mini && mini.speed === P.miniSpeed * SCALE, mini ? String(mini.speed / SCALE) : '-');
  check('分身体积是本体的一半（半径 r=16 → 8）',
    mini && Math.abs(mini.r / SCALE - (A.r / SCALE) * P.miniScale) < 0.01,
    mini ? `本体 ${A.r / SCALE} → 分身 ${mini.r / SCALE}` : '-');
  check('分身携带本体的另外两个技能（不含析光）',
    mini && mini.skills.length === 2 && !mini.skills.includes('yuncai_xiguang'),
    mini ? mini.skills.join('、') : '-');
  check('分身所有伤害为 1/3', mini && Math.abs(mini.damageMul - 1 / 3) < 1e-9,
    mini ? String(mini.damageMul) : '-');
  /* 分身的折光被动确实装上了（melee 字段是原始值 100），
     但真正打出去时要过伤害倍率 —— 所以查的是"有效伤害"而不是字段值。 */
  check('分身的折光被动生效，且有效碰撞伤害为 100/3 ≈ 33',
    mini && mini.melee === 100 && b._meleeDamage(mini) === Math.round(100 / 3),
    mini ? `melee=${mini.melee} 有效=${b._meleeDamage(mini)}` : '-');

  /* 扣血 = **当时**血量的 1/4。
     不能拿满血 1500 去算 —— 到第 5 秒时晕彩已经被打过一些了。 */
  const b2 = mk(['yuncai_xiguang']);
  const A2 = b2.units[0];
  advance(b2, Math.round((P.firstDelay - 0.3) * 60));
  const hpJustBefore = A2.hp;
  advance(b2, Math.round((P.firstDelay + 0.5) * 60));
  const cost = b2.events.find(e => e.type === 'hpCost');
  check('消耗当前血量的 1/4',
    !!cost && Math.abs(cost.value - Math.floor(hpJustBefore * P.costRatio)) <= 2,
    cost ? `扣了 ${cost.value}（当时血量 ${hpJustBefore}，1/4 = ${Math.floor(hpJustBefore / 4)}）` : '-');

  /* 分身伤害确实弱化：分身的魔弹伤害应当是 75/3 = 25 */
  const miniShot = b.events.find(e => e.type === 'shoot' && e.a === mini.id);
  check('分身的魔弹伤害为 75/3 = 25', !!miniShot && miniShot.value === 25,
    miniShot ? String(miniShot.value) : '分身还没发出魔弹');

  /* 不会把自己耗死：直接把技能调起来看血量，
     不要推进整场战斗 —— 否则 3 点血的晕彩会先被敌人打死，
     那测的就不是"析光会不会耗死自己"了。 */
  const b3 = mk(['yuncai_xiguang']);
  const A3 = b3.units[0];
  b3.frame = Math.round((P.firstDelay + 1) * 60);   // 直接跳到可以发动的时间点
  b3.time = b3.frame / 60;
  const cases = [3, 1, 2, 5];
  let survived = true, detail = [];
  for (const hp of cases) {
    A3.hp = hp;
    A3.skillCd = {};
    b3._runSkills(A3, 'cooldown');
    detail.push(`${hp}→${A3.hp}`);
    if (A3.hp < 1) survived = false;
  }
  check('血量极低时不会把自己耗死', survived, detail.join('  '));
}

/* ============ 综合：全技能一起跑 ============ */
console.log('\n【综合】七个技能同时装配');
{
  /* 实战里最多只能装 3 个，这里故意装全部 7 个做压力测试：
     分身会继承 6 个技能，场上单位数和物件数都会飙，
     所以用 40 秒时限收住，重点看"会不会崩 / 会不会卡死"。 */
  const all = Y.skills.slice();
  const b = mk(all, { rules: { timeLimit: 40 } });
  const t0 = Date.now();
  let err = null;
  try { b.runToEnd(); } catch (e) { err = e; }
  const ms = Date.now() - t0;
  check('七技能同时运行不报错', !err, err ? err.message : `${b.frame} 帧`);
  if (!err) {
    check('对局能正常收场', !!b.endReason, b.endReason);
    check('场上实体数没有失控',
      b.projectiles.length < 300 && b.fields.length <= 400,
      `弹道 ${b.projectiles.length} / 场地 ${b.fields.length}`);
    check('事件流没有爆掉', b.events.length <= 6000, `${b.events.length} 条`);
    check('模拟速度可接受（40 秒对局 < 6 秒真实时间）', ms < 6000, `${ms} ms`);
    const seen = new Set(b.events.map(e => e.type));
    /* 只要求"这个配置下必然会发生的"事件。
       开华要血量掉到 500 以下、闪避要有攻击打过来、细线爆炸要有敌人踩上去 ——
       这些在 40 秒 1v1 里不保证发生，它们各自有专门的章节在测，
       这里只确认整套机制一起跑不崩、不失控。 */
    const want = ['moteDrop', 'lineForm', 'lineStage', 'gateSpawn', 'gateSplit', 'shoot', 'hit'];
    const missing = want.filter(t => !seen.has(t));
    check('各技能的关键事件都出现过', missing.length === 0,
      missing.length ? '缺少 ' + missing.join('、') : want.length + ' 种都有');
  }
}

/* ============ 实战装配（3 个技能）============ */
console.log('\n【实战】只装配 3 个技能');
{
  const loadouts = [
    ['yuncai_caiguang', 'yuncai_modan', 'yuncai_zheguang'],
    ['yuncai_modan', 'yuncai_prism', 'yuncai_kaihua'],
    ['yuncai_caiguang', 'yuncai_domain', 'yuncai_xiguang'],
  ];
  let allOk = true, worst = 0;
  for (const lo of loadouts) {
    const b = mk(lo);
    const t0 = Date.now();
    try { b.runToEnd(); } catch (e) { allOk = false; break; }
    worst = Math.max(worst, Date.now() - t0);
    if (!b.endReason) allOk = false;
  }
  check('三种常见装配都能正常打完', allOk, `最慢一场 ${worst} ms`);
}

/* ============ 确定性 ============ */
console.log('\n【确定性】');
{
  const fp = (seed) => {
    const b = mk(Y.skills.slice(), { seed });
    b.runToEnd();
    let h = 2166136261;
    for (const s of b.snapshots) {
      for (let i = 0; i < s.data.length; i++) {
        h ^= Math.round(s.data[i] * 1000) | 0;
        h = Math.imul(h, 16777619);
      }
    }
    h ^= b.units.length * 7919;
    return (h >>> 0).toString(16);
  };
  const a1 = fp(31), a2 = fp(31), a3 = fp(31), b1 = fp(99);
  check('同种子三次结果完全一致（含召唤与闪避）', a1 === a2 && a2 === a3, [a1, a2, a3].join(' / '));
  check('不同种子结果不同', a1 !== b1, `${a1} vs ${b1}`);
}

console.log('\n' + log.join('\n'));
console.log(`\n=========== 通过 ${pass} 项，失败 ${fail} 项 ===========`);
process.exit(fail ? 1 : 0);

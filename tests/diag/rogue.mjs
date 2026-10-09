/* ============================================================
   tests/diag/rogue.mjs — 闯关肉鸽模式自检
   ------------------------------------------------------------
   分两段：
     A. 规则（纯逻辑，不需要浏览器）：难度公式、敌人凑分、抽签去重、
        光附魔解锁、通关奖励、最高记录；
     B. 真打一关（引擎）：BOSS 的"除帧伤外伤害 +50%"、技能伤害 +5、
        没绑按键的技能自动释放、玩家球的成长真的进了战斗配置。
   用法：node tests/diag/rogue.mjs
   ============================================================ */

import '../lib/test-balls.mjs';
import {
  SPECIES, SPECIES_BY_ID, PLAYABLE_SPECIES, DEFAULT_RULES, makeUnitStats, SCALE,
} from '../../js/balls.js';
import { getSkill } from '../../js/skills.js';
import { Battle, mulberry32, LIGHT_ENCHANT_BONUS } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import * as R from '../../js/rogue.js';

let pass = 0, fail = 0;
const log = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; log.push(`  ✅ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; log.push(`  ❌ ${name}${detail ? '  — ' + detail : ''}`); }
};

console.log('=========== 闯关肉鸽 · 自检 ===========\n');

/* 最高闯关数存在 localStorage 里：Node 里没有，补一个最小实现
   （没有它 recordLevel 会静默失败，测试就量不到"破纪录"这件事）。 */
if (typeof globalThis.localStorage === 'undefined') {
  const m = new Map();
  globalThis.localStorage = {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    clear: () => m.clear(),
  };
}

/* ============================================================
   A. 规则
   ============================================================ */
console.log('【A1】难度与关卡结构');
{
  check('第 1 关难度 1，每过一关 +1', R.difficultyOf(1) === 1 && R.difficultyOf(3) === 3 &&
    R.difficultyOf(4) === 4, `1→${R.difficultyOf(1)} 3→${R.difficultyOf(3)} 4→${R.difficultyOf(4)}`);
  check('通过 BOSS 关之后，难度额外 +2（第 6 关 = 8）',
    R.difficultyOf(6) === 8 && R.difficultyOf(11) === 15,
    `6→${R.difficultyOf(6)} 11→${R.difficultyOf(11)}`);
  check('每 5 关一次 BOSS', R.isBossLevel(5) && R.isBossLevel(10) && !R.isBossLevel(4) &&
    !R.isBossLevel(6));
  check('角色球难度分 = 1 + 技能数（3 个技能 → 4）',
    R.charDifficulty(3) === 4 && R.charDifficulty(4) === 5 && R.charDifficulty(5) === 6);

  /* 凑分：任何一关的敌人难度分总和都必须**正好等于**关卡难度 */
  let allExact = true, badAt = '';
  let bossHasChar = true, charTooEarly = false;
  for (let level = 1; level <= 20; level++) {
    for (let k = 0; k < 12; k++) {
      const spec = R.rollLevel(level, mulberry32(level * 100 + k));
      const sum = spec.enemies.reduce((s, e) => s + e.diff, 0);
      if (sum !== spec.difficulty) { allExact = false; badAt = `第 ${level} 关：${sum} ≠ ${spec.difficulty}`; }
      const chars = spec.enemies.filter(e => !SPECIES_BY_ID[e.speciesId].rogueOnly);
      if (spec.boss && !chars.some(e => e.boss)) { bossHasChar = false; badAt = `第 ${level} 关 BOSS 没有角色球`; }
      if (level < 5 && chars.length) { charTooEarly = true; badAt = `第 ${level} 关就出现了角色球`; }
      for (const e of spec.enemies) {
        if (SPECIES_BY_ID[e.speciesId].rogueOnly) continue;
        if (R.charDifficulty(e.skills.length) !== e.diff) {
          allExact = false; badAt = `角色球难度分不对：${e.skills.length} 技能 → ${e.diff}`;
        }
        if (e.skills.length < 3) { allExact = false; badAt = `角色球只有 ${e.skills.length} 个技能`; }
      }
    }
  }
  check('20 关 × 12 次抽样：敌人难度分总和 == 关卡难度', allExact, badAt || '全部吻合');
  check('BOSS 关必定有一个角色球（血量翻倍、除帧伤外伤害 ×1.5）', bossHasChar, badAt || '都满足');
  check('第 5 关之前不会出现角色球', !charTooEarly, charTooEarly ? badAt : '前 4 关只有小怪/精英');
  {
    const spec = R.rollLevel(5, mulberry32(5));
    const bossUnit = spec.enemies.find(e => e.boss);
    check('BOSS 的单位是"血量翻倍 + 伤害 ×1.5"',
      bossUnit && bossUnit.hpMul === 2 && bossUnit.atkMul === 1.5,
      bossUnit ? `hp×${bossUnit.hpMul} atk×${bossUnit.atkMul}` : '没找到 BOSS');
  }
  {
    /* 场地：形态随机、大小 = 1 + 0.1×敌人数 */
    const shapes = new Set();
    let scaleOk = true;
    for (let k = 0; k < 40; k++) {
      const spec = R.rollLevel(3 + k, mulberry32(900 + k));
      shapes.add(spec.arena.id);
      if (Math.abs(spec.sizeScale - R.arenaScaleFor(spec.enemies.length)) > 1e-9) scaleOk = false;
    }
    check('场地形态会随机（抽 40 次出现多种场地）', shapes.size > 2, [...shapes].join('、'));
    check('场地大小 = 1 + 0.1 × 敌人数', scaleOk,
      R.rollLevel(3, mulberry32(3)).sizeScale + '（2 个敌人）');
    check('随机到的场地都是"纯几何"场地（没有区域/收缩）',
      R.plainArenas().every(a => !(a.zones || []).length && !a.effects?.shrink));
  }
}

console.log('\n【A2】技能池与抽取');
{
  const pool = R.buildPool(['yuncai', 'taoyao', 'jianqing']);
  const want = ['yuncai', 'taoyao', 'jianqing']
    .reduce((s, id) => s + SPECIES_BY_ID[id].skills.length, 0);
  check('总技能池 = 三个球种技能之和（去重）', pool.length === want, `${pool.length} 个`);
  check('池子里没有重复', new Set(pool).size === pool.length);

  const d1 = R.rollDraw(pool, [], mulberry32(11));
  check('一手牌给 3 个技能 + 3 个属性选项',
    d1.cards.length === 3 && d1.stats.length === 3,
    `${d1.cards.length} 张 / ${d1.stats.length} 个属性`);
  check('属性选项就是"生命 / 移速 / 伤害"三选一',
    d1.stats.map(s => s.id).join(',') === 'hp,speed,dmg');
  check('抽到的技能都在池子里、且互不重复',
    d1.cards.every(c => pool.includes(c.id)) && new Set(d1.cards.map(c => c.id)).size === 3,
    d1.cards.map(c => c.name).join('、'));

  /* 抽签不能给已有的技能 */
  const owned = pool.slice(0, pool.length - 2);
  const d2 = R.rollDraw(pool, owned, mulberry32(12));
  check('已经拥有的技能不会再抽到',
    d2.cards.every(c => !owned.includes(c.id)),
    d2.cards.map(c => c.name).join('、'));
  const d3 = R.rollDraw(pool, pool.slice(), mulberry32(13));
  check('池子抽空时不硬凑技能卡（最多只剩"光附魔"那张）',
    d3.cards.filter(c => !c.isEnchant).length === 0,
    d3.cards.map(c => c.name).join('、') || '（空）');
}

console.log('\n【A3】光附魔');
{
  const yun = SPECIES_BY_ID.yuncai.skills;
  const pool = R.buildPool(['yuncai', 'tina']);
  check('晕彩技能没抽完时，光附魔不解锁', !R.lightEnchantReady(pool, []));
  check('抽完晕彩的技能后解锁',
    R.lightEnchantReady(pool, yun.slice()), `晕彩 ${yun.length} 个技能`);
  const d = R.rollDraw(pool, pool.filter(id => !yun.includes(id)).concat(yun.slice()),
    mulberry32(21));
  check('解锁后抽签里会出现「光附魔」这张卡（池子抽空时补位）',
    d.cards.some(c => c.isEnchant), d.cards.map(c => c.name).join('、') || '（空）');
  check('没选晕彩时永远不解锁', !R.lightEnchantReady(R.buildPool(['tina', 'taoyao']), []));
}

console.log('\n【A4】运行状态与奖励');
{
  const run = R.newRun(['yuncai', 'tina', 'jianqing']);
  check('开局：1500 血 / 120 速 / 伤害 +0 / 无技能',
    run.maxHp === 1500 && run.speed === 120 && run.bonusDmg === 0 && run.skills.length === 0,
    `${run.maxHp} 血 / ${run.speed} 速`);
  R.applyStatGain(run, 'hp');
  check('选"+150 生命"：上限与当前血都 +150',
    run.maxHp === 1650 && run.hp === 1650, `${run.hp}/${run.maxHp}`);
  R.applyStatGain(run, 'speed');
  R.applyStatGain(run, 'dmg');
  check('选"+10 移速 / +5 伤害"各自生效',
    run.speed === 130 && run.bonusDmg === 5, `${run.speed} 速 / +${run.bonusDmg}`);
  R.applyStatGain(run, 'all');
  check('BOSS 奖励"三样全给"（+150 血 / +10 速 / +5 伤害）一次到位',
    run.maxHp === 1800 && run.speed === 140 && run.bonusDmg === 10,
    `${run.maxHp} 血 / ${run.speed} 速 / +${run.bonusDmg}`);

  R._clearBest();
  check('初始最高记录为 0', R.getBestLevel() === 0);
  check('通关第 1 关记录为 1', R.recordLevel(1) === true && R.getBestLevel() === 1);
  check('没过记录时不改写', R.recordLevel(1) === false && R.getBestLevel() === 1);
  check('破了记录就更新', R.recordLevel(4) === true && R.getBestLevel() === 4);
  R._clearBest();
}

/* ============================================================
   B. 引擎：BOSS 的伤害加成 / 技能 +5 / 未绑键自动释放
   ============================================================ */
console.log('\n【B1】战斗配置与成长');
{
  const run = R.newRun(['yuncai']);
  run.skills = ['yuncai_modan', 'taotao_nonexistent'].filter(id => getSkill(id));
  run.skills = ['yuncai_modan', 'yuncai_prism', 'yuncai_xiguang', 'yuncai_zheguang'];
  run.maxHp = 1800; run.hp = 900; run.speed = 140; run.bonusDmg = 10;
  run.light = ['yuncai_modan'];
  const spec = R.rollLevel(5, mulberry32(5));
  const cfg = R.buildLevelConfig(run, spec);
  const hero = cfg.teams[0].units[0].stats;
  check('玩家球的血量/上限带进战斗（900/1800）',
    hero.hp === 900 && hero.maxHp === 1800, `${hero.hp}/${hero.maxHp}`);
  check('玩家球的移速与"碰撞 +5×2"都带进战斗',
    hero.speed === 140 && hero.melee === 50 + 10, `${hero.speed} 速 / 碰撞 ${hero.melee}`);
  check('技能伤害 +10 走 skillBonus（帧伤不吃）', hero.skillBonus === 10, String(hero.skillBonus));
  check('技能数量无上限（4 个技能全带上）', hero.skills.length === 4, hero.skills.join(','));
  check('光附魔列表带进战斗', hero.lightSkills && hero.lightSkills.includes('yuncai_modan'));
  check('规则：玩家操控 + 没有时间上限',
    cfg.rules.playerControl === true && cfg.rules.timeLimit === 0,
    `playerControl=${cfg.rules.playerControl} timeLimit=${cfg.rules.timeLimit}`);
  const boss = cfg.teams[1].units.find(u => u.stats.atkMul > 1);
  check('BOSS 单位的血量翻倍进了配置',
    !!boss && boss.stats.maxHp === SPECIES_BY_ID[boss.stats.speciesId].hp * 2,
    boss ? `${boss.stats.maxHp}` : '这一关没有 BOSS');
}

console.log('\n【B2】BOSS"除帧伤以外伤害 +50%"');
{
  const mk = (atkMul) => {
    const b = new Battle({
      teams: [
        { units: [{ stats: { ...makeUnitStats('yuncai', ['yuncai_modan']), atkMul } }] },
        { units: [{ stats: { ...makeUnitStats('dummy', []), maxHp: 100000, hp: 100000 } }] },
      ],
      arena: ARENA_BY_ID.rect, sizeScale: 1,
      rules: { ...DEFAULT_RULES, timeLimit: 0 }, seed: 4,
    });
    return b;
  };
  const norm = mk(1), boss = mk(1.5);
  const hpOf = b => b.units[1].hp;
  norm._damage(norm.units[0], norm.units[1], 100, 'skill');
  boss._damage(boss.units[0], boss.units[1], 100, 'skill');
  check('普通伤害：100 打 100', hpOf(norm) === 100000 - 100, String(100000 - hpOf(norm)));
  check('BOSS 伤害：100 → 150', hpOf(boss) === 100000 - 150, String(100000 - hpOf(boss)));
  /* 帧伤不吃 */
  const norm2 = mk(1), boss2 = mk(1.5);
  norm2._tickDamage(norm2.units[0], norm2.units[1], 10, 'zone', null);
  boss2._tickDamage(boss2.units[0], boss2.units[1], 10, 'zone', null);
  check('帧伤不吃 BOSS 加成（10 还是 10）',
    hpOf(norm2) === 100000 - 10 && hpOf(boss2) === 100000 - 10,
    `${100000 - hpOf(norm2)} / ${100000 - hpOf(boss2)}`);
}

console.log('\n【B3】技能伤害 +5（帧伤不受影响）');
{
  const mk = (skillBonus) => {
    const b = new Battle({
      teams: [
        { units: [{ stats: { ...makeUnitStats('yuncai', ['yuncai_modan']), skillBonus } }] },
        { units: [{ stats: { ...makeUnitStats('dummy', []), maxHp: 100000, hp: 100000 } }] },
      ],
      arena: ARENA_BY_ID.rect, sizeScale: 1,
      rules: { ...DEFAULT_RULES, timeLimit: 0 }, seed: 4,
    });
    return b;
  };
  const a = mk(0), c = mk(5);
  a._damage(a.units[0], a.units[1], 100, 'skill');
  c._damage(c.units[0], c.units[1], 100, 'skill');
  check('技能伤害 100 → 105', 100000 - hpOf(a) === 100 && 100000 - hpOf(c) === 105,
    `${100000 - hpOf(a)} / ${100000 - hpOf(c)}`);
  const a2 = mk(0), c2 = mk(5);
  a2._tickDamage(a2.units[0], a2.units[1], 10, 'zone', null);
  c2._tickDamage(c2.units[0], c2.units[1], 10, 'zone', null);
  check('帧伤 +5 不生效（10 还是 10）',
    100000 - hpOf(a2) === 10 && 100000 - hpOf(c2) === 10,
    `${100000 - hpOf(a2)} / ${100000 - hpOf(c2)}`);
  /* 碰撞伤害走的是 melee（在配置里就加过了），`skillBonus` 不该再叠一次 */
  const a3 = mk(5);
  a3._damage(a3.units[0], a3.units[1], 100, 'melee');
  check('碰撞伤害不被 skillBonus 重复加（100 还是 100）', 100000 - hpOf(a3) === 100,
    String(100000 - hpOf(a3)));
  function hpOf(b) { return b.units[1].hp; }
}

console.log('\n【B4】光附魔：该技能的攻击带"光"且 +50');
{
  const mk = (light) => {
    const b = new Battle({
      teams: [
        {
          units: [{
            stats: {
              /* 用桃夭的箭矢验"光"特质：它本来**不带** light（晕彩的魔弹自带光，
                 拿它验"附魔前后"是量不出差别的）。 */
              ...makeUnitStats('taoyao', ['taoyao_rong']),
              lightSkills: light ? ['taoyao_rong'] : null,
            },
          }],
        },
        { units: [{ stats: { ...makeUnitStats('dummy', []), maxHp: 100000, hp: 100000 } }] },
      ],
      arena: ARENA_BY_ID.rect, sizeScale: 1,
      rules: { ...DEFAULT_RULES, timeLimit: 0 }, seed: 4,
    });
    return b;
  };
  const plain = mk(false), lit = mk(true);
  plain.step({ dx: 0, dy: 0, fire: ['taoyao_rong'] });
  lit.step({ dx: 0, dy: 0, fire: ['taoyao_rong'] });
  const p1 = plain.projectiles.find(p => p.tag === 'arrow');
  const p2 = lit.projectiles.find(p => p.tag === 'arrow');
  check('被附魔的技能：弹道带上"光"特质', !!p2 && (p2.traits || []).includes('light'),
    p2 ? JSON.stringify(p2.traits) : '没发射');
  check('没附魔的技能：弹道不带"光"', !!p1 && !(p1.traits || []).includes('light'),
    p1 ? JSON.stringify(p1.traits) : '没发射');
  check(`附魔后伤害 +${LIGHT_ENCHANT_BONUS}`,
    !!p1 && !!p2 && p2.damage === p1.damage + LIGHT_ENCHANT_BONUS,
    `${p1 && p1.damage} → ${p2 && p2.damage}`);
  /* 一次性：附魔的临时加成不能漏到下一次别的技能上 */
  const b3 = mk(true);
  b3.step({ dx: 0, dy: 0, fire: ['taoyao_rong'] });
  check('附魔加成用完就清掉（不会漏给别的技能）',
    !b3.units[0].lightTemp, String(b3.units[0].lightTemp));
  /* 光附魔对"带光的技能"照样叠一层（魔弹本来就是光攻击） */
  const b4 = new Battle({
    teams: [
      {
        units: [{
          stats: {
            ...makeUnitStats('yuncai', ['yuncai_modan']),
            lightSkills: ['yuncai_modan'],
          },
        }],
      },
      { units: [{ stats: { ...makeUnitStats('dummy', []), maxHp: 100000, hp: 100000 } }] },
    ],
    arena: ARENA_BY_ID.rect, sizeScale: 1,
    rules: { ...DEFAULT_RULES, timeLimit: 0 }, seed: 4,
  });
  b4.step({ dx: 0, dy: 0, fire: ['yuncai_modan'] });
  const p4 = b4.projectiles.find(p => p.tag === 'modan');
  check(`本来就是光攻击的技能也会 +${LIGHT_ENCHANT_BONUS}（75 → 125）`,
    !!p4 && p4.damage === 75 + LIGHT_ENCHANT_BONUS, p4 ? String(p4.damage) : '没发射');
}

console.log('\n【B5】没绑按键的技能自动释放');
{
  const mk = (bound) => {
    const b = new Battle({
      teams: [
        { units: [{ stats: { ...makeUnitStats('yuncai', ['yuncai_modan', 'yuncai_prism']) } }] },
        { units: [{ stats: { ...makeUnitStats('dummy', []) } }] },
      ],
      arena: ARENA_BY_ID.rect, sizeScale: 1,
      rules: { ...DEFAULT_RULES, timeLimit: 0, playerControl: true },
      playerSlot: 0, seed: 4,
    });
    for (let i = 0; i < 60 * 5; i++) b.step({ dx: 0, dy: 0, fire: [], bound });
    return b;
  };
  const allBound = mk(['yuncai_modan', 'yuncai_prism']);
  const unbound = mk([]);
  const shots = b => b.events.filter(e => e.type === 'shoot').length;
  check('都绑了键、又没按 → 一发都不放', shots(allBound) === 0, `${shots(allBound)} 发`);
  check('没绑键的技能自动释放（交给 AI）', shots(unbound) > 0, `${shots(unbound)} 发`);
  const halfBound = (() => {
    const b = new Battle({
      teams: [
        { units: [{ stats: { ...makeUnitStats('yuncai', ['yuncai_modan', 'yuncai_prism']) } }] },
        { units: [{ stats: { ...makeUnitStats('dummy', []) } }] },
      ],
      arena: ARENA_BY_ID.rect, sizeScale: 1,
      rules: { ...DEFAULT_RULES, timeLimit: 0, playerControl: true },
      playerSlot: 0, seed: 4,
    });
    for (let i = 0; i < 60 * 5; i++) b.step({ dx: 0, dy: 0, fire: [], bound: ['yuncai_modan'] });
    return b;
  })();
  const tags = new Set(halfBound.events.filter(e => e.type === 'shoot').map(e => e.tag));
  check('只绑了一个：绑的那个等按键、没绑的那个自己放',
    !tags.has('modan') && tags.has('cannon'), [...tags].join('、') || '（没有弹道）');
}

console.log('\n' + log.join('\n'));
console.log(`\n=========== 通过 ${pass} 项，失败 ${fail} 项 ===========`);
if (fail) process.exitCode = 1;

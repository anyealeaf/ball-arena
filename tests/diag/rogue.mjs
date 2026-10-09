/* ============================================================
   tests/diag/rogue.mjs — 闯关肉鸽模式自检
   ------------------------------------------------------------
   分两段：
     A. 规则（纯逻辑，不需要浏览器）：难度公式、敌人凑分、抽签去重、
        光附魔解锁、通关奖励、最高记录；
     B. 真打一关（引擎）：BOSS 的"除帧伤外伤害 +50%"、技能伤害 +5、
        没绑按键的技能自动释放、玩家球的成长真的进了战斗配置；
     C. 敌人的攻击暗红化（引擎标记 + 渲染层真的用暗红画）；
     D. 实时模式的弹道贴图预热（开局把全集预热掉）；
     E. 玩家球继承技能自带的美术与资源条（弓 / 辉光领域 / 护盾条 / 魔力条）。
   用法：node tests/diag/rogue.mjs
   ============================================================ */

import '../lib/test-balls.mjs';
import {
  SPECIES, SPECIES_BY_ID, PLAYABLE_SPECIES, DEFAULT_RULES, makeUnitStats, SCALE,
} from '../../js/balls.js';
import { getSkill, projSpriteSrcs } from '../../js/skills.js';
import { Battle, mulberry32, LIGHT_ENCHANT_BONUS, PROJ_STRIDE, FIELD_STRIDE } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { Renderer, HOSTILE_COLOR, HOSTILE_SPRITE_FILTER, preloadSprites, stickerPaths } from '../../js/render.js';
import * as R from '../../js/rogue.js';

/** 记录型 2D 上下文：把每一次绘制调用记下来，便于断言"真的画成了什么颜色" */
function fakeCanvas() {
  const calls = [];
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'calls') return calls;
      if (prop === 'canvas') return { width: 720, height: 440, clientWidth: 720, clientHeight: 440 };
      if (prop === 'createRadialGradient' || prop === 'createLinearGradient') {
        return (...a) => { calls.push({ name: String(prop), a }); return { addColorStop() {} }; };
      }
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      // 属性赋值（fillStyle / filter / globalAlpha…）也记下来
      return (...a) => { calls.push({ name: String(prop), a }); };
    },
    set(_t, prop, value) {
      calls.push({ name: String(prop), value });
      /* fillStyle / strokeStyle 同时记在 fill / stroke 两个键上，
         这样断言"某个颜色被用过"不用猜是哪一类。 */
      if (prop === 'fillStyle') calls[calls.length - 1].fill = value;
      if (prop === 'strokeStyle') calls[calls.length - 1].stroke = value;
      return true;
    },
  });
  return {
    width: 720, height: 440, clientWidth: 720, clientHeight: 440,
    style: {},                 // Renderer.resize() 会往 style 上写尺寸
    getContext: () => ctx,
  };
}

/* 渲染层读 window.devicePixelRatio（这个测试没有浏览器环境，补一个最小值） */
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { devicePixelRatio: 1, performance: globalThis.performance };
}
/* 假的 Image：不装它的话贴图弹道整条分支会被跳过（渲染层"没加载好就宁可不画"），
   也就量不到"敌人的贴图被染成暗红"这件事。 */
if (typeof globalThis.Image === 'undefined') {
  globalThis.Image = class {
    constructor() { this.width = 64; this.height = 64; this.naturalWidth = 64; this.naturalHeight = 64; }
    set src(v) { this._src = v; if (this.onload) this.onload(); }
    get src() { return this._src; }
  };
}

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

console.log('\n【B6】敌人的攻击特效显示为暗红色');
{
  /* 引擎侧：敌人的单位带 hostileLook，它放出来的弹道 / 场地物件在快照里
     带"敌对"标记。渲染侧：程序化弹道换成暗红、贴图弹道用 filter 染成暗红。 */
  const cfg = R.buildLevelConfig(R.newRun(['yuncai']), R.rollLevel(1, mulberry32(3)));
  check('关卡里所有敌人单位都带 hostileLook',
    cfg.teams[1].units.every(u => u.stats.hostileLook === true),
    `${cfg.teams[1].units.length} 个敌人`);
  check('玩家球**不带** hostileLook（自己的攻击保留原色）',
    !cfg.teams[0].units[0].stats.hostileLook);

  const b = new Battle({ ...cfg, seed: 7, rules: { ...cfg.rules, playerControl: false } });
  const foe = b.units.find(u => u.hostileLook);
  check('引擎把 hostileLook 带到了单位上', !!foe, foe ? foe.name : '没有带标记的单位');
  if (foe) {
    /* 直接放一发（不走冷却），确认它进快照时带标记 */
    const target = b.units[0];
    b._spawnProjectile({
      kind: 'aura', tag: 'npc_bolt', owner: foe,
      x: foe.x, y: foe.y, vx: 400 * SCALE / SCALE * SCALE, vy: 0,
      damage: 50, radius: Math.round(5 * SCALE), life: 4, color: '#c084fc',
    });
    b._spawnField({
      kind: 'mote', owner: foe, x: foe.x, y: foe.y, r: 3, life: 130,
    });
    b.step();
    const snap = b.snapshots[b.snapshots.length - 1];
    const n = snap.proj.length / PROJ_STRIDE;
    let marked = 0;
    for (let i = 0; i < n; i++) if (snap.proj[i * PROJ_STRIDE + 11] > 0.5) marked++;
    check('敌人放出的弹道在快照里带"敌对"标记', marked > 0, `${marked} / ${n} 枚`);
    const fn = snap.fields.length / FIELD_STRIDE;
    let fmarked = 0;
    for (let i = 0; i < fn; i++) if (snap.fields[i * FIELD_STRIDE + 9] > 0.5) fmarked++;
    check('敌人放出的场地物件（质点/细线/光门）也带"敌对"标记', fmarked > 0,
      `${fmarked} / ${fn} 个`);
    /* 玩家自己的弹道不该被误标 */
    const mine = b.units.find(u => !u.hostileLook);
    b._spawnProjectile({
      kind: 'aura', tag: 'modan', owner: mine,
      x: mine.x, y: mine.y, vx: 500 * SCALE, vy: 0,
      damage: 75, radius: Math.round(6 * SCALE), life: 4, color: '#5b21b6',
    });
    b.step();
    const snap2 = b.snapshots[b.snapshots.length - 1];
    const n2 = snap2.proj.length / PROJ_STRIDE;
    let mineMarked = 0;
    for (let i = 0; i < n2; i++) if (snap2.proj[i * PROJ_STRIDE + 11] > 0.5) mineMarked++;
    check('玩家自己的弹道不会被标成敌对（标记是按"谁放的"来的）',
      mineMarked === marked, `敌方 ${marked} / 全部 ${mineMarked}`);
  }

  /* 渲染侧：拿记录型上下文看"真的画成了暗红" */
  const rcfg = R.buildLevelConfig(R.newRun(['yuncai']), R.rollLevel(1, mulberry32(3)));
  const rb = new Battle({ ...rcfg, seed: 7, rules: { ...rcfg.rules, playerControl: false } });
  const rfoe = rb.units.find(u => u.hostileLook);
  rb._spawnProjectile({
    kind: 'aura', tag: 'npc_bolt', owner: rfoe,
    x: rfoe.x, y: rfoe.y, vx: 400 * SCALE, vy: 0,
    damage: 50, radius: Math.round(5 * SCALE), life: 4, color: '#c084fc',
  });
  rb.step();
  const rd = new Renderer(fakeCanvas());
  const ctx = rd.ctx;
  ctx.calls = [];
  rd.draw(rb, rb.snapshots.length - 1);
  const hostileStrokes = ctx.calls.filter(c =>
    (c.fill === HOSTILE_COLOR || c.stroke === HOSTILE_COLOR)).length;
  check(`敌人的程序化弹道用暗红 ${HOSTILE_COLOR} 画（不再用技能原本的紫色）`,
    hostileStrokes > 0, `${hostileStrokes} 笔暗红`);
  /* 贴图弹道：拿一个挂了贴图的敌人弹道，确认绘制时上了 filter */
  const rfoe2 = rb.units.find(u => u.hostileLook);
  rb._spawnProjectile({
    kind: 'aura', tag: 'bat', owner: rfoe2,
    x: rfoe2.x, y: rfoe2.y, vx: 200 * SCALE, vy: 0,
    damage: 6, radius: Math.round(4 * SCALE), life: 4, color: '#a21caf',
    sprite: 'assets/characters/tina_bat.png', spriteLen: 8.5, spriteGlow: '#dc2626',
  });
  rb.step();
  ctx.calls = [];
  rd.draw(rb, rb.snapshots.length - 1);
  const filters = ctx.calls.filter(c => c.name === 'filter' && c.value === HOSTILE_SPRITE_FILTER);
  check('敌人的**贴图**弹道会被染成暗红（canvas filter）', filters.length > 0,
    `${filters.length} 次 filter`);
  /* 反过来：玩家自己的**贴图**弹道不该被染 */
  {
    const cfg2 = R.buildLevelConfig(R.newRun(['yuncai']), R.rollLevel(1, mulberry32(3)));
    const b2 = new Battle({ ...cfg2, seed: 9, rules: { ...cfg2.rules, playerControl: false } });
    const hero = b2.units[0];
    b2._spawnProjectile({
      kind: 'aura', tag: 'modan', owner: hero,
      x: hero.x, y: hero.y, vx: 500 * SCALE, vy: 0,
      damage: 75, radius: Math.round(6 * SCALE), life: 4, color: '#5b21b6',
      sprite: 'assets/characters/yuncai_bolt.png', spriteLen: 12, spriteGlow: '#c084fc',
    });
    b2.step();
    const rd2 = new Renderer(fakeCanvas());
    rd2.ctx.calls = [];
    rd2.draw(b2, b2.snapshots.length - 1);
    const bad = rd2.ctx.calls.filter(c => c.name === 'filter' && c.value === HOSTILE_SPRITE_FILTER);
    check('玩家自己的贴图弹道不会被染成暗红', bad.length === 0, `${bad.length} 次 filter`);
  }
}

/* ============================================================
   D. 实时模式的弹道贴图预热
   ------------------------------------------------------------
   实时模式（闯关是实时的）开战那一刻还没有任何弹道，"调色板长出来再补"
   必然晚一帧 —— 而渲染层对没就绪的贴图是"宁可不画"，那一帧就是空的
   （现象 = "第一发没有特效"）。所以开局要扫技能参数表把全集预热掉。
   ============================================================ */
console.log('\n【D】实时模式：开局就把弹道贴图预热掉');
{
  const srcs = projSpriteSrcs();
  check('扫技能参数表能拿到弹道贴图清单（不是手写的一份）',
    srcs.length >= 4, `${srcs.length} 张：${srcs.join(' / ').slice(0, 90)}`);
  for (const p of ['assets/characters/yuncai_bolt.png', 'assets/characters/taoyao_arrow.png',
    'assets/characters/tina_bat.png']) {
    check(`清单里有 ${p}`, srcs.includes(p));
  }
  /* preloadSprites 走的就是渲染层的贴图缓存（getSticker）：登记过 = 已经在加载 */
  const before = stickerPaths().length;
  preloadSprites(srcs);
  const after = stickerPaths();
  check('preloadSprites 之后，这些贴图都进了缓存（= 已经在加载）',
    srcs.every(s => after.includes(s)),
    `缓存 ${before} → ${after.length} 张，清单 ${srcs.length} 张`);
}

/* ============================================================
   E. 玩家球"继承"技能自带的美术与资源条
   ------------------------------------------------------------
   作者报的"闯关里有部分特效丢失"根因之一：玩家球是一颗**技能池宿主**，
   球种上什么美术/资源都没有（hero 的 bow / domain / resource 全是 null），
   而技能带来的不只是机制 —— 桃夭的映霞要靠弓画拉弓与搭箭（箭长按弓估）、
   晕彩的辉光领域要靠 domain 拿背景层、见晴的护盾与缇娜的魔力是资源条。
   少了这些，机制照跑但**画面上什么都没有**。
   ============================================================ */
console.log('\n【E】玩家球继承技能自带的美术与资源条');
{
  const mkHero = (skills) => {
    const run = R.newRun(['yuncai']);
    run.skills = skills.slice();
    const spec = R.rollLevel(1, mulberry32(1));
    const cfg = R.buildLevelConfig(run, spec);
    return cfg.teams[0].units[0].stats;
  };
  const taoyao = SPECIES_BY_ID.taoyao;
  const yuncaiSp = SPECIES_BY_ID.yuncai;
  const jianqing = SPECIES_BY_ID.jianqing;
  const tina = SPECIES_BY_ID.tina;

  check('抽到桃夭的箭 → 玩家球拿到弓（拉弓动作与箭长都要它）',
    (() => { const s = mkHero(['taoyao_rong']); return !!s.bow && s.bow === taoyao.bow; })());
  check('抽到晕彩的辉光领域 → 玩家球拿到领域背景层配置',
    (() => { const s = mkHero(['yuncai_domain']); return !!s.domain; })());
  check('抽到见晴① → 玩家球拿到水镜护盾条（上限 300）',
    (() => { const s = mkHero(['jianqing_mirror_def']); return s.resource && s.resource.id === 'mirror' && s.resource.max === 300; })(),
    (mkHero(['jianqing_mirror_def']).resource || {}).id || '没有资源条');
  check('抽到缇娜② → 玩家球拿到魔力条（上限 5，偷学才可能触发）',
    (() => { const s = mkHero(['tina_bat']); return s.resource && s.resource.id === 'mana' && s.resource.max === 5; })());
  check('没抽到要用资源的技能就不乱挂资源条（见晴④ 不需要护盾条）',
    (() => { const s = mkHero(['jianqing_takeoff']); return !s.resource; })());
  check('两个球种的资源技能都抽到时，按抽取顺序先到先得（一条资源条）',
    (() => {
      const a = mkHero(['tina_bat', 'jianqing_mirror_def']).resource;
      const b = mkHero(['jianqing_mirror_def', 'tina_bat']).resource;
      return a.id === 'mana' && b.id === 'mirror';
    })(),
    (() => `${mkHero(['tina_bat', 'jianqing_mirror_def']).resource.id} / ${mkHero(['jianqing_mirror_def', 'tina_bat']).resource.id}`)());
  check('继承的弓 / 领域 / 护盾条都是"原球种那一份"（不复制出新对象）',
    mkHero(['taoyao_rong']).bow === taoyao.bow &&
    mkHero(['yuncai_domain']).domain === yuncaiSp.domain &&
    mkHero(['jianqing_mirror_def']).resource.max === jianqing.resource.max &&
    mkHero(['tina_bat']).resource.max === tina.resource.max);

  /* 真打一关：这些字段要真的生效（不是只挂在配置上） */
  {
    const run = R.newRun(['yuncai', 'taoyao', 'jianqing']);
    run.skills = ['taoyao_rong', 'yuncai_domain', 'jianqing_mirror_def'];
    const b = new Battle({
      ...R.buildLevelConfig(run, R.rollLevel(1, mulberry32(2))),
      seed: 5, rules: { ...R.buildLevelConfig(run, R.rollLevel(1, mulberry32(2))).rules, playerControl: false },
    });
    const hero = b.units[0];
    check('辉光领域真的开始展开（auroraStyle 不为空，渲染层才会画极光）',
      !!b.auroraStyle, b.auroraStyle ? '有背景层配置' : '没有（画不出一层）');
    check('水镜护盾条能吃资源（_gainResource 不再是 0）',
      b._gainResource(hero, 40) === 40 && hero.res === 40, `res=${hero.res}`);
    /* 箭长：有弓时按"弓高 × 箭长比例"算，不是渲染层的兜底值 */
    run.skills = ['taoyao_rong'];
    const b2 = new Battle({
      ...R.buildLevelConfig(run, R.rollLevel(1, mulberry32(2))),
      seed: 6, rules: { ...R.buildLevelConfig(run, R.rollLevel(1, mulberry32(2))).rules, playerControl: false },
    });
    b2.units[0].skillCd.taoyao_rong = 0;
    for (let i = 0; i < 400 && !b2.projectiles.some(p => p.tag === 'arrow'); i++) b2.step();
    const arrow = b2.projectiles.find(p => p.tag === 'arrow');
    const sprEntry = arrow ? (b2.projSpritePalette[arrow.spriteIdx] || null) : null;
    const art = SPECIES_BY_ID.taoyao.bow.arts[0] || SPECIES_BY_ID.taoyao.bow;
    check('玩家球射出的箭长度按弓算（不是 0，也不是渲染层兜底的 r×6）',
      !!sprEntry && Math.abs(sprEntry.len - art.bowH * art.arrowLenFrac) < 0.6,
      sprEntry ? `len=${sprEntry.len}（弓算出来 ${(art.bowH * art.arrowLenFrac).toFixed(1)}）` : '没有箭');
  }
}

console.log('\n' + log.join('\n'));
console.log(`\n=========== 通过 ${pass} 项，失败 ${fail} 项 ===========`);
if (fail) process.exitCode = 1;

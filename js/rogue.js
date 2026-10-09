/* ============================================================
   rogue.js — 闯关肉鸽模式的**纯逻辑**（无 DOM、无渲染）
   ------------------------------------------------------------
   作者 2026-10 的规格（逐条落在下面的函数上）：

   · 基础小球：1500 血 / 中型（r=16）/ 移速 120 / 碰撞 50，默认玩家操控；
   · 开局选三个已有小球，把它们**全部技能**并成"总技能池"；
   · 两次技能抽取开局；每次抽 3 个（每个可重抽一次），
     也可以不要技能、改成"提高基础属性"（+150 血 / +10 速 / +5 伤害）；
   · 玩家球技能数量**无上限**，没绑按键的技能自动释放；
   · 晕彩的技能被抽完之后，池子里会出现「光附魔」——
     选它以后再选一个已有技能，那个技能的攻击也带上"光"；
   · 每过一关回 250 血并再抽一次；BOSS 关**完全回血** + 额外一次三样全给；
   · 敌人按**难度分**凑：第 1 关难度 1，每过一关 +1，过 BOSS 关额外 +2；
     每 5 关一次 BOSS（必出一个角色球，血量翻倍、除帧伤外伤害 +50%）；
     角色球从第 5 关开始出现，默认 3 个随机技能（难度 4），每多一个技能 +1；
   · 每一关场地形态随机；每有一个敌人，场地大小 +10%；
   · 记录最高闯关数。

   为什么要单独一个文件：这一层是**可以单独测的规则**（难度公式、凑分、
   抽签去重…），界面只是把它画出来。放界面里写就会变成"只能在浏览器里验"。
   ============================================================ */

import {
  SPECIES, SPECIES_BY_ID, makeUnitStats, teamColor, DEFAULT_RULES,
} from './balls.js';
import { getSkill, resolveLoadout } from './skills.js';
import { ARENAS } from './arenas.js';

/* ---------- 玩家球 ---------- */
/** 作者给的初始数值（"1500血量，体型为中，移速120，碰撞伤害50"）。 */
export const HERO_ID = 'hero';
export const HERO_BASE = { hp: 1500, r: 16, speed: 120, melee: 50 };

/** 体型三档（与木桩一致的一套口径；写在这里方便界面显示"小型/中型/大型"）。 */
export const SIZE_NAME = { 12: '小型', 16: '中型', 30: '大型' };
export function sizeName(speciesId) {
  const sp = SPECIES_BY_ID[speciesId];
  return (sp && SIZE_NAME[sp.r]) || '—';
}

/* ---------- 属性提升 ---------- */
/** 每次抽取都可以"不要技能，改要属性"。BOSS 关通关额外给一次**三样全给**。 */
export const STAT_GAIN = { hp: 150, speed: 10, dmg: 5 };
export const STAT_CHOICES = [
  { id: 'hp', label: `生命 +${STAT_GAIN.hp}`, short: '生命' },
  { id: 'speed', label: `移速 +${STAT_GAIN.speed}`, short: '移速' },
  { id: 'dmg', label: `技能与碰撞伤害 +${STAT_GAIN.dmg}`, short: '伤害' },
];
export const BOSS_BONUS_CHOICE = {
  id: 'all',
  label: `生命 +${STAT_GAIN.hp} / 移速 +${STAT_GAIN.speed} / 伤害 +${STAT_GAIN.dmg}`,
  short: '三样全给',
};

/** 把一项属性加成加到运行状态上（纯函数式地改传进来的对象）。 */
export function applyStatGain(run, id) {
  const ids = id === 'all' ? ['hp', 'speed', 'dmg'] : [id];
  for (const k of ids) {
    if (k === 'hp') { run.maxHp += STAT_GAIN.hp; run.hp += STAT_GAIN.hp; }
    else if (k === 'speed') run.speed += STAT_GAIN.speed;
    else if (k === 'dmg') run.bonusDmg += STAT_GAIN.dmg;
  }
  return run;
}

/* ---------- 难度 ---------- */
/** 第 level 关的难度分：第 1 关 1，每过一关 +1，通过 BOSS 关额外 +2。 */
export function difficultyOf(level) {
  return level + 2 * Math.floor((level - 1) / 5);
}
/** 每 5 关一次 BOSS（第 5、10、15…关）。 */
export function isBossLevel(level) {
  return level % 5 === 0;
}
/** 角色球占多少难度分：默认 3 个技能 = 4 分，每多一个技能 +1（作者口径）。 */
export function charDifficulty(skillCount) {
  return 1 + skillCount;
}
/** 关卡里允许给角色球塞几个技能：预算够就一直加（BOSS 关至少 3 个）。 */
export function maxCharSkills(difficulty) {
  return Math.max(3, Math.min(6, difficulty - 1));
}

/* ---------- 敌人池 ---------- */
/** 关卡专用敌人（NPC11…NPC23），按难度分分组。 */
export function npcPool() {
  return SPECIES.filter(s => s.rogueOnly && s.rogue && !s.rogue.isHero && s.id.startsWith('npc'));
}
/** 能当 BOSS / 关底角色的小球：正式角色（有技能的球种）。 */
export function characterPool() {
  return SPECIES.filter(s => !s.rogueOnly && s.skills && s.skills.length >= 3);
}

/* ---------- 场地 ---------- */
/** 只有几何形态、没有任何区域/特效的场地 —— 关卡随机在这些里挑。 */
export function plainArenas() {
  return ARENAS.filter(a => !a.zones?.length
    && !a.effects?.shrink && !a.effects?.rotationSpeedDeg);
}
/** 场地大小：**每有一个敌人拉高 10%**（作者规格）。 */
export function arenaScaleFor(enemyCount) {
  return Math.round((1 + 0.1 * enemyCount) * 100) / 100;
}

/* ---------- 抽签 ---------- */
const pick = (arr, rnd) => arr[Math.floor(rnd() * arr.length) % arr.length];
function pickN(arr, n, rnd) {
  const pool = arr.slice();
  const out = [];
  while (out.length < n && pool.length) {
    out.push(pool.splice(Math.floor(rnd() * pool.length) % pool.length, 1)[0]);
  }
  return out;
}

/** 一局的"总技能池"：三个球种的技能并起来（去掉重复的 id）。 */
export function buildPool(speciesIds) {
  const out = [];
  for (const id of speciesIds) {
    const sp = SPECIES_BY_ID[id];
    if (!sp) continue;
    for (const sk of sp.skills || []) if (!out.includes(sk)) out.push(sk);
  }
  return out;
}

/** 晕彩的技能是否已经被抽完（抽完才解锁「光附魔」）。 */
export function lightEnchantReady(pool, owned) {
  const yun = (SPECIES_BY_ID.yuncai && SPECIES_BY_ID.yuncai.skills) || [];
  const inPool = yun.filter(id => pool.includes(id));
  if (!inPool.length) return false;
  return inPool.every(id => owned.includes(id));
}

/** 「光附魔」在抽签里长这样（它不是一个真技能，所以用一张"虚拟卡"表示）。 */
export const LIGHT_ENCHANT_CARD = {
  id: '__light__',
  name: '光附魔',
  desc: '选择一个已有的技能，让它的攻击也附带"光"属性。',
  descDetail: '选一个你已经拥有的技能：它的攻击伤害 +50（与开华的"光"加成同一套），' +
    '并且弹道带上"光"特质（能被裁光的细线吸收、喂光）。',
  isEnchant: true,
};

/**
 * 抽一手牌：n 个技能卡（从池子里抽**还没拥有**的）+ 三个属性选项。
 * 池子抽空时会给"光附魔"（如果解锁了）或者少给几张（界面照实显示）。
 */
export function rollDraw(pool, owned, rnd, n = 3) {
  const left = pool.filter(id => !owned.includes(id));
  const cards = pickN(left, n, rnd).map(id => {
    const sk = getSkill(id) || { id, name: id };
    return { id, name: sk.name, desc: sk.desc, descDetail: sk.descDetail };
  });
  if (cards.length < n && lightEnchantReady(pool, owned) && !owned.includes(LIGHT_ENCHANT_CARD.id)) {
    cards.push(LIGHT_ENCHANT_CARD);
  }
  return { cards, stats: STAT_CHOICES.slice() };
}

/* ---------- 敌人编成 ---------- */
/**
 * 按难度分凑一关的敌人（作者规格：敌人难度分总和 == 关卡难度）。
 * BOSS 关**必定**有一个角色球（血量翻倍、除帧伤外伤害 +50%）。
 * 返回 [{ speciesId, skills, hpMul, atkMul, name, diff }]。
 */
export function rollEnemies(level, rnd) {
  const npcs = npcPool();
  const chars = characterPool();
  const boss = isBossLevel(level);
  let budget = difficultyOf(level);
  const out = [];

  const addChar = (bossUnit) => {
    if (!chars.length) return false;
    const sp = pick(chars, rnd);
    const maxSkills = Math.min(maxCharSkills(budget), (sp.skills || []).length);
    const wanted = Math.max(3, Math.min(maxSkills, 3 + Math.floor(rnd() * 2)));
    const skills = pickN(sp.skills || [], wanted, rnd);
    const diff = charDifficulty(skills.length);
    if (diff > budget) return false;
    budget -= diff;
    out.push({
      speciesId: sp.id,
      skills,
      hpMul: bossUnit ? 2 : 1,
      atkMul: bossUnit ? 1.5 : 1,
      boss: !!bossUnit,
      diff,
    });
    return true;
  };

  /* BOSS 关：先把角色球塞进去（它必须出现） */
  if (boss) {
    if (!addChar(true)) {
      /* 理论上不会发生（BOSS 关难度 ≥ 5，角色球最少 4 分）；
         真发生了就退回一个精英，至少别把这一关变成空的。 */
      const elite = npcs.filter(s => s.rogue.diff === 2);
      if (elite.length) { out.push({ speciesId: pick(elite, rnd).id, skills: [], hpMul: 2, atkMul: 1.5, boss: true, diff: 2 }); budget -= 2; }
    }
  } else if (level >= 5 && chars.length && rnd() < 0.5) {
    /* 第 5 关开始，角色球也会作为普通敌人出现（预算够就行） */
    addChar(false);
  }

  /* 剩下的预算用 NPC 填满：1 分与 2 分各占一半概率 */
  let guard = 0;
  while (budget > 0 && guard++ < 60) {
    const two = npcs.filter(s => s.rogue.diff === 2);
    const one = npcs.filter(s => s.rogue.diff === 1);
    const useTwo = budget >= 2 && two.length && rnd() < 0.45;
    const sp = useTwo ? pick(two, rnd) : (one.length ? pick(one, rnd) : pick(two, rnd));
    if (!sp) break;
    budget -= sp.rogue.diff;
    out.push({ speciesId: sp.id, skills: [], hpMul: 1, atkMul: 1, boss: false, diff: sp.rogue.diff });
  }
  return out;
}

/** 一关的完整描述（敌人 + 场地 + 大小 + 是否 BOSS） */
export function rollLevel(level, rnd) {
  const enemies = rollEnemies(level, rnd);
  const arenas = plainArenas();
  const arena = arenas.length ? pick(arenas, rnd) : ARENAS[0];
  return {
    level,
    difficulty: difficultyOf(level),
    boss: isBossLevel(level),
    enemies,
    arena,
    sizeScale: arenaScaleFor(enemies.length),
  };
}

/* ---------- 运行状态 ---------- */
/** 开一局：基础小球 + 总技能池（抽取本身由界面驱动）。 */
export function newRun(speciesIds) {
  return {
    speciesIds: speciesIds.slice(),
    pool: buildPool(speciesIds),
    level: 1,
    hp: HERO_BASE.hp,
    maxHp: HERO_BASE.hp,
    speed: HERO_BASE.speed,
    bonusDmg: 0,
    skills: [],
    light: [],            // 被光附魔的技能 id
    log: [],              // 每关一句话，用来做"闯关记录"
  };
}

/** 已经用掉的属性加成（界面显示用） */
export function statSummary(run) {
  return [
    `生命 ${run.maxHp}`,
    `移速 ${run.speed}`,
    `伤害 +${run.bonusDmg}`,
  ];
}

/* ---------- 玩家球"继承"技能自带的美术与资源条 ----------
   玩家球是一颗**技能池宿主**：它自己什么美术都没有（`hero` 球种的
   sticker / bow / domain / resource 全是 null），而技能带来的一般不只是机制 ——
   桃夭的映霞要靠**弓**画拉弓与搭箭（箭长也是按弓估的）、
   晕彩的辉光领域要靠 `domain` 拿背景层图片、见晴的护盾与缇娜的魔力是**资源条**。
   这些字段在正常球种上由 `makeUnitStats` 从 species 抄过来，玩家球身上就是空的，
   于是抽到这些技能时会出现"机制在跑、画面什么都没有"：

     · 拉弓两帧 / 搭在弓上的箭 / 五连发扇形**一样都不画**（渲染层没有 bow 直接返回），
       箭长还会算成 0 → 渲染层按兜底尺寸画，比例与偏移都不对；
     · 辉光领域只剩那点闪避，展开气浪与极光层一点都不画；
     · 水镜护盾永远攒不起来（连护盾条都不画）；蝙蝠回身加的魔力永远是 0，
       "偷学"一次都不会触发。

   规则：**按"抽到的技能属于哪个球种"把这些字段补上**。
   为什么可以无脑补（不怕补了用不上）：
     · 弓只在 `castP > 0`（正在拉弓）时才画 —— 没装映霞的球拿到弓也不会举着它；
     · 领域背景只在「辉光领域」真的装在身上时才展开（技能自己开的开关）；
     · 资源条只有一个槽位，所以**先抽到的那个球种的资源条生效**（见下面的说明）。 */
const INHERIT_FIELDS = ['bow', 'domain', 'stickerBloom'];

/** 某个技能是哪个球种的（技能表里有它的第一个球种） */
function speciesOwningSkill(skillId) {
  return SPECIES.find(s => (s.skills || []).includes(skillId)) || null;
}

/** 把技能自带的美术 / 资源条补给这个单位的初始数值（就地改 st） */
export function inheritSkillArt(st, skillIds) {
  const ids = skillIds || [];
  for (const id of ids) {
    const owner = speciesOwningSkill(id);
    if (!owner) continue;
    for (const f of INHERIT_FIELDS) if (!st[f] && owner[f]) st[f] = owner[f];
  }
  /* 资源条：只认**声明了要用它**的技能（skills.js 的 usesResource）——
     否则抽到见晴的④起飞也会给他挂一条永远为 0 的护盾条。
     两个球种的资源条都要用时只可能生效一个（引擎每个单位只有一条资源），
     按**抽取顺序**先到先得；要"两条同时显示"得改引擎（不止一条资源条）。 */
  if (!st.resource) {
    for (const id of ids) {
      const sk = getSkill(id);
      const rid = sk && sk.usesResource;
      if (!rid) continue;
      const owner = SPECIES.find(s => s.resource && s.resource.id === rid);
      if (owner) {
        st.resource = { ...owner.resource, value: owner.resource.init || 0 };
        break;
      }
    }
  }
  return st;
}

/**
 * 由运行状态 + 关卡描述生成战斗配置。
 * 玩家球：血量/移速/碰撞伤害都带上成长；技能是"已获得的全部技能"（无上限）。
 * 碰撞与技能伤害的 +5 用 `damageMul` 之外的加法实现 ——
 * 走 melee（碰撞）与 `atkBonus`（技能）两处，帧伤**不受影响**（作者口径）。
 */
export function buildLevelConfig(run, levelSpec) {
  const hero = makeUnitStats(HERO_ID, run.skills, { maxSkills: Infinity });
  /* ⚠ 玩家球的技能来自**总技能池**（三个球种的并集），而 makeUnitStats 的
     normalizeSkills 会按"这个球种自己有什么技能"过滤一遍 —— 玩家球自己一个
     技能都没有，于是会被整份滤空。所以这里把技能直接写回去（互斥组的整理
     交给引擎的 resolveLoadout，那一步仍然生效）。 */
  hero.skills = run.skills.slice();
  /* 技能自带的美术与资源条（弓 / 领域 / 护盾条 / 魔力条）也一并继承 ——
     少了这一步，抽到桃夭 / 晕彩 / 见晴 / 缇娜 的技能会出现"机制在跑、
     画面什么都没有"（作者报的"部分特效丢失"）。 */
  inheritSkillArt(hero, run.skills);
  hero.maxHp = run.maxHp;
  hero.hp = Math.max(1, Math.min(run.maxHp, run.hp));   // 血量跨关连续
  hero.speed = run.speed;
  hero.melee = HERO_BASE.melee + run.bonusDmg;
  hero.skillBonus = run.bonusDmg;          // 技能伤害 +N（引擎侧见 _scaledDamage/atkBonus）
  hero.lightSkills = run.light.slice();

  const teams = [
    { units: [{ slot: 0, stats: hero }] },
    {
      units: levelSpec.enemies.map((e, i) => {
        const st = makeUnitStats(e.speciesId, e.skills, { maxSkills: Infinity });
        st.maxHp = Math.round(st.maxHp * (e.hpMul || 1));
        st.atkMul = e.atkMul || 1;
        /* 敌人的攻击统一画成暗红色（作者 2026-10）：
           闯关模式里"谁打我"必须一眼看出来 —— 玩家的攻击保留各自的美术色，
           敌人的全部变成暗红。引擎只带这个标记，配色在 render.js 里定。 */
        st.hostileLook = true;
        st.name = (e.boss ? 'BOSS·' : '') + st.name;
        return { slot: 100 + i, stats: st };
      }),
    },
  ];
  return {
    teams,
    arena: levelSpec.arena,
    sizeScale: levelSpec.sizeScale,
    rules: {
      ...DEFAULT_RULES,
      playerControl: true,
      timeLimit: 0,          // 关卡没有时间上限：打多久都行，撤退/阵亡才是结束
      allowShrink: false,
    },
    playerSlot: 0,
  };
}

/* ---------- 最高闯关数 ---------- */
const BEST_KEY = 'ballBattle.rogue.best.v1';
export function getBestLevel() {
  try {
    const v = Number(localStorage.getItem(BEST_KEY));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  } catch (e) { return 0; }
}
/** 记一次"过了几关"，只在破纪录时写入，返回是否破纪录 */
export function recordLevel(level) {
  const best = getBestLevel();
  if (level <= best) return false;
  try { localStorage.setItem(BEST_KEY, String(level)); } catch (e) { /* 忽略 */ }
  return true;
}
/** 只给测试用：清掉记录 */
export function _clearBest() {
  try { localStorage.removeItem(BEST_KEY); } catch (e) { /* 忽略 */ }
}

export { teamColor, resolveLoadout };

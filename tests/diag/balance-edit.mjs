/* 数值（平衡）编辑器自检
 *
 *   node tests/diag/balance-edit.mjs
 *
 * 作者 2026-10 的要求：「让我可以实时修改小球的血量、飞行速度、各种技能伤害数值」。
 * 这一组字段和"调个透明度"完全不同 —— 改错了会直接改战斗结果，所以要多验三层：
 *
 *   ① **位置对**：每个数值字段都能在源码里唯一定位，且**编辑器显示的现值
 *      就是源码里那个数**（pick 路径指错了对象时，两边会对不上）；
 *   ② **真的生效**：改内存里的那份配置，同一局（同种子）打出来的伤害/血量
 *      必须跟着变 —— 这才证明"改源码里的数字"能改战斗结果，
 *      而不只是改了一个没人读的常量；
 *   ③ **看得懂**：派生面板（每秒伤害 / 打空时间 / 能挨几下）算得对，
 *      并且"改前 → 改后"的百分比说得对。
 *
 * 另外验一下保存之后的"跨标签页刷新提示"（编辑器写、游戏页读）。
 * 全程**不写任何文件**：只在内存里改导入进来的配置对象，改完还原。
 */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { readFileSync } from 'node:fs';
import { locateField, formatValue, patchField } from '../../tools/lib/asset-patch.mjs';
import { ASSET_GROUPS, EDIT_FILES, allFields } from '../../js/asset-schema.js';
import { SPECIES_BY_ID, makeUnitStats, DEFAULT_RULES } from '../../js/balls.js';
import { YUNCAI, TAOYAO, TINA, JIANQING } from '../../js/skills.js';
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { rowsFor, speciesRows, deltaText, REF_HP, REF_HIT } from '../../js/balance.js';
import { ASSETS_SAVED_KEY, notifyAssetsSaved, installLiveReload } from '../../js/live-reload.js';

let pass = 0, fail = 0;
const log = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; log.push(`  ✅ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; log.push(`  ❌ ${name}${detail ? '  — ' + detail : ''}`); }
};

const PICK_ROOTS = { SPECIES_BY_ID, YUNCAI, TAOYAO, TINA, JIANQING };
const pickObject = (path) => {
  const parts = String(path).split('.');
  let v = PICK_ROOTS[parts[0]];
  for (let i = 1; i < parts.length && v != null; i++) v = v[parts[i]];
  return v;
};
const cache = new Map();
const srcOf = (short) => {
  if (!cache.has(short)) cache.set(short, readFileSync(EDIT_FILES[short], 'utf8'));
  return cache.get(short);
};

const balanceFields = allFields().filter(f => f.group === 'balance');
const pickedFields = allFields().filter(f => f.pick);
const balanceGroup = ASSET_GROUPS.find(g => g.id === 'balance');

console.log('=========== 数值（平衡）编辑器自检 ===========\n');

/* ---------- 1) 这一组的结构 ---------- */
console.log('【1】「数值（平衡）」这一组');
{
  check('组存在，并且叫得对', !!balanceGroup && balanceGroup.name === '数值（平衡）',
    balanceGroup ? balanceGroup.name : '没有这一组');
  const items = balanceGroup ? balanceGroup.items : [];
  check('九项：5 个球种基础数值（含见晴 / 木桩）+ 4 个角色的技能数值', items.length === 9,
    items.map(i => i.name).join(' / '));
  check('每项都声明成 balance 类型（预览会走数值面板）',
    items.every(i => i.kind === 'balance'), items.map(i => i.kind).join(','));
  check('字段数量足够覆盖"血量 / 速度 / 各技能伤害"', balanceFields.length >= 40,
    `${balanceFields.length} 个字段`);
  check('每个数值字段都标了 ⚠ 平衡数值（界面上是橙色警告）',
    balanceFields.every(f => f.balance === true)
    /* 贴图那几组里的"判定半径"也是平衡数值，同样带这个标记 */
    && allFields().filter(f => f.balance).length >= balanceFields.length);
  check('每个数值字段都有取值范围（min/max），不会调出一个荒谬的数',
    balanceFields.filter(f => f.type === 'number')
      .every(f => Number.isFinite(f.min) && Number.isFinite(f.max) && f.min < f.max),
    balanceFields.filter(f => f.type === 'number' && !(Number.isFinite(f.min) && Number.isFinite(f.max)))
      .map(f => f.id).join(',') || '全部都有');
  check('每个数值字段都带 pick（编辑器靠它读现值）',
    balanceFields.every(f => typeof f.pick === 'string' && f.pick.includes('.')),
    [...new Set(balanceFields.map(f => f.pick))].length + ' 个对象');
  check('没有收录诊断夹具那几颗测试球（它们的数被 skill3 的守卫写死了）',
    !balanceFields.some(f => /test/i.test(f.pick)),
    [...new Set(balanceFields.map(f => f.pick))].filter(p => /test/i.test(p)).join(',') || '只有游戏里真的会出场的球');
  check('木桩在数值编辑器里：**只放开生命与碰撞伤害**（速度必须恒为 0）', (() => {
    const d = balanceFields.filter(f => f.pick === 'SPECIES_BY_ID.dummy');
    return d.length === 2 && d.some(f => f.key === 'hp') && d.some(f => f.key === 'melee') &&
      !d.some(f => f.key === 'speed');
  })(), balanceFields.filter(f => f.pick === 'SPECIES_BY_ID.dummy').map(f => f.key).join('、'));
  check('三个球种的基础数值都在（生命 / 速度 / 碰撞伤害）',
    ['yuncai', 'taoyao', 'tina'].every(sp =>
      ['hp', 'speed', 'melee'].every(k =>
        balanceFields.some(f => f.pick === `SPECIES_BY_ID.${sp}` && f.key === k))),
    '晕彩 / 桃夭 / 缇娜');
}

/* ---------- 2) 编辑器显示的现值 == 源码里的那个数 ---------- */
console.log('\n【2】现值：编辑器读到的 == 源码里写的');
{
  const mismatched = [];
  const unlocatable = [];
  /* 只查带 pick 的字段：贴图那几组里的判定半径走的是"按 id 前缀取"的老机制，
     由 art-proj / check-asset-schema 那两条线各自守着。 */
  for (const f of pickedFields) {
    let loc = null;
    try { loc = locateField(srcOf(f.file), f); }
    catch (e) { unlocatable.push(`${f.id}: ${e.message}`); continue; }
    const obj = pickObject(f.pick);
    const inMem = obj ? obj[f.key] : undefined;
    /* 按类型比：nums 比数组、bool 比真假、其余比数字。
       （bool 拿 Number('true') 去比会得到 NaN —— 我第一版就是这么写出假红的。） */
    let inSrc;
    if (f.type === 'nums') inSrc = JSON.parse(loc.before);
    else if (f.type === 'bool') inSrc = /true/.test(loc.before);
    else inSrc = Number(loc.before);
    const same = f.type === 'nums'
      ? Array.isArray(inMem) && inMem.length === inSrc.length &&
        inMem.every((v, i) => Math.abs(Number(v) - inSrc[i]) < 1e-9)
      : f.type === 'bool'
        ? !!inMem === inSrc
        : Math.abs(Number(inMem) - inSrc) < 1e-9;
    if (!same) mismatched.push(`${f.id}（源码 ${loc.before} vs 内存 ${JSON.stringify(inMem)}）`);
  }
  check('每个数值字段都能在源码里唯一定位', unlocatable.length === 0,
    unlocatable.slice(0, 3).join(' / ') || `${pickedFields.length} 个字段全部定位成功`);
  check('每个字段"源码里的值"与"编辑器显示的值"完全一致（pick 没指错对象）',
    mismatched.length === 0, mismatched.slice(0, 3).join(' / ') || '全部一致');
  /* 光系加成之类的派生值不该出现在这里（那会让"改了却不生效"很难查） */
  check('基础数值里没有"被技能覆盖"的假字段（例如晕彩的碰撞伤害本来就是 0）',
    Number(SPECIES_BY_ID.yuncai.melee) === 0, `晕彩 melee = ${SPECIES_BY_ID.yuncai.melee}`);
}

/* ---------- 3) 数字数组（裁光的两档接触伤害） ---------- */
console.log('\n【3】数字数组字段（dmgByStage）');
{
  const f = balanceFields.find(x => x.type === 'nums');
  check('确实有数组类型的字段', !!f, f ? `${f.id} = ${JSON.stringify(pickObject(f.pick)[f.key])}` : '没有');
  check('数组能被解析成真数组', Array.isArray(pickObject(f.pick)[f.key]), JSON.stringify(pickObject(f.pick)[f.key]));
  check('formatValue 把 "1, 2" 写成 [1, 2]',
    formatValue('nums', '1, 2') === '[1, 2]', formatValue('nums', '1, 2'));
  check('中文逗号也认（作者可能用中文输入法）',
    formatValue('nums', '1，2') === '[1, 2]', formatValue('nums', '1，2'));
  check('也接受真数组', formatValue('nums', [3, 4]) === '[3, 4]', formatValue('nums', [3, 4]));
  let threw = '';
  try { formatValue('nums', ''); } catch (e) { threw = e.message; }
  check('空数组会被拒绝（不能把一档伤害改没了）', /不能为空/.test(threw), threw);
  threw = '';
  try { formatValue('nums', '1, 哈哈'); } catch (e) { threw = e.message; }
  check('非数字会被拒绝', /不是数字/.test(threw), threw);
  /* 往返：写回源码后再定位，必须还是同一个数组 */
  const before = locateField(srcOf(f.file), f).before;
  const out = patchField(srcOf(f.file), f, [7, 9]);
  const back = locateField(out.src, f);
  check('数组的往返一致（写回 → 读回）', back.before === '[7, 9]', `${before} → ${out.after} → ${back.before}`);
}

/* ---------- 4) 改了它，战斗结果真的会变 ---------- */
console.log('\n【4】引擎真的读这些数（同种子对比）');
{
  const mkFight = (skills, foeId = 'test') => new Battle({
    teams: [
      { units: [{ stats: makeUnitStats('yuncai', skills) }] },
      { units: [{ stats: makeUnitStats(foeId, []) }] },
    ],
    arena: ARENA_BY_ID.rect,
    sizeScale: 1,
    rules: { ...DEFAULT_RULES, timeLimit: 30 },
    seed: 5,
  });
  /** 跑一局，返回第一个"命中造成伤害"的数值（按帧序，第一个最有代表性） */
  const firstHitValue = (skills, foeId, frames = 60 * 12) => {
    const b = mkFight(skills, foeId);
    for (let i = 0; i < frames; i++) b.step();
    const ev = b.events.find(e => e.type === 'hit' && !e.tick && e.value > 0);
    return ev ? { value: ev.value, frame: ev.f } : null;
  };

  /* --- 血量 --- */
  const sp = SPECIES_BY_ID.yuncai;
  const hp0 = sp.hp;
  try {
    const baseStats = makeUnitStats('yuncai').maxHp;
    sp.hp = hp0 * 2;
    const bumped = makeUnitStats('yuncai').maxHp;
    check('改 species.hp → 单位的上限血量跟着变（makeUnitStats 现读）',
      bumped === hp0 * 2 && baseStats === hp0, `${baseStats} → ${bumped}`);

    /* 同一局：血量翻倍之后，第 900 帧剩余血量必须更多（物理不受血量影响，
       所以伤害序列完全相同 —— 这是一个"干净的对照实验"） */
    const run = () => {
      const b = mkFight(['yuncai_modan', 'yuncai_caiguang']);
      for (let i = 0; i < 900; i++) b.step();
      return b.units[0].hp;
    };
    sp.hp = hp0;
    const hpA = run();
    sp.hp = hp0 * 2;
    const hpB = run();
    check('同一局里血量翻倍 → 900 帧后剩下的血更多', hpB > hpA,
      `剩 ${hpA} → ${hpB}（差 ${hpB - hpA}）`);
  } finally { sp.hp = hp0; }

  /* --- 晕彩：魔弹伤害 --- */
  const md0 = YUNCAI.modan.dmg;
  try {
    const a = firstHitValue(['yuncai_modan'], 'test_heavy');
    YUNCAI.modan.dmg = md0 * 2;
    const b = firstHitValue(['yuncai_modan'], 'test_heavy');
    check('改 YUNCAI.modan.dmg → 打出来的伤害跟着翻倍',
      a && b && Math.abs(b.value - a.value * 2) < 1e-6,
      a && b ? `${a.value} → ${b.value}（第 ${a.frame} / ${b.frame} 帧）` : '没有命中事件');
  } finally { YUNCAI.modan.dmg = md0; }

  /* --- 桃夭：箭矢伤害 --- */
  const rg0 = TAOYAO.rong.damage;
  try {
    const fight = (foe) => {
      const b = new Battle({
        teams: [
          { units: [{ stats: makeUnitStats('taoyao', ['taoyao_rong']) }] },
          { units: [{ stats: makeUnitStats(foe, []) }] },
        ],
        arena: ARENA_BY_ID.rect, sizeScale: 1,
        rules: { ...DEFAULT_RULES, timeLimit: 30 }, seed: 9,
      });
      for (let i = 0; i < 60 * 12; i++) b.step();
      const ev = b.events.find(e => e.type === 'hit' && !e.tick && e.value > 0);
      return ev ? ev.value : null;
    };
    const a = fight('test_heavy');
    TAOYAO.rong.damage = rg0 + 35;
    const b = fight('test_heavy');
    check('改 TAOYAO.rong.damage → 箭矢伤害跟着变',
      a && b && Math.abs(b - (a + 35)) < 1e-6, a && b ? `${a} → ${b}（+35）` : '没有命中事件');
  } finally { TAOYAO.rong.damage = rg0; }

  /* --- 缇娜：蝙蝠伤害 --- */
  const bt0 = TINA.bat.damage;
  try {
    const fight = () => {
      const b = new Battle({
        teams: [
          { units: [{ stats: makeUnitStats('tina', ['tina_bat']) }] },
          { units: [{ stats: makeUnitStats('test_heavy', []) }] },
        ],
        arena: ARENA_BY_ID.rect, sizeScale: 1,
        rules: { ...DEFAULT_RULES, timeLimit: 30 }, seed: 3,
      });
      for (let i = 0; i < 60 * 20; i++) b.step();
      const ev = b.events.find(e => e.type === 'hit' && !e.tick && e.value > 0);
      return ev ? ev.value : null;
    };
    const a = fight();
    TINA.bat.damage = bt0 * 5;
    const b = fight();
    check('改 TINA.bat.damage → 蝙蝠伤害跟着变（×5）',
      a && b && Math.abs(b - a * 5) < 1e-6, a && b ? `${a} → ${b}` : '没有命中事件');
  } finally { TINA.bat.damage = bt0; }

  /* 还原干净：别把内存里的配置留在被改过的状态（后面的用例还要用） */
  check('用例结束后数值已还原（自检不污染后续）',
    SPECIES_BY_ID.yuncai.hp === hp0 && YUNCAI.modan.dmg === md0 &&
    TAOYAO.rong.damage === rg0 && TINA.bat.damage === bt0,
    `hp ${SPECIES_BY_ID.yuncai.hp} / 魔弹 ${YUNCAI.modan.dmg} / 箭 ${TAOYAO.rong.damage} / 蝙蝠 ${TINA.bat.damage}`);
}

/* ---------- 5) 派生面板算得对 ---------- */
console.log('\n【5】实时推算（面板右边那一列）');
{
  const rows = speciesRows({ hp: 1500, speed: 120, melee: 66 });
  const byLabel = Object.fromEntries(rows.map(r => [r.label, r.text]));
  check('能挨几下 = 血量 ÷ 参考打击', byLabel['能挨几下'] === `${Math.ceil(1500 / REF_HIT)} 下`,
    `1500 / ${REF_HIT} → ${byLabel['能挨几下']}`);
  check('撞死参考靶 = 参考血量 ÷ 碰撞伤害', byLabel['撞死一个标准目标'] === `${Math.ceil(REF_HP / 66)} 次碰撞`,
    `${REF_HP} / 66 → ${byLabel['撞死一个标准目标']}`);
  check('碰撞伤害为 0 时说的是"不会造成碰撞伤害"（而不是除以 0）',
    speciesRows({ hp: 1500, speed: 120, melee: 0 }).find(r => r.label === '撞死一个标准目标').text === '不会造成碰撞伤害');

  const mdRows = rowsFor('numYuncaiSkill', {
    modanDmg: 75, modanCd: 2, modanSpeed: 500, caiguangDmgByStage: [1, 2], caiguangBoom: 300,
    zheguangMelee: 100, kaihuaHeal: 300, kaihuaSpeed: 150, kaihuaLightBonus: 50, kaihuaMeleeBonus: 50,
    prismCannonDmg: 200, prismCd: 3, prismCannonSpeed: 420, prismLaserDmg: 50, prismLaserSpeed: 400,
    prismShardDmg: 20, prismShardSpeed: 300, xiguangMiniHp: 500, xiguangMiniSpeed: 120,
    domainDodge: 0.1, domainDodgeBloomed: 0.15, modanLaserDmg: 150, modanLaserSpeed: 1000,
  });
  const md = Object.fromEntries(mdRows.map(r => [r.label, r.text]));
  check('每秒伤害 = 单发 ÷ 冷却', md['魔弹 · 每秒伤害'] === '37.5', `75 / 2 → ${md['魔弹 · 每秒伤害']}`);
  check('打空参考靶的时间 = 参考血量 ÷ 每秒伤害', md[`魔弹 · 打空 ${REF_HP} 血`] === '40 秒',
    `1500 / 37.5 → ${md[`魔弹 · 打空 ${REF_HP} 血`]}`);
  check('裁光的每帧伤害会折成每秒（×60 帧）',
    md['裁光 · 每秒（贴住不动）'] === '60 / 120', `1,2 → ${md['裁光 · 每秒（贴住不动）']}`);
  check('开华的碰撞加成写成"折光 100 → 150"这种能直接读的式子',
    md['开华 · 碰撞加成'] === '+50' && mdRows.find(r => r.label === '开华 · 碰撞加成').note === '折光 100 → 150',
    mdRows.find(r => r.label === '开华 · 碰撞加成').note);

  check('变化百分比：+20%', deltaText(100, 120) === '+20%', deltaText(100, 120));
  check('变化百分比：−50%', deltaText(100, 50) === '−50%', deltaText(100, 50));
  check('从 0 涨上去时不写"无穷大%"', /从 0 变成/.test(deltaText(0, 30)), deltaText(0, 30));
  check('没变化时返回空串（面板不显示变化）', deltaText(66, 66) === '', `"${deltaText(66, 66)}"`);
  check('四个角色的技能面板都算得出东西', ['numYuncaiSkill', 'numTaoyaoSkill', 'numTinaSkill', 'numJianqingSkill']
    .every(id => rowsFor(id, {}).length > 0),
    ['numYuncaiSkill', 'numTaoyaoSkill', 'numTinaSkill', 'numJianqingSkill'].map(id => `${id}:${rowsFor(id, {}).length} 行`).join('　'));
  /* 见晴的面板：几个"能直接读"的派生量。
     ⚠ 面板每行是 { label, text, note } —— "攒满要 10 秒"这类补充说明在 note 里，
     断言时要看清取的是哪一栏（我第一版就看错了栏位，四条全假红）。 */
  const jqRows = Object.fromEntries(rowsFor('numJianqingSkill', {
    jqCycle: 5, jqBorrowCycle: 9, jqHeal: 15, jqMeleeBonus: 10, jqShieldGain: 30, jqShieldMax: 300, jqShieldDecay: 5,
    jqSwordDmg: 80, jqSwordAtkCd: 1, jqSwordFront: 120, jqSwordLen: 32, jqSwordDefCd: 5, jqSwordPurge: 3,
    jqModanCd: 3, jqModanDmg: 75, jqModanSpeed: 500, jqLaserCd: 4, jqLaserDmg: 170, jqLaserLife: 0.5,
    jqLaserWidth: 20, jqFlyDist: 1560, jqFlySec: 3, jqFlySpeed: 150, jqFlyDmg: 5, jqSizeMul: 0.5,
    jqFlyTake: 0.5, jqFlyTurn: 45,
    jqTrSpeed: 50, jqTrDmgMul: 0.5, jqTrSwordMul: 0.5, jqFeatherStep: 300, jqFeatherSpeed: 250,
    jqFeatherTurn: 220, jqFeatherBounce: 3, jqFeatherSlowSec: 3, jqFeatherSlowMul: 0.5,
    jqFeatherMelee: 5, jqFeatherSkill: 5,
  }).map(r => [r.label, r]));
  check('见晴面板：护盾攒满要 10 秒（300 ÷ 30）', /10 秒/.test(jqRows['①淡粉 · 护盾速度'].note || ''),
    jqRows['①淡粉 · 护盾速度'].note);
  check('见晴面板：长剑每秒 80（80 点 / 1 秒一下）', jqRows['②长剑 · 每秒伤害'].text === '80',
    jqRows['②长剑 · 每秒伤害'].text);
  check('见晴面板：③ 两态各自折成"一个周期几发"（9 秒 ÷ 3 = 3 发、9 秒 ÷ 4 = 3 发）',
    /一个周期 3 发/.test(jqRows['③深蓝紫 · 魔弹'].note || '') && /一个周期 3 发/.test(jqRows['③白色 · 激光'].note || ''),
    `${jqRows['③深蓝紫 · 魔弹'].note} ｜ ${jqRows['③白色 · 激光'].note}`);
  check('见晴面板：起飞节奏按 120 速度折成秒数（1560 ÷ 120 = 13）',
    /13 秒一次/.test(jqRows['④起飞 · 触发节奏'].note || ''), jqRows['④起飞 · 触发节奏'].note);
  check('见晴面板：空中帧伤折算成每秒（5 × 60 = 300）',
    jqRows['④空中 · 每帧伤害'].text === '5 ×60 = 300 /秒', jqRows['④空中 · 每帧伤害'].text);
  check('见晴面板：变身会把魔弹实际伤害算成一半（75 → 37.5）',
    jqRows['⑤变身 · 魔弹实际伤害'].text === '37.5', jqRows['⑤变身 · 魔弹实际伤害'].text);
  /* ④ 的空中口径：受伤倍率要折成"能挨几下"，转速要折成"转弯半径"（半径 = 速度 ÷ 角速度） */
  check('见晴面板：④空中受伤倍率 0.5（挨 100 只掉 50）',
    jqRows['④空中 · 受伤倍率'].text === '×0.5' && /只掉 50/.test(jqRows['④空中 · 受伤倍率'].note || ''),
    `${jqRows['④空中 · 受伤倍率'].text} ｜ ${jqRows['④空中 · 受伤倍率'].note}`);
  check('见晴面板：④空中转速 45°/秒 → 转弯半径（120+150=270 速，约 344）',
    jqRows['④空中 · 追踪转速'].text === '45°/秒' &&
    /转弯半径约 344/.test(jqRows['④空中 · 追踪转速'].note || ''),
    `${jqRows['④空中 · 追踪转速'].text} ｜ ${jqRows['④空中 · 追踪转速'].note}`);

  /* 缇娜的面板：偷学"持续发动型"能力会借多久（作者 2026-10 的新口径） */
  const tnRows = Object.fromEntries(rowsFor('numTinaSkill', {
    suckMeleeTo: 30, batDamage: 6, batMinCount: 3, batMaxCount: 5, batCd: 3, batSpeed: 150,
    batHeal: 3, btStealSec: 5, shotDamage: 30, shotCd: 2, shotCount: 3, shotSpeed: 400,
    shotSpreadDeg: 15, scepterMeleeBonus: 10, p3Damage: 20, p3TickPerSec: 3,
    p3Radius: 40, p3Len: 300,
  }).map(r => [r.label, r]));
  check('缇娜面板：偷到持续型能力借 5 秒',
    tnRows['②蝙蝠 · 偷持续型能力'].text === '借 5 秒',
    `${tnRows['②蝙蝠 · 偷持续型能力'].text} ｜ ${tnRows['②蝙蝠 · 偷持续型能力'].note}`);
}

/* ---------- 6) 保存之后的"跨标签页刷新提示" ---------- */
console.log('\n【6】保存 → 游戏页提示刷新');
{
  /* 假的 localStorage / window：这一层只认 storage 事件，可以在 node 里造 */
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  const handlers = [];
  globalThis.window = {
    addEventListener: (t, fn) => { if (t === 'storage') handlers.push(fn); },
    removeEventListener: (t, fn) => {
      if (t !== 'storage') return;
      const i = handlers.indexOf(fn);
      if (i >= 0) handlers.splice(i, 1);
    },
  };

  check('写入通知会落到 localStorage 的约定键上',
    notifyAssetsSaved('魔弹伤害: 75 → 150') && store.has(ASSETS_SAVED_KEY), ASSETS_SAVED_KEY);
  check('通知里带了"改了什么"的摘要',
    /魔弹伤害/.test(store.get(ASSETS_SAVED_KEY)), store.get(ASSETS_SAVED_KEY).slice(0, 60));

  let got = null;
  const off = installLiveReload(info => { got = info; });
  check('游戏页装上了监听', handlers.length === 1, `${handlers.length} 个`);

  /* 别的键不该触发（不然任何 localStorage 变化都会弹提示） */
  handlers.slice().forEach(fn => fn({ key: 'other-key', newValue: 'x' }));
  check('其它 key 的变化不会误触发', got === null);

  /* 编辑器写的那个键要触发，并把摘要带过来 */
  handlers.slice().forEach(fn => fn({ key: ASSETS_SAVED_KEY, newValue: store.get(ASSETS_SAVED_KEY) }));
  check('收到通知并解析出摘要', !!got && /魔弹伤害/.test(got.summary || ''), got ? got.summary : '没收到');

  /* 空值/坏 JSON 不能把页面搞崩 */
  got = null;
  handlers.slice().forEach(fn => fn({ key: ASSETS_SAVED_KEY, newValue: '{坏掉的 JSON' }));
  check('坏 JSON 也不会抛错（退化成空信息）', got !== null && !got.summary, JSON.stringify(got));

  off();
  check('可以卸载监听（诊断用完就撤）', handlers.length === 0, `${handlers.length} 个`);

  /* localStorage 不可用时（隐私模式）不能连累保存 */
  const savedLS = globalThis.localStorage;
  globalThis.localStorage = { setItem() { throw new Error('QuotaExceeded'); } };
  let threw = null;
  let ok = null;
  try { ok = notifyAssetsSaved('x'); } catch (e) { threw = e; }
  check('localStorage 写不进去时不抛错（通知失败不能连累保存）', !threw && ok === false,
    threw ? threw.message : `返回 ${ok}`);
  globalThis.localStorage = savedLS;
}

/* ---------- 7) 接线：页面上的那一头 ---------- */
console.log('\n【7】页面接线（静态核对）');
{
  const main = readFileSync('js/main.js', 'utf8');
  const ui = readFileSync('js/ui-assets.js', 'utf8');
  const css = readFileSync('css/styles.css', 'utf8');
  check('游戏入口装了监听', /installLiveReload\s*\(/.test(main), 'js/main.js');
  check('游戏页的小条有点"刷新"的按钮', /点击刷新/.test(main) && /location\.reload/.test(main));
  check('编辑器保存成功后发通知', /notifyAssetsSaved\s*\(/.test(ui), 'js/ui-assets.js');
  check('编辑器支持 nums 类型（数组字段能编辑）', /type === 'nums'/.test(ui));
  check('数值面板走的是 balance.js 的同一份公式', /rowsFor\s*\(/.test(ui) && /from '\.\/balance\.js'/.test(ui));
  check('小条用 .show 类显隐（不用 hidden 属性 —— 那条坑见 README 第 39 条）',
    /\.asset-toast\s*\{[^}]*display:\s*none/.test(css) && /\.asset-toast\.show\s*\{\s*display:\s*block/.test(css));
  check('数值字段标了平衡警告（界面上是橙色 ⚠）', /balance \? ' <span class="ed-warn"/.test(ui));
}

console.log('\n' + log.join('\n'));
console.log(`\n=========== 通过 ${pass} 项，失败 ${fail} 项 ===========`);
process.exit(fail ? 1 : 0);

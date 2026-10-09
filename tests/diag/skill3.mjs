/* 技能伤害必须精确等于技能表里写的数值。
 *
 * 历史：冲刺技能标着伤害 200，屏幕上却打出 500 —— 因为当时存在一个全局
 * "僵局破解器"伤害倍率（最高 2.5×）在放大所有伤害。破解器已移除，
 * 这个脚本就是那条结论的守卫：命中事件里的数值必须恒等于 50（射击）/ 200（冲刺）。
 *
 * 用法：node tests/diag/skill3.mjs
 */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { SKILL_PARAMS } from '../../js/skills.js';
import { DEFAULT_RULES, SPECIES_BY_ID, makeUnitStats } from '../../js/balls.js';

const mk = (seed = 7) => new Battle({
  teams: [['test_skill', 'test_skill'], ['test', 'test']]
    .map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
  arena: ARENA_BY_ID.rect,
  sizeScale: 1,
  rules: { ...DEFAULT_RULES },
  seed,
});

const hits = [];
let frames = 0;
for (const seed of [7, 11, 31, 55, 12345]) {
  const b = mk(seed);
  const orig = b._damage.bind(b);
  b._damage = (from, to, amount, kind) => {
    /* 直接记录"引擎准备扣掉的那个数" —— 也就是屏幕上会飘出来的数字。 */
    if (to.alive && amount > 0) hits.push({ seed, kind, amount });
    return orig(from, to, amount, kind);
  };
  while (!b.over && b.frame < b.maxFrames) b.step();
  frames += b.frame;
}

const by = {};
for (const h of hits) (by[h.kind] ||= []).push(h.amount);

const WANT = {
  melee: SPECIES_BY_ID.test.melee,
  skill: SKILL_PARAMS.shot.damage,
  dash: SKILL_PARAMS.dash.damage,
};

console.log(`=== ${frames} 帧 / ${hits.length} 次命中 ===`);
console.log(`  期望：melee=${WANT.melee}  shot=${WANT.skill}  dash=${WANT.dash}\n`);

let ok = true;
const chk = (name, cond, note = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${note ? '  — ' + note : ''}`);
  if (!cond) ok = false;
};

for (const [kind, want] of Object.entries(WANT)) {
  const got = by[kind] || [];
  const uniq = [...new Set(got)].sort((a, b) => a - b);
  chk(`${kind} 伤害恒为 ${want}`, got.length > 0 && uniq.length === 1 && uniq[0] === want,
    got.length ? `出现 ${got.length} 次，取值 ${uniq.join(',')}` : '本局未发生');
}

/* 最强的守卫：任何一个伤害数字都必须能在"预期集合"里找到。
   哪天再冒出个全局倍率，这一条立刻变红。 */
const allowed = new Set(Object.values(WANT));
const stray = [...new Set(hits.filter(h => !allowed.has(h.amount)).map(h => `${h.kind}:${h.amount}`))];
chk('没有任何"对不上号"的伤害数字', stray.length === 0, stray.join('、') || '全部匹配');

console.log(ok ? '\n全部通过' : '\n有失败项');
process.exit(ok ? 0 : 1);

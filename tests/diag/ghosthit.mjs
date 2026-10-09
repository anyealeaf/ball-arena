/* Diagnostic: 1v1 - are hits happening WITHOUT physical contact, and do the
   damage numbers match the ball's own stats?
   (ASCII only.)

   This guards the "no phantom hits" rule: a ball must never take damage from
   something it is not touching. It used to also print the old stalemate
   breaker's reachBonus/dmgMul; that mechanism is gone, so the check is now
   simply "every hit happens at contact range, and every number equals melee".

   Usage: node tests/diag/ghosthit.mjs
 */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

const spec = makeUnitStats('test');
const CONTACT = spec.r * 2 + 6;
console.log(`ball spec: hp=${spec.maxHp} melee=${spec.melee} r=${spec.r}`);
console.log(`contact range = 2r + 6 = ${CONTACT}\n`);

let allHits = 0, allFake = 0, allStray = 0;

function trace(arenaId, seed) {
  const b = new Battle({
    teams: [['test'], ['test']].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
    arena: ARENA_BY_ID[arenaId],
    rules: { ...DEFAULT_RULES },
    seed
  });
  console.log(`--- ${arenaId} seed=${seed} ---`);
  console.log('frame | dist  | contact<= | event-value | verdict');

  const hits = [];
  for (let f = 0; f < b.maxFrames && !b.over; f++) {
    const evStart = b.events.length;
    b.step();
    for (const e of b.events.slice(evStart)) {
      if (e.type !== 'hit') continue;
      const A = b.units[e.a >= 0 ? e.a : 0], B = b.units[e.b >= 0 ? e.b : 1];
      const d = (A && B) ? Math.hypot(A.x - B.x, A.y - B.y) / SCALE : -1;
      hits.push({ f: e.f, d, value: e.value, real: d <= CONTACT + 0.5 });
    }
  }
  const fake = hits.filter(h => !h.real);
  const stray = hits.filter(h => h.value !== spec.melee);
  allHits += hits.length; allFake += fake.length; allStray += stray.length;

  console.log(`total hits: ${hits.length}, of which WITHOUT physical contact: ${fake.length}`);
  for (const h of hits.slice(0, 10)) {
    console.log(`  f=${String(h.f).padStart(5)} dist=${h.d.toFixed(1).padStart(6)} ` +
      `(contact<=${CONTACT})  damage=${String(h.value).padStart(4)}  ` +
      `${h.real ? 'physical contact' : '*** NO CONTACT ***'}`);
  }
  const dmgValues = [...new Set(hits.map(h => h.value))];
  console.log(`distinct damage values seen: ${dmgValues.join(', ') || '-'}\n`);
  return fake.length === 0 && stray.length === 0;
}

const ok = [
  trace('rect', 31),
  trace('rect', 7),
  trace('circle', 31),
].every(Boolean);

console.log(`=== ${allHits} hits total ===`);
console.log(`  ${allFake === 0 ? '✅' : '❌'} 没有"没接触却掉血"的命中  — ${allFake} 次`);
console.log(`  ${allStray === 0 ? '✅' : '❌'} 伤害数值都等于属性表里的 ${spec.melee}  — ${allStray} 次不符`);
console.log(ok && allFake === 0 && allStray === 0 ? '\n全部通过' : '\n有失败项');
process.exit(ok && allFake === 0 && allStray === 0 ? 0 : 1);

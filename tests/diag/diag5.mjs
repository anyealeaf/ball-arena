/* 3 鏂规贩鎴樻畫灞€绮炬煡锛氫负浠€涔堟斁澶т激瀹?鎵╁ぇ鍒ゅ畾鑼冨洿涔嬪悗杩樻槸闆朵激瀹?*/
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

const b = new Battle({
  teams: Array.from({ length: 3 }, () => ['test', 'test']).map(u =>
    ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
  arena: ARENA_BY_ID['octagon'],
  rules: { ...DEFAULT_RULES },
  seed: 102
});

function snapshot(tag) {
  const alive = b.units.filter(u => u.alive);
  console.log(`\n[${tag}] 甯?${b.frame} (${(b.frame / 60).toFixed(1)}s)`);
  console.log(`  瀛樻椿 ${alive.length}: ` + alive.map(u =>
    `闃?{u.team}#${u.id}(x=${(u.x / SCALE).toFixed(0)},y=${(u.y / SCALE).toFixed(0)},琛€${Math.round(u.hp)},鐩爣=${u.targetId},ax=${u.ax},ay=${u.ay},hitCd=${u.hitCd.toFixed(2)})`
  ).join('\n           '));
  console.log(`  鐮磋В鍣?on=${b.breakerOn} 浼ゅ鍊嶇巼=${b.dmgMul.toFixed(2)} 鍒ゅ畾鍔犳垚=${b.reachBonus.toFixed(0)} 璺濅笂娆′激瀹?${(b.frame - b.lastDamageFrame)} 甯);
  // 鏁屽涓や袱闂磋窛 vs 鍒ゅ畾闃堝€?  for (let i = 0; i < alive.length; i++)
    for (let j = i + 1; j < alive.length; j++) {
      const A = alive[i], B = alive[j];
      if (A.team === B.team) continue;
      const d = Math.hypot(A.x - B.x, A.y - B.y) / SCALE;
      const thr = (A.r + B.r) / SCALE + 6 + b.reachBonus;
      console.log(`  闃?{A.team}#${A.id} 鈫?闃?{B.team}#${B.id}: 闂磋窛 ${d.toFixed(1)} / 闃堝€?${thr.toFixed(1)} => ${d <= thr ? '鍙墦' : '澶熶笉鐫€'}`);
    }
}

for (let i = 0; i < 3600; i++) b.step();
snapshot('60 绉?);

for (let i = 0; i < 600; i++) b.step();
snapshot('70 绉?);

// 鐪嬭繖 10 绉掑唴鏈夋病鏈変激瀹充簨浠?const recent = b.events.filter(e => e.type === 'hit' && e.f > 3600);
console.log(`\n60鈫?0 绉掔殑浼ゅ浜嬩欢鏁? ${recent.length}`);
if (recent.length) console.log('  鏍蜂緥:', recent.slice(0, 5).map(e => `f${e.f} ${e.a}->${e.b} -${e.value}`).join(' | '));

console.log('\n鎵€鏈変簨浠剁被鍨嬬粺璁?');
const counts = {};
for (const e of b.events) counts[e.type] = (counts[e.type] || 0) + 1;
console.log(' ', JSON.stringify(counts));

console.log('\n鏈€鍚?5 鏉′簨浠?');
for (const e of b.events.slice(-5)) console.log(`  f${e.f} ${e.type} a=${e.a} b=${e.b} v=${e.value}`);

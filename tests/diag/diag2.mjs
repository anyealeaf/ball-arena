/* 娈嬪眬璇婃柇锛氬鏂规贩鎴樻墦涓嶅畬锛屽埌搴曟槸"鎾炰笉涓?杩樻槸"鎵撲笉鍔?锛?*/
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

function mk(n, extraRules = {}) {
  return {
    teams: Array.from({ length: n }, () => ['test', 'test']).map(u =>
      ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
    arena: ARENA_BY_ID['octagon'],
    rules: { ...DEFAULT_RULES, ...extraRules },
    seed: 99 + n
  };
}

for (const n of [3, 4]) {
  console.log(`\n=========== ${n} 鏂规贩鎴?===========`);
  const b = new Battle(mk(n));
  b.runToEnd();

  const alive = b.units.filter(u => u.alive);
  console.log(`缁撴潫甯?${b.frame} (${(b.frame / 60).toFixed(0)}s) 鍘熷洜=${b.endReason}`);
  console.log(`娈嬪瓨 ${alive.length} 鐞? ` +
    alive.map(u => `闃?{u.team}(琛€${Math.round(u.hp)})`).join(' '));

  // 娈嬪瓨鐞冧箣闂寸殑鏈€灏忛棿璺?vs 瑙﹀彂鏀诲嚮鎵€闇€闂磋窛
  let minGap = Infinity, need = Infinity;
  for (let i = 0; i < alive.length; i++)
    for (let j = i + 1; j < alive.length; j++) {
      const A = alive[i], B = alive[j];
      if (A.team === B.team) continue;
      const d = Math.hypot(A.x - B.x, A.y - B.y) / SCALE;
      const rq = (A.r + B.r) / SCALE + 6;
      if (d < minGap) { minGap = d; need = rq; }
    }
  console.log(`鏁屽娈嬪瓨鐞冩渶灏忛棿璺?${minGap.toFixed(1)}锛岃Е鍙戞敾鍑婚渶瑕?鈮?${need.toFixed(1)} => ` +
    (minGap <= need ? '銆愭挒寰椾笂锛屾槸鎵撲笉鍔ㄣ€? : '銆愭挒涓嶄笂锛屽嚑浣曟閿併€?));

  // 娈嬪瓨鐞冩槸鍚﹁繕鍦ㄧЩ鍔?  const before = alive.map(u => [u.x, u.y]);
  for (let i = 0; i < 300; i++) b.step();
  const after = b.units.filter(u => u.alive);
  const moved = after.map((u, i) => before[i] ? Math.hypot(u.x - before[i][0], u.y - before[i][1]) / SCALE : -1);
  console.log(`鍐嶈窇 5 绉掞紝娈嬪瓨鐞冧綅绉? ${moved.map(m => m.toFixed(1)).join(', ')} 涓栫晫鍗曚綅`);
  console.log(`鐮磋В鍣ㄧ姸鎬? on=${b.breakerOn} 浼ゅ鍊嶇巼=${b.dmgMul.toFixed(2)}`);
  console.log(`鏈€鍚?10 绉掍激瀹充簨浠? ${b.events.filter(e => e.type === 'hit' && e.f > b.frame - 600).length} 鏉);

  // 缁熻姣忎釜鐞冪殑鐩爣鏄惁闀挎湡涓嶅彉锛堟閿佺壒寰侊級
  console.log(`娈嬪瓨鐞冨綋鍓嶇洰鏍? ` + after.map(u => `闃?{u.team}#${u.id}->${u.targetId}`).join(' '));
  const teamsAlive = [...new Set(after.map(u => u.team))];
  console.log(`瀛樻椿闃熶紞: ${teamsAlive.join(',')}`);
}

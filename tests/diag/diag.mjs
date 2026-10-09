/* 璇婃柇锛氬悓闃熶簰鏀讳负浠€涔堟病浼ゅ / 澶氶槦娣锋垬涓轰粈涔堟墦涓嶅畬 */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

function cfg(teams, rules = {}, arenaId = 'rect') {
  return {
    teams: teams.map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
    arena: ARENA_BY_ID[arenaId],
    rules: { ...DEFAULT_RULES, ...rules },
    seed: 3
  };
}

console.log('=== A. 鍗曢槦 3 鐞?+ 鍙嬪啗浼ゅ寮€鍚細璺熻釜璺濈涓庝簨浠?===');
{
  const b = new Battle(cfg([['test', 'test', 'test']], { friendlyFire: true }));
  for (let i = 0; i < 600; i++) {
    b.step();
    if (i % 120 === 0 || i === 599) {
      const pos = b.units.map(u => `(${(u.x / SCALE).toFixed(0)},${(u.y / SCALE).toFixed(0)})`).join(' ');
      const hps = b.units.map(u => Math.round(u.hp)).join(',');
      const dists = [];
      for (let a = 0; a < b.units.length; a++)
        for (let c = a + 1; c < b.units.length; c++) {
          const A = b.units[a], B = b.units[c];
          dists.push(Math.hypot(A.x - B.x, A.y - B.y) / SCALE);
        }
      console.log(` 甯?{String(i).padStart(3)} 浣嶇疆 ${pos} | 琛€ ${hps} | 闂磋窛 ${dists.map(d => d.toFixed(0)).join('/')}`);
    }
  }
  console.log(` 浜嬩欢: ${b.events.length} 鏉?->`, [...new Set(b.events.map(e => e.type))].join(',') || '锛堟棤锛?);
  console.log(` 鏈熼棿鎬讳激瀹? ${b.units.reduce((s, u) => s + u.dmg, 0)}`);
  console.log(` 鍗婂緞(涓栫晫鍗曚綅): ${b.units[0].r / SCALE}, 鏀诲嚮鍒ゅ畾闃堝€? ${(b.units[0].r * 2 / SCALE + 6).toFixed(1)}`);
  console.log(` 鍚勭悆閫熷害: ${b.units.map(u => u.speed / SCALE).join(',')}`);
}

console.log('\n=== B. 鍗曢槦 2 鐞冿紙鏈€瀹规槗鎾炰笂锛?===');
{
  const b = new Battle(cfg([['test', 'test']], { friendlyFire: true }));
  b.runToEnd();
  console.log(` 缁撴潫甯?${b.frame}, 鎬讳激瀹?${b.units.reduce((s, u) => s + u.dmg, 0)}, 浜嬩欢 ${b.events.length}`);
}

console.log('\n=== C. 3 鏂规贩鎴樹负浠€涔堟墦涓嶅畬锛氳窡韪槦浼嶅瓨娲?===');
{
  const b = new Battle(cfg([['test', 'test'], ['test', 'test'], ['test', 'test']], {}, 'octagon'));
  for (let i = 0; i < 18000 && !b.over; i++) {
    b.step();
    if (i % 1800 === 0) {
      const alive = b.units.filter(u => u.alive);
      const aliveTeams = [...new Set(alive.map(u => u.team))];
      console.log(` 甯?{String(i).padStart(5)} (${(i / 60).toFixed(0)}s) 瀛樻椿 ${alive.length}/${b.units.length} 闃?${aliveTeams.join(',')} 琛€=${alive.map(u => Math.round(u.hp)).join(',')}`);
    }
  }
  console.log(` 缁撴潫: ${b.over} 鍘熷洜=${b.endReason} 甯?${b.frame}`);
  const alive = b.units.filter(u => u.alive);
  console.log(` 娈嬪瓨: ${alive.map(u => `闃?{u.team}(琛€${Math.round(u.hp)})`).join(' ')}`);
  // 鐪嬫渶鍚庝竴娈垫椂闂磋繕鏈夋病鏈変激瀹充簨浠?  const late = b.events.filter(e => e.type === 'hit' && e.f > b.frame - 1800);
  console.log(` 鏈€鍚?30 绉掍激瀹充簨浠舵暟: ${late.length}`);
}

console.log('\n=== D. 鏄惁涓?缁曞湀鍍靛眬"锛氭鏌ユ湯娈典綅绉婚噺 ===');
{
  const b = new Battle(cfg([['test', 'test'], ['test', 'test'], ['test', 'test']], {}, 'octagon'));
  let p0 = null;
  for (let i = 0; i < 5400; i++) {
    b.step();
    if (i === 3600) p0 = b.units.filter(u => u.alive).map(u => [u.x, u.y]);
  }
  const p1 = b.units.filter(u => u.alive).map(u => [u.x, u.y]);
  const moved = p0.map((p, i) => p1[i] ? Math.hypot(p1[i][0] - p[0], p1[i][1] - p[1]) / SCALE : -1);
  console.log(` 绗?60s鈫?0s 鍚勫瓨娲荤悆浣嶇Щ: ${moved.map(m => m.toFixed(0)).join(', ')} 涓栫晫鍗曚綅`);
  console.log(` 鑻ヤ綅绉诲緢澶т絾鏃犱激瀹充簨浠讹紝鍗充负"杩戒笉涓婄殑缁曞湀鍍靛眬"銆俙);
}

/* 寰璇婃柇锛氫袱涓悆闂磋窛 28锛堝湪鏀诲嚮闃堝€?38 鍐咃級鍗翠笉鎺夎銆佷笉绉诲姩锛屼负浠€涔堬紵 */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

// 鏋勯€犱竴涓渶灏忓彲鎺у満鏅細2 闃熷悇 1 鐞冿紝鏂瑰満
function twoBall() {
  return {
    teams: [['test'], ['test']].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
    arena: ARENA_BY_ID['rect'],
    rules: { ...DEFAULT_RULES },
    seed: 3
  };
}

const b = new Battle(twoBall());

// 鎵嬪姩鎶婁袱涓悆鎽嗗埌闂磋窛 28锛堟敾鍑婚槇鍊兼槸 r+r+6 = 38锛夛紝鐒跺悗瑙傚療
const [A, B] = b.units;
const cx = 360 * SCALE, cy = 220 * SCALE;
A.x = cx - 14 * SCALE; A.y = cy;
B.x = cx + 14 * SCALE; B.y = cy;
console.log('鍒濆璁剧疆: A=(360-14) B=(360+14)锛岄棿璺?28 涓栫晫鍗曚綅');
console.log(`鍗婂緞 ${A.r / SCALE}锛屾敾鍑昏Е鍙戦槇鍊?${(A.r + B.r) / SCALE + 6}`);
console.log('');

console.log('甯?| A浣嶇疆 | B浣嶇疆 | 闂磋窛 | A.hitCd | A.vx | A琛€ | B琛€ | pairCd鍛戒腑?');
for (let f = 0; f < 8; f++) {
  b.step();
  const d = Math.hypot(A.x - B.x, A.y - B.y) / SCALE;
  const k = Math.min(A.id, B.id) * b.pairKeyBase + Math.max(A.id, B.id);
  const cd = b.pairCd.get(k);
  console.log(
    `${String(f).padStart(2)} | (${(A.x / SCALE).toFixed(0)},${(A.y / SCALE).toFixed(0)}) | ` +
    `(${(B.x / SCALE).toFixed(0)},${(B.y / SCALE).toFixed(0)}) | ${d.toFixed(1)} | ` +
    `${A.hitCd.toFixed(2)} | ${A.vx} | ${Math.round(A.hp)} | ${Math.round(B.hp)} | ` +
    `${cd !== undefined ? '鏈?' + cd.toFixed(2) + ')' : '鏃?}`
  );
}

console.log('\n--- 鍏抽敭閲忓鐓?---');
console.log(`this.time = ${b.time.toFixed(3)}  甯?${b.frame}`);
console.log(`A.speed(瀹氱偣) = ${A.speed}  => 鏈熸湜姣忓抚浣嶇Щ ${(A.speed / SCALE / 60).toFixed(3)} 涓栫晫鍗曚綅`);
console.log(`A.ax=${A.ax} A.ay=${A.ay}  (鍗曚綅鍚戦噺 脳SCALE锛屽簲涓?卤1000)`);
console.log(`A.targetId=${A.targetId}  B.targetId=${B.targetId}`);
console.log(`浜嬩欢鏁?${b.events.length}  绫诲瀷=${[...new Set(b.events.map(e => e.type))].join(',')}`);

console.log('\n--- 鐩存帴妫€鏌ユ敾鍑诲垽瀹氭潯浠?---');
{
  const gap = A.r + B.r + Math.round(6 * SCALE);
  const ddx = B.x - A.x, ddy = B.y - A.y;
  const d2 = ddx * ddx + ddy * ddy;
  console.log(`gap(瀹氱偣)=${gap}  瀹為檯璺濈虏=${d2}  gap虏=${gap * gap}`);
  console.log(`璺濈鍒ゅ畾鏄惁閫氳繃: ${d2 <= gap * gap ? '閫氳繃 鉁? : '涓嶉€氳繃 鉂?}`);
  console.log(`A.team=${A.team} B.team=${B.team} friendlyFire=${b.rules.friendlyFire}`);
  console.log(`A.hitCd=${A.hitCd} B.hitCd=${B.hitCd}`);
}

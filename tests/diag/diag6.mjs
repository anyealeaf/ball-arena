/* 缁欐敾鍑诲垽瀹氳鎺㈤拡锛氬埌搴曞摢涓€琛?continue 鎺変簡 */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
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

// 璺戝埌娈嬪眬
for (let i = 0; i < 3600; i++) b.step();

const A = b.units.find(u => u.alive && u.team === 0);
const B = b.units.find(u => u.alive && u.team === 1);
console.log('娈嬪眬鍙屾柟:', `A=#${A.id}(闃?{A.team}) B=#${B.id}(闃?{B.team})`);
console.log(`璺濈(瀹氱偣)=${Math.round(Math.hypot(B.x - A.x, B.y - A.y))}`);

const gap = A.r + B.r + Math.round((6 + (b.reachBonus || 0)) * SCALE);
console.log(`gap(瀹氱偣)=${gap}  gap虏=${gap * gap}`);
const ddx = B.x - A.x, ddy = B.y - A.y;
console.log(`瀹為檯璺濈虏=${ddx * ddx + ddy * ddy}`);
console.log(`鈶?璺濈鍒ゅ畾: ${ddx * ddx + ddy * ddy <= gap * gap ? '閫氳繃' : '涓嶉€氳繃 鈫?鍗″湪杩欓噷'}`);

const k1 = Math.min(A.id, B.id) * b.pairKeyBase + Math.max(A.id, B.id);
const cd = b.pairCd.get(k1);
console.log(`鈶?pairKeyBase=${b.pairKeyBase} k1=${k1}`);
console.log(`   pairCd.get(k1)=${cd} this.time=${b.time.toFixed(3)}`);
console.log(`   鍐峰嵈鍒ゅ畾: ${(cd || 0) > b.time ? '琚喎鍗存尅浣?鈫?鍗″湪杩欓噷' : '閫氳繃'}`);
console.log(`鈶?A.hitCd=${A.hitCd} B.hitCd=${B.hitCd}  => ${A.hitCd <= 0 || B.hitCd <= 0 ? '閫氳繃' : '鍙屾柟閮藉湪鍐峰嵈 鈫?鍗″湪杩欓噷'}`);
console.log(`鈶?闃熶紞鍒ゅ畾: A.team=${A.team} B.team=${B.team} friendlyFire=${b.rules.friendlyFire}`);

console.log('\n--- 鏄惁琚┖闂村搱甯屽垎鍒颁簡涓嶅悓妗讹紵---');
const cell = 40 * SCALE;
const ka = ((A.x / cell) | 0) * 100003 + ((A.y / cell) | 0);
const kb = ((B.x / cell) | 0) * 100003 + ((B.y / cell) | 0);
console.log(`A 妗?${ka} B 妗?${kb}  ${ka === kb ? '鍚屾《锛堜細琚瘮杈冿級' : '涓嶅悓妗讹紙闇€瑕佺浉閭婚亶鍘嗭級'}`);
console.log(`A.cell=(${(A.x / cell) | 0},${(A.y / cell) | 0})  B.cell=(${(B.x / cell) | 0},${(B.y / cell) | 0})`);

console.log('\n--- pairCd 琛ㄩ噷鏈夊灏戞潯鐩€佸€兼槸鍚﹁"鏈潵鏃堕棿"鍗犱綇 ---');
let maxCd = 0, count = 0;
for (const [, v] of b.pairCd) { count++; if (v > maxCd) maxCd = v; }
console.log(`pairCd 鏉＄洰鏁?${count} 鏈€澶у€?${maxCd.toFixed(2)} 锛堝綋鍓?time=${b.time.toFixed(2)}锛塦);
console.log(`鏄惁鏈夋潯鐩妸 (A,B) 杩欏閿佹鍒版湭鏉? ${cd !== undefined && cd > b.time ? '鏄?鈫?鍏冨嚩' : '鍚?}`);

console.log('\n--- 鍏抽敭锛欰 涓?B 鏄惁鐪熺殑鍚岄槦/瀛樻椿鐘舵€?---');
console.log(`A.alive=${A.alive} B.alive=${B.alive} units鎬绘暟=${b.units.length}`);
console.log(`A.targetId=${A.targetId} B.targetId=${B.targetId}`);

/* 绮剧‘瀹氫綅锛氫綅绉诲湪鍝竴姝ヨ鍚冩帀 */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

const cfg = {
  teams: [['test'], ['test']].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
  arena: ARENA_BY_ID['rect'],
  rules: { ...DEFAULT_RULES },
  seed: 3
};
const b = new Battle(cfg);
const [A, B] = b.units;
const cx = 360 * SCALE, cy = 220 * SCALE;
A.x = cx - 14 * SCALE; A.y = cy;
B.x = cx + 14 * SCALE; B.y = cy;

console.log('閫愭瑙傚療 A 鐨?x 鍧愭爣锛堜笘鐣屽崟浣嶏級');
console.log('鍒濆 A.x =', A.x / SCALE);

// 鎵嬪姩鎷嗚В step() 鐨勫悇涓樁娈碉紝鐪?x 鍦ㄥ摢涓€姝ヨ鏀瑰洖
const origSeparate = b._separate.bind(b);
const origClampTarget = [];
void origClampTarget;
const origResolve = b._resolveAttacks.bind(b);

let snapshot = [];
b._separate = function () {
  const before = b.units.map(u => u.x);
  origSeparate();
  const after = b.units.map(u => u.x);
  snapshot.push({ stage: 'separate', before: before.map(v => v / SCALE), after: after.map(v => v / SCALE) });
};
b._resolveAttacks = function () {
  const before = b.units.map(u => u.x);
  origResolve();
  const after = b.units.map(u => u.x);
  snapshot.push({ stage: 'attacks', before: before.map(v => v / SCALE), after: after.map(v => v / SCALE) });
};

for (let i = 0; i < 3; i++) {
  snapshot = [];
  const x0 = A.x / SCALE;
  b.step();
  const x1 = A.x / SCALE;
  console.log(`\n--- 甯?${i} ---`);
  console.log(`  step 鍓嶅悗 A.x: ${x0} -> ${x1}  (宸?${(x1 - x0).toFixed(2)})`);
  console.log(`  A.ax=${A.ax} A.vx=${A.vx}  鏈熸湜浣嶇Щ ${(A.vx * (1 / 60) / SCALE).toFixed(3)}`);
  for (const s of snapshot) {
    console.log(`  [${s.stage}] A.x: ${s.before[0].toFixed(2)} -> ${s.after[0].toFixed(2)} ` +
      `| B.x: ${s.before[1].toFixed(2)} -> ${s.after[1].toFixed(2)}`);
  }
}

console.log('\n--- 妫€鏌?clampToShape 鏄惁鍦ㄥ洖閫€ ---');
// 鐩存帴璋冪敤鐪嬬湅
const testX = cx + 100 * SCALE, testY = cy;
console.log('鎶?A 鏀惧湪鍦哄湴涓ぎ鍋忓彸锛宑lamp 鏄惁鏀瑰姩瀹冿紵');
const beforeClamp = { x: A.x, y: A.y };
void beforeClamp;
void testX; void testY;

console.log('\n--- 妫€鏌?_separate 閲屾槸鍚﹁秺鐣岃闂?---');
console.log(`units.length=${b.units.length}  A.id=${A.id} B.id=${B.id}`);
console.log(`A.r=${A.r} B.r=${B.r}  鍗婂緞鍜?${A.r + B.r}`);
console.log(`瀹為檯璺濈(瀹氱偣)=${Math.round(Math.hypot(B.x - A.x, B.y - A.y))}`);
console.log(`鏄惁閲嶅彔(璺濈<鍗婂緞鍜?: ${Math.hypot(B.x - A.x, B.y - A.y) < A.r + B.r}`);

console.log('\n--- 妫€鏌ラ€熷害鏂瑰悜 ---');
console.log(`A 鍦ㄥ乏(x=${A.x / SCALE})锛孊 鍦ㄥ彸(x=${B.x / SCALE})`);
console.log(`A.ax=${A.ax} (鏈熸湜 +1000 琛ㄧず鍚戝彸鏈?B 绉诲姩)`);
console.log(`B.ax=${B.ax} (鏈熸湜 -1000 琛ㄧず鍚戝乏鏈?A 绉诲姩)`);
console.log(`A.targetId=${A.targetId} (鏈熸湜 1)  B.targetId=${B.targetId} (鏈熸湜 0)`);

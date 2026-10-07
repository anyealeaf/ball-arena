/* 没有僵局破解器兜底时，对局还能不能自然收场？
 *
 * 背景：僵局破解器（长时间无伤害就放大伤害倍率 + 全场"饥饿"掉血）是当年
 * 物理还有 bug 时的兜底手段，现在已经彻底移除。
 * 这个脚本是移除它的依据，也是后续的守卫：**任何一场打不完都是回归**。
 *
 * 统计：
 *   · 自然收场（有一方被打死）
 *   · 撞到 5 分钟模拟上限（= 真僵局，没有兜底就永远打不完）
 *
 * 用法：node tests/diag/finish-rate.mjs [每场最大秒数]
 */
import { Battle } from '../../js/core.js';
import { ARENAS } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats } from '../../js/balls.js';

const LIMIT = Number(process.argv[2] || 300);
const SEEDS = [31, 7, 12345, 99];
const SIZES = [1, 2, 3];
/* 破解器已经彻底移除，这里就是默认规则。 */
const RULES = { ...DEFAULT_RULES };

/* 也要覆盖带技能的小球：蓄力冲刺会让球停下来蓄力 2 秒再冲出去，
   这种"主动停住"的行为正是最可能拖住对局的东西，必须一起扫。 */
const SPECIES_SETS = [
  { label: '普通球    ', id: 'test' },
  { label: '技能球    ', id: 'test_skill' },
];

const rows = [];
for (const set of SPECIES_SETS) {
  for (const arena of ARENAS) {
    for (const size of SIZES) {
      for (const seed of SEEDS) {
        const teams = [
          { units: Array.from({ length: size }, () => ({ stats: makeUnitStats(set.id) })) },
          { units: Array.from({ length: size }, () => ({ stats: makeUnitStats(set.id) })) },
        ];
        let b;
        try {
          b = new Battle({ teams, arena, sizeScale: 0.5, rules: RULES, seed });
        } catch (e) {
          rows.push({ kind: set.label.trim(), arena: arena.name, size, seed, err: e.message });
          continue;
        }
        const guard = Math.round(LIMIT / (1 / 60)) + 10;
        while (!b.over && b.frame < guard) b.step();
        rows.push({
          kind: set.label.trim(), arena: arena.name, size, seed,
          sec: +(b.frame / 60).toFixed(1),
          reason: b.endReason || '未结束',
          hitCap: /模拟上限/.test(b.endReason || ''),
        });
      }
    }
  }
}

const bad = rows.filter(r => r.err);
const capped = rows.filter(r => r.hitCap);
const natural = rows.filter(r => !r.hitCap && !r.err && r.reason);
const secs = natural.map(r => r.sec).sort((a, b) => a - b);

console.log(`=== 球种 ${SPECIES_SETS.length} × 场地 ${ARENAS.length} × 规模 ${SIZES.length} × 种子 ${SEEDS.length} = ${rows.length} 场 ===`);
for (const set of SPECIES_SETS) {
  const sub = rows.filter(r => r.kind === set.label.trim());
  const subCap = sub.filter(r => r.hitCap).length;
  const subSec = sub.filter(r => !r.hitCap && !r.err).map(r => r.sec).sort((a, b) => a - b);
  console.log(`  ${set.label} ${sub.length} 场，僵局 ${subCap}，最长 ${subSec.length ? subSec[subSec.length - 1] : '-'}s`);
}
if (bad.length) {
  console.log(`构造失败 ${bad.length} 场：`);
  for (const r of bad.slice(0, 5)) console.log(`  ${r.kind} ${r.arena} ${r.size}v${r.size} seed${r.seed}: ${r.err}`);
}
console.log(`\n自然收场 ${natural.length} / ${rows.length}`);
console.log(`撞到 ${LIMIT} 秒模拟上限（真僵局）${capped.length} / ${rows.length}`);
if (capped.length) {
  console.log('  僵住的场次：');
  for (const r of capped) {
    console.log(`    ${r.kind} ${r.arena.padEnd(10)} ${r.size}v${r.size} seed${String(r.seed).padStart(5)}`);
  }
}
if (secs.length) {
  const p = (q) => secs[Math.min(secs.length - 1, Math.floor(secs.length * q))];
  console.log(`\n收场耗时：最短 ${secs[0]}s / 中位 ${p(0.5)}s / 90分位 ${p(0.9)}s / 最长 ${secs[secs.length - 1]}s`);

  // 各自场地的平均耗时，找出最拖的场地
  const byArena = new Map();
  for (const r of natural) {
    const a = byArena.get(r.arena) || [];
    a.push(r.sec);
    byArena.set(r.arena, a);
  }
  const stat = [...byArena.entries()].map(([n, a]) => ({
    n, avg: a.reduce((x, y) => x + y, 0) / a.length, max: Math.max(...a),
  })).sort((x, y) => y.avg - x.avg);
  console.log('\n最拖的 5 个场地（平均收场秒数）：');
  for (const s of stat.slice(0, 5)) console.log(`  ${s.n.padEnd(10)} 平均 ${s.avg.toFixed(1)}s  最长 ${s.max}s`);
}

const ok = capped.length === 0 && bad.length === 0;
console.log(ok
  ? '\n✅ 结论：没有任何兜底机制，所有对局（含技能球）都能自然打出一个结果'
  : `\n❌ 结论：有 ${capped.length + bad.length} 场打不完 / 构造失败，需要处理`);
process.exit(ok ? 0 : 1);

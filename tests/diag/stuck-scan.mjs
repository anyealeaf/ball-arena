/* 全局不变量：活着的小球不该长时间一动不动。
 *
 * 背景：冲刺撞墙曾经把球钉在墙上（速度 162、位移恒为 0），
 * 修法是"撞墙即终止冲刺"。但那类修复很容易换个形式复发 ——
 * 比如某一帧速度被清成 0 却没有任何东西再把它推起来，球就永久停住了。
 * 这个脚本不关心具体机制，只盯住"有没有球卡住"这个可观察事实：
 * 遍历所有场地 × 所有球种 × 多种规模，任何一只活着的球
 * 连续静止超过 MAX_STILL 帧（且不是在蓄力）就算失败。
 *
 * 用法：node tests/diag/stuck-scan.mjs
 */
import { Battle } from '../../js/core.js';
import { ARENAS } from '../../js/arenas.js';
import { DEFAULT_RULES, SPECIES, makeUnitStats, SCALE } from '../../js/balls.js';

const MAX_STILL = 150;          // 连续静止帧数上限（蓄力 120 帧是合法的，所以放到 150）
const SEEDS = [31, 7, 12345];

const speciesIds = SPECIES.map(s => s.id);
let worst = null;
const failures = [];
let battles = 0, unitFrames = 0;

for (const arena of ARENAS) {
  for (const specId of speciesIds) {
    for (const size of [1, 2, 3]) {
      for (const seed of SEEDS) {
        let b;
        try {
          b = new Battle({
            teams: [0, 1].map(() => ({
              units: Array.from({ length: size }, () => ({ stats: makeUnitStats(specId) })),
            })),
            arena, sizeScale: 0.5, rules: { ...DEFAULT_RULES }, seed,
          });
        } catch { continue; }
        battles++;

        const still = b.units.map(() => 0);
        const prev = b.units.map(u => ({ x: u.x, y: u.y }));
        while (!b.over && b.frame < b.maxFrames) {
          b.step();
          for (let i = 0; i < b.units.length; i++) {
            const u = b.units[i];
            if (!u.alive) { still[i] = 0; prev[i] = { x: u.x, y: u.y }; continue; }
            unitFrames++;
            const moved = u.x !== prev[i].x || u.y !== prev[i].y;
            prev[i] = { x: u.x, y: u.y };
            /* 蓄力期间本来就该静止 —— 那是技能设计，不是卡住。 */
            if (moved || u.chargeFrames > 0) { still[i] = 0; continue; }
            still[i]++;
            if (still[i] > MAX_STILL) {
              failures.push({
                arena: arena.name, specId, size, seed, id: u.id,
                still: still[i], mode: u.mode, frame: b.frame,
                v: +(Math.hypot(u.vx, u.vy) / SCALE).toFixed(2),
                dmg: u.damageFrom,
              });
              still[i] = 0;   // 同一只球只报一次，避免刷屏
            }
          }
        }
        const m = Math.max(...still);
        if (!worst || m > worst.still) worst = { still: m, arena: arena.name, specId, size, seed };
      }
    }
  }
}

console.log(`=== 扫描 ${battles} 场 / ${unitFrames} 球·帧 ===`);
console.log(`判据：活着的球连续静止超过 ${MAX_STILL} 帧（蓄力中的球不计）`);
console.log(`静止最久的一次：${worst.still} 帧（${worst.arena} / ${worst.specId} / ${worst.size}v${worst.size} / seed${worst.seed}）\n`);

if (failures.length) {
  console.log(`发现 ${failures.length} 处卡住：`);
  for (const f of failures.slice(0, 15)) {
    console.log(`  ${f.arena.padEnd(8)} ${f.specId.padEnd(11)} ${f.size}v${f.size} seed${String(f.seed).padStart(5)} ` +
      `球#${f.id} 静止 ${f.still} 帧，mode=${f.mode}，速度=${f.v}，受伤来源=${JSON.stringify(f.dmg)}`);
  }
  console.log('\n❌ 有球卡住了');
  process.exit(1);
}
console.log('✅ 没有任何球卡住');

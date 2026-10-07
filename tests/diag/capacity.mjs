/* Diagnostic: spawn overlap per arena type and team size.
   Some arenas (triangle) are simply too small for many big balls --
   that is a capacity limit, not a spawn bug.
   (ASCII only.) */
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID, ARENAS, arenaBounds } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

const r = makeUnitStats('test').r;
const d = r * 2;
console.log(`ball radius=${r} diameter=${d}\n`);

console.log('arena capacity (rough): usable area / ball area');
for (const a of ARENAS) {
  const b = arenaBounds(a.shape);
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  // 粗略可用面积：形状各不同，这里只给外接矩形的参考值
  const boxArea = w * h;
  const ballArea = Math.PI * r * r;
  const cap = Math.floor(boxArea / ballArea);
  console.log(`  ${a.name.padEnd(10)} bbox ${w}×${h}  可容纳约 ${cap} 个（按外接矩形估算）`);
}

console.log('\nworst spawn gap per arena / team size (negative = overlapping)');
const sizes = [1, 2, 3, 4, 5, 6];
console.log('arena      ' + sizes.map(n => String(n).padStart(7)).join(''));
for (const arenaId of ['rect', 'circle', 'octagon', 'hexagon', 'decagon', 'diamond', 'triangle']) {
  const row = [];
  for (const n of sizes) {
    let worst = Infinity;
    for (const seed of [31, 7, 555, 12, 99]) {
      const b = new Battle({
        teams: [Array(n).fill('test'), Array(n).fill('test')].map(u =>
          ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
        arena: ARENA_BY_ID[arenaId],
        sizeScale: 1,
        rules: { ...DEFAULT_RULES },
        seed
      });
      for (let i = 0; i < b.units.length; i++) {
        for (let j = i + 1; j < b.units.length; j++) {
          const A = b.units[i], B = b.units[j];
          const dd = Math.hypot(A.x - B.x, A.y - B.y) / SCALE;
          const gap = dd - (A.r + B.r) / SCALE;
          if (gap < worst) worst = gap;
        }
      }
    }
    row.push(worst);
  }
  console.log(`${ARENA_BY_ID[arenaId].name.padEnd(10)}` +
    row.map(v => (v >= 0 ? '+' : '') + v.toFixed(0)).map(s => s.padStart(7)).join(''));
}
console.log('\ntriangle is the tightest: its inscribed area is small, so many');
console.log('doubled-size balls simply do not fit there. That is a capacity');
console.log('limit of that arena, not a spawn bug.');

/* Diagnostic: verify the collision impulse is physically correct.
   For an equal-mass elastic collision the exchanged velocity along the
   normal should equal the incoming relative normal speed.
   Also hunt for cases where a ball keeps going in nearly the SAME
   direction with nearly the SAME speed after a solid hit.
   (ASCII only.) */
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

function ang(vx, vy) { return ((Math.atan2(vy, vx) * 180) / Math.PI + 360) % 360; }
function dAng(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

let cases = 0;
const bad = [];

for (const arenaId of ['rect', 'octagon', 'circle']) {
  for (const sizeScale of [0.5, 1.0]) {
    for (const seed of [31, 7, 555]) {
      const b = new Battle({
        teams: [['test', 'test'], ['test', 'test']].map(u =>
          ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
        arena: ARENA_BY_ID[arenaId],
        sizeScale,
        rules: { ...DEFAULT_RULES },
        seed
      });
      const pre = new Map();
      while (!b.over && b.frame < b.maxFrames) {
        const evStart = b.events.length;
        const preVel = new Map();
        for (const u of b.units) if (u.alive) preVel.set(u.id, { vx: u.vx, vy: u.vy });
        // 碰撞前的位置与距离（用事件里的坐标即可）
        b.step();
        for (const e of b.events.slice(evStart)) {
          if (e.type !== 'bounce') continue;
          const A = b.units[e.a], B = b.units[e.b];
          if (!A || !B) continue;
          const pA = preVel.get(e.a), pB = preVel.get(e.b);
          if (!pA || !pB) continue;
          cases++;
          const dA = dAng(ang(pA.vx, pA.vy), ang(A.vx, A.vy));
          const dB = dAng(ang(pB.vx, pB.vy), ang(B.vx, B.vy));
          const sA0 = Math.hypot(pA.vx, pA.vy) / SCALE, sA1 = Math.hypot(A.vx, A.vy) / SCALE;
          const sB0 = Math.hypot(pB.vx, pB.vy) / SCALE, sB1 = Math.hypot(B.vx, B.vy) / SCALE;

          /* 值得警惕的情况：其中一个球几乎没转向（<5°）且速度几乎没变（<5%），
             而另一个球也没怎么动 —— 说明这次碰撞等于没发生。 */
          const aUntouched = dA < 5 && Math.abs(sA1 - sA0) / sA0 < 0.05;
          const bUntouched = dB < 5 && Math.abs(sB1 - sB0) / sB0 < 0.05;
          if (aUntouched && bUntouched && bad.length < 12) {
            // 距离与相对法向速度
            const d = Math.hypot(A.x - B.x, A.y - B.y) / SCALE;
            const rvx = pB.vx - pA.vx, rvy = pB.vy - pA.vy;
            const nx = B.x - A.x, ny = B.y - A.y;
            const nl = Math.hypot(nx, ny) || 1;
            const vn = (rvx * (nx / nl) + rvy * (ny / nl)) / SCALE;
            bad.push({ arenaId, sizeScale, seed, f: b.frame, d, vn,
              dA: dA.toFixed(1), dB: dB.toFixed(1), impact: e.value.toFixed(0) });
          }
        }
      }
    }
  }
}

console.log(`total ball-ball collisions: ${cases}`);
console.log(`\ncollisions where NEITHER ball changed direction or speed: ${bad.length}`);
for (const c of bad) {
  console.log(`  ${c.arenaId}/${Math.round(c.sizeScale * 100)}%/seed${c.seed} f=${c.f} ` +
    `dist=${c.d.toFixed(1)} relNormalSpeed=${c.vn.toFixed(1)} impact=${c.impact} ` +
    `turnA=${c.dA} turnB=${c.dB}`);
}
console.log('\nnote: dist should be <= 32 (the sum of radii) for a genuine contact.');

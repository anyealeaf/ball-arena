/* Diagnostic: probe clampToShape behaviour directly near each wall.
   (ASCII only.) */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { effectiveShape } from '../../js/arenas.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { SCALE } from '../../js/balls.js';

const shape = effectiveShape(ARENA_BY_ID['rect'], 0);
console.log('shape type:', shape.type);
console.log('points:', JSON.stringify(shape.points));

/* Re-implement the exact same probe by importing core internals is not possible
   (clampToShape is private), so we replicate the algorithm here verbatim to
   observe what it returns. If this replica behaves correctly, the bug is in how
   step() applies the result. */

function pointInConvex(points, x, y) {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % n];
    const cross = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
    if (cross < 0) return false;
  }
  return true;
}

function clampProbe(shape, x, y, radius) {
  const pts = shape.points;
  const n = pts.length;
  if (pointInConvex(pts, Math.round(x / SCALE), Math.round(y / SCALE))) {
    let deepest = null;
    for (let i = 0; i < n; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % n];
      const ex = x2 - x1, ey = y2 - y1;
      const len = Math.sqrt(ex * ex + ey * ey) || 1;
      const crossRaw = (ex * (y - y1 * SCALE) - ey * (x - x1 * SCALE)) / SCALE;
      const dist = (crossRaw / len) * SCALE;
      if (deepest === null || dist < deepest.dist) {
        deepest = { dist, nx: Math.round((-ey * SCALE) / len), ny: Math.round((ex * SCALE) / len) };
      }
    }
    if (deepest && deepest.dist < radius) {
      const push = radius - deepest.dist;
      return {
        hit: true, dist: deepest.dist / SCALE, nx: deepest.nx, ny: deepest.ny,
        x: x + Math.round((deepest.nx * push) / SCALE),
        y: y + Math.round((deepest.ny * push) / SCALE)
      };
    }
    return { hit: false, dist: deepest ? deepest.dist / SCALE : null };
  }
  return { hit: 'outside', x, y };
}

const R = 16 * SCALE;
console.log('\nprobe: ball centre at various y, x=360 (arena is 720x440, r=16)');
for (const y of [10, 100, 200, 300, 400, 410, 415, 420, 423, 424, 425, 430, 439, 445]) {
  const r = clampProbe(shape, 360 * SCALE, y * SCALE, R);
  console.log(`  y=${String(y).padStart(3)}  hit=${String(r.hit).padEnd(8)} ` +
    (r.dist !== undefined && r.dist !== null ? `distToNearestEdge=${r.dist.toFixed(1)} ` : '') +
    (r.nx !== undefined ? `n=(${r.nx},${r.ny})` : ''));
}

console.log('\nprobe near left wall (y=220):');
for (const x of [5, 10, 15, 16, 17, 20, 40]) {
  const r = clampProbe(shape, x * SCALE, 220 * SCALE, R);
  console.log(`  x=${String(x).padStart(3)}  hit=${String(r.hit).padEnd(8)} ` +
    (r.dist !== undefined && r.dist !== null ? `dist=${r.dist.toFixed(1)} ` : '') +
    (r.nx !== undefined ? `n=(${r.nx},${r.ny})` : ''));
}

console.log('\nCONCLUSION CHECK: a ball whose centre is exactly at the wall');
console.log('  (dist == radius) must still report hit=true, otherwise it will');
console.log('  sit clamped at the boundary forever with unchanged velocity.');

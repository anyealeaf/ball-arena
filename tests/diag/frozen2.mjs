/* Diagnostic: circle arena - is a ball actually frozen against the wall?
   (ASCII only.) */
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, makeUnitStats, SCALE } from '../../js/balls.js';

const cfg = {
  teams: [['test'], ['test']].map(u => ({ units: u.map(id => ({ stats: makeUnitStats(id) })) })),
  arena: ARENA_BY_ID['circle'],
  sizeScale: 1,
  rules: { ...DEFAULT_RULES },
  seed: 8888
};
const b = new Battle(cfg);
const u = b.units[0];
console.log(`ball r=${u.r / SCALE} speed=${u.speed / SCALE}`);
console.log(`circle: centre=(360,220) radius=210\n`);

const pos = [];
for (let i = 0; i < 2400 && !b.over && u.alive; i++) {
  b.step();
  pos.push({ f: i, x: u.x / SCALE, y: u.y / SCALE, vx: u.vx, vy: u.vy });
}

// find windows with near-zero motion
let frozen = [];
for (let i = 61; i < pos.length; i++) {
  const a = pos[i - 61], z = pos[i];
  const net = Math.hypot(z.x - a.x, z.y - a.y);
  let path = 0;
  for (let k = i - 60; k <= i; k++) path += Math.hypot(pos[k].x - pos[k - 1].x, pos[k].y - pos[k - 1].y);
  if (net < 3 && path < 3) frozen.push({ f: z.f, x: z.x, y: z.y, speed: Math.hypot(z.vx, z.vy) / SCALE });
}

console.log(`frozen one-second windows: ${frozen.length}`);
for (const x of frozen.slice(0, 6)) {
  const dx = x.x - 360, dy = x.y - 220;
  const distFromCentre = Math.hypot(dx, dy);
  console.log(`  f=${x.f} pos=(${x.x.toFixed(1)},${x.y.toFixed(1)}) speed=${x.speed.toFixed(1)} ` +
    `distFromCentre=${distFromCentre.toFixed(1)} (limit ${210 - u.r / SCALE})`);
}
if (frozen.length) {
  const last = frozen[frozen.length - 1];
  console.log(`\nlast frozen window at frame ${last.f} (${(last.f / 60).toFixed(0)}s)`);
  console.log(`battle over=${b.over} reason="${b.endReason}" frame=${b.frame}`);
  // inspect final state of both balls
  for (const x of b.units) {
    console.log(`  #${x.id} alive=${x.alive} pos=(${(x.x / SCALE).toFixed(1)},${(x.y / SCALE).toFixed(1)}) ` +
      `speed=${(Math.hypot(x.vx, x.vy) / SCALE).toFixed(1)} hp=${Math.round(x.hp)}`);
  }
}

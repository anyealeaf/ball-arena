/* 验证小球贴图：alpha 是否构成正确的圆。
 * 判据按"半径"采样 —— 圆内应完全不透明，圆外应完全透明，边缘应有过渡。
 * 用法：node tools/check-sticker.mjs
 */
import sharp from 'sharp';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GAME = join(dirname(fileURLToPath(import.meta.url)), '..');
const F = join(GAME, 'assets', 'characters', 'yuncai_head.png');

const meta = await sharp(F).metadata();
const { data, info } = await sharp(F).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height, C = info.channels;
const cx = W / 2, cy = H / 2, R = W / 2;

const alphaAt = (x, y) => {
  const xi = Math.min(W - 1, Math.max(0, Math.round(x)));
  const yi = Math.min(H - 1, Math.max(0, Math.round(y)));
  return data[(yi * W + xi) * C + (C - 1)];
};

console.log(`贴图 ${W}×${H}（alpha=${meta.hasAlpha}），圆心 (${cx},${cy}) 半径 ${R}\n`);

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
};

/* ① 圆内（半径 0~85%）必须完全不透明 */
{
  let worst = 255, worstAt = '';
  for (let deg = 0; deg < 360; deg += 15) {
    const a = (deg * Math.PI) / 180;
    for (const f of [0, 0.3, 0.6, 0.85]) {
      const v = alphaAt(cx + Math.cos(a) * R * f, cy + Math.sin(a) * R * f);
      if (v < worst) { worst = v; worstAt = `${deg}°@${f}`; }
    }
  }
  check('圆内完全不透明', worst >= 250, `最差 alpha=${worst} @ ${worstAt}`);
}

/* ② 圆外（半径 102% 以上）必须完全透明 */
{
  let worst = 0, worstAt = '';
  for (let deg = 0; deg < 360; deg += 15) {
    const a = (deg * Math.PI) / 180;
    for (const f of [1.02, 1.1, 1.25]) {
      const x = cx + Math.cos(a) * R * f, y = cy + Math.sin(a) * R * f;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;   // 超出画布则跳过
      const v = alphaAt(x, y);
      if (v > worst) { worst = v; worstAt = `${deg}°@${f}`; }
    }
  }
  check('圆外完全透明', worst <= 5, `最差 alpha=${worst} @ ${worstAt}`);
}

/* ③ 四角必须透明 */
{
  const corners = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]].map(([x, y]) => alphaAt(x, y));
  check('四角透明', corners.every(v => v <= 5), `四角 alpha = ${corners.join(', ')}`);
}

/* ④ 边缘存在过渡（不是硬切） */
{
  let soft = 0;
  for (let deg = 0; deg < 360; deg += 15) {
    const a = (deg * Math.PI) / 180;
    for (let f = 0.97; f <= 1.03; f += 0.005) {
      const v = alphaAt(cx + Math.cos(a) * R * f, cy + Math.sin(a) * R * f);
      if (v > 20 && v < 235) { soft++; break; }
    }
  }
  check('圆边有抗锯齿过渡（不是硬切）', soft >= 20, `${soft}/24 个方向检出过渡像素`);
}

/* ⑤ alpha 分布应左右、上下对称（圆对称性） */
{
  let asym = 0;
  for (let y = 0; y < H; y += 8) {
    for (let x = 0; x < W; x += 8) {
      const a = alphaAt(x, y);
      const b = alphaAt(W - 1 - x, y);
      const c = alphaAt(x, H - 1 - y);
      if (Math.abs(a - b) > 12 || Math.abs(a - c) > 12) asym++;
    }
  }
  check('圆形左右/上下对称', asym === 0, asym ? `${asym} 个采样点不对称` : '全部对称');
}

console.log(`\n结论：通过 ${pass} 项，失败 ${fail} 项 → ${fail === 0 ? '✅ 贴图几何正确' : '❌ 需修正'}`);

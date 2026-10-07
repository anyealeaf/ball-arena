/* 验证小球贴图：alpha 是否构成正确的圆。
 * 判据按"半径"采样 —— 圆内应完全不透明，圆外应完全透明，边缘应有过渡。
 * 用法：node tools/check-sticker.mjs [贴图路径...]
 *       不给参数就查晕彩的头部贴图（历史默认值）。
 *
 * 为什么改成可以传参：角色多了以后每加一张都要改这个文件太蠢，
 * 而且"球体贴图是不是一个圆"这件事一旦不对，游戏里看着就是脏边或方角。
 */
import sharp from 'sharp';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GAME = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const TARGETS = args.length
  ? args.map(a => resolve(a))
  : [join(GAME, 'assets', 'characters', 'yuncai_head.png')];

let anyBad = 0;
for (const F of TARGETS) {
  const bad = await checkOne(F);
  anyBad += bad;
}
process.exit(anyBad ? 1 : 0);

async function checkOne(F) {
const meta = await sharp(F).metadata();
const { data, info } = await sharp(F).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height, C = info.channels;
const cx = W / 2, cy = H / 2, R = W / 2;

console.log(`\n=== ${F.replace(GAME + '\\', '').replace(GAME + '/', '')}  ${W}x${H} ===`);

const alphaAt = (x, y) => {
  const xi = Math.min(W - 1, Math.max(0, Math.round(x)));
  const yi = Math.min(H - 1, Math.max(0, Math.round(y)));
  return data[(yi * W + xi) * C + (C - 1)];
};

console.log(`贴图 ${W}×${H}（alpha=${meta.hasAlpha}），圆心 (${cx},${cy}) 半径 ${R}\n`);

let pass = 0, fail = 0, soft = 0;
const check = (label, ok, detail) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
};
/* 软判据：只报告，不影响结论与退出码（见第 ④ ⑤ 条的说明） */
const checkSoft = (label, ok, detail) => {
  if (ok) pass++; else soft++;
  console.log(`  ${ok ? '✅' : '⚠️ '} ${label}${detail ? '  — ' + detail : ''}`);
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

/* ④ 边缘存在过渡（不是硬切）
   ---- 软判据 ----
   这一条与下面第 ⑤ 条是**给"我们自己生成的遮罩"看的**（make-ball-sticker.mjs
   切出来的圆），用来确认切边是抗锯齿的软边而不是硬切。
   作者手绘/自己裁好的贴图天然不满足这两条 —— 实测四张作者贴图全部只过 3 项，
   而它们在实际游戏里观感都没问题。所以这两条只报告、不计入失败，
   否则每加一个角色都会看到一片红，等于把真问题淹掉。 */
{
  let soft = 0;
  for (let deg = 0; deg < 360; deg += 15) {
    const a = (deg * Math.PI) / 180;
    for (let f = 0.97; f <= 1.03; f += 0.005) {
      const v = alphaAt(cx + Math.cos(a) * R * f, cy + Math.sin(a) * R * f);
      if (v > 20 && v < 235) { soft++; break; }
    }
  }
  checkSoft('圆边有抗锯齿过渡（软判据：作者手绘贴图可不满足）',
    soft >= 20, `${soft}/24 个方向检出过渡像素`);
}

/* ⑤ alpha 分布左右/上下对称（软判据，同上） */
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
  checkSoft('圆形左右/上下对称（软判据：作者手绘贴图可不满足）',
    asym === 0, asym ? `${asym} 个采样点不对称` : '全部对称');
}

console.log(`\n结论：硬判据通过 ${pass} 项，失败 ${fail} 项；软判据另有 ${soft} 项未满足` +
  ` → ${fail === 0 ? '✅ 贴图可用' : '❌ 需修正'}`);
if (fail === 0 && soft > 0) {
  console.log('      （软判据不满足不影响使用 —— 作者手绘/自裁的贴图通常都不满足）');
}
return fail;
}

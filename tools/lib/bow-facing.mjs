// bow-facing.mjs — 「这把弓朝哪边」的判据，**只此一份**
//
// 构建（tools/make-sprites.mjs）和诊断（tests/diag/bow.mjs）都调这里。
// 为什么要独立成模块：这个判据是个启发式（弦细、弓臂粗），
// 两处各写一份的话，改了一边另一边就会悄悄给出不同结论 ——
// 而"弓反了"这种事，判据本身出错比图出错更难发现。
//
// 输入是**原始像素**：{ data, w, h, ch }（RGBA，ch = 通道数）。
//
// 判据（弓没有"头尾"质量特征，弦几乎没重量，所以不能用质量判）：
//   A. 弓梢（最上/最下两行的不透明像素）连成弦，比较"弦"与**全图不透明重心**的左右；
//   B. 逐行找"最细的一组（弦）"与"最宽的一组（弓臂）"，看弓臂在弦的哪一侧。
// 两个信号**必须一致**才下结论：不一致返回 0（判不准），由调用方报错让人看。
// 弓臂朝哪边鼓，箭就往哪边飞 —— 这就是弓的"前方"（本项目约定 +X）。

const ALPHA_THR = 8;
const at = (im, x, y) => im.data[(y * im.w + x) * im.ch + 3];

/** 内容包围盒（按 alpha 阈值） */
export function contentBox(im, thr = ALPHA_THR) {
  let l = im.w, r = -1, t = im.h, b = -1;
  for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) {
    if (at(im, x, y) > thr) {
      if (x < l) l = x; if (x > r) r = x;
      if (y < t) t = y; if (y > b) b = y;
    }
  }
  return { l, r, t, b, w: r - l + 1, h: b - t + 1 };
}

/** 某一行上所有不透明区段（按 x 分成若干组） */
export function rowGroups(im, y, thr = 40) {
  const out = [];
  let l = -1;
  for (let x = 0; x < im.w; x++) {
    const on = at(im, x, y) > thr;
    if (on && l < 0) l = x;
    if (!on && l >= 0) { out.push({ l, r: x - 1 }); l = -1; }
  }
  if (l >= 0) out.push({ l, r: im.w - 1 });
  return out;
}

/** @returns {{dir: 1|-1|0, what: string}} dir: 1 = 朝 +X，-1 = 朝 −X，0 = 判不准 */
export function bowFacing(im) {
  const bb = contentBox(im);
  if (bb.r < 0) return { dir: 0, what: '整张图都是透明的' };
  const mid = (g) => (g.l + g.r) / 2;

  let topX = null, botX = null;
  for (let y = bb.t; y <= bb.b; y++) { const g = rowGroups(im, y); if (g.length) { topX = mid(g[0]); break; } }
  for (let y = bb.b; y >= bb.t; y--) { const g = rowGroups(im, y); if (g.length) { botX = mid(g[g.length - 1]); break; } }

  let sw = 0, sx = 0;
  for (let y = bb.t; y <= bb.b; y++) for (let x = bb.l; x <= bb.r; x++) {
    const a = at(im, x, y); if (a > ALPHA_THR) { sw += a; sx += a * x; }
  }
  const cen = sx / sw;
  const tips = ((topX ?? cen) + (botX ?? cen)) / 2;
  const tol = bb.w * 0.02;
  const sigA = cen > tips + tol ? 1 : (cen < tips - tol ? -1 : 0);

  let plus = 0, minus = 0;
  for (const f of [0.28, 0.36, 0.44, 0.56, 0.64, 0.72]) {
    const gs = rowGroups(im, Math.min(im.h - 1, Math.max(0, Math.round(im.h * f))));
    if (gs.length < 2) continue;
    const narrow = gs.reduce((a, b) => ((b.r - b.l) < (a.r - a.l) ? b : a), gs[0]);
    const wide = gs.reduce((a, b) => ((b.r - b.l) > (a.r - a.l) ? b : a), gs[0]);
    if (Math.abs(mid(wide) - mid(narrow)) < tol) continue;   // 挨太近，这一行不算数
    if (mid(wide) > mid(narrow)) plus++; else minus++;
  }
  const sigB = plus > minus ? 1 : (minus > plus ? -1 : 0);
  const name = (s) => (s > 0 ? '+X' : s < 0 ? '−X' : '看不出');
  return {
    dir: (sigA === sigB) ? sigA : 0,
    what: `重心 ${(cen / bb.w * 100).toFixed(0)}% vs 弓梢 ${(tips / bb.w * 100).toFixed(0)}%` +
      `（弦/重心 ${name(sigA)}）· 逐行曲臂票 +X ${plus} / −X ${minus}（${name(sigB)}）`,
  };
}

/* 分析截图中某个区域内"与背景不同"的像素，给出其边界与颜色，
 * 用来判断异常矩形是谁画的。
 * 用法：node tools/probe-region.mjs <图> <x> <y> <w> <h>
 */
import sharp from 'sharp';

const [input, X, Y, W, H] = process.argv.slice(2).map((v, i) => (i === 0 ? v : Number(v)));
const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const C = info.channels, IW = info.width, IH = info.height;
const px = (x, y) => {
  const o = (y * IW + x) * C;
  return [data[o], data[o + 1], data[o + 2], data[o + 3]];
};

// 以区域四角的中位数作为"背景色"
const corners = [px(X, Y), px(X + W - 1, Y), px(X, Y + H - 1), px(X + W - 1, Y + H - 1)];
const bg = [0, 1, 2].map(i => corners.map(c => c[i]).sort((a, b) => a - b)[Math.floor(corners.length / 2)]);
console.log(`背景色估计 rgb(${bg.join(',')})`);

// 找出与背景差异明显的像素
let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, count = 0;
const colors = new Map();
for (let y = Y; y < Y + H; y++) {
  for (let x = X; x < X + W; x++) {
    const [r, g, b] = px(x, y);
    const d = Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]);
    if (d > 24) {
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      const k = `${r},${g},${b}`;
      colors.set(k, (colors.get(k) || 0) + 1);
    }
  }
}

console.log(`\n区域内非背景像素: ${count} / ${W * H}`);
if (count === 0) { console.log('没有检出异常区域'); process.exit(0); }
console.log(`包围盒: x ${minX}..${maxX} (宽 ${maxX - minX + 1})   y ${minY}..${maxY} (高 ${maxY - minY + 1})`);

const top = [...colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log('\n出现最多的颜色（可能是异常区域的主色）:');
for (const [k, v] of top) console.log(`  rgb(${k})  ×${v}`);

// 抽取"矩形"特有的水平扫描：某几行里连续的非背景像素区间
console.log('\n逐行非背景像素区间（前 20 行有内容的）:');
let shown = 0;
for (let y = minY; y <= maxY && shown < 20; y++) {
  const runs = [];
  let s = -1;
  for (let x = X; x < X + W; x++) {
    const [r, g, b] = px(x, y);
    const d = Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]);
    if (d > 24) { if (s < 0) s = x; }
    else if (s >= 0) { runs.push(`${s}-${x - 1}`); s = -1; }
  }
  if (s >= 0) runs.push(`${s}-${X + W - 1}`);
  if (runs.length) { console.log(`  y=${y}: ${runs.join('  ')}`); shown++; }
}

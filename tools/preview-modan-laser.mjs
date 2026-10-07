// preview-modan-laser.mjs — 魔弹第三发（贯穿光柱）的比例预览
//
//   node tools/preview-modan-laser.mjs
//
// 为什么值得画一张：这道光柱宽 20、长 1400 —— 直径只有小球的六成，
// 长度是场地宽度的两倍。这两个数单看没感觉，画出来才知道
// 会不会"细得像根头发"或者"长到糊出场地"。
// 用和 render.js 里 kind=3（向前画的光柱）同一套画法。
import sharp from 'sharp';

const W = 720, H = 440;        // 场地（世界单位）
const PX = 1.15;
const DW = Math.round(W * PX), DH = Math.round(H * PX);

const P = { laserWidth: 20, laserLen: 1400, laserColor: '#e9d5ff' };
const BALL_R = 16, BALL_COLOR = '#8b7fd4';
const CASES = [
  { x: 90, y: 220, ang: 0, note: '朝右（正对远处）' },
  { x: 360, y: 220, ang: -60, note: '中间朝右上' },
  { x: 640, y: 90, ang: 150, note: '贴右上角朝左下' },
];

/* 与 render.js 的 kind=3 一致：从位置出发沿方向铺 L，柱体 + 外发光 + 白色核心线 + 末端圆头 */
function beam(cx, cy, ang, L) {
  const w = P.laserWidth;
  const rot = (ang * Math.PI) / 180;
  const x2 = cx + Math.cos(rot) * L, y2 = cy + Math.sin(rot) * L;
  return `
  <g transform="translate(${(cx * PX).toFixed(1)},${(cy * PX).toFixed(1)}) rotate(${ang})">
    <rect x="0" y="${(-(w / 2 + 2.5) * PX).toFixed(1)}" width="${(L * PX).toFixed(0)}" height="${((w + 5) * PX).toFixed(1)}"
          fill="${P.laserColor}" fill-opacity="0.28"/>
    <rect x="0" y="${(-w / 2 * PX).toFixed(1)}" width="${(L * PX).toFixed(0)}" height="${(w * PX).toFixed(1)}"
          fill="${P.laserColor}" fill-opacity="0.75"/>
    <circle cx="${(L * PX).toFixed(0)}" cy="0" r="${(w / 2 * PX).toFixed(1)}" fill="${P.laserColor}" fill-opacity="0.75"/>
    <rect x="0" y="${(-w * 0.16 * PX).toFixed(1)}" width="${(L * PX).toFixed(0)}" height="${(w * 0.32 * PX).toFixed(1)}"
          fill="#ffffff" fill-opacity="0.71"/>
  </g>
  <circle cx="${(cx * PX).toFixed(1)}" cy="${(cy * PX).toFixed(1)}" r="${(BALL_R * PX).toFixed(1)}"
          fill="${BALL_COLOR}" stroke="#5b4bb8" stroke-width="2"/>
  <circle cx="${(x2 * PX).toFixed(1)}" cy="${(y2 * PX).toFixed(1)}" r="14"
          fill="#4b7fd4" stroke="#fff" stroke-width="2"/>`;
}

const comps = [];
const LABEL = 28;
for (let i = 0; i < CASES.length; i++) {
  const c = CASES[i];
  /* 关键：光柱按场地裁剪 —— 与 render.js 一致，否则它会糊到场地外面 */
  const clipId = `clip${i}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${DW}" height="${DH}">
    <defs><clipPath id="${clipId}"><rect x="0" y="0" width="${DW}" height="${DH}"/></clipPath></defs>
    <rect width="100%" height="100%" fill="#fdfcf7"/>
    ${grid(DW, DH, 24 * PX)}
    <g clip-path="url(#${clipId})">
      <circle cx="${(c.x * PX).toFixed(1)}" cy="${(c.y * PX).toFixed(1)}" r="${(P.laserLen * PX).toFixed(0)}" fill="none"/>
    </g>
    <rect x="1" y="1" width="${DW - 2}" height="${DH - 2}" fill="none" stroke="#3a352a" stroke-width="2"/>
    <g clip-path="url(#${clipId})">${beam(c.x, c.y, c.ang, P.laserLen)}</g>
    <rect x="1" y="1" width="${DW - 2}" height="${DH - 2}" fill="none" stroke="#3a352a" stroke-width="2"/>
  </svg>`;
  comps.push({ input: Buffer.from(svg), left: i * (DW + 8), top: 0 });
  comps.push({
    input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${DW}" height="${LABEL}">
       <text x="${DW / 2}" y="19" font-size="14" fill="#3a352a" text-anchor="middle"
             font-family="sans-serif">${c.note}</text></svg>`),
    left: i * (DW + 8), top: DH,
  });
}
function grid(w, h, step) {
  let out = '';
  for (let x = 0; x <= w; x += step) out += `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="#eee9db" stroke-width="1"/>`;
  for (let y = 0; y <= h; y += step) out += `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#eee9db" stroke-width="1"/>`;
  return out;
}

const out = 'tools/preview-modan-laser.png';
await sharp({
  create: { width: (DW + 8) * CASES.length, height: DH + LABEL, channels: 4, background: { r: 238, g: 235, b: 225, alpha: 1 } },
}).composite(comps).png().toFile(out);
console.log(`已生成 ${out}`);
console.log(`场地 ${W}x${H} · 光柱宽 ${P.laserWidth}（小球直径 ${BALL_R * 2}）· 长 ${P.laserLen}`);
console.log(`长度相当于场地宽度的 ${(P.laserLen / W).toFixed(2)} 倍 → 一定会被场地边界裁掉，这正是"贯穿"的样子`);

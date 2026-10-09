// preview-sprite-facing.mjs — 方向性贴图的朝向验收图
//
//   node tools/preview-sprite-facing.mjs
//
// 每行一张贴图，每列一个飞行方向（0° / 90° / 180° / 270°，0° = 向右）。
// 每格里画一个**指向该方向的箭头**，贴图按同一个角度旋转 ——
// 如果"头/尖"没顺着箭头，一眼就能看出来。
// 全部贴图都必须符合「+X = 前方」这个约定，因为它就是渲染层 atan2(vy,vx) 的基准。
import sharp from 'sharp';

const DIR = 'assets/characters/';
const ITEMS = [
  { f: 'taoyao_arrow.png', label: '映霞[荣] 箭矢（应该尖端领先）' },
  { f: 'taoyao_ku_arrow.png', label: '映霞[枯] 箭矢（应该尖端领先）' },
  { f: 'yuncai_bolt.png', label: '晕彩 能量弹（应该亮核领先、尾迹在后）' },
  { f: 'tina_bolt.png', label: '缇娜 能量弹（应该亮核领先、尾迹在后）' },
  { f: 'tina_bat.png', label: '缇娜 蝙蝠（应该头领先）' },
];
const ANGLES = [0, 90, 180, 270];
const CELL = 150, PAD = 12, LABEL = 22;

const comps = [];
const W = 220 + ANGLES.length * CELL;
const H = ITEMS.length * (CELL + LABEL) + 30;

for (let r = 0; r < ITEMS.length; r++) {
  const it = ITEMS[r];
  const meta = await sharp(DIR + it.f).metadata();
  /* 统一缩放到格子内（保持宽高比） */
  const k = Math.min((CELL - PAD * 2) / meta.width, (CELL - PAD * 2) / meta.height);
  const tw = Math.max(1, Math.round(meta.width * k)), th = Math.max(1, Math.round(meta.height * k));
  const scaled = await sharp(DIR + it.f).resize(tw, th, { fit: 'fill' }).png().toBuffer();
  const top = r * (CELL + LABEL) + 30;
  comps.push({
    input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="220" height="${LABEL}">
      <text x="6" y="16" font-size="12.5" fill="#3a352a" font-family="sans-serif">${it.label}</text></svg>`),
    left: 0, top,
  });
  for (let c = 0; c < ANGLES.length; c++) {
    const ang = ANGLES[c];
    const cx = 220 + c * CELL + CELL / 2, cy = top + CELL / 2;
    /* 贴图按 ang 旋转（与渲染层一致：atan2(vy,vx)） */
    const rot = await sharp(scaled)
      .rotate(ang, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    const rm = await sharp(rot).metadata();
    comps.push({ input: rot, left: Math.round(cx - rm.width / 2), top: Math.round(cy - rm.height / 2) });
    /* 方向箭头（从中心往 ang 方向） */
    const rad = (ang * Math.PI) / 180;
    const ax = cx, ay = cy;
    const bx = cx + Math.cos(rad) * (CELL / 2 - 6), by = cy + Math.sin(rad) * (CELL / 2 - 6);
    const px = -Math.sin(rad), py = Math.cos(rad);
    const hx = bx - Math.cos(rad) * 11, hy = by - Math.sin(rad) * 11;
    comps.push({
      input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CELL}" height="${CELL}">
        <line x1="${ax - 220 - c * CELL}" y1="${ay - top}" x2="${bx - 220 - c * CELL}" y2="${by - top}"
              stroke="#c0253f" stroke-width="2" stroke-dasharray="5 4"/>
        <polygon points="${bx - 220 - c * CELL},${by - top} ${hx - 220 - c * CELL + px * 6},${hy - top + py * 6} ${hx - 220 - c * CELL - px * 6},${hy - top - py * 6}"
                 fill="#c0253f"/>
        <text x="${CELL / 2}" y="${CELL - 6}" font-size="12" fill="#6b6656" text-anchor="middle" font-family="sans-serif">${ang}°</text>
      </svg>`),
      left: 220 + c * CELL, top,
    });
  }
}

const out = 'tools/preview-sprite-facing.png';
await sharp({ create: { width: W, height: H, channels: 4, background: { r: 253, g: 252, b: 247, alpha: 1 } } })
  .composite(comps).png().toFile(out);
console.log(`已生成 ${out}  ${W}x${H}`);
console.log('每格里红色虚线箭头 = 飞行方向；贴图的"头/尖端"应当顺着它。');

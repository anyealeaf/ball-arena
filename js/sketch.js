/* ============================================================
   sketch.js — 小尺寸预览绘制工具（图鉴与准备界面共用）
   ============================================================ */

import { arenaBounds, regularPolygon } from './arenas.js';
import { WORLD_W, WORLD_H } from './balls.js';

/** 按容器尺寸准备高清画布 */
export function prepCanvas(canvas, w, h) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = w ?? canvas.clientWidth ?? 120;
  const ch = h ?? canvas.clientHeight ?? 80;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  return { ctx, w: cw, h: ch };
}

/**
 * 画场地缩略图：把世界坐标等比缩放进小画布。
 * 只画形状 + 区域效果 + 动态标记，不画小球。
 */
export function sketchArena(canvas, arena, opts = {}) {
  const { ctx, w, h } = prepCanvas(canvas);
  const b = arenaBounds(arena.shape);
  const pad = 8;
  const bw = b.maxX - b.minX, bh = b.maxY - b.minY;
  const s = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh);
  const ox = (w - bw * s) / 2 - b.minX * s;
  const oy = (h - bh * s) / 2 - b.minY * s;

  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(s, s);

  // 底色
  ctx.fillStyle = opts.bg || 'rgba(0,0,0,0.015)';
  ctx.fillRect(b.minX, b.minY, bw, bh);

  // 区域效果
  for (const z of arena.zones || []) {
    ctx.beginPath();
    if (z.shape.kind === 'circle') ctx.arc(z.shape.cx, z.shape.cy, z.shape.r, 0, Math.PI * 2);
    else ctx.rect(z.shape.x, z.shape.y, z.shape.w, z.shape.h);
    ctx.fillStyle = z.color || 'rgba(0,0,0,.06)';
    ctx.fill();
    if (z.edge) {
      ctx.strokeStyle = z.edge;
      ctx.lineWidth = 1 / s * 1.4;
      ctx.setLineDash([4 / s, 3 / s]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // 场地轮廓
  ctx.beginPath();
  if (arena.shape.type === 'circle') {
    ctx.arc(arena.shape.cx, arena.shape.cy, arena.shape.r, 0, Math.PI * 2);
  } else {
    const pts = arena.shape.points;
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
  }
  ctx.fillStyle = 'rgba(255,255,255,.6)';
  ctx.fill();
  ctx.strokeStyle = '#3a352a';
  ctx.lineWidth = 1.6 / s;
  ctx.stroke();

  // 动态场地的收缩预示：画一圈虚线表示收缩后的范围
  const eff = arena.effects || {};
  if (eff.shrink && opts.showShrink !== false) {
    const c = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    ctx.beginPath();
    if (arena.shape.type === 'circle') {
      ctx.arc(c.x, c.y, arena.shape.r * eff.shrink.minScale, 0, Math.PI * 2);
    } else {
      const pts = arena.shape.points.map(([x, y]) => [
        c.x + (x - c.x) * eff.shrink.minScale,
        c.y + (y - c.y) * eff.shrink.minScale
      ]);
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
    }
    ctx.strokeStyle = 'rgba(217,119,6,.75)';
    ctx.lineWidth = 1.2 / s;
    ctx.setLineDash([5 / s, 4 / s]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 旋转标记
  if (eff.rotationSpeedDeg) {
    ctx.fillStyle = 'rgba(58,53,42,.55)';
    ctx.font = `${13 / s}px sans-serif`;
    ctx.fillText('↻', b.minX + 6, b.minY + 16);
  }

  ctx.restore();
}

/** 画一个"球"的正面预览（图鉴卡片 / 队伍槽位用）。
 *  有贴图的角色直接画贴图，否则画渐变圆 + 资源角标。 */
export function sketchBall(canvas, species, size = 78) {
  const { ctx, w, h } = prepCanvas(canvas, size, size);
  const cx = w / 2, cy = h / 2;
  const r = size * 0.30;

  const st = species.sticker;
  // 某些无头/测试环境没有 Image 构造器，这里退化为纯色圆，避免整个界面崩掉
  if (st && st.src && typeof Image !== 'undefined') {
    const img = new Image();
    img.onload = () => {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.clip();
      const iw = img.naturalWidth || img.width;
      const ih = img.naturalHeight || img.height;
      const srcW = iw * (st.r * 2), srcH = ih * (st.r * 2);
      const srcX = iw * st.cx - srcW / 2, srcY = ih * st.cy - srcH / 2;
      ctx.drawImage(img, srcX, srcY, srcW, srcH, cx - r, cy - r, r * 2, r * 2);
      ctx.restore();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = '#3a352a';
      ctx.lineWidth = 2;
      ctx.stroke();
    };
    img.src = st.src;
    // 加载完成前先画底色，避免卡片空白
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = species.color;
    ctx.fill();
    ctx.strokeStyle = '#3a352a';
    ctx.lineWidth = 2;
    ctx.stroke();
    return;
  }

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.15, cx, cy, r);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.35, species.color);
  g.addColorStop(1, species.color);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = '#3a352a';
  ctx.lineWidth = 2;
  ctx.stroke();

  // 高光
  ctx.beginPath();
  ctx.arc(cx - r * 0.32, cy - r * 0.34, r * 0.20, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,.55)';
  ctx.fill();

  // 有特殊资源的小球加一个小角标，直观区分
  if (species.resource) {
    ctx.beginPath();
    ctx.arc(cx + r * 0.82, cy + r * 0.82, r * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = species.resource.color || '#4f7cff';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }
}

/** 画队伍配色小块（准备界面里的队伍标识） */
export function sketchTeamDot(canvas, color, size = 16) {
  const { ctx, w, h } = prepCanvas(canvas, size, size);
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, size * 0.34, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.25)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** 在世界坐标系里画一个正多边形路径（供自检脚本复用） */
export function polyPath(ctx, points) {
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
  ctx.closePath();
}

export { regularPolygon, WORLD_W, WORLD_H };

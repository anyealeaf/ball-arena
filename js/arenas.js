/* ============================================================
   arenas.js — 场地几何与特殊效果定义
   ------------------------------------------------------------
   设计要点：
   1. 所有场地统一用「凸多边形」或「圆」描述，战斗核心只需两种包含判定，
      因此新增场地 = 加一条数据，不需要改引擎。
   2. 场地特效分「区域效果」(zones) 与「场地效果」(effects)，都是数据。
   3. 坐标单位为"世界单位"，战斗核心内部会乘 SCALE 转成定点整数。
   ============================================================ */

/**
 * 由中心与半径生成正多边形顶点
 */

import { WORLD_W, WORLD_H } from './balls.js';

export function regularPolygon(cx, cy, r, sides, rotationDeg = 0) {
  const pts = [];
  const rot = (rotationDeg * Math.PI) / 180;
  for (let i = 0; i < sides; i++) {
    const a = rot + (i * 2 * Math.PI) / sides - Math.PI / 2;
    pts.push([Math.round(cx + r * Math.cos(a)), Math.round(cy + r * Math.sin(a))]);
  }
  return pts;
}

/* ------------------------------------------------------------
   区域效果：站在区域内会持续生效
   type: 'damage' 持续掉血 | 'slow' 减速 | 'haste' 加速
   shape: 圆 {cx,cy,r} 或矩形 {x,y,w,h}
   ------------------------------------------------------------ */

export const ARENAS = [
  /* ===== 基础几何场地 ===== */
  {
    id: 'rect',
    name: '方形竞技场',
    desc: '最基础的方形场地，四周封闭，无任何额外效果。',
    tags: ['基础'],
    shape: { type: 'poly', points: [[0, 0], [720, 0], [720, 440], [0, 440]] },
    zones: [],
    effects: {}
  },
  {
    id: 'circle',
    name: '圆形斗场',
    desc: '圆形边界让走位更自由，但边缘处容易被围堵。',
    tags: ['基础'],
    shape: { type: 'circle', cx: 360, cy: 220, r: 210 },
    zones: [],
    effects: {}
  },
  {
    id: 'octagon',
    name: '八角擂台',
    desc: '八个方向的斜边会形成"角落"，适合伏击与被伏击。',
    tags: ['基础'],
    shape: { type: 'poly', points: regularPolygon(360, 220, 210, 8) },
    zones: [],
    effects: {}
  },
  {
    id: 'hexagon',
    name: '六角战场',
    desc: '六边形场地，中央到各边距离均匀，起手位置更公平。',
    tags: ['基础'],
    shape: { type: 'poly', points: regularPolygon(360, 220, 210, 6) },
    zones: [],
    effects: {}
  },
  {
    id: 'triangle',
    name: '三角死斗',
    desc: '锐角区域极窄，被逼到角上几乎无法脱身，混战会异常激烈。',
    tags: ['基础', '高危'],
    shape: { type: 'poly', points: regularPolygon(360, 220, 215, 3) },
    zones: [],
    effects: {}
  },
  {
    id: 'diamond',
    name: '菱形场',
    desc: '四个尖角，横向空间被压缩，远程单位优势明显。',
    tags: ['基础'],
    shape: { type: 'poly', points: regularPolygon(360, 220, 205, 4, 0) },
    zones: [],
    effects: {}
  },

  /* ===== 多边形边数更多的场地 ===== */
  {
    id: 'decagon',
    name: '十边环场',
    desc: '接近圆形但保留棱角，边界碰撞更不可预测。',
    tags: ['基础'],
    shape: { type: 'poly', points: regularPolygon(360, 220, 208, 10) },
    zones: [],
    effects: {}
  },

  /* ===== 带特殊效果的场地 ===== */
  {
    id: 'lava_center',
    name: '熔心斗场',
    desc: '场地中央是一片持续灼烧的岩浆区，抢中心要付出代价。',
    tags: ['特殊效果', '持续伤害'],
    shape: { type: 'poly', points: regularPolygon(360, 220, 212, 8) },
    zones: [
      { id: 'lava', name: '岩浆', type: 'damage', dps: 55, shape: { kind: 'circle', cx: 360, cy: 220, r: 85 },
        color: 'rgba(220,80,40,0.28)', edge: 'rgba(220,80,40,0.65)' }
    ],
    effects: {}
  },
  {
    id: 'ice_field',
    name: '寒霜冰原',
    desc: '地面结冰，全场移动速度下降，但中央有一块"暖流"反而加速。',
    tags: ['特殊效果', '减速', '加速'],
    shape: { type: 'poly', points: [[0, 0], [720, 0], [720, 440], [0, 440]] },
    zones: [
      { id: 'warm', name: '暖流', type: 'haste', mul: 1.55, shape: { kind: 'circle', cx: 360, cy: 220, r: 95 },
        color: 'rgba(80,170,255,0.18)', edge: 'rgba(120,200,255,0.6)' }
    ],
    effects: { globalSpeedMul: 0.72 }
  },
  {
    id: 'dual_zone',
    name: '双生祭坛',
    desc: '左右各有一座祭坛，站在己方祭坛上受到的治疗与速度加成更高，逼出"守点"战术。',
    tags: ['特殊效果', '区域增益'],
    shape: { type: 'poly', points: [[0, 0], [720, 0], [720, 440], [0, 440]] },
    zones: [
      { id: 'altarA', name: '左祭坛', type: 'haste', mul: 1.4, shape: { kind: 'circle', cx: 130, cy: 220, r: 78 },
        color: 'rgba(47,109,246,0.20)', edge: 'rgba(47,109,246,0.6)' },
      { id: 'altarB', name: '右祭坛', type: 'haste', mul: 1.4, shape: { kind: 'circle', cx: 590, cy: 220, r: 78 },
        color: 'rgba(232,69,44,0.20)', edge: 'rgba(232,69,44,0.6)' }
    ],
    effects: {}
  },

  /* ===== 动态场地（会随时间变化）===== */
  {
    id: 'shrink_ring',
    name: '收缩竞技场',
    desc: '场地会不断向内收缩，逼迫所有小球碰面，永远不会出现互相绕圈的僵局。',
    tags: ['特殊效果', '动态', '收缩'],
    shape: { type: 'poly', points: regularPolygon(360, 220, 215, 12) },
    zones: [],
    effects: { shrink: { startDelay: 4, ratePerSec: 0.028, minScale: 0.34 } }
  },
  {
    id: 'rotating_square',
    name: '回旋方阵',
    desc: '方形场地持续缓慢旋转，边角会扫过场上的小球，把站桩的单位推开。',
    tags: ['特殊效果', '动态', '旋转'],
    shape: { type: 'poly', points: regularPolygon(360, 220, 190, 4), rotate: true },
    zones: [],
    effects: { rotationSpeedDeg: 9 }
  },
  {
    id: 'chaos',
    name: '混沌之厅',
    desc: '收缩 + 旋转 + 中央灼烧三重压力，纯粹为混乱与节目效果而生。',
    tags: ['特殊效果', '动态', '高危'],
    shape: { type: 'poly', points: regularPolygon(360, 220, 215, 8), rotate: true },
    zones: [
      { id: 'core', name: '灼热核心', type: 'damage', dps: 40, shape: { kind: 'circle', cx: 360, cy: 220, r: 70 },
        color: 'rgba(220,80,40,0.22)', edge: 'rgba(220,80,40,0.55)' }
    ],
    effects: { rotationSpeedDeg: 6, shrink: { startDelay: 6, ratePerSec: 0.022, minScale: 0.42 } }
  }
];

export const ARENA_BY_ID = Object.fromEntries(ARENAS.map(a => [a.id, a]));

/**
 * 所有场地中最大的横/纵尺寸。
 * 用于把画布高度限制在"最大场地"的比例上 ——
 * 否则换成小场地（例如半场）时，画布仍按整个世界高度撑开，
 * 场地四周会留出一大圈空白，看着就像"画面没显示全"。
 */
export const ARENA_MAX_W = 720;
export const ARENA_MAX_H = 440;

/* ------------------------------------------------------------
   几何工具
   ------------------------------------------------------------ */

/** 取场地顶点的包围盒（用于渲染自适应缩放） */
export function arenaBounds(shape) {
  if (shape.type === 'circle') {
    return { minX: shape.cx - shape.r, minY: shape.cy - shape.r,
             maxX: shape.cx + shape.r, maxY: shape.cy + shape.r };
  }
  const xs = shape.points.map(p => p[0]);
  const ys = shape.points.map(p => p[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** 场地中心 */
export function arenaCenter(shape) {
  const b = arenaBounds(shape);
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

/** 按比例缩放多边形（用于收缩场地） */
export function scaledPoints(points, scale, cx, cy) {
  return points.map(([x, y]) => [
    Math.round(cx + (x - cx) * scale),
    Math.round(cy + (y - cy) * scale)
  ]);
}

/** 旋转多边形顶点 */
export function rotatedPoints(points, deg, cx, cy) {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return points.map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    return [Math.round(cx + dx * cos - dy * sin), Math.round(cy + dx * sin + dy * cos)];
  });
}

/**
 * 求"当前生效"的场地几何：把旋转与收缩都算进去。
 * 战斗核心只调用这一个函数拿多边形，因此动态场地对引擎是透明的。
 */
export function effectiveShape(arena, elapsedSec) {
  const eff = arena.effects || {};
  const shape = arena.shape;
  let scale = 1;

  if (eff.shrink) {
    const { startDelay, ratePerSec, minScale } = eff.shrink;
    const t = Math.max(0, elapsedSec - startDelay);
    scale = Math.max(minScale, 1 - t * ratePerSec);
  }

  if (shape.type === 'circle') {
    return { type: 'circle', cx: shape.cx, cy: shape.cy, r: shape.r * scale };
  }

  const b = arenaBounds(shape);
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  let pts = shape.points;
  if (scale !== 1) pts = scaledPoints(pts, scale, cx, cy);
  if (eff.rotationSpeedDeg) {
    pts = rotatedPoints(pts, eff.rotationSpeedDeg * elapsedSec, cx, cy);
  }
  return { type: 'poly', points: pts, scale, cx, cy };
}

/** 判断点是否在区域内（区域效果用） */
export function pointInZone(zone, x, y) {
  const s = zone.shape;
  if (s.kind === 'circle') {
    const dx = x - s.cx, dy = y - s.cy;
    return dx * dx + dy * dy <= s.r * s.r;
  }
  return x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h;
}

export function zoneLabel(zone) {
  if (zone.type === 'damage') return `${zone.name} · 每秒 ${zone.dps} 伤害`;
  if (zone.type === 'slow') return `${zone.name} · 减速 ${Math.round((1 - zone.mul) * 100)}%`;
  if (zone.type === 'haste') return `${zone.name} · 加速 ${Math.round((zone.mul - 1) * 100)}%`;
  return zone.name;
}

export function effectLabels(arena) {
  const out = [];
  const e = arena.effects || {};
  if (e.globalSpeedMul) out.push(`全场速度 ×${e.globalSpeedMul}`);
  if (e.shrink) out.push(`第 ${e.shrink.startDelay} 秒起持续收缩（最小 ${Math.round(e.shrink.minScale * 100)}%）`);
  if (e.rotationSpeedDeg) out.push(`场地以 ${e.rotationSpeedDeg}°/秒 旋转`);
  return out;
}

/* ------------------------------------------------------------
   场地整体缩放
   ------------------------------------------------------------
   把场地的几何（轮廓、区域效果范围、起始站位范围）统一按 size 缩放，
   中心点保持不变。用于"场地大小"选项。

   为什么需要它：碰撞频率与场地面积成反比。
   尺寸缩到 50% 时面积只剩 25%，相遇概率约提升 4 倍 ——
   所以默认 1v1 用半场就能显著提高交手频率。
   ------------------------------------------------------------ */
const CENTER_X = WORLD_W / 2;
const CENTER_Y = WORLD_H / 2;

export function scaleArena(arena, size) {
  if (!size || Math.abs(size - 1) < 1e-6) return arena;

  const shape = arena.shape;
  const scaledShape = shape.type === 'circle'
    ? { type: 'circle', cx: CENTER_X, cy: CENTER_Y, r: Math.round(shape.r * size) }
    : {
        type: 'poly',
        points: shape.points.map(([x, y]) => [
          Math.round(CENTER_X + (x - CENTER_X) * size),
          Math.round(CENTER_Y + (y - CENTER_Y) * size)
        ]),
        rotate: shape.rotate
      };

  const scaledZones = (arena.zones || []).map(z => {
    const s = z.shape;
    const ns = s.kind === 'circle'
      ? { kind: 'circle', cx: Math.round(CENTER_X + (s.cx - CENTER_X) * size),
          cy: Math.round(CENTER_Y + (s.cy - CENTER_Y) * size), r: Math.round(s.r * size) }
      : { kind: 'rect', x: Math.round(CENTER_X + (s.x - CENTER_X) * size),
          y: Math.round(CENTER_Y + (s.y - CENTER_Y) * size),
          w: Math.round(s.w * size), h: Math.round(s.h * size) };
    return { ...z, shape: ns };
  });

  return { ...arena, shape: scaledShape, zones: scaledZones, sizeScale: size };
}

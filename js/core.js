/* ============================================================
   core.js — 确定性战斗引擎（纯逻辑，不含任何渲染代码）
   ------------------------------------------------------------
   三条铁律，全部为"倍速播放 / 暂停回放 / 结果可复现"服务：
     1. 定点整数：所有物理量按 1/SCALE 存整数，不用浮点做状态。
     2. 固定时间步：逻辑恒为 60 帧/秒，与渲染帧率完全解耦。
     3. 逻辑与渲染分离：引擎只产出「快照 + 事件流」，不碰 canvas。
   ============================================================ */

import { SCALE, DT, WORLD_W, WORLD_H } from './balls.js';
import { effectiveShape, pointInZone, arenaCenter, scaleArena } from './arenas.js';
import { getSkill, SKILL_PARAMS, CHARGE_FRAMES, DASH_FRAMES, resolveLoadout } from './skills.js';

const TWO_PI = Math.PI * 2;

/* 快照步长：渲染层按这两个常数解析快照，不要再写死数字。
   改动这里就等于改动快照格式，所有读取方（render.js / ui-battle.js / 测试）会一起跟上。 */
export const SNAP_STRIDE = 16;
/* 弹道步长：
     0 x  1 y  2 r  3 剩余寿命比例 1~0  4 颜色下标  5 kind(0 特效 / 1 实体 / 2 光束)
     6 宽度  7 方向 x  8 方向 y  9 贴图下标(-1 = 无)  10 光束长度
   方向是给激光这类"长条"弹道画拖影用的 —— 速度 1000 的激光每帧走 16 单位，
   只画一个圆点会变成断断续续的虚线。它同时也是贴图弹道的**朝向**：
   箭矢要沿着飞行方向转，不然会横着飞。 */
export const PROJ_STRIDE = 11;
/* 场地物件步长（质点 / 细线 / 光门）：
     0 x  1 y  2 x2  3 y2  4 kind(0 质点 / 1 细线 / 2 光门)
     5 阶段  6 半径  7 半宽  8 剩余寿命比例
   **必须进快照**：否则渲染层只能读 battle.fields 的"最终状态"，
   把进度条拖回开头也会看到整局打完后的所有细线 ——
   看起来就像"细线在开局就凭空出现在场上"。 */
export const FIELD_STRIDE = 9;

/* 每帧持续伤害的事件上限。
   这类伤害一秒能产生几十上百条事件，如果不设上限会把事件流的
   6000 条总容量吃光，后面的死亡、开华、爆炸事件就全丢了。
   超过上限后伤害照常结算，只是不再发事件（画面上表现为飘字节流停止）。
   飘字本身的节流交给渲染层，**数值一律保持真实**。 */
export const MAX_TICK_EVENTS = 2500;

/* 场地物件的全局上限（安全阀，见 _updateFields 的说明）。
   正常对局远达不到这个数：裁光每个晕彩最多 8 条线。 */
export const MAX_FIELDS = 400;

/* 速度下限：被减速技能叠满时也不能把球钉死在地上（那样就是"卡住"了） */
export const MIN_SPEED = 20;

/* 陀螺每层带来的每秒旋转弧度。10 层 ≈ 每秒 1.9 圈。
   转速由层数驱动，所以"叠得越多转得越疯"是看得见的。 */
export const SPIN_RATE_PER_STACK = 1.2;

/* ------------------------------------------------------------
   定点正弦查表
   ------------------------------------------------------------
   偏转逻辑需要"把速度向量旋转若干度"。用查表而不是 Math.sin/cos，
   是为了让结果完全确定、跨平台一致（也更快）。
   表只存 0–90°，其余象限用对称性推导。
   ------------------------------------------------------------ */
const SIN_TABLE = (() => {
  const t = new Int32Array(91);
  for (let i = 0; i <= 90; i++) t[i] = Math.round(Math.sin((i * Math.PI) / 180) * SCALE);
  t[0] = 0;
  t[90] = SCALE;      // 强制精确，避免取整误差
  return t;
})();

/** sin(deg) × SCALE。deg 允许是小数（内部四舍五入到整数索引）。 */
function sinDeg(deg) {
  /* 注意：查表必须用整数索引。转向是"每秒 N 度"，每帧增量是个小数
     （例如 30/60 = 0.5 度），若直接用小数当索引，SIN_TABLE[0.5] 会是
     undefined，接着整条速度向量变成 NaN —— 小球直接消失且不报错。 */
  let d = Math.round(((deg % 360) + 360) % 360);
  if (d <= 90) return SIN_TABLE[d];
  if (d <= 180) return SIN_TABLE[180 - d];
  if (d <= 270) return -SIN_TABLE[d - 180];
  return -SIN_TABLE[360 - d];
}

/** cos(deg) × SCALE */
function cosDeg(deg) {
  return sinDeg(deg + 90);
}

/**
 * 把速度向量旋转 deg 度（正值 = 顺时针，与屏幕坐标系一致）。
 * 输入输出都是定点整数。
 */
function rotateVel(vx, vy, deg) {
  const c = cosDeg(deg);
  const s = sinDeg(deg);
  return {
    vx: Math.round((vx * c - vy * s) / SCALE),
    vy: Math.round((vx * s + vy * c) / SCALE)
  };
}

/* ------------------------------------------------------------
   可控随机数：同种子必然产生同一串数列
   ------------------------------------------------------------ */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------
   几何判定（定点整数，无浮点状态）
   ------------------------------------------------------------ */

/** 凸多边形射线法：点是否在多边形内 */
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

/** 供测试直接调用：把越界的点推回场地内 */
export function clampToShapeForTest(shape, x, y, radius) {
  return clampToShape(shape, x, y, radius);
}

/**
 * 把越界的点推回场地内，并返回是否发生了修正。
 * 采用「最小穿透方向」：找到穿透最浅的那条边，沿其外法线推回。
 * 返回值 scale 为定点倍数（即真实距离 × SCALE）。
 */
function clampToShape(shape, x, y, radius) {
  if (shape.type === 'circle') {
    const dx = x - shape.cx * SCALE;
    const dy = y - shape.cy * SCALE;
    const rr = shape.r * SCALE;
    const d2 = dx * dx + dy * dy;
    const limit = rr - radius;
    if (limit <= 0) return { x: shape.cx * SCALE, y: shape.cy * SCALE, hit: true, nx: 0, ny: 0 };
    if (d2 <= limit * limit) return { x, y, hit: false, nx: 0, ny: 0 };
    const d = Math.sqrt(d2) || 1;
    /* 法线约定：必须与多边形分支一致，取「指向场内」的内法线。
       圆内一点在场内方向是「从球指向圆心」，所以这里要取负号。
       写反的后果很隐蔽：vn < 0 永不成立，小球撞到圆周后速度不反射，
       会沿着圆周一直滑下去，表现为"绕着圈子跑、永远打不到人"。 */
    const nx = Math.round((-dx * SCALE) / d);
    const ny = Math.round((-dy * SCALE) / d);
    return {
      x: shape.cx * SCALE + Math.round((-nx * limit) / SCALE),
      y: shape.cy * SCALE + Math.round((-ny * limit) / SCALE),
      hit: true, nx, ny
    };
  }

  const pts = shape.points;
  const n = pts.length;

  // 先判断是否已在内部
  if (pointInConvex(pts, Math.round(x / SCALE), Math.round(y / SCALE))) {
    // 找出离哪条边最近
    let deepest = null;
    for (let i = 0; i < n; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % n];
      const ex = x2 - x1, ey = y2 - y1;
      const len2 = ex * ex + ey * ey || 1;
      const len = Math.sqrt(len2);
      // 点到边的有符号距离（内部为正）；用定点放大避免精度丢失
      const crossRaw = (ex * (y - y1 * SCALE) - ey * (x - x1 * SCALE)) / SCALE;
      const dist = (crossRaw / len) * SCALE; // 距离 × SCALE
      if (deepest === null || dist < deepest.dist) {
        deepest = {
          dist, len,
          nx: Math.round((-ey * SCALE) / len),
          ny: Math.round((ex * SCALE) / len)
        };
      }
    }

    /* 关键：判定必须带容差。小球被吸附到恰好 dist === radius 的位置后，
       严格小于号永远不成立，速度再也不会反射，于是贴墙滑到角落卡死。
       这里用 radius + 1 判定（见下），并把球吸附到 radius + 2 的位置。 */
    if (deepest && deepest.dist < radius + 1) {
      return {
        x, y,
        hit: true, nx: deepest.nx, ny: deepest.ny
      };
    }
    return { x, y, hit: false, nx: 0, ny: 0 };
  }

  // 在外部：沿质心方向拉回来（凸多边形下这是稳定且可预测的修正）
  let cx = 0, cy = 0;
  for (const [px, py] of pts) { cx += px; cy += py; }
  cx = (cx / n) * SCALE;
  cy = (cy / n) * SCALE;
  const dx = cx - x, dy = cy - y;
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = Math.round((dx * SCALE) / d);
  const ny = Math.round((dy * SCALE) / d);
  // 逐步拉回，最多 60 步，避免大位移
  let px = x, py = y;
  for (let i = 0; i < 60; i++) {
    px += Math.round((nx * 8 * SCALE) / SCALE);
    py += Math.round((ny * 8 * SCALE) / SCALE);
    if (pointInConvex(pts, Math.round(px / SCALE), Math.round(py / SCALE))) break;
  }
  return { x: Math.round(px), y: Math.round(py), hit: true, nx, ny };
}

/**
 * 把速度的方向保留、幅度还原到指定值。
 * 用于抵消定点法线取整带来的速率误差（完全弹性碰撞应严格守恒）。
 */
function restoreSpeed(u, targetSpeed) {
  const cur = Math.hypot(u.vx, u.vy);
  if (cur < 1 || targetSpeed < 1) return;
  if (Math.abs(cur - targetSpeed) <= 0.5) return;
  const k = targetSpeed / cur;
  u.vx = Math.round(u.vx * k);
  u.vy = Math.round(u.vy * k);
}

/** 两球是否重叠 */
function overlapping(A, B) {
  const dx = B.x - A.x, dy = B.y - A.y;
  const rr = A.r + B.r;
  return dx * dx + dy * dy < rr * rr;
}

/* ------------------------------------------------------------
   造球：初始站位
   ------------------------------------------------------------ */
function buildUnits(config, rnd) {
  const { teams, arena } = config;
  const shape = arena.shape;
  const center = arenaCenter(shape);
  const { minX, maxX, minY, maxY } = (() => {
    if (shape.type === 'circle') {
      return { minX: shape.cx - shape.r, maxX: shape.cx + shape.r,
               minY: shape.cy - shape.r, maxY: shape.cy + shape.r };
    }
    const xs = shape.points.map(p => p[0]);
    const ys = shape.points.map(p => p[1]);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  })();

  const units = [];
  const nTeams = teams.length;

  /* ------------------------------------------------------------
     队内站位：绕锚点做环形分布 + 带边界检查的螺旋搜索兜底。
     ------------------------------------------------------------
     为什么要兜底：小球半径翻倍后，单纯按环形排开会把靠外的球推出场地，
     被夹紧拉回后又和相邻的球叠在一起。螺旋搜索会逐个找"既在场内、
     又不与已放置的球重叠"的位置，放不下才退让（并放宽间距要求）。
     ------------------------------------------------------------ */
  const placed = [];                           // 已放置的球（含 r）
  // 开局时的场地几何（尚未开始收缩/旋转）
  const spawnShape = effectiveShape(arena, 0);

  /** 该位置是否可用：在场内、且与已放置的球保持 minGap 间距 */
  function spotOk(x, y, r, minGap) {
    const c = clampToShape(spawnShape, Math.round(x * SCALE), Math.round(y * SCALE), r * SCALE);
    if (c.hit) return false;                   // 贴到边界了，说明位置不够
    for (const p of placed) {
      const dx = x - p.x, dy = y - p.y;
      const need = r + p.r + minGap;
      if (dx * dx + dy * dy < need * need) return false;
    }
    return true;
  }

  teams.forEach((team, ti) => {
    // 多队时按圆周均匀分布起始方位；2 队时左右对峙
    let baseAngle;
    if (nTeams === 2) {
      baseAngle = ti === 0 ? Math.PI : 0;
    } else {
      baseAngle = (ti / nTeams) * TWO_PI - Math.PI / 2;
    }
    const count = team.units.length;
    // 本队锚点：距场地中心 74% 半径处，2 队时即左右对峙
    const radiusX = (maxX - minX) / 2 * 0.74;
    const radiusY = (maxY - minY) / 2 * 0.74;
    const anchorX = center.x + Math.cos(baseAngle) * radiusX;
    const anchorY = center.y + Math.sin(baseAngle) * radiusY;

    team.units.forEach((u, ui) => {
      const r = u.stats.r;
      // 首选位置：绕锚点的环形分布（球多时更紧凑）
      const ring = count > 1
        ? Math.max(r * 1.8, (r * 2.6) / (2 * Math.sin(Math.PI / count)))
        : 0;
      const a0 = (ui / Math.max(1, count)) * TWO_PI;
      const jx = (rnd() - 0.5) * r * 0.8;
      const jy = (rnd() - 0.5) * r * 0.8;
      const prefX = anchorX + Math.cos(a0) * ring + jx;
      const prefY = anchorY + Math.sin(a0) * ring + jy;

      /* 螺旋搜索：从首选位置向外找第一个可用点。
         逐步放宽"最小间距"要求，保证球多、场地小时也一定能放下。 */
      let x = prefX, y = prefY;
      let found = false;
      for (const minGap of [10, 6, 3, 1, 0]) {
        if (spotOk(prefX, prefY, r, minGap)) { x = prefX; y = prefY; found = true; break; }
        search:
        for (let step = 0; step < 40 && !found; step++) {
          const rad = (step + 1) * r * 0.7;
          const n = 8 + step * 2;
          for (let k = 0; k < n; k++) {
            const ang = (k / n) * TWO_PI;
            const cx = prefX + Math.cos(ang) * rad;
            const cy = prefY + Math.sin(ang) * rad;
            if (spotOk(cx, cy, r, minGap)) { x = cx; y = cy; found = true; break search; }
          }
        }
        if (found) break;
      }
      if (!found) {
        // 极端拥挤：退回首选位置并夹回场内，交给下面的重叠消解处理
        const c = clampToShape(spawnShape, Math.round(prefX * SCALE), Math.round(prefY * SCALE), r * SCALE);
        x = c.x / SCALE; y = c.y / SCALE;
      }

      const st = u.stats;
      units.push({
        id: units.length,
        slot: u.slot ?? units.length,   // 准备界面给的槽位号，用于指定玩家操控目标
        team: ti,
        speciesId: st.speciesId,
        name: st.name,
        color: st.color,
        sticker: st.sticker || null,   // 小球贴图（无则按颜色画圆）
        bow: st.bow || null,           // 手持物件（弓），与球体贴图分开绘制
        domain: st.domain || null,     // 辉光领域的背景层配置（只有晕彩有）
        maxHp: st.maxHp,
        hp: st.maxHp,
        r: Math.round(st.r * SCALE),
        /* 质量按面积计（半径平方）。两球对撞时质量决定各自被弹开的程度，
           所以大球撞小球会把小球弹得更远，符合直觉。 */
        mass: Math.max(1, Math.round(st.r * st.r)),
        speed: Math.round(st.speed * SCALE),
        melee: st.melee,
        reach: st.reach,
        resMax: st.resource ? st.resource.max : 0,
        res: st.resource ? (st.resource.init || 0) : 0,
        resDef: st.resource,
        isPlayer: false,
        // 定点位置与速度
        x: Math.round(x * SCALE),
        y: Math.round(y * SCALE),
        vx: 0, vy: 0,
        spawnX: Math.round(x * SCALE),
        spawnY: Math.round(y * SCALE),
        ax: 0, ay: 0,          // 本帧的操控意图方向（单位向量 ×SCALE）
        alive: true,
        respawnAt: 0,
        hitCd: 0,              // 攻击冷却（同一小球两次造成伤害的最小间隔）
        flash: 0,              // 受击闪烁剩余时间
        kills: 0, dmg: 0, taken: 0,
        damageFrom: {},        // 按来源分类的承伤，用于战后归因
        /* 技能系统 */
        /* 技能列表：过一遍互斥整理。
           引擎是权威口径 —— 即使界面漏了（或存档是手改的），
           互斥的两个技能也不会同时生效，避免"界面显示装了 2 个、
           实际只有 1 个在跑"这种两边不一致的静默故障。 */
        skills: resolveLoadout(st.skills),
        skillCd: {},           // 各技能的剩余冷却
        hitsTaken: 0, hitsDealt: 0,  // 撞击次数统计（供"次数触发"类技能使用）
        hpBelowFired: {},      // 血量触发类技能的去重标记
        mode: 'normal',        // normal | charging | dashing
        chargeFrames: 0,       // 蓄力剩余【帧数】（整数，见 skills.js 的说明）
        dashFrames: 0,         // 加速状态剩余【帧数】
        dashVx: 0, dashVy: 0,  // 加速方向（单位向量 ×SCALE）
        dashHits: new Set(),   // 本次冲刺已伤过的目标，避免来回反复吃伤害
        // 技能系统预留：冷却表与状态标记
        cd: {}, flags: {},

        /* ---------- 技能用扩展字段 ----------
           这些都是"技能系统需要但物理层不关心"的状态，
           默认值必须能表达"什么都没发生"，这样没装相关技能的球完全不受影响。 */
        /* baseSpeed / baseMelee 一律用**世界单位**（和 speedBonus / speedSlow /
           speedPer 这些技能参数同一套单位）。
           踩过：曾经把 baseSpeed 存成定点数（120000）而 speedBonus 是世界单位（2），
           两者一加就成了 120002 世界单位 —— 球会瞬间飞到场地外去。
           u.speed 仍然是定点数（物理层用），两套单位在 refreshSpeed 里对齐。 */
        baseSpeed: st.speed,
        baseMelee: st.melee,   // 球种原始碰撞伤害（同理，之后不再改）
        meleeLock: null,       // 非 null 时碰撞伤害被锁死在这个值（吸血习性）
        meleeBonus: 0,         // 技能给的碰撞伤害加成（折光 +100、开华 +50）
        spinMeleeBonus: 0,     // 陀螺逐层叠加的碰撞伤害
        /* 速度的三种修正分开记，互不覆盖（见 setSpeed/refreshSpeed 的说明）：
             speedOverride 绝对覆盖（开华的"速度提高到 N"）
             speedBonus    加法加成（陀螺每层 +2）
             speedSlow     减法减益（映霞[枯] 命中 -20，带时限） */
        speedOverride: null,
        speedBonus: 0,
        speedSlow: 0,
        speedSlowFrames: 0,
        /* 移速**乘子**（吸血的"移速降低一半"用）。
           与 speedSlow 的区别：那个是加法减益（-20），这个是整体打对折。
           两套分开记，互不覆盖 —— 和上面三种修正是同一个道理。 */
        speedMul: 1,
        bloomed: false,        // 是否已"开华"（形态强化）
        /* 陀螺：被"真正的打击"时叠层，层数同时驱动回血、碰撞伤害、移速与旋转 */
        spinStacks: 0,
        spinAngle: 0,          // 累计旋转角（弧度）—— 渲染层用它转贴图
        healAcc: 0,            // 回血余数累积（按"每秒 N 点"时不能每帧都取整）
        healed: 0,             // 累计回复量（战后统计用）
        dodge: 0,              // 闪避概率 0~1（辉光领域）
        stealthFrames: 0,      // 隐身剩余帧数（折光）
        /* 近战免疫剩余帧数（吸血习性：吸附期间不受碰撞伤害）。
           与 stealthFrames 分开：隐身是"看不见 + 免近战"，
           这个是"被缠住了所以打不到" —— 表现和来源都不同。 */
        meleeImmuneFrames: 0,
        /* 沉默剩余帧数：不能发动技能，**但撞墙触发的技能照常**
           （作者原文："除碰撞墙体使用的技能以外"）。 */
        silencedFrames: 0,
        /* 吸附：{ targetId, untilFrame } —— 由技能写入，引擎负责把位置按在目标身上 */
        latch: null,
        damageMul: st.damageMul ?? 1,   // 伤害倍率（析光分身 = 1/3）
        lightBonus: 0,         // "光"特质攻击的附加伤害（开华 +50）
        summoner: st.summoner ?? -1,    // 召唤它的单位 id（-1 = 原生单位）
        stickerBloom: st.stickerBloom || null,  // 开华形态的贴图
        /* ---------- 动作动画（拉弓 / 蓄势）----------
           快照 13 / 14 位的数据源。默认值必须表达"什么都没发生"：
           castP = 0 表示不在施法，aimAngle = 0 表示没在瞄谁。 */
        castP: 0,              // 施法进度 0~1（1 = 这一帧就要射出去）
        castKind: 0,           // 施法变体：0 普通 / 1 五连发（见快照第 15 位）
        aimAngle: 0,           // 瞄准角（角度制），朝最近的敌人
        hasWindup: false,      // 装了带 windup 的技能 → 每帧要算 castP
        needsAim: false,       // 装了瞄准类技能 → 每帧要算 aimAngle
      });
    });
  });

  // 指定玩家操控的小球
  if (config.rules.playerControl && units.length) {
    let target = null;
    if (config.playerSlot !== null && config.playerSlot !== undefined) {
      target = units.find(u => u.slot === config.playerSlot) || null;
    }
    target = target || units[0];
    target.isPlayer = true;
    config.playerUnitId = target.id;
  }

  /* ---------- 开局初速：给每个球一个方向随机、力道相等的力 ----------
     力道 = 该球种的移速 × 全局倍率（所以"力道相等"是指同球种之间相等，
     不同球种仍保留各自的移速差异）。
     方向来源：
       random —— 由种子驱动的随机角（同一颗种子必然得到同一套方向）
       custom —— 使用 rules.customAngles 里逐个指定的角度
     方向默认朝场地中心一侧偏转，避免开局直接撞墙浪费十几秒。 */
  const speedScale = config.rules.speedScale ?? 1;
  const centerX = shape.type === 'circle' ? shape.cx : (minX + maxX) / 2;
  const centerY = shape.type === 'circle' ? shape.cy : (minY + maxY) / 2;
  const mode = config.rules.spawnMode || 'random';
  const custom = config.rules.customAngles || [];

  units.forEach((u, i) => {
    // 1) 先算「指向场地中心」的基准角
    const toCenter = Math.atan2(centerY - u.y / SCALE, centerX - u.x / SCALE);

    // 2) 决定本球的冲量方向
    let ang;
    if (mode === 'custom' && typeof custom[i] === 'number' && isFinite(custom[i])) {
      ang = (custom[i] * Math.PI) / 180;
    } else {
      // 以"朝中心"为基准，在 ±110° 内随机偏转：
      // 既保证开局会往场地里走，又保证每球方向不同、不会整齐冲向同一点。
      // 随机数取自本局的种子流，因此同种子必然得到同一套开局方向。
      const jitter = (rnd() - 0.5) * 2 * (110 * Math.PI / 180);
      ang = toCenter + jitter;
    }

    const spd = Math.round(u.speed * speedScale);
    const nx = Math.cos(ang);
    const ny = Math.sin(ang);
    u.spawnAngle = ((ang * 180) / Math.PI + 360) % 360;
    u.vx = Math.round(nx * spd);
    u.vy = Math.round(ny * spd);
  });

  /* ---------- 开局站位后处理：把残留重叠解开 ----------
     环形+螺旋放置已经把绝大多数情况排开了；这里再跑几轮分离，
     专门处理"两队锚点靠近"或"球特别多"时的残余重叠。 */
  for (let pass = 0; pass < 12; pass++) {
    let moved = 0;
    for (let i = 0; i < units.length; i++) {
      for (let j = i + 1; j < units.length; j++) {
        const A = units[i], B = units[j];
        const dx = B.x - A.x, dy = B.y - A.y;
        const rr = A.r + B.r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2) || 1;
        // 开局时两队是分开的，不需要按质量分配，各退一半即可
        const push = Math.round((rr - d) / 2) + 1;
        const px = Math.round((dx / d) * push);
        const py = Math.round((dy / d) * push);
        A.x -= px; A.y -= py;
        B.x += px; B.y += py;
        moved++;
      }
    }
    // 推完拉回场地内，并同步刷新出生点
    for (const u of units) {
      const c = clampToShape(spawnShape, u.x, u.y, u.r);
      u.x = c.x; u.y = c.y;
    }
    if (moved === 0) break;
  }
  for (const u of units) { u.spawnX = u.x; u.spawnY = u.y; }

  return units;
}
/* ------------------------------------------------------------
   Battle —— 一次性算完整局，并录制成快照序列
   ------------------------------------------------------------ */
export class Battle {
  /**
   * @param {object} config
   *   { teams: [{units:[{stats}]}], arena, rules, seed }
   */
  constructor(config) {
    this.config = config;
    /* 场地大小：把场地几何整体缩放。
       碰撞频率与场地面积成反比，所以尺寸缩一半约等于交手频率提升 4 倍。 */
    this.sizeScale = config.sizeScale ?? 1;
    this.arena = scaleArena(config.arena, this.sizeScale);
    this.rules = config.rules;
    this.seed = config.seed >>> 0;
    this.rnd = mulberry32(this.seed);

    this.units = buildUnits({ ...config, arena: this.arena }, this.rnd);
    this.n = this.units.length;

    this.frame = 0;
    this.time = 0;
    this.over = false;
    this.winner = -1;          // -1 未结束；-2 平局
    this.endReason = '';

    // 快照与事件
    this.snapshots = [];
    this.events = [];
    this.zoneAccum = new Map();  // 区域持续伤害的余数累积，保证每秒伤害准确
    this.pairCd = new Map();     // 成对碰撞冷却
    this.pairKeyBase = this.n * 1000;

    this.maxFrames = Math.round(300 / DT); // 安全上限：最多模拟 5 分钟

    /* 这里曾经有一个"僵局破解器"：长时间无伤害就逐步放大伤害倍率，
       僵持更久还会让全场按最大生命百分比缓慢掉血（"饥饿"）。
       它已经被移除 —— 那是物理还有 bug 时的兜底手段。
       当年真正的问题是"两球互相顶着永远碰不到 / 沿墙滑到角落停死"，
       修好撞墙偏转与逐帧微转向之后，物理本身就能收敛：
       实测（tests/diag/finish-rate.mjs）13 个场地 × 3 种规模 × 4 个种子
       = 156 场全部自然打出结果，中位 12.7 秒、最长 55 秒，零僵局。
       所以现在**伤害就是属性表 / 技能表里写的那个数**，
       不会被任何机制悄悄放大（以前冲刺伤害会被放大到 500 就是这么来的）。 */

    /* -------- 弹道（实体类技能产物）--------
       与小球同样是定点数实体，参与确定性模拟；
       会随时间衰减、撞墙消失，也可以被别的东西命中而消失。 */
    this.projectiles = [];
    this.nextProjectileId = 1;
    /* 弹道颜色调色板：快照里只存下标，避免每帧快照都带字符串。
       颜色种类很少（每个技能一种），查表还原即可。 */
    this.projPalette = [];
    this.projSpritePalette = [];
    /* 时间停止（公主传承1）：战场级状态，不是单位状态 ——
       它同时影响"谁能动、谁能开火、谁的冷却在走"。
       ownerId 是唯一豁免者（-1 = 没在停止中）。 */
    this.timeStopUntil = 0;
    this.timeStopOwner = -1;
    this.projSpriteKeys = [];

    /* -------- 场地物件（裁光的质点·细线 / 棱镜的光门）--------
       与弹道的区别：弹道会飞、碰到就消失；场地物件待在原地，
       有寿命或阶段状态，并且可以"每帧持续造成伤害"（裁光的质点与细线）。
       统一放一个列表，由 _updateFields() 每帧推进。 */
    this.fields = [];
    this.nextFieldId = 1;
    /* "全场生效"类效果的开关（辉光领域）：技能开启它，渲染层据此铺极光 */
    /* 辉光领域（晕彩）。
       aurora 是"领域是否已生效"；auroraAt / auroraCenter / auroraStyle 是
       渲染层画展开动画要用的三个量。它们**只在激活那一刻写一次**，
       之后不再变 —— 静态量不需要每帧进快照，和 aurora 这个布尔量同理。
       （每帧变的量才必须进快照，否则暂停/拖动进度条会对不上。） */
    this.aurora = false;
    this.auroraAt = -1;            // 激活发生在第几帧
    this.auroraCenter = null;      // 气浪的中心（定点坐标）
    this.auroraStyle = null;       // 美术配置（来自球种的 domain 字段）

    /* 每帧持续伤害已经发过多少条事件（见 MAX_TICK_EVENTS） */
    this.tickEvents = 0;

    /* 本帧内每个小球要结算的"接触伤害倍率"。
       charge 表示蓄力；dash 表示加速冲刺（碰撞伤害提升到 SKILL_PARAMS.dash.damage，
       并且命中时把对手推远）。 */
    this.contactBoost = new Map();

    /* -------- 常驻被动技能：开局结算一次 --------
       有些技能不是"到点发动"，而是"装上就一直生效"：
         · 折光 —— 把碰撞伤害从 0 改成 100；
         · 辉光领域 —— 全场极光 + 10% 闪避。
       它们由技能自己声明 passive(battle, unit)，在开战瞬间执行一次。
       放在这里而不是 step() 里，是为了让第一帧的快照就带上效果
       （否则渲染层第一帧会画出一个还没变身的球）。 */
    for (const u of this.units) this._initUnitSkills(u);

    this._record();
  }

  /* ---------- 安装单位的技能：被动一次 + 钩子登记 ----------
     两条路径都要用（开局的单位 / 战斗中召唤出来的分身），
     所以抽成一个方法 —— 之前召唤路径漏了 hooks 字段，一用就崩。 */
  _initUnitSkills(u) {
    u.hooks = u.hooks || {};
    /* 动作动画的两个开关也在装技能时定下来，避免每帧遍历技能表。
       只有声明了相应参数的技能才会打开 —— 没装的球这两个字段恒为 0，
       不花任何代价，也不会在快照里凭空多出瞄准角。 */
    u.hasWindup = false;
    u.needsAim = false;
    for (const id of u.skills || []) {
      const sk = getSkill(id);
      if (!sk) continue;
      if (sk.windup > 0) u.hasWindup = true;
      if (sk.aims) u.needsAim = true;
      if (typeof sk.passive === 'function') sk.passive(this, u);
      if (sk.hooks) {
        for (const name in sk.hooks) {
          if (!u.hooks[name]) u.hooks[name] = [];
          u.hooks[name].push(sk.hooks[name]);
        }
      }
    }
    /* 没装瞄准类技能（映霞）就不拿弓 —— 一个只带春景/陀螺的桃夭
       不该举着一张弓。放在这里判：引擎是权威口径，渲染层只读结论。 */
    if (!u.needsAim) u.bow = null;
  }

  /* ---------- 当前几何 ---------- */
  shape() {
    const shrink = this.rules.allowShrink ? this.arena.effects?.shrink : null;
    const arena = shrink
      ? this.arena
      : { ...this.arena, effects: { ...(this.arena.effects || {}), shrink: null } };
    return effectiveShape(arena, this.time);
  }

  /* ---------- 快照 ----------
     快照是渲染层唯一的数据来源：渲染器只读快照 + 事件流，
     不碰引擎内部状态，所以暂停 / 倍速 / 回放都能直接工作。
     因此"想在画面上看到的东西"必须进快照 —— 弹道和蓄力进度也不例外。

     小球步长 SNAP_STRIDE：
       0 x  1 y  2 hp  3 alive  4 flash  5 res  6 face
       7 mode(0 普通 / 1 蓄力 / 2 冲刺)  8 蓄力进度 0~1  9 冲刺进度 0~1
      10 隐身中(0/1)  11 开华中(0/1)  12 旋转角(弧度)
      13 施法进度 0~1（"拉弓"这类**射出前**的动作，见下）
      14 瞄准角(角度制，朝最近的敌人)
      15 施法变体(0 普通 / 1 五连发；同一种动作的不同版本)
       旋转角进快照而不是让渲染层自己按时间算 —— 后者在暂停/回放时会对不上，
       和当初"场地物件没进快照"是同一类错误。

      13 / 14 是为了"射出前的动作"（拉弓、蓄势）而加的。为什么必须由引擎算：
        · 渲染层只读快照，它**看不到技能冷却还剩多久**，
          所以无从知道"还有 0.4 秒就要射箭了"；
        · 若让渲染层按 performance.now() 自己推算，一按暂停弓就一直拉着不放。
      瞄准角也**不能复用 face**：face 是"当前运动方向"，
      而瞄准是"朝最近的敌人" —— 一边飞一边瞄时这两个方向不是一回事。
     弹道步长 PROJ_STRIDE：
       0 x  1 y  2 r  3 剩余寿命比例 1~0  4 颜色下标  5 kind(0 特效 / 1 实体)
       6 宽度  7 方向x  8 方向y  9 贴图下标(-1 无)
     ------------------------------------------------------------ */
  _record() {
    const n = this.n;
    const buf = new Float64Array(n * SNAP_STRIDE);
    for (let i = 0; i < n; i++) {
      const u = this.units[i];
      const o = i * SNAP_STRIDE;
      buf[o] = u.x / SCALE;
      buf[o + 1] = u.y / SCALE;
      buf[o + 2] = u.hp;
      buf[o + 3] = u.alive ? 1 : 0;
      buf[o + 4] = u.flash;
      buf[o + 5] = u.res;
      buf[o + 6] = u.face ?? 0;
      buf[o + 7] = u.mode === 'charging' ? 1 : (u.mode === 'dashing' ? 2 : 0);
      buf[o + 8] = u.chargeFrames > 0 ? 1 - u.chargeFrames / CHARGE_FRAMES : 0;
      buf[o + 9] = u.dashFrames > 0 ? 1 - u.dashFrames / DASH_FRAMES : 0;
      buf[o + 10] = u.stealthFrames > 0 ? 1 : 0;
      buf[o + 11] = u.bloomed ? 1 : 0;
      buf[o + 12] = u.spinAngle || 0;
      /* 施法进度：给"射出前的动作"提供时间基准（拉弓、蓄势）。
         不用 u.mode —— mode 现在只有 蓄力/冲刺 两种（那是移动状态机），
         拉弓是**攻击**的前置动作，两回事，混在一起会把移动状态机搞乱。 */
      buf[o + 13] = u.castP || 0;
      buf[o + 14] = u.aimAngle ?? 0;
      /* 15 施法变体：同一种前置动作的不同版本。
         目前只有映霞[荣] 用到 —— 0 = 普通单发，1 = 这一发是五连发。
         五连发和单发的**前置动作时长完全一样**，光看 castP 分不出来，
         但画面上要"多排四根箭"，所以必须由引擎额外告诉渲染层。 */
      buf[o + 15] = u.castKind || 0;
    }

    // 弹道：只有存在弹道时才分配，绝大多数帧是 null
    let proj = null;
    const live = this.projectiles.filter(p => p.alive);
    if (live.length) {
      proj = new Float64Array(live.length * PROJ_STRIDE);
      for (let i = 0; i < live.length; i++) {
        const p = live[i];
        const o = i * PROJ_STRIDE;
        proj[o] = p.x / SCALE;
        proj[o + 1] = p.y / SCALE;
        proj[o + 2] = p.r / SCALE;
        proj[o + 3] = p.maxLife > 0 ? Math.max(0, p.life / p.maxLife) : 1;
        proj[o + 4] = this._projColorIndex(p.color);
        /* 0 = 特效弹 / 1 = 实体弹 / 2 = 光束（渲染成圆柱体光柱） */
        /* 0 特效 / 1 实体 / 2 光束（向后画拖影）/ 3 锚定光柱（向前画） */
        proj[o + 5] = p.beamForward ? 3 : (p.beam ? 2 : (p.kind === 'body' ? 1 : 0));
        /* p.w 统一以**世界单位**存放（见 _spawnProjectile），不再除 SCALE */
        proj[o + 6] = p.w;
        const sp = Math.hypot(p.vx, p.vy) || 1;
        proj[o + 7] = p.vx / sp;
        proj[o + 8] = p.vy / sp;
        /* 9 = 贴图下标（-1 = 没有，渲染成程序化光点）。
           贴了一张图就按 dirX/dirY 转着画 —— 箭矢靠这个画成真箭。 */
        proj[o + 9] = p.spriteIdx ?? -1;
        proj[o + 10] = p.beamLen || 0;
      }
    }

    /* 场地物件：只有存在时才分配，绝大多数帧是 null */
    let fld = null;
    const liveF = this.fields.filter(f => f.alive);
    if (liveF.length) {
      fld = new Float64Array(liveF.length * FIELD_STRIDE);
      for (let i = 0; i < liveF.length; i++) {
        const f = liveF[i];
        const o = i * FIELD_STRIDE;
        fld[o] = f.x / SCALE;
        fld[o + 1] = f.y / SCALE;
        fld[o + 2] = f.x2 / SCALE;
        fld[o + 3] = f.y2 / SCALE;
        fld[o + 4] = f.kind === 'mote' ? 0 : (f.kind === 'line' ? 1 : 2);
        fld[o + 5] = f.stage;
        fld[o + 6] = f.r / SCALE;
        fld[o + 7] = f.halfW / SCALE;
        fld[o + 8] = f.maxLife > 0 ? Math.max(0, f.life / f.maxLife) : 1;
      }
    }
    /* ts = 时间停止的豁免者下标（-1 = 没在停止中）。
       放在快照对象上而不是每个单位身上：它是**战场级**状态，
       每个单位都存一份等于把同一个数抄 120 遍。
       渲染层据此把"除了 ts 之外的球"画成褪色的。 */
    this.snapshots.push({
      f: this.frame, data: buf, proj, fields: fld,
      ts: this.timeStopActive() ? this.timeStopOwner : -1,
    });
  }
  /** 弹道颜色 → 调色板下标（同一颜色只登记一次） */
  _projColorIndex(color) {
    let i = this.projPalette.indexOf(color);
    if (i < 0) { i = this.projPalette.length; this.projPalette.push(color); }
    return i;
  }
  /** 弹道贴图 → 调色板下标（同一张图只登记一次）
      与颜色调色板同一个套路：快照里只存一个下标，
      渲染层拿 battle.projSpritePalette[idx] 去取图。
      为什么不让渲染层自己按 tag 判断：tag 是引擎内部字段，没进快照。 */
  _projSpriteIndex(src, len) {
    if (!src) return -1;
    const key = src + '|' + (len || 0);
    let i = this.projSpriteKeys.indexOf(key);
    if (i < 0) {
      i = this.projSpriteKeys.length;
      this.projSpriteKeys.push(key);
      this.projSpritePalette.push({ src, len: len || 0 });
    }
    return i;
  }

  /* ---------- 单帧推进 ---------- */
  step(input) {
    if (this.over) return;
    const { units, rules } = this;
    const shape = this.shape();
    const speedMul = this.arena.effects?.globalSpeedMul ?? 1;

    /* --- 1) 冷却与计时 --- */
    this.contactBoost.clear();   // 每帧重建"本帧的接触伤害倍率"
    for (const u of units) {
      if (u.hitCd > 0) u.hitCd = Math.max(0, u.hitCd - DT);
      if (u.flash > 0) u.flash = Math.max(0, u.flash - DT);
      if (u.stealthFrames > 0) u.stealthFrames--;
      if (u.meleeImmuneFrames > 0) u.meleeImmuneFrames--;
      if (u.silencedFrames > 0) u.silencedFrames--;
      /* 吸附**不在这里清除**。
         踩过：原先这里到期就 u.latch = null，而这一句在计时段（phase 1），
         技能的 onThink 在 phase 2 —— 等技能醒来时 latch 已经没了，
         于是"松开时还原目标移速"那段永远不执行，目标被永久打对折。
         生命周期交给设置它的技能收尾（skills.js 的 tina_suck.onThink），
         引擎只负责"到期后不再把位置按上去"（见第 5.5 段）。 */

      /* 减速的时限（映霞[枯]：命中后移速 -20，持续 2 秒）到期就撤掉 */
      if (u.speedSlowFrames > 0) {
        u.speedSlowFrames--;
        if (u.speedSlowFrames === 0 && u.speedSlow) {
          u.speedSlow = 0;
          this.refreshSpeed(u);
        }
      }

      /* 旋转（陀螺）：层数越高转得越快。角度累加在这里，
         渲染层只读快照里的角度值 —— 这样暂停/回放时旋转也冻得住。 */
      if (u.spinStacks > 0) {
        u.spinAngle += SPIN_RATE_PER_STACK * u.spinStacks * DT;
        if (u.spinAngle > Math.PI * 2000) u.spinAngle -= Math.PI * 2000;  // 防止无限增长丢精度
      }
      /* 技能冷却。时间停止期间只有 owner 的冷却继续走 ——
         "技能冷却也停止"是作者确认过的口径。 */
      if (!this._frozenFor(u)) {
        for (const id in u.skillCd) {
          if (u.skillCd[id] > 0) u.skillCd[id] = Math.max(0, u.skillCd[id] - DT);
        }
      }

      /* --- 动作动画：施法进度 + 瞄准角（快照 13 / 14 位）---
         放在"冷却递减之后、技能发动之前"，于是：
           · 冷却刚归零的这一帧 castP 正好 = 1，与弹道生成同帧；
           · 下一帧冷却被重置成满值 → castP 掉回 0，动作自然收势。
         多个带 windup 的技能同时装时取"进度最大的那个"，
         因为画面上只有一份动作，谁的箭先出就摆谁的姿势。 */
      if (u.alive) {
        if (u.hasWindup) {
          let best = 0, kind = 0;
          for (const id of u.skills || []) {
            const sk = getSkill(id);
            if (!sk || !(sk.windup > 0) || !sk.trigger || sk.trigger.type !== 'cooldown') continue;
            const left = u.skillCd[id] || 0;
            if (left > sk.windup) continue;         // 还没进入拉弓区间
            const p = (sk.windup - left) / sk.windup;
            if (p >= best) {
              best = p;
              /* 技能可以声明"这一发是哪个变体"（映霞[荣]用它标五连发）。
                 取进度最大的那个技能的变体 —— 和 castP 同一个来源，
                 否则画面上会出现"进度是 A 的、变体是 B 的"。 */
              kind = typeof sk.castKind === 'function' ? (sk.castKind(u) | 0) : 0;
            }
          }
          u.castP = best;
          u.castKind = kind;
        } else {
          u.castP = 0;
          u.castKind = 0;
        }
        if (u.needsAim) {
          const t = this._nearestEnemy(u);
          if (t) {
            u.aimAngle = ((Math.atan2(t.y - u.y, t.x - u.x) * 180) / Math.PI + 360) % 360;
          }
          /* 没有敌人时**保留上一帧的角度**而不是归零：
             归零会让弓"啪"地转回右边，比保持不动难看得多。 */
        }
      } else {
        u.castP = 0;
        u.castKind = 0;
      }
      if (!u.alive && rules.respawn && this.frame >= u.respawnAt) {
        u.alive = true;
        u.hp = u.maxHp;
        u.x = u.spawnX; u.y = u.spawnY;
        // 复活时按原方向重新出发，保持"匀速直线"的世界规则
        const a = (u.spawnAngle * Math.PI) / 180;
        u.vx = Math.round(Math.cos(a) * u.speed);
        u.vy = Math.round(Math.sin(a) * u.speed);
        if (u.resDef) u.res = u.resDef.init || 0;
        this._emit('respawn', u, null, 0);
      }
    }

    /* --- 2) 区域效果、技能钩子与位置推进 ---
       默认模型：小球做匀速直线运动，只有碰撞才会改变方向。
       因此这里不再有"寻找最近敌人并朝它走"的 AI ——
       移动完全由速度向量决定。 */
    for (const u of units) {
      if (!u.alive) continue;

      /* 区域效果与场地加成 */
      let zoneMul = 1;
      for (const z of this.arena.zones || []) {
        if (!pointInZone(z, u.x / SCALE, u.y / SCALE)) continue;
        if (z.type === 'damage') {
          const key = `${u.id}:${z.id}`;
          const acc = (this.zoneAccum.get(key) || 0) + (z.dps * DT);
          const whole = Math.floor(acc);
          if (whole > 0) {
            this.zoneAccum.set(key, acc - whole);
            this._damage(null, u, whole, 'zone');
          } else {
            this.zoneAccum.set(key, acc);
          }
        } else if (z.type === 'slow') {
          zoneMul = Math.min(zoneMul, z.mul);
        } else if (z.type === 'haste') {
          zoneMul = Math.max(zoneMul, z.mul);
        }
      }

      /* 玩家操控：唯一允许主动改变方向的情形。
         不给"直接覆盖速度"，而是给一个转向加速度，这样仍然是"本体在直着走"，
         只影响方向，不至于让操控手感变得像开赛车。 */
      if (u.isPlayer && input && (input.dx || input.dy)) {
        const mag = Math.hypot(input.dx, input.dy) || 1;
        const accel = u.speed * 2.6;                 // 转向加速度上限
        u.vx += Math.round((input.dx / mag) * accel * DT);
        u.vy += Math.round((input.dy / mag) * accel * DT);
        this._clampSpeed(u, u.speed * 1.6);          // 防止无限加速
      }

      /* 技能钩子：给技能一次修改速度或触发效果的机会 */
      this._runHooks(u, 'onThink', { input });

      /* 冷却触发的技能（例如"每 2.5 秒发射一枚弹道"）。
         放在移动之前：发射位置取本帧开始时的位置，更好预测。 */
      this._runSkills(u, 'cooldown');

      /* 血量阈值与次数阈值的技能每帧都要检查一次。
         注意：这两类以前**根本没有分发点**，写了 onHpBelow 的技能永远不会发动
         （开华就是这么被漏掉的）。构造函数里的被动技能是另一条路，别混淆。 */
      this._runSkills(u, 'onHpBelow');
      this._runSkills(u, 'onHits');

      /* 冲刺收尾：上一帧跑完了最后一帧冲刺。
         放在冲刺分支之前，是为了让 mode === 'dashing' 的帧数正好等于
         DASH_FRAMES —— 否则最后一帧跑完就把 mode 改回 normal，
         状态帧数会少 1（冲刺看起来"只有 119 帧"）。 */
      if (u.mode === 'dashing' && u.dashFrames === 0) {
        u.mode = 'normal';
        const a = Math.atan2(u.dashVy, u.dashVx);
        u.vx = Math.round(Math.cos(a) * u.speed);
        u.vy = Math.round(Math.sin(a) * u.speed);
        this._emit('dashEnd', u, null, 0);
      }

      /* ---------- 蓄力 / 冲刺状态机 ----------
         charging：撞墙后停下蓄力，期间不移动（速度保持 0）
         dashing ：加速冲向对手，速度线性衰减回常速
         两者都由技能触发，这里只负责推进状态与速度。

         计时一律用【整数帧】：浮点秒数倒计时会留下 1e-15 级残渣，
         导致"2 秒蓄力"实际跑 121 帧（详见 skills.js 里的说明）。 */
      if (u.chargeFrames > 0) {
        u.chargeFrames--;                     // 本帧消耗一帧蓄力
        u.mode = 'charging';
        u.vx = 0; u.vy = 0;                   // 蓄力期间停止移动
        this.contactBoost.set(u.id, 'charging');
        this._runHooks(u, 'onMove', {});
        if (u.resDef && u.resMax > 0) u.res = Math.min(u.resMax, u.res + u.resDef.gainPerSec * DT);
        continue;                             // 蓄力期间跳过其余移动逻辑
      }

      /* 蓄力刚走完：瞄准最近的敌人转为冲刺。
         这里刻意不 continue —— 本帧就直接按冲刺速度动起来，
         否则蓄力与冲刺之间会多出一帧"站着不动"的空转帧。 */
      if (u.mode === 'charging') {
        const tgt = this._nearestEnemy(u);
        const ang = tgt
          ? Math.atan2(tgt.y - u.y, tgt.x - u.x)
          : ((u.face ?? 0) * Math.PI) / 180;
        u.dashVx = Math.round(Math.cos(ang) * SCALE);
        u.dashVy = Math.round(Math.sin(ang) * SCALE);
        u.dashFrames = DASH_FRAMES;
        u.mode = 'dashing';
        u.dashHits = new Set();
        this._emit('dashStart', u, tgt, SKILL_PARAMS.dash.dashTime);
      }

      /* 冲刺中：只设定本帧速度，位置推进交给下面统一做。
         历史 bug：这里原本是 continue，于是速度算得漂漂亮亮，
         位置却从来没被积分过 —— 球整个冲刺期间原地不动（位移 0.00），
         而且因为没动过，冲刺永远撞不到人（命中 0 次）。
         所以现在只跳过"转向 / 阻力 / 区域减速"这些修正，
         位移积分照旧执行。 */
      let dashing = false;
      if (u.dashFrames > 0) {
        const D = SKILL_PARAMS.dash;
        /* 速度线性衰减：从 startSpeedMul 倍常速降到 1 倍常速。
           本帧的 dashFrames 是"含本帧还剩几帧"，所以 t 从 1/DASH_FRAMES
           递增，最后一帧恰好 t = 1、速度回到常速。 */
        const t = 1 - (u.dashFrames - 1) / DASH_FRAMES;
        const mul = D.startSpeedMul + (D.endSpeedMul - D.startSpeedMul) * t;
        const spd = Math.round(u.speed * mul);
        u.vx = Math.round((u.dashVx * spd) / SCALE);
        u.vy = Math.round((u.dashVy * spd) / SCALE);
        this.contactBoost.set(u.id, 'dashing');
        u.dashFrames--;
        dashing = true;
      }

      /* 转向修正 / 阻力 / 区域速度缩放：冲刺期间一律不生效，
         冲刺的航向与速度只由技能自己的衰减曲线决定。 */
      if (!dashing) {
        /* 逐帧微转向：让航向缓慢朝最近的敌人修正。
           速度大小不变，只改方向，因此观感上仍是"直着走"。
           玩家操控时跳过（否则会和玩家的操作打架）。 */
        const steer = (this.rules.steerDegPerSec ?? 0) * DT;
        if (steer > 0 && !u.isPlayer) {
          this._deflectTowardEnemy(u, steer);
        }

        /* 空气阻力（默认 0，即永不减速，保持匀速直线） */
        const drag = this.rules.drag || 0;
        if (drag > 0) {
          const keep = Math.max(0, 1 - drag * DT);
          u.vx = Math.round(u.vx * keep);
          u.vy = Math.round(u.vy * keep);
        }

        /* 场地减速/加速区只缩放速度大小，不改变方向 */
        if (zoneMul !== 1) {
          const target = u.speed * (this.arena.effects?.globalSpeedMul ?? 1) * zoneMul;
          const cur = Math.hypot(u.vx, u.vy) || 1;
          if (cur > 0) {
            const k = target / cur;
            u.vx = Math.round(u.vx * k);
            u.vy = Math.round(u.vy * k);
          }
        }
      }

      this._runHooks(u, 'onMove', {});

      /* 位移：纯粹的匀速直线积分。
         时间停止期间被冻住的球**原地不动** —— 注意是"不积分"而不是"速度清零"：
         速度留着，停止结束后它会沿着原方向继续走，观感才像"暂停"而不是"刹住"。 */
      if (!this._frozenFor(u)) {
        u.x += Math.round(u.vx * DT);
        u.y += Math.round(u.vy * DT);
      }

      // 朝向由速度方向决定。约定：face 存「角度制」，与 spawnAngle 一致，
      // 避免同一字段在不同地方被当成弧度和角度两种含义。
      if (u.vx || u.vy) u.face = ((Math.atan2(u.vy, u.vx) * 180) / Math.PI + 360) % 360;

      /* 特殊资源积攒 */
      if (u.resDef && u.resMax > 0) {
        u.res = Math.min(u.resMax, u.res + u.resDef.gainPerSec * DT);
        this._runHooks(u, 'onResource', {});
      }
    }

    /* --- 3) 与边界碰撞：反射速度向量（撞墙反弹，速率不变） ---
       两个必须守住的细节：
       (1) 法线约定：c.nx/c.ny 是「指向场内」的内法线，
           所以小球正在朝墙撞去时 v·n 为负。符号写反会导致球贴墙滑行。
       (2) 顺序：必须先用「夹紧前的位置」拿到法线并完成反射，再去挪位置。
           若先夹紧再取法线，位置可能已被挪到另一条边上，
           拿到的法线就是错的，该反射的不反射，小球会一点点蹭掉速度
           （在菱形、八角这类斜边场地上尤其明显）。 */
    for (const u of units) {
      if (!u.alive) continue;
      const c = clampToShape(shape, u.x, u.y, u.r);
      if (!c.hit) continue;

      const vn = Math.round((u.vx * c.nx + u.vy * c.ny) / SCALE);
      if (vn < 0) {
        // 撞墙前的速率，反射后要精确还原（完全弹性 = 速率严格不变）
        const speedBefore = Math.hypot(u.vx, u.vy);

        // 镜面反射：v' = v − 2(v·n)n
        u.vx -= Math.round((2 * c.nx * vn) / SCALE);
        u.vy -= Math.round((2 * c.ny * vn) / SCALE);

        /* 把速率校正回撞墙前的值。
           必要性：斜边的内法线经过定点取整后不再是精确单位向量
           （45° 时长度约 0.707），反射会按 |n|² 缩放速度分量，
           多次撞击后小球会明显变慢（菱形场地实测能掉到 109/120）。
           直接归一化即可，物理含义就是"完全弹性碰撞不损失动能"。 */
        restoreSpeed(u, speedBefore);

        /* 撞墙后把航向朝最近的敌人偏转一点（默认最多 10 度）。
           这既让场面更容易收敛到交战，也省掉了"凭空扩大攻击范围"的假机制。 */
        const maxDeg = this.rules.wallDeflectDeg ?? 10;
        const turned = maxDeg > 0 ? this._deflectTowardEnemy(u, maxDeg) : 0;

        this._emit('wall', u, null, 0, { nx: c.nx, ny: c.ny, turned });

      }
      u.x = c.x; u.y = c.y;
      /* 撞墙触发的技能（例如"停止移动并蓄力"、"在墙上留下质点"）。
         放在**夹紧之后**：必须等球真的贴到墙面上再触发，
         否则技能拿到的位置是这一帧穿透进墙里的位置（最多差 2 个单位）。
         除了速度覆盖依然有效之外，还把"球与墙面的接触点"算好一起传过去：
         球心夹紧后离墙面还有 r 那么远，用球心当"撞墙点"是错的。 */
      if (vn < 0) {
        const nl = Math.hypot(c.nx, c.ny) || 1;
        const nx = c.nx / nl, ny = c.ny / nl;      // 指向场内的单位法线
        /* 接触点 = 球与墙面的接触位置。
           这里**不能**用"球心 ± 半径"或 clampToShape 的返回值去推 ——
           那两个分支的语义并不一致：
             · 多边形·在内部：返回的是球心原位置，和墙面还差一点点；
             · 多边形·在外部：返回的是"球心被拉回场内"的位置；
             · 圆形·在外部  ：返回的是球心该在的位置（离墙面整整一个半径）。
           照任何一种推都会偏，实测偏 5~16 个单位，质点看着根本没落在墙上。
           最稳的做法与分支无关：从球心沿"朝墙外"方向一格一格走，
           取最后一个仍在场地内的点 —— 那就是墙面。 */
        const step = 0.5;                          // 世界单位
        const maxD = u.r / SCALE + 4;
        let t = 0;
        for (let d = step; d <= maxD; d += step) {
          const px = Math.round(u.x - nx * d * SCALE);
          const py = Math.round(u.y - ny * d * SCALE);
          const cc = clampToShape(shape, px, py, 0);
          if (cc.x !== px || cc.y !== py) break;   // 出界，停在上一档
          t = d;
        }
        this._onWallTouch(u, {
          nx, ny,
          cx: (u.x - nx * t * SCALE) / SCALE,
          cy: (u.y - ny * t * SCALE) / SCALE,
        });
      }
    }

    /* --- 3.5) 弹道推进与命中（实体类技能的产物） --- */
    this._updateProjectiles(shape);

    /* --- 3.6) 场地物件（裁光的质点·细线 / 棱镜的光门） --- */
    this._updateFields(shape);

    /* --- 4) 球球碰撞：完全弹性碰撞，靠冲量自然分开 --- */
    this._collide();

    /* --- 5) 碰撞后可能在边界外，再约束一次 --- */
    for (const u of units) {
      if (!u.alive) continue;
      const c = clampToShape(shape, u.x, u.y, u.r);
      if (c.hit) { u.x = c.x; u.y = c.y; }
    }

    /* --- 5.5) 夹紧可能把几个球朝场地内堆到一起，造出新的穿透。
       这里只做位置分离（不再施加冲量，避免与第 4 步重复加能量），
       把由于夹紧产生的重叠解开 —— 否则那一帧末就会留下"叠着还在往里挤"的球对。 */
    this._relieveOverlap();

    /* --- 5.5) 吸附（吸血习性）---
       把吸附者按在目标身上：位置强制贴到"刚好接触"的地方。
       必须放在所有小球都位移完之后 —— 否则吸附者用的是目标**上一帧**的坐标，
       每帧慢一拍，看起来像橡皮筋。
       速度不清零：清了下一次 refreshSpeed 又会把它算回来，
       而且离开吸附的瞬间应该沿原方向继续飞（"甩开"的观感）。 */
    for (const u of units) {
      if (!u.alive || !u.latch) continue;
      if (this.frame >= u.latch.untilFrame) continue;   // 到期：不再按位置，等技能收尾
      const t = units[u.latch.targetId];
      if (!t || !t.alive) { u.latch = null; continue; }
      const dx = u.x - t.x, dy = u.y - t.y;
      const d = Math.hypot(dx, dy) || 1;
      const gap = u.r + t.r;
      u.x = Math.round(t.x + (dx / d) * gap);
      u.y = Math.round(t.y + (dy / d) * gap);
    }

    /* --- 6) 攻击结算：贴身则造成伤害 --- */
    this._resolveAttacks();


    /* --- 7) 胜负判定 ---
       这里原本还有一步"僵局破解"（放大伤害 + 全场饥饿掉血）。
       已移除：物理修好之后不再需要兜底，伤害数值保持干净。 */
    this._checkEnd();

    this.frame++;
    this.time = this.frame * DT;
    this._record();

    if (this.frame >= this.maxFrames && !this.over) {
      this.over = true;
      this.endReason = '达到模拟上限';
      this.winner = this._leaderByHp();
    }
  }

  /* ---------- 速度大小限制（玩家操控时防止无限加速） ---------- */
  _clampSpeed(u, maxSpeed) {
    const cur = Math.hypot(u.vx, u.vy);
    if (cur > maxSpeed && cur > 0) {
      const k = maxSpeed / cur;
      u.vx = Math.round(u.vx * k);
      u.vy = Math.round(u.vy * k);
    }
  }

  /* ---------- 技能系统 ----------
     统一分发三类触发：
       cooldown  冷却到点自动发动
       onWall    撞墙时发动（由边界处理调用）
       onHit     撞到小球时发动（由碰撞结算调用）
       onHpBelow / onHits  血量、次数阈值（按需使用）
     技能返回 true 表示"这次真的发动了"，引擎才让它进入冷却 ——
     这样"没有对手所以打不出子弹"之类的情况不会白白吃掉冷却。
     ------------------------------------------------------------ */
  _nearestEnemy(unit) {
    let best = null, bestD2 = Infinity;
    for (const o of this.units) {
      if (!o.alive || o.id === unit.id) continue;
      if (o.team === unit.team && !this.rules.friendlyFire) continue;
      const dx = o.x - unit.x, dy = o.y - unit.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = o; }
    }
    return best;
  }

  /** 按触发类型调用某小球身上的技能。list 为空表示"所有技能都可触发"。 */
  _runSkills(unit, triggerType, extra) {
    const ids = unit.skills || [];
    if (!ids.length) return;
    /* 沉默（吸血习性）：被缠住的球发不出技能，
       但**撞墙触发的技能照常** —— 作者原文"除碰撞墙体使用的技能以外"。
       所以 onWall 单独放行，其余触发方式一律拦掉。 */
    if (unit.silencedFrames > 0 && triggerType !== 'onWall') return;
    /* 时间停止：被冻住的球发不出技能（撞墙类也发不出 —— 它压根动不了） */
    if (this._frozenFor(unit)) return;
    const target = this._nearestEnemy(unit);
    for (const id of ids) {
      const sk = getSkill(id);
      if (!sk) continue;
      if (sk.trigger.type !== triggerType) continue;
      if ((unit.skillCd[id] || 0) > 0) continue;

      let fired = false;
      if (triggerType === 'cooldown') {
        fired = !!sk.run({ battle: this, unit, target });
      } else if (triggerType === 'onWall') {
        /* 把撞墙信息一并传给技能：内法线 + 球与墙面的接触点（世界坐标）。
           接触点很重要 —— 球心离墙面有 r 那么远（夹紧时留的余量），
           直接用球心位置会在场地中央凭空画出一个质点。 */
        fired = !!sk.run({ battle: this, unit, target, ...(extra || {}) });
      } else if (triggerType === 'onHit') {
        const other = extra && extra.other;
        if (!other) continue;
        fired = !!sk.run({ battle: this, unit, target, other });
      } else if (triggerType === 'onHpBelow') {
        const ratio = unit.hp / unit.maxHp;
        if (ratio > sk.trigger.ratio) continue;
        if (unit.hpBelowFired[id]) continue;
        fired = !!sk.run({ battle: this, unit, target });
        if (fired) unit.hpBelowFired[id] = true;
      } else if (triggerType === 'onHits') {
        if (unit.hitsTaken + unit.hitsDealt < sk.trigger.count) continue;
        fired = !!sk.run({ battle: this, unit, target });
      }

      if (fired && sk.trigger.cd) unit.skillCd[id] = sk.trigger.cd;
    }
  }

  /* ---------- 弹道 ---------- */
  _spawnProjectile(p) {
    this.projectiles.push({
      id: this.nextProjectileId++,
      kind: p.kind || 'aura',        // 表现类型：'aura' 特效 / 'body' 实体
      tag: p.tag || '',              // 技能内部标识：'modan' / 'cannon' / 'laser' / 'shard' …
      /* 贴图弹道：给一张图就按 dirX/dirY 转着画（箭矢用）。
         没给就是 -1，渲染层回退成原来的程序化光点。
         登记成下标而不是把路径塞进快照 —— 快照是每帧的 Float64Array，
         塞字符串会毁掉它的紧凑性。 */
      spriteIdx: this._projSpriteIndex(p.sprite, p.spriteLen),
      /* ---------- 追踪（蝙蝠） ----------
         homing: { targetId, turnPerSec } —— 每帧朝目标转，但**每秒最多转这么多度**。
         是"转速上限"不是"总偏角上限"（作者确认过）：
         打不到的目标它会绕着圈追，而不是被一个锥形范围卡死。 */
      homing: p.homing || null,
      /* ---------- 返程（蝙蝠命中后回缇娜） ----------
         returnTo: 单位下标。返程中每帧朝主人转（转速给得宽松），抵达时触发 onReturn。
         不做成"反向再飞一次"的原因：主人也在动，必须每帧重新朝它转。 */
      returnTo: (p.returnTo ?? -1),
      returning: false,
      /* ---------- 锚定（公主传承3 的光柱） ----------
         anchor: 单位下标。位置每帧强制跟到它身上、方向朝锁定目标 ——
         所以这根光柱是"从缇娜身上长出来的"，而不是一个会飞出去的弹道。 */
      anchor: (p.anchor ?? -1),
      anchorTarget: (p.anchorTarget ?? -1),
      /* beamForward: 光束从锚点**向前**画（普通激光的拖影是往后的） */
      beamForward: !!p.beamForward,
      /* 光束长度：判定与绘制**共用这一个数**。
         以前渲染层的长度是画的时候自己算的（max(40, w*3)），
         判定却按一个点算 —— 视觉和判定对不上。这里把它变成弹道属性。 */
      beamLen: p.beamLen || 0,
      /* 周期性范围伤害（光柱：每秒 3 次判定），范围 = 与光柱同宽同长的胶囊 */
      tickDamage: p.tickDamage || 0,
      tickInterval: p.tickInterval || 0,
      tickTimer: p.tickInterval || 0,
      tickKind: p.tickKind || 'skill',
      /* 锚定光柱用：跳过"贴到就爆"的弹体命中（伤害走 tickDamage） */
      noBodyHit: !!p.noBodyHit,
      owner: p.owner ? p.owner.id : -1,
      team: p.owner ? p.owner.team : -1,
      x: p.x, y: p.y,
      vx: p.vx, vy: p.vy,
      damage: p.damage,
      r: p.radius,
      /* 宽度：激光这类"长条"弹道需要一个横向尺寸。
         碰撞仍按圆处理（半径 = 核心粗细的一半），渲染时画成柱体。
         **统一以世界单位存放** —— 之前这里写的是 `p.width || (p.radius * 2)`，
         而 radius 是定点数、width 是世界单位，两个来源单位不一致；
         快照又按定点数除了一次 SCALE，结果激光的宽度被算成 0.016，
         画出来是一根看不见的头发丝。 */
      w: p.width || (p.radius / SCALE * 2),
      life: p.life,
      maxLife: p.life,
      color: p.color || '#7dd3fc',
      /* 特质标签："光"是裁光细线唯一会反应的东西，
         开华的 +50 也只加在带"光"的攻击上。 */
      traits: p.traits ? [...p.traits] : [],
      bounces: p.bounces || 0,       // 剩余可弹射次数（撞墙反弹而不是消失）
      hitsLeft: p.hitsLeft ?? 1,     // 还剩几次命中判定（默认一次）
      /* 光束类弹道（激光）：渲染成长条拖影而不是圆点。
         不能靠"宽度/半径"的比值去猜 —— 激光的宽度恰好是半径的 2 倍，
         和普通圆弹一样，比值区分不出来（踩过这个坑）。 */
      beam: !!p.beam,
      /* 穿透：命中后不消失，继续往前打。
         用一个"已经打过的目标"集合去重 —— 否则弹道在同一个球身上
         会连着好几帧反复结算高伤害。 */
      pierce: !!p.pierce,
      hitIds: new Set(),
      /* 技能可以挂回调：命中/过期时由引擎回调，用来做"打中两次就换招"
         这类需要跨弹道累加状态的机制。引擎自己不懂这些含义。 */
      onHit: p.onHit || null,
      /* 返程抵达主人时回调（蝙蝠回到缇娜身上回血 / 加魔力）。
         **必须在这里登记** —— 忘了这一行，技能那边传了 onReturn 也白传：
         弹道照样掉头、照样飞回、然后在沉默中消失，什么都不发生。
         实测症状就是"11 次命中、0 次返回结算"。 */
      onReturn: p.onReturn || null,
      onExpire: p.onExpire || null,
      /* 打空了（撞墙或到寿命都没碰到任何球）时回调。
         用来做"箭矢落空要掉层"这类机制 —— 引擎自己不懂什么是"落空"，
         它只知道这个弹道一次都没命中过。 */
      onMiss: p.onMiss || null,
      didHit: false,
      knockback: p.knockback || 0,   // 命中时的击退强度（世界单位/秒）
      /* 被细线吸收时的回调。用来做"魔弹被裁光的细线吃掉，也算一次命中计数"
         这类跨技能联动 —— 引擎自己不懂这些含义。 */
      onAbsorb: p.onAbsorb || null,
      /* 能不能被细线"吃掉"。
         默认 true（魔弹那种小弹一碰细线就没）；
         贯穿型的光柱传 false —— 它穿过去，但**依然提供"光"**（见细线那一段）。 */
      absorbable: p.absorbable !== false,
      /* 已经喂过"光"的细线 id。贯穿光柱会停在线上一段时间，
         不记这个的话它会逐帧喂同一条线，瞬间把细线顶到满级。 */
      fedLines: new Set(),
      /* 每个目标只结算一次的范围伤害（晕彩那道贯穿激光）。
         与 tickDamage 的区别：那个按节拍反复结算，这个一趟只打一下。 */
      sweepOnce: !!p.sweepOnce,
      alive: true
    });
    this._emit('shoot', p.owner || null, null, p.damage, {
      px: p.x / SCALE, py: p.y / SCALE, color: p.color || '#7dd3fc',
      tag: p.tag || '', light: (p.traits || []).includes('light')
    });
  }

  /** 从弹道 p 在当前位置分裂出 n 条新弹道（棱镜的光门分裂） */
  _splitProjectile(p, n, spec) {
    const base = Math.atan2(p.vy, p.vx);
    for (let i = 0; i < n; i++) {
      /* 随机方向：用本局种子流，保证同种子完全可复现 */
      const ang = base + (this.rnd() * 2 - 1) * Math.PI;
      const spd = spec.speed * SCALE;
      this._spawnProjectile({
        kind: 'aura',
        tag: spec.tag,
        owner: this.units[p.owner] || null,
        x: p.x, y: p.y,
        vx: Math.round(Math.cos(ang) * spd),
        vy: Math.round(Math.sin(ang) * spd),
        damage: spec.damage,
        radius: Math.round((spec.radius ?? 6) * SCALE),
        width: spec.width,
        beam: !!spec.beam,
        life: spec.life ?? 4,
        color: spec.color,
        traits: spec.traits,
        bounces: spec.bounces ?? 0
      });
    }
  }

  _updateProjectiles(shape) {
    const ps = this.projectiles;
    if (!ps.length) return;
    for (const p of ps) {
      if (!p.alive) continue;
      p.life -= DT;
      if (p.life <= 0) {
        p.alive = false;
        if (p.onExpire) p.onExpire(this, p);
        /* 到寿命都没碰到任何球 = 打空了 */
        if (!p.didHit && p.onMiss) p.onMiss(this, this.units[p.owner] || null, p);
        this._emit('projExpire', null, null, 0, { px: p.x / SCALE, py: p.y / SCALE, tag: p.tag });
        continue;
      }

      /* ---------- 锚定光柱：位置跟住锚点，方向朝锁定目标 ----------
         放在位移之前：锚定弹道的"位置"不是积分出来的，是每帧从主人身上抄的。 */
      if (p.anchor >= 0) {
        const a = this.units[p.anchor];
        if (!a || !a.alive) { p.alive = false; continue; }
        p.x = a.x; p.y = a.y;
        const t = this.units[p.anchorTarget];
        if (t && t.alive) {
          const ang = Math.atan2(t.y - p.y, t.x - p.x);
          const sp = Math.hypot(p.vx, p.vy) || SCALE;
          p.vx = Math.round(Math.cos(ang) * sp);
          p.vy = Math.round(Math.sin(ang) * sp);
        }
      }

      /* ---------- 追踪：每秒最多转 turnPerSec 度 ----------
         必须放在位移之前，否则这一帧用的还是转向前的方向。 */
      if (p.homing) {
        const t = this.units[p.homing.targetId];
        if (t && t.alive) {
          const want = Math.atan2(t.y - p.y, t.x - p.x);
          const cur = Math.atan2(p.vy, p.vx);
          let d = want - cur;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          const maxTurn = ((p.homing.turnPerSec || 0) * Math.PI / 180) * DT;
          const na = cur + Math.max(-maxTurn, Math.min(maxTurn, d));
          const sp = Math.hypot(p.vx, p.vy) || SCALE;
          p.vx = Math.round(Math.cos(na) * sp);
          p.vy = Math.round(Math.sin(na) * sp);
        }
      }

      /* ---------- 返程：朝主人转，贴到身上就算送达 ---------- */
      if (p.returning && p.returnTo >= 0) {
        const o = this.units[p.returnTo];
        if (!o || !o.alive) { p.alive = false; continue; }
        const want = Math.atan2(o.y - p.y, o.x - p.x);
        const cur = Math.atan2(p.vy, p.vx);
        let d = want - cur;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        const maxTurn = (720 * Math.PI / 180) * DT;      // 返程不设难度，保证回得来
        const na = cur + Math.max(-maxTurn, Math.min(maxTurn, d));
        const sp = Math.hypot(p.vx, p.vy) || SCALE;
        p.vx = Math.round(Math.cos(na) * sp);
        p.vy = Math.round(Math.sin(na) * sp);
        const dx = o.x - p.x, dy = o.y - p.y;
        const rr = p.r + o.r;
        if (dx * dx + dy * dy <= rr * rr) {
          if (p.onReturn) p.onReturn(this, o, p);
          p.alive = false;
          continue;
        }
      }

      /* ---------- 周期性范围伤害（光柱：每秒 3 次判定） ---------- */
      if (p.tickDamage > 0 && p.tickInterval > 0) {
        p.tickTimer -= DT;
        if (p.tickTimer <= 0) {
          p.tickTimer += p.tickInterval;
          const owner = this.units[p.owner] || null;
          for (const u of this._beamTargets(p)) {
            this._damage(owner, u, p.tickDamage, p.tickKind);
          }
        }
      }

      /* ---------- 贯穿光的"一趟只打一下"（晕彩的魔弹激光）----------
         与上面那条的区别：tickDamage 按节拍反复结算（每秒 3 次），
         这条是**每个目标只结算一次**，符合"贯穿、同一目标不重复"。
         用 hitIds 去重 —— 和普通穿透弹共用同一套去重集合。 */
      if (p.sweepOnce && p.damage > 0) {
        const from = this.units[p.owner] || null;
        for (const u of this._beamTargets(p)) {
          if (p.hitIds.has(u.id)) continue;
          p.hitIds.add(u.id);
          p.didHit = true;
          this._damage(from, u, p.damage, 'skill', { traits: p.traits });
          this._emit('projHit', null, u, p.damage, {
            px: u.x / SCALE, py: u.y / SCALE, color: p.color, tag: p.tag
          });
        }
      }

      /* 时间停止期间，非 owner 的弹道停在原地。
         注意只跳过**位移**，寿命、命中、撞墙都照常判 ——
         否则停在原地的弹道会永远不消失。

         锚定弹道**一律不做位移积分**：它的位置就是锚点的位置，
         再积分一次等于每帧多走一帧的距离（实测光柱离缇娜 10 个单位，
         正好是 600 单位/秒 × 1/60 秒）。这个"多走一点"很小、
         小到肉眼几乎看不出来，但它是错的，而且会随速度线性放大。 */
      if (p.anchor < 0 && !this._frozenFor(this.units[p.owner])) {
        p.x += Math.round(p.vx * DT);
        p.y += Math.round(p.vy * DT);
      }

      /* ---------- 穿过己方光门：分裂 ----------
         放在撞墙判定之前：光门通常贴着敌人的方向，先判分裂更符合直觉。 */
      if (p.tag === 'cannon' || p.tag === 'modan') {
        for (const f of this.fields) {
          if (!f.alive || f.kind !== 'gate') continue;
          if (f.team !== p.team) continue;
          const dx = f.x - p.x, dy = f.y - p.y;
          if (dx * dx + dy * dy > f.r * f.r) continue;
          const owner = this.units[p.owner] || null;
          if (p.tag === 'cannon') {
            /* 光炮 → 五条随机方向的激光，撞墙弹射一次，每条 50 */
            this._splitProjectile(p, 5, {
              tag: 'laser', speed: 400, damage: this._lightDamage(owner, 50,
                { lightBonus: owner && owner.bloomed ? 15 : 0 }),
              radius: 4, width: 10, beam: true, life: 5, color: '#e9d5ff',
              traits: ['light'], bounces: 1
            });
          } else {
            /* 魔力球 → 五个弹射一次的小魔力球，每个 20 */
            this._splitProjectile(p, 5, {
              tag: 'shard', speed: 300, damage: this._lightDamage(owner, 20),
              radius: 5, life: 4, color: '#c4b5fd',
              traits: ['light'], bounces: 1
            });
          }
          p.alive = false;
          this._emit('gateSplit', owner, null, p.tag === 'cannon' ? 5 : 5, {
            px: p.x / SCALE, py: p.y / SCALE
          });
          break;
        }
        if (!p.alive) continue;
      }

      /* 撞到场地边界：有弹射次数就反弹，否则消失 */
      const c = clampToShape(shape, p.x, p.y, p.r);
      if (c.hit) {
        if (p.bounces > 0) {
          p.bounces--;
          const vn = (p.vx * c.nx + p.vy * c.ny) / SCALE;
          if (vn < 0) {
            p.vx -= Math.round((2 * c.nx * vn) / SCALE);
            p.vy -= Math.round((2 * c.ny * vn) / SCALE);
          }
          p.x = c.x; p.y = c.y;
          this._emit('projBounce', null, null, 0, { px: p.x / SCALE, py: p.y / SCALE, color: p.color });
          continue;
        }
        p.alive = false;
        /* 撞墙而死、且一次都没命中 = 打空了（"箭矢落空"就是这个） */
        if (!p.didHit && p.onMiss) p.onMiss(this, this.units[p.owner] || null, p);
        this._emit('projWall', null, null, 0, { px: (c.x) / SCALE, py: (c.y) / SCALE, color: p.color, tag: p.tag });
        continue;
      }

      /* 返程中的弹道不再伤人 —— 否则它回程路上会一路割过去。
         （"命中后返回"里的"命中"只算第一次）
         锚定光柱也不走弹体命中：它的伤害由 tickDamage 按节拍结算，
         走弹体命中会在缇娜身边擦到谁就把自己撞没。 */
      if (p.returning || p.noBodyHit) continue;

      // 命中敌对小球
      for (const u of this.units) {
        if (!u.alive) continue;
        if (u.id === p.owner) continue;
        if (u.team === p.team && !this.rules.friendlyFire) continue;
        if (p.pierce && p.hitIds.has(u.id)) continue;   // 穿透弹不重复打同一个目标
        const dx = u.x - p.x, dy = u.y - p.y;
        const rr = u.r + p.r;
        if (dx * dx + dy * dy > rr * rr) continue;
        const from = this.units[p.owner] || null;
        this._damage(from, u, p.damage, 'skill', { traits: p.traits });
        this._emit('projHit', null, u, p.damage, {
          px: p.x / SCALE, py: p.y / SCALE, color: p.color, tag: p.tag
        });
        p.didHit = true;
        if (p.onHit) p.onHit(this, from, u, p);
        /* 命中时的击退：沿飞行方向把目标推开一点 */
        if (p.knockback) {
          const d = Math.hypot(p.vx, p.vy) || 1;
          const kb = p.knockback * SCALE;
          u.vx = Math.round((p.vx / d) * kb);
          u.vy = Math.round((p.vy / d) * kb);
          this._emit('knock', from, u, p.knockback);
        }
        /* 穿透弹记下打过的目标，然后**继续**检查同一帧里的其他目标；
           普通弹道打中一个就地消失。 */
        if (p.pierce) { p.hitIds.add(u.id); continue; }
        /* 带 returnTo 的弹道命中后不死，改成掉头往回飞 ——
           "命中就消失"与"命中后回主人身上"是两种不同的弹道。 */
        if (p.returnTo >= 0) {
          p.returning = true;
          p.hitsLeft = 1;
          const o = this.units[p.returnTo];
          if (o && o.alive) {
            const ang = Math.atan2(o.y - p.y, o.x - p.x);
            const sp = Math.hypot(p.vx, p.vy) || SCALE;
            p.vx = Math.round(Math.cos(ang) * sp);
            p.vy = Math.round(Math.sin(ang) * sp);
          }
          break;
        }
        p.hitsLeft--;
        if (p.hitsLeft <= 0) p.alive = false;
        break;
      }
    }
    // 清理已消失的弹道
    if (ps.some(p => !p.alive)) this.projectiles = ps.filter(p => p.alive);
  }

  /* ============================================================
     场地物件（裁光的质点·细线 / 棱镜的光门）
     ------------------------------------------------------------
     与弹道的分工：
       · 弹道会飞、碰到就没了；
       · 场地物件待在原地，可以被"光"激活升级（细线），
         也可以每帧持续造成伤害（质点与细线），或者持续放行射弹（光门）。
     ============================================================ */

  /** 生成一个场地物件。返回它，方便调用方继续设置字段。 */
  _spawnField(spec) {
    const f = {
      id: this.nextFieldId++,
      kind: spec.kind,                 // 'mote' | 'line' | 'gate'
      owner: spec.owner ? spec.owner.id : -1,
      team: spec.owner ? spec.owner.team : -1,
      x: spec.x, y: spec.y,
      x2: spec.x2 ?? 0, y2: spec.y2 ?? 0,
      r: Math.round((spec.r ?? 5) * SCALE),
      halfW: Math.round((spec.halfW ?? 2) * SCALE),
      stage: 0,                        // 细线阶段：0 漆黑 / 1 深紫 / 2 微光
      absorb: 0,                       // 已被"光"激活的次数
      life: spec.life || 0,            // 0 = 不因寿命消失
      maxLife: spec.life || 0,
      /* ⑥ 辉光领域里细线会自动进阶：stageTimerMax 为 0 表示不会自动进阶 */
      stageTimer: 0,
      stageTimerMax: spec.stageTimerMax || 0,
      damage: spec.damage || 0,        // 每帧接触伤害
      /* 分阶段伤害表（裁光细线：漆黑 1/帧 → 深紫 2/帧）。
         阶段越高伤害越大，所以用表而不是单值。 */
      damageByStage: spec.damageByStage || null,
      boomDamage: spec.boomDamage || 0,// 第三阶段被敌方触碰时的爆炸伤害（基础值）
      flash: 0,
      alive: true
    };
    this.fields.push(f);
    return f;
  }

  /** 细线进阶一级（被"光"激活，或由辉光领域按时推进）
   *  cause: 'absorb' = 真的吸收了"光"；'domain' = 领域按时推进。
   *  只有真的吸收才增加 absorb 计数 —— 领域推进不是吸收，
   *  混在一起会让"这条线被光激活过几次"这个信息失真。 */
  _advanceLine(f, cause) {
    if (f.stage >= 2) return false;
    f.stage++;
    if (cause === 'absorb') f.absorb++;
    f.flash = 0.25;
    this._emit('lineStage', null, null, f.stage, {
      px: f.x / SCALE, py: f.y / SCALE,
      x2: f.x2 / SCALE, y2: f.y2 / SCALE, cause
    });
    return true;
  }

  /** 处在某条"光柱胶囊"里的敌对单位。
   *  范围 = 从弹道位置沿它的方向、长 beamLen、半宽 w/2 的一条胶囊。
   *  **判定与绘制共用 beamLen / w 这两个数** —— 画多长多粗就判多长多粗。
   *  抽成函数是因为现在有两处要用：缇娜光柱的按节拍结算、
   *  晕彩贯穿激光的"每个目标只打一下"。 */
  _beamTargets(p) {
    const out = [];
    if (!(p.beamLen > 0)) return out;
    const half = (p.w * SCALE) / 2;
    const sp = Math.hypot(p.vx, p.vy) || 1;
    const ex = p.x + (p.vx / sp) * (p.beamLen * SCALE);
    const ey = p.y + (p.vy / sp) * (p.beamLen * SCALE);
    for (const u of this.units) {
      if (!u.alive || u.id === p.owner) continue;
      if (u.team === p.team && !this.rules.friendlyFire) continue;
      const d = Battle._distToSeg(u.x, u.y, p.x, p.y, ex, ey);
      if (d > half + u.r) continue;
      out.push(u);
    }
    return out;
  }

  /** 两线段的最短距离（全部为定点整数）。
   *  不相交时最短距离一定取在某个端点上，所以四个"点到线段"取最小即可；
   *  相交时是 0 —— 这一步不能省：
   *  细线横穿光柱正中间时，四个端点到对方的距离都可能很大。 */
  static _distSegToSeg(ax, ay, bx, by, cx, cy, dx, dy) {
    if (Battle._segCross(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
    return Math.min(
      Battle._distToSeg(ax, ay, cx, cy, dx, dy),
      Battle._distToSeg(bx, by, cx, cy, dx, dy),
      Battle._distToSeg(cx, cy, ax, ay, bx, by),
      Battle._distToSeg(dx, dy, ax, ay, bx, by));
  }
  static _cross(ax, ay, bx, by, px, py) {
    return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  }
  /** 两线段是否相交（端点正好落在对方身上算相交） */
  static _segCross(ax, ay, bx, by, cx, cy, dx, dy) {
    const d1 = Battle._cross(cx, cy, dx, dy, ax, ay);
    const d2 = Battle._cross(cx, cy, dx, dy, bx, by);
    const d3 = Battle._cross(ax, ay, bx, by, cx, cy);
    const d4 = Battle._cross(ax, ay, bx, by, dx, dy);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
  }

  /** 点到线段的最短距离（全部为定点整数） */
  static _distToSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  _updateFields(shape) {
    const fs = this.fields;
    if (!fs.length) return;

    /* 全局安全阀：场地物件理论上由技能自己控制数量（裁光有 per-owner 上限），
       但这是最后一道防线 —— 一旦物件数失控，每帧的「物件 × 小球」检测
       会把模拟拖到跑不完（实测过几千条细线时 5 分钟对局跑十几分钟）。
       超出就丢最早的，宁可少画几条也不能让模拟卡死。 */
    if (fs.length > MAX_FIELDS) {
      const excess = fs.length - MAX_FIELDS;
      for (let i = 0; i < excess; i++) fs[i].alive = false;
    }

    for (const f of fs) {
      if (!f.alive) continue;

      /* --- 寿命 --- */
      if (f.life > 0) {
        f.life--;
        if (f.life <= 0) {
          f.alive = false;
          this._emit('fieldEnd', null, null, 0, { kind: f.kind, px: f.x / SCALE, py: f.y / SCALE });
          continue;
        }
      }
      if (f.flash > 0) f.flash = Math.max(0, f.flash - DT);

      /* --- ⑥ 辉光领域：细线到点自动进阶，不需要接触"光" --- */
      if (f.kind === 'line' && f.stageTimerMax > 0 && f.stage < 2) {
        f.stageTimer++;
        if (f.stageTimer >= f.stageTimerMax) {
          f.stageTimer = 0;
          this._advanceLine(f, 'domain');
        }
      }

      /* --- 细线吸收"光"：带 light 特质的弹道碰到细线就被吃掉 ---
         注意是**任何来源**的光，包括晕彩自己的魔弹/激光/光炮。
         设定里"光"的定义就是"晕彩的其他技能" ——
         也就是设计意图是"先布细线，再打光过去喂它升级"。
         （最早写成"只吃敌方的光"，结果对手没有光技能时细线永远停在第一阶段。） */
      if (f.kind === 'line' && f.stage < 2) {
        for (const p of this.projectiles) {
          if (!p.alive) continue;
          if (!p.traits.includes('light')) continue;
          /* 判定"这枚光碰到线了没有"。
             **贯穿光柱要按整条线判**，不能只看它的位置 ——
             锚定光柱的位置就是主人的位置，只看那个点的话，
             光柱横穿场地却只有贴着晕彩的那条细线才算"碰到"。
             单位也要对齐：f.halfW 是**世界单位**，p.r 是**定点数**，
             原式 `f.halfW + p.r` 把 0.6 加在 6000 上，等于忽略了线自身的宽度。 */
          const halfW = Math.round(f.halfW * SCALE);
          const pr = (p.beamForward && p.w > 0) ? Math.round((p.w / 2) * SCALE) : p.r;
          let d;
          if (p.beamForward && p.beamLen > 0) {
            const sp = Math.hypot(p.vx, p.vy) || 1;
            d = Battle._distSegToSeg(
              p.x, p.y,
              p.x + (p.vx / sp) * (p.beamLen * SCALE),
              p.y + (p.vy / sp) * (p.beamLen * SCALE),
              f.x, f.y, f.x2, f.y2);
          } else {
            d = Battle._distToSeg(p.x, p.y, f.x, f.y, f.x2, f.y2);
          }
          if (d > halfW + pr) continue;
          if (p.absorbable) {
            p.alive = false;
          } else {
            /* 贯穿型的光柱不被吃掉，但**照样提供"光"** ——
               作者的口径是"碰到细线时不会消失，但是依然会提供光"。
               每条细线只喂一次：光柱会在线上停一秒，
               逐帧都喂的话细线瞬间满级，等于白送。 */
            if (p.fedLines.has(f.id)) break;
            p.fedLines.add(f.id);
          }
          this._advanceLine(f, 'absorb');
          this._emit('lineAbsorb', null, null, f.stage, {
            px: p.x / SCALE, py: p.y / SCALE
          });
          /* 通知发射者"你的光被吃掉了" —— 有些技能靠这个计数 */
          if (p.onAbsorb) p.onAbsorb(this, this.units[p.owner] || null, p);
          break;
        }
      }

      /* --- 接触伤害（只打敌对小球）--- */
      for (const u of this.units) {
        if (!u.alive) continue;
        if (u.team === f.team && !this.rules.friendlyFire) continue;
        const owner = this.units[f.owner] || null;
        if (f.kind === 'mote' || f.kind === 'gate') {
          if (f.kind !== 'mote') continue;
          const dx = u.x - f.x, dy = u.y - f.y;
          const rr = u.r + f.r;
          if (dx * dx + dy * dy > rr * rr) continue;
          this._tickDamage(owner, u, f.damage || 1, 'caiguang', ['light']);
        } else if (f.kind === 'line') {
          const d = Battle._distToSeg(u.x, u.y, f.x, f.y, f.x2, f.y2);
          if (d > u.r + f.halfW) continue;
          if (f.stage >= 2) {
            /* 第三阶段：被敌方触碰就爆炸并消失，爆炸也带"光"特质（所以吃开华的 +50） */
            const boom = this._lightDamage(owner, f.boomDamage);
            this._damage(owner, u, boom, 'caiguang', { traits: ['light'] });
            this._emit('lineBoom', owner, u, boom, {
              px: f.x / SCALE, py: f.y / SCALE, x2: f.x2 / SCALE, y2: f.y2 / SCALE
            });
            f.alive = false;
            break;
          }
          const perFrame = f.damageByStage
            ? (f.damageByStage[Math.min(f.stage, f.damageByStage.length - 1)] || 0)
            : (f.damage || 0);
          this._tickDamage(owner, u, this._scaledDamage(owner, perFrame), 'caiguang', ['light']);
        }
      }
    }

    if (fs.some(f => !f.alive)) this.fields = fs.filter(f => f.alive);
  }

  /* ---------- 每帧持续伤害 ----------
     裁光的质点与细线是"接触期间每帧扣血"。
     伤害逐帧结算，事件也**逐帧如实输出真实数值**（1 或 2）。

     这里曾经为了怕事件流爆掉，把 15 帧的伤害合并成一条事件输出，
     结果飘字变成"-16" —— 玩家看到的是"一帧扣了 16 点"，
     与设定里"每帧 1 点"完全对不上。**合并显示等于报假数**，不能这么做。
     防爆改成两道：① 飘字由渲染层节流（数值仍然真实）；
     ② 这里给持续伤害单独设一个事件上限，超了就只扣血不再发事件，
     免得把事件流的 6000 条总上限吃光、导致后面的死亡/开华事件被丢掉。 */
  _tickDamage(from, to, amount, kind, traits) {
    if (!to.alive || amount <= 0) return;
    this._damage(from, to, amount, kind, { traits, quiet: true, unavoidable: true });
    if (this.tickEvents < MAX_TICK_EVENTS) {
      this.tickEvents++;
      this._emit('hit', from, to, amount, { kind, tick: true });
    }
  }

  /* ---------- 召唤（析光的小晕彩）----------
     动态往 this.units 里追加一个单位。
     注意两件事：
       · this.n 与 pairKeyBase 要一起更新，否则快照长度和碰撞冷却键会错位；
       · 早期帧的快照里没有这个单位，所以所有读快照的地方都必须容忍"这一帧还没它"。
     ------------------------------------------------------------ */
  _spawnSummon(owner, stats) {
    const u = {
      id: this.units.length,
      slot: -1,
      team: owner.team,
      speciesId: stats.speciesId || owner.speciesId,
      name: stats.name || owner.name,
      color: stats.color || owner.color,
      sticker: stats.sticker || owner.sticker,
      stickerBloom: stats.stickerBloom || null,
      bow: stats.bow || null,
      maxHp: stats.maxHp,
      hp: stats.maxHp,
      r: Math.round((stats.r ?? owner.r / SCALE) * SCALE),
      mass: Math.max(1, Math.round((stats.r ?? owner.r / SCALE) ** 2)),
      speed: Math.round((stats.speed ?? owner.speed / SCALE) * SCALE),
      baseSpeed: (stats.speed ?? owner.speed / SCALE),   // 世界单位，见 buildUnits 的说明
      melee: stats.melee ?? 0,
      reach: 0,
      resMax: 0, res: 0, resDef: null,
      isPlayer: false,
      x: stats.x, y: stats.y,
      spawnX: stats.x, spawnY: stats.y,
      vx: stats.vx ?? 0, vy: stats.vy ?? 0,
      ax: 0, ay: 0,
      alive: true,
      respawnAt: 0, hitCd: 0, flash: 0,
      kills: 0, dmg: 0, taken: 0,
      damageFrom: {},
      skills: stats.skills ? resolveLoadout(stats.skills) : [],
      skillCd: {}, hitsTaken: 0, hitsDealt: 0, hpBelowFired: {},
      mode: 'normal', chargeFrames: 0, dashFrames: 0, dashVx: 0, dashVy: 0,
      dashHits: new Set(), cd: {}, flags: {},
      bloomed: false, dodge: 0, stealthFrames: 0,
      meleeImmuneFrames: 0, silencedFrames: 0, latch: null,
      baseMelee: stats.melee ?? 0, meleeBonus: 0, spinMeleeBonus: 0,
      speedOverride: null, speedBonus: 0, speedSlow: 0, speedSlowFrames: 0, speedMul: 1,
      spinStacks: 0, spinAngle: 0, healAcc: 0, healed: 0,
      castP: 0, castKind: 0, aimAngle: 0, hasWindup: false, needsAim: false,
      damageMul: stats.damageMul ?? 1,
      lightBonus: 0,
      summoner: owner.id,
      hooks: {},
    };
    this.units.push(u);
    this.n = this.units.length;
    this.pairKeyBase = Math.max(this.pairKeyBase, this.n * 1000);
    /* 被动与钩子必须手动补一次：召回来的单位不走构造函数那条路 */
    this._initUnitSkills(u);
    this._emit('summon', owner, u, 0);
    return u;
  }

  /* ---------- "光"特质的最终伤害 ----------
     开华的 +50 只加在带"光"的攻击上；析光分身的所有伤害再乘 1/3。
     乘在最后，所以分身的分身也自然继承（spec 里"所有伤害数值为三分之一"）。
     opts.lightBonus 可覆盖单位自身的加成 —— 棱镜分裂出来的个体用的是 +15
     而不是 +50（作者明确区分了这两档）。
     ------------------------------------------------------------ */
  _lightDamage(unit, base, opts = {}) {
    if (!unit) return Math.max(1, Math.round(base));
    const bonus = opts.lightBonus !== undefined ? opts.lightBonus : (unit.lightBonus || 0);
    return Math.max(1, Math.round((base + bonus) * (unit.damageMul ?? 1)));
  }

  /** 碰撞伤害：走单位的伤害倍率（析光分身的所有伤害都是 1/3） */
  _meleeDamage(unit) {
    if (!unit || unit.melee <= 0) return 0;
    return Math.max(1, Math.round(unit.melee * (unit.damageMul ?? 1)));
  }

  /* ---------- 回复 ----------
     按"每秒 N 点"回复时不能每帧取整 —— 20/60 = 0.33，取整后每帧都是 0，
     一滴血都回不上。所以用余数累积，攒够 1 点才真的加。 */
  _heal(unit, amount) {
    if (!unit || !unit.alive || amount <= 0) return 0;
    unit.healAcc += amount;
    const whole = Math.floor(unit.healAcc);
    if (whole <= 0) return 0;
    unit.healAcc -= whole;
    const before = unit.hp;
    unit.hp = Math.min(unit.maxHp, unit.hp + whole);
    const got = unit.hp - before;
    if (got > 0) {
      unit.healed += got;
      this._emit('heal', null, unit, got);
    }
    return got;
  }

  /* ---------- 时间停止 ----------
     语义（作者确认）：
       · 除 owner 外的球**不能移动、不能开火、技能冷却也停**；
       · 但灼烧 / 细线之类的**持续伤害照常跳** —— 站在火里照样掉血。
     所以"停止"只落在三处：冷却递减、位移积分、技能分发。
     区域伤害与场地物件的每帧结算**都不在这里**，因此天然不受影响。 */
  startTimeStop(owner, seconds) {
    const frames = Math.max(1, Math.round(seconds / DT));
    this.timeStopUntil = this.frame + frames;
    this.timeStopOwner = owner ? owner.id : -1;
    this._emit('timeStop', owner || null, null, seconds);
    return frames;
  }
  /** 这个单位此刻是否被时间停止冻住（owner 自己不受影响） */
  _frozenFor(unit) {
    if (this.timeStopUntil <= this.frame) return false;
    return !unit || unit.id !== this.timeStopOwner;
  }
  /** 此刻是否有时间停止在生效 */
  timeStopActive() {
    return this.timeStopUntil > this.frame;
  }

  /* ---------- 特殊资源 ----------
     与 _heal 对称的原语：技能想加资源就调它，别直接改 u.res。
     理由和 _heal 一样 —— 夹上限、记事件、以及"技能不需要知道 resMax 在哪"。 */
  _gainResource(unit, amount, reason) {
    if (!unit || !unit.alive || !(amount > 0) || !(unit.resMax > 0)) return 0;
    const before = unit.res;
    unit.res = Math.min(unit.resMax, unit.res + amount);
    const got = unit.res - before;
    if (got > 0) this._emit('resource', unit, null, got, { res: unit.res, reason: reason || '' });
    return got;
  }

  /** 只按倍率缩放、**不加**"光"加成。
      用途：裁光质点/细线的"每帧 1~2 点"接触伤害。
      开华的 +50 是加在"一次攻击"上的，如果每帧都 +50，
      接触伤害会变成 51×60 = 3060/秒，显然不是原意。 */
  _scaledDamage(unit, base) {
    return Math.max(1, Math.round(base * ((unit && unit.damageMul) ?? 1)));
  }

  /** 把一个世界坐标点夹进场地内（技能放置场地物件时用） */
  clampPoint(x, y, r = 0) {
    const c = clampToShape(this.shape(), Math.round(x * SCALE), Math.round(y * SCALE),
      Math.round(r * SCALE));
    return { x: c.x / SCALE, y: c.y / SCALE };
  }

  /* ---------- 速度模型：基础速度 + 加成/减益 ----------
     小球的实际移动用的是速度向量 vx/vy，而那是开局按 speed 定好的；
     之后只有碰撞、撞墙反射、转向修正会动它（且都保持速率不变）。
     所以技能要"提速/减速"**必须走这里**，不能只写 u.speed。

     这个坑真实发生过：晕彩开华的"速度提高到 150"从一开始就没生效，
     直到给桃夭做"每层 +2 移速"时才被测出来。

     三个来源分开记，互不覆盖：
       baseSpeed      球种原始速度（出生时定，不再改）
       speedOverride  绝对覆盖（开华那种"提高到 N"）
       speedBonus     加法加成（陀螺每层 +2）
       speedSlow      减法减益（映霞[枯] 命中 -20，带时限）
     最终 = (override ?? base) + bonus + slow，再夹一个下限防止被减到 0。
     ------------------------------------------------------------ */

  /** 只改"当前速度"本身，并同步缩放速度向量（方向不变） */
  setSpeed(unit, worldSpeed) {
    unit.speed = Math.round(worldSpeed * SCALE);
    const cur = Math.hypot(unit.vx, unit.vy);
    if (cur > 0) {
      const k = unit.speed / cur;
      unit.vx = Math.round(unit.vx * k);
      unit.vy = Math.round(unit.vy * k);
    }
    /* 速度为 0 的情况（蓄力中）不用管：状态机恢复速度时会读 u.speed */
    return unit.speed;
  }

  /** 按"基础 + 覆盖 + 加成 + 减益"重算当前速度，并同步速度向量 */
  refreshSpeed(unit) {
    const base = (unit.speedOverride != null) ? unit.speedOverride : (unit.baseSpeed || 0);
    /* 先加减、再乘 —— 所以"减半"是把最终结果对折，
       而不是把基础速度对折（否则陀螺的加速度会按原样加回来）。 */
    const target = Math.max(MIN_SPEED,
      (base + (unit.speedBonus || 0) + (unit.speedSlow || 0)) * (unit.speedMul ?? 1));
    if (unit.speed !== Math.round(target * SCALE)) this.setSpeed(unit, target);
    return target;
  }

  /* ---------- 碰撞伤害：同样是"基础 + 加成" ----------
     撞伤必须走这里，不能直接 `u.melee += 50`：
     陀螺每叠一层都要重算，直接加会把折光的 +100 反复累加进去
     （叠 10 层就变成 100 + 10×2 + 100×10 这种莫名其妙的数）。 */
  refreshMelee(unit) {
    /* meleeLock：某些技能把碰撞伤害**锁死**在一个值上
       （吸血习性：降到 30，且权杖的 +15 不影响它）。
       用"锁"而不是"减 20"：后者会和权杖的 +15 互相抵消，
       算出一个既不是 30 也不是 65 的数。 */
    if (unit.meleeLock != null) {
      unit.melee = unit.meleeLock;
      return unit.melee;
    }
    unit.melee = Math.max(0,
      (unit.baseMelee || 0) + (unit.meleeBonus || 0) + (unit.spinMeleeBonus || 0));
    return unit.melee;
  }


  /* ---------- 撞墙时触发技能 ---------- */
  _onWallTouch(u, info) {
    /* 冲刺中撞墙：立刻结束冲刺。
       不这么做的话会出大问题：冲刺分支每帧都会把速度重新覆盖成
       "朝 dashVx/dashVy 冲"，于是撞墙反射出来的速度下一帧就被抹掉，
       球被推进墙里、再被夹回原位 —— 表现为贴在墙上反复抽搐然后卡死
       （实测圆场里连续 20 帧位移恰好为 0）。
       同时 onWall 技能还会因为 dashFrames > 0 而拒绝触发，球永远爬不出来。
       所以"撞墙"对冲刺来说是终止条件。

       这里**刻意不清零速度**：上面刚做完的撞墙反射要保留下来。
       清零交给真正接手的技能去做（"停止移动并蓄力"由技能自己清）。
       这样即使某个冲刺技能没有配 onWall 接手技能，球也只是正常弹开，
       不会变成速度 0、永远停在墙上。 */
    if (u.dashFrames > 0 || u.mode === 'dashing') {
      u.dashFrames = 0;
      u.dashHits = new Set();
      u.mode = 'normal';   // 置为 normal，下一帧的收尾分支就不会再把速度还原成冲刺方向
      this._emit('dashEnd', u, null, 0);
    }
    // 让技能有机会"接手"（例如停止移动并蓄力）
    this._runSkills(u, 'onWall', info);
    // 若技能把它切到停止状态，就不再反弹（速度已归零，反弹也无意义）
    if (u.mode === 'charging') return;
  }

  /* ---------- 撞墙后的方向偏转 ----------
     小球撞墙反弹之后，把新的速度方向朝「最近的敌对小球」偏转，最多 maxDeg 度。

     目的：纯弹跳模型下两个小球很容易长期擦肩而过（圆形场地里斜反射会形成
     稳定周期轨道），一场 1v1 可能几十秒都碰不上。让每次撞墙都轻微修正航向，
     场面就会自然收敛到交战，而不是靠"凭空扩大攻击范围"这种假机制兜底。

     偏转是"最多 maxDeg"，不是"一定 maxDeg"：只转实际需要的角度，
     所以本来就已经朝向敌人时不会被转过头。
     ------------------------------------------------------------ */
  _deflectTowardEnemy(u, maxDeg) {
    // 找最近的敌对目标
    let best = null, bestD2 = Infinity;
    for (const o of this.units) {
      if (!o.alive || o.id === u.id) continue;
      if (o.team === u.team && !this.rules.friendlyFire) continue;
      const dx = o.x - u.x, dy = o.y - u.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = o; }
    }
    if (!best) return 0;

    /* 转向角度累加器：每帧的增量往往是小数（例如 30 度/秒 ÷ 60 = 0.5 度），
       而旋转查表需要整数。这里把小数累积起来，够 1 度才真正转一次，
       既保证长期转向速率精确，也避免了每帧都做一次几乎无意义的微旋转。 */
    u._steerAcc = (u._steerAcc || 0) + maxDeg;
    const whole = Math.trunc(u._steerAcc);
    if (whole === 0) return 0;
    u._steerAcc -= whole;

    const curDeg = ((Math.atan2(u.vy, u.vx) * 180) / Math.PI + 360) % 360;
    const wantDeg = ((Math.atan2(best.y - u.y, best.x - u.x) * 180) / Math.PI + 360) % 360;

    // 取最短转向路径（−180..180）
    let diff = wantDeg - curDeg;
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;

    const applied = Math.max(-whole, Math.min(whole, diff));
    if (Math.round(Math.abs(applied)) === 0) return 0;

    const before = Math.hypot(u.vx, u.vy);
    const r = rotateVel(u.vx, u.vy, applied);
    u.vx = r.vx;
    u.vy = r.vy;
    restoreSpeed(u, before);            // 旋转不该改变速率
    u.face = ((Math.atan2(u.vy, u.vx) * 180) / Math.PI + 360) % 360;
    return applied;
  }

  /* ---------- 球球碰撞：完全弹性碰撞 ----------
     两圆斜碰的物理结果（等质量或不等质量）：
       1. 先沿法线把重叠推开（各退一半，按质量反比分配）
       2. 再沿法线做一维弹性碰撞的冲量交换
     速度的切向分量不变 —— 所以小球只会因为碰撞改变方向，符合"匀速直线"的直觉。

     两个必须额外保证的点（否则会"粘在一起"）：
       · 分离要做多次迭代。实测一帧只做一次时，最大穿透能到 24.9 单位
         （球直径才 32），一帧修不完就继续叠着，观感就是粘住。
       · 冲量之后要保证两球确实在"分开"。当重球撞轻球时，
         按质量反比解出来的冲量可能让轻球速度几乎不变，
         于是两球保持贴合一起走 —— 所以给分离速度设一个下限。
     ------------------------------------------------------------ */
  _collide() {
    const units = this.units;
    const e = this.rules.restitution ?? 1;

    /* 网格单元尺寸必须 ≥ 一次 3×3 邻域能覆盖的最大距离
       （即 unit > 两球接触判定距离 2r）。
       当前 r=16 ⇒ 2r=32，取 40 留足余量。
       ⚠️ 以后若调大球体半径或判定范围，这里必须跟着放大，
       否则距离在 (unit, 2r] 之间的配对会落在相隔 2 格的格子里而永远匹配不上。 */
    const cellSize = 40 * SCALE;

    /* 交错迭代：分离 → 冲量 → 再分离 …
       为什么不能分成"先全部分离、再全部冲量"两个独立阶段：
       分离把两球推开之后，冲量又可能把它们推向彼此；更麻烦的是
       边界夹紧会把贴墙的两球重新挤到一起。交错迭代能收敛。

       关键：**每一轮都要重建网格**。分离会把球推出原来的格子，
       沿用旧网格就会漏掉新的相邻配对 —— 表现为"明明叠在一起却没有冲量"，
       实测能看到"重叠 0.2、相对速度却是 -90"（还在往里挤）。 */
    for (let pass = 0; pass < 6; pass++) {
      const grid = new Map();
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (!u.alive) continue;
        const key = ((u.x / cellSize) | 0) * 100003 + ((u.y / cellSize) | 0);
        let b = grid.get(key);
        if (!b) grid.set(key, (b = []));
        b.push(i);
      }

      let acted = 0;
      for (const [key, bucket] of grid) {
        const gx = Math.floor(key / 100003);
        const gy = key - gx * 100003;

        // ① 同格内部
        for (let a = 0; a < bucket.length; a++) {
          const A = units[bucket[a]];
          if (!A.alive) continue;
          for (let c = a + 1; c < bucket.length; c++) {
            const B = units[bucket[c]];
            if (!B.alive || !overlapping(A, B)) continue;
            acted++;
            /* 顺序很重要：先算速度冲量、再做位置分离。
               反过来的话，分离会把两球正好推到"相切"（distance === r1+r2），
               而 _resolveCollision 开头会判定"不再重叠"直接返回 ——
               冲量永远不生效，运动又被分离推挤抵消，
               小球就卡在相切位置一动不动（实测速度 120 却整秒零位移）。 */
            if (pass < 2) this._resolveCollision(A, B, e);
            this._separatePair(A, B);
          }
        }

        /* ② 相邻格之间：只遍历"右/下"半边的邻域（相对偏移集合见下）。
           这个偏移集合恰好覆盖 8 个邻居各一次，因此不重不漏，
           而且与坐标正负、格子编号大小都无关 ——
           用「网格 key 比大小」来去重是错的：球被推到负坐标区时
           key 的大小关系与格子的相对方位并不对应，会漏掉真实相邻的格子。
           常见错法还有把同列的 dy 写成只取 0，那会漏掉"正上/正下"格子，
           两球能互相穿透而过（实测穿透 16 单位、相对速度 -198 却毫无碰撞）。 */
        const NEIGHBORS = [[0, 1], [1, -1], [1, 0], [1, 1]];
        for (const [dx, dy] of NEIGHBORS) {
          const other = grid.get((gx + dx) * 100003 + (gy + dy));
          if (!other) continue;
          for (let a = 0; a < bucket.length; a++) {
            const A = units[bucket[a]];
            if (!A.alive) continue;
            for (let c = 0; c < other.length; c++) {
              const B = units[other[c]];
              if (!B.alive || !overlapping(A, B)) continue;
              acted++;
              // 同样：先冲量、后分离（原因见同格分支的注释）
              if (pass < 2) this._resolveCollision(A, B, e);
              this._separatePair(A, B);
            }
          }
        }
      }
      if (acted === 0) break;   // 没有重叠了，提前结束
    }
  }

  /** 只做位置分离（调用前已确认重叠） */
  _separatePair(A, B) {
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const rr = A.r + B.r;
    const d2 = dx * dx + dy * dy;
    let d = Math.sqrt(d2);
    let nx, ny;
    if (d < 1) {
      // 完全重合：给一个确定的分离方向，避免除零
      nx = SCALE; ny = 0; d = 0.001;
    } else {
      nx = Math.round((dx * SCALE) / d);
      ny = Math.round((dy * SCALE) / d);
    }
    const overlap = rr - d;

    const totalMass = A.mass + B.mass;
    const pushA = Math.round(overlap * (B.mass / totalMass));
    const pushB = overlap - pushA;
    A.x -= Math.round((nx * pushA) / SCALE);
    A.y -= Math.round((ny * pushA) / SCALE);
    B.x += Math.round((nx * pushB) / SCALE);
    B.y += Math.round((ny * pushB) / SCALE);
    return true;
  }

  /** 解一对圆球的碰撞：沿法线交换速度（位置分离由 _separatePair 负责） */
  _resolveCollision(A, B, e) {
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const rr = A.r + B.r;
    const d2 = dx * dx + dy * dy;
    if (d2 === 0 || d2 >= rr * rr) return;

    const d = Math.sqrt(d2);
    // 法线（A 指向 B）
    const nx = Math.round((dx * SCALE) / d);
    const ny = Math.round((dy * SCALE) / d);

    /* --- 冲量：沿法线做弹性碰撞 --- */
    const rvx = B.vx - A.vx;
    const rvy = B.vy - A.vy;
    const vn = Math.round((rvx * nx + rvy * ny) / SCALE);   // 相对速度在法线上的分量

    // 记录碰撞前各自的速率
    const spA = Math.hypot(A.vx, A.vy);
    const spB = Math.hypot(B.vx, B.vy);

    const invA = 1 / A.mass;
    const invB = 1 / B.mass;

    if (vn > 0) {
      /* 已经在分离：通常什么都不用做。
         但有一种必须处理的情形：两个球的相对速度**几乎平行于接触面**
         （v·n ≈ 0），又紧贴着。此时：
           移动阶段把它们推到一起 2 单位/帧，
           分离推挤又把它们推回去 2 单位/帧，
         两者精确抵消 —— 位置完全冻结，只有航向被反复旋转。
         实测表现就是"小球有速度却一动不动，卡在相切位置"。
         所以这里给一个很小的分离速度下限，把它推离接触状态。 */
      const minSepTiny = 0.15 * Math.max(A.speed, B.speed);
      if (vn < minSepTiny) {
        const need = minSepTiny - vn;
        const wA = invA / (invA + invB);
        const wB = invB / (invA + invB);
        A.vx -= Math.round((nx * need * wA) / SCALE);
        A.vy -= Math.round((ny * need * wA) / SCALE);
        B.vx += Math.round((nx * need * wB) / SCALE);
        B.vy += Math.round((ny * need * wB) / SCALE);
      }
      restoreSpeed(A, spA);
      restoreSpeed(B, spB);
      this._ensureMoving(A);
      this._ensureMoving(B);
      return;
    }

    // j = -(1+e) * vn / (1/mA + 1/mB)
    const j = (-(1 + e) * vn) / (invA + invB);

    A.vx -= Math.round((j * invA * nx) / SCALE);
    A.vy -= Math.round((j * invA * ny) / SCALE);
    B.vx += Math.round((j * invB * nx) / SCALE);
    B.vy += Math.round((j * invB * ny) / SCALE);

    // 防呆：速度不该变成 0（会出现"停住不动"的观感）
    this._ensureMoving(A);
    this._ensureMoving(B);

    /* --- 保证确实在分开 ---
       重球撞轻球时，按质量反比解出的冲量可能让小球的法向相对速度仍接近 0，
       两球就会贴合着一起走 —— 观感就是"粘在一起、方向没变"。
       所以给分离速度设一个下限：不够就补到下限。 */
    const minSep = 0.35 * Math.max(A.speed, B.speed);
    let sep = Math.round(((B.vx - A.vx) * nx + (B.vy - A.vy) * ny) / SCALE);
    if (sep < minSep) {
      const need = minSep - sep;
      const wA = invA / (invA + invB);
      const wB = invB / (invA + invB);
      A.vx -= Math.round((nx * need * wA) / SCALE);
      A.vy -= Math.round((ny * need * wA) / SCALE);
      B.vx += Math.round((nx * need * wB) / SCALE);
      B.vy += Math.round((ny * need * wB) / SCALE);
      sep = minSep;
    }

    /* --- 保证"看得见转向" ---
       擦碰（法向相对速度极小）在物理上确实只会让方向几乎不变 ——
       实测 530 次碰撞里有十几次双方转向都小于 5°，全都是这种相切滑过。
       但玩家看到两球接触就该看到方向变化，否则会认为"撞了没反应"。

       做法：让每个球至少以 minTurn 的角度离开接触面（法线）。
       这既保证每一次可见接触都有可见偏转，也让两球的轨迹真正分岔，
       不会贴着走一路继续擦碰。 */
    const minTurn = this.rules.contactMinTurnDeg ?? 8;
    if (minTurn > 0) {
      const penWorld = (rr - d) / SCALE;
      // 对 A：出射方向 = +n
      this._ensureSeparationAngle(A, nx, ny, ny, -nx, minTurn, penWorld);
      // 对 B：出射方向 = −n
      this._ensureSeparationAngle(B, -nx, -ny, -ny, nx, minTurn, penWorld);
    }

    /* 完全弹性碰撞下，两球各自的速率都不应改变 —— 改变的只有方向。
       但斜法线经定点取整后不是精确单位向量（45° 时长度约 0.707），
       冲量会被 |n|² 缩放，实测菱形场地一次碰撞就掉 9% 速度。
       这里按碰撞前的速率还原，符合"动能不损失"的物理定义。 */
    if (e >= 1) {
      restoreSpeed(A, spA);
      restoreSpeed(B, spB);
    }

    this._emit('bounce', A, B, Math.abs(vn) / SCALE, { nx, ny });
  }

  /**
   * 保证 u 不会"贴着接触面滑走"。
   *
   * 只在球仍在朝接触面靠近时介入 —— 弹开的球必须原样保留，
   * 否则对撞（两球迎面撞上）会被错误地推向同一侧，物理上就错了。
   *
   * @param {object} u  小球
   * @param {number} dT 出射方向（远离对方），定点
   * @param {number} dN 接触面法线方向，定点
   * @param {number} minTurn 最小出射夹角（度）
   */
  _ensureSeparationAngle(u, nx, ny, dTx, dTy, minTurn, pen) {
    if (!u.alive) return;
    const speed = Math.hypot(u.vx, u.vy);
    if (speed < 1) return;

    /* 穿透很深时不要动方向：此时"接触面"的方位本来就不可靠，
       按它旋转反而可能把球推向第三个球。深穿透交给分离迭代去解。 */
    if (pen > 1.5) return;

    const vn = u.vx * nx + u.vy * ny;

    const curA = Math.atan2(u.vy, u.vx);
    const outA = Math.atan2(dTy, dTx);
    let d = curA - outA;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;

    const minRad = (minTurn * Math.PI) / 180;
    const offTangent = Math.abs(Math.abs(d) - Math.PI / 2);

    if (vn >= 0) {
      /* 已经在远离接触面，方向不动 —— 除了一个必须处理的例外：
         速度**几乎平行于接触面**（贴着切向滑）时，
         运动会被分离推挤精确抵消，小球会卡在相切位置一动不动。
         实测"速度 120 却整整一秒零位移"就是这个原因。
         所以把这种贴切向的速度掰出一个最小出射角。 */
      if (offTangent >= Math.PI / 2 - minRad) return;   // 已经斜着离开了
    } else {
      // 正在靠近：本来就要按最小出射角纠正
      if (offTangent <= Math.PI / 2 - minRad && Math.abs(d) >= minRad) return;
    }

    const sign = d >= 0 ? 1 : -1;
    const target = outA + sign * minRad;
    const turnDeg = ((target - curA) * 180) / Math.PI;
    if (Math.abs(turnDeg) < 0.05) return;

    const r = rotateVel(u.vx, u.vy, turnDeg);
    u.vx = r.vx; u.vy = r.vy;
    restoreSpeed(u, speed);
    u.face = ((Math.atan2(u.vy, u.vx) * 180) / Math.PI + 360) % 360;
  }

  /** 碰撞后若速度过小则给一个最小速度，避免小球停在原地 */
  _ensureMoving(u) {
    const minSpeed = u.speed * 0.25;
    const cur = Math.hypot(u.vx, u.vy);
    if (cur >= minSpeed) return;
    if (cur < 1) {
      // 速度几乎归零：沿原朝向重新给一个速度
      const a = ((u.face ?? u.spawnAngle ?? 0) * Math.PI) / 180;
      u.vx = Math.round(Math.cos(a) * minSpeed);
      u.vy = Math.round(Math.sin(a) * minSpeed);
    } else {
      const k = minSpeed / cur;
      u.vx = Math.round(u.vx * k);
      u.vy = Math.round(u.vy * k);
    }
  }

  /**
   * 只解重叠、不施加冲量。
   * 用于边界夹紧之后：夹紧会把几个球朝场地内堆到一起，
   * 那一刻产生的穿透必须解开，否则帧末会留下"叠着还在往里挤"的球对。
   */
  _relieveOverlap() {
    const units = this.units;
    // 与 _collide 用同样的单元尺寸：必须 ≥ 接触判定距离(2r)
    const cellSize = 40 * SCALE;
    for (let pass = 0; pass < 3; pass++) {
      const grid = new Map();
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (!u.alive) continue;
        const key = ((u.x / cellSize) | 0) * 100003 + ((u.y / cellSize) | 0);
        let b = grid.get(key);
        if (!b) grid.set(key, (b = []));
        b.push(i);
      }
      let acted = 0;
      for (const [key, bucket] of grid) {
        const gx = Math.floor(key / 100003);
        const gy = key - gx * 100003;
        // 同格内部：不会重复
        for (let a = 0; a < bucket.length; a++) {
          const A = units[bucket[a]];
          if (!A.alive) continue;
          for (let c = a + 1; c < bucket.length; c++) {
            const B = units[bucket[c]];
            if (!B.alive || !overlapping(A, B)) continue;
            acted++; this._separatePair(A, B);
          }
        }
        /* 跨格：必须遍历完整 3×3 邻域，再用"单元坐标字典序"去重，
           保证每对相邻单元恰好处理一次。
           不能只取半边偏移（如右/下）—— 那只能覆盖同格内部，
           跨格时"左/上"方向的邻居会被漏掉，
           于是深穿透的一对球会一直叠着（相对速度很大却毫无分离）。 */
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            // 字典序去重：只处理"邻居队列 >= 自己队列"的一侧
            if (dx < 0 || (dx === 0 && dy < 0)) continue;
            const other = grid.get((gx + dx) * 100003 + (gy + dy));
            if (!other) continue;
            for (let a = 0; a < bucket.length; a++) {
              const A = units[bucket[a]];
              if (!A.alive) continue;
              for (let c = 0; c < other.length; c++) {
                const B = units[other[c]];
                if (!B.alive || !overlapping(A, B)) continue;
                acted++; this._separatePair(A, B);
              }
            }
          }
        }
      }
      if (acted === 0) break;
    }
  }

  /* ---------- 攻击结算 ----------
     注意：网格单元尺寸必须 ≥ 单次查询半径。
     否则两个明明在攻击范围内的小球，会因为落在斜对角的格子里而永远查不到对方
     —— 这类 bug 表现为"完全静默、零伤害"，极难从画面上看出来。
     ------------------------------------------------------------ */
  _resolveAttacks() {
    const units = this.units;
    const queryR = 40 * SCALE;
    const cellSize = Math.max(40 * SCALE, queryR);
    const grid = new Map();
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!u.alive) continue;
      const key = ((u.x / cellSize) | 0) * 100003 + ((u.y / cellSize) | 0);
      let b = grid.get(key);
      if (!b) grid.set(key, (b = []));
      b.push(i);
    }

    /* 先处理同一格内部的配对，再处理相邻格之间的配对。
       用 index 比较去重：跨格时两个方向的遍历会碰到同一对，
       只保留 bucket index 小于 other index 的那一次。 */
    for (const [key, bucket] of grid) {
      const gx = Math.floor(key / 100003);
      const gy = key - gx * 100003;

      // ① 同格内部
      for (let a = 0; a < bucket.length; a++) {
        const A = units[bucket[a]];
        if (!A.alive) continue;
        for (let c = a + 1; c < bucket.length; c++) {
          const B = units[bucket[c]];
          if (!B.alive) continue;
          if (A.team === B.team && !this.rules.friendlyFire) continue;
          this._attackPair(A, B);
        }
      }

      // ② 相邻格之间（完整 3×3 邻域，只取序号更大的一侧避免重复）
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const nKey = (gx + dx) * 100003 + (gy + dy);
          if (nKey <= key) continue;
          const other = grid.get(nKey);
          if (!other) continue;
          for (let a = 0; a < bucket.length; a++) {
            const A = units[bucket[a]];
            if (!A.alive) continue;
            for (let c = 0; c < other.length; c++) {
              const B = units[other[c]];
              if (!B.alive) continue;
              if (A.team === B.team && !this.rules.friendlyFire) continue;
              this._attackPair(A, B);
            }
          }
        }
      }
    }
  }

  /** 判定一对小球能否互相攻击并结算伤害 */
  _attackPair(A, B) {
    const ddx = B.x - A.x, ddy = B.y - A.y;
    /* 攻击判定范围 = 两球半径 + 6 单位余量。
       常量就是常量：不接受任何"临时加成"，没接触就是没伤害。 */
    const gap = A.r + B.r + Math.round(6 * SCALE);
    if (ddx * ddx + ddy * ddy > gap * gap) return;

    const k1 = Math.min(A.id, B.id) * this.pairKeyBase + Math.max(A.id, B.id);
    if ((this.pairCd.get(k1) || 0) > this.time) return;

    /* 加速冲撞：把碰撞伤害提升到 SKILL_PARAMS.dash.damage，
       并在命中时把对手推开。用一个"本次冲刺内每个目标只吃一次"的集合去重，
       避免两球贴合着前进时反复被推开、看起来像抽搐。 */
    const D = SKILL_PARAMS.dash;
    const dir = (att, def) => {
      const dx = def.x - att.x, dy = def.y - att.y;
      const d = Math.hypot(dx, dy) || 1;
      return { nx: dx / d, ny: dy / d };
    };

    let dealt = false;
    /* 隐身（折光）：隐身期间不会受到敌方小球的**近战**伤害。
       只挡近战 —— 弹道与场地物件不受影响，这是技能说明的原文口径。 */
    const meleeImmune = (def) => def.stealthFrames > 0 || def.meleeImmuneFrames > 0;
    /* 碰撞伤害就是 u.melee 这一个数：
         基础 0 → 折光给 100 → 开华再 +50（两者都有就是 150）。
       刻意**不**在这里叠 lightBonus —— 那个是给技能伤害用的，
       否则"只有开华"会算成 50+50=100，与设定不符。
       但要过 _meleeDamage，这样析光分身的碰撞伤害也自动变成 1/3。 */
    const crescent = (att, def) => {
      if (att.bloomed && att.melee > 0) this._emit('crescent', att, def, 0);
    };

    if (A.hitCd <= 0 && A.melee > 0 && !meleeImmune(B)) {
      const dash = this.contactBoost.get(A.id) === 'dashing';
      if (dash && A.dashHits && A.dashHits.has(B.id)) {
        // 本次冲刺已伤过它，本次跳过（冷却照常走下面的逻辑）
      } else {
        this._damage(A, B, dash ? D.damage : this._meleeDamage(A), dash ? 'dash' : 'melee');
        A.hitCd = 0.5;
        dealt = true;
        if (!dash) crescent(A, B);
        if (dash) {
          A.dashHits.add(B.id);
          const n = dir(A, B);
          const kb = D.knockback * SCALE;
          B.vx = Math.round(n.nx * kb);
          B.vy = Math.round(n.ny * kb);
          this._emit('knock', A, B, D.knockback);
        }
      }
    }
    if (B.hitCd <= 0 && B.alive && B.melee > 0 && !meleeImmune(A)) {
      const dash = this.contactBoost.get(B.id) === 'dashing';
      if (dash && B.dashHits && B.dashHits.has(A.id)) {
        // 同上
      } else {
        this._damage(B, A, dash ? D.damage : this._meleeDamage(B), dash ? 'dash' : 'melee');
        B.hitCd = 0.5;
        dealt = true;
        if (!dash) crescent(B, A);
        if (dash) {
          B.dashHits.add(A.id);
          const n = dir(B, A);
          const kb = D.knockback * SCALE;
          A.vx = Math.round(n.nx * kb);
          A.vy = Math.round(n.ny * kb);
          this._emit('knock', B, A, D.knockback);
        }
      }
    }
    if (dealt) {
      A.hitsDealt++; B.hitsTaken++;
      B.hitsDealt++; A.hitsTaken++;
      this.pairCd.set(k1, this.time + 0.5);
      // 撞击触发类技能
      this._runSkills(A, 'onHit', { other: B });
      this._runSkills(B, 'onHit', { other: A });
    }
  }

  /* ---------- 伤害与死亡 ----------
     opts:
       traits      特质标签数组（目前只用到 'light'）
       quiet       true 时不发 hit 事件（每帧持续伤害用，飘字另行合并输出）
       unavoidable true 时无视闪避（场地持续的接触伤害用） */
  _damage(from, to, amount, kind, opts = {}) {
    if (!to.alive || amount <= 0) return;
    /* 伤害就是传进来的那个数，不做任何全局放大。
       这里以前会乘一个"僵局破解器"的 dmgMul（最高 2.5 倍），
       导致冲刺技能标着 200 却在屏幕上打出 500。
       破解器已移除，数值从此和属性表 / 技能表严格一致。 */
    let dmg = amount;

    /* 闪避（辉光领域）：10% / 开华后 15%。
       用本局种子流取值，所以同一条种子必然闪避同样的次数，不影响可复现性。 */
    if (!opts.unavoidable && to.dodge > 0 && this.rnd() < to.dodge) {
      this._emit('dodge', null, to, 0, { kind });
      return;
    }

    // 技能钩子：允许技能修改伤害（护盾、减伤、增伤）
    const mod = this._runHooks(to, 'onBeforeDamage', { from, amount: dmg, kind }) || {};
    dmg = Math.max(1, Math.round(mod.amount ?? dmg));

    to.hp -= dmg;
    to.taken += dmg;
    to.flash = 0.18;
    if (kind) to.damageFrom[kind] = (to.damageFrom[kind] || 0) + dmg;
    if (from) {
      from.dmg += dmg;
      if (from.resDef?.gainOnHit) {
        from.res = Math.min(from.resMax, from.res + from.resDef.gainOnHit);
      }
      this._runHooks(from, 'onHit', { target: to, dmg, kind });
    }

    if (!opts.quiet) this._emit('hit', from, to, dmg, { kind, light: (opts.traits || []).includes('light') });

    /* "被真正的打击命中"钩子。
       区分得很重要：裁光质点/细线的**每帧接触伤害**和场地灼烧都不算
       "被打了一下" —— 一秒 60 次的接触伤害如果每次都触发"被攻击"类效果，
       任何"被攻击时叠层"的技能都会瞬间叠满，等于没有设计。
       所以只有一次性打击（近战、弹道、爆炸）才置 heavy。 */
    const heavy = !opts.quiet && kind !== 'zone';
    this._runHooks(to, 'onDamaged', { from, amount: dmg, kind, heavy });

    if (to.hp <= 0) {
      to.hp = 0;
      to.alive = false;
      if (from) from.kills++;
      this._emit('death', from, to, 0);
      this._runHooks(to, 'onDeath', { killer: from });
      if (this.rules.respawn) {
        to.respawnAt = this.frame + Math.round((this.rules.respawnDelay || 3) / DT);
        this._emit('respawnPending', to, null, to.respawnAt);
      }
    }
  }

  /* ---------- 技能钩子（当前无技能，接口先留好） ---------- */
  _runHooks(u, hook, ctx) {
    const list = u.hooks;
    if (!list || !list[hook]) return undefined;
    let ret;
    for (const fn of list[hook]) {
      const r = fn(this, u, ctx);
      if (r) ret = r;
    }
    return ret;
  }

  /* ---------- 事件流 ---------- */
  _emit(type, a, b, value, extra) {
    if (this.events.length > 6000) return;   // 安全阀
    this.events.push({
      f: this.frame,
      type,
      value,
      a: a ? a.id : -1,
      b: b ? b.id : -1,
      ax: a ? a.x / SCALE : 0,
      ay: a ? a.y / SCALE : 0,
      bx: b ? b.x / SCALE : 0,
      by: b ? b.y / SCALE : 0,
      color: a ? a.color : '#888',
      ...(extra || {})
    });
  }

  /* ---------- 胜负 ---------- */
  _aliveTeams() {
    const set = new Set();
    for (const u of this.units) {
      if (u.alive) set.add(u.team);
      else if (this.rules.respawn) set.add(u.team); // 待复活也算还活着
    }
    return [...set];
  }

  _teamHp(team) {
    let sum = 0;
    for (const u of this.units) if (u.team === team) sum += Math.max(0, u.hp);
    return sum;
  }

  _leaderByHp() {
    const teams = new Set(this.units.map(u => u.team));
    let best = -1, bestHp = -1, tie = false;
    for (const t of teams) {
      const hp = this._teamHp(t);
      if (hp > bestHp) { bestHp = hp; best = t; tie = false; }
      else if (hp === bestHp) tie = true;
    }
    return tie ? -2 : best;
  }

  _checkEnd() {
    const alive = this._aliveTeams();
    if (alive.length <= 1) {
      this.over = true;
      this.winner = alive.length === 1 ? alive[0] : -2;
      this.endReason = alive.length === 1 ? '其余队伍全部阵亡' : '全部阵亡';
      this._emit('end', null, null, this.winner, { reason: this.endReason });
      return;
    }
    if (this.rules.timeLimit > 0 && this.time >= this.rules.timeLimit) {
      this.over = true;
      this.winner = this._leaderByHp();
      this.endReason = '达到时间上限，按剩余总血量判定';
      this._emit('end', null, null, this.winner, { reason: this.endReason });
    }
  }

  /* ---------- 一次性算完整局 ----------
     inputProvider 每帧被调用，返回 {dx,dy} 作为玩家操控意图。
     注意：由于玩家操控无法"预先知道"，实战中采用固定节奏采样
     （见 ui-battle.js），把采样结果按帧喂进来，这样模拟仍然是一次性
     算完的，倍速/暂停/回放全部照常可用。
     inputProvider 也可以返回 {stop:true} 来中止本次预算。
     ------------------------------------------------ */
  runToEnd(inputProvider) {
    let guard = 0;
    while (!this.over && guard < this.maxFrames + 10) {
      const inp = inputProvider ? inputProvider(this) : null;
      if (inp && inp.stop) return this;
      this.step(inp);
      guard++;
    }
    return this;
  }

  /* ---------- 结果指纹：用于验证同一配置必然得到同一结果 ---------- */
  fingerprint() {
    let h = 2166136261;
    const last = this.snapshots[this.snapshots.length - 1].data;
    for (let i = 0; i < last.length; i++) {
      h ^= (last[i] | 0);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= this.frame | 0;
    h = Math.imul(h, 16777619) >>> 0;
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  /* ---------- 战报 ---------- */
  summary() {
    const nameOf = id => (this.units[id] ? this.units[id].name : '?');
    const teamOf = id => (this.units[id] ? this.units[id].team : -1);
    return {
      frames: this.frame,
      seconds: +(this.frame * DT).toFixed(2),
      winner: this.winner,
      endReason: this.endReason,
      fingerprint: this.fingerprint(),
      units: this.units.map(u => ({
        id: u.id, team: u.team, name: u.name, color: u.color,
        hp: Math.max(0, Math.round(u.hp)), maxHp: u.maxHp,
        alive: u.alive, kills: u.kills,
        dmg: Math.round(u.dmg), taken: Math.round(u.taken)
      })),
      stats: {
        totalDamage: Math.round(this.units.reduce((s, u) => s + u.dmg, 0)),
        survivors: this.units.filter(u => u.alive).length,
        teamsAlive: this._aliveTeams().length
      },
      nameOf, teamOf
    };
  }
}

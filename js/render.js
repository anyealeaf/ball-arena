/* ============================================================
   render.js — 渲染层（只读）
   ------------------------------------------------------------
   铁律：本文件绝不修改战斗状态。
   所有画面都来自「快照 + 事件流」，因此：
     · 倍速播放 = 换播放头推进速度
     · 暂停/单步 = 停住播放头
     · 回放 = 播放头往回拖
   画布坐标系固定为 WORLD_W × WORLD_H 的世界坐标，浏览器负责等比缩放。
   ============================================================ */

import { SCALE, DT, WORLD_W, WORLD_H } from './balls.js';
import { teamColor } from './balls.js';
import { effectiveShape, pointInZone, arenaBounds } from './arenas.js';
import { SNAP_STRIDE, PROJ_STRIDE, FIELD_STRIDE } from './core.js';

const FONT = '"Segoe UI","Microsoft YaHei",system-ui,sans-serif';

/* 光柱（激光）各层的不透明度。
   **本体这一层就是"光柱的透明度"**，作者定在 75%。

   注意三层会**叠加**，所以肉眼看到的比 0.75 更实：
     本体 0.75 + 柔光外壳 0.21  →  中间实心带约 80%
     再叠白色高光核心线         →  正中心约 94%
   要让整道光柱更透，调这一个数就行（柔光与核心都按比例跟着走）；
   如果只是嫌正中间那条白线太亮，调 BEAM_CORE。 */
const BEAM_ALPHA = 0.75;
const BEAM_GLOW = 0.28;      // 柔光外壳相对本体的比例
const BEAM_CORE = 0.95;      // 中心高亮核心线相对本体的比例


/* 把 #rgb / #rrggbb 颜色转成带透明度的 rgba()。
   弹道外发光需要"同一个颜色、不同透明度"的多个渐变色标，
   直接用 globalAlpha 会让整块渐变一起变淡，出不来发光感。 */
function hexA(color, a) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || '').trim());
  if (!m) return `rgba(125,211,252,${a})`;          // 认不出来就退回默认弹道色
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const v = parseInt(h, 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}

/* ------------------------------------------------------------
   小球贴图缓存
   ------------------------------------------------------------
   贴图是"头部圆形贴图"（已带 alpha 遮罩），直接用 drawImage 画成圆。
   浏览器首次绘制时才加载会导致第一帧空白，所以这里提前预加载并按路径缓存；
   未加载完成时渲染层回退成纯色圆，不会出现空洞。
   ------------------------------------------------------------ */
const stickerCache = new Map();

function getSticker(src) {
  // 无头/测试环境没有 Image 构造器：直接返回 null，渲染层回退纯色圆
  if (!src || typeof Image === 'undefined') return null;
  let entry = stickerCache.get(src);
  if (entry) return entry;
  entry = { img: new Image(), ready: false };
  entry.img.onload = () => { entry.ready = true; };
  entry.img.onerror = () => { entry.failed = true; };
  entry.img.src = src;
  stickerCache.set(src, entry);
  return entry;
}

/** 预加载一组球种用到的贴图（进入战斗前调用一次） */
export function preloadStickers(speciesList) {
  for (const sp of speciesList || []) {
    if (sp && sp.sticker && sp.sticker.src) getSticker(sp.sticker.src);
    // 形态切换的第二张贴图（如晕彩的开华形态）也要预热，否则切换瞬间会闪一下纯色圆
    if (sp && sp.stickerBloom && sp.stickerBloom.src) getSticker(sp.stickerBloom.src);
    /* 手持物件（弓）同理。多帧的话每一帧都要预热 ——
       否则拉到某一帧才第一次去加载，会看到弓闪一下不见了。 */
    if (sp && sp.bow) {
      if (sp.bow.src) getSticker(sp.bow.src);
      for (const f of sp.bow.frames || []) if (f && f.src) getSticker(f.src);
    }
    /* 辉光领域的背景长图同理 —— 不预热的话展开动画会从"空白"开始，
       气浪扫过去一片空，等图加载完才补上。 */
    if (sp && sp.domain && sp.domain.src) getSticker(sp.domain.src);
  }
}

/** 按施法进度 castP 挑弓的动作状态 —— 与作者的描述一一对应：
 *    castP = 0        → idle 平时（弓举着，弦是直的）
 *    0 < castP < 1    → draw 准备射箭（弦拉开，搭好一支箭）
 *    castP = 1        → shot 射箭那一帧（弓回到平时，箭已经离弦）
 *  `shot` 没单独给图就回退成 idle，也就是作者说的"射箭的时候切换为 1"。
 *  射箭那一帧只持续一帧（16ms），是刻意的"撒放"效果 —— 弓啪地弹回去。 */
function bowStateSrc(bow, castP) {
  if (!bow) return null;
  if (castP <= 0) return bow.idle;
  if (castP >= 0.999) return bow.shot || bow.idle;
  return bow.draw;
}

export class Renderer {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.showDamage = true;
    this.showHud = true;      // 是否显示血条/资源条
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    /* 场地大小：小场地会被放大铺满画布，避免四周留一大圈空白。
       渲染坐标恒为 0..WORLD_W / 0..WORLD_H，缩放交给 canvas 变换。 */
    this.sizeScale = 1;
    this.resize();
  }

  /**
   * 重算绘图缓冲区与相机。
   *
   * 尺寸策略（重要）：
   *   · CSS 负责显示尺寸 —— 高度用 aspect-ratio 由宽度推出，宽度填满容器。
   *   · JS 只负责绘图缓冲区（canvas.width/height）与相机。
   * 之前是 JS 写死 CSS 宽高、同时又去读父元素宽度，两套尺寸互相影响，
   * 出现过"设置值 2.317、实际用 1.0"这类自相矛盾的情况。
   * 现在 JS 不再写 style，彻底避免与 CSS 打架。
   *
   * 关键：这里读的是 canvas 自身的显示尺寸（getBoundingClientRect），
   * 它会随 CSS 自动变化，所以 ResizeObserver 回调里调用本函数是安全的。
   */
  resize() {
    const cv = this.cv;
    const box = this._arenaBox();
    const boxW = Math.max(1, box.maxX - box.minX);
    const boxH = Math.max(1, box.maxY - box.minY);

    /* 读画布的内容宽度。
       clientWidth 就是"不含边框的内容区宽度"，正对应绘图缓冲区。
       宽度由 CSS（width:100%）撑开，所以它是唯一的数据源；
       高度再由宽度按场地宽高比算出来并写死 —— 不再依赖 aspect-ratio，
       因为实测浏览器并不总会按 aspect-ratio 算出预期高度，
       结果画布偏高、场地只占上半部分。 */
    let dispW = cv.clientWidth || 0;
    if (!dispW) {
      // 布局尚未完成时 clientWidth 为 0，退化为按容器/世界宽度估算
      const parent = cv.parentElement;
      dispW = (parent && parent.clientWidth) || 720;
    }
    dispW = Math.max(240, Math.round(dispW));

    const scale = dispW / boxW;
    const dispH = Math.max(1, Math.round(boxH * scale));

    // 宽高都由这里定死：内容区恰好等于场地，场地就会贴满画布
    cv.style.aspectRatio = String(boxW / boxH);
    cv.style.height = dispH + 'px';

    /* 缓冲区按 dpr 放大以保证清晰，但要设上限：
       页面放宽后宽屏画布可能到 1500px 以上，若再乘 dpr=2
       缓冲区会超过 3000px 宽（约 12MB），既占内存也拖慢重绘。
       超过上限时按比例缩小 dpr，画面略微变软但依然清晰。 */
    const MAX_BUF_W = 2200;
    const bufScale = Math.min(this.dpr, MAX_BUF_W / dispW);
    cv.width = Math.round(dispW * bufScale);
    cv.height = Math.round(dispH * bufScale);
    this._bufScale = bufScale;

    /* 相机：把场地包围盒映射到整块画布（贴边，不留额外边距）。
       **这里必须用 cv.width（缓冲区宽度），不能用 dispW（CSS 宽度）。**
       draw() 是在缓冲区坐标系上 ctx.scale()，而缓冲区比 CSS 尺寸大 bufScale 倍
       （高清屏 dpr，或用 MAX_BUF_W 压过的值）。
       写成 dispW / boxW 的话，场地只铺满画布的 1/bufScale：
       dpr=1 时看不出来，dpr=1.25/1.5/2 的屏幕上就会在右边和下边留一条空白 ——
       作者在 135% 缩放的机器上看到"战场铺不满画布"就是这个。
       一直没被测出来，是因为 smoke 里 devicePixelRatio=1，而且那条断言比的是
       camScale × boxW ≈ cssW —— 按构造必然成立，等于没测。 */
    this.camScale = cv.width / boxW;
    this.camX = box.minX;
    this.camY = box.minY;
    this.boxW = boxW;
    this.boxH = boxH;
    this.cssW = dispW;
    this.cssH = dispH;

    // 诊断信息：排查尺寸问题时用
    this._resizeCount = (this._resizeCount || 0) + 1;
    this._lastDispW = dispW;
    this._lastSetScale = scale;
  }

  /**
   * 场地在世界坐标系里的包围盒 —— 不额外留边距。
   *
   * 曾经这里加了 3% 的 padding，结果场地四周留出一圈空白，
   * 场地边缘与画布边缘对不齐，看起来就是"场地显示与页面不一致"。
   * 现在直接贴合包围盒：场地边缘就是画布边缘。
   * （圆形的包围盒是正方形，左右仍会有少量留白，那是几何决定的，无法避免。）
   */
  _arenaBox() {
    const s = this.arenaShape;
    if (!s) return { minX: 0, minY: 0, maxX: WORLD_W, maxY: WORLD_H };
    const b = arenaBounds(s);
    return { minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY };
  }

  /** 换场地或换大小时调用：更新几何并重算画布 */
  setArena(arena, sizeScale) {
    this.arenaShape = arena ? arena.shape : null;
    if (sizeScale !== undefined) this.sizeScale = sizeScale;
    this.resize();
  }

  /** 世界坐标是否在视野内（用于剔除） */
  get viewW() { return this.boxW || WORLD_W; }
  get viewH() { return this.boxH || WORLD_H; }

  /* ---------- 主绘制入口 ----------
     frame: 播放头所在帧号（可能小于 battle.frame，实现回放）
  */
  draw(battle, frame, opts = {}) {
    const ctx = this.ctx;
    const cv = this.cv;
    /* 等比缩放：横向与纵向共用 this.scale，并把坐标平移到世界窗口原点。
       用同一个比例是画面不被拉伸的前提。 */
    const s = this.camScale || (cv.width / WORLD_W);
    const camX = this.camX ?? 0;
    const camY = this.camY ?? 0;

    // 记录本帧实际使用的变换，供"尺寸信息"面板核对（渲染与报告必须一致）
    this._usedScale = s;
    this._usedCamX = camX;
    this._usedCamY = camY;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    this._bg(ctx, cv.width, cv.height);   // 背景铺满整块画布（屏幕坐标系）

    ctx.save();
    ctx.scale(s, s);
    ctx.translate(-camX, -camY);

    const snapIdx = Math.min(frame, battle.snapshots.length - 1);
    const snap = battle.snapshots[snapIdx];
    const time = snap.f * DT;

    // 用与引擎一致的方式还原"这一帧的场地几何"
    const shrink = battle.rules.allowShrink ? battle.arena.effects?.shrink : null;
    const arenaForShape = shrink
      ? battle.arena
      : { ...battle.arena, effects: { ...(battle.arena.effects || {}), shrink: null } };
    const shape = effectiveShape(arenaForShape, time);

    /* 记下这一帧的场地几何：光柱要按它裁剪（见 _projectiles）。
       不裁的话，1400 单位长的贯穿光柱会冲出场地，
       在圆形/多边形场地里就会画到场地外面那段空白上。 */
    this._frameShape = shape;
    this._zones(ctx, battle.arena);
    this._shape(ctx, shape, battle.rules.allowShrink && battle.arena.effects?.shrink);
    /* 辉光领域铺在场地之上、小球之下：它是背景氛围，不该盖住任何东西 */
    if (battle.aurora) this._aurora(ctx, battle, snap);
    this._events(ctx, battle, snap.f);
    /* 弹道画在小球下面：飞行物从球体背后穿过去，视觉上更清楚，
       也不会盖住血条。 */
    this._projectiles(ctx, battle, snap);
    /* 场地物件（质点/细线/光门）画在小球之上：
       细线是"压在小球身上的线"，被球盖住就看不出敌人有没有踩上去。 */
    this._units(ctx, battle, snap, opts);
    this._fields(ctx, snap);
    ctx.restore();

    // 画布边界标线（仅调试）：把场地应当贴合的矩形显式画出来
    if (this.showFrame) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.strokeStyle = '#e8452c';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.strokeRect(1, 1, cv.width - 2, cv.height - 2);
      ctx.restore();
    }
  }

    /* 背景：铺满整块画布（屏幕坐标，不随相机缩放）。
       颜色与场地内部一致 —— 场地是贴边铺满的，两者不该有肉眼可见的分界。 */
  _bg(ctx, w, h) {
    ctx.fillStyle = '#fdfcf7';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#eee9db';
    ctx.lineWidth = 1;
    const step = 24 * (this._bufScale || this.dpr || 1);
    for (let x = 0; x <= w; x += step) {
      ctx.beginPath(); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, h); ctx.stroke();
    }
    for (let y = 0; y <= h; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(w, y + .5); ctx.stroke();
    }
  }

  /* ---------- 区域效果 ---------- */
  _zones(ctx, arena) {
    for (const z of arena.zones || []) {
      const s = z.shape;
      ctx.save();
      if (s.kind === 'circle') {
        ctx.beginPath();
        ctx.arc(s.cx, s.cy, s.r, 0, Math.PI * 2);
      } else {
        ctx.beginPath();
        ctx.rect(s.x, s.y, s.w, s.h);
      }
      ctx.fillStyle = z.color || 'rgba(0,0,0,0.06)';
      ctx.fill();
      if (z.edge) {
        ctx.strokeStyle = z.edge;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }
  }

  /* ---------- 场地轮廓 ---------- */
  _shape(ctx, shape, shrinking) {
    ctx.save();
    ctx.beginPath();
    if (shape.type === 'circle') {
      ctx.arc(shape.cx, shape.cy, shape.r, 0, Math.PI * 2);
    } else {
      const pts = shape.points;
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fill();
    ctx.strokeStyle = shrinking ? '#d97706' : '#3a352a';
    ctx.lineWidth = shrinking ? 2.6 : 2;
    ctx.stroke();
    ctx.restore();
  }

  /* ---------- 场地物件：裁光的质点·细线 / 棱镜的光门 ----------
     数据来自**快照**（`snap.fields`），不是 battle.fields。
     这一点是硬要求：读实时状态的话，把进度条拖回开头也会画出整局打完后的
     所有细线 —— 看起来就像"细线在开局就凭空出现在场上"。
     弹道一直是走快照的，场地物件当初漏了。 */
  _fields(ctx, snap) {
    const fl = snap && snap.fields;
    if (!fl || !fl.length) return;
    const frame = snap.f;
    for (let i = 0; i < fl.length; i += FIELD_STRIDE) {
      const x = fl[i], y = fl[i + 1];
      const x2 = fl[i + 2], y2 = fl[i + 3];
      const kind = fl[i + 4], stage = fl[i + 5];
      const r = fl[i + 6], halfW = fl[i + 7];
      const lifeT = fl[i + 8];

      if (kind < 0.5) {
        /* 漆黑质点：一个很小的黑点 + 一圈几乎看不见的吸收边。
           尺寸必须和判定半径一致（判定就是 params 里的 moteR）。 */
        const g = ctx.createRadialGradient(x, y, 0, x, y, r * 1.8);
        g.addColorStop(0, 'rgba(0,0,0,0.95)');
        g.addColorStop(0.5, 'rgba(10,8,20,0.7)');
        g.addColorStop(1, 'rgba(10,8,20,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, r * 1.8, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#05050a';
        ctx.beginPath(); ctx.arc(x, y, r * 0.85, 0, Math.PI * 2); ctx.fill();
      } else if (kind < 1.5) {
        /* 细线就是"细"线：主宽度严格等于判定的 2×halfW，
           只在外侧加一点点辉光。三个阶段的颜色/亮度差异要一眼能分出来：
             0 漆黑：几乎纯黑，不发光
             1 深紫：深紫 + 微弱紫辉
             2 微光：亮紫 + 呼吸式闪光（警告"再碰就爆"） */
        const coreW = halfW * 2;
        const pulse = 0.5 + 0.5 * Math.sin((frame / 60) * 5);
        if (stage >= 1) {
          ctx.globalAlpha = stage >= 2 ? (0.35 + pulse * 0.45) : 0.3;
          ctx.strokeStyle = stage >= 2 ? '#e879f9' : '#7c3aed';
          ctx.lineWidth = coreW + (stage >= 2 ? 3.2 : 1.8);
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.strokeStyle = stage < 0.5 ? '#05050a' : (stage < 1.5 ? '#7c3aed' : '#f0abfc');
        ctx.lineWidth = coreW;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
      } else {
        /* 光门：一圈会转的双环 + 中间很淡的光膜；快消失时整体变淡 */
        const fade = lifeT < 0.25 ? lifeT / 0.25 : 1;
        const t = (frame / 60) * 1.1;
        ctx.globalAlpha = 0.75 * fade;
        ctx.strokeStyle = '#f0abfc';
        ctx.lineWidth = 2.6;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 0.55 * fade;
        ctx.strokeStyle = '#a5f3fc';
        ctx.lineWidth = 1.6;
        ctx.setLineDash([7, 6]);
        ctx.lineDashOffset = -t * 22;
        ctx.beginPath(); ctx.arc(x, y, r * 0.72, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(240,171,252,0.26)');
        g.addColorStop(1, 'rgba(240,171,252,0)');
        ctx.globalAlpha = fade;
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }

  /* ---------- 辉光领域：全场极光 ----------
     画在场地之上、小球之下，是一层半透明的流动极光带。 */
  /* ---------- 辉光领域（晕彩） ----------
     两段：
       ① 展开：一圈气浪从**激活时晕彩所在的位置**向外扩散，扫到哪、领域就从哪浮现
          （实现是两次 clip 求交：场地形状 ∩ 气浪圆）；
       ② 展开完成后：背景缓慢向右滚动 + 稳定在较低的不透明度。

     全部由 snap.f 推出来 —— 暂停会冻在那一帧、拖进度条会跟着倒回去。
     引擎只给三个**静态**量（何时激活、中心、美术配置），
     它们不需要每帧进快照，理由和 battle.aurora 这个布尔量一样。

     滚动用的是**镜像平铺**：把图片按"正-反-正-反"首尾相接铺开，
     横向移动时接缝两边的像素本来就相同，所以永远看不到跳变。
     直接平移一张不循环的图，到边界那一下会"啪"地跳回去。 */
  _aurora(ctx, battle, snap) {
    const cfg = battle.auroraStyle;
    if (!cfg || !cfg.src) return;
    const st = getSticker(cfg.src);
    if (!st || !st.ready || st.failed) return;

    const box = this._arenaBox();
    const w = box.maxX - box.minX, h = box.maxY - box.minY;
    if (!(w > 0 && h > 0)) return;

    const cx = battle.auroraCenter ? battle.auroraCenter.x / SCALE : box.minX + w / 2;
    const cy = battle.auroraCenter ? battle.auroraCenter.y / SCALE : box.minY + h / 2;
    const elapsed = Math.max(0, (snap.f - (battle.auroraAt ?? 0)) / 60);
    const dur = Math.max(0.05, cfg.revealSeconds ?? 1.3);
    const p = Math.min(1, elapsed / dur);

    /* 要多大半径才能铺满全场：取离中心最远的那个角 */
    const corner = Math.max(
      Math.hypot(cx - box.minX, cy - box.minY),
      Math.hypot(cx - box.maxX, cy - box.minY),
      Math.hypot(cx - box.minX, cy - box.maxY),
      Math.hypot(cx - box.maxX, cy - box.maxY));
    const ease = 1 - Math.pow(1 - p, 3);          // easeOutCubic：气浪先快后慢地铺开
    const waveR = corner * ease + 2;

    ctx.save();
    this._arenaClip(ctx);
    /* ① 领域层：只在气浪扫过的圆里可见 */
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, waveR, 0, Math.PI * 2);
    ctx.clip();

    const img = st.img;
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    /* 按**高度**等比缩放：竖直方向刚好铺满，横向必然溢出（图是 7:3），
       溢出的那部分正好拿来滚动。绝不拉伸。 */
    const drawH = h;
    const drawW = drawH * (iw / ih);

    const fadeIn = cfg.fadeInPortion ?? 0.25;
    const alpha = (cfg.opacity ?? 0.4) * Math.min(1, fadeIn > 0 ? p / fadeIn : 1);
    ctx.globalAlpha = alpha;

    /* ② 展开完成后开始滚动。用 elapsed 而不是 p —— p 到 1 就不动了。 */
    const period = drawW * 2;                      // 镜像平铺的周期
    const speed = cfg.scrollUnitsPerSec ?? 0;
    let off = 0;
    if (p >= 1 && speed > 0) {
      off = ((elapsed - dur) * speed) % period;
      if (off < 0) off += period;
    }
    const first = Math.floor((box.minX - off) / drawW);
    const last = Math.floor((box.maxX - off) / drawW);
    for (let k = first; k <= last; k++) {
      const x = k * drawW + off;
      /* 奇数格水平翻转 —— 这样每一道接缝两边的像素都是同一条边，天然无缝 */
      const mirrored = (((k % 2) + 2) % 2) === 1;
      if (mirrored) {
        ctx.save();
        ctx.translate(x + drawW, box.minY);
        ctx.scale(-1, 1);
        ctx.drawImage(img, 0, 0, drawW, drawH);
        ctx.restore();
      } else {
        ctx.drawImage(img, x, box.minY, drawW, drawH);
      }
    }
    ctx.restore();   // 解除"气浪圆"裁剪

    /* ③ 气浪环本身：画在领域层之上，随展开变淡，铺满即消失。
       放在圆裁剪**外面**，否则环会被自己的圆裁掉一半。 */
    if (p < 1) {
      const fade = Math.min(1, p / 0.05);          // 起步极快淡入，免得第一帧是个点
      const ringA = (cfg.ringAlpha ?? 0.85) * fade * Math.pow(1 - p, 0.8);
      if (ringA > 0.01) {
        ctx.globalAlpha = ringA;
        ctx.strokeStyle = cfg.glow || '#7dd3fc';
        ctx.lineWidth = cfg.ringWidth ?? 30;
        ctx.beginPath();
        ctx.arc(cx, cy, waveR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = ringA * (cfg.ringCoreAlpha ?? 0.95);
        ctx.strokeStyle = cfg.core || '#ffffff';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /** 把裁剪区域设成"场地形状"。
   *  领域层必须裁到场地里 —— 只按外接矩形裁的话，圆形/多边形场地外面
   *  也会糊上一层极光，看起来像画到画布外面去了。 */
  _arenaClip(ctx, shape) {
    const s = shape || this.arenaShape;
    ctx.beginPath();
    if (!s) { ctx.rect(0, 0, WORLD_W, WORLD_H); }
    else if (s.type === 'circle') { ctx.arc(s.cx, s.cy, s.r, 0, Math.PI * 2); }
    else {
      const pts = s.points;
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
    }
    ctx.clip();
  }

  /* ---------- 事件特效 ---------- */
  _events(ctx, battle, frame) {
    const LIFE = 22;
    for (const e of battle.events) {
      const age = frame - e.f;
      if (age < 0 || age > LIFE) continue;
      const t = age / LIFE;
      const alpha = 1 - t;
      ctx.save();
      ctx.globalAlpha = alpha;

      if (e.type === 'hit') {
        // 命中：扩散圆环 + 伤害飘字
        const r = 7 + t * 20;
        ctx.strokeStyle = e.color;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.arc(e.bx, e.by, r, 0, Math.PI * 2);
        ctx.stroke();
        if (this.showDamage) {
          ctx.globalAlpha = alpha * 0.95;
          ctx.fillStyle = '#1f1c15';
          ctx.font = `bold 12px ${FONT}`;
          ctx.textAlign = 'center';
          ctx.fillText(`-${Math.round(e.value)}`, e.bx, e.by - 14 - t * 20);
          ctx.textAlign = 'left';
        }
      } else if (e.type === 'death') {
        ctx.globalAlpha = alpha * 0.8;
        ctx.strokeStyle = e.color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(e.ax, e.ay, 10 + t * 26, 0, Math.PI * 2);
        ctx.stroke();
      } else if (e.type === 'respawn') {
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = '#159c6b';
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.arc(e.ax, e.ay, 6 + (1 - t) * 22, 0, Math.PI * 2);
        ctx.stroke();
      } else if (e.type === 'shoot') {
        /* 发射：枪口闪光。画在弹道出生点上，
           让"技能什么时候放出来"这件事一眼可见。 */
        const c = e.color || '#7dd3fc';
        ctx.globalAlpha = alpha * 0.9;
        ctx.strokeStyle = c;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(e.px, e.py, 3 + t * 9, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = alpha * 0.5;
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(e.px, e.py, 3 * (1 - t), 0, Math.PI * 2);
        ctx.fill();
      } else if (e.type === 'projHit') {
        // 弹道命中：短促爆点 + 十字星芒
        const c = e.color || '#7dd3fc';
        ctx.globalAlpha = alpha * 0.95;
        ctx.strokeStyle = c;
        ctx.lineWidth = 2.2;
        const rr = 3 + t * 13;
        ctx.beginPath();
        ctx.arc(e.px, e.py, rr, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        for (const a of [0, Math.PI / 2, Math.PI, (Math.PI * 3) / 2]) {
          ctx.moveTo(e.px + Math.cos(a) * rr * 0.5, e.py + Math.sin(a) * rr * 0.5);
          ctx.lineTo(e.px + Math.cos(a) * rr * 1.5, e.py + Math.sin(a) * rr * 1.5);
        }
        ctx.stroke();
      } else if (e.type === 'projWall') {
        // 弹道撞墙：贴着墙面的小水花
        ctx.globalAlpha = alpha * 0.7;
        ctx.strokeStyle = e.color || '#7dd3fc';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(e.px, e.py, 2 + t * 7, 0, Math.PI * 2);
        ctx.stroke();
      } else if (e.type === 'dashStart') {
        /* 冲刺起手：从球心向外炸开的一圈，
           配合球体上的冲刺光环说明"它现在在冲"。 */
        const c = (e.a >= 0 && battle.units[e.a]) ? teamColor(battle.units[e.a].team).main : '#888';
        ctx.globalAlpha = alpha * 0.9;
        ctx.strokeStyle = c;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(e.ax, e.ay, 12 + t * 30, 0, Math.PI * 2);
        ctx.stroke();
      } else if (e.type === 'knock') {
        // 冲刺命中把人推开：沿推开方向画几道冲击线
        const dx = e.bx - e.ax, dy = e.by - e.ay;
        const d = Math.hypot(dx, dy) || 1;
        const nx = dx / d, ny = dy / d;
        const c = e.color || '#888';
        ctx.globalAlpha = alpha * 0.85;
        ctx.strokeStyle = c;
        ctx.lineWidth = 2.4;
        for (const off of [-0.5, 0, 0.5]) {
          const px = -ny * off * 9, py = nx * off * 9;
          ctx.beginPath();
          ctx.moveTo(e.bx + px - nx * (4 + t * 6), e.by + py - ny * (4 + t * 6));
          ctx.lineTo(e.bx + px + nx * (10 + t * 16), e.by + py + ny * (10 + t * 16));
          ctx.stroke();
        }
      } else if (e.type === 'moteDrop') {
        // 质点落下：一圈迅速收缩的黑环
        ctx.globalAlpha = alpha * 0.8;
        ctx.strokeStyle = '#0a0a14';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(e.px, e.py, 16 - t * 11, 0, Math.PI * 2); ctx.stroke();
      } else if (e.type === 'lineForm') {
        // 两点连成细线：从两端向中间"拉"出来的白闪
        ctx.globalAlpha = alpha * 0.9;
        ctx.strokeStyle = '#e9d5ff';
        ctx.lineWidth = 1.4;
        const mx = (e.px + e.x2) / 2, my = (e.py + e.y2) / 2;
        const k = 1 - t;
        ctx.beginPath();
        ctx.moveTo(e.px + (mx - e.px) * (1 - k), e.py + (my - e.py) * (1 - k));
        ctx.lineTo(e.x2 + (mx - e.x2) * (1 - k), e.y2 + (my - e.y2) * (1 - k));
        ctx.stroke();
      } else if (e.type === 'lineStage' || e.type === 'lineAbsorb') {
        /* 细线进阶 / 吸收"光"：沿线扫过一道亮光，颜色按新阶段走 */
        const col = e.value >= 2 ? '#f0abfc' : '#7c3aed';
        ctx.globalAlpha = alpha * 0.95;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.6 + (1 - t) * 1.2;
        ctx.beginPath(); ctx.moveTo(e.px, e.py); ctx.lineTo(e.x2 || e.px, e.y2 || e.py); ctx.stroke();
        ctx.globalAlpha = alpha * 0.7;
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(e.px, e.py, 3 + t * 8, 0, Math.PI * 2); ctx.stroke();
      } else if (e.type === 'lineBoom') {
        /* 细线爆炸：沿线爆开一串亮斑 + 一圈扩散的紫色冲击环 */
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = '#d8b4fe';
        ctx.lineWidth = 1.8;
        ctx.beginPath(); ctx.moveTo(e.px, e.py); ctx.lineTo(e.x2 || e.px, e.y2 || e.py); ctx.stroke();
        ctx.globalAlpha = alpha * 0.8;
        ctx.strokeStyle = '#f5d0fe';
        ctx.lineWidth = 2.4;
        for (let i = 0; i <= 5; i++) {
          const k = i / 5;
          const bx = e.px + ((e.x2 || e.px) - e.px) * k;
          const by = e.py + ((e.y2 || e.py) - e.py) * k;
          ctx.beginPath(); ctx.arc(bx, by, 5 + t * 20, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(e.bx, e.by, 8 + t * 34, 0, Math.PI * 2); ctx.stroke();
      } else if (e.type === 'gateSpawn') {
        // 光门出现：两圈反向旋转的环迅速张开
        ctx.globalAlpha = alpha * 0.9;
        ctx.strokeStyle = '#f0abfc';
        ctx.lineWidth = 2.4;
        ctx.beginPath(); ctx.arc(e.px, e.py, 6 + t * 22, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = '#a5f3fc';
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(e.px, e.py, 14 + t * 30, 0, Math.PI * 2); ctx.stroke();
      } else if (e.type === 'gateSplit') {
        // 分裂：从中心炸开五条放射线，说明"一分为五"
        ctx.globalAlpha = alpha * 0.9;
        ctx.strokeStyle = '#f5d0fe';
        ctx.lineWidth = 2;
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2 + t * 1.6;
          ctx.beginPath();
          ctx.moveTo(e.px + Math.cos(a) * 4, e.py + Math.sin(a) * 4);
          ctx.lineTo(e.px + Math.cos(a) * (10 + t * 26), e.py + Math.sin(a) * (10 + t * 26));
          ctx.stroke();
        }
      } else if (e.type === 'bloom') {
        /* 开华：三层彩色光环向外炸开（和极光同色系），强调"形态变了" */
        const cols = ['#a78bfa', '#7dd3fc', '#f0abfc'];
        for (let i = 0; i < 3; i++) {
          ctx.globalAlpha = alpha * (0.85 - i * 0.2);
          ctx.strokeStyle = cols[i];
          ctx.lineWidth = 4 - i;
          ctx.beginPath();
          ctx.arc(e.ax, e.ay, 12 + i * 9 + t * 48, 0, Math.PI * 2);
          ctx.stroke();
        }
      } else if (e.type === 'stealth') {
        // 隐身：一圈虚线向里收，表示"身影淡下去了"
        ctx.globalAlpha = alpha * 0.8;
        ctx.strokeStyle = '#e9d5ff';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.lineDashOffset = -t * 20;
        ctx.beginPath(); ctx.arc(e.ax, e.ay, 30 - t * 14, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
      } else if (e.type === 'dodge') {
        // 闪避：一道斜向掠过的白光，表示"打空了"
        ctx.globalAlpha = alpha * 0.9;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.2;
        const off = 26 - t * 26;
        ctx.beginPath();
        ctx.moveTo(e.bx - 16 + off * 0.4, e.by + 14);
        ctx.lineTo(e.bx + 14 + off * 0.4, e.by - 14);
        ctx.stroke();
      } else if (e.type === 'crescent') {
        /* 开华的月牙斩击：在受击者身上划出一道细月牙，带"光"所以是亮紫白 */
        const ang = Math.atan2(e.by - e.ay, e.bx - e.ax);
        const rr = 15 + t * 9;
        ctx.globalAlpha = alpha * 0.95;
        ctx.strokeStyle = '#f5d0fe';
        ctx.lineWidth = 2.6 - t;
        ctx.beginPath();
        ctx.arc(e.bx, e.by, rr, ang - 1.15, ang + 1.15);
        ctx.stroke();
        ctx.globalAlpha = alpha * 0.5;
        ctx.strokeStyle = '#a78bfa';
        ctx.lineWidth = 5 - t * 3;
        ctx.beginPath();
        ctx.arc(e.bx, e.by, rr + 3, ang - 0.9, ang + 0.9);
        ctx.stroke();
      } else if (e.type === 'xiguangSplit') {
        // 析光分身：本体身上泛起一圈淡紫，说明"分出去了一部分"
        ctx.globalAlpha = alpha * 0.85;
        ctx.strokeStyle = '#c4b5fd';
        ctx.lineWidth = 2.6;
        ctx.beginPath(); ctx.arc(e.ax, e.ay, 10 + t * 30, 0, Math.PI * 2); ctx.stroke();
      } else if (e.type === 'hpCost') {
        // 血量代价：本体上方飘一个小小的 -N（用冷色，和伤害的红黑区分开）
        if (this.showDamage) {
          ctx.globalAlpha = alpha * 0.9;
          ctx.fillStyle = '#7c3aed';
          ctx.font = `bold 11px ${FONT}`;
          ctx.textAlign = 'center';
          ctx.fillText(`-${Math.round(e.value)}`, e.ax, e.ay - 18 - t * 16);
          ctx.textAlign = 'left';
        }
      } else if (e.type === 'heal') {
        /* 回血：绿色的小十字往上飘。和伤害的深色数字明确区分开，
           否则会误读成"又挨打了"。 */
        ctx.globalAlpha = alpha * 0.9;
        ctx.strokeStyle = '#159c6b';
        ctx.lineWidth = 2;
        const hy = e.by - 12 - t * 16;
        ctx.beginPath();
        ctx.moveTo(e.bx - 4, hy); ctx.lineTo(e.bx + 4, hy);
        ctx.moveTo(e.bx, hy - 4); ctx.lineTo(e.bx, hy + 4);
        ctx.stroke();
      } else if (e.type === 'spinUp') {
        /* 陀螺叠层：绕球转一圈短弧，层数越高弧越亮（转得也更疯） */
        const k = Math.min(1, (e.value || 1) / 10);
        ctx.globalAlpha = alpha * (0.4 + k * 0.5);
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 1.6 + k * 1.4;
        for (let i = 0; i < 3; i++) {
          const a0 = (frame / 60) * 6 + i * 2.1;
          ctx.beginPath();
          ctx.arc(e.ax, e.ay, 22, a0, a0 + 1.1);
          ctx.stroke();
        }
      } else if (e.type === 'projBounce') {
        // 弹射：撞墙点的小火花
        ctx.globalAlpha = alpha * 0.8;
        ctx.strokeStyle = e.color || '#f5d0fe';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(e.px, e.py, 2 + t * 8, 0, Math.PI * 2); ctx.stroke();
      } else if (e.type === 'aimStack' || e.type === 'aimMiss') {
        /* 认真拉矢：命中叠层画向上的金色小箭头，落空掉层画向下的灰箭头 */
        const up = e.type === 'aimStack';
        ctx.globalAlpha = alpha * 0.9;
        ctx.strokeStyle = up ? '#d97706' : '#9ca3af';
        ctx.lineWidth = 2;
        const dy0 = e.ay - 20 - t * 14;
        ctx.beginPath();
        ctx.moveTo(e.ax - 4, dy0 + (up ? 4 : -4));
        ctx.lineTo(e.ax, dy0 + (up ? -2 : 2));
        ctx.lineTo(e.ax + 4, dy0 + (up ? 4 : -4));
        ctx.stroke();
      } else if (e.type === 'arrowBurst') {
        // 五连发：从球心炸开五道扇形短线
        ctx.globalAlpha = alpha * 0.9;
        ctx.strokeStyle = '#f9a8d4';
        ctx.lineWidth = 2;
        for (let i = 0; i < 5; i++) {
          const a = -Math.PI / 2 + (i - 2) * 0.26;
          ctx.beginPath();
          ctx.moveTo(e.ax + Math.cos(a) * 8, e.ay + Math.sin(a) * 8);
          ctx.lineTo(e.ax + Math.cos(a) * (20 + t * 22), e.ay + Math.sin(a) * (20 + t * 22));
          ctx.stroke();
        }
      } else if (e.type === 'buffOn' || e.type === 'buffOff') {
        /* 春景 buff 的开/关：开是向外扩散的粉环，关是向内收的暗环 */
        const on = e.type === 'buffOn';
        ctx.globalAlpha = alpha * (on ? 0.85 : 0.6);
        ctx.strokeStyle = on ? '#fbcfe8' : '#9ca3af';
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.arc(e.ax, e.ay, on ? 12 + t * 30 : 30 - t * 16, 0, Math.PI * 2);
        ctx.stroke();
      } else if (e.type === 'slow') {
        // 被减速：一圈向里收的灰环
        ctx.globalAlpha = alpha * 0.75;
        ctx.strokeStyle = '#6b7280';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(e.ax, e.ay, 26 - t * 12, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }


/* ---------- 弹道 ----------
     数据来自快照（不是事件），所以暂停时会停在原地、回放会跟着倒回去。 */
  _projectiles(ctx, battle, snap) {
    const pj = snap && snap.proj;
    if (!pj || !pj.length) return;
    const pal = battle.projPalette || [];
    for (let i = 0; i < pj.length; i += PROJ_STRIDE) {
      const x = pj[i], y = pj[i + 1], r = pj[i + 2];
      const lifeT = pj[i + 3];                 // 1 → 0
      const color = pal[pj[i + 4]] || '#7dd3fc';
      const ptype = pj[i + 5];                 // 0 特效 / 1 实体 / 2 光束 / 3 锚定光柱
      const isBeam = ptype > 1.5;
      /* 锚定光柱（公主传承3）：从锚点**向前**画，长度由弹道自己带着。
         普通激光是"头部 + 身后拖影"，方向正好相反。 */
      const beamFwd = ptype > 2.5;
      const beamLen = pj[i + 10] || 0;
      const isBody = !isBeam && ptype > 0.5;
      const w = pj[i + 6] || r * 2;
      const dirX = pj[i + 7], dirY = pj[i + 8];
      const sprIdx = pj[i + 9];
      const spr = (sprIdx >= 0 && battle.projSpritePalette)
        ? battle.projSpritePalette[sprIdx] : null;

      ctx.save();
      /* 接近寿命尽头时淡出，避免"啪"地凭空消失。
         实体弹比特效弹更实（不透明度更高、有描边）。 */
      const fade = lifeT < 0.25 ? lifeT / 0.25 : 1;
      const core = fade * (isBody ? 1 : 0.75);

      /* 贴图弹道（箭矢）：有图就直接按飞行方向转着画，
         不再画程序化的光点。这样"搭在弓上的箭"和"飞出去的箭"
         是同一张图，撒放那一瞬间接得上。 */
      if (spr && spr.src) {
        const st = getSticker(spr.src);
        if (st && st.ready && !st.failed) {
          const iw = st.img.naturalWidth || st.img.width;
          const ih = st.img.naturalHeight || st.img.height;
          const len = spr.len > 0 ? spr.len : r * 6;
          const hgt = len * (ih / iw);
          ctx.globalAlpha = fade;
          ctx.translate(x, y);
          ctx.rotate(Math.atan2(dirY, dirX));
          /* 箭图的中心对准弹道中心（碰撞按圆算，所以图要居中才不偏） */
          ctx.drawImage(st.img, -len / 2, -hgt / 2, len, hgt);
          ctx.restore();
          continue;
        }
      }

      /* 光束（激光）：画成一根**圆柱体光柱**，而不是渐隐的拖尾。
         圆柱体的特征是"等宽、两端有明确边界"：
         外面一层柔光外壳，中间实心光柱，中心一条更亮的核心线，
         前端补一个半圆头 —— 这样它看起来是一截"打出去的光"，
         和其他圆点状弹道一眼就能分开。 */
      if (isBeam && (dirX || dirY)) {
        /* 长度优先用弹道自带的 beamLen —— 判定用的也是同一个数，
           所以"画多长"就等于"打多长"。没有才退回按宽度估的旧行为。 */
        const L = beamLen > 0 ? beamLen : Math.max(40, w * 3);
        /* 向前画的光柱从锚点出发往 +X 铺；普通激光从头部往 -X 铺拖影 */
        const x0 = beamFwd ? 0 : -L;
        const x1 = beamFwd ? L : 0;
        /* 光柱本体的不透明度 = fade（寿命末端的淡出）× BEAM_ALPHA。
           其余两层按比例跟着它走，所以调 BEAM_ALPHA 一处就够。 */
        const beamA = fade * BEAM_ALPHA;
        ctx.save();
        /* 先按场地裁剪（此时还在世界坐标系里），再进局部变换 ——
           否则 clip 会拿到"旋转过的场地路径"，裁出来的形状是错的。 */
        this._arenaClip(ctx, this._frameShape);
        ctx.translate(x, y);
        ctx.rotate(Math.atan2(dirY, dirX));
        // 外层柔光（圆柱外壳）
        ctx.globalAlpha = beamA * BEAM_GLOW;
        ctx.fillStyle = color;
        ctx.fillRect(x0, -w / 2 - 2.5, x1 - x0, w + 5);
        // 柱体
        ctx.globalAlpha = beamA;
        ctx.fillRect(x0, -w / 2, x1 - x0, w);
        // 圆头一律补在**远离锚点的那一端**（普通激光是头部、光柱是末端）
        ctx.beginPath();
        ctx.arc(beamFwd ? x1 : 0, 0, w / 2, -Math.PI / 2, Math.PI / 2);
        ctx.fill();
        // 中心高亮核心线
        ctx.globalAlpha = beamA * BEAM_CORE;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x0, -w * 0.16, x1 - x0, w * 0.32);
        ctx.restore();
        ctx.globalAlpha = core;
      } else {
        // 圆点状弹道：外发光 + 弹体 + 高光点

        // 外发光
        const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2.6);
        g.addColorStop(0, hexA(color, 0.55 * core));
        g.addColorStop(1, hexA(color, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r * 2.6, 0, Math.PI * 2);
        ctx.fill();

        // 弹体
        ctx.globalAlpha = core;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        if (isBody) {
          ctx.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
        // 高光点：让弹道看起来是个"实体"而不是一块色斑
        ctx.globalAlpha = core * 0.9;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath();
        ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.34, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  /* ---------- 小球本体 ---------- */
  /* ------------------------------------------------------------
     手持物件：弓（动作动画的载体）

     为什么必须和球体分开画 —— 三个约束在这里同时解开：
       1. 球体贴图走的是 ctx.clip() 圆形裁剪，
          弓画在球外面会被整条裁掉，所以这里**不 clip**；
       2. 球装陀螺时 `spin` 会让 ctx.rotate 整个贴图，
          弓如果画在同一个变换里就会跟着翻滚、没法瞄准。
          这里**不套那个 rotate**，弓天然只按 aimAngle 转 → 冲突自动消失；
       3. 弓的朝向来自快照的 aimAngle（朝最近敌人），
          而球体贴图的旋转来自 spinAngle（陀螺层数），两者本来就是两回事。

     绘制顺序：本函数在**画球之前**调用，于是球会盖住弓的握把内侧，
     看起来像"球握着弓"，而不是"弓贴在球上"。
     ------------------------------------------------------------ */
  _bow(ctx, u, x, y, r, castP, aimAngle, castKind) {
    const bow = u.bow;
    if (!bow) return;
    const src = bowStateSrc(bow, castP);
    if (!src) return;
    const st = getSticker(src);
    if (!st || !st.ready || st.failed) return;   // 没加载好就干脆不画，别画个方块

    const iw = st.img.naturalWidth || st.img.width;
    const ih = st.img.naturalHeight || st.img.height;
    /* 单位注意：_units 里的 x / y / r 全是**世界单位**（快照已经除过 SCALE），
       画布的整体缩放由外层 transform 负责，所以这里不能乘 SCALE。 */
    const drawH = bow.bowH;
    const drawW = drawH * (iw / ih);             // 宽度按原图比例，绝不拉伸
    const axF = bow.anchor.x, ayF = bow.anchor.y;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(((aimAngle ?? 0) * Math.PI) / 180);   // 0° = 朝 +X
    /* 把图片的**锚点**摆到球心：锚点在这块画布上的位置就是球心的位置。
       两张弓帧（平时 / 拉弓）已由 make-bow-sprites.mjs 对齐到同一块画布，
       所以这里换图不会让弓横跳 —— 原始两张图的画布宽度差 40px。 */
    ctx.drawImage(st.img, -axF * drawW, -ayF * drawH, drawW, drawH);

    /* 五连发：在同一个搭箭节点上，扇形额外排布 4 根箭矢。
       这些箭是**武器的一部分**（不是已经射出去的弹道），
       所以写在弓的局部坐标系里 —— 跟着弓一起转，也就不受陀螺自转影响。
       画在弓图之上、球之下：球仍然盖住握把内侧。 */
    if (castKind === 1 && castP > 0 && castP < 0.999 && bow.burst && bow.arrow) {
      const at = getSticker(bow.arrow);
      if (at && at.ready && !at.failed) {
        const aw = at.img.naturalWidth || at.img.width;
        const ah = at.img.naturalHeight || at.img.height;
        const aLen = (bow.arrowLenFrac ?? 0.335) * drawH;
        const aH = aLen * (ah / aw);
        /* 搭箭节点在画布上的位置 → 相对球心的局部坐标 */
        const nlx = (bow.nock.x - axF) * drawW;
        const nly = (bow.nock.y - ayF) * drawH;
        const n = bow.burst.count;
        const spread = (bow.burst.spreadDeg * Math.PI) / 180;
        for (let k = 0; k < n; k++) {
          /* 与 skills.js 里五连发**同一个公式**：
             把 k 在 (0..n-1) 上映射到 [-1,1]，再乘张角的一半。
             这样画出来的扇形与箭真正飞出去的方向逐根对齐。 */
          const off = (n === 1) ? 0 : ((k / (n - 1)) * 2 - 1) * spread;
          /* 正中那一根（off = 0）已经画在 draw 图里了，这里跳过，
             否则会和图上那支箭叠成两支。 */
          if (Math.abs(off) < 1e-9) continue;
          ctx.save();
          ctx.translate(nlx, nly);
          ctx.rotate(off);
          /* 箭图的左边缘中点 = 箭尾，所以画在 (0, -aH/2) ——
             五根箭共用同一个箭尾，扇形从这里散开。 */
          ctx.drawImage(at.img, 0, -aH / 2, aLen, aH);
          ctx.restore();
        }
      }
    }
    ctx.restore();
  }

  _units(ctx, battle, snap, opts) {
    const d = snap.data;
    /* 用快照实际长度反推单位数，而不是 battle.units.length：
       析光召唤出来的分身是在战斗中才出现的，
       它出现之前的那些帧快照里根本没有它。 */
    const n = Math.floor(d.length / SNAP_STRIDE);
    for (let i = 0; i < n; i++) {
      const o = i * SNAP_STRIDE;
      /* 注意这里是 !(>0.5) 而不是 <0.5：
         求之前的帧里 d[o+3] 是 undefined，两种写法结果不同。 */
      if (!(d[o + 3] > 0.5)) continue;          // 已阵亡 / 这一帧还不存在
      const u = battle.units[i];
      const x = d[o], y = d[o + 1];
      const hp = d[o + 2], flash = d[o + 4], res = d[o + 5];
      const mode = d[o + 7], chargeP = d[o + 8], dashP = d[o + 9];
      const stealth = d[o + 10] > 0.5;
      const bloomed = d[o + 11] > 0.5;
      const spin = d[o + 12] || 0;      // 旋转角（陀螺叠层驱动），暂停回放时会冻住
      const castP = d[o + 13] || 0;     // 施法进度 0~1（拉弓动作的时间基准）
      const aimAngle = d[o + 14] || 0;  // 瞄准角（角度制，朝最近的敌人）
      const castKind = d[o + 15] || 0;  // 施法变体：0 普通 / 1 五连发
      const r = u.r / SCALE;
      const tc = teamColor(u.team);

      ctx.save();

      /* 时间停止（公主传承1）：除豁免者外全场褪色。
         放在这个 save 之后 —— 血条、队伍环、贴图会一起褪，
         否则会出现"球灰了但血条还是彩色的"这种半吊子效果。 */
      const tsOwner = snap.ts ?? -1;
      if (tsOwner >= 0 && i !== tsOwner) {
        ctx.filter = 'grayscale(1) brightness(0.55)';
      }

      /* 手持物件（弓）：先画，让球盖住握把内侧。
         放在所有球体装饰之前 —— 弓是"身体的一部分"，
         不该压在血条、闪光、隐身轮廓上面。 */
      this._bow(ctx, u, x, y, r, castP, aimAngle, castKind);

      /* 开华的极光形态：脚下一圈缓慢旋转的光晕，说明"这个球已经强化过了" */
      if (bloomed) {
        const t = (snap.f / 60) * 0.7;
        for (let k = 0; k < 3; k++) {
          ctx.globalAlpha = 0.18 - k * 0.045;
          ctx.strokeStyle = ['#a78bfa', '#7dd3fc', '#f0abfc'][k];
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(x, y, r + 5 + k * 3.5, t + k * 2.1, t + k * 2.1 + Math.PI * 1.25);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      /* 隐身（折光）：整颗球半透明，并加一圈虚线轮廓，避免"球消失了"的错觉 */
      if (stealth) {
        ctx.globalAlpha = 0.30;
      }

      /* -------- 蓄力 / 冲刺的地面光环 --------
         先画光环再画球，光环就自然被球压在下面，不会糊住贴图。 */
      if (mode > 1.5) {
        // 冲刺：外扩的青色光晕，随冲刺推进变淡（表示"冲劲在衰减"）
        const k = 1 - dashP * 0.55;
        ctx.globalAlpha = 0.75 * k;
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 3 * k;
        ctx.beginPath();
        ctx.arc(x, y, r + 4 + dashP * 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 0.22 * k;
        ctx.fillStyle = '#38bdf8';
        ctx.beginPath();
        ctx.arc(x, y, r + 4 + dashP * 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (mode > 0.5) {
        /* 蓄力：脚下画进度环（从 12 点方向顺时针填满），
           同时球体轻微脉动，说明"在攒劲、还不能动"。 */
        const a0 = -Math.PI / 2;
        ctx.globalAlpha = 0.28;
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, r + 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#0ea5e9';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(x, y, r + 6, a0, a0 + Math.PI * 2 * Math.max(0, Math.min(1, chargeP)));
        ctx.stroke();
        ctx.lineCap = 'butt';
      }

      // 玩家操控标识：底部光环
      if (u.isPlayer) {
        ctx.globalAlpha = 0.55 + Math.sin(performance.now() / 220) * 0.25;
        ctx.strokeStyle = '#111';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, r + 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      /* 蓄力时球体自身也收一下再胀一下（周期用蓄力进度驱动，
         不依赖墙钟时间，所以暂停/回放时脉动是"冻结"的）。 */
      const pulse = mode > 0.5 && mode < 1.5 ? 1 + Math.sin(chargeP * Math.PI * 6) * 0.05 : 1;
      const rr = r * pulse;

      /* 运动拖尾已移除：
         原先用固定透明度的粗线表示速度，形状接近实心矩形，
         容易被误认成界面上的半透明方块。小球本身已经能看出运动方向。 */

      /* 球体：优先用角色贴图（头部圆形贴图，已带 alpha），
         没有贴图或尚未加载完成时回退成纯色圆。
         开华后换用第二张贴图 —— 用快照里的 bloomed 标记判断，
         而不是读单位的实时状态，这样暂停/回放才对得上。 */
      const sp = (bloomed && u.stickerBloom) ? u.stickerBloom : u.sticker;
      const st = sp ? getSticker(sp.src) : null;
      const useSticker = !!(st && st.ready && !st.failed);
      if (useSticker) {
        ctx.save();
        /* 陀螺：贴图绕球心自转。
           只转球体本身，血条与队伍色环不转 —— 否则数字会跟着翻滚，读不了。
           旋转走 ctx.rotate 而不是"每帧重算裁剪"，因为贴图是圆形的，
           转起来边缘不会有锯齿或缺口。 */
        if (spin) {
          ctx.translate(x, y);
          ctx.rotate(spin);
          ctx.translate(-x, -y);
        }
        // 圆形裁剪：保证边缘干净（贴图自带遮罩，这里再兜一层保险）
        ctx.beginPath();
        ctx.arc(x, y, rr, 0, Math.PI * 2);
        ctx.clip();
        const iw = st.img.naturalWidth || st.img.width;
        const ih = st.img.naturalHeight || st.img.height;
        const srcW = iw * (sp.r * 2), srcH = ih * (sp.r * 2);
        const srcX = iw * sp.cx - srcW / 2, srcY = ih * sp.cy - srcH / 2;
        ctx.drawImage(st.img, srcX, srcY, srcW, srcH, x - rr, y - rr, rr * 2, rr * 2);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, rr, 0, Math.PI * 2);
        ctx.fillStyle = u.color;
        ctx.fill();
      }
      /* 队伍色描边。/ 必须在这里重新 beginPath：
         贴图分支里的裁剪路径已被 restore 丢弃，
         直接 stroke 会去描"上一个路径"（拖尾或别的球）。 */
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      // 受击闪光
      if (flash > 0) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 3;
      } else {
        ctx.strokeStyle = tc.main;
        ctx.lineWidth = 2.2;
      }
      ctx.stroke();

      // 队伍色细环
      ctx.globalAlpha = stealth ? 0.2 : 0.45;
      ctx.beginPath();
      ctx.arc(x, y, r + 2.6, 0, Math.PI * 2);
      ctx.strokeStyle = tc.main;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.globalAlpha = 1;

      /* 隐身时画一圈虚线：半透明的球很容易被当成"已经不在了"，
         虚线轮廓能说明"它还在，只是隐身中"。 */
      if (stealth) {
        const tt = (snap.f / 60) * 1.6;
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = '#e9d5ff';
        ctx.lineWidth = 1.6;
        ctx.setLineDash([4, 4]);
        ctx.lineDashOffset = -tt * 8;
        ctx.beginPath();
        ctx.arc(x, y, r + 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
        ctx.globalAlpha = 1;
      }

      if (this.showHud) {
        /* -------- 血条：小球上方（带详细血量数字） --------
           数字画在血条**上方**而不是压在条里：条只有 4 个单位高，
           数字压上去会把满血的绿色底色糊掉，混战时基本读不出来。
           白描边 + 深色字，保证在浅色场地和深色场地都能看清。 */
        const bw = Math.max(26, r * 2.3), bh = 4.2;
        const by = y - r - 10;
        const p = Math.max(0, Math.min(1, hp / u.maxHp));
        ctx.fillStyle = 'rgba(0,0,0,0.20)';
        ctx.fillRect(x - bw / 2, by, bw, bh);
        ctx.fillStyle = p > 0.5 ? '#159c6b' : (p > 0.25 ? '#d97706' : '#e8452c');
        ctx.fillRect(x - bw / 2, by, bw * p, bh);
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 0.6;
        ctx.strokeRect(x - bw / 2, by, bw, bh);

        /* 详细血量：优先显示"当前/上限"，条太窄放不下时退化成只显示当前值 */
        const cur = Math.max(0, Math.round(hp));
        const maxv = Math.round(u.maxHp);
        const fullTxt = `${cur}/${maxv}`;
        const smallTxt = `${cur}`;
        ctx.font = `bold 9px ${FONT}`;
        const txt = ctx.measureText(fullTxt).width <= bw + 16 ? fullTxt : smallTxt;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 2.6;
        ctx.strokeStyle = 'rgba(255,255,255,0.92)';
        ctx.strokeText(txt, x, by - 1.6);
        ctx.fillStyle = '#1f1c15';
        ctx.fillText(txt, x, by - 1.6);
        ctx.textAlign = 'left';

        /* -------- 特殊资源：小球下方（仅当该球有资源时显示）-------- */
        if (u.resMax > 0) {
          const ry = y + r + 5;
          const rp = Math.max(0, Math.min(1, res / u.resMax));
          ctx.fillStyle = 'rgba(0,0,0,0.20)';
          ctx.fillRect(x - bw / 2, ry, bw, bh);
          ctx.fillStyle = (u.resDef && u.resDef.color) || '#4f7cff';
          ctx.fillRect(x - bw / 2, ry, bw * rp, bh);
          ctx.strokeStyle = 'rgba(0,0,0,0.35)';
          ctx.lineWidth = 0.6;
          ctx.strokeRect(x - bw / 2, ry, bw, bh);
          if (rp >= 1) {   // 资源满时高亮，为将来的技能释放做视觉铺垫
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.6;
            ctx.strokeRect(x - bw / 2 - 0.8, ry - 0.8, bw + 1.6, bh + 1.6);
          }
        }
      }

      ctx.restore();
    }
  }

  /* ---------- 小尺寸预览（图鉴 / 准备界面用） ---------- */
  drawPortrait(canvas, species) {
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || 86;
    const h = canvas.clientHeight || 86;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2, cy = h / 2;
    const rad = Math.min(w, h) * 0.30;

    if (species.image) {
      // 已接入原创立绘时走图片渲染
      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(img, cx - rad, cy - rad, rad * 2, rad * 2);
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.strokeStyle = '#3a352a';
        ctx.lineWidth = 2;
        ctx.stroke();
      };
      img.src = species.image;
      return;
    }

    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fillStyle = species.color;
    ctx.fill();
    ctx.strokeStyle = '#3a352a';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

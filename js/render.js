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
/* 伤害 → 力度权重：飘字的大小和打击音的轻重**共用同一套刻度**（见 DMG_* 注释） */
import { hitWeight } from './audio.js';

const FONT = '"Segoe UI","Microsoft YaHei",system-ui,sans-serif';

/* 光柱（激光）各层的不透明度。
   **本体这一层就是"光柱的透明度"**，作者定在 75%。

   注意三层会**叠加**，所以肉眼看到的比 0.75 更实：
     本体 0.75 + 柔光外壳 0.21  →  中间实心带约 80%
     再叠白色高光核心线         →  正中心约 94%
   要让整道光柱更透，调这一个数就行（柔光与核心都按比例跟着走）；
   如果只是嫌正中间那条白线太亮，调 BEAM_CORE。 */
export const BEAM_ALPHA = 0.75;
const BEAM_GLOW = 0.28;      // 柔光外壳相对本体的比例
const BEAM_CORE = 0.95;      // 中心高亮核心线相对本体的比例

/* ---------- 开华（形态强化）的表现 ----------
   作者 2026-10 的要求：「开华的时候特效稍微显眼一点，并且伴随轻微的屏幕抖动」。
   分成两块：
     · **一次性爆发**（bloom 事件）：三层彩色光环 + 中心闪光 + 放射细线，
       比原来更亮更粗、持续更久（34 帧 ≈ 0.57 秒）；
     · **常驻形态光晕**（开华之后的每一帧）：脚下旋转的极光弧 + 一层柔光底。
   屏幕抖动见下面的 SHAKE_*。 */
export const BLOOM_RING_ALPHA = 1.0;   // 三层光环的基准不透明度（原来最内层 0.85）
export const BLOOM_RING_WIDTH = 6.5;   // 最内层线宽（原来 4，每层递减 1）
export const BLOOM_FLASH_ALPHA = 0.5;  // 中心闪光的峰值不透明度
export const BLOOM_GLOW_ALPHA = 0.34;  // 开华后脚下常驻柔光的强度（原来没有底光）
export const BLOOM_ARC_ALPHA = 0.34;   // 常驻旋转弧的基准不透明度（原来 0.18）
export const BLOOM_LIFE = 34;          // 这次爆发持续多少帧（普通事件是 22）

/* 屏幕抖动：只在**开华那一瞬间**轻微晃一下。
   位移按"距离开华帧数"衰减，所以它完全由帧号 + 事件推出来 ——
   不用墙上时钟，暂停会冻在那一帧、拖进度条也会跟着回到同一状态（渲染层的铁律）。 */
export const SHAKE_MAX = 3.2;    // 最大位移（世界单位；场地宽 720，约 0.4%）
export const SHAKE_FRAMES = 20;  // 抖多久（20 帧 ≈ 0.33 秒）
export const SHAKE_HZ = 14;      // 抖动的来回频率

/* ---------- 见晴（白水仙）：水镜三态 + 起飞 ----------
   作者还没给见晴美术，所以这一整块都是**程序化**表现：
     · 水镜外圈：小球边缘一圈的颜色 = 当前形态（淡绿 / 淡粉 / 深蓝紫 / 白）；
     · 猩红长剑：一根深红色光柱贴在球缘，随移动方向转（挥动时另有事件动画）；
     · 护盾：水镜护盾 > 0 时球外一圈柔光（护盾值本身走资源条）；
     · 起飞：虚化 + 变大 + 下方影子（近大远小），这是作者明确要求的观感。
   全部由快照（16/17 颜色、18 状态位）与事件流驱动，所以暂停/回放都对得上。 */
export const MIRROR_RING_W = 3.4;      // 水镜外圈的线宽
export const MIRROR_RING_GAP = 3.2;    // 外圈离球面多远
export const FLY_SCALE = 1.35;         // 飞行中的显示放大（判定箱不变）
export const FLY_ALPHA = 0.55;         // 飞行中的"虚化"透明度
export const FLY_SHADOW_ALPHA = 0.22;  // 影子的浓度
export const SHIELD_ALPHA = 0.30;      // 护盾柔光的峰值
export const SWORD_W = 4.5;            // 长剑（深红光柱）的粗细
/** 挥动动画默认帧数（事件没带 swingFrames 时用这个） */
export const SWORD_SWING_FRAMES = 12;
const MIRROR_COLORS = {
  1: '#86efac',   // ① 淡绿
  2: '#f9a8d4',   // ① 淡粉
  3: '#5b21b6',   // ③ 深蓝紫
  4: '#ffffff',   // ③ 白
};
const SWORD_COLOR = '#8b1a1a';         // ② 猩红（暂时用深红光柱替代美术）

/* ---------- 伤害飘字 ----------
   作者 2026-10 的要求：「加大加粗伤害文字，把伤害文字改为显眼一些的红色」。
   原来是最普通的深灰 `bold 12px`。这一版做了四件事：
     · **更大更粗**（DMG_FONT_PX / DMG_WEIGHT）；
     · **鲜红 + 浅色描边**：场地是浅色方格纸、球又是深色贴图，
       纯红字压在深色球面上会糊、压在纸上会飘 —— 那圈浅色描边才是
       "显眼"的真正来源，填充色只负责"是红的"；
     · **出现瞬间放大再收回**（DMG_POP → 1，DMG_POP_FRAMES 帧内），
       让数字像是被打出来的，而不是浮在那里的；
     · **伤害越高字越大**（DMG_SIZE_GAIN，设 0 = 关掉，回到统一字号）。
   字号用的权重来自 audio.js 的 hitWeight() —— 和打击音是同一套刻度，
   否则同一下重击会出现"看起来比听起来轻"的错位。 */
export const DMG_FONT_PX = 19;         // 基准字号（原来 12）
export const DMG_WEIGHT = 800;         // 字体粗细（原来 bold ≈ 700）
export const DMG_COLOR = '#e11d1d';    // 填充色：鲜红
export const DMG_OUTLINE = '#fffdf8';  // 描边色：和场地纸同色系的浅色
export const DMG_OUTLINE_W = 3.4;      // 描边宽度（0 = 不描边）
export const DMG_SIZE_GAIN = 0.4;      // 满权重时字号再放大这么多倍（0 = 不随伤害变）
export const DMG_RISE = 24;            // 飘字上升距离（世界单位，原来 20）
export const DMG_POP = 1.35;           // 出现那一瞬间的放大倍数
export const DMG_POP_FRAMES = 7;       // 放大用几帧收回 1.0
const DMG_ALPHA = 0.95;                // 飘字自身的不透明度（再乘事件淡出）

/* ---------- 贴图弹道：光效环绕 + （只给蝙蝠的）透明度呼吸 ----------
   都只作用于**贴图弹道**（箭矢 / 蝙蝠 / 能量弹）：

   ① **光效环绕**：对应颜色的半透明光晕，椭圆、贴着图的形状
      （箭是长条、弹是圆球，用圆会把长箭裹成一大团）。
      颜色按弹道种类给（各技能的 `spriteGlow`），画在图**下面**，不糊图。

   ② **透明度呼吸**：**只有配了 `spritePulse` 的弹道才有**（目前只有蝙蝠）。
      作者的要求是"只有蝙蝠有透明度呼吸效果，其他特效均不要"，
      所以这是一个**显式开关**，不是全局行为：
        · 配了 → 图与光晕的不透明度在 PROJ_ALPHA_MIN ~ MAX 之间来回浮动；
        · 没配 → 图完全不透明（1.0）、光晕取峰值常数，整枚弹道一动不动。

   ⚠ 光晕颜色必须挑**中等饱和度**的：场地背景是浅色方格纸（#fdfcf7），
   淡白的光晕在白纸上等于没画。 */
export const PROJ_ALPHA_MIN = 0.25;    // 呼吸区间（作者定，只对配了 spritePulse 的弹道生效）
export const PROJ_ALPHA_MAX = 0.40;
export const PROJ_PULSE_HZ = 1.1;      // 每秒呼吸几个来回
export const PROJ_GLOW_ALPHA = 0.30;   // 光晕中心的不透明度峰值（"不用做太过强烈"）
export const PROJ_GLOW_RX = 0.55;      // 光晕半长轴 ÷ 图长
export const PROJ_GLOW_RY = 0.95;      // 光晕半短轴 ÷ 图高
export const PROJ_GLOW_FLOOR = 0.45;   // 呼吸时，光晕暗到峰值的这个比例为止

/** 呼吸相位 0~1（用 cos 的半波，两端都真的能取到）。
 *
 *  相位用**帧号**算，不用墙上时钟 —— 渲染层只读快照（见文件头），
 *  用 performance.now() 的话一暂停弹道就继续明暗闪，拖进度条也回不到同一帧的样子。
 *
 *  `seed` 让同一种弹道里的几只各呼吸各的：不加偏移的话同时在场的几只
 *  会一起明暗，看起来是"画面在闪"，而不是"每只在呼吸"。 */
function pulseAt(frame, hz, seed) {
  const f = hz > 0 ? hz : PROJ_PULSE_HZ;
  const off = (seed || 0) * 0.37;
  return 0.5 - 0.5 * Math.cos((frame / 60 + off) * f * Math.PI * 2);
}


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

/** 诊断用：已经登记过的贴图路径（"这枚弹道/这张球贴图为什么不显示"全靠它）。
 *  渲染层对没就绪的贴图是"宁可不画"，所以"路径在不在表里"是第一个要查的事。 */
export function stickerPaths() {
  return [...stickerCache.keys()];
}

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

/** 预加载整局用到的**弹道贴图**（箭矢 / 蝙蝠 / 能量弹…）。
 *
 *  为什么必须在"整局算完"之后调：弹道是模拟过程中才产生的，
 *  `battle.projSpritePalette` 要跑完才有内容。而本项目恰好是
 *  "先把整局算完、再推动播放头"，所以这时候能一次拿到全场用到的贴图。
 *
 *  ⚠ **玩家操控是实时推进的**（见 ui-battle.js），开战那一刻调这个函数时
 *  弹药一枚都还没生出来 —— 于是那种弹道的贴图要等到"第一次开火的那一帧
 *  才在绘制里现加载"，那一两帧只能画程序化光点（作者看到的就是
 *  "手操时特效不对/像没了"）。所以实时模式里**每帧都要再补一次**
 *  （见 ui-battle.js 的 `warmSprites()`）：调色板一长出新条目就立刻预热。
 *
 *  不预热会怎样：某种弹道**第一次出现的那一两帧什么都不画**
 *  （渲染层对没加载好的贴图是"宁可不画，也不画个方块"），
 *  看起来就像"第一发没有特效"。都是本地小图、加载很快，
 *  但首次开火那一帧照样会空 —— 这是观感问题，不是性能问题。 */
export function preloadProjSprites(battle) {
  for (const e of (battle && battle.projSpritePalette) || []) {
    if (e && e.src) getSticker(e.src);
  }
}

/** 预加载一组球种用到的贴图（进入战斗前调用一次） */
export function preloadStickers(speciesList) {
  for (const sp of speciesList || []) {
    if (sp && sp.sticker && sp.sticker.src) getSticker(sp.sticker.src);
    // 形态切换的第二张贴图（如晕彩的开华形态）也要预热，否则切换瞬间会闪一下纯色圆
    if (sp && sp.stickerBloom && sp.stickerBloom.src) getSticker(sp.stickerBloom.src);
    /* 手持物件（弓）同理。多帧的话每一帧都要预热 ——
       否则拉到某一帧才第一次去加载，会看到弓闪一下不见了。
       弓有两种写法：单一武器（src / frames）和多武器（kindArt + arts），
       两种都走一遍，缺哪一种都不会在战斗中现加载。 */
    if (sp && sp.bow) {
      const sets = (Array.isArray(sp.bow.arts) && sp.bow.arts.length) ? sp.bow.arts : [sp.bow];
      for (const art of sets) {
        if (!art) continue;
        if (art.src) getSticker(art.src);
        for (const f of art.frames || []) if (f && f.src) getSticker(f.src);
        /* 每一式的四个动作位都要预热：idle / draw / shot / arrow */
        for (const k of ['idle', 'draw', 'shot', 'arrow']) {
          if (typeof art[k] === 'string') getSticker(art[k]);
        }
      }
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

/** 按 castKind 从 bow.kindArt 表里挑出这一式该用哪套美术。
 *
 *  背景：映霞[荣] 和 映霞[枯] 是同一只球的两个技能，长得完全不一样
 *  （荣是粉弓、枯是墨色花枝弓），而弓的美术挂在**球种**上 ——
 *  渲染层从球身上看不出当前放的是哪一式。
 *  所以技能把 castKind（0 普通 / 1 五连发 / 2 枯）写进快照，
 *  渲染层照 balls.js 的 kindArt 表查，两边共用同一张表。
 *
 *  bow 兼容两种写法：
 *    单一武器  → 直接就是一套（有 idle / draw 那层）
 *    多武器    → { kindArt: [...], arts: [...] }
 *  单一写法原样返回；查不到（越界 / 表少写了一段）就回退第 0 套，
 *  绝不返回 undefined 把渲染搞崩。 */
export function pickBowArt(bow, castKind) {
  if (!bow) return null;
  const arts = bow.arts;
  if (!Array.isArray(arts) || !arts.length) return bow;
  const table = Array.isArray(bow.kindArt) ? bow.kindArt : null;
  const k = castKind | 0;
  /* 越界**不**夹到表的末项：末项是枯（花枝弓），而一个来路不明的
     castKind 更可能是"普通施法"而不是"最后一式"，所以回退第 0 套。 */
  const idx = (table && k >= 0 && k < table.length) ? (table[k] | 0) : 0;
  if (!(idx >= 0 && idx < arts.length)) return arts[0];
  return arts[idx];
}

/** 开华爆发的**几何参数**（纯函数，给定进度 t∈[0,1] 算出这一帧该画什么）。
 *
 *  为什么要单独抽出来：它有两个消费者 ——
 *     · 渲染层（画到 canvas 上）；
 *     · 离线预览 `tools/preview-bloom.mjs`（画成 PNG 给作者看）。
 *  两边各写一份公式迟早会漂（本项目在"五连发扇形"上就吃过一次亏，
 *  预览画的 14° 和真正飞出去的 24° 差了一倍）。所以公式只此一份。 */
export function bloomBurstSpec(t) {
  const k = Math.max(0, Math.min(1, t));
  const cols = ['#a78bfa', '#7dd3fc', '#f0abfc'];
  return {
    /* 三层扩散光环：更粗更亮（作者要求"显眼一点"） */
    rings: [0, 1, 2].map(i => ({
      r: 12 + i * 9 + k * 58,
      lw: BLOOM_RING_WIDTH - i * 1.6,
      alpha: BLOOM_RING_ALPHA - i * 0.22,
      color: cols[i]
    })),
    /* 中心闪光：只在最前 40% 里存在 */
    flash: k < 0.4
      ? { r: 10 + k * 70, alpha: BLOOM_FLASH_ALPHA * (1 - k / 0.4) }
      : null,
    /* 放射细线：8 根，从光环内侧往外推 */
    rays: [0, 1, 2, 3, 4, 5, 6, 7].map(i => {
      const a = (i / 8) * Math.PI * 2 + 0.2;
      const r0 = 10 + k * 40;
      return { a, r0, r1: r0 + 10 + k * 22 };
    })
  };
}

/** 五连发每一根箭相对瞄准方向的偏角（度），**跳过正中那一根**。 *
 *  这条公式必须和 skills.js 真正发箭时用的那条逐根对齐 ——
 *  画这个扇形的全部意义就是"预告这五发往哪飞"。两边各写一遍迟早会漂
 *  （历史上就差过整整一倍：技能 24°，画出来 14°）。
 *  所以这里导出成函数：渲染层、诊断（bow.mjs 拿它和真实弹道速度对）和
 *  预览脚本（tools/preview-bow.mjs）都调它，谁都不再抄一份。
 *
 *  正中那一根（off = 0）要跳过：它已经画在 draw 那张图里了，
 *  再画一根会和图上那支叠成两支。 */
export function burstOffsetsDeg(burst) {
  if (!burst || !(burst.count >= 2) || !(burst.spreadDeg > 0)) return [];
  const out = [];
  for (let k = 0; k < burst.count; k++) {
    const off = ((k / (burst.count - 1)) * 2 - 1) * burst.spreadDeg;
    if (Math.abs(off) < 1e-9) continue;
    out.push(off);
  }
  return out;
}

/** 画一个伤害飘字。**游戏与素材编辑器的预览共用这一份**——
 *  预览另抄一套公式的话，作者照着预览调完，实际打出来又是另一个样子
 *  （本项目在"五连发扇形"上吃过一次亏：预览 14°、实际 24°）。
 *
 *  @param text      要画的字（一般是 `-66`）
 *  @param x,y       飘字**当前**的位置（调用方算好上升偏移）
 *  @param w         伤害权重 0~1（来自 hitWeight()，决定字号）
 *  @param ageFrames 这个事件已经过去了几帧（只用来做出现瞬间的放大）
 *  @param opts      可覆盖任意一个 DMG_*（素材编辑器预览用），
 *                   另有 fade = 事件整体的淡出系数 */
export function drawDamageNumber(ctx, text, x, y, w, ageFrames, opts = {}) {
  const k = Math.max(0, Math.min(1, Number(w) || 0));
  const px = (opts.px ?? DMG_FONT_PX) * (1 + (opts.sizeGain ?? DMG_SIZE_GAIN) * k);
  const popTo = opts.pop ?? DMG_POP;
  const popFrames = Math.max(1e-6, opts.popFrames ?? DMG_POP_FRAMES);
  const pop = 1 + (popTo - 1) * Math.max(0, 1 - Math.max(0, ageFrames) / popFrames);
  ctx.save();
  ctx.globalAlpha = DMG_ALPHA * (opts.fade ?? 1);
  ctx.translate(x, y);
  ctx.scale(pop, pop);
  ctx.font = `${opts.weight ?? DMG_WEIGHT} ${px.toFixed(1)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  /* 描边要"圆角接头"，否则粗描边会在笔画尖角处支棱出小刺 */
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  const ow = opts.outlineW ?? DMG_OUTLINE_W;
  if (ow > 0) {
    ctx.lineWidth = ow;
    ctx.strokeStyle = opts.outline ?? DMG_OUTLINE;
    ctx.strokeText(text, 0, 0);
  }
  ctx.fillStyle = opts.color ?? DMG_COLOR;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

export class Renderer {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.showDamage = true;
    this.showHud = true;      // 是否显示血条/资源条
    /* 屏幕抖动开关（开华那一下）。战斗界面控制条上有勾选框，
       对应 prefs 里的"屏幕抖动" —— 有人不喜欢镜头晃，给个开关。 */
    this.screenShake = true;
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

  /* ---------- 屏幕 ⇄ 世界（玩家用鼠标瞄准时要它） ----------
     CSS 像素 → 世界单位。换算链与 draw() 里那套必须**完全互逆**：
       · 缓冲区坐标 = CSS 坐标 × (cv.width / cssW)
       · 世界坐标   = 缓冲区坐标 ÷ camScale + cam 原点
     这里直接用「一个 CSS 像素等于多少世界单位」一步到位：
     cssW 个 CSS 像素正好铺满 boxW 个世界单位。 */
  screenToWorld(clientX, clientY) {
    const cv = this.cv;
    const r = cv.getBoundingClientRect();
    const cssW = r.width || this.cssW || 1;
    const cssH = r.height || this.cssH || 1;
    return {
      x: this.camX + ((clientX - r.left) / cssW) * (this.boxW || WORLD_W),
      y: this.camY + ((clientY - r.top) / cssH) * (this.boxH || WORLD_H),
    };
  }

  /** 玩家瞄准指示：从自己的球到鼠标一条细虚线 + 鼠标处一个准星。
   *  画在 draw() 之后（自己重设一次变换），所以不受绘制顺序影响。
   *  ⚠ 用的是 draw() **记录下来的** _usedScale/_usedCam（含屏幕抖动），
   *  和刚刚那一帧画出来的东西严格对齐。 */
  drawAim(world, opts = {}) {
    const ctx = this.ctx;
    if (!ctx || !world) return;
    const s = this._usedScale || this.camScale || 1;
    const camX = (this._usedCamX ?? this.camX) ?? 0;
    const camY = (this._usedCamY ?? this.camY) ?? 0;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(s, s);
    ctx.translate(-camX + (this.shakeX || 0), -camY + (this.shakeY || 0));
    /* 世界里线宽是"世界单位"，所以要按 s 缩小 —— 否则 1px 线在高分屏上会变粗 */
    const px = 1 / s;
    const from = opts.from;
    ctx.strokeStyle = opts.color || 'rgba(255,255,255,0.5)';
    ctx.lineWidth = px * 1.4;
    ctx.setLineDash([px * 6, px * 6]);
    if (from) {
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(world.x, world.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(world.x, world.y, px * 9, 0, Math.PI * 2);
    ctx.lineWidth = px * 1.6;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(world.x - px * 13, world.y); ctx.lineTo(world.x - px * 4, world.y);
    ctx.moveTo(world.x + px * 4, world.y); ctx.lineTo(world.x + px * 13, world.y);
    ctx.moveTo(world.x, world.y - px * 13); ctx.lineTo(world.x, world.y - px * 4);
    ctx.moveTo(world.x, world.y + px * 4); ctx.lineTo(world.x, world.y + px * 13);
    ctx.stroke();
    ctx.restore();
  }

  /** 世界坐标是否在视野内（用于剔除） */
  get viewW() { return this.boxW || WORLD_W; }
  get viewH() { return this.boxH || WORLD_H; }

  /** 屏幕抖动：只在**开华那一瞬间**轻微晃一下。
   *
   *  两条硬要求：
   *   1. **跟着帧号算，不跟墙上时钟** —— 渲染层只读快照（见文件头）。
   *      用 performance.now() 的话，一暂停画面就继续晃、拖进度条也回不到同一帧的样子。
   *   2. **不叠加**：几个晕彩同时开华时取最强的那一次，而不是把位移加起来 ——
   *      加起来会变成"晃得看不清"，而作者要的是"轻微"。
   *
   *  开华事件的帧号缓存一份：事件流最多 6000 条，每帧全扫一遍没必要。
   *  缓存键带上事件条数，所以战斗中新增事件（析光召唤等）会自动失效重建。 */
  _screenShake(battle, f) {
    if (!this.screenShake) return { x: 0, y: 0, amp: 0 };
    const evs = battle.events || [];
    let cache = this._shakeCache;
    if (!cache || cache.battle !== battle || cache.n !== evs.length) {
      cache = this._shakeCache = {
        battle, n: evs.length,
        frames: evs.filter(e => e.type === 'bloom').map(e => e.f)
      };
    }
    let amp = 0;
    for (const bf of cache.frames) {
      const age = f - bf;
      if (age < 0 || age > SHAKE_FRAMES) continue;
      const k = 1 - age / SHAKE_FRAMES;
      amp = Math.max(amp, k * k);          // 取最强的一次，不累加
    }
    if (amp <= 0) return { x: 0, y: 0, amp: 0 };
    const ph = (f / 60) * SHAKE_HZ * Math.PI * 2;
    return {
      x: Math.sin(ph) * SHAKE_MAX * amp,
      y: Math.cos(ph * 1.37) * SHAKE_MAX * 0.7 * amp,
      amp
    };
  }

  /** 取"这一帧某个单位正在挥的那一剑"（没有就返回 null）。
   *
   *  为什么要缓存：`battle.events` 可以有几千条，每帧每个球都线性扫一遍
   *  是白花钱 —— 和上面 `_screenShake` 同一个做法：事件流**只增不改**，
   *  所以按 battle 缓存一份索引就够（缓存键带上事件条数，新增事件会自动重建）。
   *
   *  返回 { angle, sweep, len, kind, t }：t 从 0（刚挥出）到 1（收招）。
   *  挥动的**判定**在引擎那一帧就结算完了，这里纯粹是"补一段看得见的动作" ——
   *  所以它是表现层的东西，靠帧号驱动，暂停会冻住、回放会跟着倒回去。
   *  （作者 2026-10 的要求：长剑挥动时要**以小球原点为轴**转起来。） */
  _swordSwingAt(battle, unitIdx, frame) {
    const evs = battle.events || [];
    if (this._swingOwner !== battle || this._swingN !== evs.length) {
      this._swingOwner = battle;
      this._swingN = evs.length;
      const map = new Map();
      for (const e of evs) {
        if (e.type !== 'swordSwing' || !(e.a >= 0)) continue;
        let list = map.get(e.a);
        if (!list) map.set(e.a, (list = []));
        list.push({
          f: e.f,
          angle: e.angle || 0,
          sweep: ((e.sweepDeg != null ? e.sweepDeg : 120) * Math.PI) / 180,
          len: e.swordLen || 0,
          kind: e.kind || 'attack',
          frames: e.swingFrames || SWORD_SWING_FRAMES,
        });
      }
      this._swingMap = map;
    }
    const list = this._swingMap.get(unitIdx);
    if (!list) return null;
    /* 从后往前找最近的一次挥动（列表按帧号天然递增） */
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      if (s.f > frame) continue;
      const age = frame - s.f;
      if (age > s.frames) return null;
      return {
        angle: s.angle, sweep: s.sweep, len: s.len, kind: s.kind,
        t: Math.max(0, Math.min(1, age / s.frames)),
      };
    }
    return null;
  }

  /* ---------- 主绘制入口 ----------     frame: 播放头所在帧号（可能小于 battle.frame，实现回放）
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

    /* 屏幕抖动：整场（场地 + 球 + 特效）一起晃，像镜头被震了一下。
       放在世界变换里，所以背景网格（屏幕坐标系）不动 —— 那正是"镜头晃、纸不动"的观感。 */
    const shake = this._screenShake(battle, Math.min(frame, battle.snapshots.length - 1));
    this.shakeX = shake.x;
    this.shakeY = shake.y;
    this.shakeAmp = shake.amp;

    ctx.save();
    ctx.scale(s, s);
    ctx.translate(-camX + shake.x, -camY + shake.y);

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
      /* 开华那一下刻意比普通事件**活得久**（34 帧 ≈ 0.57 秒）：
         22 帧一闪就过去了，作者的要求是"稍微显眼一点"。
         注意 t 也要用它自己的寿命算，否则光环会提前到达 t=1 而停滞。 */
      const life = e.type === 'bloom' ? BLOOM_LIFE : LIFE;
      const age = frame - e.f;
      if (age < 0 || age > life) continue;
      const t = age / life;
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
          /* 伤害飘字：红的、粗的、带浅色描边，伤害越高越大（见 drawDamageNumber）。
             位置比原来再高一点，免得那圈更粗的描边压到球身上。 */
          drawDamageNumber(ctx, `-${Math.round(e.value)}`, e.bx, e.by - 20 - t * DMG_RISE,
            hitWeight(e.value), age, { fade: alpha });
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
        /* 开华：三层彩色光环向外炸开（和极光同色系），强调"形态变了"。
           作者反馈"想更显眼一点"，所以这一版加了三样：
             · 中心的**闪光圆盘**（径向渐变，爆开瞬间最亮，很快收掉）；
             · 光环更亮更粗（见文件头的 BLOOM_* 常量）；
             · 一圈**放射细线**，让"炸开"有方向感。
           它的寿命比普通事件长（BLOOM_LIFE），否则 22 帧一闪就过去了。
           几何全部来自 bloomBurstSpec —— 离线预览调的是同一个函数。 */
        const spec = bloomBurstSpec(t);
        if (spec.flash) {
          const R = spec.flash.r, fa = spec.flash.alpha;
          const g = ctx.createRadialGradient(e.ax, e.ay, 0, e.ax, e.ay, R);
          g.addColorStop(0, `rgba(255,255,255,${fa.toFixed(3)})`);
          g.addColorStop(0.4, `rgba(196,181,253,${(fa * 0.7).toFixed(3)})`);
          g.addColorStop(1, 'rgba(167,139,250,0)');
          ctx.globalAlpha = 1;
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(e.ax, e.ay, R, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = alpha * 0.75;
        ctx.strokeStyle = '#f5d0fe';
        ctx.lineWidth = 2;
        for (const ray of spec.rays) {
          ctx.beginPath();
          ctx.moveTo(e.ax + Math.cos(ray.a) * ray.r0, e.ay + Math.sin(ray.a) * ray.r0);
          ctx.lineTo(e.ax + Math.cos(ray.a) * ray.r1, e.ay + Math.sin(ray.a) * ray.r1);
          ctx.stroke();
        }
        for (const ring of spec.rings) {
          ctx.globalAlpha = alpha * ring.alpha;
          ctx.strokeStyle = ring.color;
          ctx.lineWidth = ring.lw;
          ctx.beginPath();
          ctx.arc(e.ax, e.ay, ring.r, 0, Math.PI * 2);
          ctx.stroke();
        }
      } else if (e.type === 'mirrorSwitch') {
        /* 见晴①②③：水镜切换。
           作者的原话是"身前出现一副水镜，见晴穿过水镜，小球边缘一圈的颜色发生变化" ——
           所以这里画的是**球前方立着的一面镜子**：一个竖直的椭圆镜面，
           边缘是新的形态颜色，往外撑开一点再淡出（她"穿过去"的那一下）。 */
        const col = MIRROR_COLORS[e.value] || '#ffffff';
        const fa = ((e.face ?? 0) * Math.PI) / 180;
        const gap = 26 + t * 10;
        const mx = e.ax + Math.cos(fa) * gap;
        const my = e.ay + Math.sin(fa) * gap;
        const rw = 6 + (1 - t) * 4;
        const rh = 26 * (1 - t * 0.25);
        ctx.globalAlpha = alpha * 0.85;
        ctx.strokeStyle = col;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.ellipse(mx, my, rw, rh, fa, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = alpha * 0.28;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.ellipse(mx, my, rw * 0.7, rh * 0.9, fa, 0, Math.PI * 2);
        ctx.fill();
        /* 球缘那一圈也要跟着亮一下（换色的"落点"） */
        ctx.globalAlpha = alpha * 0.7;
        ctx.beginPath();
        ctx.arc(e.ax, e.ay, 16 + MIRROR_RING_GAP + t * 6, 0, Math.PI * 2);
        ctx.stroke();
      } else if (e.type === 'swordSwing') {
        /* 见晴②：长剑挥动。扇形扫过那道弧 —— 
           attack 是砍人（猩红），guard 是消除魔弹（更亮的白红）。 */
        const guard = e.kind === 'guard';
        const a0 = (e.angle || 0) - 0.9 + t * 0.5;
        const len = e.swordLen || 32;
        const rr = 16 + len;
        ctx.globalAlpha = alpha * (guard ? 0.95 : 0.8);
        ctx.strokeStyle = guard ? '#fecaca' : SWORD_COLOR;
        ctx.lineWidth = guard ? 5 : 7;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(e.ax, e.ay, rr * 0.85, a0, a0 + 1.5);
        ctx.stroke();
        ctx.globalAlpha = alpha * 0.5;
        ctx.strokeStyle = '#fca5a5';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(e.ax, e.ay, rr * 1.05, a0, a0 + 1.5);
        ctx.stroke();
        ctx.lineCap = 'butt';
      } else if (e.type === 'projPurge') {
        /* 长剑扫掉的敌方弹道：一个小十字爆点（和普通命中区分开） */
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = e.color || '#fecaca';
        ctx.lineWidth = 2.4;
        const rr = 4 + t * 10;
        ctx.beginPath();
        ctx.moveTo(e.px - rr, e.py - rr); ctx.lineTo(e.px + rr, e.py + rr);
        ctx.moveTo(e.px + rr, e.py - rr); ctx.lineTo(e.px - rr, e.py + rr);
        ctx.stroke();
      } else if (e.type === 'takeoff' || e.type === 'landing') {
        /* 起飞 / 落地：两圈向外扩的羽毛色圆环 + 一对"翅膀"弧线。
           takeoff 向外扩（离地），landing 向内收（落地）—— 方向就能读出来。 */
        const up = e.type === 'takeoff';
        const k = up ? t : 1 - t;
        ctx.globalAlpha = alpha * 0.8;
        ctx.strokeStyle = '#e0f2fe';
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.arc(e.ax, e.ay, 14 + k * 34, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = alpha * 0.55;
        ctx.lineWidth = 2;
        for (const s of [-1, 1]) {
          const a0 = s > 0 ? -0.9 : Math.PI + 0.9;
          ctx.beginPath();
          ctx.arc(e.ax, e.ay, 20 + k * 26, a0 - 0.5, a0 + 0.5);
          ctx.stroke();
        }
      } else if (e.type === 'flyUpgrade') {
        /* 见晴飞完一次的永久成长（移速 +5 / 帧伤 +0.5）：一圈金色光环 + 三道上升的短线。
           没有这个反馈的话，"每次飞完都更强"是玩家完全看不见的机制。 */
        ctx.globalAlpha = alpha * 0.9;
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.arc(e.ax, e.ay, 16 + t * 26, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = alpha * 0.75;
        ctx.lineWidth = 2;
        for (let i = 0; i < 3; i++) {
          const dx = (i - 1) * 7;
          const y0 = e.ay + 14 - t * 18;
          ctx.beginPath();
          ctx.moveTo(e.ax + dx, y0);
          ctx.lineTo(e.ax + dx, y0 - 9);
          ctx.stroke();
        }
      } else if (e.type === 'featherHit') {
        /* 羽毛命中：一小簇羽毛状的放射线 */
        ctx.globalAlpha = alpha * 0.9;
        ctx.strokeStyle = '#bfe3ff';
        ctx.lineWidth = 2;
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + 0.3;
          const r0 = 4 + t * 6, r1 = 10 + t * 16;
          ctx.beginPath();
          ctx.moveTo(e.px + Math.cos(a) * r0, e.py + Math.sin(a) * r0);
          ctx.lineTo(e.px + Math.cos(a) * r1, e.py + Math.sin(a) * r1);
          ctx.stroke();
        }
      } else if (e.type === 'immune') {
        /* 起飞期间被打到：一圈淡黄的"挡下"光环。
           没有这个反馈的话，玩家只会看到"打了不掉血"，像是 bug。 */
        ctx.globalAlpha = alpha * 0.7;
        ctx.strokeStyle = '#fde68a';
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.arc(e.bx ?? e.ax, e.by ?? e.ay, 18 + t * 10, 0, Math.PI * 2);
        ctx.stroke();
      } else if (e.type === 'blocked') {
        /* 护盾全额挡下：一层青色盾光闪一下 */
        ctx.globalAlpha = alpha * 0.7;
        ctx.strokeStyle = '#a5f3fc';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(e.bx ?? e.ax, e.by ?? e.ay, 20 + t * 8, 0, Math.PI * 2);
        ctx.stroke();
      } else if (e.type === 'shieldHit') {
        /* 护盾吃到伤害：贴着球面的碎裂弧 */
        ctx.globalAlpha = alpha * 0.85;
        ctx.strokeStyle = '#f0abfc';
        ctx.lineWidth = 3;
        for (let i = 0; i < 3; i++) {
          const a0 = (i / 3) * Math.PI * 2 + t * 2;
          ctx.beginPath();
          ctx.arc(e.ax, e.ay, 20 + i * 3, a0, a0 + 0.7);
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
        // 血量代价：本体上方飘一个小小的 -N（用冷色、字号也小，和伤害的红字区分开）
        if (this.showDamage) {
          drawDamageNumber(ctx, `-${Math.round(e.value)}`, e.ax, e.ay - 18 - t * 16, 0, age, {
            fade: alpha * 0.9, px: 13, color: '#7c3aed', outlineW: 2.4, sizeGain: 0, pop: 1.15,
          });
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
      const ptype = pj[i + 5];                 // 0 特效 / 1 实体 / 2 光束 / 3 锚定光柱 / 4 羽毛
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

      /* ---------- 羽毛（见晴⑥）----------
         没有美术，所以程序化画一根羽毛：一片沿飞行方向拉长的椭圆 +
         中间一根羽轴 + 几根羽枝 + 外圈淡蓝柔光。它和别的弹道最大的不同是
         "会拐弯"（追踪 + 反弹），所以画成有方向感的形状比画成圆点更好读。
         ⚠ 这段必须在 dirX/dirY **读出来之后**（原先放在前面，踩了一个
         TDZ 的坑：const 声明的变量在声明前使用会直接抛错）。 */
      if (ptype > 3.5) {
        const ang = Math.atan2(dirY, dirX);
        const len = Math.max(10, r * 3.4);
        const wid = Math.max(3.5, r * 1.2);
        const fadeIn = lifeT < 0.25 ? lifeT / 0.25 : 1;
        ctx.globalAlpha = 0.75 * fadeIn;
        const g = ctx.createRadialGradient(x, y, 0, x, y, len * 0.9);
        g.addColorStop(0, 'rgba(191,227,255,0.55)');
        g.addColorStop(1, 'rgba(191,227,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, len * 0.9, 0, Math.PI * 2); ctx.fill();
        ctx.translate(x, y);
        ctx.rotate(ang);
        ctx.globalAlpha = 0.95 * fadeIn;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.ellipse(0, 0, len * 0.5, wid, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(-len * 0.5, 0); ctx.lineTo(len * 0.5, 0);
        ctx.stroke();
        /* 羽枝：几根斜线，一眼能认出是羽毛 */
        ctx.lineWidth = 1;
        for (let k = -2; k <= 2; k++) {
          const px = k * len * 0.16;
          ctx.beginPath();
          ctx.moveTo(px, 0);
          ctx.lineTo(px - len * 0.08, -wid * 0.9);
          ctx.moveTo(px, 0);
          ctx.lineTo(px - len * 0.08, wid * 0.9);
          ctx.stroke();
        }
        ctx.restore();
        continue;
      }

      /* 接近寿命尽头时淡出，避免"啪"地凭空消失。
         实体弹比特效弹更实（不透明度更高、有描边）。 */
      const fade = lifeT < 0.25 ? lifeT / 0.25 : 1;
      const core = fade * (isBody ? 1 : 0.75);

      /* 贴图弹道（箭矢 / 蝙蝠 / 能量弹）：有图就直接按飞行方向转着画，
         不再画程序化的光点。这样"搭在弓上的箭"和"飞出去的箭"
         是同一张图，撒放那一瞬间接得上。
         外面套一层**对应颜色的半透明光晕**；**只有配了 `spritePulse`
         的弹道**（目前只有蝙蝠）图与光晕才会呼吸 —— 其余一律静止。
         调数值看文件头那几个常量与各技能的 `spriteGlow` / `spritePulse`。 */
      if (spr && spr.src) {
        const st = getSticker(spr.src);
        if (st && st.ready && !st.failed) {
          const iw = st.img.naturalWidth || st.img.width;
          const ih = st.img.naturalHeight || st.img.height;
          const len = spr.len > 0 ? spr.len : r * 6;
          const hgt = len * (ih / iw);
          /* 呼吸：0 = 这一枚不呼吸（图全不透明、光晕取峰值常数）。
             一个开关决定"谁在呼吸"，见文件头 —— 别在这里按种类写 if。 */
          const pulse = spr.pulse ? pulseAt(snap.f || 0, PROJ_PULSE_HZ, sprIdx) : 1;
          const artA = spr.pulse
            ? PROJ_ALPHA_MIN + (PROJ_ALPHA_MAX - PROJ_ALPHA_MIN) * pulse
            : 1;
          /* 贴图相对**判定中心**的偏移（世界单位，弹道局部坐标：+x 朝前）。
             判定中心 = 弹道位置（物理上就是它参与碰撞），所以"图偏了"记在这里；
             0 = 图正好套在判定圆上。光晕要跟着图一起偏 ——
             否则会出现"光在一个位置、图在另一个位置"。 */
          const offX = spr.offX || 0, offY = spr.offY || 0;
          ctx.translate(x, y);
          ctx.rotate(Math.atan2(dirY, dirX));   // 光晕是椭圆，必须跟着转

          /* ① 光晕：画在图下面，颜色按弹道种类给 */
          if (spr.glow) {
            const grx = Math.max(1, len * PROJ_GLOW_RX);
            const gry = Math.max(1, hgt * PROJ_GLOW_RY);
            /* 不呼吸的那些：pulse = 1 → 光晕恒为峰值（不动） */
            const ga = PROJ_GLOW_ALPHA * fade * (PROJ_GLOW_FLOOR + (1 - PROJ_GLOW_FLOOR) * pulse);
            const g = ctx.createRadialGradient(offX, offY, 0, offX, offY, Math.max(grx, gry));
            g.addColorStop(0, hexA(spr.glow, ga));
            g.addColorStop(0.55, hexA(spr.glow, ga * 0.4));
            g.addColorStop(1, hexA(spr.glow, 0));
            ctx.globalAlpha = 1;
            ctx.fillStyle = g;
            ctx.beginPath();
            /* 椭圆贴着图的形状：箭是长条、弹是圆球，用圆会把长箭裹成一大团 */
            ctx.ellipse(offX, offY, grx, gry, 0, 0, Math.PI * 2);
            ctx.fill();
          }

          /* ② 图本身；寿命末端整体淡出（那是"快消失了"，不是呼吸） */
          ctx.globalAlpha = fade * artA;
          ctx.drawImage(st.img, offX - len / 2, offY - hgt / 2, len, hgt);
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
    /* 先按 castKind 挑出这一式的那套美术（荣 / 枯），
       后面所有几何量（bowH / anchor / nock / burst）都从这套里读 ——
       两式的画布不同，锚点也不同，混用会让弓飞到球外面去。 */
    const art = pickBowArt(bow, castKind);
    if (!art) return;
    const src = bowStateSrc(art, castP);
    if (!src) return;
    const st = getSticker(src);
    if (!st || !st.ready || st.failed) return;   // 没加载好就干脆不画，别画个方块

    const iw = st.img.naturalWidth || st.img.width;
    const ih = st.img.naturalHeight || st.img.height;
    /* 单位注意：_units 里的 x / y / r 全是**世界单位**（快照已经除过 SCALE），
       画布的整体缩放由外层 transform 负责，所以这里不能乘 SCALE。 */
    const drawH = art.bowH;
    const drawW = drawH * (iw / ih);             // 宽度按原图比例，绝不拉伸
    const axF = art.anchor.x, ayF = art.anchor.y;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(((aimAngle ?? 0) * Math.PI) / 180);   // 0° = 朝 +X
    /* 把图片的**锚点**摆到球心：锚点在这块画布上的位置就是球心的位置。
       两张弓帧（平时 / 拉弓）已由 make-sprites.mjs 对齐到同一块画布，
       所以这里换图不会让弓横跳 —— 原始两张图的画布宽度差 40px。 */
    ctx.drawImage(st.img, -axF * drawW, -ayF * drawH, drawW, drawH);

    /* 五连发：在同一个搭箭节点上，扇形额外排布 4 根箭矢。
       这些箭是**武器的一部分**（不是已经射出去的弹道），
       所以写在弓的局部坐标系里 —— 跟着弓一起转，也就不受陀螺自转影响。
       画在弓图之上、球之下：球仍然盖住握把内侧。 */
    if (castKind === 1 && castP > 0 && castP < 0.999 && art.burst && art.arrow) {
      const at = getSticker(art.arrow);
      if (at && at.ready && !at.failed) {
        const aw = at.img.naturalWidth || at.img.width;
        const ah = at.img.naturalHeight || at.img.height;
        const aLen = (art.arrowLenFrac ?? 0.335) * drawH;
        const aH = aLen * (ah / aw);
        /* 搭箭节点在画布上的位置 → 相对球心的局部坐标 */
        const nlx = (art.nock.x - axF) * drawW;
        const nly = (art.nock.y - ayF) * drawH;
        for (const offDeg of burstOffsetsDeg(art.burst)) {
          const off = (offDeg * Math.PI) / 180;
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

      /* ---------- 见晴的每帧状态（全部来自快照）----------
         ringKind / auxKind = 两面水镜当前的颜色（①③ 各一套循环）；
         flying = 起飞中 → 虚化 + 变大 + 影子。 */
      const ringDef = d[o + 16] || 0;
      const ringBorrow = d[o + 17] || 0;
      const flying = (d[o + 18] || 0) > 0.5;
      const vis = flying ? FLY_SCALE : 1;
      const rv = r * vis;

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

      /* 开华的极光形态：脚下一圈缓慢旋转的光晕 + 一层柔光底，
         说明"这个球已经强化过了"。作者要求"稍微显眼一点"，
         所以把弧的不透明度提了一档，并加了一层径向柔光底
         （原来只有三条很淡的弧，混战时基本看不出来）。 */
      if (bloomed) {
        const t = (snap.f / 60) * 0.7;
        const g = ctx.createRadialGradient(x, y, r * 0.6, x, y, r + 14);
        g.addColorStop(0, `rgba(167,139,250,${BLOOM_GLOW_ALPHA.toFixed(3)})`);
        g.addColorStop(0.55, `rgba(125,211,252,${(BLOOM_GLOW_ALPHA * 0.45).toFixed(3)})`);
        g.addColorStop(1, 'rgba(167,139,250,0)');
        ctx.globalAlpha = 1;
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, r + 14, 0, Math.PI * 2); ctx.fill();
        for (let k = 0; k < 3; k++) {
          ctx.globalAlpha = BLOOM_ARC_ALPHA - k * 0.08;
          ctx.strokeStyle = ['#a78bfa', '#7dd3fc', '#f0abfc'][k];
          ctx.lineWidth = 3.2 - k * 0.5;
          ctx.beginPath();
          ctx.arc(x, y, r + 5 + k * 3.5, t + k * 2.1, t + k * 2.1 + Math.PI * 1.25);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      /* 隐身（折光）：整颗球半透明，并加一圈虚线轮廓，避免"球消失了"的错觉 */
      if (stealth) {
        ctx.globalAlpha = 0.30;
      } else if (flying) {
        /* 起飞："虚化" —— 比隐身浅，但要能看出"她不在这一层" */
        ctx.globalAlpha = FLY_ALPHA;
      }

      /* ---------- 飞行中的影子（近大远小）----------
         画在球的正下方：飞得"高"（视觉放大）时影子更小更淡，
         这样不用真的做 3D 也能读出"她飞起来了"。 */
      if (flying) {
        ctx.save();
        ctx.globalAlpha = FLY_SHADOW_ALPHA;
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.ellipse(x, y + rv * 0.95, rv * 0.78, rv * 0.30, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
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
      /* 起飞时整体放大的是**显示**（rv），判定箱不变 —— 作者要的是"表现为变大" */
      const rr = r * pulse * vis;

      /* 运动拖尾已移除：
         原先用固定透明度的粗线表示速度，形状接近实心矩形，
         容易被误认成界面上的半透明方块。小球本身已经能看出运动方向。 */

      /* 球体：优先用角色贴图（头部圆形贴图，已带 alpha），
         没有贴图或尚未加载完成时回退成纯色圆。
         开华后换用第二张贴图 —— 用快照里的 bloomed 标记判断，
         而不是读单位的实时状态，这样暂停/回放才对得上。 */
      /* ⚠ "虚化"必须在**画球体之前**再设一次：
         上面那几段装饰（队伍环、水镜圈、护盾、长剑）各自会把 globalAlpha
         改回 1 —— 只在块首设一次的话，"没装水镜的见晴起飞时看起来完全不透明"
         （实测就是被这条抓住的：球体那次绘制的 alpha 是 1 而不是 0.55）。 */
      if (flying) ctx.globalAlpha = FLY_ALPHA;
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
        const ih = st.img.naturalHeight || st.img.height;
        const iw = st.img.naturalWidth || st.img.width;
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
      ctx.arc(x, y, rr, 0, Math.PI * 2);
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
      ctx.arc(x, y, rv + 2.6, 0, Math.PI * 2);
      ctx.strokeStyle = tc.main;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.globalAlpha = 1;

      /* ---------- 见晴 · 水镜外圈 ----------
         小球边缘那一圈就是她的形态指示：淡绿 / 淡粉（①）、深蓝紫 / 白（③）。
         ①③ 可以同时装，所以两圈分开画：防守色画外圈，借用色画内侧那圈。
         （作者的原话就是"小球边缘一圈的颜色发生变化"。） */
      if (ringDef || ringBorrow) {
        if (ringDef) {
          ctx.globalAlpha = 0.95;
          ctx.strokeStyle = MIRROR_COLORS[ringDef] || '#ffffff';
          ctx.lineWidth = MIRROR_RING_W;
          ctx.beginPath();
          ctx.arc(x, y, rv + MIRROR_RING_GAP, 0, Math.PI * 2);
          ctx.stroke();
        }
        if (ringBorrow) {
          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = MIRROR_COLORS[ringBorrow] || '#ffffff';
          ctx.lineWidth = MIRROR_RING_W * 0.6;
          ctx.beginPath();
          ctx.arc(x, y, rv + MIRROR_RING_GAP * 0.35, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = flying ? FLY_ALPHA : 1;
      }

      /* ---------- 见晴 · 水镜护盾 ----------
         护盾值走资源条（血条下方那条「水镜护盾」），这里再补一圈柔光，
         不然"有没有盾"只能靠读条。 */
      if (u.resDef && u.resDef.id === 'mirror' && res > 0) {
        const k = Math.max(0, Math.min(1, res / Math.max(1, u.resMax)));
        const g = ctx.createRadialGradient(x, y, rv * 0.7, x, y, rv + 9);
        g.addColorStop(0, `rgba(240,171,252,${(SHIELD_ALPHA * k).toFixed(3)})`);
        g.addColorStop(1, 'rgba(240,171,252,0)');
        ctx.globalAlpha = 1;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, rv + 9, 0, Math.PI * 2);
        ctx.fill();
      }

      /* ---------- 见晴 · 猩红长剑 ----------
         平时：绑在球缘、朝**移动方向**（face）。
         挥动中：**以球心为轴旋转**扫过 sweepDeg（作者要的"长剑有以小球原点
         为轴的旋转动画"）—— 用 swordSwing 事件的时间轴驱动，所以暂停会冻住、
         回放会跟着倒回去。 */
      if (u.swordLen > 0) {
        const swing = this._swordSwingAt(battle, i, snap.f);
        const len = swing ? swing.len : u.swordLen;
        let fa;
        if (swing) {
          /* ease-out：出手快、收尾慢，看起来像"挥"而不是"转" */
          const k = 1 - Math.pow(1 - swing.t, 2.2);
          fa = swing.angle - swing.sweep / 2 + swing.sweep * k;
        } else {
          fa = ((d[o + 6] ?? 0) * Math.PI) / 180;      // face（角度制）
        }
        const x0 = x + Math.cos(fa) * rv;
        const y0 = y + Math.sin(fa) * rv;
        const x1 = x + Math.cos(fa) * (rv + len * vis);
        const y1 = y + Math.sin(fa) * (rv + len * vis);
        ctx.globalAlpha = flying ? 0.75 : 1;
        /* 挥动中把剑画得亮一点、粗一点，让"这一下真的在动"看得出来 */
        ctx.strokeStyle = swing ? '#a52a2a' : SWORD_COLOR;
        ctx.lineWidth = SWORD_W * (swing ? 1.25 : 1);
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        /* 剑刃中间一道更亮的高光，让它看起来是"剑"而不是一根棍 */
        ctx.strokeStyle = swing ? 'rgba(254,202,202,0.95)' : 'rgba(248,113,113,0.85)';
        ctx.lineWidth = SWORD_W * 0.35;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        /* 挥动时再补一道淡淡的残影弧（剑扫过的轨迹） */
        if (swing) {
          ctx.globalAlpha = (flying ? 0.5 : 0.7) * (1 - swing.t);
          ctx.strokeStyle = swing.kind === 'guard' ? '#fecaca' : '#fca5a5';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(x, y, rv + len * vis * 0.92,
            swing.angle - swing.sweep / 2, fa);
          ctx.stroke();
        }
        ctx.lineCap = 'butt';
        ctx.globalAlpha = flying ? FLY_ALPHA : 1;
      }

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

/* ============================================================
   asset-schema.js — 「素材编辑器」能改哪些东西、改在哪一行
   ------------------------------------------------------------
   同一份清单有两个消费者：
     · 编辑页面（js/ui-assets.js）用它生成控件；
     · 本地开发服务器（tools/serve.mjs）用它校验"写回哪个文件的哪一处"。
   共用一份，才不会出现"界面能改、写回去改错地方"。

   每个字段描述的是「**在某个唯一的锚点之后、某个键的值**」：
     anchor —— 必须在本文件里只出现一次的字符串
     key    —— 源码里的键名（写回时找 `键:` 或 `键 =`，配置对象与 const 都支持）
     window —— 锚点之后多少字符内找（默认 80）
     stop   —— 可选：窗口的硬边界（遇到它就停）—— 用于"窗口要开很大"的场合
   写回前会核验「锚点唯一 + 窗口内该键只出现一次」，否则**拒绝写入**并说明原因。
   离线自检：`node tools/check-asset-schema.mjs`（把每个字段都试算一遍）。

   id 与 key 分开：界面上要唯一标识一个控件，而源码里可能有两个同名的键
   （例如小球自己的 r 与贴图裁剪的 r）。 --*/
const F = (id, key, label, extra) => ({ id, key, label, ...extra });

/* 弹道贴图的公共字段：
   尺寸 / 光晕色 / 呼吸开关 / **判定半径** / **贴图相对判定中心的偏移**。
   判定半径原先只显示不改（那是平衡数值），作者后来要求能直接调 ——
   所以放开了，但界面上会明确提醒"会改命中率"。 */
const projFields = (anchor, idPrefix, stop, win) => [
  F(idPrefix + 'Len', 'spriteLen', '尺寸（世界单位：图沿飞行方向画多长）',
    { type: 'number', min: 3, max: 120, step: 0.5, file: 'skills', anchor, stop, window: win }),
  F(idPrefix + 'Glow', 'spriteGlow', '光晕颜色', { type: 'color', file: 'skills', anchor, stop, window: win }),
  F(idPrefix + 'Pulse', 'spritePulse', '透明度呼吸（只有蝙蝠是开的）',
    { type: 'bool', file: 'skills', anchor, stop, window: win }),
  F(idPrefix + 'R', 'r', '判定半径（世界单位；⚠ 改它会改命中率）',
    { type: 'number', min: 1, max: 40, step: 0.5, file: 'skills', anchor, stop, window: win, balance: true }),
  F(idPrefix + 'OffX', 'spriteOffX', '贴图偏移 · 前后（+x = 朝飞行方向）',
    { type: 'number', min: -60, max: 60, step: 0.5, file: 'skills', anchor, stop, window: win }),
  F(idPrefix + 'OffY', 'spriteOffY', '贴图偏移 · 左右（+y = 飞行方向右手侧）',
    { type: 'number', min: -60, max: 60, step: 0.5, file: 'skills', anchor, stop, window: win }),
];

/* 箭矢那一组：长度由弓决定（去「弓」那一组调），
   这里能调的是**判定半径**与**贴图偏移**。
   注意偏移的**源码键名**是 arrowOffX / kuArrowOffX（不是 spriteOffX）——
   它们在 TAOYAO 里是两支箭共用的配置；锚点用它们上面那行注释，
   因为 `arrowOffX` 这个词在发射点也出现过，直接拿它当锚点不唯一。 */
const arrowFields = (rAnchor, offAnchor, offXKey, offYKey, idPrefix) => [
  F(idPrefix + 'R', 'r', '判定半径（世界单位；⚠ 改它会改命中率）',
    { type: 'number', min: 1, max: 40, step: 0.5, file: 'skills', anchor: rAnchor, window: 400, balance: true }),
  F(idPrefix + 'OffX', offXKey, '贴图偏移 · 前后（+x = 朝飞行方向）',
    { type: 'number', min: -60, max: 60, step: 0.5, file: 'skills', anchor: offAnchor, window: 200 }),
  F(idPrefix + 'OffY', offYKey, '贴图偏移 · 左右（+y = 飞行方向右手侧）',
    { type: 'number', min: -60, max: 60, step: 0.5, file: 'skills', anchor: offAnchor, window: 200 }),
];

/* 弓的两式：锚点是美术表里的分隔注释；stop 把窗口关在这一套美术之内，
   否则窗口会伸到隔壁那一式、把它的 bowH 也算进来（那就"不唯一"了）。 */
const RONG = '// ---------- 荣 ----------';
const KU = '// ---------- 枯 ----------';
const bowFields = (anchor, stop, idPrefix) => [
  F(idPrefix + 'BowH', 'bowH', '弓的绘制高度（世界单位）',
    { type: 'number', min: 40, max: 320, step: 2, file: 'balls', anchor, stop, window: 1600 }),
  F(idPrefix + 'ArrowLen', 'arrowLenFrac', '箭长 ÷ 弓高（搭在弓上的箭与飞出去的箭共用）',
    { type: 'number', min: 0.1, max: 0.9, step: 0.005, file: 'balls', anchor, stop, window: 1600 }),
];

/* 小球：半径 + 贴图圆形裁剪。裁剪的 r 与球半径同名，所以 id 分开、key 相同。 */
const ballFields = (species, png, idPrefix) => [
  F(idPrefix + 'R', 'r', '半径（世界单位 = 判定半径）',
    { type: 'number', min: 4, max: 40, step: 0.5, file: 'balls', anchor: `id: '${species}',`, stop: 'sticker', window: 500 }),
  F(idPrefix + 'Cx', 'cx', '裁剪 · 圆心 x', { type: 'number', min: 0, max: 1, step: 0.01, file: 'balls', anchor: png, window: 160 }),
  F(idPrefix + 'Cy', 'cy', '裁剪 · 圆心 y', { type: 'number', min: 0, max: 1, step: 0.01, file: 'balls', anchor: png, window: 160 }),
  F(idPrefix + 'Cr', 'r', '裁剪 · 半径（比例）', { type: 'number', min: 0.05, max: 1, step: 0.01, file: 'balls', anchor: png, window: 160 }),
];

/* ---------- 数值（平衡）----------
   作者 2026-10 的要求：「让我可以实时修改小球的血量、飞行速度、各种技能伤害数值」。

   这一组和上面的贴图/表现参数**性质不同**：改一个数就会改战斗结果，
   所以三条规矩写在最前面：

     1. **每一项都标 ⚠ 平衡数值**（`balance: true`），界面上是橙色的，
        不会和"调个透明度"混在一起；
     2. **不收录"只有测试用的球"**（诊断夹具那几颗：`test` / `test_skill`…）——
        `tests/diag/skill3.mjs` 等守卫把 50 / 200 / 100 这些数写死了，
        "编辑器能改"和"守卫要求不变"会互相打架。要调的是**游戏里真的会出场**的球：
        三个正式角色 + 木桩（木桩只放开生命与碰撞伤害，速度必须恒为 0）。
     3. **不收录比值 / 表达式**（`damageMul: 4 / 3`、`miniDamageMul: 1 / 3`）——
       写回只支持具体数值，把它改成 1.333333 会丢掉"这是三分之四"的语义。

   `nums` 类型是本轮新加的：`dmgByStage: [1, 2]` 这种一维数字数组也要能改
   （裁光的两档接触伤害）。写法是 `[1, 2]`，界面上编辑成 `1, 2`。 */
const N = (id, key, label, opts) => F(id, key, label, { type: 'number', file: 'balls', balance: true, ...opts });
const SN = (id, key, label, opts) => F(id, key, label, { type: 'number', file: 'skills', balance: true, ...opts });

/** 预制的"取值器"：**每个技能对象一行**。 *
 *  编辑器显示现值时要拿到内存里那个真实对象（`YUNCAI.modan.dmg`），
 *  而字段的 key 只有 `dmg` 这么短 —— 光靠 id/key 推不出它属于哪个技能。
 *  所以字段上带一个 `pick`（点分路径），由编辑器解析。
 *
 *  为什么不做成"编辑器里手写一张映射表"：上一轮加开华常量时，正是
 *  手写清单忘登记 → 界面显示成一片空白框（README 第 42 条）。
 *  写成数据还有一个好处：**能被自检核对** ——
 *  check-asset-schema.mjs 会逐个验证每个 pick 路径真的取得到值。 */
const P = (pick) => (id, key, label, opts) => SN(id, key, label, { pick, ...opts });
const cgP = P('YUNCAI.caiguang'), mdP = P('YUNCAI.modan'), zgP = P('YUNCAI.zheguang');
const khP = P('YUNCAI.kaihua'), prP = P('YUNCAI.prism'), dmP = P('YUNCAI.domain'), xgP = P('YUNCAI.xiguang');
const rgP = P('TAOYAO.rong'), kuP = P('TAOYAO.ku'), aimP = P('TAOYAO.aim');
const cjP = P('TAOYAO.chunjing'), topP = P('TAOYAO.top');
const skP = P('TINA.suck'), btP = P('TINA.bat'), shP = P('TINA.shot'), scP = P('TINA.scepter'), p3P = P('TINA.p3');
/* 见晴：六个技能各是 JIANQING 下的一个子块 */
const jqDef = P('JIANQING.mirrorDef'), jqSw = P('JIANQING.mirrorSword'), jqBo = P('JIANQING.mirrorBorrow');
const jqTk = P('JIANQING.takeoff'), jqTr = P('JIANQING.transform'), jqFt = P('JIANQING.feather');

/* 球种的基础数值：锚点是该球种的 `id: 'xxx',`（balls.js 里唯一），
   stop 卡在 `desc:` —— 再往后就是 sticker / domain，那些 `r` 之类的键会撞车。 */
const statFields = (species, p) => [
  N(p + 'Hp', 'hp', '生命上限', { min: 1, max: 20000, step: 50, pick: `SPECIES_BY_ID.${species}`, anchor: `id: '${species}',`, stop: 'desc:', window: 700 }),
  N(p + 'Speed', 'speed', '移动速度（世界单位/秒）', { min: 10, max: 900, step: 5, pick: `SPECIES_BY_ID.${species}`, anchor: `id: '${species}',`, stop: 'desc:', window: 700 }),
  N(p + 'Melee', 'melee', '碰撞伤害（每次撞击）', { min: 0, max: 500, step: 5, pick: `SPECIES_BY_ID.${species}`, anchor: `id: '${species}',`, stop: 'desc:', window: 700 }),
];

export const ASSET_GROUPS = [
  {
    id: 'projectiles',
    name: '弹道贴图',
    hint: '箭矢 / 蝙蝠 / 能量弹。"尺寸"是**图沿飞行方向画多长**；判定半径写在技能参数里（属于平衡数值，这里只显示不改）。',
    items: [
      {
        id: 'yuncai_bolt', name: '晕彩 · 魔弹', src: 'assets/characters/yuncai_bolt.png', kind: 'proj',
        note: '判定半径 YUNCAI.modan.r = 6（直径 12）',
        fields: projFields('/* ② 魔弹 */', 'yuncai', '/* ③ 折光 */', 2200)
      },
      {
        id: 'tina_bolt', name: '缇娜 · 魔力霰弹', src: 'assets/characters/tina_bolt.png', kind: 'proj',
        note: '判定半径 TINA.shot.r = 5（直径 10）',
        fields: projFields('/* ③ 魔力霰弹 */', 'tinaShot', '/* ④ 权杖（被动） */', 2200)
      },
      {
        id: 'tina_bat', name: '缇娜 · 蝙蝠', src: 'assets/characters/tina_bat.png', kind: 'proj',
        note: '判定半径 TINA.bat.r = 5（直径 10）',
        fields: projFields('/* ② 蝙蝠 */', 'tinaBat', '/* ③ 魔力霰弹 */', 2200)
      },
      {
        id: 'taoyao_arrow', name: '桃夭 · 映霞[荣] 箭矢', src: 'assets/characters/taoyao_arrow.png', kind: 'proj',
        note: '长度由弓决定（弓高 × 箭长比例），想改长度去「弓」那一组 —— ' +
          '两边必须一致，否则搭在弓上的箭和射出去的箭不一样长。',
        fields: [
          F('rongArrowSprite', 'arrowSprite', '贴图路径', { type: 'text', file: 'skills', anchor: 'arrowSprite:' }),
          F('rongArrowGlow', 'arrowGlow', '光晕颜色', { type: 'color', file: 'skills', anchor: 'arrowGlow:' }),
          F('rongArrowPulse', 'arrowPulse', '透明度呼吸', { type: 'bool', file: 'skills', anchor: 'arrowPulse:' }),
          ...arrowFields('rong: {', '/* 箭矢贴图相对判定中心的偏移', 'arrowOffX', 'arrowOffY', 'rongArrow'),
        ]
      },
      {
        id: 'taoyao_ku_arrow', name: '桃夭 · 映霞[枯] 箭矢', src: 'assets/characters/taoyao_ku_arrow.png', kind: 'proj',
        fields: [
          F('kuArrowSprite', 'kuArrowSprite', '贴图路径', { type: 'text', file: 'skills', anchor: 'kuArrowSprite:' }),
          F('kuArrowGlow', 'kuArrowGlow', '光晕颜色', { type: 'color', file: 'skills', anchor: 'kuArrowGlow:' }),
          F('kuArrowPulse', 'kuArrowPulse', '透明度呼吸', { type: 'bool', file: 'skills', anchor: 'kuArrowPulse:' }),
          ...arrowFields('ku: {', 'kuArrowPulse: false,', 'kuArrowOffX', 'kuArrowOffY', 'kuArrow'),
        ]
      },
    ]
  },
  {
    id: 'bows',
    name: '手持物件（弓）',
    hint: '⚠ 锚点 / 搭箭点 / 箭长这几个数**由 tools/make-sprites.mjs 量出来**。' +
      '手改之后不要再跑构建，否则会被覆盖 —— 构建工具才是权威。',
    items: [
      { id: 'taoyao_bow', name: '桃夭 · 映霞[荣]', src: 'assets/characters/taoyao_bow_draw.png', kind: 'bow', anchor: RONG, fields: bowFields(RONG, KU, 'rong') },
      { id: 'taoyao_ku_bow', name: '桃夭 · 映霞[枯]', src: 'assets/characters/taoyao_ku_bow_draw.png', kind: 'bow', anchor: KU, fields: bowFields(KU, '],', 'ku') },
    ]
  },
  {
    id: 'balls',
    name: '小球贴图与尺寸',
    hint: '小球的**显示半径就是判定半径**（项目规矩：看到的多大，判定就多大）。裁剪决定"圆形头像取原图的哪一块"。',
    items: [
      { id: 'yuncai_ball', name: '晕彩', src: 'assets/characters/yuncai_ball.png', kind: 'ball', species: 'yuncai', fields: ballFields('yuncai', 'yuncai_ball.png', 'yuncaiBall') },
      { id: 'taoyao_ball', name: '桃夭', src: 'assets/characters/taoyao_ball.png', kind: 'ball', species: 'taoyao', fields: ballFields('taoyao', 'taoyao_ball.png', 'taoyaoBall') },
      { id: 'tina_ball', name: '缇娜', src: 'assets/characters/tina_ball.png', kind: 'ball', species: 'tina', fields: ballFields('tina', 'tina_ball.png', 'tinaBall') },
      { id: 'jianqing_ball', name: '见晴', src: 'assets/characters/jianqing_ball.png', kind: 'ball', species: 'jianqing', fields: ballFields('jianqing', 'jianqing_ball.png', 'jianqingBall') },
    ]
  },
  {
    id: 'domain',
    name: '辉光领域（背景层）',
    hint: '晕彩的领域展开：铺满后的透明度、气浪扫过的时间与背景滚动速度。',
    items: [
      {
        id: 'yuncai_domain', name: '晕彩 · 辉光领域', src: 'assets/characters/yuncai_aurora.jpg', kind: 'domain',
        fields: [
          F('domOpacity', 'opacity', '铺满后的不透明度', { type: 'number', min: 0, max: 1, step: 0.02, file: 'balls', anchor: 'domain: {', window: 600 }),
          F('domReveal', 'revealSeconds', '气浪扫过全场的时间（秒）', { type: 'number', min: 0.2, max: 5, step: 0.1, file: 'balls', anchor: 'domain: {', window: 600 }),
          F('domScroll', 'scrollUnitsPerSec', '背景滚动速度（世界单位/秒）', { type: 'number', min: 0, max: 40, step: 0.5, file: 'balls', anchor: 'domain: {', window: 600 }),
        ]
      },
    ]
  },
  {
    id: 'globals',
    name: '通用表现参数（全局）',
    hint: '改一处，所有贴图弹道 / 所有光柱一起变。',
    items: [
      {
        id: 'globals', name: '贴图弹道与光柱', kind: 'globals',
        fields: [
          F('gGlowA', 'PROJ_GLOW_ALPHA', '光晕峰值不透明度', { type: 'number', min: 0, max: 0.9, step: 0.01, file: 'render', anchor: 'const PROJ_GLOW_ALPHA' }),
          F('gGlowRx', 'PROJ_GLOW_RX', '光晕半长轴 ÷ 图长', { type: 'number', min: 0.2, max: 1.5, step: 0.01, file: 'render', anchor: 'const PROJ_GLOW_RX' }),
          F('gGlowRy', 'PROJ_GLOW_RY', '光晕半短轴 ÷ 图高', { type: 'number', min: 0.2, max: 1.5, step: 0.01, file: 'render', anchor: 'const PROJ_GLOW_RY' }),
          F('gGlowFloor', 'PROJ_GLOW_FLOOR', '呼吸时光晕暗到峰值的比例', { type: 'number', min: 0, max: 1, step: 0.05, file: 'render', anchor: 'const PROJ_GLOW_FLOOR' }),
          F('gAlphaMin', 'PROJ_ALPHA_MIN', '呼吸下限（透明度）', { type: 'number', min: 0, max: 1, step: 0.01, file: 'render', anchor: 'const PROJ_ALPHA_MIN' }),
          F('gAlphaMax', 'PROJ_ALPHA_MAX', '呼吸上限（透明度）', { type: 'number', min: 0, max: 1, step: 0.01, file: 'render', anchor: 'const PROJ_ALPHA_MAX' }),
          F('gPulseHz', 'PROJ_PULSE_HZ', '呼吸频率（次/秒）', { type: 'number', min: 0.1, max: 6, step: 0.1, file: 'render', anchor: 'const PROJ_PULSE_HZ' }),
          F('gBeamA', 'BEAM_ALPHA', '光柱本体不透明度', { type: 'number', min: 0, max: 1, step: 0.01, file: 'render', anchor: 'const BEAM_ALPHA' }),
        ]
      },
      {
        id: 'bloomfx', name: '开华特效与屏幕抖动', kind: 'globals',
        note: '开华（晕彩的形态强化）那一下的爆发与镜头抖动。改完看预览：node tools/preview-bloom.mjs',
        fields: [
          F('bRingA', 'BLOOM_RING_ALPHA', '三层光环的基准不透明度', { type: 'number', min: 0, max: 1, step: 0.05, file: 'render', anchor: 'const BLOOM_RING_ALPHA' }),
          F('bRingW', 'BLOOM_RING_WIDTH', '最内层光环的线宽（世界单位）', { type: 'number', min: 1, max: 20, step: 0.5, file: 'render', anchor: 'const BLOOM_RING_WIDTH' }),
          F('bFlash', 'BLOOM_FLASH_ALPHA', '中心闪光的峰值不透明度', { type: 'number', min: 0, max: 1, step: 0.05, file: 'render', anchor: 'const BLOOM_FLASH_ALPHA' }),
          F('bGlow', 'BLOOM_GLOW_ALPHA', '开华后脚下常驻柔光强度', { type: 'number', min: 0, max: 1, step: 0.02, file: 'render', anchor: 'const BLOOM_GLOW_ALPHA' }),
          F('bArc', 'BLOOM_ARC_ALPHA', '常驻旋转弧的基准不透明度', { type: 'number', min: 0, max: 1, step: 0.02, file: 'render', anchor: 'const BLOOM_ARC_ALPHA' }),
          F('bLife', 'BLOOM_LIFE', '爆发持续帧数（60 帧 = 1 秒）', { type: 'number', min: 8, max: 120, step: 1, file: 'render', anchor: 'const BLOOM_LIFE' }),
          F('sMax', 'SHAKE_MAX', '屏幕抖动最大位移（世界单位）', { type: 'number', min: 0, max: 20, step: 0.2, file: 'render', anchor: 'const SHAKE_MAX' }),
          F('sFrames', 'SHAKE_FRAMES', '抖动持续帧数', { type: 'number', min: 2, max: 90, step: 1, file: 'render', anchor: 'const SHAKE_FRAMES' }),
          F('sHz', 'SHAKE_HZ', '抖动频率（来回/秒）', { type: 'number', min: 2, max: 40, step: 1, file: 'render', anchor: 'const SHAKE_HZ' }),
        ]
      },
    ]
  },
  {
    id: 'hud',
    name: '界面文字',
    hint: '打中时飘出来的数字、血条上的数字。改这里不影响任何战斗数值。',
    items: [
      {
        id: 'dmgtext', name: '伤害飘字', kind: 'globals',
        note: '打中时飘出来的红色伤害数字（作者要求：更大更粗、显眼的红色）。预览里直接画三档伤害的样本。',
        fields: [
          F('dmgPx', 'DMG_FONT_PX', '基准字号（像素）', { type: 'number', min: 8, max: 48, step: 1, file: 'render', anchor: 'const DMG_FONT_PX' }),
          F('dmgWeight', 'DMG_WEIGHT', '字体粗细（100~900）', { type: 'number', min: 100, max: 900, step: 100, file: 'render', anchor: 'const DMG_WEIGHT' }),
          F('dmgColor', 'DMG_COLOR', '填充色（显眼红）', { type: 'color', file: 'render', anchor: 'const DMG_COLOR' }),
          F('dmgOutline', 'DMG_OUTLINE', '描边色（浅色，压在球面上才不糊）', { type: 'color', file: 'render', anchor: 'const DMG_OUTLINE =' }),
          F('dmgOutlineW', 'DMG_OUTLINE_W', '描边宽度（0 = 不描边）', { type: 'number', min: 0, max: 12, step: 0.2, file: 'render', anchor: 'const DMG_OUTLINE_W' }),
          F('dmgGain', 'DMG_SIZE_GAIN', '伤害越高字越大的幅度（0 = 统一字号）', { type: 'number', min: 0, max: 1.5, step: 0.05, file: 'render', anchor: 'const DMG_SIZE_GAIN' }),
          F('dmgRise', 'DMG_RISE', '飘字上升距离（世界单位）', { type: 'number', min: 0, max: 80, step: 1, file: 'render', anchor: 'const DMG_RISE' }),
          F('dmgPop', 'DMG_POP', '出现瞬间的放大倍数（1 = 不放大）', { type: 'number', min: 1, max: 2.5, step: 0.05, file: 'render', anchor: 'const DMG_POP =' }),
          F('dmgPopF', 'DMG_POP_FRAMES', '放大用几帧收回（帧）', { type: 'number', min: 1, max: 40, step: 1, file: 'render', anchor: 'const DMG_POP_FRAMES' }),
        ]
      },
    ]
  },
  {
    id: 'balance',
    name: '数值（平衡）',
    hint: '⚠ 这一组**会直接改战斗结果**（生命 / 速度 / 伤害），和上面调贴图那几组不是一回事。' +
      '改完保存 → 已打开的游戏页会弹一条「素材已更新 · 点击刷新」，点一下新数值就生效（引擎在页面加载时读一次配置，必须刷新）。' +
      '预览里会**实时**算出派生结果：能挨几下、每秒打多少、打空一个 1500 血目标要几秒。',
    items: [
      {
        id: 'stat_yuncai', name: '晕彩 · 基础数值', kind: 'balance',
        note: '晕彩本体没有碰撞伤害（0），输出全靠技能；折光会把碰撞伤害改成 100、开华再 +50。',
        fields: statFields('yuncai', 'yc'),
      },
      {
        id: 'stat_taoyao', name: '桃夭 · 基础数值', kind: 'balance',
        note: '桃夭靠箭矢输出、靠春景与认真拉矢续航，碰撞伤害 66 是她的兜底输出。',
        fields: statFields('taoyao', 'ty'),
      },
      {
        id: 'stat_tina', name: '缇娜 · 基础数值', kind: 'balance',
        note: '缇娜血量与晕彩一样（1500），速度略快、碰撞伤害 50；权杖会让碰撞伤害 +15。',
        fields: statFields('tina', 'tn'),
      },
      {
        id: 'stat_jianqing', name: '见晴 · 基础数值', kind: 'balance',
        note: '魔法少女[白水仙]：血量 1500 / 速度 120 / 碰撞伤害 30 / 标准体型（r = 16）。',
        fields: statFields('jianqing', 'jq'),
      },
      {
        id: 'numJianqingSkill', name: '见晴 · 技能数值', kind: 'balance',
        note: '三面水镜（防御 / 长剑 / 借来的魔弹与激光）+ 起飞 + 精灵变身 + 羽毛。' +
          '⚠ ①②③ 是三个独立技能，各有自己的冷却与颜色循环；改这里只影响见晴。',
        fields: [
          /* ① 水镜·魔力共鸣（防御） */
          jqDef('jqCycle', 'cycle', '①水镜（防御）· 切色间隔（秒）', { min: 0.5, max: 30, step: 0.5, anchor: '/* ① 水镜·魔力共鸣（防御） */', window: 900, stop: '/* ② 水镜·魔力共鸣（猩红色） */' }),
          jqDef('jqHeal', 'healPerSec', '①淡绿 · 每秒回血', { min: 0, max: 500, step: 1, anchor: '/* ① 水镜·魔力共鸣（防御） */', window: 900, stop: '/* ② 水镜·魔力共鸣（猩红色） */' }),
          jqDef('jqMeleeBonus', 'meleeBonus', '①淡粉 · 碰撞伤害加成', { min: 0, max: 500, step: 1, anchor: '/* ① 水镜·魔力共鸣（防御） */', window: 900, stop: '/* ② 水镜·魔力共鸣（猩红色） */' }),
          jqDef('jqShieldGain', 'shieldPerSec', '①淡粉 · 每秒护盾', { min: 0, max: 500, step: 1, anchor: '/* ① 水镜·魔力共鸣（防御） */', window: 900, stop: '/* ② 水镜·魔力共鸣（猩红色） */' }),
          jqDef('jqShieldMax', 'shieldMax', '①护盾上限', { min: 0, max: 5000, step: 25, anchor: '/* ① 水镜·魔力共鸣（防御） */', window: 900, stop: '/* ② 水镜·魔力共鸣（猩红色） */' }),
          jqDef('jqShieldDecay', 'shieldDecayPerSec', '①非淡粉 · 护盾每秒衰减', { min: 0, max: 200, step: 1, anchor: '/* ① 水镜·魔力共鸣（防御） */', window: 900, stop: '/* ② 水镜·魔力共鸣（猩红色） */' }),
          /* ② 水镜·魔力共鸣（猩红色） */
          jqSw('jqSwordSpeed', 'speedBonus', '②长剑 · 移速加成', { min: 0, max: 300, step: 1, anchor: '/* ② 水镜·魔力共鸣（猩红色） */', window: 900, stop: '/* ③ 水镜·魔力共鸣（深蓝紫色和白色） */' }),
          jqSw('jqSwordLen', 'swordLen', '②长剑 · 长度（= 小球直径）', { min: 0, max: 200, step: 1, anchor: '/* ② 水镜·魔力共鸣（猩红色） */', window: 900, stop: '/* ③ 水镜·魔力共鸣（深蓝紫色和白色） */' }),
          jqSw('jqSwordFront', 'frontDeg', '②长剑 · 前方扇形角度', { min: 10, max: 360, step: 5, anchor: '/* ② 水镜·魔力共鸣（猩红色） */', window: 900, stop: '/* ③ 水镜·魔力共鸣（深蓝紫色和白色） */' }),
          jqSw('jqSwordDmg', 'dmg', '②长剑 · 挥动伤害', { min: 0, max: 2000, step: 5, anchor: '/* ② 水镜·魔力共鸣（猩红色） */', window: 900, stop: '/* ③ 水镜·魔力共鸣（深蓝紫色和白色） */' }),
          jqSw('jqSwordAtkCd', 'atkInterval', '②长剑 · 攻击性挥动间隔（秒）', { min: 0.1, max: 20, step: 0.1, anchor: '/* ② 水镜·魔力共鸣（猩红色） */', window: 900, stop: '/* ③ 水镜·魔力共鸣（深蓝紫色和白色） */' }),
          jqSw('jqSwordDefCd', 'defInterval', '②长剑 · 防御性挥动间隔（秒）', { min: 0.5, max: 30, step: 0.5, anchor: '/* ② 水镜·魔力共鸣（猩红色） */', window: 900, stop: '/* ③ 水镜·魔力共鸣（深蓝紫色和白色） */' }),
          jqSw('jqSwordPurge', 'purgeMax', '②长剑 · 一次最多消除几个魔弹', { min: 1, max: 12, step: 1, anchor: '/* ② 水镜·魔力共鸣（猩红色） */', window: 900, stop: '/* ③ 水镜·魔力共鸣（深蓝紫色和白色） */' }),
          /* ③ 水镜·魔力共鸣（深蓝紫色和白色） */
          jqBo('jqBorrowCycle', 'cycle', '③水镜（借用）· 切色间隔（秒）', { min: 0.5, max: 60, step: 0.5, anchor: '/* ③ 水镜·魔力共鸣（深蓝紫色和白色） */', window: 1400, stop: '/* ④ 起飞 */' }),
          jqBo('jqModanCd', 'modanCd', '③深蓝紫 · 魔弹间隔（秒）', { min: 0.2, max: 30, step: 0.1, anchor: '/* ③ 水镜·魔力共鸣（深蓝紫色和白色） */', window: 1400, stop: '/* ④ 起飞 */' }),
          jqBo('jqModanDmg', 'modanDmg', '③深蓝紫 · 魔弹伤害', { min: 0, max: 2000, step: 5, anchor: '/* ③ 水镜·魔力共鸣（深蓝紫色和白色） */', window: 1400, stop: '/* ④ 起飞 */' }),
          jqBo('jqModanSpeed', 'modanSpeed', '③深蓝紫 · 魔弹弹速', { min: 50, max: 3000, step: 10, anchor: '/* ③ 水镜·魔力共鸣（深蓝紫色和白色） */', window: 1400, stop: '/* ④ 起飞 */' }),
          jqBo('jqLaserCd', 'laserCd', '③白色 · 激光间隔（秒）', { min: 0.2, max: 30, step: 0.1, anchor: '/* ③ 水镜·魔力共鸣（深蓝紫色和白色） */', window: 1400, stop: '/* ④ 起飞 */' }),
          jqBo('jqLaserDmg', 'laserDmg', '③白色 · 激光伤害', { min: 0, max: 3000, step: 10, anchor: '/* ③ 水镜·魔力共鸣（深蓝紫色和白色） */', window: 1400, stop: '/* ④ 起飞 */' }),
          jqBo('jqLaserLife', 'laserLife', '③白色 · 激光持续（秒）', { min: 0.05, max: 5, step: 0.05, anchor: '/* ③ 水镜·魔力共鸣（深蓝紫色和白色） */', window: 1400, stop: '/* ④ 起飞 */' }),
          jqBo('jqLaserWidth', 'laserWidth', '③白色 · 激光粗细', { min: 2, max: 120, step: 1, anchor: '/* ③ 水镜·魔力共鸣（深蓝紫色和白色） */', window: 1400, stop: '/* ④ 起飞 */' }),
          /* ④ 起飞 */
          jqTk('jqFlyDist', 'distance', '④起飞 · 触发距离（世界单位）', { min: 100, max: 20000, step: 60, anchor: '/* ④ 起飞 */', window: 1400, stop: '/* ⑤ 精灵变身（装备即生效，作者确认） */' }),
          jqTk('jqFlySec', 'seconds', '④起飞 · 滞空时间（秒）', { min: 0.5, max: 20, step: 0.5, anchor: '/* ④ 起飞 */', window: 1400, stop: '/* ⑤ 精灵变身（装备即生效，作者确认） */' }),
          jqTk('jqFlySpeed', 'speedBonus', '④起飞 · 空中移速加成', { min: 0, max: 600, step: 5, anchor: '/* ④ 起飞 */', window: 1400, stop: '/* ⑤ 精灵变身（装备即生效，作者确认） */' }),
          jqTk('jqFlyDmg', 'frameDamage', '④起飞 · 空中每帧伤害', { min: 0, max: 200, step: 1, anchor: '/* ④ 起飞 */', window: 1400, stop: '/* ⑤ 精灵变身（装备即生效，作者确认） */' }),
          jqTk('jqFlyTake', 'damageTakenMul', '④起飞 · 空中受到的伤害倍率（0.5 = 减半）', { min: 0, max: 1, step: 0.05, anchor: '/* ④ 起飞 */', window: 1400, stop: '/* ⑤ 精灵变身（装备即生效，作者确认） */' }),
          jqTk('jqFlyTurn', 'turnPerSec', '④起飞 · 追踪转速上限（度/秒）', { min: 0, max: 720, step: 5, anchor: '/* ④ 起飞 */', window: 1400, stop: '/* ⑤ 精灵变身（装备即生效，作者确认） */' }),
          jqTk('jqFlyHoming', 'wallHoming', '④起飞 · 撞墙后朝最近的敌人（关掉就是普通反弹）',
            { type: 'bool', file: 'skills', balance: true, pick: 'JIANQING.takeoff', anchor: '/* ④ 起飞 */', window: 1400, stop: '/* ⑤ 精灵变身（装备即生效，作者确认） */' }),
          jqTk('jqFlySpeedStep', 'speedPerFlight', '④起飞 · 每飞完一次移速永久 +N', { min: 0, max: 50, step: 1, anchor: '/* ④ 起飞 */', window: 1400, stop: '/* ⑤ 精灵变身（装备即生效，作者确认） */' }),
          jqTk('jqFlyDmgStep', 'frameDamagePerFlight', '④起飞 · 每飞完一次帧伤 +N（可叠加）', { min: 0, max: 5, step: 0.1, anchor: '/* ④ 起飞 */', window: 1400, stop: '/* ⑤ 精灵变身（装备即生效，作者确认） */' }),
          /* ⑤ 精灵变身 */
          jqTr('jqSizeMul', 'sizeMul', '⑤变身 · 体型倍率', { min: 0.2, max: 1.5, step: 0.05, anchor: '/* ⑤ 精灵变身（装备即生效，作者确认） */', window: 600, stop: '/* ⑥ 我很可爱 */' }),
          jqTr('jqTrSpeed', 'speedBonus', '⑤变身 · 移速加成', { min: 0, max: 400, step: 5, anchor: '/* ⑤ 精灵变身（装备即生效，作者确认） */', window: 600, stop: '/* ⑥ 我很可爱 */' }),
          jqTr('jqTrDmgMul', 'damageMul', '⑤变身 · 伤害倍率', { min: 0.1, max: 2, step: 0.05, anchor: '/* ⑤ 精灵变身（装备即生效，作者确认） */', window: 600, stop: '/* ⑥ 我很可爱 */' }),
          jqTr('jqTrSwordMul', 'swordMul', '⑤变身 · 长剑长度倍率', { min: 0.1, max: 2, step: 0.05, anchor: '/* ⑤ 精灵变身（装备即生效，作者确认） */', window: 600, stop: '/* ⑥ 我很可爱 */' }),
          /* ⑥ 我很可爱 */
          jqFt('jqFeatherStep', 'hpStep', '⑥羽毛 · 每掉多少血发一根', { min: 10, max: 5000, step: 10, anchor: '/* ⑥ 我很可爱 */', window: 900, stop: 'export const SKILL_MIRROR_DEF' }),
          jqFt('jqFeatherSpeed', 'speed', '⑥羽毛 · 速度', { min: 20, max: 1500, step: 10, anchor: '/* ⑥ 我很可爱 */', window: 900, stop: 'export const SKILL_MIRROR_DEF' }),
          jqFt('jqFeatherTurn', 'turnPerSec', '⑥羽毛 · 追踪转速（度/秒）', { min: 0, max: 720, step: 10, anchor: '/* ⑥ 我很可爱 */', window: 900, stop: 'export const SKILL_MIRROR_DEF' }),
          jqFt('jqFeatherBounce', 'bounces', '⑥羽毛 · 可反弹次数', { min: 0, max: 20, step: 1, anchor: '/* ⑥ 我很可爱 */', window: 900, stop: 'export const SKILL_MIRROR_DEF' }),
          jqFt('jqFeatherSlowSec', 'slowSeconds', '⑥羽毛 · 移速减半持续（秒）', { min: 0, max: 30, step: 0.5, anchor: '/* ⑥ 我很可爱 */', window: 900, stop: 'export const SKILL_MIRROR_DEF' }),
          jqFt('jqFeatherSlowMul', 'slowMul', '⑥羽毛 · 移速倍率', { min: 0.1, max: 1, step: 0.05, anchor: '/* ⑥ 我很可爱 */', window: 900, stop: 'export const SKILL_MIRROR_DEF' }),
          jqFt('jqFeatherMelee', 'meleeMinus', '⑥羽毛 · 每次碰撞伤害 -N', { min: 0, max: 100, step: 1, anchor: '/* ⑥ 我很可爱 */', window: 900, stop: 'export const SKILL_MIRROR_DEF' }),
          jqFt('jqFeatherSkill', 'skillMinus', '⑥羽毛 · 每次技能伤害 -N', { min: 0, max: 100, step: 1, anchor: '/* ⑥ 我很可爱 */', window: 900, stop: 'export const SKILL_MIRROR_DEF' }),
        ]
      },
      {
        id: 'stat_dummy', name: '木桩 · 基础数值', kind: 'balance',        note: '演示用的靶子。**只有生命与碰撞伤害可调**：速度恒定为 0 是它的用途本身' +
          '（引擎还按 immovable 处理，撞也撞不动），所以故意不给速度旋钮。',
        fields: [
          /* 只挑两个字段：dummy 的 speed 必须保持 0，给个滑条反而容易被拖坏。
             锚点同样是 `id: 'dummy',`，stop 卡在 desc:。 */
          N('dmHp', 'hp', '生命上限（挨得住一整套演示）', {
            min: 1, max: 50000, step: 100, pick: 'SPECIES_BY_ID.dummy',
            anchor: "id: 'dummy',", stop: 'desc:', window: 700,
          }),
          N('dmMelee', 'melee', '碰撞伤害（每次撞击）', {
            min: 0, max: 500, step: 5, pick: 'SPECIES_BY_ID.dummy',
            anchor: "id: 'dummy',", stop: 'desc:', window: 700,
          }),
        ],
      },
      {
        id: 'numYuncaiSkill', name: '晕彩 · 技能数值', kind: 'balance',
        note: '七个技能的伤害与弹速。裁光的接触伤害是**每帧**结算（60 帧 = 1 秒），预览里会把每秒值也列出来。',
        fields: [
          F('cgDmg', 'dmgByStage', '裁光 · 每帧接触伤害（两档）', {
            type: 'nums', file: 'skills', balance: true, pick: 'YUNCAI.caiguang',
            anchor: '/* ① 裁光 */', window: 400, min: 0, max: 200, step: 1,
          }),
          cgP('cgBoom', 'boom', '裁光 · 微光爆炸伤害', { min: 0, max: 3000, step: 10, anchor: '/* ① 裁光 */', window: 400 }),
          mdP('mdCd', 'cd', '魔弹 · 冷却（秒）', { min: 0.1, max: 20, step: 0.1, anchor: '/* ② 魔弹 */', window: 80 }),
          mdP('mdDmg', 'dmg', '魔弹 · 单发伤害', { min: 0, max: 2000, step: 5, anchor: '/* ② 魔弹 */', window: 80 }),
          mdP('mdSpeed', 'speed', '魔弹 · 弹速（世界单位/秒）', { min: 50, max: 3000, step: 10, anchor: '/* ② 魔弹 */', window: 80 }),
          /* ⚠ 锚点里**不能带那个会被改的值**：写回之后锚点自己就消失了，
             再定位（往返校验）会报"锚点找不到" —— 实测踩到两次
             （`laserDmg: 150,`、`tickPerSec: 3,`）。所以只用注释/键名做锚点。 */
          mdP('mdLaserDmg', 'laserDmg', '魔弹 · 第三发光柱伤害', { min: 0, max: 3000, step: 10, anchor: '/* 光效环绕的颜色（画在贴图下面的一层半透明光晕）。', window: 600 }),
          mdP('mdLaserSpeed', 'laserSpeed', '魔弹 · 光柱速度（只剩方向含义）', { min: 50, max: 5000, step: 10, anchor: '/* 光效环绕的颜色（画在贴图下面的一层半透明光晕）。', window: 600 }),
          zgP('zgMelee', 'melee', '折光 · 碰撞伤害（本体本来是 0）', { min: 0, max: 500, step: 5, anchor: '/* ③ 折光 */', window: 80 }),
          khP('khHeal', 'heal', '开华 · 回血', { min: 0, max: 3000, step: 10, anchor: '/* ④ 开华 */', window: 260 }),
          khP('khSpeed', 'speed', '开华 · 移动速度', { min: 10, max: 900, step: 5, anchor: '/* ④ 开华 */', window: 260 }),
          khP('khLight', 'lightBonus', '开华 · 光系伤害加成', { min: 0, max: 1000, step: 5, anchor: '/* ④ 开华 */', window: 260 }),
          khP('khMelee', 'meleeBonus', '开华 · 碰撞伤害加成', { min: 0, max: 1000, step: 5, anchor: '/* ④ 开华 */', window: 260 }),
          prP('prCd', 'cd', '棱镜 · 冷却（秒）', { min: 0.1, max: 20, step: 0.1, anchor: '/* ⑤ 棱镜 */', window: 300 }),
          prP('prCannonDmg', 'cannonDmg', '棱镜 · 光炮伤害', { min: 0, max: 3000, step: 10, anchor: '/* ⑤ 棱镜 */', window: 300 }),
          prP('prCannonSpeed', 'cannonSpeed', '棱镜 · 光炮弹速', { min: 50, max: 3000, step: 10, anchor: '/* ⑤ 棱镜 */', window: 300 }),
          prP('prLaserDmg', 'laserDmg', '棱镜 · 分裂激光伤害', { min: 0, max: 3000, step: 5, anchor: '/* ⑤ 棱镜 */', window: 300 }),
          prP('prLaserSpeed', 'laserSpeed', '棱镜 · 分裂激光弹速', { min: 50, max: 3000, step: 10, anchor: '/* ⑤ 棱镜 */', window: 300 }),
          prP('prShardDmg', 'shardDmg', '棱镜 · 碎片伤害', { min: 0, max: 3000, step: 5, anchor: '/* ⑤ 棱镜 */', window: 300 }),
          prP('prShardSpeed', 'shardSpeed', '棱镜 · 碎片弹速', { min: 50, max: 3000, step: 10, anchor: '/* ⑤ 棱镜 */', window: 300 }),
          xgP('xgCd', 'cd', '析光 · 冷却（秒）', { min: 1, max: 60, step: 1, anchor: '/* ⑦ 析光 */', window: 250 }),
          xgP('xgMiniHp', 'miniHp', '析光 · 分身生命', { min: 1, max: 5000, step: 25, anchor: '/* ⑦ 析光 */', window: 250 }),
          xgP('xgMiniSpeed', 'miniSpeed', '析光 · 分身速度', { min: 10, max: 900, step: 5, anchor: '/* ⑦ 析光 */', window: 250 }),
          dmP('dmDodge', 'dodge', '辉光领域 · 闪避率（开华前）', { min: 0, max: 0.9, step: 0.01, anchor: '/* ⑥ 辉光领域 */', window: 80 }),
          dmP('dmDodgeBloom', 'dodgeBloomed', '辉光领域 · 闪避率（开华后）', { min: 0, max: 0.9, step: 0.01, anchor: '/* ⑥ 辉光领域 */', window: 80 }),
        ]
      },
      {
        id: 'numTaoyaoSkill', name: '桃夭 · 技能数值', kind: 'balance',
        note: '两支箭（荣 / 枯）互斥，所以一般只有一支在场上；认真拉矢的每层加成同时吃满层上限。',
        fields: [
          rgP('rgCd', 'cd', '映霞[荣] · 冷却（秒）', { min: 0.1, max: 20, step: 0.1, anchor: '/* ① 映霞[荣]：连射 + 五连发 */', window: 300 }),
          rgP('rgDmg', 'damage', '映霞[荣] · 单箭伤害', { min: 0, max: 2000, step: 5, anchor: '/* ① 映霞[荣]：连射 + 五连发 */', window: 300 }),
          rgP('rgSpeed', 'speed', '映霞[荣] · 箭矢速度', { min: 50, max: 3000, step: 10, anchor: '/* ① 映霞[荣]：连射 + 五连发 */', window: 300 }),
          rgP('rgBurstDmg', 'burstDmg', '映霞[荣] · 五连发每支伤害', { min: 0, max: 2000, step: 5, anchor: '/* ① 映霞[荣]：连射 + 五连发 */', window: 460 }),
          rgP('rgBurstCount', 'burstCount', '映霞[荣] · 五连发支数', { min: 2, max: 12, step: 1, anchor: '/* ① 映霞[荣]：连射 + 五连发 */', window: 460 }),
          kuP('kuCd', 'cd', '映霞[枯] · 冷却（秒）', { min: 0.1, max: 20, step: 0.1, anchor: '/* ② 映霞[枯]：黑白箭 + 减速 */', window: 200 }),
          kuP('kuDmg', 'damage', '映霞[枯] · 单箭伤害', { min: 0, max: 2000, step: 5, anchor: '/* ② 映霞[枯]：黑白箭 + 减速 */', window: 200 }),
          kuP('kuSpeed', 'speed', '映霞[枯] · 箭矢速度', { min: 50, max: 3000, step: 10, anchor: '/* ② 映霞[枯]：黑白箭 + 减速 */', window: 200 }),
          kuP('kuSlow', 'slow', '映霞[枯] · 减速量', { min: 0, max: 200, step: 5, anchor: '/* ② 映霞[枯]：黑白箭 + 减速 */', window: 200 }),
          kuP('kuSlowSec', 'slowSeconds', '映霞[枯] · 减速持续（秒）', { min: 0, max: 10, step: 0.5, anchor: '/* ② 映霞[枯]：黑白箭 + 减速 */', window: 200 }),
          aimP('aimPer', 'perStack', '认真拉矢 · 每层伤害加成', { min: 0, max: 100, step: 1, anchor: '/* ③ 认真拉矢：命中叠层、落空掉层 */', window: 120 }),
          aimP('aimMax', 'maxStacks', '认真拉矢 · 满层数', { min: 1, max: 50, step: 1, anchor: '/* ③ 认真拉矢：命中叠层、落空掉层 */', window: 120 }),
          cjP('cjCd', 'cd', '春景 · 冷却（秒）', { min: 0.1, max: 60, step: 0.5, anchor: '/* ④ 春景：自我 buff */', window: 300 }),
          cjP('cjHeal', 'healPerSec', '春景 · 每秒回血', { min: 0, max: 500, step: 1, anchor: '/* ④ 春景：自我 buff */', window: 300 }),
          cjP('cjCannonDmg', 'cannonDmg', '春景 · 光炮伤害', { min: 0, max: 3000, step: 10, anchor: '/* ④ 春景：自我 buff */', window: 300 }),
          cjP('cjCannonSpeed', 'cannonSpeed', '春景 · 光炮弹速', { min: 50, max: 3000, step: 10, anchor: '/* ④ 春景：自我 buff */', window: 300 }),
          cjP('cjCannonEvery', 'cannonEvery', '春景 · 光炮间隔（秒）', { min: 0.1, max: 20, step: 0.1, anchor: '/* ④ 春景：自我 buff */', window: 300 }),
          topP('topMelee', 'meleePer', '陀螺 · 每层碰撞加成', { min: 0, max: 100, step: 1, anchor: '/* ⑤ 陀螺：被打击叠层 */', window: 200 }),
          topP('topSpeed', 'speedPer', '陀螺 · 每层速度加成', { min: 0, max: 100, step: 1, anchor: '/* ⑤ 陀螺：被打击叠层 */', window: 200 }),
        ]
      },
      {
        id: 'numTinaSkill', name: '缇娜 · 技能数值', kind: 'balance',
        note: '蝙蝠与霰弹是"一轮多发"，所以预览里会按一轮合计与每秒伤害两种口径都算给你看。',
        fields: [
          skP('skMelee', 'meleeTo', '吸血 · 每次接触伤害', { min: 0, max: 500, step: 5, anchor: '/* ① 吸血习性 */', window: 400 }),
          skP('skHold', 'holdSeconds', '吸血 · 吸附时长（秒）', { min: 0.1, max: 10, step: 0.1, anchor: '/* ① 吸血习性 */', window: 400 }),
          btP('btCd', 'cd', '蝙蝠 · 冷却（秒）', { min: 0.1, max: 30, step: 0.5, anchor: '/* ② 蝙蝠 */', window: 700 }),
          btP('btMin', 'minCount', '蝙蝠 · 最少只数', { min: 1, max: 12, step: 1, anchor: '/* ② 蝙蝠 */', window: 700 }),
          btP('btMax', 'maxCount', '蝙蝠 · 最多只数', { min: 1, max: 12, step: 1, anchor: '/* ② 蝙蝠 */', window: 700 }),
          btP('btSpeed', 'speed', '蝙蝠 · 飞行速度', { min: 20, max: 900, step: 5, anchor: '/* ② 蝙蝠 */', window: 700 }),
          btP('btDmg', 'damage', '蝙蝠 · 单只伤害', { min: 0, max: 500, step: 1, anchor: '/* ② 蝙蝠 */', window: 700 }),
          btP('btHeal', 'heal', '蝙蝠 · 返回时回血', { min: 0, max: 500, step: 1, anchor: '/* ② 蝙蝠 */', window: 700 }),
          btP('btStealSec', 'stealSeconds', '蝙蝠 · 偷到持续型能力时借多久（秒）',
            { min: 0.5, max: 30, step: 0.5, anchor: '/* ② 蝙蝠 */', window: 700 }),
          btP('btTurn', 'turnPerSec', '蝙蝠 · 追踪转速上限（度/秒）',
            { min: 0, max: 720, step: 5, anchor: '/* ② 蝙蝠 */', window: 700 }),
          shP('shCd', 'cd', '霰弹 · 冷却（秒）', { min: 0.1, max: 30, step: 0.5, anchor: '/* ③ 魔力霰弹 */', window: 400 }),
          shP('shCount', 'count', '霰弹 · 一轮几发', { min: 1, max: 12, step: 1, anchor: '/* ③ 魔力霰弹 */', window: 400 }),
          shP('shSpread', 'spreadDeg', '霰弹 · 每发偏移上限（度）', { min: 0, max: 90, step: 1, anchor: '/* ③ 魔力霰弹 */', window: 400 }),
          shP('shDmg', 'damage', '霰弹 · 单发伤害', { min: 0, max: 2000, step: 5, anchor: '/* ③ 魔力霰弹 */', window: 400 }),
          shP('shSpeed', 'speed', '霰弹 · 弹速', { min: 50, max: 3000, step: 10, anchor: '/* ③ 魔力霰弹 */', window: 400 }),
          scP('scMelee', 'meleeBonus', '权杖 · 碰撞伤害加成', { min: 0, max: 500, step: 1, anchor: '/* ④ 权杖（被动） */', window: 120 }),
          p3P('p3Tick', 'tickPerSec', '光柱 · 每秒结算几次', { min: 0.5, max: 20, step: 0.5, anchor: 'p3: {', window: 250 }),
          p3P('p3Dmg', 'damage', '光柱 · 每次结算伤害', { min: 0, max: 2000, step: 5, anchor: 'p3: {', window: 250 }),
          p3P('p3Radius', 'radius', '光柱 · 半径', { min: 1, max: 200, step: 1, anchor: 'p3: {', window: 250 }),
          p3P('p3Len', 'len', '光柱 · 长度', { min: 20, max: 2000, step: 10, anchor: 'p3: {', window: 250 }),
        ]
      },
    ]
  },
];

/** 文件短名 → 真实路径（也是允许写入的白名单） */
export const EDIT_FILES = {
  balls: 'js/balls.js',
  skills: 'js/skills.js',
  render: 'js/render.js',
};

/** 扁平化所有字段（写回、自检、按 id 查值都用它） */
export function allFields() {
  const out = [];
  for (const g of ASSET_GROUPS) {
    for (const it of g.items) {
      for (const f of it.fields) out.push({ ...f, group: g.id, item: it.id });
    }
  }
  return out;
}

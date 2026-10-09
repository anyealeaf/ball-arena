/* ============================================================
   balls.js — 小球定义表（数据层）
   ------------------------------------------------------------
   这一层是"内容"，不是"引擎"。将来接入你的原创角色时，
   只需要往 SPECIES 里加条目、填 image 与 skills，引擎代码不用改。
   ============================================================ */

/* ---------- 物理与全局常量（定点数标度） ---------- */
export const SCALE = 1000;          // 定点标度：内部全部按 1/1000 单位存整数
export const DT = 1 / 60;           // 固定时间步：60 逻辑帧/秒
export const WORLD_W = 720;         // 世界宽度（设计尺寸）
export const WORLD_H = 440;         // 世界高度（设计尺寸）

/* ---------- 队伍配置：最多支持到 6 队 ---------- */
export const MAX_TEAMS = 6;

export const TEAM_COLORS = [
  { key: 'blue',   name: '蓝队', main: '#2f6df6', soft: 'rgba(47,109,246,0.22)',  text: '#1d4ed8' },
  { key: 'red',    name: '红队', main: '#e8452c', soft: 'rgba(232,69,44,0.22)',   text: '#b3271a' },
  { key: 'green',  name: '绿队', main: '#159c6b', soft: 'rgba(21,156,107,0.22)',  text: '#0f6b4a' },
  { key: 'amber',  name: '黄队', main: '#d97706', soft: 'rgba(217,119,6,0.22)',   text: '#a35a05' },
  { key: 'violet', name: '紫队', main: '#8b5cf6', soft: 'rgba(139,92,246,0.22)',  text: '#6d3fd4' },
  { key: 'cyan',   name: '青队', main: '#0891b2', soft: 'rgba(8,145,178,0.22)',   text: '#0e7490' }
];

/** 取队伍配色（超过 6 队时循环复用） */
export function teamColor(i) {
  return TEAM_COLORS[i % TEAM_COLORS.length];
}

/* ---------- 小球定义 ----------
   字段说明：
     id        内部标识
     name      显示名
     color     球体颜色
     hp        最大生命
     r         半径（世界单位）
     speed     移动速度（世界单位/秒）
     melee     贴身碰撞造成的伤害
     reach     攻击距离；0 表示纯近战，>0 表示远程
     image     角色立绘路径（接入原创角色时填，如 '../assets/xxx.png'）
     resource  特殊资源定义；null 表示该球没有特殊资源
     skills    技能列表；空数组表示无技能
   ---------- */

export const SPECIES = [
  /* ---------- 正式角色 ---------- */
  {
    id: 'yuncai',
    name: '晕彩',
    color: '#8ea2e8',          // 取自立绘的发色，作为贴图加载前的兜底
    hp: 1500,
    r: 16,
    speed: 120,
    /* 基础没有碰撞伤害 —— 折光会把碰撞伤害改成 100，
       开华再 +50（两者都有就是 150）。 */
    melee: 0,
    reach: 0,
    desc: '魔法少女。速度 120，本身没有碰撞伤害，靠"光"体系的技能输出。' +
          '技能共 7 个，每局最多装配 3 个。',
    tags: ['魔法少女', '正式角色'],
    /* 小球贴图：作者提供的裁剪好的圆形头像，直接用满。 */
    sticker: {
      src: 'assets/characters/yuncai_ball.png',
      cx: 0.5, cy: 0.5, r: 0.5
    },
    /* ---------- 辉光领域的背景层（作者提供的横向长图）----------
       这张图**直接就是成品**，不需要任何切图/规整步骤，所以它放在
       assets/characters/ 而不是 assets/src/（后者是"待处理的源图"）。

       领域展开分两段，参数都在这里，改数值不用动渲染代码：
         1) 从晕彩身上扩散一圈气浪到铺满全场，气浪扫过的地方领域浮现出来；
         2) 展开完成后，背景缓慢向右滚动（镜像平铺，不会出现接缝跳变），
            整体透明度降到 opacity —— 压到 30~50% 是为了不盖住对战。

       坐标约定：图片按**场地高度**等比缩放，于是横向一定溢出（图是 7:3），
       溢出量正好拿来滚动。竖直方向刚好铺满，不拉伸。 */
    domain: {
      src: 'assets/characters/yuncai_aurora.jpg',
      revealSeconds: 1.3,     // 气浪从中心铺满全场的时间
      opacity: 0.42,          // 展开完成后稳定下来的不透明度（作者要 30%~50%）
      fadeInPortion: 0.25,    // 前 25% 的展开过程里淡入，避免"啪"地冒出来
      scrollUnitsPerSec: 7,   // 展开后背景向右滚动的速度（世界单位/秒）
      ringWidth: 30,          // 气浪环的宽度（世界单位）
      ringAlpha: 0.85,
      ringCoreAlpha: 0.95,
      glow: '#7dd3fc',
      core: '#ffffff'
    },
    /* 开华形态的贴图：开华发动后渲染层自动换成这一张 */
    stickerBloom: {
      src: 'assets/characters/yuncai_ball_bloom.png',
      cx: 0.5, cy: 0.5, r: 0.5
    },
    resource: null,
    /* 顺序即"默认装配"的优先级：前 3 个会默认带上。
       这里按作者给出的编号 ①~⑦ 排列。 */
    skills: [
      'yuncai_caiguang',   // ① 裁光
      'yuncai_modan',      // ② 魔弹
      'yuncai_zheguang',   // ③ 折光
      'yuncai_kaihua',     // ④ 开华
      'yuncai_prism',      // ⑤ 棱镜
      'yuncai_domain',     // ⑥ 辉光领域
      'yuncai_xiguang'     // ⑦ 析光
    ]
  },

  {
    id: 'taoyao',
    name: '桃夭',
    color: '#e8a8b8',          // 取自立绘的发色／粉色蝴蝶结
    hp: 1750,
    r: 16,
    speed: 120,
    melee: 66,
    reach: 0,
    desc: '魔法少女。速度 120、碰撞伤害 66，靠箭矢输出并靠回血续航。' +
          '技能共 5 个，其中「映霞[荣]」与「映霞[枯]」互斥，只能二选一；每局最多装配 3 个。',
    tags: ['魔法少女', '正式角色'],
    sticker: {
      src: 'assets/characters/taoyao_ball.png',
      cx: 0.5, cy: 0.5, r: 0.5
    },
    /* ---------- 手持物件：弓（动作动画的载体）----------
       与球体贴图**完全分开**的一条绘制路径，原因有三个：
         1. 球体贴图会被 clip 成圆形，弓画在球外面会被整个裁掉；
         2. 球装陀螺时会自转（spin），弓跟着转就没法瞄准了 ——
            分开画之后弓天然不继承自转，这个问题自动消失；
         3. 弓要朝目标转，而球体贴图只需要自转，两者的变换互不相干。

       三个动作状态，与作者的描述一一对应（映霞[荣]-1 / -2）：
         idle —— 平时（弓举着，弦是直的）        castP 恰好 = 0
         draw —— 准备射箭（弦拉开，搭好一支箭）  0 < castP < 1
         shot —— 射箭那一帧（弓回到平时，箭已离弦）castP = 1
       `shot` 留 null = 与 idle 同一张图，也就是作者说的"射箭的时候切换为 1"。

       两张弓图的原始画布宽度不同（116 / 196，拉弓那张多一支箭），
       直接各自居中画会让弓横跳 40px。所以由 tools/make-sprites.mjs
       先把两帧按"弓臂对齐"贴到**同一块画布**上，这里拿到的两张图同尺寸同锚点。 */
    bow: {
      /* 哪一个 castKind 用哪一套美术：
         kind 0 = 映霞[荣] 普通，1 = 映霞[荣] 五连发，2 = 映霞[枯]。
         两式长得完全不一样（荣是粉弓、枯是墨色花枝弓），
         而弓的美术挂在球种上、渲染层看不出当前是哪一式 ——
         所以由技能用 castKind 报出来，渲染层照这个表挑。 */
      kindArt: [0, 0, 1],
      arts: [
      { // ---------- 荣 ----------
      idle: 'assets/characters/taoyao_bow_idle.png',
      draw: 'assets/characters/taoyao_bow_draw.png',
      shot: null,                                        // null = 同 idle
      arrow: 'assets/characters/taoyao_arrow.png',

      /* anchor —— **球心**落在这块画布上的位置（画布宽高的比例）。
         弓绕这个点旋转，所以它同时决定了"球握在弓的哪个位置"。
         y 取 0.521 = 画里那支搭好的箭所在的高度，也就是搭箭点 ——
         球心必须在这一行上，否则箭会从球的旁边而不是身上射出去。 */
      /* 下面三个几何量都由 tools/make-sprites.mjs **量出来**，不是人眼试的。
         它同时拿荣这组值做自检（对照当初人眼调好的 0.426 / 0.0204 / 0.335）。 */
      anchor: { x: 0.4260, y: 0.5211 },
      /* bowH —— 弓的绘制高度（世界单位），宽度按原图比例。球直径是 32。
         弓是 1:4.96 的细长弓，所以这个数要比球直径大不少才看得清；
         取 140 时弓的内容宽度约 28 单位，和球差不多宽 ——
         表现为"球在弓的正中、上下各伸出一截弓臂"。 */
      bowH: 100,

      /* nock —— 搭箭节点（那支搭好的箭的箭尾）在画布上的位置。
         五连发时，额外四根箭以这个点为轴扇形排开 —— 五根箭共用同一个箭尾。 */
      nock: { x: 0.0051, y: 0.5211 },
      /* 箭矢长度按弓高的比例给（画里那支搭好的箭是弓高的 0.335 倍），
         这样改 bowH 时箭会跟着等比缩放，不用再调一次。 */
      arrowLenFrac: 0.3243,

      /* 五连发：在 draw 的基础上，于同一个搭箭节点扇形排布箭矢。
         这些箭是**武器的一部分**，所以跟着弓一起旋转（用弓的局部坐标系）。

         **角度必须和箭真正飞出去的角度一致** —— 画这个扇形的意义就是
         "预告这五发往哪飞"。所以这里给的是"总共几发 + 张角的一半"，
         渲染层按和技能**同一个公式**算角度，再把正中那根跳掉
         （0° 那根已经画在 draw 图里了）。
         参数对应 TAOYAO.rong 的 burstCount / burstSpread：
           5 发 / 0.42 弧度（24.06°）→ 0°, ±12.03°, ±24.06°。
         诊断里有一条断言把这两个数钉在一起，改一边不改另一边会变红。 */
      burst: { count: 5, spreadDeg: 24.06 },
      },

      { // ---------- 枯 ----------
      /* 枯的弓是墨色花枝弓，与荣完全不同的一套图。
         它没有五连发，所以 burst 用不上（五连发是荣独有的）。
         几何量同样由构建工具量出来：对齐偏移 38px → 画布 214×589。

         **这张「平时」原图作者画反了手**：弦在右边、弓臂鼓向左边，
         和它自己的「拉弓」那张、以及荣的两张正好相反。
         tools/make-sprites.mjs 会在构建时把方向不对的那一帧**左右镜像**过来
         （镜像 ≠ 转 180°：弓上下有别，转 180° 会把弓梢和握把也翻掉），
         并在控制台把这件事报出来。所以下面这些数字是**摆正之后**量的，
         别拿 assets/src 里的原图去核对 —— 那张是反的。 */
      idle: 'assets/characters/taoyao_ku_bow_idle.png',
      draw: 'assets/characters/taoyao_ku_bow_draw.png',
      shot: null,
      arrow: 'assets/characters/taoyao_ku_arrow.png',
      anchor: { x: 0.5374, y: 0.5059 },
      bowH: 100,
      nock: { x: 0.0514, y: 0.5059 },
      arrowLenFrac: 0.3243,
      burst: null,
      },
      ],
    },
    resource: null,
    /* 数组顺序 = "默认装配"的优先级（前 3 个）。
       刻意把「映霞[枯]」排在第 4 位：它和「映霞[荣]」互斥，
       排进前 3 会导致默认装配只剩 2 个技能（互斥项被自动剔除）。
       这样排下来默认是「荣 + 认真拉矢 + 春景」，三个都能用。 */
    skills: [
      'taoyao_rong',       // ① 映霞[荣]
      'taoyao_aim',        // ③ 认真拉矢
      'taoyao_chunjing',   // ④ 春景
      'taoyao_ku',         // ② 映霞[枯]（与①互斥）
      'taoyao_top'         // ⑤ 陀螺
    ]
  },

  {
    id: 'tina',
    name: '缇娜',
    color: '#c0253f',          // 取自立绘的红裙与红宝石（技能那套"猩红色"同源）
    hp: 1500,
    r: 16,
    speed: 125,
    melee: 50,
    reach: 0,
    desc: '魔法少女。血量 1500、速度 125、碰撞伤害 50。' +
          '打法围绕"贴身吸血 + 蝙蝠攒魔力"，技能共 7 个，每局最多装配 3 个。',
    tags: ['魔法少女', '正式角色'],
    sticker: {
      src: 'assets/characters/tina_ball.png',
      cx: 0.5, cy: 0.5, r: 0.5
    },
    /* 魔力计数：由「蝙蝠」返回时逐点积攒（不是随时间自动涨），
       满 5 点触发一次"偷学"——见 js/skills.js 的 tina_bat。
       所以 gainPerSec / gainOnHit 都是 0，涨的方式写在技能里。 */
    resource: {
      id: 'mana',
      name: '魔力',
      max: 5,
      init: 0,
      gainPerSec: 0,
      gainOnHit: 0,
      color: '#c0253f'
    },
    /* 数组顺序 = 默认装配优先级（前 3 个），与作者给的编号 ①~⑦ 一致。
       默认是「吸血习性 + 蝙蝠 + 魔力霰弹」——前 3 个都不互斥，三个都能用。
       ⑤⑥⑦ 三个「公主传承」互斥（group: 'princess'），排在第 5~7 位，
       所以它们不会被自动塞进默认装配。 */
    skills: [
      'tina_suck',         // ① 吸血习性
      'tina_bat',          // ② 蝙蝠
      'tina_shot',         // ③ 魔力霰弹
      'tina_scepter',      // ④ 权杖（被动）
      'tina_p1',           // ⑤ 公主传承1（与⑥⑦互斥）
      'tina_p2',           // ⑥ 公主传承2（与⑤⑦互斥）
      'tina_p3'            // ⑦ 公主传承3（与⑤⑥互斥）
    ]
  },

  /* ---------- 见晴（魔法少女[白水仙]）----------
     作者 2026-10 给的规格：**血量 1500 / 速度 120 / 碰撞伤害 30 /
     标准体型（与晕彩一致，r = 16）**，六个技能。

     她的"特殊资源"就是 ① 的护盾（水镜护盾）：白色小球在淡粉水镜下每秒 +30、
     上限 300，受到的伤害先扣它。放进 resource 而不是新加一个字段，
     是因为资源条本来就会画在血条下方 —— 护盾看得见，才谈得上"要不要开 ①"。

     贴图暂时没有（作者还没给美术），所以 sticker 为 null：
     渲染层会退回纯色圆 + 当前水镜颜色的外圈。 */
  {
    id: 'jianqing',
    name: '见晴',
    color: '#cfe0ea',          // 白水仙的淡白蓝（贴图加载前的兜底色）
    hp: 1500,
    r: 16,                     // 标准体型：与晕彩一致
    speed: 120,
    melee: 30,
    reach: 0,
    desc: '魔法少女[白水仙]。血量 1500、速度 120、碰撞伤害 30、标准体型；' +
          '靠三面「水镜」切换形态（回血 / 长剑 / 借来的魔弹与激光），' +
          '还能飞起来、变成精灵形态、掉血时射出追踪羽毛。技能共 6 个，每局最多装配 3 个。',
    tags: ['魔法少女', '正式角色'],
    image: null,
    /* 小球贴图：作者 2026-10 给的「魔法少女[白水仙]（贴图）.png」，
       已经裁成一个 282×282 的圆形头像，直接用满（cx/cy/r = 0.5）。
       源图留在 assets/src/jianqing/ball.png。 */
    sticker: {
      src: 'assets/characters/jianqing_ball.png',
      cx: 0.5, cy: 0.5, r: 0.5
    },
    /* 水镜护盾：由技能① 攒，受伤时先扣它 */
    resource: {
      id: 'mirror',
      name: '水镜护盾',
      max: 300,
      init: 0,
      gainPerSec: 0,   // 不随时间自动涨：只有淡粉水镜才 +30/秒（见 skills.js）
      gainOnHit: 0,
      color: '#f0abfc'
    },
    skills: [
      'jianqing_mirror_def',     // ① 水镜·魔力共鸣（防御）
      'jianqing_mirror_sword',   // ② 水镜·魔力共鸣（猩红色）
      'jianqing_mirror_borrow',  // ③ 水镜·魔力共鸣（攻击）
      'jianqing_takeoff',        // ④ 起飞
      'jianqing_transform',      // ⑤ 精灵变身
      'jianqing_feather'         // ⑥ 我很可爱
    ]
  },

  /* ---------- 木桩（演示用靶子）----------
     作者 2026-10 的要求：「速度恒定为 0，体型为大，血量 5000，碰撞伤害 50，
     无技能，用于斗蛐蛐技能演示」。

     为什么它需要一个**引擎级**的开关（immovable）而不是只把 speed 写成 0：
       · `speed: 0` 只挡住"自己走"（转向/巡敌都是按 speed 给速度的）；
       · 但碰撞冲量、分离推挤、击退、撞墙反弹都会**直接改 vx/vy**，
         木桩会被打得满地跑 —— 那就没法当靶子了。
     所以引擎把 immovable 的小球按"质量极大"处理（见 core.js 的 buildUnits），
     推挤全部转嫁给对方，撞上来的一方自己弹开，木桩纹丝不动。
     `speed: 0` 与 `immovable: true` 两个一起才是"速度恒定为 0"。

     ⚠ **两个木桩对打是永远打不完的**（都不会动、碰不到对方）——
     这不是 bug，是"靶子"的必然结果。要收场就打开「比赛时长上限」。 */
  {
    id: 'dummy',
    name: '木桩',
    color: '#8a6a48',          // 木头色（没有贴图时的兜底圆）
    hp: 5000,
    r: 30,                     // 体型为大：直径 60，正好是本体（32）的近两倍
    speed: 0,                  // 永远不动
    melee: 50,
    reach: 0,
    immovable: true,           // 推不动（引擎按"质量极大"处理）
    desc: '演示用的木桩：不会移动、不会主动出手，血量 5000、体型比本体大一圈，' +
          '碰撞伤害 50。拿它当靶子看技能效果最直观。' +
          '注意两个木桩对打是打不完的 —— 它们都动不了，谁也碰不到谁。',
    tags: ['木桩', '演示'],
    image: null,
    sticker: null,             // 没有贴图：渲染层会退回纯色圆
    resource: null,
    skills: []                 // 无技能
  }
];

export const SPECIES_BY_ID = Object.fromEntries(SPECIES.map(s => [s.id, s]));

/**
 * 小球显示/体积倍率。
 * 保持 1：即小球按 SPECIES 表里的原始半径与移速。
 * （曾试过改成 2 让小球的碰撞截面变大从而提高交手频率，
 *   但因为要连带调整站位算法与空间哈希单元尺寸，引入了更多问题，已回退。）
 */
export const BALL_SCALE = 1;

/** 默认选中（新建对局时使用）。
 *  也兼作"球种 id 认不出来"时的兜底（旧存档、手改配置）。
 *  原来是测试球 'test' —— 测试球已经搬到 tests/lib/test-balls.mjs 当夹具了，
 *  这里改成第一位正式角色。 */
export const DEFAULT_SPECIES_ID = 'yuncai';

/* ---------- 技能装配 ----------
   每个小球在开战前单独选择要带哪几个技能。

   为什么要有上限：魔法少女的技能数量天然会很多（设定里每人都有
   武装 / 奇术 / 开华 / 领域等多套能力），全带上既没法平衡，
   也看不出"这一局我想怎么打"的取舍。限到 3 个之后，
   同一套阵容可以通过换装配打出不同效果。
   ---------- */
export const MAX_SKILLS_PER_UNIT = 3;

/**
 * 「随机技能」每局给每个球抽几个技能。
 * 取 3 是因为它同时是"正常装配上限"，老虎机也正好三格。
 * （作者只说"依次展示本局抽到的技能"，没指定数量 —— 要改就改这一个数。）
 */
export const RANDOM_SKILL_COUNT = MAX_SKILLS_PER_UNIT;

/**
 * 某球种的默认装配：取技能表里的前 maxSkills 个。
 * **顺序即优先级** —— 想让哪几个技能默认带上，就在 SPECIES 里排在前面。
 */
export function defaultSkillsFor(speciesId, maxSkills = MAX_SKILLS_PER_UNIT) {
  const s = SPECIES_BY_ID[speciesId] || SPECIES_BY_ID[DEFAULT_SPECIES_ID];
  return (s.skills || []).slice(0, maxSkills);
}

/**
 * 把"想装的技能"整理成合法装配：
 *   · 只保留该球种真的拥有的技能（防止换了球种还留着上一个球种的技能）
 *   · 最多 maxSkills 个（**"无限火力"就是把这个上限抬掉**）
 * wanted 传 undefined / null → 用默认装配；
 * 传数组 → 按数组来，允许空数组（= 这个球不带任何技能，也是合法配置）。
 */
export function normalizeSkills(speciesId, wanted, maxSkills = MAX_SKILLS_PER_UNIT) {
  if (wanted === undefined || wanted === null) return defaultSkillsFor(speciesId, maxSkills);
  const s = SPECIES_BY_ID[speciesId] || SPECIES_BY_ID[DEFAULT_SPECIES_ID];
  const owned = new Set(s.skills || []);
  const cap = Number.isFinite(maxSkills) ? Math.max(0, maxSkills) : Infinity;
  const out = [];
  for (const id of wanted) {
    if (!owned.has(id)) continue;          // 不是这个球种的技能，丢掉
    if (out.includes(id)) continue;        // 去重
    out.push(id);
    if (out.length >= cap) break;
  }
  return out;
}

/** 生成一个战斗单位的运行时初始属性。
 *  半径与移速按 BALL_SCALE 缩放（BALL_SCALE=1 时即原始数值）。
 *  skillIds 省略时使用该球种的默认装配；显式传数组（含空数组）则以它为准。
 *  opts.maxSkills 传 Infinity 即"无限火力"（不限制装几个技能）。
 */
export function makeUnitStats(speciesId, skillIds, opts = {}) {
  const s = SPECIES_BY_ID[speciesId] || SPECIES_BY_ID[DEFAULT_SPECIES_ID];
  const cap = opts.maxSkills ?? MAX_SKILLS_PER_UNIT;
  return {
    speciesId: s.id,
    name: s.name,
    color: s.color,
    maxHp: s.hp,
    r: s.r * BALL_SCALE,
    speed: s.speed * BALL_SCALE,
    melee: s.melee,
    reach: s.reach,
    /* 木桩：推不动（引擎按"质量极大"处理，见 core.js）。 */
    immovable: !!s.immovable,
    sticker: s.sticker || null,
    /* 形态切换用的第二张贴图（例如晕彩的"开华"形态）。
       渲染层按快照里的 bloomed 标记决定用哪一张。 */
    stickerBloom: s.stickerBloom || null,
    /* 手持物件（弓）。渲染层按快照里的 castP（施法进度）挑帧、
       按 aimAngle（瞄准角）决定朝向。 */
    bow: s.bow || null,
    /* 领域背景层的配置（目前只有晕彩有）。渲染层要靠它拿图片路径与时长。 */
    domain: s.domain ? { ...s.domain } : null,
    skills: normalizeSkills(s.id, skillIds, cap),
    resource: s.resource ? { ...s.resource, value: s.resource.init || 0 } : null
  };
}

/* ---------- 特殊规则默认值 ----------
   对应「斗蛐蛐准备」里的特殊选项区域。
   ---------- */
export const DEFAULT_RULES = {
  /** 同队伍小球之间是否会造成伤害 */
  friendlyFire: false,
  /** 是否允许玩家操控其中一个小球（操控方式：WASD / 方向键 / 触屏摇杆） */
  playerControl: false,
  /** 被杀后是否复活 */
  respawn: false,
  /** 复活等待时间（秒） */
  respawnDelay: 3,
  /** 是否按场地设置自动收缩边界（关掉则强制不收缩） */
  allowShrink: true,
  /**
   * 无限火力：解除"每个球最多 MAX_SKILLS_PER_UNIT 个技能"的限制 ——
   * 可以把一个球种的技能全带上（晕彩 7 个），也可以一个都不带。
   * 互斥组（映霞[荣]/[枯]、公主传承）**仍然生效**：那是设计上的"二选一"，
   * 不是数量上限。
   */
  unlimitedSkills: false,
  /**
   * 随机技能：准备界面里不能选技能，开战前先抽（三格老虎机动画）。
   * 抽的是**这个球种自己的**技能池，用本局种子抽，所以同一颗种子抽到同一套。
   */
  randomSkills: false,
  /** 是否有比赛时长上限；到点按剩余总血量判定胜负 */
  timeLimit: 0,        // 0 表示不限时
  /** 展示用：是否显示伤害飘字 */
  showDamageNumbers: true,

  /* ---------- 初始运动 ---------- */
  /**
   * 开局方向模式：
   *   'random' —— 每个小球随机一个方向（同一颗种子必然得到同一套方向）
   *   'custom' —— 使用 customAngles 里逐个指定的角度
   */
  spawnMode: 'random',
  /** custom 模式下每个球的角度（度）。与「斗蛐蛐准备」里的球序一一对应 */
  customAngles: [],
  /** 初速强度倍率：所有小球的开局力道等比缩放（1 为标准力道） */
  speedScale: 1,
  /**
   * 弹性系数：1 = 完全弹性（动能不损失），越小越"闷"。
   * 默认 1，符合"小球一直匀速直线运动"的设定。
   */
  restitution: 1,
  /**
   * 空气阻力（每秒速度衰减比例）。默认 0 = 永不减速。
   * 想让场面逐渐安静下来时可以调到 0.02~0.1。
   */
  drag: 0,
  /**
   * 撞墙后的方向偏转上限（度）。
   * 小球撞墙反弹后，新方向会朝「最近的敌对小球」偏转，最多这么多度。
   * 设为 0 即关闭，变成完全镜面反射。
   */
  wallDeflectDeg: 10,
  /**
   * 接触后的最小出射夹角（度）。
   *
   * 为什么需要：擦碰时法向相对速度接近 0，物理上方向几乎不变 ——
   * 实测约 4% 的碰撞转向不到 2 度，另有 13% 不到 10 度。
   * 玩家看到两球接触却没看到方向变化，就会认为"撞了没反应"。
   * 所以接触后保证每个球至少以这个角度离开接触面。
   *
   * 只在"球仍在朝接触面靠近"时介入，弹开的球原样保留 ——
   * 否则对撞（迎面撞上）会被错误地推向同一侧。
   * 设为 0 即关闭，回到纯物理。
   */
  contactMinTurnDeg: 8,
  /**
   * 逐帧微转向速度（度/秒）。
   * 除了撞墙时的偏转，每帧还可以让航向缓慢朝最近的敌人修正。
   *
   * 为什么需要它：只靠撞墙偏转的话，两次撞墙之间可能隔着好几秒，
   * 而两个小球一旦进入平行轨迹就会一直保持平行，迟迟不肯碰面
   * （实测会让 1v1 从十几秒拖到 130 秒以上）。给一个很慢的持续修正，
   * 场面就会稳定收敛到交战，同时速度大小仍然不变、看上去依旧接近直线。
   *
   * 设为 0 即完全关闭，变成"只有碰撞才改变方向"的纯粹模型。
   */
  steerDegPerSec: 30
};

/** 混战/时限等相关的可选档位（给 UI 做下拉） */
export const TIME_LIMIT_OPTIONS = [
  { value: 0, label: '不限时（打到分出胜负）' },
  { value: 30, label: '30 秒（超时按剩余血量判定）' },
  { value: 60, label: '60 秒' },
  { value: 90, label: '90 秒' },
  { value: 120, label: '120 秒' }
];

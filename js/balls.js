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
       直接各自居中画会让弓横跳 40px。所以由 tools/make-bow-sprites.mjs
       先把两帧按"弓臂对齐"贴到**同一块画布**上，这里拿到的两张图同尺寸同锚点。 */
    bow: {
      idle: 'assets/characters/taoyao_bow_idle.png',
      draw: 'assets/characters/taoyao_bow_draw.png',
      shot: null,                                        // null = 同 idle
      arrow: 'assets/characters/taoyao_arrow.png',

      /* anchor —— **球心**落在这块画布上的位置（画布宽高的比例）。
         弓绕这个点旋转，所以它同时决定了"球握在弓的哪个位置"。
         y 取 0.521 = 画里那支搭好的箭所在的高度，也就是搭箭点 ——
         球心必须在这一行上，否则箭会从球的旁边而不是身上射出去。 */
      anchor: { x: 0.4260, y: 0.5211 },
      /* bowH —— 弓的绘制高度（世界单位），宽度按原图比例。球直径是 32。
         弓是 1:4.96 的细长弓，所以这个数要比球直径大不少才看得清；
         取 140 时弓的内容宽度约 28 单位，和球差不多宽 ——
         表现为"球在弓的正中、上下各伸出一截弓臂"。 */
      bowH: 140,

      /* nock —— 搭箭节点（那支搭好的箭的箭尾）在画布上的位置。
         五连发时，额外四根箭以这个点为轴扇形排开 —— 五根箭共用同一个箭尾。 */
      nock: { x: 0.0204, y: 0.5211 },
      /* 箭矢长度按弓高的比例给（画里那支搭好的箭是弓高的 0.335 倍），
         这样改 bowH 时箭会跟着等比缩放，不用再调一次。 */
      arrowLenFrac: 0.335,

      /* 五连发：在 draw 的基础上，于同一个搭箭节点扇形排布箭矢。
         这些箭是**武器的一部分**，所以跟着弓一起旋转（用弓的局部坐标系）。

         **角度必须和箭真正飞出去的角度一致** —— 画这个扇形的意义就是
         "预告这五发往哪飞"。所以这里给的是"总共几发 + 张角的一半"，
         渲染层按和技能**同一个公式**算角度，再把正中那根跳掉
         （0° 那根已经画在 draw 图里了）。
         参数对应 TAOYAO.rong 的 burstCount / burstSpread：
           5 发 / 0.42 弧度（24.06°）→ 0°, ±12.03°, ±24.06°。
         诊断里有一条断言把这两个数钉在一起，改一边不改另一边会变红。 */
      burst: { count: 5, spreadDeg: 24.06 }
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

  /* ---------- 技能测试球 ---------- */  {
    id: 'test_skill',
    name: '测试球·技能型',
    color: '#c084fc',
    hp: 1000,
    r: 16,
    speed: 120,
    melee: 100,
    reach: 0,
    desc: '用来验证技能机制的测试球，带两个技能：' +
          '① 每 2.5 秒自动瞄准对手发射一枚攻击力 50 的特效小球；' +
          '② 撞到场地边界时停止移动，蓄力 2 秒后加速冲向对手（加速期间碰撞伤害 200，并把对手推远）。',
    tags: ['测试', '技能'],
    image: null,
    resource: null,
    /* 技能引用见 js/skills.js。冷却、撞墙/撞击/血量/次数等触发方式
       都由引擎统一分发，技能本身只负责"发动时做什么"。 */
    skills: ['test_shot', 'test_dash']
  },

  /* ---------- 测试球 ---------- */
  {
    id: 'test',
    name: '测试球',
    color: '#8a94a6',
    hp: 1000,
    r: 16,
    speed: 120,
    melee: 100,          // 碰撞造成 100 伤害
    reach: 0,
    desc: '框架验证用的空白小球：无技能、1000 点生命、贴身碰撞造成 100 点伤害。',
    tags: ['测试'],
    image: null,
    resource: null,      // 无特殊资源 —— 血条下方不会出现资源条
    skills: []
  },

  /* ---------- 演示用：带特殊资源的小球 ----------
     存在的目的是验证「血条在上、特殊资源在下」的 HUD 布局，
     以及资源随时间积攒的逻辑是否跑得通。技能本身留空。 */
  {
    id: 'test_charge',
    name: '测试球·蓄能型',
    color: '#6d8cff',
    hp: 1000,
    r: 16,
    speed: 120,
    melee: 100,
    reach: 0,
    desc: '与测试球数值完全相同，但带一条「蓄能」资源条，用于验证特殊资源的显示与积攒逻辑。',
    tags: ['测试', '资源'],
    image: null,
    resource: {
      id: 'charge',
      name: '蓄能',
      max: 100,
      init: 0,
      gainPerSec: 12,    // 每秒自然积攒
      gainOnHit: 6,      // 每次命中额外获得
      color: '#4f7cff'
    },
    skills: []
  },
  {
    id: 'test_lowhp',
    name: '测试球·脆皮型',
    color: '#e0a03a',
    hp: 400,
    r: 13,
    speed: 150,
    melee: 100,
    reach: 0,
    desc: '生命只有 400 但速度更快，用于验证不同体型/血量在混战中的表现差异。',
    tags: ['测试'],
    image: null,
    resource: null,
    skills: []
  },
  {
    id: 'test_heavy',
    name: '测试球·重装型',
    color: '#3f8f7f',
    hp: 1600,
    r: 21,
    speed: 88,
    melee: 100,
    reach: 0,
    desc: '生命 1600、体型更大、移动更慢，用于验证体积与推挤手感。',
    tags: ['测试'],
    image: null,
    resource: null,
    skills: []
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

/** 默认选中（新建对局时使用） */
export const DEFAULT_SPECIES_ID = 'test';

/* ---------- 技能装配 ----------
   每个小球在开战前单独选择要带哪几个技能。

   为什么要有上限：魔法少女的技能数量天然会很多（设定里每人都有
   武装 / 奇术 / 开华 / 领域等多套能力），全带上既没法平衡，
   也看不出"这一局我想怎么打"的取舍。限到 3 个之后，
   同一套阵容可以通过换装配打出不同效果。
   ---------- */
export const MAX_SKILLS_PER_UNIT = 3;

/**
 * 某球种的默认装配：取技能表里的前 MAX_SKILLS_PER_UNIT 个。
 * **顺序即优先级** —— 想让哪几个技能默认带上，就在 SPECIES 里排在前面。
 */
export function defaultSkillsFor(speciesId) {
  const s = SPECIES_BY_ID[speciesId] || SPECIES_BY_ID[DEFAULT_SPECIES_ID];
  return (s.skills || []).slice(0, MAX_SKILLS_PER_UNIT);
}

/**
 * 把"想装的技能"整理成合法装配：
 *   · 只保留该球种真的拥有的技能（防止换了球种还留着上一个球种的技能）
 *   · 最多 MAX_SKILLS_PER_UNIT 个
 * wanted 传 undefined / null → 用默认装配；
 * 传数组 → 按数组来，允许空数组（= 这个球不带任何技能，也是合法配置）。
 */
export function normalizeSkills(speciesId, wanted) {
  if (wanted === undefined || wanted === null) return defaultSkillsFor(speciesId);
  const s = SPECIES_BY_ID[speciesId] || SPECIES_BY_ID[DEFAULT_SPECIES_ID];
  const owned = new Set(s.skills || []);
  const out = [];
  for (const id of wanted) {
    if (!owned.has(id)) continue;          // 不是这个球种的技能，丢掉
    if (out.includes(id)) continue;        // 去重
    out.push(id);
    if (out.length >= MAX_SKILLS_PER_UNIT) break;
  }
  return out;
}

/** 生成一个战斗单位的运行时初始属性。
 *  半径与移速按 BALL_SCALE 缩放（BALL_SCALE=1 时即原始数值）。
 *  skillIds 省略时使用该球种的默认装配；显式传数组（含空数组）则以它为准。
 */
export function makeUnitStats(speciesId, skillIds) {
  const s = SPECIES_BY_ID[speciesId] || SPECIES_BY_ID[DEFAULT_SPECIES_ID];
  return {
    speciesId: s.id,
    name: s.name,
    color: s.color,
    maxHp: s.hp,
    r: s.r * BALL_SCALE,
    speed: s.speed * BALL_SCALE,
    melee: s.melee,
    reach: s.reach,
    sticker: s.sticker || null,
    /* 形态切换用的第二张贴图（例如晕彩的"开华"形态）。
       渲染层按快照里的 bloomed 标记决定用哪一张。 */
    stickerBloom: s.stickerBloom || null,
    /* 手持物件（弓）。渲染层按快照里的 castP（施法进度）挑帧、
       按 aimAngle（瞄准角）决定朝向。 */
    bow: s.bow || null,
    /* 领域背景层的配置（目前只有晕彩有）。渲染层要靠它拿图片路径与时长。 */
    domain: s.domain ? { ...s.domain } : null,
    skills: normalizeSkills(s.id, skillIds),
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

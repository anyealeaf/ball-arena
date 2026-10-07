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

  /* ---------- 技能测试球 ---------- */
  {
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

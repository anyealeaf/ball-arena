/* ============================================================
   skills.js — 技能数据与注册表
   ------------------------------------------------------------
   设计约定（后续所有角色都按这套写）：

   触发方式（trigger）共 5 种，由引擎在对应时机统一调用：
     'cooldown'  内置冷却，时间到自动发动        { cd }
     'onWall'    撞到场地边界、且正朝墙里撞时发动 { }
     'onHit'     撞到别的球并造成伤害后发动      { }（ctx.other = 对方）
     'onHpBelow' 血量首次降到该比例以下时发动    { ratio }（每个技能只发动一次）
     'onHits'    累计命中+被命中次数达到阈值发动 { count }

   表现方式（effect）两类：
     'aura'       特效（无实体）—— 直接结算，不参与碰撞
     'projectile' 实体 —— 有自己的位置与速度，
                  可以被别的实体或特效命中而消失

   技能实现形如：
     { id, name, desc, trigger: {type, ...}, run(ctx) }
   其中 ctx = { battle, unit, target, other }：
     target = 离 unit 最近的敌人（可能为 null）
     other  = onHit 时的对方小球
   run 返回 true 表示"已发动"；冷却由引擎统一管理，
   返回 true 之后才进入冷却，所以不必在 run 里自己计时。

   技能可以调用的引擎原语（都在 core.js 里）：
     battle._spawnProjectile({kind, owner, x, y, vx, vy, damage, radius, life, color})
        生成一枚弹道：会进快照（所以画面上看得见、能暂停回放）、有寿命、
        撞墙消失、命中敌对小球时按 damage 结算。
     battle._damage(from, to, amount, kind)
        直接结算伤害。kind 是伤害类型标签（'melee' / 'skill' / 自定义），
        会进事件流与伤害统计 —— 画面上飘的数字就是这个 amount，不会被任何机制放大。
     battle._emit(type, a, b, value, extra)
        发一个视觉事件。渲染层已支持的 type 见 render.js 的 _events()。
     battle._nearestEnemy(unit)

   单位字段（unit.*）：x y vx vy r hp maxHp speed melee team id alive
     res resMax resDef（特殊资源条） face flash dmg kills taken damageFrom
     chargeFrames / dashFrames（蓄力·冲刺状态机，见下方说明）
   ============================================================ */

import { SCALE, DT } from './balls.js';

export const TRIGGER_LABELS = {
  cooldown: '冷却触发',
  onWall: '撞墙触发',
  onHit: '撞击触发',
  onHpBelow: '血量触发',
  onHits: '次数触发'
};

/* ------------------------------------------------------------
   参数集中在这里，方便调数值
   ------------------------------------------------------------ */
export const SKILL_PARAMS = {
  /* 技能一：定期发射特效小球 */
  shot: {
    cooldown: 2.5,        // 每 2.5 秒一发
    damage: 50,           // 攻击力
    speed: 300,           // 弹道速度（世界单位/秒）
    radius: 6,            // 弹道半径
    life: 3.0,            // 存活时间（秒），到点自毁，避免满场残留
    color: '#7dd3fc'
  },

  /* 技能二：撞墙后蓄力冲刺 */
  dash: {
    chargeTime: 2.0,      // 蓄力时长（此期间停止移动）
    dashTime: 2.0,        // 加速状态持续时长
    startSpeedMul: 3.0,   // 冲刺初速 = 常速 × 该倍率
    endSpeedMul: 1.0,     // 结束时回到常速
    damage: 200,          // 冲刺期间的碰撞伤害
    knockback: 270        // 命中时把对手推开的初速
  }
};

/* ------------------------------------------------------------
   蓄力 / 冲刺按「整数帧」计时，不用秒做倒计时
   ------------------------------------------------------------
   踩过的坑：原先写的是 u.charge = 2.0; u.charge -= DT; 用浮点秒数倒计时。
   2.0 连续减 120 次 1/60 之后剩下的不是 0 而是 1.4e-15 之类的残渣，
   于是"蓄力 2 秒"实际持续 121 帧，屏幕上的进度环还会出现
   chargeP = 0.999999999999999 这种"看着满了却没出发"的一帧。
   引擎其它部分都是整数逻辑，这里也改成整数帧，长度就精确等于设定值。
   ------------------------------------------------------------ */
export const CHARGE_FRAMES = Math.round(SKILL_PARAMS.dash.chargeTime / DT);
export const DASH_FRAMES = Math.round(SKILL_PARAMS.dash.dashTime / DT);

/* ============================================================
   闯关肉鸽 · 敌人的两套"魔弹"（作者 2026-10 给的数值）
   ------------------------------------------------------------
   两张表共用一个发射函数：小怪/精英的差别只有伤害、弹速与间隔。
   它们和玩家的技能走同一条路（冷却触发 + `_spawnProjectile`），
   所以撞墙、被见晴的长剑消掉、被裁光的细线吸收这些交互全都天然成立。
   美术：**没有贴图**，就是程序化光点（它们是关卡杂兵，不值得再配图）。
   ============================================================ */
export const ROGUE_BOLTS = {
  bolt50: { name: '魔弹', cd: 2, damage: 50, speed: 400, r: 5, life: 4, color: '#c084fc' },
  bolt100: { name: '魔弹', cd: 1, damage: 100, speed: 550, r: 6, life: 4, color: '#f472b6' },
};

function fireBolt(battle, unit, target, P) {
  const dx = target.x - unit.x, dy = target.y - unit.y;
  const d = Math.hypot(dx, dy) || 1;
  const spd = P.speed * SCALE;
  battle._spawnProjectile({
    kind: 'aura', tag: 'npc_bolt', owner: unit,
    x: unit.x, y: unit.y,
    vx: Math.round((dx / d) * spd), vy: Math.round((dy / d) * spd),
    damage: battle._scaledDamage(unit, P.damage),
    radius: Math.round(P.r * SCALE),
    life: P.life, color: P.color,
  });
}

/** 每 2 秒一个 50 伤害 / 400 弹速的魔弹（NPC11 / NPC22） */
export const SKILL_NPC_BOLT50 = {
  id: 'npc_bolt50',
  name: '魔弹',
  desc: `每 ${ROGUE_BOLTS.bolt50.cd} 秒发射一个 ${ROGUE_BOLTS.bolt50.damage} 伤害、` +
        `${ROGUE_BOLTS.bolt50.speed} 弹速的魔弹。`,
  descDetail: `每 ${ROGUE_BOLTS.bolt50.cd} 秒瞄准最近的敌人发射一枚魔弹：` +
        `伤害 ${ROGUE_BOLTS.bolt50.damage}、弹速 ${ROGUE_BOLTS.bolt50.speed}、没有贴图（程序化光点）。`,
  trigger: { type: 'cooldown', cd: ROGUE_BOLTS.bolt50.cd },
  run(ctx) {
    const { battle, unit, target } = ctx;
    if (!target) return false;
    fireBolt(battle, unit, target, ROGUE_BOLTS.bolt50);
    return true;
  },
};

/** 每 1 秒一个 100 伤害 / 550 弹速的魔弹（NPC21） */
export const SKILL_NPC_BOLT100 = {
  id: 'npc_bolt100',
  name: '魔弹',
  desc: `每 ${ROGUE_BOLTS.bolt100.cd} 秒发射一个 ${ROGUE_BOLTS.bolt100.damage} 伤害、` +
        `${ROGUE_BOLTS.bolt100.speed} 弹速的魔弹。`,
  descDetail: `每 ${ROGUE_BOLTS.bolt100.cd} 秒瞄准最近的敌人发射一枚魔弹：` +
        `伤害 ${ROGUE_BOLTS.bolt100.damage}、弹速 ${ROGUE_BOLTS.bolt100.speed}。`,
  trigger: { type: 'cooldown', cd: ROGUE_BOLTS.bolt100.cd },
  run(ctx) {
    const { battle, unit, target } = ctx;
    if (!target) return false;
    fireBolt(battle, unit, target, ROGUE_BOLTS.bolt100);
    return true;
  },
};

/* ------------------------------------------------------------
   技能一：每隔 2.5 秒自动瞄准对手发射一个 50 攻击力的特效小球
   ------------------------------------------------------------ */
export const SKILL_SHOT = {
  id: 'test_shot',
  name: '定时射击',
  desc: `每 ${SKILL_PARAMS.shot.cooldown} 秒自动瞄准最近的对手，发射一枚攻击力 ${SKILL_PARAMS.shot.damage} 的特效小球。`,
  trigger: { type: 'cooldown', cd: SKILL_PARAMS.shot.cooldown },
  run(ctx) {
    const { battle, unit, target } = ctx;
    if (!target) return false;                 // 没有对手就不发动
    const P = SKILL_PARAMS.shot;
    const dx = target.x - unit.x, dy = target.y - unit.y;
    const d = Math.hypot(dx, dy) || 1;
    const spd = P.speed * SCALE;
    battle._spawnProjectile({
      kind: 'shot',
      owner: unit,
      x: unit.x,
      y: unit.y,
      vx: Math.round((dx / d) * spd),
      vy: Math.round((dy / d) * spd),
      damage: P.damage,
      radius: Math.round(P.radius * SCALE),
      life: P.life,
      color: P.color
    });
    return true;
  }
};

/* ------------------------------------------------------------
   技能二：撞墙后停止移动 → 蓄力 2 秒 → 加速冲向对手
   ------------------------------------------------------------
   加速状态持续 2 秒，期间速度线性衰减回常速；
   加速期间碰撞伤害提升到 200，并把命中的对手推开。
   ------------------------------------------------------------ */
export const SKILL_DASH = {
  id: 'test_dash',
  name: '撞墙蓄力冲刺',
  desc: `撞到场地边界时停止移动并蓄力 ${SKILL_PARAMS.dash.chargeTime} 秒，` +
        `随后以 ${SKILL_PARAMS.dash.startSpeedMul} 倍速度冲向对手，` +
        `加速持续 ${SKILL_PARAMS.dash.dashTime} 秒并逐渐减速回常速；` +
        `加速期间碰撞伤害为 ${SKILL_PARAMS.dash.damage}，且会把对手推远。`,
  trigger: { type: 'onWall' },
  run(ctx) {
    const { battle, unit } = ctx;
    if (unit.chargeFrames > 0 || unit.dashFrames > 0) return false;   // 已在蓄力/冲刺中
    /* 这里只登记"要蓄力多少帧"，不直接改 mode。
       撞墙那一帧球还在墙上（位置是这一帧刚夹紧过去的），
       如果这一帧就标成 charging，"蓄力"就会多算 1 帧。
       交给 core.js 的状态机在下一帧统一进入 charging，
       这样 charging 状态的帧数恒等于 CHARGE_FRAMES。 */
    unit.chargeFrames = CHARGE_FRAMES;
    unit.vx = 0;
    unit.vy = 0;
    battle._emit('chargeStart', unit, null, SKILL_PARAMS.dash.chargeTime);
    return true;
  }
};

/* ============================================================
   晕彩 · 七个技能（作者设计，2026-10 版）
   ------------------------------------------------------------
   基础数值：HP 1500 / 速度 120 / **没有碰撞伤害**。
   每局最多装配 3 个（见 balls.js 的 MAX_SKILLS_PER_UNIT），
   所以每个技能都必须能独立工作，不能靠"反正另一个一定在"。

   ⚠️ 每个技能有两套描述：
   · `desc`       —— **作者给的官方措辞，逐字照抄**，界面上默认显示这一套；
   · `descDetail` —— 把机制与数值全部展开的"详细版"，由界面上的开关切换。
   详细版是给要抠数值的人看的，所以里面写着具体参数；
   改参数时**两套都要回来同步**，否则就成了假说明。

   贯穿全部技能的两个概念：
     · **"光"特质**：魔弹、激光、光炮、裁光细线的爆炸、开华的月牙斩击
       都带这个标签。裁光的细线只对"光"起反应；
       开华的 +50 也只加在带"光"的攻击上。
     · **伤害倍率 damageMul**：析光分身的"所有伤害三分之一"就是靠它，
       1/3 乘在最后，所以分身用同一套技能代码就自动弱化。
   ============================================================ */

export const YUNCAI = {
  /* ① 裁光 */
  caiguang: {
    /* 质点是个很小的黑点，细线很细 —— 画面上一大片粗黑线会把场地糊住。
       视觉尺寸与判定尺寸用同一个数：看起来多细，判定就是多细
       （这个项目早期吃过"看着没碰到却在掉血"的亏，两者绝不能分开调）。 */
    moteR: 2.6,               // 质点半径（判定 + 绘制）
    lineHalfW: 0.6,           // 细线半宽（判定 + 绘制，即线宽 1.2）
    dmgByStage: [1, 2],       // 每帧接触伤害：漆黑 1 → 深紫 2
    boom: 300,                // 微光阶段被敌方触碰时的爆炸伤害（带"光"）
    stageSeconds: 7.5,        // 辉光领域内自动进阶的间隔
    /* 每个晕彩同时最多留几条细线（超出就顶掉最早的那条）。
       为什么必须有这个上限：细线不会自然消失，只会被踩爆；
       一场 5 分钟的对局能撞墙上百次，细线会无限累积。
       实测（全技能一起装的极端情况）场上会堆到几千条，
       而每帧都要做「细线 × 小球」的线段距离检测 ——
       复杂度 O(线数 × 球数)，直接把模拟拖到跑不完。
       8 条对正常对局完全够用（3 秒一条也要 24 秒才填满）。 */
    maxLines: 8,
  },

  /* ② 魔弹 */
  modan: {
    cd: 2, dmg: 75, speed: 500, r: 6, life: 4, color: '#c4b5fd',
    hitsToLaser: 2,
    /* 淡紫魔力球的美术（作者给的图）：亮核在右、尾迹在左的彗星。
       判定是半径 6 的圆（直径 12）。
       **spriteLen 由作者定，改过两次：30 → 15（"改成现在的一半左右"）
       → 20（"魔弹尺寸统一改到 20"）。**
       20 正好等于第三发光柱的粗细（`laserWidth`），所以魔弹的两种形态
       在画面上是同一个尺寸感 —— 这也是"统一到 20"最自然的结果。
       比判定直径（12）大，所以是"看到的球 ≥ 能打中的范围"，
       不会出现"看着没碰到却在掉血"。 */
    sprite: 'assets/characters/yuncai_bolt.png',
    spriteLen: 20,
    /* 光效环绕的颜色（画在贴图下面的一层半透明光晕）。
       挑中等饱和度的紫：场地是浅色方格纸，淡白的光晕在白纸上等于没画。
       **不配 spritePulse = 这一枚不呼吸**（作者：只有蝙蝠要呼吸）。 */
    spriteGlow: '#a855f7',
    /* 不呼吸：这一枚的图恒为完全不透明（只有蝙蝠呼吸） */
    spritePulse: false,
    /* 贴图相对**判定中心**的偏移（世界单位，弹道局部坐标：+x 朝前、+y 朝飞行方向的右手侧）。
       判定中心就是弹道的位置（物理上用那个点做碰撞），所以"图偏了"要记在这里：
       0 = 图正好套在判定圆上。彗星状的图（亮核在右、尾迹在左）把 x 调大一点，
       亮核才会压在判定圆上。编辑器里直接拖判定圆就能改这两个数。 */
    spriteOffX: -2,
    spriteOffY: -0.5,
    laserDmg: 150, laserSpeed: 1000, laserColor: '#e9d5ff',
    /* 第三发是一道**锚定在晕彩身上、贯穿战场的光柱**。
       长度取 1400：所有场地 × 所有尺寸里最长的对角线是 1266，
       取比它更大就一定能从场地这头穿到那头。
       速度只剩"方向"的含义 —— 光柱不飞，位置每帧从晕彩身上抄。 */
    laserLen: 1400,
    laserLife: 0.5,        // 只持续半秒
    /* 激光的粗细（世界单位，小球直径是 32）。
       注意这里只定义一次，渲染与判定都读它 —— 判定半径 = 宽度的一半。
       之前因为一个单位 bug，宽度被算成 0.016，画出来是一根看不见的头发丝，
       所以看上去"太细"其实不只是数值问题。 */
    laserWidth: 20,
  },

  /* ③ 折光 */
  zheguang: { melee: 100, stealthSeconds: 1 },

  /* ④ 开华 */
  kaihua: {
    hpBelow: 499,             // 血量小于 500 时发动
    heal: 300, speed: 150,
    lightBonus: 50,           // 所有"光"攻击 +50
    meleeBonus: 50,           // 碰撞伤害 +50（折光的 100 → 150）
  },

  /* ⑤ 棱镜 */
  prism: {
    cd: 3, gateLife: 3, gateR: 26,
    gateLead: 90,             // 光门落在"敌人前方多远"处
    cannonDmg: 200, cannonSpeed: 420, cannonR: 7, cannonLife: 4,
    splitBonus: 15,           // 分裂出来的激光只吃 +15，不是 +50
    laserDmg: 50, laserSpeed: 400, laserWidth: 10, shardDmg: 20, shardSpeed: 300,
  },

  /* ⑥ 辉光领域 */
  domain: { dodge: 0.15, dodgeBloomed: 0.24 },

  /* ⑦ 析光 */
  xiguang: {
    firstDelay: 5, cd: 10, costRatio: 0.25,
    miniHp: 500, miniSpeed: 120, miniDamageMul: 1 / 3,
    miniScale: 0.5,           // 分身半径 = 本体的一半
  },
};

/* ------------------------------------------------------------
   ① 裁光：撞墙留下漆黑质点，两个质点连成细线
   ------------------------------------------------------------
   场上每凑够两个质点就连成一条线并消耗掉质点；
   质点和细线都会对**接触到的敌对小球**每帧造成伤害。
   细线只吃敌方的"光"：吃一次变深紫（2/帧），
   吃两次开始微微闪光，此时被敌方碰到就爆炸（300，也带"光"）并消失。
   ------------------------------------------------------------ */
export const SKILL_CAIGUANG = {
  id: 'yuncai_caiguang',
  name: '裁光',
  desc: '每两次碰撞墙体留下一道细线，造成1点的帧伤；被光命中后转化为紫色，' +
        '造成2点的帧伤；再次被光命中后，会在碰撞时造成300点伤害并消失。' +
        '最多保留8条细线。',
  descDetail: `触碰墙壁时，在**球与墙面的接触点**留下一个漆黑的质点；场上出现两个质点时，` +
        `两点之间连成一条黑色细线并消耗掉这两个质点。` +
        `质点与细线都会对接触到的敌对小球每帧造成 ${YUNCAI.caiguang.dmgByStage[0]} 点伤害。` +
        `细线会吸收任何来源的"光"（包括晕彩自己的魔弹/激光/光炮）：` +
        `吸收一次转为深紫，每帧伤害提升到 ${YUNCAI.caiguang.dmgByStage[1]} 点；` +
        `吸收两次后开始微微闪光，此时被敌方触碰就爆炸，造成 ${YUNCAI.caiguang.boom} 点伤害（带"光"）并消失。` +
        `装配辉光领域时，细线每 ${YUNCAI.caiguang.stageSeconds} 秒自动进阶一次（不需要接触"光"）。` +
        `同时最多保留 ${YUNCAI.caiguang.maxLines} 条细线，超出时最早的一条会消散。`,
  trigger: { type: 'onWall' },
  run(ctx) {
    const { battle, unit } = ctx;
    const P = YUNCAI.caiguang;
    /* 质点落点 = 球与墙面的**接触点**，不是球心。
       球心夹紧后离墙面还有 r 那么远，用球心会把质点画在场地中间，
       连出来的细线看着像凭空出现在场里（用户反馈过）。
       ctx.cx / ctx.cy 由引擎在撞墙时算好传进来。 */
    const hasContact = typeof ctx.cx === 'number' && typeof ctx.cy === 'number';
    const mx = hasContact ? Math.round(ctx.cx * SCALE) : unit.x;
    const my = hasContact ? Math.round(ctx.cy * SCALE) : unit.y;

    const prevId = unit.flags.caiguangMote;
    const prev = prevId != null
      ? battle.fields.find(f => f.id === prevId && f.alive && f.kind === 'mote')
      : null;

    if (prev) {
      /* 第二个质点到手：连成细线，并把质点消耗掉 */
      /* 先看看自己已经留了几条线：超上限就顶掉最早的一条，
         否则长对局会把细线堆到几千条，模拟直接跑不动。 */
      const mine = battle.fields.filter(f => f.alive && f.kind === 'line' && f.owner === unit.id);
      if (mine.length >= P.maxLines) {
        const oldest = mine.reduce((a, c) => (c.id < a.id ? c : a), mine[0]);
        oldest.alive = false;
        battle._emit('fieldEnd', null, null, 0, {
          kind: 'line', px: oldest.x / SCALE, py: oldest.y / SCALE, reason: 'overflow'
        });
      }
      const line = battle._spawnField({
        kind: 'line', owner: unit,
        x: prev.x, y: prev.y, x2: mx, y2: my,
        halfW: P.lineHalfW,
        damageByStage: P.dmgByStage,
        boomDamage: P.boom,
        /* 装了辉光领域才会自动进阶 —— 这是作者给的联动 */
        stageTimerMax: unit.skills.includes('yuncai_domain')
          ? Math.round(P.stageSeconds / DT) : 0,
      });
      prev.alive = false;
      unit.flags.caiguangMote = null;
      battle._emit('lineForm', unit, null, 0, {
        px: line.x / SCALE, py: line.y / SCALE,
        x2: line.x2 / SCALE, y2: line.y2 / SCALE,
      });
    } else {
      const m = battle._spawnField({
        kind: 'mote', owner: unit, x: mx, y: my,
        r: P.moteR, damage: P.dmgByStage[0],
      });
      unit.flags.caiguangMote = m.id;
      battle._emit('moteDrop', unit, null, 0, { px: mx / SCALE, py: my / SCALE });
    }
    return true;
  }
};

/* ------------------------------------------------------------
   ② 魔弹：每 2 秒一发淡紫魔力球；累计命中两次后，下一发变激光
   ------------------------------------------------------------ */
/* ------------------------------------------------------------
   魔弹与激光的"发射原语" —— 晕彩的②与见晴的③**共用这一份**
   ------------------------------------------------------------
   见晴的「水镜·魔力共鸣（深蓝紫 / 白）」按作者设定就是"借晕彩的魔弹技能"，
   只有参数不同（伤害 / 弹速 / 间隔 / 颜色），行为必须完全一致。
   两份各写一遍迟早会漂（本项目在"五连发扇形"上吃过一次亏：
   预览画 14°、真正飞出去 24°），所以发射逻辑只此一份，两边都调它。
   ------------------------------------------------------------ */
function spawnModanBullet(battle, unit, target, spec) {
  /* 方向：玩家操控时是鼠标方向，否则朝目标（见 core.js 的 aimUnit） */
  const { ux, uy } = battle.aimUnit(unit, target);
  const spd = spec.speed * SCALE;
  battle._spawnProjectile({
    kind: 'aura', tag: 'modan', owner: unit,
    x: unit.x, y: unit.y,
    vx: Math.round(ux * spd), vy: Math.round(uy * spd),
    damage: battle._lightDamage(unit, spec.damage, spec.lightBonus),
    radius: Math.round(spec.r * SCALE),
    life: spec.life, color: spec.color, traits: ['light'],
    sprite: spec.sprite, spriteLen: spec.spriteLen,
    spriteGlow: spec.spriteGlow, spritePulse: spec.spritePulse,
    spriteOffX: spec.spriteOffX, spriteOffY: spec.spriteOffY,
    onHit: spec.onHit, onAbsorb: spec.onAbsorb,
  });
}

/** 贯穿光柱：一端钉在施法者身上、朝发射那一刻的方向铺出去，每个目标只结算一次 */
function spawnLaserBeam(battle, unit, target, spec) {
  const { ux, uy } = battle.aimUnit(unit, target);
  const spd = spec.speed * SCALE;
  battle._spawnProjectile({
    kind: 'aura', tag: 'laser', owner: unit,
    x: unit.x, y: unit.y,
    vx: Math.round(ux * spd), vy: Math.round(uy * spd),
    damage: battle._lightDamage(unit, spec.damage, spec.lightBonus),
    /* 碰撞半径只用于"撞墙夹紧"；它锚在施法者身上，而人永远离墙 ≥ 半径，
       所以这道光柱不会因为贴墙而消失。真正的伤害走胶囊判定。 */
    radius: Math.round(2 * SCALE),
    width: spec.width,
    beam: true,
    beamForward: true,        // 从身上**向前**画（普通激光是往后画拖影）
    beamLen: spec.len,
    anchor: unit.id,          // 一端始终钉在身上
    /* 刻意**不设 anchorTarget** —— 设了就会每帧朝目标转向 */
    noBodyHit: true,          // 不走"贴到就爆"的弹体命中
    sweepOnce: true,          // 每个目标只结算一次
    absorbable: false,        // 穿过细线，但仍然喂它"光"
    life: spec.life,
    color: spec.color, traits: ['light'],
  });
}

export const SKILL_MODAN = {
  id: 'yuncai_modan',
  name: '魔弹',
  desc: '每两秒发射一发魔力球，累计命中两次后，下一发改为发射更强大的激光。',
  descDetail: `每 ${YUNCAI.modan.cd} 秒瞄准最近的敌人发射一枚淡紫色魔力球` +
        `（速度 ${YUNCAI.modan.speed}，伤害 ${YUNCAI.modan.dmg}，带"光"）。` +
        `命中判定包括两种：打中敌方小球，以及**被裁光的细线吸收** —— 两种都算一次命中。` +
        `累计命中 ${YUNCAI.modan.hitsToLaser} 次后，下一发改为**贯穿战场的光柱**` +
        `（伤害 ${YUNCAI.modan.laserDmg}，宽度 ${YUNCAI.modan.laserWidth}，带"光"）：` +
        `一端钉在晕彩身上、朝发射那一刻的方向铺出去 ${YUNCAI.modan.laserLen} 单位，` +
        `持续 ${YUNCAI.modan.laserLife} 秒。` +
        `**不跟随目标**（方向定死），**每个敌人只结算一次**（不会反复掉血）。` +
        `碰到「裁光」的细线时**不会消失**，但仍然提供"光"把细线喂进阶（每条只喂一次）。` +
        `发射后命中计数归零。`,
  trigger: { type: 'cooldown', cd: YUNCAI.modan.cd },
  run(ctx) {
    const { battle, unit, target } = ctx;
    if (!target) return false;                 // 没有对手就不发动，也不吃冷却
    const P = YUNCAI.modan;
    const hits = unit.flags.modanHits || 0;

    if (hits >= P.hitsToLaser) {
      /* 第三发：**贯穿战场的光柱**（形态与缇娜的「公主传承3」同一种）。
         和那道光的区别：
           · 只持续 0.5 秒（缇娜是 2 秒）；
           · **不跟随目标** —— 方向在发射那一刻定死（缇娜的光柱每帧朝目标转）；
           · **只有一次伤害判定** —— 每个目标只结算一下（缇娜是每秒 3 次）。
         相同的部分：一端钉在晕彩身上、向前画成圆柱、
         长度够从场地这头穿到那头、判定与绘制共用同一组 beamLen / width。

         另外两条刻意的设定：
           · absorbable: false —— 碰到裁光的细线**不会消失**，
             但**依然提供"光"**（细线照样进阶，每条只喂一次）；
           · sweepOnce —— 每个敌人只吃一下，不会像 tickDamage 那样反复结算。 */
      unit.flags.modanHits = 0;
      spawnLaserBeam(battle, unit, target, {
        damage: P.laserDmg, speed: P.laserSpeed, life: P.laserLife,
        color: P.laserColor, width: P.laserWidth, len: P.laserLen,
      });
    } else {
      /* 命中计数：打中敌人算一次，**被裁光的细线吸收也算一次** ——
         都是"这发魔力球确实命中了东西"，所以共用一个回调。
         见晴借去的那一枚不数（她不带激光形态）。 */
      const countHit = (b, from) => {
        if (!from) return;
        from.flags.modanHits = (from.flags.modanHits || 0) + 1;
      };
      spawnModanBullet(battle, unit, target, {
        damage: P.dmg, speed: P.speed, r: P.r, life: P.life, color: P.color,
        sprite: P.sprite, spriteLen: P.spriteLen, spriteGlow: P.spriteGlow,
        spritePulse: P.spritePulse, spriteOffX: P.spriteOffX, spriteOffY: P.spriteOffY,
        onHit: countHit, onAbsorb: countHit,
      });
    }
    return true;
  }
};

/* 折光给多少碰撞伤害。写成常量是因为 passive 里要用，
   而 YUNCAI 对象在文件更上面，直接引用也行，这里只是让意图更清楚。 */
const TAOYAO_ZHEGUANG_MELEE = YUNCAI.zheguang.melee;

/* ------------------------------------------------------------
   ③ 折光：被动把碰撞伤害改成 100；每次近战命中后隐身 1 秒
   ------------------------------------------------------------ */
export const SKILL_ZHEGUANG = {
  id: 'yuncai_zheguang',
  name: '折光',  desc: '获得100点的碰撞伤害，碰撞后隐身1秒。',
  descDetail: `碰撞伤害由 0 改为 ${YUNCAI.zheguang.melee}。` +
        `每次成功造成近战伤害后进入隐身，持续 ${YUNCAI.zheguang.stealthSeconds} 秒。` +
        `隐身期间**不会受到敌方小球的近战伤害**，但弹道与场地物件（裁光的质点/细线）照常命中。` +
        `隐身期间画面上的小球会变成半透明并带一圈虚线轮廓。`,
  trigger: { type: 'passive' },
  passive(battle, unit) {
    /* 走 meleeBonus 而不是直接写 unit.melee —— 陀螺会重算碰撞伤害，
       直接写会被覆盖掉（碰撞伤害和速度一样是"基础 + 加成"模型）。 */
    unit.meleeBonus = (unit.meleeBonus || 0) + TAOYAO_ZHEGUANG_MELEE;
    battle.refreshMelee(unit);
  },
  hooks: {
    /* 只有近战命中才触发隐身（技能命中不算）——所以要检查 kind */
    onHit(battle, unit, ctx) {
      if (ctx.kind !== 'melee') return;
      unit.stealthFrames = Math.round(YUNCAI.zheguang.stealthSeconds / DT);
      battle._emit('stealth', unit, null, YUNCAI.zheguang.stealthSeconds);
    }
  }
};

/* ------------------------------------------------------------
   ④ 开华：血量小于 500 时发动，回血 300、提速到 150、所有"光"伤害 +50
   ------------------------------------------------------------ */
export const SKILL_KAIHUA = {
  id: 'yuncai_kaihua',
  name: '开华',
  desc: '血量低于500后发动，恢复300血量，提高速度和伤害。',
  descDetail: `血量降到 ${YUNCAI.kaihua.hpBelow + 1} 以下时发动一次：` +
        `恢复 ${YUNCAI.kaihua.heal} 点血量，速度提高到 ${YUNCAI.kaihua.speed}，` +
        `所有带"光"的攻击伤害 +${YUNCAI.kaihua.lightBonus}，碰撞伤害 +${YUNCAI.kaihua.meleeBonus}` +
        `（只装开华是 0 → ${YUNCAI.kaihua.meleeBonus}，装了折光则 100 → ${100 + YUNCAI.kaihua.meleeBonus}）。` +
        `此后碰撞时附带一道细细的月牙斩击特效（同样带"光"），并换上开华形态的贴图。` +
        `若同时装了辉光领域，闪避率也从 10% 提升到 15%。`,
  trigger: { type: 'onHpBelow', ratio: YUNCAI.kaihua.hpBelow / 1500 },
  run(ctx) {
    const { battle, unit } = ctx;
    if (unit.bloomed) return false;
    const P = YUNCAI.kaihua;
    unit.bloomed = true;
    unit.hp = Math.min(unit.maxHp, unit.hp + P.heal);
    /* 提速必须走速度模型：光写 unit.speed 字段球根本不会变快
       （实际移动看的是 vx/vy，那个是开局定好的）；
       而且要用 speedOverride，否则陀螺一叠层重算就把这个覆盖丢了。 */
    unit.speedOverride = P.speed;
    battle.refreshSpeed(unit);
    unit.lightBonus = P.lightBonus;
    /* 碰撞伤害 +50 同样走加成，不能直接加 u.melee */
    unit.meleeBonus = (unit.meleeBonus || 0) + P.meleeBonus;
    battle.refreshMelee(unit);
    /* 装了辉光领域的话，闪避也从 10% 提到 15% */
    if (unit.skills.includes('yuncai_domain')) unit.dodge = YUNCAI.domain.dodgeBloomed;
    battle._emit('bloom', unit, null, P.heal);
    return true;
  }
};

/* ------------------------------------------------------------
   ⑤ 棱镜：每 3 秒生成一个持续 3 秒的光门，并朝敌人发射一发光炮
   ------------------------------------------------------------
   光门落在"晕彩→敌人"连线上靠近敌人处，光炮朝敌人射，
   所以光炮必然穿过光门 → 分裂成 5 条随机方向的激光（各弹射一次）。
   魔力球（②）穿过光门时同样分裂，变成 5 个弹射一次的小魔力球。
   ------------------------------------------------------------ */
export const SKILL_PRISM = {
  id: 'yuncai_prism',
  name: '棱镜',
  desc: '每3秒生成一个持续3秒的光门并发射一次光炮，晕彩的攻击穿过光门时会一分为五，但减少伤害。',
  descDetail: `每 ${YUNCAI.prism.cd} 秒在"自己与敌人之间、靠近敌人处"生成一个持续 ${YUNCAI.prism.gateLife} 秒的光门，` +
        `随即朝敌人发射一发光炮（伤害 ${YUNCAI.prism.cannonDmg}，带"光"，只有一次判定）。` +
        `光炮穿过光门后会分裂成 5 条随机方向的激光（撞墙弹射一次，每条 ${YUNCAI.prism.laserDmg}，带"光"）。` +
        `魔力球穿过光门则分裂成 5 个弹射一次的小魔力球（每个 ${YUNCAI.prism.shardDmg}）。` +
        `分裂出来的个体吃到的开华加成只有 +${YUNCAI.prism.splitBonus}，不是 +${YUNCAI.kaihua.lightBonus}。`,
  trigger: { type: 'cooldown', cd: YUNCAI.prism.cd },
  run(ctx) {
    const { battle, unit, target } = ctx;
    if (!target) return false;
    const P = YUNCAI.prism;

    /* 这一式的"正前方"：玩家操控时是鼠标方向，否则朝目标。
       光门与光炮共用它 —— 两边必须一致，不然门和炮会各朝一边。 */
    const aim = battle.aimUnit(unit, target);
    const ux = aim.ux, uy = aim.uy;
    const d = Math.hypot(target.x - unit.x, target.y - unit.y) || 1;

    /* 光门：放在敌人前方 gateLead 处，再夹进场地内（不能放到墙外去） */
    const gd = Math.max(40, d / SCALE - P.gateLead);
    const gp = battle.clampPoint(
      unit.x / SCALE + ux * gd, unit.y / SCALE + uy * gd, P.gateR);
    battle._spawnField({
      kind: 'gate', owner: unit,
      x: Math.round(gp.x * SCALE), y: Math.round(gp.y * SCALE),
      r: P.gateR, life: Math.round(P.gateLife / DT),
    });
    battle._emit('gateSpawn', unit, null, P.gateLife, { px: gp.x, py: gp.y });

    /* 紧接着发射光炮（先有门、再有炮，所以这一发必然穿门） */
    const spd = P.cannonSpeed * SCALE;
    battle._spawnProjectile({
      kind: 'aura', tag: 'cannon', owner: unit,
      x: unit.x, y: unit.y,
      vx: Math.round(ux * spd), vy: Math.round(uy * spd),
      damage: battle._lightDamage(unit, P.cannonDmg),
      radius: Math.round(P.cannonR * SCALE),
      life: P.cannonLife, color: '#f5d0fe', traits: ['light'],
    });
    return true;
  }
};

/* ------------------------------------------------------------
   ⑥ 辉光领域：装上就常驻生效
   ------------------------------------------------------------ */
export const SKILL_DOMAIN = {
  id: 'yuncai_domain',
  name: '辉光领域',
  desc: `整个场地被极光覆盖。晕彩全程有 ${Math.round(YUNCAI.domain.dodge * 100)}% 的概率闪避攻击，` +
        `开华后提升到 ${Math.round(YUNCAI.domain.dodgeBloomed * 100)}%。` +
        `领域内裁光的细线即使没有接触"光"，也会每 ${YUNCAI.caiguang.stageSeconds} 秒自动进入下一阶段。`,
  descDetail: `整个场地被极光覆盖。晕彩全程有 ${Math.round(YUNCAI.domain.dodge * 100)}% 的概率闪避攻击，` +
        `开华后提升到 ${Math.round(YUNCAI.domain.dodgeBloomed * 100)}%。` +
        `闪避是对**任何来源**的攻击都生效（近战、弹道、场地物件都算），` +
        `但裁光质点/细线的每帧接触伤害属于"持续接触"，不参与闪避判定。` +
        `领域内裁光的细线即使没有接触"光"，也会每 ${YUNCAI.caiguang.stageSeconds} 秒自动进入下一阶段。` +
        `这是常驻被动：装上就一直生效，没有持续时间与冷却。`,
  trigger: { type: 'passive' },
  passive(battle, unit) {
    unit.dodge = unit.bloomed ? YUNCAI.domain.dodgeBloomed : YUNCAI.domain.dodge;
    /* 渲染层画"气浪展开"要用的三个量，只在**第一次**激活时写。
       为什么必须判一次：析光的分身也带这个技能，它的被动会再跑一遍 ——
       不判的话分身一出生就把 auroraAt 改成"现在"、auroraCenter 改成分身的位置，
       整场极光会突然重放一次气浪（而且是从分身那一侧扫过来）。
       另外 `unit.domain` 必须存在：早期 _spawnSummon 漏拷了这个字段，
       于是分身的被动把 auroraStyle 覆盖成 null → **极光整个消失**（看着像领域失效）。 */
    if (!battle.aurora) {
      battle.aurora = true;
      battle.auroraAt = battle.frame;
      /* 中心是**固定**的：气浪从晕彩当时的位置向外扩散到铺满全场；
         若让它跟着晕彩走，离她远的那半边就永远扫不到。 */
      battle.auroraCenter = { x: unit.x, y: unit.y };
    }
    battle.auroraStyle = battle.auroraStyle || unit.domain || null;
    battle._emit('domainOn', unit, null, 0, { px: unit.x / SCALE, py: unit.y / SCALE });
  }
};

/* ------------------------------------------------------------
   ⑦ 析光：扣掉当前血量的 1/4，召唤一个弱化分身
   ------------------------------------------------------------
   分身带的是"本体携带的另外两个技能"（因为每局最多装 3 个，另外两个就是全部其余技能），
   所有伤害数值乘 1/3 后四舍五入 —— 靠 unit.damageMul 实现，
   技能代码一行都不用改。
   分身不带析光本身，所以不会无限分裂。
   ------------------------------------------------------------ */
export const SKILL_XIGUANG = {
  id: 'yuncai_xiguang',
  name: '析光',
  desc: '开场5秒后召唤分身，之后每十秒召唤一次。每次召唤消耗当前血量的四分之一。' +
        '分身拥有更低的属性，并拥有本体携带的另两个技能。',
  descDetail: `开场 ${YUNCAI.xiguang.firstDelay} 秒后召唤第一个分身，之后每 ${YUNCAI.xiguang.cd} 秒一次。` +
        `每次消耗**当前**血量的四分之一（血量最低保留 1 点，不会把自己耗死）。` +
        `分身半径是本体的一半（质量按半径平方算，所以只有 1/4，撞起来明显更轻）、` +
        `血量上限 ${YUNCAI.xiguang.miniHp}、速度 ${YUNCAI.xiguang.miniSpeed}，` +
        `携带本体的另外两个技能（不含析光本身，所以不会无限分裂），` +
        `但所有伤害数值为原本的三分之一（小数四舍五入，通过伤害倍率实现，` +
        `连碰撞伤害与每帧伤害也一起弱化）。`,
  trigger: { type: 'cooldown', cd: YUNCAI.xiguang.cd },
  run(ctx) {
    const { battle, unit } = ctx;
    const P = YUNCAI.xiguang;
    if (battle.time < P.firstDelay) return false;    // 开场 5 秒内不发动
    /* 消耗当前血量的 1/4，但至少留 1 点 —— 分身是队友，不该把自己祭了 */
    const cost = Math.min(Math.floor(unit.hp * P.costRatio), Math.max(0, unit.hp - 1));
    if (cost <= 0) return false;
    unit.hp -= cost;
    battle._emit('hpCost', unit, null, cost);

    const PX = YUNCAI.prism;
    /* 分身带另外两个技能（排除析光自己） */
    const inherited = unit.skills.filter(id => id !== SKILL_XIGUANG.id);
    /* 出生点：朝敌人方向的垂直方向偏开一点，避免和本体叠在一起 */
    const tgt = battle._nearestEnemy(unit);
    let ox = 0, oy = 0;
    if (tgt) {
      const dx = tgt.x - unit.x, dy = tgt.y - unit.y;
      const d = Math.hypot(dx, dy) || 1;
      const off = (unit.r / SCALE) * 2 + 6;
      ox = (-dy / d) * off; oy = (dx / d) * off;
    }
    const sp = battle.clampPoint(unit.x / SCALE + ox, unit.y / SCALE + oy, unit.r / SCALE);
    const mini = battle._spawnSummon(unit, {
      maxHp: P.miniHp,
      speed: P.miniSpeed,
      /* 分身体积是本体的一半：半径减半，质量按半径平方算所以是 1/4，
         撞起来也会明显更"轻"。 */
      r: (unit.r / SCALE) * P.miniScale,
      sticker: unit.sticker,
      stickerBloom: unit.stickerBloom,
      skills: inherited,
      damageMul: P.miniDamageMul,
      x: Math.round(sp.x * SCALE),
      y: Math.round(sp.y * SCALE),
      vx: unit.vx, vy: unit.vy,        // 继承本体当前的航向
    });
    /* 被动与钩子的安装由 _spawnSummon 内部统一处理（见 core.js 的 _initUnitSkills），
       这里不需要再补一遍。 */
    battle._emit('xiguangSplit', unit, mini, cost);
    return true;
  }
};

/* ============================================================
   桃夭 · 五个技能（作者设计，2026-10 版）
   ------------------------------------------------------------
   基础数值：HP 1750 / 速度 120 / 碰撞伤害 66。
   ① 映霞[荣] 与 ② 映霞[枯] **互斥**：同一 group，只能选一个。
   （每局仍是最多装配 3 个，所以桃夭实际是"荣或枯 + 另外两个"。）

   几个只在桃夭身上出现的机制：
     · **箭矢落空**：弹道撞墙或到寿命都没碰到球 = 落空，
       用来驱动"认真拉矢"的掉层。
     · **被攻击**：只有一次性打击（近战/弹道/爆炸）才算，
       裁光那种每帧接触伤害不算 —— 否则叠层瞬间满，等于没设计。
     · **旋转**：陀螺层数驱动，角度进快照，暂停回放时旋转也冻得住。
   ============================================================ */
export const TAOYAO = {
  /* ① 映霞[荣]：连射 + 五连发 */
  rong: {
    cd: 1, damage: 50, speed: 500, r: 5, life: 1.6, color: '#f9a8d4',
    /* 击退已按作者要求去掉（原本 60）。
       引擎的 knockback 原语保留 —— 诊断夹具里那颗"技能测试球"的定点射击还在用，
       以后哪个技能要击退，直接在这里加回一个数就行。 */
    burstEvery: 5,          // 射 5 次之后
    burstCount: 5,          // 下一次连发 5 支
    burstDmg: 30,
    burstSpread: 0.42,      // 五连发的扇形张角（弧度，总张角的一半）
  },

  /* ② 映霞[枯]：黑白箭 + 减速 */
  ku: {
    cd: 2, damage: 65, speed: 550, r: 5, life: 2.0, color: '#6b7280',
    slow: 20, slowSeconds: 2,
  },

  /* ③ 认真拉矢：命中叠层、落空掉层 */
  aim: {
    perStack: 5, maxStacks: 10, losePerMiss: 2,
  },

  /* ④ 春景：自我 buff */
  chunjing: {
    cd: 10, duration: 5, healPerSec: 10,
    cannonEvery: 2.5, cannonDmg: 180, cannonSpeed: 420, cannonR: 7,
    cannonLife: 3, color: '#fbcfe8',
  },

  /* ⑤ 陀螺：被打击叠层 */
  top: {
    maxStacks: 10,
    meleePer: 2, speedPer: 2,
    /* 回血已按作者要求去掉（原本每层 +1 血/秒）。
       层数现在只驱动"碰撞伤害 / 移速 / 转速"三件事。 */
    /* 每层旋转速度见 core.js 的 SPIN_RATE_PER_STACK */
  },

  /* 两式各有一支箭（作者分别给了图）。
     注意**两张原图的方向本来不一样**：荣的是横的、箭尖朝右；
     枯的是竖的、箭尖朝上 —— 构建脚本已经统一转成朝右，
     所以运行时只管按飞行方向旋转，不必再记"哪张要额外转 90°"。 */
  arrowSprite: 'assets/characters/taoyao_arrow.png',
  kuArrowSprite: 'assets/characters/taoyao_ku_arrow.png',
  /* 两支箭的光效环绕颜色：荣是粉箭 → 粉光；枯是黑白箭 → 灰墨光。
     同样是中等饱和度（场地是浅色方格纸）。 */
  arrowGlow: '#ec4899',
  arrowPulse: false,
  /* 箭矢贴图相对判定中心的偏移（世界单位，局部坐标 +x 朝前） */
  arrowOffX: -15,
  arrowOffY: 0,
  kuArrowGlow: '#64748b',
  kuArrowPulse: false,
  kuArrowOffX: -15,
  kuArrowOffY: 0,
  /* 两式分别用哪一套弓的美术（索引对应 balls.js 的 bow.arts）。
     和 bow.kindArt 是同一张表 —— 那边按 castKind 查、这边按技能直接取。 */
  RONG_ART: 0,
  KU_ART: 1,
};

/* 单位身上有没有装「认真拉矢」。
   为什么必须查一下：叠层是挂在**箭矢的命中回调**上的，
   而箭矢不管装没装认真拉矢都会发射。不查的话，
   没装这个技能的桃夭照样在偷偷叠层加伤害 —— 实测满层时箭矢打出了 80 而不是 50。 */
function hasAim(unit) {
  return !!(unit && unit.skills && unit.skills.includes(SKILL_AIM.id));
}

/** 取"某个技能对应那一套弓的美术"。
 *  bow 有两种写法：单一武器直接就是一套；多武器则是 { kindArt, arts }。
 *  这里按索引取，取不到就回落第一套（宁可画错武器，也别让弓整个消失）。 */
function bowArtOf(unit, index) {
  const bow = unit && unit.bow;
  if (!bow) return null;
  return bow.arts ? (bow.arts[index] || bow.arts[0]) : bow;
}

/** 这支箭该画多长：**弓高 × 那套美术自己的箭长比例**。
 *  两式的弓高一样、但箭长比例不同（荣 0.3415 / 枯 0.3243），
 *  所以不能共用一个数 —— 搭在弓上的箭和飞出去的箭必须等长。 */
function arrowLenOf(unit, index) {
  const art = bowArtOf(unit, index);
  /* bowH 挂在**每一套美术**上（两把弓各自的尺寸），不是挂在 bow 上 */
  if (!art || !(art.bowH > 0) || !(art.arrowLenFrac > 0)) return 0;
  return art.bowH * art.arrowLenFrac;
}

/* ------------------------------------------------------------
   箭矢的公共部分：映霞两式都靠它发射
   ------------------------------------------------------------ */
function fireArrow(battle, unit, target, spec) {
  /* 方向优先级：spec.aim（调用方直接给了方向，例如五连发那一发）
     → 玩家鼠标方向 → 朝目标。 */
  const aim = spec.aim || battle.aimUnit(unit, target);
  const { ux, uy } = aim;
  const spd = spec.speed * SCALE;
  const stacks = hasAim(unit) ? (unit.flags.aimStacks || 0) : 0;
  /* 认真拉矢：每层 +5，只作用于箭矢（春景的光炮不吃） */
  const dmg = Math.max(1, Math.round(
    (spec.damage + TAOYAO.aim.perStack * stacks) * (unit.damageMul ?? 1)));
  battle._spawnProjectile({
    kind: 'aura', tag: 'arrow', owner: unit,
    sprite: spec.sprite || null,      // 有贴图就画成真箭，没有就回退程序化光点
    /* 箭矢画多长：**弓高 × 这一式自己的箭长比例**。
       这样"搭在弓上的箭"和"飞出去的箭"永远等长，改 bowH 也不用两头改。 */
    spriteLen: spec.spriteLen ?? arrowLenOf(unit, TAOYAO.RONG_ART),
    /* 光效环绕的颜色：默认按"哪一式的箭"给（荣粉 / 枯灰），
       调用方要用别的颜色也能覆盖。 */
    spriteGlow: spec.spriteGlow || TAOYAO.arrowGlow,
    spritePulse: spec.spritePulse ?? TAOYAO.arrowPulse,
    spriteOffX: spec.spriteOffX ?? TAOYAO.arrowOffX,
    spriteOffY: spec.spriteOffY ?? TAOYAO.arrowOffY,
    x: unit.x, y: unit.y,
    vx: Math.round(ux * spd), vy: Math.round(uy * spd),
    damage: dmg,
    radius: Math.round(spec.r * SCALE),
    life: spec.life, color: spec.color,
    knockback: spec.knockback || 0,
    /* 命中 → 认真拉矢 +1 层（没装这个技能就不叠） */
    onHit: (b, from) => {
      if (!hasAim(from)) return;
      from.flags.aimStacks = Math.min(TAOYAO.aim.maxStacks, (from.flags.aimStacks || 0) + 1);
      b._emit('aimStack', from, null, from.flags.aimStacks);
    },
    /* 落空（撞墙或到寿命都没碰到球）→ -2 层 */
    onMiss: (b, from) => {
      if (!hasAim(from)) return;
      const before = from.flags.aimStacks || 0;
      if (before <= 0) return;
      from.flags.aimStacks = Math.max(0, before - TAOYAO.aim.losePerMiss);
      b._emit('aimMiss', from, null, from.flags.aimStacks);
    },
  });
}

/* ------------------------------------------------------------
   ① 映霞[荣]：每 1 秒一支粉色箭矢；射满 5 次后下一次改为一轮五连发
   ------------------------------------------------------------ */
export const SKILL_RONG = {
  id: 'taoyao_rong',
  name: '映霞[荣]',
  group: 'yingxia',
  /* 动作动画的两个开关（引擎在 _initUnitSkills 里读，见 core.js）：
       aims   —— 这个技能"朝最近的敌人"出手，所以引擎每帧算一个瞄准角进快照；
       windup —— 射出前的动作时长（秒）。引擎据此算出 castP（0→1，射出那一帧 = 1），
                 渲染层拿它摆"拉弓"的姿势。
     为什么 windup 是 0.4 而不是等于 cd：拉弓只该占冷却的最后一段，
     否则弓会一直拉着，看起来像卡住了。 */
  aims: true,
  windup: 0.4,
  /* 五连发是"同一种拉弓动作的另一个版本"：时长完全一样，
     区别只在于画面上要多排四根箭。光看 castP 分不出这两种，
     所以由这里告诉引擎"这一发是变体 1"（见 core.js 的 castKind）。 */
  castKind(unit) {
    const P = TAOYAO.rong;
    return ((unit.flags.rongShots || 0) + 1 > P.burstEvery) ? 1 : 0;
  },
  /* 简要描述 = **作者给的官方措辞**（2026-10 定稿），不要在这里加数值细节 ——
     要展开机制与数字请改 descDetail（图鉴里有"简要 / 详细"切换）。 */
  desc: '每秒射一根箭，射五次后下一发变为五连发散射。',
  descDetail: `每 ${TAOYAO.rong.cd} 秒瞄准最近的敌人发射一支粉色箭矢` +
        `（速度 ${TAOYAO.rong.speed}，伤害 ${TAOYAO.rong.damage}，**没有击退**）。` +
        `射出 ${TAOYAO.rong.burstEvery} 支之后，下一轮改为**一次齐射 ${TAOYAO.rong.burstCount} 支**` +
        `（扇形散开，每支伤害降到 ${TAOYAO.rong.burstDmg}），随后重新计数。` +
        `与「映霞[枯]」互斥，两个只能选一个。`,
  trigger: { type: 'cooldown', cd: TAOYAO.rong.cd },
  run(ctx) {
    const { battle, unit, target } = ctx;
    if (!target) return false;
    const P = TAOYAO.rong;
    const fired = (unit.flags.rongShots || 0) + 1;
    if (fired > P.burstEvery) {
      /* 五连发：朝目标扇形散开（玩家操控时这个"基准方向"是鼠标方向） */
      unit.flags.rongShots = 0;
      const aim = battle.aimUnit(unit, target);
      const base = Math.atan2(aim.uy, aim.ux);
      const n = P.burstCount;
      for (let i = 0; i < n; i++) {
        const off = (n === 1) ? 0 : (i / (n - 1) * 2 - 1) * P.burstSpread;
        const ang = base + off;
        const dx = Math.cos(ang), dy = Math.sin(ang);
        /* ⚠ 这里必须**显式**把方向交给 fireArrow（spec.aim）：
           以前是塞一个 1000 单位外的假目标当方向载体，而 fireArrow 现在
           会优先看鼠标方向 —— 不显式给方向的话，五支箭会全部叠向鼠标，
           扇形直接消失（作者一眼就能看出来）。 */
        fireArrow(battle, unit, null, {
          ...P, aim: { ux: dx, uy: dy },
          damage: P.burstDmg, knockback: 0, sprite: TAOYAO.arrowSprite,
        });
      }
      battle._emit('arrowBurst', unit, target, n);
    } else {
      unit.flags.rongShots = fired;
      fireArrow(battle, unit, target, { ...P, sprite: TAOYAO.arrowSprite });
    }
    return true;
  }
};

/* ------------------------------------------------------------
   ② 映霞[枯]：每 2 秒一支黑白箭矢，命中后目标移速 -20 持续 2 秒
   ------------------------------------------------------------ */
export const SKILL_KU = {
  id: 'taoyao_ku',
  name: '映霞[枯]',
  group: 'yingxia',
  aims: true,
  windup: 0.4,
  /* 施法变体 2 = "用第二套弓的美术"（枯的墨色花枝弓）。
     荣是 0（普通）/ 1（五连发），所以变体号同时也是"换哪张弓"的索引，
     两边共用 balls.js 的 bow.kindArt 那张表。 */
  castKind() { return 2; },
  desc: '每两秒射一根箭，命中后造成两秒的减速。',
  descDetail: `每 ${TAOYAO.ku.cd} 秒瞄准最近的敌人发射一支黑白箭矢` +
        `（速度 ${TAOYAO.ku.speed}，伤害 ${TAOYAO.ku.damage}）。` +
        `命中后目标移动速度 −${TAOYAO.ku.slow}，持续 ${TAOYAO.ku.slowSeconds} 秒（可刷新）。` +
        `减速走引擎的速度模型（基础速度 + 加成 − 减益），` +
        `所以和陀螺的加速、开华的提速是叠加而不是互相覆盖。` +
        `与「映霞[荣]」互斥，两个只能选一个。`,
  trigger: { type: 'cooldown', cd: TAOYAO.ku.cd },
  run(ctx) {
    const { battle, unit, target } = ctx;
    if (!target) return false;
    const P = TAOYAO.ku;
    const dx = target.x - unit.x, dy = target.y - unit.y;
    const d = Math.hypot(dx, dy) || 1;
    const spd = P.speed * SCALE;
    const stacks = hasAim(unit) ? (unit.flags.aimStacks || 0) : 0;
    battle._spawnProjectile({
      kind: 'aura', tag: 'arrow', owner: unit,
      /* 枯有自己的黑白箭（荣那支是粉的），长度也按枯那套弓算 */
      sprite: TAOYAO.kuArrowSprite,
      spriteLen: arrowLenOf(unit, TAOYAO.KU_ART),
      spriteGlow: TAOYAO.kuArrowGlow,
      spritePulse: TAOYAO.kuArrowPulse,
      spriteOffX: TAOYAO.kuArrowOffX,
      spriteOffY: TAOYAO.kuArrowOffY,
      x: unit.x, y: unit.y,
      vx: Math.round((dx / d) * spd), vy: Math.round((dy / d) * spd),
      damage: Math.max(1, Math.round((P.damage + TAOYAO.aim.perStack * stacks) * (unit.damageMul ?? 1))),
      radius: Math.round(P.r * SCALE),
      life: P.life, color: P.color,
      onHit: (b, from, to) => {
        /* 认真拉矢：命中 +1 层（没装这个技能就不叠） */
        if (hasAim(from)) {
          from.flags.aimStacks = Math.min(TAOYAO.aim.maxStacks, (from.flags.aimStacks || 0) + 1);
          b._emit('aimStack', from, null, from.flags.aimStacks);
        }
        /* 减速：走速度模型，带时限（到期由 core 的计时器撤掉） */
        if (to && to.alive) {
          to.speedSlow = -P.slow;
          to.speedSlowFrames = Math.round(P.slowSeconds / DT);
          b.refreshSpeed(to);
          b._emit('slow', to, null, P.slow);
        }
      },
      onMiss: (b, from) => {
        if (!hasAim(from)) return;
        const before = from.flags.aimStacks || 0;
        if (before <= 0) return;
        from.flags.aimStacks = Math.max(0, before - TAOYAO.aim.losePerMiss);
        b._emit('aimMiss', from, null, from.flags.aimStacks);
      },
    });
    return true;
  }
};

/* ------------------------------------------------------------
   ③ 认真拉矢：被动（叠层逻辑写在箭矢的 onHit / onMiss 里，这里只做说明）
   ------------------------------------------------------------ */
export const SKILL_AIM = {
  id: 'taoyao_aim',
  name: '认真拉矢',
  desc: '被动技能。每次箭矢命中叠加五点伤害，最多叠加十层，箭矢落空后降低两层。',
  descDetail: `被动。每支箭矢**命中**后层数 +1（下一发伤害 +${TAOYAO.aim.perStack}），` +
        `最多 ${TAOYAO.aim.maxStacks} 层（即最多 +${TAOYAO.aim.maxStacks * TAOYAO.aim.perStack} 伤害）；` +
        `箭矢**落空**（撞墙或到寿命都没碰到球）时层数 −${TAOYAO.aim.losePerMiss}，最低 0 层。` +
        `只作用于映霞的箭矢 —— 春景的淡粉色光炮不吃这个加成，也不叠层。`,
  trigger: { type: 'passive' },
  passive(battle, unit) {
    unit.flags.aimStacks = unit.flags.aimStacks || 0;
  }
};

/* ------------------------------------------------------------
   ④ 春景：每 10 秒给自己一个 5 秒 buff（每秒回血 + 每 2.5 秒补一发光炮）
   ------------------------------------------------------------ */
export const SKILL_CHUNJING = {
  id: 'taoyao_chunjing',
  name: '春景',
  desc: '每隔十秒为自己施加五秒的“春景”buff，每秒回复10点生命，每2.5秒发射一次光炮。',
  descDetail: `每 ${TAOYAO.chunjing.cd} 秒给自己施加一次「春景」，持续 ${TAOYAO.chunjing.duration} 秒。` +
        `buff 期间：每秒回复 ${TAOYAO.chunjing.healPerSec} 点生命（回复量用余数累积，` +
        `不会因为每帧不足 1 点而回不上血）；` +
        `每 ${TAOYAO.chunjing.cannonEvery} 秒额外朝最近的敌人发射一发光炮` +
        `（伤害 ${TAOYAO.chunjing.cannonDmg}，速度 ${TAOYAO.chunjing.cannonSpeed}）。` +
        `光炮与映霞的箭矢是两套体系：不吃「认真拉矢」的层数加成，命中也**不叠层**。`,
  trigger: { type: 'cooldown', cd: TAOYAO.chunjing.cd },
  run(ctx) {
    const { battle, unit } = ctx;
    const P = TAOYAO.chunjing;
    unit.flags.chunjingUntil = battle.frame + Math.round(P.duration / DT);
    unit.flags.chunjingCannon = 0;          // 立即允许第一次补炮
    battle._emit('buffOn', unit, null, P.duration, { buff: '春景' });
    return true;
  },
  hooks: {
    /* 每帧推进 buff：回血 + 补炮计时 */
    onThink(battle, unit) {
      const P = TAOYAO.chunjing;
      if (!unit.flags.chunjingUntil || battle.frame >= unit.flags.chunjingUntil) {
        if (unit.flags.chunjingUntil) {
          unit.flags.chunjingUntil = 0;
          battle._emit('buffOff', unit, null, 0, { buff: '春景' });
        }
        return;
      }
      battle._heal(unit, P.healPerSec * DT);
      unit.flags.chunjingCannon = (unit.flags.chunjingCannon || 0) + DT;
      if (unit.flags.chunjingCannon < P.cannonEvery) return;
      unit.flags.chunjingCannon -= P.cannonEvery;
      const target = battle._nearestEnemy(unit);
      if (!target) return;
      /* 补炮方向：玩家操控时跟鼠标（春景开着的时候由玩家自己瞄） */
      const aim = battle.aimUnit(unit, target);
      const spd = P.cannonSpeed * SCALE;
      battle._spawnProjectile({
        kind: 'aura', tag: 'chunjing_cannon', owner: unit,
        x: unit.x, y: unit.y,
        vx: Math.round(aim.ux * spd), vy: Math.round(aim.uy * spd),
        damage: Math.max(1, Math.round(P.cannonDmg * (unit.damageMul ?? 1))),
        radius: Math.round(P.cannonR * SCALE),
        life: P.cannonLife, color: P.color,
      });
    }
  }
};

/* ------------------------------------------------------------
   ⑤ 陀螺：被"真正的打击"命中时叠层，层数驱动伤害 / 移速 / 转速
   ------------------------------------------------------------ */
export const SKILL_TOP = {
  id: 'taoyao_top',
  name: '陀螺',
  desc: '被攻击后，桃夭会开始旋转，最多叠加十层，增加桃夭的碰撞伤害和移动速度。',
  descDetail: `被攻击时叠一层，最多 ${TAOYAO.top.maxStacks} 层（被打得越多转得越快）。` +
        `每层：碰撞伤害 +${TAOYAO.top.meleePer}、移动速度 +${TAOYAO.top.speedPer}。` +
        `满层时 +${TAOYAO.top.meleePer * TAOYAO.top.maxStacks} 碰撞伤害、` +
        `+${TAOYAO.top.speedPer * TAOYAO.top.maxStacks} 移速。` +
        `注意"被攻击"只算**真正的打击**（近战、弹道、爆炸）——` +
        `裁光质点/细线那种每帧接触伤害、以及场地灼烧都不算，` +
        `否则一秒 60 次的接触伤害会瞬间把层数顶满。` +
        `（陀螺**不回血**。）`,
  trigger: { type: 'passive' },
  passive(battle, unit) {
    unit.spinStacks = unit.spinStacks || 0;
  },
  hooks: {
    onDamaged(battle, unit, ctx) {
      if (!ctx || !ctx.heavy) return;          // 每帧接触伤害不算"被攻击"
      if (unit.spinStacks >= TAOYAO.top.maxStacks) return;
      unit.spinStacks++;
      /* 层数一变，碰撞伤害与移速都要跟着走 —— 两处都走"基础 + 加成"模型重算 */
      unit.spinMeleeBonus = TAOYAO.top.meleePer * unit.spinStacks;
      battle.refreshMelee(unit);
      unit.speedBonus = TAOYAO.top.speedPer * unit.spinStacks;
      battle.refreshSpeed(unit);
      battle._emit('spinUp', unit, null, unit.spinStacks);
    },
  }
};

/* ============================================================
   缇娜（球种 3）—— 吸血 / 蝙蝠 / 霰弹 / 权杖 / 公主传承
   ------------------------------------------------------------
   这一组技能把几套新引擎系统串起来，各自的开关写在 core.js 里：
     · 吸附 latch        —— 位置按在目标身上（step 第 5.5 段）
     · 沉默 silencedFrames —— 挡技能，撞墙类除外（_runSkills）
     · 近战免疫 meleeImmuneFrames —— 被缠住时不吃碰撞伤害（_resolveAttacks）
     · 移速乘子 speedMul —— "降低一半"是对折，不是减 20
     · 追踪 homing       —— 每秒最多转多少度（转速上限，不是总偏角）
     · 返程 returnTo     —— 命中后掉头回主人，抵达触发 onReturn
     · 锚定光柱 anchor + tickDamage —— 从主人身上长出来、按节拍结算的范围伤害
     · 时间停止 startTimeStop —— 冻位移/开火/冷却，但**不冻持续伤害**
   ============================================================ */
export const TINA = {
  /* ① 吸血习性 */
  suck: {
    meleeTo: 30,          // 碰撞伤害锁死在 30（权杖的 +15 不影响它）
    holdSeconds: 1.5,
    /* 吸附持续帧数。刻意比 1.5 秒（90 帧）短 2 帧：
       接触伤害的节拍是 0.5 秒，1.5 秒里正好 3 跳（0 / 0.5 / 1.0 秒）。
       若撑满 90 帧，命中冷却在第 90 帧刚好归零，会多出第 4 跳。
       所以"3 次"不是自己数出来的，是**节拍自然落成 3 次** —— 见 descDetail。 */
    holdFrames: 88,
    /* 免疫/沉默留得比吸附略久，保证松开那一帧不会漏出一个伤害 */
    holdTailFrames: 95,
    targetSpeedMul: 0.5,
    /* 吸附**结束之后**的硬性间隔：这 1 秒内不会再吸附任何一个球。
       从"吸附结束"起算，不是从"吸附开始"（作者原话：
       "吸附吸血完成之后，一秒之内都不会再进行吸附吸血"）。
       写进 unit.skillCd 实现 —— 引擎在分发 onHit 技能前会检查它，
       所以是硬性的，不依赖技能自己的判断。 */
    afterCooldown: 1,
  },

  /* ② 蝙蝠 */
  bat: {
    cd: 3,
    minCount: 3, maxCount: 5,
    /* 速度 150（原本 260）。
       转弯半径 = 速度 ÷ 角速度：150 ÷ (60°×π/180) ≈ 143 世界单位，
       权杖加成到 90°/秒后约 95 —— 场地约 700×500，这个半径才追得住人。
       260 时半径是 248，蝙蝠基本直飞、只在末端划一道弧。 */
    speed: 150,
    turnPerSec: 60,       // 追踪转速上限（度/秒）
    damage: 6, r: 4, life: 4,
    /* 回到缇娜身上时回的血（作者 2026-10 从 6 下调到 3）。
       注意「权杖」只提高**伤害**，不提高回血 —— 回血不是伤害。 */
    heal: 3,
    mana: 1,              // 回到缇娜身上时加的魔力
    /* 偷到"持续发动型"能力时，借她**用多久**（作者 2026-10：5 秒）。
       那类能力（见晴的变色 / 常驻长剑…）单放一次是没有意义的 ——
       它们的完整效果就是一段持续状态，所以要借一段时间。 */
    stealSeconds: 5,
    color: '#a21caf',
    /* 蝙蝠的美术（作者给的图）。方向已由 tools/make-sprites.mjs 统一成
       "头朝 +X"，所以渲染层照旧只按 atan2(vy,vx) 转，运行时不用记偏移。
       **spriteLen 由作者定：先要 34，看过之后要求"改成现在的四分之一"，所以是 8.5。**
       追踪/返程都是每帧改速度方向，所以它会跟着转弯，天然是"扑向目标"。 */
    sprite: 'assets/characters/tina_bat.png',
    spriteLen: 8.5,
    /* 光晕用红色 —— 对应**图本身的颜色**（那只蝙蝠是红的），
       不是技能表里的 color（#a21caf 紫，那是程序化回退光点用的）。 */
    spriteGlow: '#dc2626',
    /* **只有蝙蝠要透明度呼吸**（作者）：它的图与光晕在 25%~40% 之间来回浮动。
       其他弹道一律不呼吸、图保持完全不透明 —— 所以这里这一个开关
       就是"谁在呼吸"的唯一出处。 */
    spritePulse: true,
    /* 贴图相对**判定中心**的偏移（世界单位，弹道局部坐标：+x 朝前、+y 朝飞行方向的右手侧）。
       判定中心就是弹道的位置（物理上用那个点做碰撞），所以"图偏了"要记在这里：
       0 = 图正好套在判定圆上。彗星状的图（亮核在右、尾迹在左）把 x 调大一点，
       亮核才会压在判定圆上。编辑器里直接拖判定圆就能改这两个数。 */
    spriteOffX: -0.5,
    spriteOffY: 0,
  },

  /* ③ 魔力霰弹 */
  shot: {
    cd: 2,                // 每 2 秒一轮
    count: 3,
    windowSeconds: 0.5,   // 一轮里的 3 发在 0.5 秒内打完
    spreadDeg: 15,        // 每发随机偏 0~15°
    damage: 30, speed: 420, r: 5.5, life: 2.2,
    color: '#e11d48',     // 猩红
    /* 猩红魔弹的美术：亮核在右、尾迹拖在左的彗星。
       判定是半径 5 的圆（直径 10），spriteLen 取到"图里的亮核 ≈ 判定直径"
       —— 亮核约占图宽的 45~50%，24 × 0.48 ≈ 11.5。 */
    sprite: 'assets/characters/tina_bolt.png',
    spriteLen: 24,
    spriteGlow: '#f43f5e',
    spritePulse: false,
    /* 贴图相对**判定中心**的偏移（世界单位，弹道局部坐标：+x 朝前、+y 朝飞行方向的右手侧）。
       判定中心就是弹道的位置（物理上用那个点做碰撞），所以"图偏了"要记在这里：
       0 = 图正好套在判定圆上。彗星状的图（亮核在右、尾迹在左）把 x 调大一点，
       亮核才会压在判定圆上。编辑器里直接拖判定圆就能改这两个数。 */
    spriteOffX: -2.5,
    spriteOffY: 0,
  },

  /* ④ 权杖（被动） */
  scepter: { meleeBonus: 15, damageMul: 4 / 3, turnBonusDeg: 30 },

  /* ⑤⑥⑦ 公主传承（三选一，互斥组见下） */
  p1: { cd: 10, duration: 3 },
  p2: { cd: 10 },
  p3: {
    cd: 10, chargeSeconds: 1, durationSeconds: 2,
    tickPerSec: 3, damage: 35,
    radius: 16,           // 直径 = 小球直径（球半径 16）
    len: 420,             // 光柱长度（世界单位）
    color: '#dc2626',
  },
};

/* ============================================================
   见晴（魔法少女[白水仙]）—— 水镜三态 + 起飞 + 精灵变身 + 羽毛
   ------------------------------------------------------------
   作者 2026-10 的规格。基础数值：**血量 1500 / 速度 120 / 碰撞伤害 30 /
   标准体型（与晕彩一致，r = 16）**。

   六个技能是**三个各自独立的水镜**（作者确认：可以分开装配，
   各有一套自己的颜色循环）+ 起飞 + 精灵变身 + 羽毛：

     ① 水镜（防御）  每 5 秒随机切淡绿 / 淡粉
     ② 水镜（猩红）  常驻：速度 +10、身侧一柄长剑（砍人 / 消魔弹）
     ③ 水镜（双色）  每 9 秒随机切深蓝紫 / 白（借晕彩的魔弹 / 激光）
     ④ 起飞          累计移动 1560 单位后飞 3 秒
     ⑤ 精灵变身      装备即永久：体型减半、速度 +50、所有伤害减半
     ⑥ 我很可爱      每掉 300 血发一根追踪羽毛

   两个"必须记住"的点（都在引擎里落地，见 core.js）：
     · ①③ 两套颜色循环是**各自独立**的，所以快照给了两个颜色位
       （16 防守色 / 17 借用色）—— 一个字段装不下两个循环；
     · ④ 的"只与墙壁碰撞"用 phasingFrames 一个开关关掉**碰撞、分离、撞伤**
       三件事（它们都先问 overlapping），"免伤"用 invulnFrames，
       "不发动攻击"用 noAttackFrames（只拦冷却类与 onThink，
       被动 / 护盾 / 受伤钩子照常 —— 那才是作者说的"防御效果"）。
   ============================================================ */
export const JIANQING = {
  /* ① 水镜·魔力共鸣（防御） */
  mirrorDef: {
    cycle: 5,                 // 每 5 秒随机切一次（允许连续切到同一个颜色）
    healPerSec: 15,           // 淡绿色：每秒回复
    meleeBonus: 10,           // 淡粉色：碰撞伤害提高
    shieldPerSec: 30,         // 淡粉色：每秒生成一个"能抵挡 30 伤害"的护盾
    shieldMax: 300,           // 护盾上限（作者确认：300 = 连续淡粉 10 秒的量）
    shieldDecayPerSec: 5,     // 不在淡粉色时护盾每秒衰减
  },
  /* ② 水镜·魔力共鸣（猩红色） */
  mirrorSword: {
    speedBonus: 10,           // 移动速度提高 10 点
    swordLen: 32,             // 长剑长度 = 小球直径（r=16 → 32）
    frontDeg: 120,            // "见晴前方 120° 范围"
    sweepDeg: 120,            // 挥动动画的扫过角度（以球心为轴转这么多度）
    dmg: 80,                  // 挥动一次 80 点伤害
    atkInterval: 1,           // 攻击性挥动间隔（秒，至少）
    defInterval: 2.5,           // 防御性挥动（消魔弹）间隔（秒，至少）
    purgeMax: 3,              // 一次最多消除 3 个魔弹
    swingFrames: 12,          // 挥动动画帧数（纯表现；判定在触发那一帧完成）
    color: '#8b1a1a',         // 猩红（暂时用深红光柱替代美术）
  },
  /* ③ 水镜·魔力共鸣（深蓝紫色和白色） */
  mirrorBorrow: {
    cycle: 9,                 // 每 9 秒随机切一次
    /* 深蓝紫：借晕彩的魔弹（**没有第三发激光**）。
       3 秒一发 → 一个 9 秒周期里会打出 4 发（第 0 / 3 / 6 / 9 秒各一发）。 */
    modanCd: 3, modanDmg: 75, modanSpeed: 600, modanR: 6, modanLife: 4,
    modanColor: '#5b21b6',
    /* 白色：借魔弹的激光（贯穿、每个目标只结算一次、持续 0.5 秒）。
       4 秒一发 → 一个 9 秒周期里 3 发（第 0 / 4 / 8 秒）。 */
    laserCd: 4, laserDmg: 170, laserSpeed: 1000, laserLife: 0.5,
    laserWidth: 20, laserLen: 1400, laserColor: '#ffffff',
  },
  /* ④ 起飞 */
  takeoff: {
    distance: 1560,           // 累计移动这么多世界单位后起飞（落地后重新累计）
    seconds: 4,               // 滞空时间（作者在编辑器里调的：3 → 5 → 4）
    speedBonus: 150,          // 空中移速提高（**临时的**：落地就撤）
    /* 作者 2026-10 的第二次改口径：
         · 免疫 → **受到的所有伤害减半**（帧伤也减半）；
         · 空中**可以正常使用其它所有技能**（原先禁止攻击那条已取消）；
         · 移动中持续以最多 45°/秒 修正航向追踪敌人。 */
    damageTakenMul: 0.5,      // 空中受到的伤害倍率
    turnPerSec: 45,           // 空中每秒最多修正多少度（追踪最近的敌人）
    frameDamage: 5,           // 与任一小球重合时每帧 5 点（帧伤，走 _tickDamage）
    scale: 1.35,              // 表现：变大（判定箱不变，见 README）
    wallHoming: true,         // 撞墙后航向**直接指向最近的敌人**（否则随机反弹）
    /* ---------- 每次飞行之后的永久成长（作者 2026-10 的新机制）----------
       "见晴每次起飞过后，速度永久加 5，下次起飞的帧伤增加 0.5，可叠加"。
       两项都在**落地那一刻**结算 —— 所以第 1 次飞行用的还是原始数值，
       从第 2 次起才吃到 +0.5（速度的 +5 从落地后就永久生效）。 */
    speedPerFlight: 5,        // 每完成一次飞行：移速永久 +5（可叠加）
    frameDamagePerFlight: 0.5,// 每完成一次飞行：之后每次飞行的帧伤 +0.5（可叠加）
  },  /* ⑤ 精灵变身（装备即生效，作者确认） */
  transform: {
    sizeMul: 0.6,             // 体型倍率（作者在编辑器里调的；判定与显示一起变）
    speedBonus: 55,           // 移速加成
    damageMul: 0.7,           // 造成的**所有**伤害的倍率
    swordMul: 0.6,            // ② 的长剑长度倍率
  },
  /* ⑥ 我很可爱 */
  feather: {
    hpStep: 300,              // 每掉这么多血发一根
    speed: 250,               // 羽毛速度
    r: 6, life: 9,
    turnPerSec: 220,          // 追踪转速上限（度/秒）
    bounces: 3,               // 可以撞墙反弹
    slowMul: 0.5, slowSeconds: 3,   // 命中：移速减半，持续 3 秒
    meleeMinus: 5, skillMinus: 5,   // 命中：碰撞/技能伤害各 -5（可叠加，本局永久）
    color: '#bfe3ff',
  },
};

/* ---------- 小工具 ---------- */
const TINA_SUCK_ID = 'tina_suck';
/* "此刻拥有这个技能" = 本体的 or 借来的（缇娜偷学来的那是真的能用了） */
const hasSkill = (unit, id) =>
  !!(unit && ((unit.skills && unit.skills.includes(id)) || (unit.borrow && unit.borrow[id])));

/* 权杖是否在身上。它是被动，装了就生效，所以别的技能按这个开关取修正值。 */
const withScepter = (unit) => !!(unit && unit.flags && unit.flags.tinaScepter);

/** 结束吸附：还原目标身上的减速，并给下一次吸附挂上硬性间隔。
 *  **两条结束路径（到期 / 目标阵亡）都要走这里** ——
 *  以前只有到期那条写了"还原减速"，目标中途死掉的话减速就永远留在它身上了。 */
function endLatch(battle, unit, target) {
  unit.latch = null;
  if (target) {
    if (target.speedMul === TINA.suck.targetSpeedMul) {
      target.speedMul = 1;
      battle.refreshSpeed(target);
    }
    battle._emit('latchEnd', unit, target, 0);
  }
  /* 硬性间隔：从**吸附结束**起算，1 秒内不再吸附任何球。
     写进 skillCd 之后由引擎统一递减与拦截，技能自己不用再判断。 */
  unit.skillCd = unit.skillCd || {};
  unit.skillCd[TINA_SUCK_ID] = TINA.suck.afterCooldown;
  battle._emit('latchCooldown', unit, null, TINA.suck.afterCooldown);
}

/** 开始吸附。①的撞击触发与⑥的瞬移触发共用这一段 ——
 *  两处各写一遍的话，"3 跳""免疫""减半"很容易只改到一处。 */
function startLatch(battle, unit, other) {
  if (!other || !other.alive || unit.latch) return false;
  const T = TINA.suck;
  unit.latch = { targetId: other.id, untilFrame: battle.frame + T.holdFrames };
  unit.meleeImmuneFrames = T.holdTailFrames;
  other.silencedFrames = T.holdTailFrames;
  other.speedMul = T.targetSpeedMul;
  battle.refreshSpeed(other);
  battle._emit('latch', unit, other, T.holdSeconds);
  return true;
}

/* ---------- ② 的蝙蝠：一次发射与"返程结算"都收在这里 ---------- */
function fireBat(battle, unit, target) {
  if (!target || !target.alive) return null;
  const P = TINA.bat;
  const scep = withScepter(unit);
  const turn = P.turnPerSec + (scep ? TINA.scepter.turnBonusDeg : 0);
  const dmg = Math.max(1, Math.round(P.damage * (scep ? TINA.scepter.damageMul : 1)));
  const spd = P.speed * SCALE;
  /* 初始方向：朝目标（玩家操控时是鼠标方向），但**随机散开一点** ——
     3~5 只如果完全同向重叠，看起来只有一只。 */
  const aim = battle.aimUnit(unit, target);
  const base = Math.atan2(aim.uy, aim.ux) + (battle.rnd() * 2 - 1) * 0.5;
  return battle._spawnProjectile({
    kind: 'body', tag: 'bat', owner: unit,
    x: unit.x, y: unit.y,
    vx: Math.round(Math.cos(base) * spd),
    vy: Math.round(Math.sin(base) * spd),
    damage: dmg,
    /* 半径是**定点数**（×SCALE）—— 漏了这个乘号，半径就成了 0.005 世界单位，
       画面上是一个亚像素点，等于"看不到特效"。 */
    radius: Math.round(P.r * SCALE),
    life: P.life, color: P.color,
    sprite: P.sprite, spriteLen: P.spriteLen,
    spriteGlow: P.spriteGlow, spritePulse: P.spritePulse,
    spriteOffX: P.spriteOffX, spriteOffY: P.spriteOffY,
    homing: { targetId: target.id, turnPerSec: turn },
    returnTo: unit.id,
    onHit: (b, from, to) => { if (from && to) from.flags.batLastHit = to.id; },
    onReturn: (b, from) => {
      b._heal(from, P.heal);
      b._gainResource(from, P.mana, 'bat');
      b._emit('batReturn', from, null, P.heal);
      /* 魔力满 → 偷学一次，然后清零重新攒 */
      if (from.resMax > 0 && from.res >= from.resMax) {
        from.res = 0;
        b._emit('manaBurst', from, null, 0);
        stealAndCast(b, from);
      }
    },
  });
}

/** 能被"偷学"的技能：**能释放一次的主动技能** + **持续发动型能力**。
 *  作者口径是排除"领域类 / 近战类 / 碰撞墙壁类"，这三类在本项目里恰好
 *  全都是被动（辉光领域、折光）或撞墙触发（裁光），所以一条规则就够：
 *    有 run()（被动没有）+ 不是 onWall（碰撞墙壁类）
 *  比逐个点名白名单稳 —— 以后新加的技能自动被正确归类。
 *
 *  ⚠ 2026-10 补的一条：标了 `sustain` 的技能（见晴 ①②③ 这类
 *  "变色 / 常驻"能力）没有 run() 也可能被偷 —— 它们的完整效果是
 *  一段持续状态，判定不能只看"有没有 run"。 */
function stealableFrom(victim) {
  const out = [];
  for (const id of victim.skills || []) {
    const sk = getSkill(id);
    if (!sk || sk.noSteal) continue;
    if (!sk.trigger || sk.trigger.type === 'onWall') continue;
    if (typeof sk.run !== 'function' && !sk.sustain) continue;
    out.push(sk);
  }
  return out;
}

/** 抽victim一个技能、用缇娜的身份放一次。
 *  注意**不设冷却** —— 缇娜并没有这个技能，设了也没人读。 */
function stealAndCast(battle, tina) {
  const victim = battle.units[tina.flags.batLastHit];
  if (!victim || !victim.alive) return null;
  const pool = stealableFrom(victim);
  if (!pool.length) return null;
  const sk = pool[Math.floor(battle.rnd() * pool.length) % pool.length];
  const target = battle._nearestEnemy(tina);
  /* ---------- 持续发动型：不是"放一次"，而是"借来用 N 秒" ----------
     作者 2026-10 报的 bug：偷到见晴的变色能力时"发动了但没有任何效果"。
     原因：那类能力的 run() 只切一次颜色，真正的效果全在它自己的
     被动 + 每帧钩子里；缇娜身上没有那些钩子，所以放完什么都不会发生。
     所以这里改成把技能**临时装到缇娜身上**：被动、钩子、冷却全都真的跑起来，
     到期由引擎摘掉（含技能自己的 onUnborrow 收尾）。 */
  if (sk.sustain) {
    const ok = battle.grantSkill(tina, sk.id, TINA.bat.stealSeconds);
    battle._emit('steal', tina, victim, ok ? 1 : 0, { skill: sk.name, sustain: true });
    return sk;
  }
  let ok = false;
  try {
    ok = !!sk.run({ battle, unit: tina, target });
  } catch (e) {
    /* 偷来的技能可能在原主身上有前置状态。失败不该把整局带崩 ——
       emit 一条事件，诊断里能看到，但不影响这一局继续跑。 */
    battle._emit('stealFail', tina, victim, 0, { skill: sk.name, err: String(e && e.message) });
    return null;
  }
  battle._emit('steal', tina, victim, ok ? 1 : 0, { skill: sk.name });
  return sk;
}

/* ------------------------------------------------------------
   ① 吸血习性
   ------------------------------------------------------------ */
export const SKILL_TINA_SUCK = {
  id: 'tina_suck',
  name: '吸血习性',
  desc: '碰撞伤害降低到30，碰撞时吸附1.5秒，造成3次碰撞伤害并百分百吸血。' +
        '回复不会超过缇娜生命上限。',
  descDetail: `碰撞伤害被**锁死在 ${TINA.suck.meleeTo}**（权杖的 +${TINA.scepter.meleeBonus} 不影响它）。` +
        `撞到敌方小球后吸附在它身上 ${TINA.suck.holdSeconds} 秒，期间：` +
        `目标**无法发动技能**（撞墙类除外）、移速 ×${TINA.suck.targetSpeedMul}；` +
        `缇娜**不受碰撞伤害**。` +
        `这 1.5 秒里正好结算 **3 次**接触伤害，每一次缇娜都回复等量生命（不超过生命上限）。` +
        `"3 次"不是自己数的：接触伤害的节拍是 0.5 秒一次，` +
        `吸附把两颗球按在一起，节拍自然落下 3 跳；吸附刻意比 1.5 秒早 2 帧松开，` +
        `以免第 90 帧命中冷却归零多出第 4 跳。` +
        `**吸附结束后 ${TINA.suck.afterCooldown} 秒内不会再吸附任何球**（硬性间隔，从吸附结束起算）。`,
  trigger: { type: 'onHit' },
  passive(battle, unit) {
    /* 用"锁"而不是"减 20"：权杖的 +15 与它互不影响，
       锁成 30 之后 refreshMelee 会直接返回 30。 */
    unit.meleeLock = TINA.suck.meleeTo;
    battle.refreshMelee(unit);
  },
  run(ctx) {
    const { battle, unit, other } = ctx;
    const ok = startLatch(battle, unit, other);
    /* 触发吸附的那一下接触伤害**发生在 run() 之前**（引擎先结算伤害、
       再分发 onHit 技能），那时 latch 还没建立，所以 onHit 钩子把它挡掉了。
       实测结果是"3 跳只回了 2 次血" —— 这里把第一次补上。
       伤害值直接用 _meleeDamage(unit)：触发它的就是缇娜的碰撞伤害。 */
    if (ok) {
      const first = battle._meleeDamage(unit);
      if (first > 0) {
        battle._heal(unit, first);
        battle._emit('drain', unit, other, first);
      }
    }
    return ok;
  },
  hooks: {
    /* 吸附期间每一次接触伤害都按数值回血。
       直接用"造成伤害"这个钩子，就不必自己维护跳数 ——
       跳数由接触伤害的节拍决定，"3 次"是它的自然结果。 */
    onHit(battle, unit, ctx) {
      if (!unit.latch || !ctx || ctx.kind !== 'melee') return;
      battle._heal(unit, ctx.dmg);
      battle._emit('drain', unit, ctx.target, ctx.dmg);
    },
    onThink(battle, unit) {
      const l = unit.latch;
      if (!l) return;
      const t = battle.units[l.targetId];
      /* 目标中途死了也要走 endLatch：以前这里直接 unit.latch = null，
         结果"还原减速 + 挂间隔"两件事都被跳过。 */
      if (!t || !t.alive) { endLatch(battle, unit, t || null); return; }
      if (battle.frame >= l.untilFrame) { endLatch(battle, unit, t); return; }
      /* 每帧续期：引擎每帧递减，续到 3 帧就足够覆盖整个吸附时间 */
      t.silencedFrames = Math.max(t.silencedFrames, 3);
      unit.meleeImmuneFrames = Math.max(unit.meleeImmuneFrames, 3);
    },
  },
};

/* ------------------------------------------------------------
   ② 蝙蝠
   ------------------------------------------------------------ */
export const SKILL_TINA_BAT = {
  id: 'tina_bat',
  name: '蝙蝠',
  desc: '每3秒释放3~5只蝙蝠，每只造成6点伤害，恢复3点生命值。' +
        '累计命中五次后，缇娜复制一次最后命中目标的随机技能。',
  descDetail: `每 ${TINA.bat.cd} 秒放出一批 **${TINA.bat.minCount}~${TINA.bat.maxCount} 只**小蝙蝠，` +
        `朝最近的敌人追踪：速度 ${TINA.bat.speed}，**每秒最多偏转 ${TINA.bat.turnPerSec}°**` +
        `（是"转速上限"而不是"总偏角上限"——追不到就会绕圈追）。` +
        `命中造成 ${TINA.bat.damage} 伤害，然后**掉头飞回缇娜**；` +
        `每只回到身上时回复 ${TINA.bat.heal} 点生命（**回血不吃权杖加成** —— 权杖提高的是伤害）、` +
        `魔力 +${TINA.bat.mana}。` +
        `魔力满 ${5} 点后清空，并按**最后命中的目标**随机抽它一个技能放一次。` +
        `可偷的范围是"能释放一次的主动技能"：被动（辉光领域、折光、认真拉矢、陀螺…）` +
        `没有"释放一次"这回事，撞墙触发的（裁光）也在排除之列。\n` +
        `抽到**持续发动型**能力时不是"放一次"——那类能力的效果本身就是一段持续状态，` +
        `放一次等于什么都没发生（作者实测报过：偷到见晴的变色能力，颜色变了但一滴血没回）。` +
        `所以按能力分三种处理：\n` +
        `· 变色 / 常驻类（见晴 ① ② ③、精灵变身）：**借来用 ${TINA.bat.stealSeconds} 秒** ——` +
        `期间它的被动、每帧效果、冷却触发全都真的跑在缇娜身上，时间到了自动归还（含资源条还原）；\n` +
        `· 起飞：借来的那一刻**立刻起飞**，滞空 ${JIANQING.takeoff.seconds} 秒，` +
        `落地那份"每次飞完永久 +${JIANQING.takeoff.speedPerFlight} 移速"照给，而且归还时不会被撤掉；\n` +
        `· 我很可爱：**立刻发一根羽毛**（不用等掉血）。\n` +
        `装上「权杖」后：伤害 ×4/3，偏转角 +${TINA.scepter.turnBonusDeg}°（→ ${TINA.bat.turnPerSec + TINA.scepter.turnBonusDeg}°/秒）。`,
  trigger: { type: 'cooldown', cd: TINA.bat.cd },
  run(ctx) {
    const { battle, unit, target } = ctx;
    const t = target || battle._nearestEnemy(unit);
    if (!t) return false;
    const n = TINA.bat.minCount +
      Math.floor(battle.rnd() * (TINA.bat.maxCount - TINA.bat.minCount + 1));
    for (let i = 0; i < n; i++) fireBat(battle, unit, t);
    battle._emit('batSwarm', unit, t, n);
    return true;
  },
};

/* ------------------------------------------------------------
   ③ 魔力霰弹
   ------------------------------------------------------------ */
export const SKILL_TINA_SHOT = {
  id: 'tina_shot',
  name: '魔力霰弹',
  desc: '三连发的魔力弹，间隔2秒，但是准头不太好。',
  descDetail: `每 ${TINA.shot.cd} 秒打出一轮 **${TINA.shot.count} 发**：` +
        `第 1 发立刻出手，其余两发在 ${TINA.shot.windowSeconds} 秒内均匀打完（间隔 ${(TINA.shot.windowSeconds / (TINA.shot.count - 1)).toFixed(2)} 秒）。` +
        `每发在瞄准方向上随机偏 **0~${TINA.shot.spreadDeg}°**，每发 ${TINA.shot.damage} 伤害` +
        `（一轮合计 ${TINA.shot.damage * TINA.shot.count}）。` +
        `装上「权杖」后每发 ×4/3 → ${Math.round(TINA.shot.damage * TINA.scepter.damageMul)}。`,
  trigger: { type: 'cooldown', cd: TINA.shot.cd },
  run(ctx) {
    const { battle, unit } = ctx;
    const t = battle._nearestEnemy(unit);
    if (!t) return false;
    fireShot(battle, unit, t);
    /* 剩下两发交给 onThink 按节拍补完 —— 一排三发同时出膛就没有"连射"的意思了 */
    unit.flags.volleyLeft = TINA.shot.count - 1;
    unit.flags.volleyTimer = TINA.shot.windowSeconds / (TINA.shot.count - 1);
    return true;
  },
  hooks: {
    onThink(battle, unit) {
      if (!unit.flags.volleyLeft) return;
      unit.flags.volleyTimer -= DT;
      if (unit.flags.volleyTimer > 0) return;
      unit.flags.volleyTimer += TINA.shot.windowSeconds / (TINA.shot.count - 1);
      unit.flags.volleyLeft--;
      const t = battle._nearestEnemy(unit);
      if (t) fireShot(battle, unit, t);
    },
  },
};

function fireShot(battle, unit, target) {
  const P = TINA.shot;
  const scep = withScepter(unit);
  const dmg = Math.max(1, Math.round(P.damage * (scep ? TINA.scepter.damageMul : 1)));
  /* 基准方向：玩家操控时是鼠标方向，否则朝目标 */
  const aim = battle.aimUnit(unit, target);
  const base = Math.atan2(aim.uy, aim.ux);
  const off = (battle.rnd() * 2 - 1) * ((P.spreadDeg * Math.PI) / 180);
  const a = base + off;
  const spd = P.speed * SCALE;
  battle._spawnProjectile({
    kind: 'aura', tag: 'tina_shot', owner: unit,
    x: unit.x, y: unit.y,
    vx: Math.round(Math.cos(a) * spd),
    vy: Math.round(Math.sin(a) * spd),
    damage: dmg, radius: Math.round(P.r * SCALE), life: P.life, color: P.color,
    sprite: P.sprite, spriteLen: P.spriteLen,
    spriteGlow: P.spriteGlow, spritePulse: P.spritePulse,
    spriteOffX: P.spriteOffX, spriteOffY: P.spriteOffY,
  });
  /* 不要再 emit('shoot') —— _spawnProjectile 自己就会发一条
     （带 px/py/color/tag）。技能里再发一次的话，上层统计里每发魔弹会变成两发。 */
}

/* ------------------------------------------------------------
   ④ 权杖（被动）
   ------------------------------------------------------------ */
export const SKILL_TINA_SCEPTER = {
  id: 'tina_scepter',
  name: '权杖',
  desc: '增加15点碰撞伤害，魔力霰弹和蝙蝠的伤害提高，准度提高。',
  descDetail: `被动。碰撞伤害 **+${TINA.scepter.meleeBonus}**（${50} → ${50 + TINA.scepter.meleeBonus}）——` +
        `但如果同时装了「吸血习性」，碰撞伤害仍是被锁死的 ${TINA.suck.meleeTo}，这 +15 不生效。` +
        `「魔力霰弹」与「蝙蝠」的伤害各 **×4/3**` +
        `（霰弹 ${TINA.shot.damage} → ${Math.round(TINA.shot.damage * TINA.scepter.damageMul)}，` +
        `蝙蝠 ${TINA.bat.damage} → ${Math.round(TINA.bat.damage * TINA.scepter.damageMul)}）；` +
        `蝙蝠的追踪偏转角 **+${TINA.scepter.turnBonusDeg}°**（${TINA.bat.turnPerSec} → ${TINA.bat.turnPerSec + TINA.scepter.turnBonusDeg}°/秒）。`,
  trigger: { type: 'passive' },
  passive(battle, unit) {
    unit.flags.tinaScepter = true;
    unit.meleeBonus = (unit.meleeBonus || 0) + TINA.scepter.meleeBonus;
    battle.refreshMelee(unit);
  },
};

/* ------------------------------------------------------------
   ⑤⑥⑦ 公主传承 —— 三个互斥，只能选一个
   ------------------------------------------------------------ */
export const SKILL_TINA_P1 = {
  id: 'tina_p1',
  name: '公主传承1',
  group: 'princess',
  desc: '每10秒可以使用一次，时停3秒。',
  descDetail: `每 ${TINA.p1.cd} 秒发动一次**时间停止**，持续 ${TINA.p1.duration} 秒。` +
        `表现：除缇娜外的球**全部褪色**（渲染层按快照里的豁免者下标做灰度）。` +
        `效果（作者确认过的口径）：除缇娜自己与她的技能产物外，` +
        `**小球不能移动、不能开火、技能冷却也停**；` +
        `但**灼烧 / 细线之类的持续伤害照常结算** —— 站在火里照样掉血。` +
        `与另外两个「公主传承」互斥，三个只能选一个。`,
  trigger: { type: 'cooldown', cd: TINA.p1.cd },
  run(ctx) {
    const { battle, unit } = ctx;
    battle.startTimeStop(unit, TINA.p1.duration);
    return true;
  },
};

export const SKILL_TINA_P2 = {
  id: 'tina_p2',
  name: '公主传承2',
  group: 'princess',
  desc: '每10秒可以使用一次，发动一次蝙蝠（不论是否携带）并瞬移到锁定的小球边上。',
  descDetail: `每 ${TINA.p2.cd} 秒发动一次：先**立刻放出一只蝙蝠**（即使没装「蝙蝠」也会放），` +
        `然后**瞬移**到锁定目标的旁边、贴上去撞一下。` +
        `如果装了「吸血习性」，这次撞击直接进入**吸附吸血**（省掉"撞上了才算"的随机性）。` +
        `与另外两个「公主传承」互斥，三个只能选一个。`,
  trigger: { type: 'cooldown', cd: TINA.p2.cd },
  run(ctx) {
    const { battle, unit, target } = ctx;
    const t = target || battle._nearestEnemy(unit);
    if (!t || !t.alive) return false;
    /* ① 先放蝙蝠（与是否携带「蝙蝠」无关） */
    fireBat(battle, unit, t);
    /* ② 瞬移到它旁边。用"原方向的延长线"落位，比直接贴到圆心再分离更稳：
       直接重合会被分离逻辑弹开一个随机方向。 */
    const dx = unit.x - t.x, dy = unit.y - t.y;
    const d = Math.hypot(dx, dy) || 1;
    const gap = unit.r + t.r;
    unit.x = Math.round(t.x + (dx / d) * gap);
    unit.y = Math.round(t.y + (dy / d) * gap);
    battle._emit('blink', unit, t, 0, { px: unit.x / SCALE, py: unit.y / SCALE });
    /* ③ 带了吸血习性就直接吸附 */
    if (hasSkill(unit, 'tina_suck')) startLatch(battle, unit, t);
    return true;
  },
};

export const SKILL_TINA_P3 = {
  id: 'tina_p3',
  name: '公主传承3',
  group: 'princess',
  desc: '蓄力一秒后射一发大的，持续两秒，造成最高210点伤害。',
  descDetail: `每 ${TINA.p3.cd} 秒发动一次：蓄力 ${TINA.p3.chargeSeconds} 秒后，` +
        `从缇娜身上射出一条**锚定的**猩红光柱，持续 ${TINA.p3.durationSeconds} 秒。` +
        `光柱直径 ${TINA.p3.radius * 2}（与小球直径一致），一端**始终钉在缇娜身上**，` +
        `另一端随锁定目标移动而转向。` +
        `每秒 ${TINA.p3.tickPerSec} 次判定、每次 ${TINA.p3.damage} 伤害 ` +
        `（共 ${TINA.p3.tickPerSec * TINA.p3.durationSeconds} 次，合计 ${TINA.p3.tickPerSec * TINA.p3.durationSeconds * TINA.p3.damage}）。` +
        `判定范围与画出来的光柱**同宽同长**（共用弹道上的 beamLen / w）。` +
        `与另外两个「公主传承」互斥，三个只能选一个。`,
  trigger: { type: 'cooldown', cd: TINA.p3.cd },
  run(ctx) {
    const { battle, unit } = ctx;
    if (!battle._nearestEnemy(unit)) return false;
    /* 蓄力：先记下"什么时候该开火"，真正的发射在 onThink 里 */
    unit.flags.p3At = battle.frame + Math.round(TINA.p3.chargeSeconds / DT);
    battle._emit('chargeStart', unit, null, TINA.p3.chargeSeconds, { skill: '公主传承3' });
    return true;
  },
  hooks: {
    onThink(battle, unit) {
      if (!unit.flags.p3At) return;
      if (battle.frame < unit.flags.p3At) return;
      unit.flags.p3At = 0;
      const t = battle._nearestEnemy(unit);
      if (!t) return;
      const P = TINA.p3;
      const a = Math.atan2(t.y - unit.y, t.x - unit.x);
      const spd = 600 * SCALE;
      battle._spawnProjectile({
        kind: 'aura', tag: 'tina_beam', owner: unit,
        x: unit.x, y: unit.y,
        vx: Math.round(Math.cos(a) * spd),
        vy: Math.round(Math.sin(a) * spd),
        damage: 0,              // 伤害走 tickDamage，不走弹体命中
        /* 这个 r 只被"撞墙夹紧"用到（命中已被 noBodyHit 跳过），
           但同样要是定点数，否则夹紧判定按 0.002 世界单位算。 */
        radius: Math.round(2 * SCALE),
        width: P.radius * 2,    // 宽度 = 直径（世界单位），与小球一致
        beam: true,
        beamForward: true,      // 从缇娜身上**向前**画
        beamLen: P.len,
        life: P.durationSeconds,
        color: P.color,
        anchor: unit.id, anchorTarget: t.id,
        noBodyHit: true,
        tickDamage: P.damage,
        tickInterval: 1 / P.tickPerSec,
        tickKind: 'skill',
      });
      battle._emit('beamStart', unit, t, P.durationSeconds);
    },
  },
};

/* ------------------------------------------------------------
   注册表：小球通过 skills: ['test_shot','test_dash'] 引用
   ------------------------------------------------------------ */
/* ============================================================
   见晴（魔法少女[白水仙]）· 六个技能
   ============================================================ */

/* ------------------------------------------------------------
   ① 水镜·魔力共鸣（防御）：每 5 秒随机切淡绿 / 淡粉
   ------------------------------------------------------------
   淡绿 = 每秒回血；淡粉 = 碰撞 +10、每秒 +30 护盾。
   护盾是"水镜护盾"资源条（物种上的 resource）：**受到的伤害先扣它**，
   所以吸收写在 onBeforeDamage 里 —— 那是引擎留给"护盾/减伤"的官方出口。

   两个实现细节值得记一笔：
     · 回血与护盾都按"每秒 N 点"给，**不能每帧取整**（15/60 = 0.25，
       取整后每帧都是 0，一滴都回不上）。所以各自攒余数，够 1 点才结算 ——
       回血有引擎的 _heal 帮忙攒，护盾这里自己攒（unit.flags.shieldAcc）。
     · 每帧都对 _gainResource/_spendResource 会让事件流被 60 条/秒灌满，
       所以同样按"整数点"结算。 */
export const SKILL_MIRROR_DEF = {
  id: 'jianqing_mirror_def',
  name: '水镜·魔力共鸣（防御）',
  desc: '每5秒随机切换一次颜色。淡绿色时每秒回复15点生命值，淡粉色时每秒获得30点护盾，上限300。' +
        '切换回淡绿色时，护盾会每秒衰减5点。',
  descDetail: `每 ${JIANQING.mirrorDef.cycle} 秒**随机**切一次颜色（淡绿 / 淡粉），` +
        `允许连续切到同一个颜色。切换时见晴身前张开一副水镜，她穿过水镜，小球边缘那一圈随之换色。\n` +
        `· 淡绿色：每秒回复 ${JIANQING.mirrorDef.healPerSec} 点生命。\n` +
        `· 淡粉色：碰撞伤害 +${JIANQING.mirrorDef.meleeBonus}；每秒 +${JIANQING.mirrorDef.shieldPerSec} 点护盾。\n` +
        `护盾是一个挡伤害的池子，上限 ${JIANQING.mirrorDef.shieldMax}` +
        `（血条下方那条「水镜护盾」就是它）：受到的伤害先扣护盾，扣完才掉血。` +
        `**不在淡粉色时**护盾每秒衰减 ${JIANQING.mirrorDef.shieldDecayPerSec} 点。\n` +
        `起飞期间这套防御效果照常生效（作者明确：它属于 buff 类效果）。`,
  trigger: { type: 'cooldown', cd: JIANQING.mirrorDef.cycle },
  /* 玩家操控时**仍然自动触发**（作者 2026-10）：变色属于"被动/形态"，
     不该占一个技能键。引擎读这个标记：标了 auto 的冷却技能照旧自己放。 */
  auto: true,
  /* 持续发动型：完整效果是"一段持续状态"，不是"放一次就完"。
     所以被缇娜的蝙蝠偷到时，引擎会把它**临时装到缇娜身上 5 秒**
     （引擎是唯一读它的地方：见 core.js 的 grantSkill 与 skills.js 的
     stealableFrom / stealAndCast）。
     单看 run() 只切一次颜色 —— 回血、护盾、碰撞加成全在下面的钩子里。 */
  sustain: true,
  passive(battle, unit) {
    /* 颜色在第 0 帧的第一次 run() 里随机决定 ——
       那时开局初速方向已经算好，所以不会打乱"同种子同开局"。 */
    unit.flags.mirrorColor = 0;
    unit.flags.shieldAcc = 0;
  },
  /* 借来的时候要**换资源条**：护盾池用的是物种的"特殊资源"，
     而缇娜身上那条是魔力（上限 5）—— 拿它当护盾会当场把
     "魔力满 5 → 偷学"的循环点着（还会把她的魔力花掉）。
     所以先把她原来的资源定义存起来，借完原样还回去。 */
  onBorrow(battle, unit) {
    const P = JIANQING.mirrorDef;
    unit.flags.borrowRes = { max: unit.resMax, res: unit.res, def: unit.resDef };
    unit.resMax = P.shieldMax;
    unit.res = 0;
    unit.resDef = {
      id: 'borrowWaterMirror', name: '水镜护盾',
      max: P.shieldMax, gainPerSec: 0, color: '#f0abfc',
    };
  },
  onUnborrow(battle, unit) {
    const s = unit.flags.borrowRes;
    if (s) {
      unit.resMax = s.max; unit.res = s.res; unit.resDef = s.def;
      delete unit.flags.borrowRes;
    }
    /* 淡粉色那份碰撞加成要撤掉（它记在 mirrorMelee 上）——
       不撤的话缇娜会永久 +10 碰撞伤害。 */
    if ((unit.flags.mirrorMelee || 0) !== 0) {
      unit.meleeBonus = (unit.meleeBonus || 0) - unit.flags.mirrorMelee;
      unit.flags.mirrorMelee = 0;
      battle.refreshMelee(unit);
    }
    unit.flags.mirrorColor = 0;
    unit.ringKind = 0;
  },
  run({ battle, unit }) {
    /* 两个颜色等概率，**允许连续切到同一个**（作者原话） */
    const color = battle.rnd() < 0.5 ? 1 : 2;
    unit.flags.mirrorColor = color;
    unit.ringKind = color;
    /* face 一起带上：渲染层要按她的朝向画"身前那副水镜"
       （事件里只有位置，没有朝向 —— 而镜面是有方向的） */
    battle._emit('mirrorSwitch', unit, null, color, { face: unit.face ?? 0, def: true });
    return true;
  },
  hooks: {
    /* 每帧的防御效果（起飞期间也照常：onMove 不在"禁止攻击"的拦截范围内） */
    onMove(battle, unit) {
      const P = JIANQING.mirrorDef;
      const color = unit.flags.mirrorColor;
      /* ---- 淡粉色的碰撞伤害 +10 ----
         走"基础 + 加成"模型：先把自己上一次加的那份撤掉，再按当前颜色加回去。
         直接 `melee += 10` 会随着切色反复累加（第 3 次切到淡粉就 +30）。 */
      const want = color === 2 ? P.meleeBonus : 0;
      if ((unit.flags.mirrorMelee || 0) !== want) {
        unit.meleeBonus = (unit.meleeBonus || 0) - (unit.flags.mirrorMelee || 0) + want;
        unit.flags.mirrorMelee = want;
        battle.refreshMelee(unit);
      }
      if (color === 1) {
        battle._heal(unit, P.healPerSec * DT);
        unit.flags.shieldAcc = 0;
      } else if (color === 2) {
        /* 淡粉：每秒 +30。攒余数，够 1 点才结算（否则每帧都发资源事件，60 条/秒） */
        unit.flags.shieldAcc = Math.max(0, unit.flags.shieldAcc || 0) + P.shieldPerSec * DT;
        unit.flags.shieldDecayAcc = 0;
        const whole = Math.floor(unit.flags.shieldAcc);
        if (whole > 0) {
          unit.flags.shieldAcc -= whole;
          battle._gainResource(unit, whole, 'waterMirror');
        }
      } else {
        unit.flags.shieldAcc = 0;
      }
      /* 不在淡粉色：护盾每秒衰减 5（同样攒够 1 点才结算）。
         ⚠ 这里必须用**另一个**累加器：和上面共用一个的话，
         "淡绿分支把它清零" 会把衰减的余数一起抹掉 —— 实测表现就是
         "切回淡绿之后护盾一点都不会掉"（存了半天才发现）。 */
      if (color !== 2) {
        if (unit.res > 0) {
          unit.flags.shieldDecayAcc = (unit.flags.shieldDecayAcc || 0) + P.shieldDecayPerSec * DT;
          const whole = Math.floor(unit.flags.shieldDecayAcc);
          if (whole > 0) {
            unit.flags.shieldDecayAcc -= whole;
            battle._spendResource(unit, whole, 'decay');
          }
        } else {
          unit.flags.shieldDecayAcc = 0;
        }
      }
    },
    /* 护盾吸收：先扣护盾，剩下的才打到血上 */
    onBeforeDamage(battle, unit, ctx) {
      if (!(unit.res > 0)) return;
      const spent = battle._spendResource(unit, ctx.amount, 'shield');
      if (!(spent > 0)) return;
      battle._emit('shieldHit', unit, null, spent, { amount: ctx.amount });
      const left = ctx.amount - spent;
      /* 全额挡下时返回 0 —— 引擎会把这次伤害整个取消（不再夹到 1 点） */
      return { amount: Math.max(0, left) };
    },
  },
};

/* ------------------------------------------------------------
   ② 水镜·魔力共鸣（猩红色）：常驻长剑
   ------------------------------------------------------------
   "见晴**移动方向**的前方 120° 范围" —— 扇形中心是她的速度方向（face），
   不是"朝目标的方向"。站着不动（蓄力等）时才退回 face 字段（上次的朝向）。

   两套间隔各记各的：攻击性挥动 ≥ 1 秒，防御性挥动（消魔弹）≥ 5 秒。
   两者都放在 onThink 里 —— 那是引擎认定的"攻击决策"钩子，
   所以起飞期间会被自动拦掉（作者：空中不发动其他技能的攻击）。 */
export const SKILL_MIRROR_SWORD = {
  id: 'jianqing_mirror_sword',
  name: '水镜·魔力共鸣（猩红色）',
  desc: '移动速度+10，获得一把80伤害的大宝剑，挥动间隔1秒；' +
        '前方出现敌方弹道时，会挥剑至多消除三个弹道，间隔2.5秒。',
  descDetail: `常驻：移动速度 +${JIANQING.mirrorSword.speedBonus}；` +
        `小球边缘绑着一柄猩红色长剑，长度等于小球直径（${JIANQING.mirrorSword.swordLen} 世界单位）。\n` +
        `· **攻击性挥动**：见晴**移动方向**的前方 ${JIANQING.mirrorSword.frontDeg}° 扇形里` +
        `出现敌方小球就挥剑，造成 ${JIANQING.mirrorSword.dmg} 点伤害；` +
        `两次之间至少间隔 ${JIANQING.mirrorSword.atkInterval} 秒。\n` +
        `· **防御性挥动**：同一条扇形里出现敌方弹道（魔弹 / 箭矢 / 蝙蝠…）时也挥剑，` +
        `一次最多消除 ${JIANQING.mirrorSword.purgeMax} 个，两次之间至少间隔 ` +
        `${JIANQING.mirrorSword.defInterval} 秒。钉在施法者身上的光柱不算"弹射物"，不会被扫掉。\n` +
        `长剑暂时用深红色光柱表现（这一式还没有美术）。`,
  trigger: { type: 'passive' },
  /* 持续发动型（常驻长剑）：被偷到时按"借用 5 秒"处理 —— 放一次对
     "常驻"这种能力毫无意义，剑是挂在身上持续挥的。 */
  sustain: true,
  passive(battle, unit) {
    unit.speedBonus = (unit.speedBonus || 0) + JIANQING.mirrorSword.speedBonus;
    battle.refreshSpeed(unit);
    /* 剑长记在 swordBase 上：精灵变身（⑤）要把它减半，
       而两个被动谁先跑取决于装配顺序 —— 所以两边都从 swordBase 现算。 */
    unit.swordBase = JIANQING.mirrorSword.swordLen;
    unit.swordLen = unit.swordBase * (unit.smallForm ? JIANQING.transform.swordMul : 1);
    unit.flags.swordAtkCd = 0;
    unit.flags.swordDefCd = 0;
  },
  /** 归还时把"挂上去的东西"摘掉：移速加成与那柄剑。
   *  借剑的缇娜身上没有 ⑤，所以直接还原成 0 —— 但移速要按减法撤，
   *  不能写死（她可能同时被别的技能加过速）。 */
  onUnborrow(battle, unit) {
    unit.swordLen = 0;
    unit.swordBase = 0;
    unit.speedBonus = (unit.speedBonus || 0) - JIANQING.mirrorSword.speedBonus;
    battle.refreshSpeed(unit);
  },
  hooks: {
    onThink(battle, unit) {
      const P = JIANQING.mirrorSword;
      unit.flags.swordAtkCd = Math.max(0, (unit.flags.swordAtkCd || 0) - DT);
      unit.flags.swordDefCd = Math.max(0, (unit.flags.swordDefCd || 0) - DT);
      if (!(unit.swordLen > 0)) return;

      /* 长剑**始终朝向锁定的敌人**（作者 2026-10 的修改）。
         以前是"以移动方向为中心"，站着不动时剑会僵在最后一次的朝向上 ——
         现在改成每帧朝向 `_nearestEnemy` 算出来的角度：
           · `inCone` 的扇形中心也跟着它，所以"够不够得着"变成纯距离判定
             （剑一直对着敌人，方向不再需要玩家考虑）；
           · 这个角度同时写进快照第 19 位，渲染层画平时那柄剑时用它；
           · 没有敌人时退回上一次的朝向（face），不会突然甩到右边。 */
      const foe = battle._nearestEnemy(unit);
      const dir = foe
        ? Math.atan2(foe.y - unit.y, foe.x - unit.x)
        : ((unit.face ?? 0) * Math.PI) / 180;
      unit.swordAngle = ((dir * 180) / Math.PI + 360) % 360;
      const half = (P.frontDeg / 2) * Math.PI / 180;
      /* 够得着：球心距 ≤ 自身半径 + 剑长 + 对方半径（"剑尖扫到"的判定）。
         ⚠ 单位：目标位置与 unit.x/y、unit.r 都是**定点数**（×SCALE），
         而 swordLen 是**世界单位** —— 混着比会被放大 1000 倍，
         结果就是"谁都够不着"（或"全都够得着"）。这里统一换算成世界单位再比。 */
      const selfR = unit.r / SCALE;
      const inCone = (t, extra) => {
        const dx = t.x - unit.x, dy = t.y - unit.y;
        const dist = Math.hypot(dx, dy) / SCALE;      // → 世界单位
        if (dist > selfR + unit.swordLen + (extra || 0)) return 0;
        let diff = Math.atan2(dy, dx) - dir;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        return Math.abs(diff) <= half ? dist : 0;
      };

      /* ---- 防御性挥动：先判（消魔弹的机会更稀有，别被攻击性挥动抢掉）---- */
      if (unit.flags.swordDefCd <= 0) {
        const doomed = [];
        for (const p of battle.projectiles) {
          if (!p.alive || p.team === unit.team) continue;
          if (p.beam || p.beamForward || p.anchor >= 0) continue;   // 光柱不算弹射物
          if (!inCone(p, p.r / SCALE)) continue;
          doomed.push(p);
          if (doomed.length >= P.purgeMax) break;
        }
        if (doomed.length) {
          for (const p of doomed) {
            p.alive = false;
            battle._emit('projPurge', unit, null, 0, {
              px: p.x / SCALE, py: p.y / SCALE, color: p.color, tag: p.tag,
            });
          }
          unit.flags.swordDefCd = P.defInterval;
          unit.flags.swordAtkCd = Math.max(unit.flags.swordAtkCd, 0.001);
          battle._emit('swordSwing', unit, null, 0, {
            angle: dir, swordLen: unit.swordLen, kind: 'guard', purged: doomed.length,
            sweepDeg: P.sweepDeg, swingFrames: P.swingFrames,
          });
          return;
        }
      }

      /* ---- 攻击性挥动：前方扇形里有敌方小球就砍 ---- */
      if (unit.flags.swordAtkCd > 0) return;
      let best = null, bestDist = Infinity;
      for (const o of battle.units) {
        if (o === unit || !o.alive || o.team === unit.team) continue;
        const dist = inCone(o, o.r / SCALE);
        if (dist > 0 && dist < bestDist) { best = o; bestDist = dist; }
      }
      if (!best) return;
      const dmg = battle._scaledDamage(unit, P.dmg);
      battle._damage(unit, best, dmg, 'skill');
      unit.flags.swordAtkCd = P.atkInterval;
      battle._emit('swordSwing', unit, best, dmg, {
        angle: Math.atan2(best.y - unit.y, best.x - unit.x),
        swordLen: unit.swordLen, kind: 'attack',
        sweepDeg: P.sweepDeg, swingFrames: P.swingFrames,
      });
    },
  },
};

/* ------------------------------------------------------------
   ③ 水镜·魔力共鸣（深蓝紫色和白色）：每 9 秒随机切，借晕彩的魔弹 / 激光
   ------------------------------------------------------------
   深浅两态的**攻击方式完全不同**，所以这里不走引擎的冷却分发
   （那个冷却时长是写在 trigger 里的常量，换色换不了它），
   而是自己在 onThink 里记一个计时器：
     · 深蓝紫：每 3 秒一发魔弹（没有第三发激光）→ 9 秒周期里 4 发
     · 白色  ：每 4 秒一发贯穿光柱           → 9 秒周期里 3 发
   放 onThink 还有个好处：起飞期间会被自动拦掉（"空中不发动攻击"）。 */
export const SKILL_MIRROR_BORROW = {
  id: 'jianqing_mirror_borrow',
  name: '水镜·魔力共鸣（攻击）',
  /* 简要描述 = 作者给的官方措辞（2026-10 定稿；这一版把名字从
     "（深蓝紫与白）"改成了"（攻击）"，因为是他在这一轮明确要改的）。 */
  desc: '每9秒随机切换一次颜色。深蓝紫色时发射75点伤害的魔弹，一个周期内最多发射4发；' +
        '白色时发射170点伤害的激光，一个周期内最多发射3发。',
  descDetail: `每 ${JIANQING.mirrorBorrow.cycle} 秒**随机**切一次颜色（深蓝紫 / 白），` +
        `允许连续切到同一个颜色。\n` +
        `· 深蓝紫色：借来晕彩的**魔弹**（深紫色特效，**没有第三发激光**）：` +
        `伤害 ${JIANQING.mirrorBorrow.modanDmg}、弹速 ${JIANQING.mirrorBorrow.modanSpeed}、` +
        `每 ${JIANQING.mirrorBorrow.modanCd} 秒一发 —— 一个 9 秒周期里一共 4 发。\n` +
        `· 白色：借来魔弹的**激光**（白色特效）：伤害 ${JIANQING.mirrorBorrow.laserDmg}、` +
        `单次持续 ${JIANQING.mirrorBorrow.laserLife} 秒、每 ${JIANQING.mirrorBorrow.laserCd} 秒一发 —— ` +
        `一个 9 秒周期里一共 3 发。激光一端钉在见晴身上、贯穿战场，每个敌人只结算一次。`,
  trigger: { type: 'passive' },
  /* 持续发动型（借来的魔弹 / 激光）：被偷到时按"借用 5 秒"处理 ——
     它连 run() 都没有，完整效果就是钩子里那套循环。 */
  sustain: true,
  passive(battle, unit) {
    /* 让第 0 帧就切一次色（否则前 9 秒是"无色"，什么都射不出来） */
    unit.flags.borrowT = JIANQING.mirrorBorrow.cycle;
    unit.flags.borrowColor = 0;
    unit.flags.borrowShotCd = 0;
  },
  /** 归还：把借用的那面水镜收起来（颜色位要清，否则缇娜身上一直挂着一圈白/紫） */
  onUnborrow(battle, unit) {
    unit.flags.borrowColor = 0;
    unit.flags.borrowT = 0;
    unit.flags.borrowShotCd = 0;
    unit.auxKind = 0;
  },
  hooks: {
    onThink(battle, unit) {
      const P = JIANQING.mirrorBorrow;
      /* ---- 9 秒的颜色循环 ---- */
      unit.flags.borrowT = (unit.flags.borrowT || 0) + DT;
      if (unit.flags.borrowT >= P.cycle) {
        unit.flags.borrowT -= P.cycle;
        const color = battle.rnd() < 0.5 ? 3 : 4;
        unit.flags.borrowColor = color;
        unit.auxKind = color;
        battle._emit('mirrorSwitch', unit, null, color, { borrow: true, face: unit.face ?? 0 });
      }
      /* ---- 开火 ---- */
      unit.flags.borrowShotCd = Math.max(0, (unit.flags.borrowShotCd || 0) - DT);
      if (unit.flags.borrowShotCd > 0) return;
      const color = unit.flags.borrowColor;
      if (color !== 3 && color !== 4) return;
      const target = battle._nearestEnemy(unit);
      if (!target) return;
      if (color === 3) {
        spawnModanBullet(battle, unit, target, {
          damage: P.modanDmg, speed: P.modanSpeed, r: P.modanR,
          life: P.modanLife, color: P.modanColor,
        });
        unit.flags.borrowShotCd = P.modanCd;
      } else {
        spawnLaserBeam(battle, unit, target, {
          damage: P.laserDmg, speed: P.laserSpeed, life: P.laserLife,
          color: P.laserColor, width: P.laserWidth, len: P.laserLen,
        });
        unit.flags.borrowShotCd = P.laserCd;
      }
    },
  },
};

/* ------------------------------------------------------------
   ④ 起飞：累计移动 1560 单位 → 飞 3 秒
   ------------------------------------------------------------
   引擎侧只加了三个开关（invulnFrames / phasingFrames / noAttackFrames），
   状态机本身在这里：
     · 起飞：无敌 + 穿透 + 禁止攻击；移速 +150；emit('takeoff')
     · 滞空：与任一小球重合就每帧 5 点帧伤（走 _tickDamage，
       所以它进"帧伤"这一类：不吃羽毛的 -5，也能打进同样在飞的对手）
     · 落地：撤掉三个开关、还原速度；emit('landing')
   距离用"每帧位移"累加，落地后接着累加（不是清零重来 ——
   清零会让"刚落地又得再走 1560"变成一个小惩罚，作者没这个意思）。 */
export const SKILL_TAKEOFF = {
  id: 'jianqing_takeoff',
  name: '起飞',
  desc: '累计移动1560世界单位后起飞，滞空4秒，期间移动速度+150，受到所有伤害减半，' +
        '不与任何小球碰撞，会在碰撞墙壁后自动追踪最近的敌人。' +
        '起飞时每帧对接触的敌人造成5点帧伤，降落后永久提升移速与之后起飞的帧伤。',
  descDetail: `累计移动 ${JIANQING.takeoff.distance} 世界单位后起飞，滞空 ` +
        `${JIANQING.takeoff.seconds} 秒（表现：虚化、变大，球下方出现影子 —— 近大远小）。\n` +
        `空中：移动速度 +${JIANQING.takeoff.speedBonus}；**受到的所有伤害减半**；` +
        `**不与任何小球发生碰撞**（只和墙壁碰），` +
        `碰撞箱与任一小球重合时每帧造成 ${JIANQING.takeoff.frameDamage} 点伤害。\n` +
        `**飞行中会以每秒最多 ${JIANQING.takeoff.turnPerSec}° 持续修正航向追踪最近的敌人**；` +
        `**撞到墙壁后**则直接锁定它（空中只跟墙碰撞，不这样的话这几秒就只是随机乱撞）。\n` +
        `空中**其它技能照常可用**（水镜三态、长剑、羽毛都能正常发动）——` +
        `这一版不再禁止攻击。\n` +
        `**每次飞完都会永久变强**：移动速度 +${JIANQING.takeoff.speedPerFlight}（永久、可叠加），` +
        `之后每次飞行的帧伤 +${JIANQING.takeoff.frameDamagePerFlight}（可叠加）——` +
        `第 1 次飞行是 ${JIANQING.takeoff.frameDamage}、第 2 次 ${JIANQING.takeoff.frameDamage + JIANQING.takeoff.frameDamagePerFlight}、` +
        `第 3 次 ${JIANQING.takeoff.frameDamage + JIANQING.takeoff.frameDamagePerFlight * 2}…以此类推。`,
  trigger: { type: 'passive' },
  /* 持续发动型：被缇娜的蝙蝠偷到时"借来**立刻**起飞"（作者 2026-10 的口径），
     滞空时长就是它自己的 seconds；落地那份"每次飞完永久 +5 移速"照给。 */
  sustain: true,
  passive(battle, unit) {
    unit.flags.traveled = 0;
    unit.flags.flyFrames = 0;
    /* 已完成的飞行次数（驱动"速度 +5 / 帧伤 +0.5"的叠加） */
    unit.flags.flyCount = 0;
    unit.flags.flyDmgAcc = 0;
  },
  /** 借来的那一刻：不用走满 1560，直接起飞 */
  onBorrow(battle, unit) {
    takeOff(battle, unit);
  },
  /** 归还时若还悬在空中（滞空比借用时长更长时会出现），让她落地收尾。
   *  ⚠ **不清 flyCount** —— 作者要的"获得叠加移速"就是靠它累积的，
   *  清掉的话下一次借 ④ 就又回到 +5 起步了。 */
  onUnborrow(battle, unit) {
    if (unit.flags.flyFrames > 0) landFlight(battle, unit);
  },
  hooks: {
    onMove(battle, unit) {
      const P = JIANQING.takeoff;
      /* ---------- 滞空中 ---------- */
      if (unit.flags.flyFrames > 0) {
        unit.flags.flyFrames--;
        /* 持续修正航向追踪敌人：每秒最多 turnPerSec 度（作者 2026-10 的要求）。
           引擎的 _deflectTowardEnemy 就是"每帧最多转 N 度"的旋转查表实现，
           小数部分它自己用累加器攒（45/60 = 0.75 度/帧，不会因为取整而丢失）。 */
        if (P.turnPerSec > 0) battle._deflectTowardEnemy(unit, P.turnPerSec * DT);
        /* 与任一小球重合 → 帧伤（友军不算：那属于"自己人撞自己人"）。
           伤害 = 基础 + 已完成飞行次数 × 每次叠加（作者 2026-10 的新机制）。
           ⚠ 0.5 这种小数**不能直接交给引擎**：伤害与 HP 都是整数，
           `_scaledDamage` 会先 round 一次（5.5 → 6），叠几层就偏了。
           所以按"回血余数"那一套：攒够 1 点才真的结算一次，
           平均下来严格等于 5.5 / 帧（表现上是 5、6 交替）。 */
        const per = (P.frameDamage + (unit.flags.flyCount || 0) * P.frameDamagePerFlight)
          * (unit.damageMul ?? 1);
        const r2 = unit.r;
        for (const o of battle.units) {
          if (o === unit || !o.alive || o.team === unit.team) continue;
          const dx = o.x - unit.x, dy = o.y - unit.y;
          const rr = r2 + o.r;
          if (dx * dx + dy * dy >= rr * rr) continue;
          unit.flags.flyDmgAcc = (unit.flags.flyDmgAcc || 0) + per;
          const whole = Math.floor(unit.flags.flyDmgAcc);
          if (whole <= 0) continue;
          unit.flags.flyDmgAcc -= whole;
          battle._tickDamage(unit, o, whole, 'fly', null);
        }
        if (unit.flags.flyFrames === 0) landFlight(battle, unit);
        return;
      }
      /* ---------- 累计移动距离 ---------- */
      /* ⚠ 只统计**没在飞的时候**的位移，而且**起飞那一刻清零**。
         不清零的话触发条件永远成立（累计量还在 1560 以上）——
         落地当帧就再次起飞，表现成"一直飞在天上"（作者实测报的就是这个）。
         清零 + 飞行中不计 = 每次都要老老实实再走满 1560。 */
      const step = Math.hypot(unit.vx, unit.vy) * DT / SCALE;
      unit.flags.traveled = (unit.flags.traveled || 0) + step;
      if (unit.flags.traveled < P.distance) return;
      takeOff(battle, unit);
    },
  },
};

/** 起飞（走满距离触发、或借来的那一刻直接调用）。
 *  抽成函数是因为"借来的 ④"要跳过距离条件直接起飞 ——
 *  否则借 5 秒里她还在慢慢走路，等于什么都没发生。 */
function takeOff(battle, unit) {
  const P = JIANQING.takeoff;
  unit.flags.traveled = 0;
  const frames = Math.round(P.seconds / DT);
  unit.flags.flyFrames = frames;
  /* 空中只与墙壁碰撞（穿透），受到的伤害按倍率减半（作者：免疫 → 减半）。
     **不再**设 invulnFrames / noAttackFrames —— 那两条是上一版的口径，
     现在的口径是"能正常使用其它所有技能、只是少挨点打"。 */
  unit.phasingFrames = frames;
  unit.dmgTakeMul = P.damageTakenMul;
  unit.dmgTakeMulFrames = frames;
  /* 撞墙后直接朝最近的敌人（飞行中只与墙碰撞，不这样的话就是随机乱撞） */
  unit.wallHoming = !!P.wallHoming;
  /* 空中转向限速：引擎的全局微转向（设置里默认 30°/秒）会和技能自己的
     45°/秒**叠加**，实测变成 75°/秒 —— 与"每秒最多 45°"不符。
     这里登记上限，由引擎在 onMove 之后统一钳住（撞墙的瞬间锁定不受限）。 */
  unit.turnCapDegPerSec = P.turnPerSec;
  unit.speedBonus = (unit.speedBonus || 0) + P.speedBonus;
  battle.refreshSpeed(unit);
  battle._emit('takeoff', unit, null, P.seconds);
}

/** 落地：撤掉"穿透 + 减伤 + 转向限速"，还原那份**临时**的移速加成，
 *  并结算"每次飞完永久 +5 移速 / 下次帧伤 +0.5"的成长。 */
function landFlight(battle, unit) {
  const P = JIANQING.takeoff;
  unit.flags.flyFrames = 0;
  unit.phasingFrames = 0;
  unit.dmgTakeMul = 1;
  unit.dmgTakeMulFrames = 0;
  unit.wallHoming = false;
  unit.turnCapDegPerSec = 0;
  unit.speedBonus = (unit.speedBonus || 0) - P.speedBonus;
  /* ---------- 每次飞行之后的永久成长 ----------
     作者 2026-10：「每次起飞过后，速度永久加 5，下次起飞的帧伤增加 0.5，可叠加」。
     在**落地**结算：本次飞行用的还是旧数值，成长留给下一次 ——
     这才对得上"下次起飞的帧伤增加 0.5"。
     借来的 ④ 也照给（作者："且获得叠加移速"）：所以这份 +5 不会被归还撤掉。 */
  unit.flags.flyCount = (unit.flags.flyCount || 0) + 1;
  unit.speedBonus = (unit.speedBonus || 0) + P.speedPerFlight;
  battle.refreshSpeed(unit);
  battle._emit('flyUpgrade', unit, null, unit.flags.flyCount, {
    speedStep: P.speedPerFlight,
    frameDamage: P.frameDamage + unit.flags.flyCount * P.frameDamagePerFlight,
  });
  battle._emit('landing', unit, null, 0);
}

/* ------------------------------------------------------------
   ⑤ 精灵变身：装备即永久生效（作者确认）
   ------------------------------------------------------------
   "大小变为目前的一半"用的是 u.r —— 这个项目的铁律是**看到的多大判定就多大**，
   所以判定半径与显示半径一起减半（渲染层读的就是 u.r）。
   减半是"变小"，不会破坏碰撞网格的单元尺寸（那个按最大半径定的），
   所以不需要动 broad-phase。
   "造成的所有伤害减半"走 damageMul（引擎里所有伤害出口都乘它），
   ② 的长剑长度另外跟着 swordBase 一起减半。 */
export const SKILL_TRANSFORM = {
  id: 'jianqing_transform',
  name: '精灵变身',
  desc: '见晴体型变小，造成的所有伤害减少，移动速度大幅增加。',
  descDetail: `装备即生效（永久）：\n` +
        `· 体型变为 ${JIANQING.transform.sizeMul * 100}%（判定与显示一起变，长剑也随之减半）；\n` +
        `· 移动速度 +${JIANQING.transform.speedBonus}；\n` +
        `· 造成的**所有**伤害 ×${JIANQING.transform.damageMul} —— 碰撞、魔弹、激光、长剑、` +
        `连空中那 5 点帧伤都算。`,
  trigger: { type: 'passive' },
  /* 持续发动型：被偷到时借缇娜 5 秒（作者 2026-10 的口径）。
     注意这对缇娜**是削弱**：她的伤害也会 ×0.7 —— 但她体型变小、移速 +55。 */
  sustain: true,
  /** 被动会把体型 / 伤害倍率真改掉，想**原样**还回去就必须在它跑之前先记一份 */
  prepareBorrow(battle, unit) {
    unit.flags.preForm = { r: unit.r, damageMul: unit.damageMul ?? 1 };
  },
  passive(battle, unit) {
    const P = JIANQING.transform;
    unit.smallForm = true;
    /* 半径是定点数（×SCALE），所以直接对半砍 */
    unit.r = Math.max(1, Math.round(unit.r * P.sizeMul));
    unit.speedBonus = (unit.speedBonus || 0) + P.speedBonus;
    battle.refreshSpeed(unit);
    unit.damageMul = (unit.damageMul ?? 1) * P.damageMul;
    /* 长剑长度跟着体型走（② 的被动可能还没跑，所以两边都要判一手） */
    if (unit.swordBase) unit.swordLen = unit.swordBase * P.swordMul;
  },
  /** 归还：把变身整个撤掉（体型、移速、伤害倍率、剑长都回到借用前的样子） */
  onUnborrow(battle, unit) {
    const P = JIANQING.transform;
    const s = unit.flags.preForm;
    if (s) {
      unit.r = s.r;
      unit.damageMul = s.damageMul;
      unit.flags.preForm = null;
    }
    unit.smallForm = false;
    unit.speedBonus = (unit.speedBonus || 0) - P.speedBonus;
    /* 剑长：借用期间被 ×0.6 过，还回去时按"没变身"的长度算 */
    if (unit.swordBase) unit.swordLen = unit.swordBase;
    battle.refreshSpeed(unit);
  },
};

/* ------------------------------------------------------------
   ⑥ 我很可爱：每掉 300 血发一根追踪羽毛
   ------------------------------------------------------------
   羽毛：追踪（homing）+ 撞墙反弹（bounces）+ 速度 250。
   命中后果（作者确认）：**移速减半只持续 3 秒**，而**减伤是叠加的、本局永久**：
     · 移速减半：写 speedMul + speedMulFrames，3 秒后引擎自己还原；
     · 碰撞伤害 -5、技能伤害 -5：写 meleePenalty / skillPenalty，
       由 _damage 在结算时扣（一处覆盖所有伤害来源），**帧伤不减**。
   "每下降 300 血"用累计受伤量算，余数留着（掉了 500 血就是"发一根、余 200"）。 */
export const SKILL_FEATHER = {
  id: 'jianqing_feather',
  name: '我很可爱',
  desc: '累计受到300点伤害后发射一根追踪羽毛，被命中的小球在3秒内移速减半，伤害永久降低。',
  descDetail: `每累计受到 ${JIANQING.feather.hpStep} 点伤害就发射一根羽毛` +
        `（速度 ${JIANQING.feather.speed}，持续追踪最近的敌人，可以被墙壁反弹 ` +
        `${JIANQING.feather.bounces} 次）。\n` +
        `被羽毛命中的小球：\n` +
        `· 移动速度减半，持续 ${JIANQING.feather.slowSeconds} 秒（再次命中只是刷新这 3 秒）；\n` +
        `· **造成的**碰撞伤害 -${JIANQING.feather.meleeMinus}、技能伤害 -${JIANQING.feather.skillMinus}，` +
        `可以叠加、本局永久（每一下都扣，最低扣到 1 点为止）；\n` +
        `· 每帧持续伤害（帧伤）不受影响 —— 作者明确排除。`,
  trigger: { type: 'passive' },
  passive(battle, unit) {
    unit.flags.featherAcc = 0;
  },
  /** 被蝙蝠偷到时只"放一次" —— 就是**立刻发一根羽毛**（作者 2026-10 的口径）。
   *  对见晴自己没有任何影响：她的 trigger 是 passive，
   *  而引擎只按 cooldown / onWall / onHit / onHpBelow / onHits 分发 run()。 */
  run({ battle, unit }) {
    fireFeather(battle, unit);
    return true;
  },
  hooks: {
    onDamaged(battle, unit, ctx) {
      const P = JIANQING.feather;
      const amount = (ctx && ctx.amount) || 0;
      if (!(amount > 0)) return;
      unit.flags.featherAcc = (unit.flags.featherAcc || 0) + amount;
      let fired = 0;
      while (unit.flags.featherAcc >= P.hpStep && fired < 8) {
        unit.flags.featherAcc -= P.hpStep;
        fired++;
        fireFeather(battle, unit);
      }
    },
  },
};

/** 发一根羽毛（⑥ 的弹体：追踪 + 反弹 + 命中挂减益） */
function fireFeather(battle, unit) {
  const P = JIANQING.feather;
  const target = battle._nearestEnemy(unit);
  /* 没有敌人也要发（朝着当前朝向飞出去）—— 作者说的是"每当生命值下降 300 就发射"，
     没有"必须有目标"这个前提。玩家操控时初始方向跟鼠标（之后它自己追踪）。 */
  const aim = target ? battle.aimUnit(unit, target) : null;
  const ang = aim
    ? Math.atan2(aim.uy, aim.ux)
    : ((unit.face ?? 0) * Math.PI) / 180;
  const spd = P.speed * SCALE;
  battle._spawnProjectile({
    kind: 'aura', tag: 'feather', owner: unit,
    feather: true,                       // 进快照的 kind=4（渲染层据此画羽毛）
    x: unit.x, y: unit.y,
    vx: Math.round(Math.cos(ang) * spd), vy: Math.round(Math.sin(ang) * spd),
    damage: 0,                           // 羽毛本身不造成伤害，只挂减益
    radius: Math.round(P.r * SCALE),
    life: P.life, color: P.color,
    bounces: P.bounces,
    homing: target ? { targetId: target.id, turnPerSec: P.turnPerSec } : null,
    onHit: (b, from, hit) => {
      if (!hit) return;
      applyFeatherDebuff(b, hit);
      b._emit('featherHit', from, hit, 0, { px: hit.x / SCALE, py: hit.y / SCALE });
    },
  });
}

/** 羽毛命中后的减益（速度减半 3 秒 + 减伤永久叠加）。
 *  **导出**是为了让诊断能调它 —— 测试里自己再抄一份减益逻辑的话，
 *  真正的那份写错了也测不出来（测试会测自己抄的那份）。 */
export function applyFeatherDebuff(battle, target) {
  const P = JIANQING.feather;
  target.meleePenalty = (target.meleePenalty || 0) + P.meleeMinus;
  target.skillPenalty = (target.skillPenalty || 0) + P.skillMinus;
  /* 速度减半：只刷新时长，**不叠加成 1/4** */
  target.speedMul = P.slowMul;
  target.speedMulFrames = Math.round(P.slowSeconds / DT);
  battle.refreshSpeed(target);
}

/** 这个技能在**玩家操控**时是不是"按键发动"的主动技能。
 *
 *  作者 2026-10 的口径：主动攻击技能改为按键触发（原来的间隔变成技能冷却），
 *  被动技能照旧自动触发（裁光、见晴的变色…）。
 *  在本项目里这条规则正好落在"触发方式"上：
 *    · 冷却触发 = 原来"每 N 秒自己放一次"的主动技能 → 按键
 *    · 撞墙 / 被动 / 掉血阈值 / 撞击触发 = 被动技 → 自动
 *  例外用 `auto: true` 标出来（见晴①变色：内部是冷却，但按作者口径算被动）。
 */
export function isManualSkill(sk) {
  return !!(sk && sk.trigger && sk.trigger.type === 'cooldown' && !sk.auto);
}

/** 玩家操控时"要占一个技能键"的技能 id 列表 —— 顺序 = 按键顺序。
 *  引擎只按这个列表分发（见 core.js 的 _runSkills），
 *  界面也用它生成技能栏与按键提示，两边**同一份口径**。 */
export function manualSkillIds(unit) {
  const out = [];
  for (const id of (unit && unit.skills) || []) {
    const sk = getSkill(id);
    if (isManualSkill(sk)) out.push(id);
  }
  return out;
}

export const SKILLS = {
  [SKILL_TINA_SUCK.id]: SKILL_TINA_SUCK,
  [SKILL_TINA_BAT.id]: SKILL_TINA_BAT,
  [SKILL_TINA_SHOT.id]: SKILL_TINA_SHOT,
  [SKILL_TINA_SCEPTER.id]: SKILL_TINA_SCEPTER,
  [SKILL_TINA_P1.id]: SKILL_TINA_P1,
  [SKILL_TINA_P2.id]: SKILL_TINA_P2,
  [SKILL_TINA_P3.id]: SKILL_TINA_P3,
  [SKILL_SHOT.id]: SKILL_SHOT,
  [SKILL_DASH.id]: SKILL_DASH,
  [SKILL_CAIGUANG.id]: SKILL_CAIGUANG,
  [SKILL_MODAN.id]: SKILL_MODAN,
  [SKILL_ZHEGUANG.id]: SKILL_ZHEGUANG,
  [SKILL_KAIHUA.id]: SKILL_KAIHUA,
  [SKILL_PRISM.id]: SKILL_PRISM,
  [SKILL_DOMAIN.id]: SKILL_DOMAIN,
  [SKILL_XIGUANG.id]: SKILL_XIGUANG,
  [SKILL_RONG.id]: SKILL_RONG,
  [SKILL_KU.id]: SKILL_KU,
  [SKILL_AIM.id]: SKILL_AIM,
  [SKILL_CHUNJING.id]: SKILL_CHUNJING,
  [SKILL_TOP.id]: SKILL_TOP,
  /* 闯关肉鸽 · 敌人的魔弹 */
  [SKILL_NPC_BOLT50.id]: SKILL_NPC_BOLT50,
  [SKILL_NPC_BOLT100.id]: SKILL_NPC_BOLT100,
  /* 见晴（白水仙） */
  [SKILL_MIRROR_DEF.id]: SKILL_MIRROR_DEF,
  [SKILL_MIRROR_SWORD.id]: SKILL_MIRROR_SWORD,
  [SKILL_MIRROR_BORROW.id]: SKILL_MIRROR_BORROW,
  [SKILL_TAKEOFF.id]: SKILL_TAKEOFF,
  [SKILL_TRANSFORM.id]: SKILL_TRANSFORM,
  [SKILL_FEATHER.id]: SKILL_FEATHER,
};

export function getSkill(id) {
  return SKILLS[id] || null;
}

/**
 * 互斥技能的整理：同一 group 里只保留第一个，后面的丢掉。
 *
 * 为什么放在 skills.js 而不是 balls.js：分组信息属于技能注册表，
 * 而 balls.js 不能 import skills.js —— skills.js 顶部就要用 balls.js 的
 * SCALE / DT 做常量计算，反过来引会形成循环依赖，
 * ES 模块下会变成"访问未初始化的 DT"直接报错。
 *
 * 三个地方都要用它，缺一个就会出现"界面显示装了 2 个、引擎只认 1 个"：
 *   · 引擎建单位时（core.js）—— 权威口径
 *   · 准备界面存装配时（ui-prepare.js）
 *   · 准备界面渲染勾选框时（把互斥项置灰并说明原因）
 */
export function resolveLoadout(ids) {
  const out = [];
  const usedGroups = new Set();
  for (const id of ids || []) {
    const sk = getSkill(id);
    if (!sk) continue;
    if (sk.group) {
      if (usedGroups.has(sk.group)) continue;    // 同组已经选过一个了
      usedGroups.add(sk.group);
    }
    out.push(id);
  }
  return out;
}

/** 某个技能是否与"已选的其它技能"互斥（准备界面用它置灰勾选框） */
export function conflictsWithChosen(id, chosenIds) {
  const sk = getSkill(id);
  if (!sk || !sk.group) return false;
  if ((chosenIds || []).includes(id)) return false;   // 自己已经选了，不算冲突
  return (chosenIds || []).some(x => {
    const o = getSkill(x);
    return o && o.group === sk.group;
  });
}

/** 取技能所属的互斥组名（没有分组返回 null） */
export function skillGroup(id) {
  const sk = getSkill(id);
  return (sk && sk.group) || null;
}

/**
 * 取技能描述文本。
 * detail = true 时优先返回详细版；没有详细版就退回简要版（新技能可以只写一套）。
 */
export function skillDesc(skill, detail) {
  if (!skill) return '';
  if (detail && skill.descDetail) return skill.descDetail;
  return skill.desc || '';
}

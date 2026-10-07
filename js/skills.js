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
    laserDmg: 150, laserSpeed: 1000, laserColor: '#e9d5ff',
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
  domain: { dodge: 0.10, dodgeBloomed: 0.15 },

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
export const SKILL_MODAN = {
  id: 'yuncai_modan',
  name: '魔弹',
  desc: '每两秒发射一发魔力球，累计命中两次后，下一发改为发射更强大的激光。',
  descDetail: `每 ${YUNCAI.modan.cd} 秒瞄准最近的敌人发射一枚淡紫色魔力球` +
        `（速度 ${YUNCAI.modan.speed}，伤害 ${YUNCAI.modan.dmg}，带"光"）。` +
        `命中判定包括两种：打中敌方小球，以及**被裁光的细线吸收** —— 两种都算一次命中。` +
        `累计命中 ${YUNCAI.modan.hitsToLaser} 次后，下一发改为发射一道圆柱体光柱` +
        `（速度 ${YUNCAI.modan.laserSpeed}，伤害 ${YUNCAI.modan.laserDmg}，宽度 ${YUNCAI.modan.laserWidth}，带"光"），` +
        `激光会**穿透**目标：打中之后继续往前飞，沿途每个敌人各吃一次伤害，同一个目标不会重复结算。` +
        `发射后命中计数归零。`,
  trigger: { type: 'cooldown', cd: YUNCAI.modan.cd },
  run(ctx) {
    const { battle, unit, target } = ctx;
    if (!target) return false;                 // 没有对手就不发动，也不吃冷却
    const P = YUNCAI.modan;
    const hits = unit.flags.modanHits || 0;

    if (hits >= P.hitsToLaser) {
      /* 第三发：激光。宽度 laserWidth，判定半径取它的一半 ——
         粗细只定义一处，画多粗就判定多粗。
         激光**穿透**目标：打中之后继续往前飞，沿途每个敌人各吃一次。 */
      unit.flags.modanHits = 0;
      const dx = target.x - unit.x, dy = target.y - unit.y;
      const d = Math.hypot(dx, dy) || 1;
      const spd = P.laserSpeed * SCALE;
      battle._spawnProjectile({
        kind: 'aura', tag: 'laser', owner: unit,
        x: unit.x, y: unit.y,
        vx: Math.round((dx / d) * spd), vy: Math.round((dy / d) * spd),
        damage: battle._lightDamage(unit, P.laserDmg),
        radius: Math.round((P.laserWidth / 2) * SCALE),
        width: P.laserWidth,
        beam: true,
        pierce: true,
        life: 3, color: P.laserColor, traits: ['light'],
      });
    } else {
      const dx = target.x - unit.x, dy = target.y - unit.y;
      const d = Math.hypot(dx, dy) || 1;
      const spd = P.speed * SCALE;
      /* 命中计数：打中敌人算一次，**被裁光的细线吸收也算一次** ——
         都是"这发魔力球确实命中了东西"，所以共用一个回调。 */
      const countHit = (b, from) => {
        if (!from) return;
        from.flags.modanHits = (from.flags.modanHits || 0) + 1;
      };
      battle._spawnProjectile({
        kind: 'aura', tag: 'modan', owner: unit,
        x: unit.x, y: unit.y,
        vx: Math.round((dx / d) * spd), vy: Math.round((dy / d) * spd),
        damage: battle._lightDamage(unit, P.dmg),
        radius: Math.round(P.r * SCALE),
        life: P.life, color: P.color, traits: ['light'],
        onHit: countHit,
        onAbsorb: countHit,
      });
    }
    return true;
  }
};

/* ------------------------------------------------------------
   ③ 折光：被动把碰撞伤害改成 100；每次近战命中后隐身 1 秒
   ------------------------------------------------------------ */
export const SKILL_ZHEGUANG = {
  id: 'yuncai_zheguang',
  name: '折光',
  desc: '获得100点的碰撞伤害，碰撞后隐身1秒。',
  descDetail: `碰撞伤害由 0 改为 ${YUNCAI.zheguang.melee}。` +
        `每次成功造成近战伤害后进入隐身，持续 ${YUNCAI.zheguang.stealthSeconds} 秒。` +
        `隐身期间**不会受到敌方小球的近战伤害**，但弹道与场地物件（裁光的质点/细线）照常命中。` +
        `隐身期间画面上的小球会变成半透明并带一圈虚线轮廓。`,
  trigger: { type: 'passive' },
  passive(battle, unit) {
    unit.melee = YUNCAI.zheguang.melee;
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
    unit.speed = Math.round(P.speed * SCALE);
    unit.baseSpeed = unit.speed;
    unit.lightBonus = P.lightBonus;
    unit.melee += P.meleeBonus;
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

    const dx = target.x - unit.x, dy = target.y - unit.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d;

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
    battle.aurora = true;
    battle._emit('domainOn', unit, null, 0);
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

/* ------------------------------------------------------------
   注册表：小球通过 skills: ['test_shot','test_dash'] 引用
   ------------------------------------------------------------ */
export const SKILLS = {
  [SKILL_SHOT.id]: SKILL_SHOT,
  [SKILL_DASH.id]: SKILL_DASH,
  [SKILL_CAIGUANG.id]: SKILL_CAIGUANG,
  [SKILL_MODAN.id]: SKILL_MODAN,
  [SKILL_ZHEGUANG.id]: SKILL_ZHEGUANG,
  [SKILL_KAIHUA.id]: SKILL_KAIHUA,
  [SKILL_PRISM.id]: SKILL_PRISM,
  [SKILL_DOMAIN.id]: SKILL_DOMAIN,
  [SKILL_XIGUANG.id]: SKILL_XIGUANG,
};

export function getSkill(id) {
  return SKILLS[id] || null;
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

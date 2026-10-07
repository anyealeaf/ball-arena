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
      const dx = target.x - unit.x, dy = target.y - unit.y;
      const d = Math.hypot(dx, dy) || 1;
      const spd = P.laserSpeed * SCALE;
      battle._spawnProjectile({
        kind: 'aura', tag: 'laser', owner: unit,
        x: unit.x, y: unit.y,
        vx: Math.round((dx / d) * spd), vy: Math.round((dy / d) * spd),
        damage: battle._lightDamage(unit, P.laserDmg),
        /* 碰撞半径只用于"撞墙夹紧"；它锚在晕彩身上，而她永远离墙 ≥ 她的半径，
           所以这道光柱不会因为贴墙而消失。真正的伤害走下面的胶囊判定。 */
        radius: Math.round(2 * SCALE),
        width: P.laserWidth,
        beam: true,
        beamForward: true,        // 从晕彩身上**向前**画（普通激光是往后画拖影）
        beamLen: P.laserLen,
        anchor: unit.id,          // 一端始终钉在晕彩身上
        /* 刻意**不设 anchorTarget** —— 设了就会每帧朝目标转向，那是缇娜的光柱 */
        noBodyHit: true,          // 不走"贴到就爆"的弹体命中
        sweepOnce: true,          // 每个目标只结算一次
        absorbable: false,        // 穿过细线，但仍然喂它"光"
        life: P.laserLife,
        color: P.laserColor, traits: ['light'],
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
    /* 渲染层画"气浪展开"要用的三个量，只在激活这一刻写一次。
       中心是**固定**的：气浪从晕彩当时的位置向外扩散到铺满全场；
       若让它跟着晕彩走，离她远的那半边就永远扫不到。 */
    battle.auroraAt = battle.frame;
    battle.auroraCenter = { x: unit.x, y: unit.y };
    battle.auroraStyle = unit.domain || null;
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
       引擎的 knockback 原语保留 —— 测试球的定点射击还在用，
       以后哪个技能要击退，直接在这里加回一个数就行。 */
    burstEvery: 5,          // 射 5 次之后
    burstCount: 5,          // 下一次连发 5 支
    burstDmg: 30,
    burstSpread: 0.42,      // 五连发的扇形张角（弧度，总张角的一半）
  },

  /* ② 映霞[枯]：黑白箭 + 减速 */
  ku: {
    cd: 2, damage: 65, speed: 450, r: 5, life: 2.0, color: '#6b7280',
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

  /* 箭矢贴图（作者提供）。映霞两式共用同一支箭的外观 ──
     目前只有粉色这一张，所以只有「荣」用；「枯」是黑白的，等作者给图。 */
  arrowSprite: 'assets/characters/taoyao_arrow.png',
};

/* 单位身上有没有装「认真拉矢」。
   为什么必须查一下：叠层是挂在**箭矢的命中回调**上的，
   而箭矢不管装没装认真拉矢都会发射。不查的话，
   没装这个技能的桃夭照样在偷偷叠层加伤害 —— 实测满层时箭矢打出了 80 而不是 50。 */
function hasAim(unit) {
  return !!(unit && unit.skills && unit.skills.includes(SKILL_AIM.id));
}

/* ------------------------------------------------------------
   箭矢的公共部分：映霞两式都靠它发射
   ------------------------------------------------------------ */
function fireArrow(battle, unit, target, spec) {
  const dx = target.x - unit.x, dy = target.y - unit.y;
  const d = Math.hypot(dx, dy) || 1;
  const spd = spec.speed * SCALE;
  const stacks = hasAim(unit) ? (unit.flags.aimStacks || 0) : 0;
  /* 认真拉矢：每层 +5，只作用于箭矢（春景的光炮不吃） */
  const dmg = Math.max(1, Math.round(
    (spec.damage + TAOYAO.aim.perStack * stacks) * (unit.damageMul ?? 1)));
  battle._spawnProjectile({
    kind: 'aura', tag: 'arrow', owner: unit,
    sprite: spec.sprite || null,      // 有贴图就画成真箭，没有就回退程序化光点
    /* 箭矢画多长：直接问单位身上挂着的弓配置（bowH × 箭占弓高的比例）。
       这样"搭在弓上的箭"和"飞出去的箭"永远等长，改 bowH 也不用两头改。 */
    spriteLen: (unit.bow && unit.bow.bowH && unit.bow.arrowLenFrac)
      ? unit.bow.bowH * unit.bow.arrowLenFrac : 0,
    x: unit.x, y: unit.y,
    vx: Math.round((dx / d) * spd), vy: Math.round((dy / d) * spd),
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
  desc: '每1秒发射一支粉色的箭矢，箭矢移动速度为500，造成50伤害。' +
        '射击五次后，下一次会连续发射5发箭矢，每支伤害降低到30。',
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
      /* 五连发：朝目标扇形散开 */
      unit.flags.rongShots = 0;
      const base = Math.atan2(target.y - unit.y, target.x - unit.x);
      const n = P.burstCount;
      for (let i = 0; i < n; i++) {
        const off = (n === 1) ? 0 : (i / (n - 1) * 2 - 1) * P.burstSpread;
        const ang = base + off;
        const dx = Math.cos(ang), dy = Math.sin(ang);
        fireArrow(battle, unit, {
          x: unit.x + dx * 1000, y: unit.y + dy * 1000,   // 借方向，用假目标
        }, { ...P, damage: P.burstDmg, knockback: 0, sprite: TAOYAO.arrowSprite });
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
  desc: '每2秒发射一支黑白色的箭矢，箭矢移动速度为450，造成65伤害，' +
        '被命中后的小球移动速度减少20，持续2秒。',
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
  desc: '被动技能，每次箭矢命中后，下一发箭矢伤害提高5点，最多叠加十层，' +
        '箭矢落空之后会降低两层层数。',
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
  desc: '每隔10秒对自己施加一次持续5秒的"春景"buff，在buff下，' +
        '桃夭每秒恢复10点生命值，每2.5秒额外发射一次淡粉色的光炮，光炮伤害为180。',
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
      const dx = target.x - unit.x, dy = target.y - unit.y;
      const d = Math.hypot(dx, dy) || 1;
      const spd = P.cannonSpeed * SCALE;
      battle._spawnProjectile({
        kind: 'aura', tag: 'chunjing_cannon', owner: unit,
        x: unit.x, y: unit.y,
        vx: Math.round((dx / d) * spd), vy: Math.round((dy / d) * spd),
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
  desc: '被攻击时，桃夭的小球会开始旋转，转速会进行叠加，最多叠加10层。' +
        '每层会使桃夭碰撞伤害提升2点，移动速度提升2点。',
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
    damage: 6, r: 5, life: 4,
    /* 回到缇娜身上时回的血（作者 2026-10 从 6 下调到 3）。
       注意「权杖」只提高**伤害**，不提高回血 —— 回血不是伤害。 */
    heal: 3,
    mana: 1,              // 回到缇娜身上时加的魔力
    color: '#a21caf',
  },

  /* ③ 魔力霰弹 */
  shot: {
    cd: 2,                // 每 2 秒一轮
    count: 3,
    windowSeconds: 0.5,   // 一轮里的 3 发在 0.5 秒内打完
    spreadDeg: 15,        // 每发随机偏 0~15°
    damage: 30, speed: 420, r: 5, life: 2.2,
    color: '#e11d48',     // 猩红
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

/* ---------- 小工具 ---------- */
const TINA_SUCK_ID = 'tina_suck';
const hasSkill = (unit, id) => !!(unit && unit.skills && unit.skills.includes(id));

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
  const dx = target.x - unit.x, dy = target.y - unit.y;
  const d = Math.hypot(dx, dy) || 1;
  const spd = P.speed * SCALE;
  /* 初始方向：朝目标，但**随机散开一点** ——
     3~5 只如果完全同向重叠，看起来只有一只。 */
  const base = Math.atan2(dy, dx) + (battle.rnd() * 2 - 1) * 0.5;
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

/** 能被"偷学"的技能：**能释放一次的主动技能**。
 *  作者口径是排除"领域类 / 近战类 / 碰撞墙壁类"，这三类在本项目里恰好
 *  全都是被动（辉光领域、折光）或撞墙触发（裁光），所以一条规则就够：
 *    有 run()（被动没有）+ 不是 onWall（碰撞墙壁类）
 *  比逐个点名白名单稳 —— 以后新加的技能自动被正确归类。 */
function stealableFrom(victim) {
  const out = [];
  for (const id of victim.skills || []) {
    const sk = getSkill(id);
    if (!sk || typeof sk.run !== 'function') continue;
    if (!sk.trigger || sk.trigger.type === 'onWall') continue;
    if (sk.noSteal) continue;
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
  desc: '碰撞伤害降低到30，但是碰撞后会吸附在对方小球身上1.5秒，' +
        '这期间对方小球无法使用技能（除碰撞墙体使用的技能以外），移速降低一半。' +
        '同时，在这1.5秒内，会造成3次缇娜的碰撞伤害，缇娜会回复对应数值的生命值。' +
        '并且缇娜自己在这段时间不会受到碰撞伤害。回复数值不会超过缇娜的生命上限。' +
        '吸附结束后有1秒的间隔，期间不会再次吸附。',
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
  desc: '每3秒释放带有追踪能力的3~5只小蝙蝠，每只蝙蝠在追踪时最多进行60度的偏转，' +
        '蝙蝠命中后对敌方小球造成6点伤害，随后会返回缇娜身上，' +
        '每只蝙蝠返回会恢复缇娜3点生命值，并提供一点魔力计数。' +
        '魔力计数满5点后，根据蝙蝠最后命中的目标，缇娜会随机抽取其一个技能' +
        '（不会释放领域类、近战类、以及碰撞墙壁类的技能）释放一次。',
  descDetail: `每 ${TINA.bat.cd} 秒放出一批 **${TINA.bat.minCount}~${TINA.bat.maxCount} 只**小蝙蝠，` +
        `朝最近的敌人追踪：速度 ${TINA.bat.speed}，**每秒最多偏转 ${TINA.bat.turnPerSec}°**` +
        `（是"转速上限"而不是"总偏角上限"——追不到就会绕圈追）。` +
        `命中造成 ${TINA.bat.damage} 伤害，然后**掉头飞回缇娜**；` +
        `每只回到身上时回复 ${TINA.bat.heal} 点生命（**回血不吃权杖加成** —— 权杖提高的是伤害）、` +
        `魔力 +${TINA.bat.mana}。` +
        `魔力满 ${5} 点后清空，并按**最后命中的目标**随机抽它一个技能放一次。` +
        `可偷的范围是"能释放一次的主动技能"：被动（辉光领域、折光、认真拉矢、陀螺…）` +
        `没有"释放一次"这回事，撞墙触发的（裁光）也在排除之列。` +
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
  desc: '对着敌方小球在0.5秒内连续发射三个猩红色魔弹，发射间隔为2秒，' +
        '每颗魔弹发射时都会随机出现0~15°的角度偏差，每颗魔弹伤害为30.',
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
  const base = Math.atan2(target.y - unit.y, target.x - unit.x);
  const off = (battle.rnd() * 2 - 1) * ((P.spreadDeg * Math.PI) / 180);
  const a = base + off;
  const spd = P.speed * SCALE;
  battle._spawnProjectile({
    kind: 'aura', tag: 'tina_shot', owner: unit,
    x: unit.x, y: unit.y,
    vx: Math.round(Math.cos(a) * spd),
    vy: Math.round(Math.sin(a) * spd),
    damage: dmg, radius: Math.round(P.r * SCALE), life: P.life, color: P.color,
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
  desc: '碰撞伤害提高15点（不影响吸血习性的碰撞伤害），' +
        '魔力霰弹和蝙蝠的伤害各提高三分之一，且增加30°的追踪偏转角。',
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
  desc: '每隔10秒使用一次，造成持续3秒的时间停止，表现为全场除了缇娜以外的球全部褪色，' +
        '此时场上除了缇娜以及缇娜技能产出的攻击外，所有小球和攻击均不会移动。',
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
  desc: '每隔10秒使用一次，缇娜瞬间发动一次蝙蝠（不论有没有携带），' +
        '然后瞬移到锁定的小球边上进行碰撞（如果携带了吸血习性，则会直接吸附吸血）。',
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
  desc: '每隔10秒使用一次，缇娜蓄力1秒后持续发射一条直径与小球一致的猩红色光柱，' +
        '光柱为笔直圆柱体，一端始终在缇娜上，会随着锁定目标的移动转向。' +
        '光柱持续2秒，每秒造成3次攻击判定，每次攻击判定造成35点伤害。',
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

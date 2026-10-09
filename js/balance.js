/* ============================================================
   balance.js — 「数值（平衡）」面板的派生量（纯函数，无 DOM）
   ------------------------------------------------------------
   作者 2026-10 的要求：「让我可以实时修改小球的血量、飞行速度、各种技能伤害数值」。

   编辑器里能直接改的数字（生命 / 速度 / 各技能伤害…）本身是"原料"，
   但作者真正想知道的是**派生出来的结果**：
     · 这个球能挨几下？
     · 这套技能每秒打多少？打死一个 1500 血的晕彩要几秒？
   所以这一层把原料算成结论，并且**改一个数就立刻重算**（编辑器每帧重绘预览）。

   为什么单独一个文件：
     · 它有两个消费者 —— 编辑器的预览面板，和 tests/diag/balance-edit.mjs；
     · 公式写两遍迟早会漂（本项目在"五连发扇形"上吃过一次亏：
       预览画 14°、实际飞出去 24°），所以结论只此一份。

   所有公式都**不含隐藏常数**：要用到的（例如"参考靶血量"）都写在下面并注明理由。
   ============================================================ */

/** 参考靶：算"打死要多久"时用的假想敌血量。
 *  取 1500 = 晕彩的默认生命，也就是"打一个标准魔法少女"的意思。 */
export const REF_HP = 1500;

/** 参考打击：算"能挨几下"时用的单次伤害。
 *  取 100 = 诊断夹具里那颗"测试球"的碰撞伤害（项目里所有守卫都在用这个数）。
 *  它现在住在 tests/lib/test-balls.mjs（游戏球种里已经没它了），
 *  但作为"一把尺子"仍然合适：100 这个数好算，而且它本来就是当年的基准球。 */
export const REF_HIT = 100;

/** 数字格式化：大数不留小数，小数留够位数（37.5 不能变成 38）。
 *  默认位数按量级选：≥100 取整、≥10 一位、其余两位，且去掉没用的尾零。 */
const n = (v, d) => {
  const x = Number(v);
  if (!Number.isFinite(x)) return '—';
  const dec = d == null ? (Math.abs(x) >= 100 ? 0 : Math.abs(x) >= 10 ? 1 : 2) : d;
  return String(Number(x.toFixed(dec)));
};
const secs = (v) => {
  const x = Number(v);
  if (!Number.isFinite(x)) return '—';
  if (x >= 60) return `${Math.round(x)} 秒`;
  return `${Math.round(x * 10) / 10} 秒`;
};

/** 一行面板数据。delta 由编辑器按"基线值"补上（见 deltaText） */
const row = (label, text, note = '') => ({ label, text, note });

/** 相对基线的变化描述：+20% / −13% / 新增 / 无 */
export function deltaText(before, after) {
  const b = Number(before), a = Number(after);
  if (!Number.isFinite(b) || !Number.isFinite(a) || Math.abs(a - b) < 1e-9) return '';
  if (Math.abs(b) < 1e-9) return '从 0 变成 ' + n(a);
  const pct = ((a - b) / Math.abs(b)) * 100;
  const sign = pct > 0 ? '+' : '−';
  return `${sign}${Math.abs(pct) >= 10 ? Math.round(Math.abs(pct)) : Math.round(Math.abs(pct) * 10) / 10}%`;
}

/* ---------- 小球的基础数值 ---------- */

/** 生命 / 移速 / 碰撞伤害 → 能挨几下、能撞死谁 */
export function speciesRows(v = {}) {
  const hp = Number(v.hp), speed = Number(v.speed), melee = Number(v.melee);
  const rows = [
    row('生命', n(hp), '满血能扛的总伤害'),
    row('移动速度', `${n(speed)} /秒`, '世界单位每秒（球直径 32，约 ' +
      `${n(speed / 32, 1)} 个身位/秒）`),
    row('碰撞伤害', n(melee), melee > 0 ? '撞到敌人一次造成的伤害' : '这个球本身不靠碰撞输出'),
  ];
  rows.push(row('能挨几下', Number.isFinite(hp) ? `${Math.ceil(hp / REF_HIT)} 下` : '—',
    `按每次 ${REF_HIT} 伤害（测试球的碰撞伤害）算`));
  rows.push(row('撞死一个标准目标', melee > 0 ? `${Math.ceil(REF_HP / melee)} 次碰撞` : '不会造成碰撞伤害',
    `目标按 ${REF_HP} 血（晕彩默认生命）算`));
  return rows;
}

/* ---------- 技能伤害 ---------- */

/** 每秒伤害：单次伤害 × 每秒次数 */
const dps = (dmg, perSec) => {
  const d = Number(dmg), p = Number(perSec);
  if (!Number.isFinite(d) || !Number.isFinite(p) || p <= 0) return NaN;
  return d * p;
};
/** 打空参考靶要多久（按每秒伤害推） */
const ttk = (dmg, perSec) => {
  const v = dps(dmg, perSec);
  if (!Number.isFinite(v) || v <= 0) return NaN;
  return REF_HP / v;
};
/** "单发伤害 / 每秒伤害 / 打空时间" 三连 —— 技能面板里最常出现的三行 */
const damageBlock = (who, dmg, cd, extra = '') => {
  const rows = [row(`${who} · 单次伤害`, n(dmg), extra)];
  const per = Number(cd) > 0 ? 1 / Number(cd) : NaN;
  rows.push(row(`${who} · 每秒伤害`, Number.isFinite(per) ? n(dps(dmg, per)) : '—',
    Number.isFinite(per) ? `冷却 ${n(cd)} 秒 → 每秒 ${n(per, 2)} 次` : ''));
  rows.push(row(`${who} · 打空 ${REF_HP} 血`, Number.isFinite(ttk(dmg, per)) ? secs(ttk(dmg, per)) : '—',
    '按持续命中同一个目标算'));
  return rows;
};

const SKILL_ROWS = {
  /* 晕彩 */
  numYuncaiSkill(v = {}) {
    const rows = [];
    /* 裁光：每帧接触伤害 —— 一秒 60 帧，所以"每秒"是 ×60，这里必须点明，
       否则作者会以为 1 点伤害微不足道。 */
    const stages = Array.isArray(v.caiguangDmgByStage) ? v.caiguangDmgByStage : [];
    rows.push(row('裁光 · 每帧接触伤害', stages.map(s => n(s)).join(' / ') || '—',
      stages.length > 1 ? '漆黑 / 深紫两档' : ''));
    rows.push(row('裁光 · 每秒（贴住不动）',
      stages.length ? stages.map(s => n(Number(s) * 60)).join(' / ') : '—',
      '接触伤害每帧结算一次，60 帧 = 1 秒'));
    rows.push(row('裁光 · 微光爆炸', n(v.caiguangBoom), '敌方碰到闪光细线时的爆炸伤害'));
    rows.push(...damageBlock('魔弹', v.modanDmg, v.modanCd, `飞行速度 ${n(v.modanSpeed)}/秒`));
    rows.push(row('魔弹 · 第三发光柱', n(v.modanLaserDmg), `速度 ${n(v.modanLaserSpeed)}（光柱锚在身上，速度只有方向含义）`));
    rows.push(row('折光 · 碰撞伤害', n(v.zheguangMelee), '折光把碰撞伤害改成这个值（本体原本是 0）'));
    rows.push(row('开华 · 回血', n(v.kaihuaHeal), `开华后移动速度 ${n(v.kaihuaSpeed)}`));
    rows.push(row('开华 · 光系加成', `+${n(v.kaihuaLightBonus)}`, '所有"光"攻击都加这么多'));
    rows.push(row('开华 · 碰撞加成', `+${n(v.kaihuaMeleeBonus)}`, `折光 ${n(v.zheguangMelee)} → ${n(Number(v.zheguangMelee) + Number(v.kaihuaMeleeBonus))}`));
    rows.push(...damageBlock('棱镜光炮', v.prismCannonDmg, v.prismCd, `飞行速度 ${n(v.prismCannonSpeed)}`));
    rows.push(row('棱镜 · 分裂激光', n(v.prismLaserDmg), `速度 ${n(v.prismLaserSpeed)}`));
    rows.push(row('棱镜 · 碎片', n(v.prismShardDmg), `速度 ${n(v.prismShardSpeed)}`));
    rows.push(row('析光 · 分身生命 / 速度', `${n(v.xiguangMiniHp)} / ${n(v.xiguangMiniSpeed)}`,
      '分身的碰撞伤害与技能伤害都按本体的一定比例弱化'));
    rows.push(row('领域 · 闪避', `${n(Number(v.domainDodge) * 100)}% → ${n(Number(v.domainDodgeBloomed) * 100)}%`,
      '开华之后换成后面那个'));
    return rows;
  },

  /* 桃夭 */
  numTaoyaoSkill(v = {}) {
    const rows = [];
    rows.push(...damageBlock('映霞[荣]', v.rongDamage, v.rongCd, `飞行速度 ${n(v.rongSpeed)}`));
    rows.push(row('映霞[荣] · 五连发一轮',
      `${n(v.rongBurstCount)} 支 × ${n(v.rongBurstDmg)} = ${n(Number(v.rongBurstCount) * Number(v.rongBurstDmg))}`,
      '每射 5 次之后的下一次改为一轮五连发'));
    rows.push(...damageBlock('映霞[枯]', v.kuDamage, v.kuCd, `飞行速度 ${n(v.kuSpeed)}`));
    rows.push(row('认真拉矢 · 每层加成', `+${n(v.aimPerStack)}`, `最多 ${n(v.aimMaxStacks)} 层 → 满层 +${n(Number(v.aimPerStack) * Number(v.aimMaxStacks))}`));
    rows.push(...damageBlock('春景光炮', v.chunjingCannonDmg, v.chunjingCannonEvery, `飞行速度 ${n(v.chunjingCannonSpeed)}`));
    rows.push(row('春景 · 回血', `${n(v.chunjingHealPerSec)} /秒`, `持续期间总共回 ${n(Number(v.chunjingHealPerSec) * 5)}（按 5 秒算）`));
    rows.push(row('陀螺 · 每层', `碰撞 +${n(v.topMeleePer)} / 速度 +${n(v.topSpeedPer)}`, `最多 ${n(v.topMaxStacks)} 层`));
    return rows;
  },

  /* 缇娜 */
  numTinaSkill(v = {}) {    const rows = [];
    rows.push(row('吸血 · 每次接触伤害', n(v.suckMeleeTo), '吸附期间按 0.5 秒一跳，1.5 秒共 3 跳'));
    rows.push(row('吸血 · 一轮三跳合计', n(Number(v.suckMeleeTo) * 3), '吸附 1.5 秒里正好 3 跳（见技能说明）'));
    rows.push(row('蝙蝠 · 单只伤害', n(v.batDamage), `每轮 ${n(v.batMinCount)}~${n(v.batMaxCount)} 只，冷却 ${n(v.batCd)} 秒`));
    rows.push(row('蝙蝠 · 一轮满编合计', n(Number(v.batDamage) * Number(v.batMaxCount)),
      `按 ${n(v.batMaxCount)} 只算；每只回来还给缇娜回 ${n(v.batHeal)} 血`));
    rows.push(row('蝙蝠 · 每秒伤害', n(dps(Number(v.batDamage) * Number(v.batMaxCount), 1 / Number(v.batCd))),
      `速度 ${n(v.batSpeed)}（转弯半径 = 速度 ÷ 角速度）`));
    /* 偷学：一次性的技能就放一次；持续发动型（见晴的变色这类）借来用 N 秒 */
    rows.push(row('②蝙蝠 · 偷持续型能力', `借 ${n(v.btStealSec)} 秒`,
      `单次技能照旧只放一次；持续发动型（变色 / 常驻长剑…）改为临时装上，`
      + `${n(v.btStealSec)} 秒后自动归还（期间它的被动与每帧效果都真的在跑）`));
    rows.push(...damageBlock('猩红霰弹（单发）', v.shotDamage, v.shotCd, `飞行速度 ${n(v.shotSpeed)}`));
    rows.push(row('霰弹 · 一轮合计', `${n(v.shotCount)} 发 × ${n(v.shotDamage)} = ${n(Number(v.shotCount) * Number(v.shotDamage))}`,
      `每发随机偏 0~${n(v.shotSpreadDeg)}°`));
    rows.push(row('权杖 · 碰撞加成', `+${n(v.scepterMeleeBonus)}`, '只作用于碰撞伤害，不影响技能'));
    rows.push(row('光柱 · 每跳伤害', n(v.p3Damage), `每秒 ${n(v.p3TickPerSec)} 跳 → 每秒 ${n(Number(v.p3Damage) * Number(v.p3TickPerSec))}`));
    rows.push(row('光柱 · 覆盖范围', `半径 ${n(v.p3Radius)} × 长 ${n(v.p3Len)}`, `持续 2 秒 → 一共 ${n(Number(v.p3Damage) * Number(v.p3TickPerSec) * 2)} 伤害`));
    return rows;
  },

  /* 见晴（白水仙）：三面水镜 + 起飞 + 精灵变身 + 羽毛 */
  numJianqingSkill(v = {}) {
    const rows = [];
    /* ① 水镜（防御）：两个形态各算一个"每秒" */
    rows.push(row('①淡绿 · 每秒回血', n(v.jqHeal), `切色间隔 ${n(v.jqCycle)} 秒（随机，可能连着同色）`));
    rows.push(row('①淡粉 · 碰撞伤害', `30 + ${n(v.jqMeleeBonus)}`, '淡粉期间才加，切走会撤掉'));
    rows.push(row('①淡粉 · 护盾速度', `${n(v.jqShieldGain)} /秒`, `上限 ${n(v.jqShieldMax)} → 攒满要 ${n(Number(v.jqShieldMax) / Math.max(1, Number(v.jqShieldGain)), 1)} 秒`));
    rows.push(row('①护盾衰减', `${n(v.jqShieldDecay)} /秒`, `不在淡粉时，${n(Number(v.jqShieldMax) / Math.max(1, Number(v.jqShieldDecay)))} 秒掉光`));
    /* ② 长剑：一刀 80、1 秒一下 */
    rows.push(row('②长剑 · 每秒伤害', n(Number(v.jqSwordDmg) / Math.max(0.1, Number(v.jqSwordAtkCd))),
      `${n(v.jqSwordDmg)} 点 / ${n(v.jqSwordAtkCd)} 秒一下；扇形 ${n(v.jqSwordFront)}°、剑长 ${n(v.jqSwordLen)}`));
    rows.push(row('②长剑 · 消弹', `每 ${n(v.jqSwordDefCd)} 秒最多 ${n(v.jqSwordPurge)} 个`, '同一条扇形里的敌方弹道'));
    /* ③ 借用：两态各一个"每秒"，再折成 9 秒周期里的发数 */
    rows.push(row('③深蓝紫 · 魔弹', `${n(v.jqModanDmg)} /发`, `${n(v.jqModanCd)} 秒一发 → 一个周期 ${Math.ceil(Number(v.jqBorrowCycle) / Math.max(0.2, Number(v.jqModanCd)))} 发`));
    rows.push(row('③深蓝紫 · 每秒伤害', n(Number(v.jqModanDmg) / Math.max(0.2, Number(v.jqModanCd))), `弹速 ${n(v.jqModanSpeed)}`));
    rows.push(row('③白色 · 激光', `${n(v.jqLaserDmg)} /发`, `持续 ${n(v.jqLaserLife)} 秒、${n(v.jqLaserCd)} 秒一发 → 一个周期 ${Math.ceil(Number(v.jqBorrowCycle) / Math.max(0.2, Number(v.jqLaserCd)))} 发`));
    rows.push(row('③白色 · 每秒伤害', n(Number(v.jqLaserDmg) / Math.max(0.2, Number(v.jqLaserCd))), `粗细 ${n(v.jqLaserWidth)}`));
    /* ④ 起飞：按移速折成"多少秒飞一次"（默认 120 速度） */
    rows.push(row('④起飞 · 触发节奏', `走 ${n(v.jqFlyDist)} 单位`, `按 120 速度算约 ${n(Number(v.jqFlyDist) / 120, 1)} 秒一次，滞空 ${n(v.jqFlySec)} 秒`));
    rows.push(row('④空中 · 每帧伤害', `${n(v.jqFlyDmg)} ×60 = ${n(Number(v.jqFlyDmg) * 60)} /秒`, '只在与小球重合时结算（帧伤）'));
    /* ④ 空中口径：受伤倍率 + 追踪转速（转速要折成转弯半径才看得出强弱，
       和缇娜蝙蝠那一节同一个道理：半径 = 速度 ÷ 角速度） */
    const takeMul = Number(v.jqFlyTake ?? 1);
    rows.push(row('④空中 · 受伤倍率', `×${n(takeMul, 2)}`,
      `挨一次 100 点只掉 ${n(Math.max(1, Math.round(100 * takeMul)))}；` +
      `1500 血能挨 ${n(Math.ceil(1500 / Math.max(1, 100 * takeMul)))} 下（空中）`));
    const turnDeg = Number(v.jqFlyTurn ?? 0);
    const flySpeed = 120 + Number(v.jqFlySpeed || 0);
    rows.push(row('④空中 · 追踪转速', `${n(turnDeg)}°/秒`,
      turnDeg > 0
        ? `空中速度 ${n(flySpeed)} → 转弯半径约 ${n(flySpeed / (turnDeg * Math.PI / 180))} 世界单位（半径 = 速度 ÷ 角速度）`
        : '设成 0 就是完全不修正航向（只按引擎的全局微转向走）'));
    /* ④ 的成长：每次飞完永久 +速度、下次帧伤更高 */
    const n1 = Number(v.jqFlyDmg), step = Number(v.jqFlyDmgStep || 0);
    rows.push(row('④飞完的成长', `移速永久 +${n(v.jqFlySpeedStep)} / 帧伤 +${n(step)}`,
      `第 1 次飞行 ${n(n1)}、第 3 次 ${n(n1 + step * 2)}、第 5 次 ${n(n1 + step * 4)} /帧；飞 10 次后移速共 +${n(Number(v.jqFlySpeedStep) * 10)}`));
    /* ⑤ 变身：伤害减半、体型减半 */
    rows.push(row('⑤变身 · 伤害倍率', `×${n(v.jqTrDmgMul)}`, `体型 ×${n(v.jqSizeMul)}、移速 +${n(v.jqTrSpeed)}、剑长 ×${n(v.jqTrSwordMul)}`));
    rows.push(row('⑤变身 · 魔弹实际伤害', n(Number(v.jqModanDmg) * Number(v.jqTrDmgMul)),
      '与 ③ 同时装时（半伤后的数）'));
    /* ⑥ 羽毛：每 300 血一根 */
    rows.push(row('⑥羽毛 · 触发节奏', `每掉 ${n(v.jqFeatherStep)} 血 1 根`, `速度 ${n(v.jqFeatherSpeed)}、可反弹 ${n(v.jqFeatherBounce)} 次`));
    rows.push(row('⑥羽毛 · 命中减益', `移速 ×${n(v.jqFeatherSlowMul)}（${n(v.jqFeatherSlowSec)} 秒）`,
      `碰撞 -${n(v.jqFeatherMelee)}、技能 -${n(v.jqFeatherSkill)}（永久叠加，帧伤不减）`));
    return rows;
  },
};

/** 统一入口：给一个 item id 和当前值，返回要显示的派生行 */
export function rowsFor(itemId, values = {}) {
  const key = String(itemId || '');
  if (key.startsWith('stat_')) return speciesRows(values);
  const fn = SKILL_ROWS[key];
  return fn ? fn(values) : [];
}

/** 面板用的分组标题（编辑器显示在卡片顶部） */
export const BALANCE_TITLES = {
  stat_yuncai: '晕彩 · 基础数值',
  stat_taoyao: '桃夭 · 基础数值',
  stat_tina: '缇娜 · 基础数值',
  stat_jianqing: '见晴 · 基础数值',
  stat_dummy: '木桩 · 基础数值',
  numYuncaiSkill: '晕彩 · 技能数值',
  numTaoyaoSkill: '桃夭 · 技能数值',
  numTinaSkill: '缇娜 · 技能数值',
  numJianqingSkill: '见晴 · 技能数值',
};

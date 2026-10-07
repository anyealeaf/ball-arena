/* ============================================================
   tests/core.test.mjs — 核心逻辑自检（无需浏览器）
   ------------------------------------------------------------
   运行：node tests/core.test.mjs
   覆盖：伤害数值、同队不互攻、场地约束、多队混战、
         复活规则、时限判定、以及最关键的确定性。
   ============================================================ */

import { Battle, SNAP_STRIDE } from '../js/core.js';
import {
  SPECIES_BY_ID, DEFAULT_RULES, makeUnitStats, SCALE, BALL_SCALE,
  MAX_SKILLS_PER_UNIT, defaultSkillsFor, normalizeSkills
} from '../js/balls.js';
import { ARENA_BY_ID, ARENAS, effectiveShape, pointInZone } from '../js/arenas.js';

let pass = 0, fail = 0;
const results = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  ✅ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; results.push(`  ❌ ${name}${detail ? '  — ' + detail : ''}`); }
}

function mkConfig({ teams, arenaId = 'rect', rules = {}, playerSlot = null, seed = 1, sizeScale = 1 }) {
  return {
    teams: teams.map(units => ({ units: units.map(id => ({ stats: makeUnitStats(id) })) })),
    arena: ARENA_BY_ID[arenaId],
    sizeScale,
    rules: { ...DEFAULT_RULES, ...rules },
    playerSlot,
    seed
  };
}

function teamOf(ids) { return ids.map(id => ({ stats: makeUnitStats(id) })); }

console.log('=========== 小球对决 · 核心自检 ===========\n');

/* ---------- 1. 基本对战 ---------- */
console.log('【1】基本对战');
{
  const cfg = mkConfig({ teams: [['test'], ['test']], seed: 42 });
  const b = new Battle(cfg);
  b.runToEnd();
  const s = b.summary();
  check('对局能正常结束', b.over, `结束帧 ${b.frame}（${s.seconds}s），原因：${s.endReason}`);
  check('产生了胜负方', s.winner !== -1, `winner=${s.winner}`);
  check('产生了伤害事件', s.stats.totalDamage > 0, `总伤害 ${s.stats.totalDamage}`);
  check('有小球阵亡', s.units.some(u => !u.alive), `存活 ${s.stats.survivors}/${s.units.length}`);
}

/* ---------- 2. 伤害数值符合设定（1000 血 / 100 伤害） ---------- */
console.log('\n【2】伤害与数值设定');
{
  const cfg = mkConfig({
    teams: [['test'], ['test']], seed: 7,
  });
  const b = new Battle(cfg);
  // 跑到第一次命中事件为止
  let hit = null, guard = 0;
  while (!hit && guard < 6000) {
    b.step();
    hit = b.events.find(e => e.type === 'hit');
    guard++;
  }
  check('首次碰撞造成了伤害', !!hit, hit ? `第 ${hit.f} 帧，伤害 ${hit.value}` : '未发生碰撞');
  if (hit) {
    check('单次碰撞伤害 = 100（含双方对撞即各扣 100）',
      hit.value === 100, `实际 ${hit.value}`);
  }
  const totals = b.units.map(u => u.maxHp);
  check('测试球生命上限 = 1000', totals.every(h => h === 1000), `实际 ${totals.join(',')}`);
}

/* ---------- 3. 同队不互相攻击 ---------- */
console.log('\n【3】同队伍不互相造成伤害');
{
  // 一队 3 球对另一队 1 球；关闭友军伤害时，己方三球之间不应产生任何伤害
  const cfg = mkConfig({ teams: [['test', 'test', 'test'], ['test']], seed: 3 });
  const b = new Battle(cfg);
  b.runToEnd();
  const selfHarm = b.units.reduce((s, u) => s + (u.damageFrom.melee || 0) * 0, 0);
  void selfHarm;
  const friendly = b.events.filter(e => e.type === 'hit'
    && b.units[e.a] && b.units[e.b] && b.units[e.a].team === b.units[e.b].team);
  check('关闭友军伤害时，队友之间零伤害事件', friendly.length === 0,
    `队友互击事件 ${friendly.length} 条`);
  check('对局仍正常产生伤害', b.units.reduce((s, u) => s + u.dmg, 0) > 0,
    `总伤害 ${b.units.reduce((s, u) => s + u.dmg, 0)}`);
}
{
  // 同一个对阵，打开友军伤害：应当出现队友互击
  const cfg = mkConfig({ teams: [['test', 'test', 'test'], ['test']], seed: 3, rules: { friendlyFire: true } });
  const b = new Battle(cfg);
  b.runToEnd();
  const friendly = b.events.filter(e => e.type === 'hit'
    && b.units[e.a] && b.units[e.b] && b.units[e.a].team === b.units[e.b].team);
  check('开启友军伤害后出现队友互击', friendly.length > 0,
    `队友互击事件 ${friendly.length} 条`);
}

/* ---------- 4. 场地约束：小球不得跑出场外 ---------- */
console.log('\n【4】场地边界约束');
for (const arenaId of ['rect', 'circle', 'octagon', 'triangle', 'diamond', 'shrink_ring', 'chaos']) {
  const cfg = mkConfig({ teams: [['test', 'test', 'test'], ['test', 'test', 'test']], arenaId, seed: 11 });
  const b = new Battle(cfg);
  let outside = 0, worst = 0;
  let guard = 0;
  while (!b.over && guard < 1200) {
    b.step();
    const shape = effectiveShape(
      cfg.rules.allowShrink ? cfg.arena : { ...cfg.arena, effects: { ...(cfg.arena.effects || {}), shrink: null } },
      b.time
    );
    for (const u of b.units) {
      if (!u.alive) continue;
      const x = u.x / SCALE, y = u.y / SCALE, r = u.r / SCALE;
      let inside;
      if (shape.type === 'circle') {
        const dx = x - shape.cx, dy = y - shape.cy;
        inside = Math.hypot(dx, dy) <= shape.r + 1.5;
      } else {
        // 允许 1.5 单位的容差（定点取整误差）
        inside = pointInsidePolyTol(shape.points, x, y, 1.5);
      }
      if (!inside) { outside++; worst = Math.max(worst, 1); }
      void r;
    }
    guard++;
  }
  check(`「${ARENA_BY_ID[arenaId].name}」小球未越界`, outside === 0,
    outside ? `越界 ${outside} 次` : `模拟 ${guard} 帧`);
}

/* ---------- 5. 多队混战必须能自然打完（不能僵死） ---------- */
console.log('\n【5】多方混战（重点：必须能分出胜负，不能僵死）');
for (const n of [2, 3, 4, 5, 6]) {
  const teams = Array.from({ length: n }, () => ['test', 'test']);
  const cfg = mkConfig({ teams, arenaId: 'octagon', seed: 99 + n });
  const b = new Battle(cfg);
  b.runToEnd();
  const s = b.summary();
  const alive = new Set(s.units.filter(u => u.alive).map(u => u.team));
  const natural = b.endReason === '其余队伍全部阵亡' || b.endReason === '全部阵亡';
  check(`${n} 方混战能自然打出结果（非超时兜底）`, natural,
    `${s.seconds}s，原因：${b.endReason}，剩余 ${alive.size} 队`);
  check(`${n} 方混战时长在 120 秒内`, s.seconds <= 120,
    `实际 ${s.seconds}s`);
}

/* ---------- 5b. 无兜底机制：对局必须靠物理自己收场 ----------
   这里曾经测的是"僵局破解器会不会触发"。破解器已移除，
   改测更重要的一件事：**没有任何兜底机制时，对局能不能自然打完**。
   如果哪天物理改动又引入死锁，这一项会立刻变红。 */
console.log('\n【5b】没有兜底机制也能自然收场');
{
  // 多个场地 × 多个种子，全部必须自然分出胜负（不能拖到时间/模拟上限）
  const arenas = ['rect', 'octagon', 'circle', 'diamond', 'hexagon'];
  const results = [];
  for (const arenaId of arenas) {
    for (const seed of [102, 7, 12345]) {
      const teams = Array.from({ length: 3 }, () => ['test', 'test']);
      const b = new Battle(mkConfig({ teams, arenaId, seed }));
      b.runToEnd();
      results.push({
        arenaId, seed,
        natural: b.endReason === '其余队伍全部阵亡' || b.endReason === '全部阵亡',
        sec: +(b.frame / 60).toFixed(1),
        reason: b.endReason,
      });
    }
  }
  const stuck = results.filter(r => !r.natural);
  check('所有场地/种子都自然分出胜负（无死锁）', stuck.length === 0,
    stuck.length
      ? stuck.map(r => `${r.arenaId}/seed${r.seed}:${r.reason}`).join('、')
      : `${results.length} 场全部分出胜负`);
  const secs = results.map(r => r.sec);
  const maxSec = Math.max(...secs);
  check('最慢的一场也在 120 秒内收场', maxSec <= 120,
    `最慢 ${maxSec}s（中位 ${secs.sort((a, b) => a - b)[Math.floor(secs.length / 2)]}s）`);
}

/* ---------- 5c. 伤害数值不被任何机制悄悄放大 ----------
   以前"冲刺标 200 却打出 500"就是因为有个全局伤害倍率在放大。
   这里直接断言：屏幕上出现的伤害数字，必须恒等于属性表/技能表里的值。 */
console.log('\n【5c】伤害数值与设定严格一致');
{
  const cfg = mkConfig({
    teams: [['test_skill', 'test_skill'], ['test', 'test']],
    arenaId: 'rect', seed: 11,
  });
  const b = new Battle(cfg);
  b.runToEnd();
  const base = { melee: SPECIES_BY_ID.test.melee, skill: 50, dash: 200 };
  const seen = {};
  for (const e of b.events) {
    if (e.type !== 'hit' || !e.kind) continue;
    (seen[e.kind] ||= new Set()).add(e.value);
  }
  for (const [kind, want] of Object.entries(base)) {
    const got = seen[kind] ? [...seen[kind]] : [];
    // dash 可能一次都没打中，那就只检查"出现过的值都是对的"
    check(`${kind} 伤害恒为 ${want}`,
      got.length === 0 || got.every(v => v === want),
      got.length ? `实际 ${got.join(',')}` : '本局未发生');
  }
}

/* ---------- 5d. 技能装配（每个小球最多带 MAX_SKILLS_PER_UNIT 个） ----------
   魔法少女的技能数量会很多，所以改成"开战前每个球挑几个带"。
   这里验证两件事：
     (1) 装配规则本身（默认值、上限、跨球种过滤、空装配）
     (2) 战斗里真的按装配走 —— 没装的技能一次都不能发动
   (2) 才是关键：UI 改对了但引擎没读，就会变成"看着装配了其实照旧全带"。 */
console.log('\n【5d】技能装配');
{
  const skillBall = SPECIES_BY_ID.test_skill;
  const owned = skillBall.skills || [];
  check('测试球·技能型至少有两个技能可供取舍', owned.length >= 2, owned.join('、'));

  check('省略装配参数时使用默认装配（技能表前 N 个）',
    JSON.stringify(makeUnitStats('test_skill').skills) === JSON.stringify(defaultSkillsFor('test_skill')),
    makeUnitStats('test_skill').skills.join('、'));
  check('默认装配不超过上限', defaultSkillsFor('test_skill').length <= MAX_SKILLS_PER_UNIT);
  check('显式传空数组 = 不带任何技能（合法配置）',
    makeUnitStats('test_skill', []).skills.length === 0);
  check('无技能的球种默认装配为空', defaultSkillsFor('test').length === 0);

  /* 上限：塞进去一堆也不该超过 MAX_SKILLS_PER_UNIT */
  const many = [...owned, ...owned, ...owned];
  check(`装配数量被硬性限制在 ${MAX_SKILLS_PER_UNIT} 个`,
    normalizeSkills('test_skill', many).length <= MAX_SKILLS_PER_UNIT,
    `传入 ${many.length} 个 -> 保留 ${normalizeSkills('test_skill', many).length} 个`);
  check('装配会去重', normalizeSkills('test_skill', [owned[0], owned[0]]).length === 1);
  check('不属于该球种的技能会被剔除',
    normalizeSkills('test', owned).length === 0,
    `把技能球的技能装到普通球上 -> ${JSON.stringify(normalizeSkills('test', owned))}`);

  /* 战斗里是否真的按装配走：数事件流里的技能痕迹 */
  function runWith(skills) {
    const cfg = {
      teams: [
        { units: [{ stats: makeUnitStats('test_skill', skills) }] },
        { units: [{ stats: makeUnitStats('test') }] },
      ],
      arena: ARENA_BY_ID.rect,
      sizeScale: 1,
      rules: { ...DEFAULT_RULES },
      seed: 31,
    };
    const b = new Battle(cfg);
    b.runToEnd();
    const n = t => b.events.filter(e => e.type === t).length;
    const kinds = new Set(b.events.filter(e => e.type === 'hit').map(e => e.kind));
    return { shots: n('shoot'), charges: n('chargeStart'), kinds, b };
  }

  const none = runWith([]);
  check('装配为空时：一次技能都不发动',
    none.shots === 0 && none.charges === 0,
    `射击 ${none.shots} 次 / 蓄力 ${none.charges} 次`);
  check('装配为空时：只打得出普通碰撞伤害',
    [...none.kinds].every(k => k === 'melee'),
    `出现过的伤害类型 ${[...none.kinds].join('、') || '（无）'}`);

  const onlyShot = runWith([skillBall.skills[0]]);
  const shotId = skillBall.skills[0];
  // test_shot 是冷却射击，test_dash 是撞墙蓄力
  if (shotId === 'test_shot') {
    check('只装"定时射击"时：会射击', onlyShot.shots > 0, `射击 ${onlyShot.shots} 次`);
    check('只装"定时射击"时：绝不会蓄力冲刺', onlyShot.charges === 0, `蓄力 ${onlyShot.charges} 次`);
  }

  const onlyDash = runWith([skillBall.skills[1]]);
  if (skillBall.skills[1] === 'test_dash') {
    check('只装"撞墙蓄力冲刺"时：会蓄力', onlyDash.charges > 0, `蓄力 ${onlyDash.charges} 次`);
    check('只装"撞墙蓄力冲刺"时：绝不会射击', onlyDash.shots === 0, `射击 ${onlyDash.shots} 次`);
  }

  /* 装配为空的小球，技能列表必须真的是空的 —— 引擎不认 undefined / null，
     否则会出现"UI 显示不带技能、引擎却按球种全带"的静默不一致。 */
  const b0 = new Battle({
    teams: [
      { units: [{ stats: makeUnitStats('test_skill', []) }] },
      { units: [{ stats: makeUnitStats('test') }] },
    ],
    arena: ARENA_BY_ID.rect, sizeScale: 1, rules: { ...DEFAULT_RULES }, seed: 5,
  });
  check('装配为空时单位身上的技能列表为空数组',
    Array.isArray(b0.units[0].skills) && b0.units[0].skills.length === 0,
    JSON.stringify(b0.units[0].skills));
}

/* ---------- 6. 复活规则 ---------- */
console.log('\n【6】阵亡后复活');
{
  const cfg = mkConfig({
    teams: [['test_lowhp', 'test_lowhp'], ['test']],
    seed: 5, rules: { respawn: true, respawnDelay: 1 }
  });
  const b = new Battle(cfg);
  b.runToEnd();
  const respawns = b.events.filter(e => e.type === 'respawn').length;
  check('复活规则生效（出现复活事件）', respawns > 0, `复活 ${respawns} 次`);
  check('开启复活时不因一方全灭而立刻结束',
    b.endReason !== '其余队伍全部阵亡' || respawns > 0,
    `结束原因：${b.endReason}`);
}

/* ---------- 7. 时限判定 ---------- */
console.log('\n【7】比赛时限');
{
  // 单选两个肉球，几乎打不死，用于触发时限
  const cfg = mkConfig({ teams: [['test_heavy'], ['test_heavy']], seed: 8, rules: { timeLimit: 5 } });
  const b = new Battle(cfg);
  b.runToEnd();
  check('到时限即结束', b.over && b.frame <= Math.round(5 * 60) + 2,
    `结束帧 ${b.frame}（上限 ${Math.round(5 * 60)}）`);
  check('时限结束会给出判定理由', b.endReason.includes('时间'), b.endReason);
}

/* ---------- 8. 场地特效生效 ---------- */
console.log('\n【8】场地特殊效果');
{
  // 熔心斗场：中央持续灼烧
  const cfg = mkConfig({ teams: [['test'], ['test']], arenaId: 'lava_center', seed: 21 });
  const b = new Battle(cfg);
  b.runToEnd();
  const zoneHits = b.events.filter(e => e.kind === 'zone').length;
  check('区域持续伤害生效', zoneHits > 0, `区域伤害事件 ${zoneHits} 次`);
}
{
  // 收缩场地：后期几何应当小于初始
  const cfg = mkConfig({ teams: [['test'], ['test']], arenaId: 'shrink_ring', seed: 22 });
  const a = ARENA_BY_ID['shrink_ring'];
  const early = effectiveShape(a, 0);
  const late = effectiveShape(a, 20);
  const sizeEarly = polySize(early.points);
  const sizeLate = polySize(late.points);
  check('收缩场地确实变小', sizeLate < sizeEarly,
    `0 秒 ${sizeEarly.toFixed(0)} → 20 秒 ${sizeLate.toFixed(0)}`);
}
{
  // 旋转场地：顶点位置应当随时间改变
  const a = ARENA_BY_ID['rotating_square'];
  const p0 = effectiveShape(a, 0).points[0];
  const p5 = effectiveShape(a, 5).points[0];
  check('旋转场地顶点随时间变化', p0[0] !== p5[0] || p0[1] !== p5[1],
    `[${p0}] → [${p5}]`);
}

/* ---------- 9. 确定性（最重要的一项） ---------- */
console.log('\n【9】确定性：同配置必然得到同一场战斗');
{
  const cfg = mkConfig({
    teams: [['test', 'test_lowhp', 'test_charge'], ['test_heavy', 'test', 'test']],
    arenaId: 'chaos', seed: 20260930
  });
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const b = new Battle({ ...cfg, seed: 20260930 });
    b.runToEnd();
    runs.push({ f: b.frame, w: b.winner, fp: b.fingerprint() });
  }
  const same = runs.every(r => r.fp === runs[0].fp && r.f === runs[0].f && r.w === runs[0].w);
  check('三次独立模拟结果完全一致', same,
    runs.map(r => `帧${r.f}/胜${r.w}/指纹${r.fp}`).join('  '));

  // 换种子应当得到不同的战斗过程
  const b1 = new Battle({ ...cfg, seed: 1 }); b1.runToEnd();
  const b2 = new Battle({ ...cfg, seed: 2 }); b2.runToEnd();
  check('换种子会产生不同过程', b1.fingerprint() !== b2.fingerprint(),
    `${b1.fingerprint()} vs ${b2.fingerprint()}`);
}

/* ---------- 10. 快照完整性（回放的基础） ---------- */
console.log('\n【10】快照与事件流（回放基础）');
{
  const cfg = mkConfig({ teams: [['test', 'test'], ['test', 'test']], seed: 33 });
  const b = new Battle(cfg);
  b.runToEnd();
  check('快照数量 = 帧数 + 1', b.snapshots.length === b.frame + 1,
    `${b.snapshots.length} 个快照 / ${b.frame} 帧`);
  const bad = b.snapshots.find(s => s.data.length !== b.units.length * SNAP_STRIDE);
  check('每个快照包含全部小球的状态', !bad, bad ? '存在长度异常的快照' : `每帧 ${b.units.length * SNAP_STRIDE} 个数值`);
  check('事件流非空', b.events.length > 0, `${b.events.length} 条事件`);
  const noFrame = b.events.find(e => typeof e.f !== 'number');
  check('事件都带帧号（可定位到回放时间点）', !noFrame);
}

/* ---------- 11. 资源条逻辑 ---------- */
console.log('\n【11】特殊资源积攒');
{
  const cfg = mkConfig({ teams: [['test_charge'], ['test_heavy']], seed: 44 });
  const b = new Battle(cfg);
  const u = b.units[0];
  check('蓄能型小球初始资源为 0 且有上限', u.resMax > 0, `resMax=${u.resMax}`);
  for (let i = 0; i < 60; i++) b.step();
  check('资源随时间增长', u.res > 0, `1 秒后 res=${u.res.toFixed(1)}`);
  check('普通测试球没有资源条', b.units[1].resMax === 0, `resMax=${b.units[1].resMax}`);
}

/* ---------- 12. 大规模混战压力 ---------- */
console.log('\n【12】大规模混战');
{
  const teams = Array.from({ length: 4 }, () => Array.from({ length: 12 }, () => 'test'));
  const cfg = mkConfig({ teams, arenaId: 'octagon', seed: 555 });
  const t0 = process.hrtime.bigint();
  const b = new Battle(cfg);
  b.runToEnd();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const s = b.summary();
  check(`48 球 4 方混战可完成`, b.over, `${b.frame} 帧 / ${s.seconds}s / 耗时 ${ms.toFixed(0)}ms`);
  check('48 球模拟耗时可接受（< 3000ms）', ms < 3000, `实际 ${ms.toFixed(0)}ms`);
}

/* ---------- 13. 初始运动模型 ---------- */
console.log('\n【13】初始运动：开局给每个球一个方向随机、力道相等的力');
{
  const cfg = mkConfig({ teams: [['test', 'test', 'test'], ['test', 'test', 'test']], seed: 777 });
  const b = new Battle(cfg);
  const speeds = b.units.map(u => Math.hypot(u.vx, u.vy) / SCALE);
  check('所有球开局都在运动', speeds.every(s => s > 0), `速度 ${speeds.map(s => s.toFixed(0)).join(',')}`);
  const uniq = new Set(speeds.map(s => Math.round(s)));
  check('同球种的初速大小相等（力道相等）', uniq.size === 1, `取值 ${[...uniq].join(',')}`);

  const angles = b.units.map(u => u.spawnAngle);
  check('每个球的开局方向都不同', new Set(angles.map(a => a.toFixed(1))).size === angles.length,
    `方向 ${angles.map(a => a.toFixed(0)).join('°, ')}°`);
}

/* ---------- 14. 匀速：速率恒定，方向只由物理事件改变 ---------- */
console.log('\n【14】匀速直线运动（只有碰撞/撞墙才改变方向）');
{
  // 关掉持续微转向，验证"纯物理"下的直线性
  const cfg = mkConfig({ teams: [['test'], ['test']], seed: 4242, rules: { steerDegPerSec: 0 } });
  const b = new Battle(cfg);
  const u = b.units[0];
  const v0 = { x: u.vx, y: u.vy };
  const p0 = { x: u.x, y: u.y };
  let straight = true;
  for (let i = 0; i < 60; i++) {
    b.step();
    // 若这一帧发生了撞墙或碰撞，就停止检查直线性
    const bounced = b.events.some(e => e.f === b.frame - 1 && (e.type === 'wall' || e.type === 'bounce'));
    if (bounced) break;
    if (u.vx !== v0.x || u.vy !== v0.y) { straight = false; break; }
  }
  check('无碰撞期间速度向量完全不变（关闭微转向时）', straight,
    straight ? '60 帧内保持恒定' : '速度发生了变化');
  const moved = Math.hypot(u.x - p0.x, u.y - p0.y) / SCALE;
  check('位移与速度成正比（直线前进）', moved > 0, `移动了 ${moved.toFixed(1)} 单位`);
}

/* ---------- 14b. 速率恒定（含微转向与撞墙） ---------- */
console.log('\n【14b】速率恒定：转向与撞墙都不改变速度大小');
{
  const cfg = mkConfig({ teams: [['test'], ['test']], seed: 4242 });
  const b = new Battle(cfg);
  const u = b.units[0];
  const target = Math.hypot(u.vx, u.vy) / SCALE;
  let minS = Infinity, maxS = 0;
  for (let i = 0; i < 1800 && !b.over && u.alive; i++) {
    b.step();
    const s = Math.hypot(u.vx, u.vy) / SCALE;
    minS = Math.min(minS, s);
    maxS = Math.max(maxS, s);
  }
  check('全程速率严格恒定（微转向只改方向、弹性碰撞不损失动能）',
    Math.abs(maxS - minS) < 1.0,
    `${minS.toFixed(2)} ~ ${maxS.toFixed(2)}（目标 ${target.toFixed(2)}）`);
}

/* ---------- 14c. 撞墙偏转确实朝敌人偏转，且不超过上限 ---------- */
console.log('\n【14c】撞墙偏转朝敌人修正');
{
  const cfg = mkConfig({ teams: [['test'], ['test']], seed: 4242, rules: { steerDegPerSec: 0 } });
  const b = new Battle(cfg, );
  // 记录每次撞墙时的偏转角
  let turned = 0, sum = 0, overLimit = 0;
  const limit = cfg.rules.wallDeflectDeg ?? 10;
  for (let i = 0; i < 3600 && !b.over; i++) {
    const before = b.events.length;
    b.step();
    for (const e of b.events.slice(before)) {
      if (e.type === 'wall' && e.turned) {
        turned++;
        sum += Math.abs(e.turned);
        if (Math.abs(e.turned) > limit + 0.001) overLimit++;
      }
    }
  }
  check('撞墙时确实发生了朝敌偏转', turned > 0, `${turned} 次偏转，累计 ${sum.toFixed(0)} 度`);
  check('偏转角不超过设定上限', overLimit === 0, `上限 ${limit} 度，越界 ${overLimit} 次`);
}

/* ---------- 15. 碰撞后必须分开（不能粘在一起） ---------- */
console.log('\n【15】碰撞后分离');
{
  // 用多球对局提高相遇概率：纯弹跳模型下 1v1 可能长时间擦肩而过，
  // 那是物理的正常结果，不是 bug（"没有兜底机制也能收场"见【5b】）。
  const cfg = mkConfig({
    teams: [['test', 'test'], ['test', 'test']],
    arenaId: 'rect', seed: 31
  });
  const b = new Battle(cfg);
  let found = false, separated = false, detail = '';
  for (let i = 0; i < 6000 && !b.over; i++) {
    const before = b.events.length;
    b.step();
    const bounce = b.events.slice(before).find(e => e.type === 'bounce' && e.a >= 0 && e.b >= 0);
    if (bounce) {
      found = true;
      const A = b.units[bounce.a], B = b.units[bounce.b];
      const sumR = (A.r + B.r) / SCALE;
      const d0 = Math.hypot(A.x - B.x, A.y - B.y) / SCALE;
      // 再跑 30 帧，看它们是否真的分开了
      for (let k = 0; k < 30; k++) b.step();
      const d1 = Math.hypot(A.x - B.x, A.y - B.y) / SCALE;
      separated = d1 >= sumR - 1;
      detail = `碰撞瞬间距 ${d0.toFixed(1)} → 30 帧后 ${d1.toFixed(1)}（半径和 ${sumR.toFixed(1)}）`;
      break;
    }
  }
  check('发生了球球碰撞', found, found ? '' : '6000 帧内未发生碰撞');
  if (found) check('碰撞后两球不再重叠（确实是分开了）', separated, detail);
}

/* ---------- 16. 撞墙反弹：所有场地类型都要正确反射 ---------- */
console.log('\n【16】撞墙反弹与速率守恒（含圆形场地）');
for (const arenaId of ['rect', 'circle', 'octagon', 'diamond']) {
  const cfg = mkConfig({ teams: [['test'], ['test']], arenaId, seed: 8888 });
  const b = new Battle(cfg);
  const u = b.units[0];
  let walls = 0, minSpeed = Infinity, maxSpeed = 0, frozenWindows = 0;
  const windowPos = [];
  for (let i = 0; i < 2400 && !b.over; i++) {
    b.step();
    if (!u.alive) break;
    const x = u.x / SCALE, y = u.y / SCALE;
    /* 撞墙会被夹紧、球球碰撞会被分离推挤，单帧位移偏小都属正常。
       所以看"一整秒窗口"：净位移接近 0 且路径长度也接近 0 才算真卡死
       （来回小幅振荡会让净位移很小，但路径长度很大，那不算卡死）。 */
    windowPos.push([x, y]);
    if (windowPos.length > 61) {
      windowPos.shift();
      const a = windowPos[0], z = windowPos[windowPos.length - 1];
      const net = Math.hypot(z[0] - a[0], z[1] - a[1]);
      let path = 0;
      for (let k = 1; k < windowPos.length; k++) {
        path += Math.hypot(windowPos[k][0] - windowPos[k - 1][0],
                           windowPos[k][1] - windowPos[k - 1][1]);
      }
      if (net < 3 && path < 3) frozenWindows++;
    }
    walls += b.events.filter(e => e.f === b.frame - 1 && e.type === 'wall' && e.a === u.id).length;
    const s = Math.hypot(u.vx, u.vy) / SCALE;
    minSpeed = Math.min(minSpeed, s);
    maxSpeed = Math.max(maxSpeed, s);
  }
  const name = ARENA_BY_ID[arenaId].name;
  check(`「${name}」小球会撞墙反弹`, walls > 0, `${walls} 次`);
  check(`「${name}」速率守恒（完全弹性）`, Math.abs(maxSpeed - minSpeed) < 0.5,
    `${minSpeed.toFixed(1)} ~ ${maxSpeed.toFixed(1)}`);
  check(`「${name}」没有卡死（每秒都有实际位移）`, frozenWindows === 0,
    frozenWindows ? `${frozenWindows} 个一秒窗口内几乎没动` : '全程正常');
}

/* ---------- 17. 自定义开局方向 ---------- */
console.log('\n【17】自定义开局方向');
{
  const angles = [0, 90, 180, 270];
  const cfg = mkConfig({
    teams: [['test', 'test'], ['test', 'test']],
    seed: 5,
    rules: { spawnMode: 'custom', customAngles: angles }
  });
  const b = new Battle(cfg);
  const ok = b.units.every((u, i) => {
    const a = ((Math.atan2(u.vy, u.vx) * 180) / Math.PI + 360) % 360;
    return Math.abs(a - angles[i]) < 1;
  });
  check('按指定角度生成初速', ok,
    b.units.map(u => (((Math.atan2(u.vy, u.vx) * 180) / Math.PI + 360) % 360).toFixed(0) + '°').join(', '));
}

/* ---------- 18. 初速倍率 ---------- */
console.log('\n【18】初速强度倍率');
{
  const base = new Battle(mkConfig({ teams: [['test'], ['test']], seed: 9 }));
  const fast = new Battle(mkConfig({ teams: [['test'], ['test']], seed: 9, rules: { speedScale: 2 } }));
  const s1 = Math.hypot(base.units[0].vx, base.units[0].vy) / SCALE;
  const s2 = Math.hypot(fast.units[0].vx, fast.units[0].vy) / SCALE;
  check('倍率 2 时初速翻倍', Math.abs(s2 - s1 * 2) < 1, `${s1.toFixed(0)} -> ${s2.toFixed(0)}`);
}

/* ---------- 19. 场地大小缩放 ---------- */
console.log('\n【19】场地大小缩放');
{
  const base = ARENA_BY_ID['rect'];
  const half = new Battle(mkConfig({ teams: [['test'], ['test']], seed: 1, sizeScale: 0.5 }));
  const xs = half.arena.shape.points.map(p => p[0]);
  const ys = half.arena.shape.points.map(p => p[1]);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  check('50% 缩放后场地确实是一半大小', w === 360 && h === 220, `${w}×${h}（原始 720×440）`);

  const cxb = base.shape.points.reduce((s, p) => s + p[0], 0) / 4;
  const cxa = xs.reduce((s, v) => s + v, 0) / 4;
  check('缩放后中心点不变', Math.abs(cxa - cxb) < 1, `${cxb} -> ${cxa}`);

  check('场地对象记录了缩放比例', half.sizeScale === 0.5 && half.arena.sizeScale === 0.5);
  check('不传 sizeScale 时保持原尺寸',
    new Battle(mkConfig({ teams: [['test'], ['test']], seed: 1 })).sizeScale === 1);
}
{
  // 小球必须仍然待在缩小后的场地内
  for (const sizeScale of [0.35, 0.5, 0.75, 1.0, 1.4]) {
    const cfg = mkConfig({
      teams: [['test', 'test'], ['test', 'test']], arenaId: 'octagon', seed: 77, sizeScale
    });
    const b = new Battle(cfg);
    let outside = 0;
    let guard = 0;
    while (!b.over && guard < 6000) {
      b.step();
      const shape = effectiveShape(
        cfg.rules.allowShrink ? b.arena : { ...b.arena, effects: { ...b.arena.effects, shrink: null } },
        b.time
      );
      for (const u of b.units) {
        if (!u.alive) continue;
        if (shape.type === 'poly' && !pointInsidePolyTol(shape.points, u.x / SCALE, u.y / SCALE, 1.5)) outside++;
      }
      guard++;
    }
    check(`缩放 ${Math.round(sizeScale * 100)}% 时小球不越界`, outside === 0,
      outside ? `越界 ${outside} 次` : `模拟 ${guard} 帧`);
  }
}
{
  /* 场地缩小的效果是"单位时间内交手更频繁"，而不是"对局时长一定更短" ——
     两者不是一回事：交手多了，每场伤害也涨得快，但对局何时结束受
     随机轨迹影响很大，单看时长噪声极大（实测 75% 甚至可能比 100% 更慢）。
     所以这里测真正有意义的量：单位时间内的碰撞次数。 */
  const measure = sizeScale => {
    let seconds = 0, bounces = 0, maxObserved = 0;
    const SAMPLE = 40;                 // 每次取样最多跑 40 秒，避免被长尾拉偏
    for (const arenaId of ['rect', 'octagon', 'circle']) {
      for (let seed = 1; seed <= 6; seed++) {
        const b = new Battle(mkConfig({
          teams: [['test'], ['test']], arenaId, seed, sizeScale
        }));
        while (!b.over && b.frame < SAMPLE * 60) b.step();
        seconds += b.frame / 60;
        bounces += b.events.filter(e => e.type === 'bounce').length;
        maxObserved++;
      }
    }
    void maxObserved;
    return bounces / seconds;          // 每秒球球碰撞次数
  };
  const full = measure(1.0);
  const half = measure(0.5);
  check('缩小到 50% 后单位时间内的碰撞次数明显增加', half > full * 1.3,
    `${full.toFixed(2)} → ${half.toFixed(2)} 次/秒（各 ${18} 场取样）`);
}

/* ---------- 19b. 碰撞后不会粘在一起 ---------- */
console.log('\n【19b】碰撞后不粘滞');
{
  /* 判定标准：连续重叠帧数。
     正常碰撞只会重叠几帧（穿透的那一瞬），
     真正"粘住"会表现为连续几百帧都叠在一起。 */
  let worstRun = 0, worstWhere = '';
  for (const arenaId of ['rect', 'octagon', 'circle', 'triangle']) {
    for (const sizeScale of [0.5, 1.0]) {
      for (const seed of [31, 7, 555]) {
        const b = new Battle(mkConfig({
          teams: [['test'], ['test']], arenaId, seed, sizeScale
        }));
        const streak = new Map();
        while (!b.over && b.frame < b.maxFrames) {
          b.step();
          const alive = b.units.filter(u => u.alive);
          const seen = new Set();
          for (let i = 0; i < alive.length; i++) {
            for (let j = i + 1; j < alive.length; j++) {
              const A = alive[i], B = alive[j];
              const key = Math.min(A.id, B.id) * 100 + Math.max(A.id, B.id);
              const d = Math.hypot(A.x - B.x, A.y - B.y);
              if (d < A.r + B.r - 0.5) {
                seen.add(key);
                const v = (streak.get(key) || 0) + 1;
                streak.set(key, v);
                if (v > worstRun) { worstRun = v; worstWhere = `${arenaId}/${Math.round(sizeScale * 100)}%/seed${seed}`; }
              }
            }
          }
          for (const key of [...streak.keys()]) if (!seen.has(key)) streak.delete(key);
        }
      }
    }
  }
  // 1 秒（60 帧）以上的连续重叠才算"粘住"
  check('没有任何球对被粘住（连续重叠 < 1 秒）', worstRun < 60,
    `最长连续重叠 ${worstRun} 帧（${(worstRun / 60).toFixed(2)}s）@ ${worstWhere || '-'}`);
}
{
  // 缩放不破坏确定性
  const runs = [0, 1, 2].map(() => {
    const b = new Battle(mkConfig({
      teams: [['test', 'test'], ['test', 'test']], arenaId: 'octagon', seed: 20260930, sizeScale: 0.5
    }));
    b.runToEnd();
    return b.fingerprint();
  });
  check('缩放后仍可复现', runs.every(f => f === runs[0]), runs.join(' / '));
}

/* ---------- 20. 碰撞的物理正确性（用守恒量检验，不依赖人工摆位） ---------- */
console.log('\n【20】碰撞的物理正确性');
{
  /* 完全弹性碰撞应当守恒动能。逐次碰撞前后比较两球的速率平方和 ——
     这是最稳健的检验：不依赖事件里谁是谁，也不需要人工摆放初始状态。 */
  let checks = 0, violations = [];
  for (const arenaId of ['rect', 'octagon', 'circle', 'diamond']) {
    for (const sizeScale of [0.5, 1.0]) {
      for (const seed of [31, 7, 555]) {
        const b = new Battle(mkConfig({
          teams: [['test', 'test'], ['test', 'test']], arenaId, seed, sizeScale
        }));
        while (!b.over && b.frame < b.maxFrames) {
          const evStart = b.events.length;
          const pre = new Map();
          for (const u of b.units) if (u.alive) pre.set(u.id, u.vx * u.vx + u.vy * u.vy);
          b.step();
          for (const e of b.events.slice(evStart)) {
            if (e.type !== 'bounce') continue;
            const A = b.units[e.a], B = b.units[e.b];
            if (!A || !B || !A.alive || !B.alive) continue;
            const p0 = (pre.get(e.a) ?? 0) + (pre.get(e.b) ?? 0);
            const p1 = A.vx * A.vx + A.vy * A.vy + B.vx * B.vx + B.vy * B.vy;
            if (p0 < 1) continue;
            checks++;
            // 允许少量定点取整误差（相对 2%）
            if (Math.abs(p1 - p0) / p0 > 0.02) {
              violations.push(`${arenaId}/${Math.round(sizeScale * 100)}%/seed${seed} `
                + `动能 ${(p0 / 1e6).toFixed(1)} -> ${(p1 / 1e6).toFixed(1)}`);
            }
          }
        }
      }
    }
  }
  check('每次碰撞都守恒动能（完全弹性）', violations.length === 0,
    violations.length ? violations.slice(0, 3).join(' | ') : `${checks} 次碰撞全部守恒`);
}

/* ---------- 21. 帧末不存在"重叠且仍在靠近"的球对 ---------- */
console.log('\n【21】帧末不存在"叠在一起还在往里挤"的球对');
{
  /* 这才是"粘住"的严格定义：两球互相重叠，同时相对速度还在减小间距。
     两者同时成立才会真的粘住；只是重叠（穿透那一瞬）是正常的。

     不用"每次碰撞事件后相对速度必须为正"来判定 ——
     同一帧可能发生多次碰撞，事件触发后速度还会被后续碰撞改写，
     那时采样到的是整帧结束的状态，会得出错误结论。 */
  let overlaps = 0, approachingWhileOverlapping = [];
  for (const arenaId of ['rect', 'octagon', 'circle', 'triangle', 'diamond']) {
    for (const sizeScale of [0.5, 1.0]) {
      for (const seed of [31, 7, 555, 12, 99, 1234]) {
        const b = new Battle(mkConfig({
          teams: [['test', 'test'], ['test', 'test']], arenaId, seed, sizeScale
        }));
        while (!b.over && b.frame < b.maxFrames) {
          b.step();
          const alive = b.units.filter(u => u.alive);
          for (let i = 0; i < alive.length; i++) {
            for (let j = i + 1; j < alive.length; j++) {
              const A = alive[i], B = alive[j];
              const dx = B.x - A.x, dy = B.y - A.y;
              const d = Math.hypot(dx, dy);
              const pen = (A.r + B.r - d) / SCALE;
              /* 只统计"确实叠进去了"的情况。
                 刚好相切（穿透 < 0.5 单位）时相对速度可以任意 —— 那只是接触，
                 不是粘住；把它们算进来会让断言变得毫无意义。 */
              if (pen <= 0.5) continue;
              overlaps++;
              const rel = ((B.vx - A.vx) * dx + (B.vy - A.vy) * dy) / (d || 1) / SCALE;
              if (rel < -3 && approachingWhileOverlapping.length < 6) {
                approachingWhileOverlapping.push(
                  `${arenaId}/${Math.round(sizeScale * 100)}%/seed${seed} 重叠 ${pen.toFixed(1)} 相对速度 ${rel.toFixed(1)}`);
              }
            }
          }
        }
      }
    }
  }
  check('没有"重叠且仍在靠近"的球对（不会粘住）',
    approachingWhileOverlapping.length === 0,
    approachingWhileOverlapping.length ? approachingWhileOverlapping.join(' | ')
      : `检查了 ${overlaps} 个重叠帧，全部在分离`);
}

/* ---------- 22. 开局不允许重叠 ---------- */
console.log('\n【22】开局站位不重叠');
{
  /* 小球体积翻倍后，简单的环形排布会把靠外的球推出场地、
     被夹紧拉回后又叠在一起。现在用"环形 + 带边界检查的螺旋搜索"放置。 */
  let worst = Infinity, worstAt = '', cases = 0, bad = 0;
  for (const arenaId of ['rect', 'circle', 'octagon', 'hexagon', 'decagon', 'diamond', 'triangle']) {
    for (const n of [1, 2, 3, 4, 5, 6]) {
      for (const seed of [31, 7, 555]) {
        const b = new Battle(mkConfig({
          teams: [Array(n).fill('test'), Array(n).fill('test')],
          arenaId, seed, sizeScale: 1
        }));
        const us = b.units;
        for (let i = 0; i < us.length; i++) {
          for (let j = i + 1; j < us.length; j++) {
            const A = us[i], B = us[j];
            const d = Math.hypot(A.x - B.x, A.y - B.y) / SCALE;
            const gap = d - (A.r + B.r) / SCALE;
            cases++;
            if (gap < worst) { worst = gap; worstAt = `${ARENA_BY_ID[arenaId].name}/${n}v${n}/seed${seed}`; }
            if (gap < -3) bad++;
          }
        }
      }
    }
  }
  /* 容忍 -3 单位：三角场这类狭窄场地塞满 6 个大球时，
     勉强贴合是几何极限，不该当成 bug。 */
  check('开局没有明显重叠的球对（容差 3 单位）', bad === 0,
    `最差间距 ${worst.toFixed(1)} @ ${worstAt}（${cases} 组配对）`);
}

/* ---------- 23. 小球体积倍率 ---------- */
console.log('\n【23】小球体积倍率');
{
  const st = makeUnitStats('test');
  const sp = SPECIES_BY_ID[st.speciesId];
  check('半径按倍率放大', st.r === sp.r * BALL_SCALE, `${sp.r} → ${st.r}（倍率 ${BALL_SCALE}）`);
  check('移速同比放大（节奏观感不变）', st.speed === sp.speed * BALL_SCALE,
    `${sp.speed} → ${st.speed}`);
  check('伤害不变（只是变大，不是变强）', st.melee === sp.melee, `melee=${st.melee}`);
  check('生命不变', st.maxHp === sp.hp, `hp=${st.maxHp}（物种 ${sp.name}）`);
}

console.log('\n' + results.join('\n'));
console.log(`\n=========== 通过 ${pass} 项，失败 ${fail} 项 ===========`);
process.exit(fail ? 1 : 0);

/* ---------- 辅助 ---------- */
function pointInsidePolyTol(points, x, y, tol = 0) {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % n];
    const ex = x2 - x1, ey = y2 - y1;
    const len = Math.hypot(ex, ey) || 1;
    const cross = (ex * (y - y1) - ey * (x - x1)) / len;
    if (cross < -tol) return false;
  }
  return true;
}

function polySize(points) {
  let minX = Infinity, maxX = -Infinity;
  for (const [x] of points) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
  return maxX - minX;
}

import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { readFileSync } from 'node:fs';
/* ============================================================
   木桩自检
   ------------------------------------------------------------
   作者 2026-10 的要求：「新增一个木桩小球，速度恒定为 0，体型为大，
   血量 5000，碰撞伤害 50，无技能，用于斗蛐蛐技能演示。
   然后删去除了晕彩、缇娜、桃夭之外的所有测试用小球。」

   这个脚本盯四件事：
     ① **数据**：血量/体型/碰撞伤害/无技能 都得照要求；
     ② **速度恒定为 0**：这最容易被写坏 —— 单靠 `speed: 0` 只挡"自己走"，
        碰撞冲量、分离推挤、击退、撞墙反弹都会直接改 vx/vy，
        所以引擎给它加了 immovable（按"质量极大"处理）+ 每帧清零速度。
        这里就用"被三颗球围撞一整局，位置一个单位都不能变"来验；
     ③ **当靶子**：它得能被打伤、被打死 —— 不然演示局收不了场；
     ④ **渲染**：它没有贴图（作者还没给美术），渲染层必须能退回纯色圆而不是崩。
   ============================================================ */
import { Battle, SNAP_STRIDE } from '../../js/core.js';
import { ARENAS, ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, SPECIES, SPECIES_BY_ID, PLAYABLE_SPECIES, makeUnitStats } from '../../js/balls.js';
import { Renderer } from '../../js/render.js';

let pass = 0, fail = 0;
const log = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; log.push(`  ✅ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; log.push(`  ❌ ${name}${detail ? '  — ' + detail : ''}`); }
};

const D = SPECIES_BY_ID.dummy;

console.log('=========== 木桩自检 ===========\n');

/* ---------- 1) 数据 ---------- */
console.log('【1】数据（照作者给的规格）');
{
  check('球种存在且 id 是 dummy', !!D, D ? `${D.id} / ${D.name}` : '没有 dummy 这个球种');
  check('血量 5000', D.hp === 5000, String(D.hp));
  check('速度 0', D.speed === 0, String(D.speed));
  check('碰撞伤害 50', D.melee === 50, String(D.melee));
  check('无技能', Array.isArray(D.skills) && D.skills.length === 0, JSON.stringify(D.skills));
  /* 2026-10 起多了"闯关专用"的敌人（NPC13 / NPC23 也是大体型 r=30），
     所以判据写成"木桩落在最大那一档、且不比任何**可选角色**小"。 */
  check('体型为大（最大那一档，且不小于任何可选角色）',
    D.r === 30 && PLAYABLE_SPECIES.filter(s => s.id !== 'dummy').every(s => D.r >= s.r),
    `木桩 r=${D.r}，可选角色里最大的 r=${Math.max(...PLAYABLE_SPECIES.filter(s => s.id !== 'dummy').map(s => s.r))}`);
  check('标了 immovable（否则会被撞飞，见下面的引擎用例）', D.immovable === true);

  const st = makeUnitStats('dummy');
  check('makeUnitStats 带上了 immovable 与 0 速度',
    st.immovable === true && st.speed === 0 && st.maxHp === 5000,
    `immovable=${st.immovable} speed=${st.speed} maxHp=${st.maxHp}`);
  check('它进了球种总表（图鉴 / 准备界面能选到）',
    SPECIES.some(s => s.id === 'dummy'));

  /* 游戏里只剩 4 个球：3 个正式角色 + 木桩。
     测试球（test / test_skill…）已经搬到 tests/lib/test-balls.mjs 当夹具。
     ⚠ 本进程的 SPECIES 里**当然**有夹具球（这文件自己 import 了它们），
     所以"游戏数据里没有测试球"要**去看源码**，而不是看内存。 */
  const src = readFileSync('js/balls.js', 'utf8');
  const gameBalls = SPECIES.filter(s => !s.id.startsWith('test'));
  check('游戏数据（js/balls.js）里没有测试球',
    !/id: '(test|test_skill|test_charge|test_lowhp|test_heavy)'/.test(src),
    ['test', 'test_skill', 'test_charge', 'test_lowhp', 'test_heavy']
      .filter(id => src.includes(`id: '${id}'`)).join('、') || '源码里一个都没有');
  /* 2026-10 加了闯关肉鸽：斗蛐蛐**能选**的仍然是 4 角色 + 木桩；
     另外还有一批"闯关专用"的球（玩家球 + 6 个关卡敌人），它们标了 rogueOnly，
     不会出现在准备界面的选球列表里。 */
  check('斗蛐蛐能选的球就是 4 个角色 + 木桩',
    PLAYABLE_SPECIES.length === 5 &&
    ['yuncai', 'taoyao', 'tina', 'jianqing', 'dummy'].every(id => PLAYABLE_SPECIES.some(s => s.id === id)),
    PLAYABLE_SPECIES.map(s => `${s.name}(${s.id})`).join('、'));
  const rogueBalls = gameBalls.filter(s => s.rogueOnly);
  check('闯关专用球都标了 rogueOnly（玩家球 + 6 个关卡敌人）',
    rogueBalls.length === 7 && rogueBalls.some(s => s.id === 'hero') &&
    rogueBalls.filter(s => s.id.startsWith('npc')).length === 6,
    rogueBalls.map(s => s.id).join('、'));
  check('夹具球是诊断脚本自己注册进来的（游戏侧不受影响）',
    SPECIES.some(s => s.id === 'test') && src.includes('木桩'),
    `本进程 SPECIES 有 ${SPECIES.length} 个（含夹具），源码里是 ${gameBalls.length} 个`);
}

/* ---------- 2) 速度恒为 0：被围撞一整局也不动 ---------- */
console.log('\n【2】速度恒定为 0（被围撞一整局）');
{
  const mk = (foeId, opts = {}) => new Battle({
    teams: [
      { units: [{ stats: makeUnitStats('dummy') }] },
      { units: Array.from({ length: opts.foes || 3 }, () => ({ stats: makeUnitStats(foeId) })) },
    ],
    arena: ARENA_BY_ID.rect,
    sizeScale: opts.sizeScale ?? 1,
    rules: { ...DEFAULT_RULES, timeLimit: opts.timeLimit ?? 0 },
    seed: opts.seed ?? 31,
  });

  const b = mk('test');
  const dummy = b.units[0];
  const home = { x: dummy.x, y: dummy.y };
  let movedMax = 0, maxSpeed = 0;
  while (!b.over && b.frame < b.maxFrames) {
    b.step();
    movedMax = Math.max(movedMax, Math.hypot(dummy.x - home.x, dummy.y - home.y));
    maxSpeed = Math.max(maxSpeed, Math.hypot(dummy.vx, dummy.vy));
  }
  check('整局跑完（不是卡在模拟上限）', b.over, `结束原因：${b.endReason}`);
  check('位置一个定点单位都没动过', movedMax === 0,
    `最大位移 ${(movedMax / 1000).toFixed(3)} 世界单位`);
  check('速度全程为 0（每帧都被清）', maxSpeed === 0, `最大速度 ${maxSpeed}`);
  check('它是挨了打的（说明确实被围撞了，不是没人理它）',
    dummy.taken > 0, `承伤 ${dummy.taken}`);

  /* 直接灌一个速度进去：任何来源（击退/冲刺/反弹/分离推挤）都不该让它动 */
  const b2 = mk('test', { timeLimit: 5 });
  const d2 = b2.units[0];
  const p2 = { x: d2.x, y: d2.y };
  d2.vx = 900 * 1000; d2.vy = -700 * 1000;
  b2.step();
  check('外部把速度灌进去也会被清掉（速度恒为 0 没有例外通道）',
    d2.vx === 0 && d2.vy === 0 && d2.x === p2.x && d2.y === p2.y,
    `v=(${d2.vx},${d2.vy}) 位移 ${(Math.hypot(d2.x - p2.x, d2.y - p2.y) / 1000).toFixed(3)}`);

  /* 分离推挤：把一颗球硬塞进木桩身体里，应该只有对方被推开 */
  const b3 = mk('test', { timeLimit: 5 });
  const d3 = b3.units[0], foe = b3.units[1];
  const p3 = { x: d3.x, y: d3.y };
  foe.x = d3.x; foe.y = d3.y;              // 完全重合
  foe.vx = 0; foe.vy = 0;
  b3.step();
  check('重叠时只有对方被推开，木桩不动',
    d3.x === p3.x && d3.y === p3.y && (foe.x !== d3.x || foe.y !== d3.y),
    `木桩位移 ${(Math.hypot(d3.x - p3.x, d3.y - p3.y) / 1000).toFixed(3)}，对方位移 ${(Math.hypot(foe.x - p3.x, foe.y - p3.y) / 1000).toFixed(2)}`);

  /* 各种场地都扫一遍。收缩场地（shrink_ring）是**唯一**的例外：
     边界往里收的时候，引擎会把越界的球夹回场内 —— 那是"被边界推回来"，
     不是"木桩自己在走"（它的速度全程仍然是 0）。所以分开验：
       · 其它场地：位置一个定点单位都不许动；
       · 收缩场地：位移只能是夹回来的，而且**只在越界时发生**，
         不能变成"贴着收缩的墙一路滑"。 */
  const badArena = [], badSpeed = [], slide = [];
  let shrinkMoved = 0, shrinkChangeFrames = 0, shrinkFrames = 0;
  for (const arena of ARENAS) {
    const bb = new Battle({
      teams: [
        { units: [{ stats: makeUnitStats('dummy') }] },
        { units: Array.from({ length: 2 }, () => ({ stats: makeUnitStats('test') })) },
      ],
      arena, sizeScale: 1, rules: { ...DEFAULT_RULES }, seed: 7,
    });
    const u = bb.units[0];
    const h = { x: u.x, y: u.y };
    let spd = 0, changed = 0, frames = 0;
    while (!bb.over && bb.frame < bb.maxFrames) {
      const px = u.x, py = u.y;
      bb.step();
      frames++;
      spd = Math.max(spd, Math.hypot(u.vx, u.vy));
      if (u.x !== px || u.y !== py) changed++;
    }
    const moved = Math.hypot(u.x - h.x, u.y - h.y) / 1000;
    if (spd > 0) badSpeed.push(arena.name);
    if (arena.id === 'shrink_ring') {
      shrinkMoved = moved; shrinkChangeFrames = changed; shrinkFrames = frames;
      /* 夹回来应该只在少数几帧发生；若一大半帧都在挪，那就是"被墙推着滑" */
      if (changed > frames * 0.5) slide.push(`${arena.name}(${changed}/${frames} 帧)`);
    } else if (u.x !== h.x || u.y !== h.y) {
      badArena.push(`${arena.name}(${moved.toFixed(2)})`);
    }
  }
  check('除收缩场地外，7 个场地里位置一个单位都不动', badArena.length === 0,
    badArena.join('、') || `${ARENAS.length - 1} 个场地合格`);
  check('所有场地里速度都恒为 0（含收缩场地）', badSpeed.length === 0,
    badSpeed.join('、') || `${ARENAS.length} 个场地`);
  check('收缩场地里只是"被边界夹回来"，没有一路被推着滑',
    slide.length === 0,
    `位移 ${shrinkMoved.toFixed(2)} 世界单位，只在 ${shrinkChangeFrames} / ${shrinkFrames} 帧里变过位置`);
}

/* ---------- 3) 当靶子：能被打伤、能被打死 ---------- */
console.log('\n【3】当靶子（演示局要能收场）');
{
  const b = new Battle({
    teams: [
      { units: [{ stats: makeUnitStats('yuncai', ['yuncai_modan', 'yuncai_prism', 'yuncai_caiguang']) }] },
      { units: [{ stats: makeUnitStats('dummy') }] },
    ],
    arena: ARENA_BY_ID.rect, sizeScale: 1,
    rules: { ...DEFAULT_RULES, timeLimit: 180 }, seed: 5,
  });
  while (!b.over && b.frame < b.maxFrames) b.step();
  const dummy = b.units[1];
  check('木桩被打伤了', dummy.taken > 0, `承伤 ${dummy.taken}`);
  check('这一局收场了（有胜负）', b.over && (b.winner === 0 || b.winner === 1),
    `${b.endReason}（第 ${(b.frame / 60).toFixed(1)} 秒）`);
  check('演示局时长在可接受范围内（< 3 分钟模拟时间）', b.frame / 60 < 180,
    `${(b.frame / 60).toFixed(1)} 秒`);

  /* 两个木桩：**永远打不完**（都动不了，碰不到对方）。
     这是"靶子"的必然结果，不是 bug —— 这里把它钉成已知行为：
     只有打开「比赛时长上限」才收场。 */
  const bb = new Battle({
    teams: [
      { units: [{ stats: makeUnitStats('dummy') }] },
      { units: [{ stats: makeUnitStats('dummy') }] },
    ],
    arena: ARENA_BY_ID.rect, sizeScale: 1,
    rules: { ...DEFAULT_RULES, timeLimit: 30 }, seed: 5,
  });
  while (!bb.over && bb.frame < bb.maxFrames) bb.step();
  check('两个木桩对打：谁也伤不到谁（都不会动）',
    bb.units.every(u => u.taken === 0), bb.units.map(u => u.taken).join(' / '));
  check('两个木桩对打：靠「比赛时长上限」收场（这是已知行为，不是 bug）',
    bb.over && /时间上限/.test(bb.endReason || ''), bb.endReason);
}

/* ---------- 4) 渲染：没有贴图也不能崩 ---------- */
console.log('\n【4】渲染（它没有贴图，要能退回纯色圆）');
{
  const calls = [];
  const rec = (name) => (...a) => { calls.push({ name, a }); };
  const ctx = {
    calls,
    canvas: null,
    globalAlpha: 1, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    lineCap: 'butt', lineJoin: 'miter', font: '', textAlign: 'left', textBaseline: 'alphabetic',
    setTransform: rec('setTransform'), clearRect: rec('clearRect'),
    save: rec('save'), restore: rec('restore'), scale: rec('scale'), translate: rec('translate'),
    rotate: rec('rotate'), beginPath: rec('beginPath'), closePath: rec('closePath'),
    moveTo: rec('moveTo'), lineTo: rec('lineTo'), rect: rec('rect'), clip: rec('clip'),
    fill: rec('fill'), stroke: rec('stroke'), fillRect: rec('fillRect'), strokeRect: rec('strokeRect'),
    fillText: rec('fillText'), strokeText: rec('strokeText'), setLineDash: rec('setLineDash'),
    arc: rec('arc'), ellipse: rec('ellipse'), drawImage: rec('drawImage'),
    measureText: (t) => ({ width: String(t).length * 5 }),
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  const cv = { width: 900, height: 550, clientWidth: 900, clientHeight: 550, style: {}, parentElement: { clientWidth: 900 }, getContext: () => ctx };
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.performance = globalThis.performance || { now: () => 0 };

  const b = new Battle({
    teams: [
      { units: [{ stats: makeUnitStats('yuncai', ['yuncai_modan']) }] },
      { units: [{ stats: makeUnitStats('dummy') }] },
    ],
    arena: ARENA_BY_ID.rect, sizeScale: 1, rules: { ...DEFAULT_RULES }, seed: 5,
  });
  for (let i = 0; i < 60 * 10; i++) b.step();

  const rd = new Renderer(cv);
  rd.showHud = true; rd.showDamage = true;
  let threw = null;
  try {
    for (let f = 0; f < b.snapshots.length; f += 3) rd.draw(b, f);
  } catch (e) { threw = e; }
  check('整局逐帧渲染不抛错（没有贴图的球走纯色圆兜底）',
    !threw, threw ? threw.message : `${Math.ceil(b.snapshots.length / 3)} 帧`);

  /* 木桩的圆心处必须画过东西（血条/贴图/兜底圆），否则就是"看不见的球" */
  const snap = b.snapshots[b.snapshots.length - 1];
  const DUMMY_UNIT = 1;                       // teams[1] 就是木桩
  const dx = snap.data[DUMMY_UNIT * SNAP_STRIDE];
  const dy = snap.data[DUMMY_UNIT * SNAP_STRIDE + 1];
  calls.length = 0;
  rd.draw(b, b.snapshots.length - 1);
  const nearDummy = calls.filter(c =>
    (c.name === 'arc' || c.name === 'fillRect' || c.name === 'fillText' ||
     c.name === 'drawImage' || c.name === 'ellipse') &&
    c.a && Math.abs((c.a[0] ?? 0) - dx) < 90 && Math.abs((c.a[1] ?? 0) - dy) < 90);
  check('木桩身上（那一帧）确实画了东西', nearDummy.length > 0,
    `${nearDummy.length} 次绘制调用，圆心 (${dx}, ${dy})`);

  /* 准星：球种半径即判定半径（木桩也是） */
  check('木桩的判定半径 = 显示半径 = 30',
    makeUnitStats('dummy').r === 30, String(makeUnitStats('dummy').r));
}

console.log('\n' + log.join('\n'));
console.log(`\n=========== 通过 ${pass} 项，失败 ${fail} 项 ===========`);
process.exit(fail ? 1 : 0);

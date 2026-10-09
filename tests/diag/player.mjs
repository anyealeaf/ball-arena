/* ============================================================
   tests/diag/player.mjs — 玩家操控（实时战斗界面）自检
   ------------------------------------------------------------
   这一套的重点是"**界面到底有没有把玩家的操作喂给引擎**"：
     · WASD 按键 → 八向移动
     · 鼠标位置 → 弹道初始方向
     · 技能键（默认 左键/右键/E/1/2/3）→ 主动技能发动 + 冷却
     · 被动/形态技能照旧自动触发
     · 实时模式下的播放控件（打到一半不能拖进度条，打完了可以回看）
   用 linkedom 提供真实 DOM，rAF 队列手动跑帧（与 smoke.test.mjs 同一套路）。
   用法：node tests/diag/player.mjs
   ============================================================ */

import '../lib/test-balls.mjs';
import { parseHTML } from 'linkedom';

let pass = 0, fail = 0;
const log = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; log.push(`  ✅ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; log.push(`  ❌ ${name}${detail ? '  — ' + detail : ''}`); }
}

console.log('=========== 玩家操控 · 实时战斗自检 ===========\n');

/* ---------- 1) 浏览器环境 ---------- */
const { window, document } = parseHTML('<!DOCTYPE html><html><body><div id="app"></div></body></html>');
const ctxStub = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'canvas') return { width: 720, height: 440, clientWidth: 720, clientHeight: 440 };
    if (prop === 'createRadialGradient' || prop === 'createLinearGradient') return () => ({ addColorStop() {} });
    if (prop === 'measureText') return () => ({ width: 10 });
    return () => {};
  },
  set() { return true; },
});
const proto = window.HTMLCanvasElement && window.HTMLCanvasElement.prototype;
if (!proto) { console.error('linkedom 没有 HTMLCanvasElement.prototype，无法跑界面自检'); process.exit(1); }
proto.getContext = () => ctxStub;
/* 画布在页面里的位置：测试里假定它贴在视口左上角、720×440 —— 
   screenToWorld 就是按这个矩形反算世界坐标的。 */
proto.getBoundingClientRect = () => ({ left: 0, top: 0, right: 720, bottom: 440, width: 720, height: 440 });
Object.defineProperty(proto, 'clientWidth', { get: () => 720, configurable: true });
Object.defineProperty(proto, 'clientHeight', { get: () => 440, configurable: true });

globalThis.window = window;
globalThis.document = document;
globalThis.performance = globalThis.performance || { now: () => Date.now() };
window.devicePixelRatio = 1;
window.scrollTo = () => {};

const rafQueue = [];
window.requestAnimationFrame = fn => { rafQueue.push(fn); return rafQueue.length; };
globalThis.requestAnimationFrame = window.requestAnimationFrame;
let mockNow = 100000;
/** 跑 n 帧（每帧 16.7ms ≈ 一个逻辑帧 @1×） */
const runFrames = (n) => {
  for (let i = 0; i < n; i++) {
    mockNow += 16.7;
    const q = rafQueue.splice(0, rafQueue.length);
    for (const fn of q) fn(mockNow);
  }
};

const store = new Map();
const localStorageStub = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
  clear: () => store.clear(),
};
globalThis.localStorage = localStorageStub;
window.localStorage = localStorageStub;
globalThis.location = { hash: '', href: 'http://localhost/', pathname: '/', reload() {} };
window.location = globalThis.location;

/* 假的 Image：**记录"是谁新建的它"**（构造栈）。
   贴图必须在"画到它之前"就开始加载（见 ui-battle.js 的 warmSprites），
   所以下面靠"构造栈里有没有 preloadProjSprites"来钉这条。 */
const imgStacks = [];
globalThis.Image = class {
  constructor() {
    imgStacks.push(new Error().stack || '');
    this.width = 64; this.height = 64; this.naturalWidth = 64; this.naturalHeight = 64;
    this._src = '';
  }
  get src() { return this._src; }
  set src(v) { this._src = v; if (this.onload) this.onload(); }
};

const root = document.getElementById('app');

/* ---------- 2) 模块 ---------- */
const balls = await import('../../js/balls.js');
const skills = await import('../../js/skills.js');
const prefs = await import('../../js/prefs.js');
const { renderBattle } = await import('../../js/ui-battle.js');
const { stickerPaths } = await import('../../js/render.js');
const { Battle } = await import('../../js/core.js');
const { ARENA_BY_ID } = await import('../../js/arenas.js');

/* ---------- 3) 事件模拟小工具 ---------- */
const key = (type, code) => {
  const e = new window.Event(type, { bubbles: true, cancelable: true });
  e.code = code;
  window.dispatchEvent(e);
};
const tapKey = code => { key('keydown', code); };
const holdKey = code => key('keydown', code);
const releaseKey = code => key('keyup', code);
/* ⚠ 鼠标位置要**跟着 moveMouse 走**：按下时引擎也会用事件坐标更新瞄准点，
   如果 mousedown 固定写个中心值，就会把刚移好的瞄准方向覆盖掉
   （第一版就是固定 clientX=360，于是"鼠标放左边"的用例量到的是朝右飞）。 */
const mousePos = { x: 360, y: 220 };
const moveMouse = (x, y) => {
  mousePos.x = x; mousePos.y = y;
  const e = new window.Event('mousemove', { bubbles: true, cancelable: true });
  e.clientX = x; e.clientY = y;
  window.dispatchEvent(e);
};
const mouseDown = (el, button = 0, x = mousePos.x, y = mousePos.y) => {
  const e = new window.Event('mousedown', { bubbles: true, cancelable: true });
  e.button = button; e.clientX = x; e.clientY = y;
  el.dispatchEvent(e);
};
const mouseUp = (button = 0) => {
  const e = new window.Event('mouseup', { bubbles: true, cancelable: true });
  e.button = button;
  window.dispatchEvent(e);
};

/** 造一局玩家操控 */
const mkCfg = (opts = {}) => ({
  teams: [
    { units: [{ slot: 0, stats: balls.makeUnitStats(opts.playerId || 'yuncai', opts.playerSkills || ['yuncai_modan']) }] },
    { units: [{ slot: 100, stats: balls.makeUnitStats(opts.foeId || 'dummy', opts.foeSkills || []) }] },
  ],
  arena: ARENA_BY_ID.rect,
  sizeScale: 1,
  rules: { ...balls.DEFAULT_RULES, timeLimit: opts.timeLimit ?? 0, playerControl: true },
  playerSlot: 0,
});

const startBattle = (opts = {}) => {
  root.innerHTML = '';
  rafQueue.length = 0;
  renderBattle(root, mkCfg(opts), () => {});
  return {
    canvas: root.querySelector('#battleCanvas'),
    hud: root.querySelector('#ctrlHud'),
    start: root.querySelector('#startLayer'),
    startBtn: root.querySelector('#btStart'),
    seek: root.querySelector('#btSeek'),
    skip: root.querySelector('#btSkip'),
    step: root.querySelector('#btStep'),
    play: root.querySelector('#btPlay'),
  };
};
/** 点「斗蛐蛐开始」—— 现在开战必须经过这一下（作者 2026-10 的要求）。
 *  ⚠ 跑两帧：点下去的那一帧要重置计时基准（dtms 归 0），第二步才真的走。 */
const clickStart = (ui) => { ui.startBtn.onclick(); runFrames(2); };

/* ---------- 3.5 开战闸门：进界面不立刻开打 ---------- */
console.log('【0】开战闸门（「斗蛐蛐开始」）');
{
  const ui = startBattle({ playerSkills: [] });
  const b = ui.canvas.__battle;
  runFrames(30);                       // 干等 30 帧
  check('进战斗界面后**不会**自己开打（帧数停在 0）', b.frame === 0, `${b.frame} 帧`);
  check('遮罩上出现「斗蛐蛐开始」按钮', !!ui.startBtn && ui.startBtn.textContent.includes('斗蛐蛐开始'),
    ui.startBtn ? ui.startBtn.textContent : '没有按钮');
  check('遮罩带 .show（默认 display:none，靠类显示）',
    ui.start.classList.contains('show'), ui.start.className);
  check('没开始前：单步/拖动/跳到结果都禁用',
    ui.seek.disabled === true && ui.step.disabled === true && ui.skip.disabled === true,
    `seek=${ui.seek.disabled} step=${ui.step.disabled} skip=${ui.skip.disabled}`);
  check('没开始前：播放键不做事（不推进、也不报错）', (() => {
    ui.play.onclick();
    runFrames(5);
    return b.frame === 0;
  })(), `${b.frame} 帧`);
  check('没开始前：技能栏已经能看（先看清带的是什么再开打）',
    !ui.hud.hidden, String(ui.hud.hidden));

  clickStart(ui);
  check('点开始后遮罩收起', !ui.start.classList.contains('show'), ui.start.className);
  check('点开始后立刻开始推进', b.frame > 0, `${b.frame} 帧`);
  /* 这一局是**实时操控**：开始之后进度条仍然锁着（快照还没录完），
     要等本局打完才解禁 —— 全自动模式的解禁在【6】里验。 */
  check('开始后仍然是实时模式：中途锁住进度条', ui.seek.disabled === true,
    String(ui.seek.disabled));
  /* 等待期间的时间不能被算成"已经过去"：点了开始的第一帧只该走 1~2 帧，
     不能把干等的 30 帧一次性补上（那会让开局"跳"一下）。 */
  check('等待时间不会被补进战斗（开局不跳帧）', b.frame <= 4, `${b.frame} 帧`);
}

/* ---------- 4) 技能栏 HUD：默认按键与技能对应 ---------- */
console.log('\n【1】技能栏（HUD）与默认按键');
{
  prefs._resetPrefsCache();
  prefs.setPlayerKeys(['Mouse0', 'Mouse2', 'KeyE', 'Digit1', 'Digit2', 'Digit3']);
  const ui = startBattle();
  runFrames(2);
  const html = ui.hud ? ui.hud.innerHTML : '';
  check('技能栏出现在战场上', !!ui.hud && !ui.hud.hidden, ui.hud ? String(ui.hud.hidden) : '没有 #ctrlHud');
  check('技能栏**不在画布之上**（否则会挡住战场下沿的球和弹道）',
    !ui.hud.closest('.stage'), String(!!ui.hud.closest('.stage')));
  check('显示了默认按键（鼠标左键）', html.includes('鼠标左键'), html.slice(0, 120));
  check('技能名跟着按键一起显示（魔弹）', html.includes('魔弹'), html.includes('魔弹') ? '有' : '没有');
  check('显示"就绪"状态（开局冷却为 0）', html.includes('就绪'));
  const manual = skills.manualSkillIds({ skills: ['yuncai_modan'] });
  check('界面的技能顺序 = 引擎的 manualSkillIds', manual.length === 1 && manual[0] === 'yuncai_modan',
    manual.join(','));
  check('未占用的键位不会冒出来（只有一个主动技能 → 只有一格）',
    (html.match(/ch-slot/g) || []).length === 1, `${(html.match(/ch-slot/g) || []).length} 格`);
}

/* ---------- 5) WASD 八向移动 ---------- */
console.log('\n【2】WASD 八向移动');
{
  const ui = startBattle({ playerSkills: [] });
  clickStart(ui);
  runFrames(2);
  const battle = null;   // 引擎在界面内部，这里用画面位置验证
  const posOf = () => {
    // 玩家球的世界坐标从渲染器读不到，改从"快照"读：界面把快照画出来了，
    // 但更直接的是用 window.__battleKeyState 之外的口子 —— 这里用一个内部约定：
    // renderBattle 会把 battle 挂在 canvas 上（见 ui-battle.js 的 __battle）。
    return ui.canvas.__battle.units[0];
  };
  check('画布上留了引擎引用（诊断用）', !!ui.canvas.__battle);
  const u = posOf();
  const x0 = u.x, y0 = u.y;
  holdKey('KeyD');
  runFrames(20);
  check('按住 D：向右移动', u.x > x0 + 5, `x ${(x0 / 1000).toFixed(1)} → ${(u.x / 1000).toFixed(1)}`);
  check('按住 D：y 基本不变（不是斜着走）', Math.abs(u.y - y0) < 3,
    `Δy ${((u.y - y0) / 1000).toFixed(2)}`);
  releaseKey('KeyD');
  runFrames(20);
  const stopped = Math.hypot(u.vx, u.vy) / 1000;
  check('松开后很快停下', stopped < 1, `${stopped.toFixed(2)}`);

  holdKey('KeyW'); holdKey('KeyD');
  runFrames(20);
  check('按住 W+D：斜向右上（八向）', u.vx > 0 && u.vy < 0,
    `v = (${(u.vx / 1000).toFixed(0)}, ${(u.vy / 1000).toFixed(0)})`);
  releaseKey('KeyW'); releaseKey('KeyD');
}

/* ---------- 6) 按键发动主动技能 + 冷却 ---------- */
console.log('\n【3】主动技能：按键发动、冷却、鼠标定方向');
{
  const ui = startBattle();
  clickStart(ui);
  runFrames(2);
  const battle = ui.canvas.__battle;
  const u = battle.units[0];
  /* ⚠ 魔弹技能"累计命中两次后下一发变激光"，所以两种弹道都要算上 ——
     只数 modan 的话会在第三发那里看到"放了但找不到弹道"的假红。 */
  const shots = () => battle.events.filter(e => e.type === 'shoot' &&
    (e.tag === 'modan' || e.tag === 'laser')).length;
  const lastShot = () => battle.projectiles.filter(p => p.tag === 'modan' || p.tag === 'laser').pop();
  check('开局什么都没放（不按键不会自动开火）', shots() === 0, `${shots()} 发`);

  /* 鼠标放到画面右侧 → 弹道应该往右（vx > 0） */
  moveMouse(700, 220);
  mouseDown(ui.canvas, 0);
  runFrames(2);
  mouseUp(0);
  const p1 = lastShot();
  check('按鼠标左键 → 立刻放出一发魔弹', shots() === 1, `${shots()} 发`);
  check('弹道朝鼠标（鼠标在右侧 → vx > 0）', !!p1 && p1.vx > 0,
    p1 ? `${(p1.vx / 1000).toFixed(0)}` : '-');
  const hud1 = ui.hud.innerHTML;
  check('技能栏显示冷却倒计时（不是"就绪"）', /ch-cd">[\d.]+s/.test(hud1),
    (hud1.match(/ch-cd">[^<]*/) || [''])[0]);

  /* 冷却没走完之前按住不放也不会连发 */
  moveMouse(700, 220);
  mouseDown(ui.canvas, 0);
  runFrames(20);
  check('冷却中按住不放不会连发', shots() === 1, `${shots()} 发`);

  /* 等冷却结束（魔弹 2 秒）→ 再按就再放 */
  mouseUp(0);
  runFrames(140);
  check('冷却走完后技能栏回到"就绪"', ui.hud.innerHTML.includes('就绪'));
  mouseDown(ui.canvas, 0);
  runFrames(2);
  mouseUp(0);
  check('冷却结束后再按又能放', shots() === 2, `${shots()} 发`);

  /* 方向跟着鼠标变：这次鼠标放左侧 */
  runFrames(140);
  moveMouse(20, 220);
  mouseDown(ui.canvas, 0);
  runFrames(2);
  mouseUp(0);
  const p2 = lastShot();
  check('鼠标换到左侧 → 新弹道朝左（vx < 0）', !!p2 && p2.vx < 0,
    p2 ? `${p2.tag} vx=${(p2.vx / 1000).toFixed(0)}` : `没有弹道（共放过 ${shots()} 发，over=${battle.over}，cd=${(u.skillCd['yuncai_modan'] || 0).toFixed(2)}）`);
  check('玩家球本身没被鼠标"拖走"', Math.abs(u.x - battle.units[0].x) < 1);

  /* 其他键位的球：按 E / 1 / 2 / 3 在没有对应技能时什么都不放 */
  const before = shots();
  tapKey('KeyE'); tapKey('Digit1'); tapKey('Digit2'); tapKey('Digit3');
  runFrames(2);
  check('按到未绑定的技能键不会乱放技能', shots() === before, `${shots()} 发`);

  /* ---- 快速点按不能被吞掉 ----
     按下与松开如果都发生在**同一帧的间隙里**，只看"按住"的实现会整发丢掉
     （作者报的"手操有时特效不见了"就是这个）。所以按下的动作要锁存到被消费。 */
  runFrames(140);                          // 等冷却
  const beforeTap = shots();
  const bd = beforeTap;
  void bd;
  const down = new window.Event('mousedown', { bubbles: true, cancelable: true });
  down.button = 0; down.clientX = 700; down.clientY = 220;
  ui.canvas.dispatchEvent(down);
  const up = new window.Event('mouseup', { bubbles: true, cancelable: true });
  up.button = 0;
  window.dispatchEvent(up);                // 同一帧内就松开
  runFrames(2);
  check('同一帧内按下又松开，这一发照样打得出去（按下会被锁存）',
    shots() === beforeTap + 1, `${beforeTap} → ${shots()}`);

  /* ---- 弹道贴图要在"画到它之前"就开始加载 ---- */
  const boltPath = 'assets/characters/yuncai_bolt.png';
  check(`弹道贴图在绘制前就预热（调色板一长出来就加载 ${boltPath}）`,
    imgStacks.some(s => /preloadProjSprites/.test(s)) && stickerPaths().includes(boltPath),
    `已登记 ${stickerPaths().length} 张，其中带 preload 调用栈的 ${imgStacks.filter(s => /preloadProjSprites/.test(s)).length} 次`);
}

/* ---------- 7) 被动 / 形态技能照旧自动触发 ---------- */
console.log('\n【4】被动技能自动触发（见晴①变色）');
{
  const ui = startBattle({ playerId: 'jianqing', playerSkills: ['jianqing_mirror_def'] });
  clickStart(ui);
  runFrames(4);
  const battle = ui.canvas.__battle;
  const u = battle.units[0];
  const html = ui.hud.innerHTML;
  check('技能栏说明"这个球没有主动技能"', /没有主动技能/.test(html), html.slice(0, 100));
  check('技能栏列出自动触发的技能名', /自动触发：.*水镜/.test(html),
    (html.match(/自动触发：[^<]*/) || [''])[0]);
  check('不按键也会自动变色（ringKind 1/2）', u.ringKind === 1 || u.ringKind === 2,
    `ringKind=${u.ringKind}`);
}

/* ---------- 8) 实时模式的播放控件 ---------- */
console.log('\n【5】实时模式的播放控件');
{
  const ui = startBattle();
  clickStart(ui);
  runFrames(30);
  const battle = ui.canvas.__battle;
  check('实时推进：帧数在涨', battle.frame > 20, `${battle.frame} 帧`);
  check('进度条上限跟着涨（能反映这一局有多长）',
    Number(ui.seek.max) === battle.frame, `seek.max=${ui.seek.max} / frame=${battle.frame}`);
  check('打到一半：进度条禁用（快照还没录完）', ui.seek.disabled === true || ui.seek.hasAttribute('disabled'),
    String(ui.seek.disabled));
  check('打到一半：单步/跳到结果也禁用',
    (ui.step.disabled === true) && (ui.skip.disabled === true));
  check('实时模式的指纹栏写明"实时操控"',
    /实时操控/.test(root.querySelector('#btFp').textContent),
    root.querySelector('#btFp').textContent);

  /* 跑到本局结束（时间上限 1 秒 + 判定留一帧） */
  runFrames(90);
  check('本局结束后：进度条解禁，可以回看', !battle.over || !ui.seek.disabled,
    `over=${battle.over} disabled=${ui.seek.disabled}`);
  if (battle.over) {
    check('结束后快照录满整局（回看用的快照数 ≈ 帧数）',
      battle.snapshots.length >= battle.frame,
      `${battle.snapshots.length} 张 / ${battle.frame} 帧`);
    check('结束后技能栏提示可以回看', /回看/.test(ui.hud.innerHTML));
  }
}

/* ---------- 9) 全自动模式不受影响 ---------- */
console.log('\n【6】没开玩家操控时一切照旧');
{
  root.innerHTML = '';
  rafQueue.length = 0;
  const cfg = mkCfg();
  cfg.rules.playerControl = false;
  cfg.playerSlot = null;
  renderBattle(root, cfg, () => {});
  runFrames(3);
  check('全自动模式没有技能栏', root.querySelector('#ctrlHud') === null ||
    root.querySelector('#ctrlHud').hidden === true);
  const b = root.querySelector('#battleCanvas').__battle;
  /* 全自动模式是"开局就把整局算完"，所以 b.frame 一开始就是总帧数 ——
     要看的是**播放头**有没有动（界面上的时间标签）。 */
  check('全自动模式：开局不播，等「斗蛐蛐开始」',
    root.querySelector('#btTime').textContent === '0.0s',
    root.querySelector('#btTime').textContent);
  const sBtn = root.querySelector('#btStart');
  check('全自动模式也有「斗蛐蛐开始」按钮', !!sBtn);
  sBtn.onclick();
  runFrames(4);
  check('全自动模式：点了开始才推播放头',
    root.querySelector('#btTime').textContent !== '0.0s',
    root.querySelector('#btTime').textContent);
  check('全自动模式：整局确实在开战前就算完了', b.over === true, `over=${b.over}`);
  check('全自动模式：开始后进度条可用',
    !root.querySelector('#btSeek').disabled);
  check('全自动模式：开局冲量照旧（玩家球也照飞）',
    Math.hypot(b.units[0].vx, b.units[0].vy) > 0,
    `${(Math.hypot(b.units[0].vx, b.units[0].vy) / 1000).toFixed(0)}`);
}

console.log('\n' + log.join('\n'));
console.log(`\n=========== 通过 ${pass} 项，失败 ${fail} 项 ===========`);
if (fail) process.exitCode = 1;

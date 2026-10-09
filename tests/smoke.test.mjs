/* ============================================================
   smoke.test.mjs — 前端界面真实渲染自检
   ------------------------------------------------------------
   用 linkedom 提供真实 DOM，把「图鉴 / 准备 / 战斗」三个界面
   各渲染一遍，并模拟点击关键按钮，确认页面真的能操作。
   运行：node tests/smoke.test.mjs
   ============================================================ */

import './lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { parseHTML } from 'linkedom';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const log = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; log.push(`  ✅ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; log.push(`  ❌ ${name}${detail ? '  — ' + detail : ''}`); }
}

/* linkedom 的坑：从 innerHTML 解析出来的 <input type="checkbox" checked>，
   `.checked` 是 undefined —— 它不把 checked 属性反射到属性上（disabled 反而会）。
   真实浏览器两者都会反射。所以测试统一用这两个助手读"勾没勾/禁没禁"，
   属性与属性值任一成立即算成立。 */
const isChecked = el => el.hasAttribute('checked') || el.checked === true;
const isDisabled = el => el.hasAttribute('disabled') || el.disabled === true;

console.log('=========== 前端界面自检（linkedom）===========\n');

/* ---------- 1. 建立浏览器环境 ---------- */
const { window, document } = parseHTML(`<!DOCTYPE html><html><body><div id="app"></div></body></html>`);
// canvas 2D 上下文桩件：记录调用次数，便于确认"确实画了东西"
const drawCalls = { n: 0 };
const ctxStub = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'canvas') return { width: 720, height: 440, clientWidth: 720, clientHeight: 440 };
    if (prop === 'createRadialGradient' || prop === 'createLinearGradient') {
      return () => ({ addColorStop() {} });
    }
    if (prop === 'measureText') return () => ({ width: 10 });
    return (...args) => { drawCalls.n++; void args; };
  },
  set() { return true; }
});

// 所有 canvas 元素都要能 getContext。
// 注意：innerHTML 解析出来的元素不会经过 document.createElement，
// 因此必须同时改写原型方法，否则图鉴/准备界面里的缩略图 canvas 拿不到上下文。
function patchCanvasProto() {
  const proto = window.HTMLCanvasElement && window.HTMLCanvasElement.prototype;
  if (!proto) return false;
  proto.getContext = () => ctxStub;
  return true;
}

const origCreate = document.createElement.bind(document);
document.createElement = (tag, ...rest) => {
  const el = origCreate(tag, ...rest);
  el.getContext = () => ctxStub;
  if (String(tag).toLowerCase() === 'canvas') {
    Object.defineProperty(el, 'clientWidth', { get: () => 720, configurable: true });
    Object.defineProperty(el, 'clientHeight', { get: () => 440, configurable: true });
  }
  return el;
};

// 关键：把原型上的 getContext 也换掉，覆盖 innerHTML 解析出来的 canvas
const protoPatched = patchCanvasProto();

globalThis.window = window;
globalThis.document = document;
globalThis.performance = globalThis.performance || { now: () => Date.now() };

// linkedom 的 location 不支持 hash 赋值，这里换成可用的桩件（界面靠 location.hash 做路由）
const locationStub = {
  _hash: '',
  get hash() { return this._hash; },
  set hash(v) { this._hash = String(v); },
  href: 'http://localhost/',
  pathname: '/',
  reload() {}
};
globalThis.location = locationStub;
window.location = locationStub;
window.devicePixelRatio = 1;
window.scrollTo = () => {};

// 捕获渲染循环回调，不真的递归，但允许我们手动跑几帧
const rafQueue = [];
window.requestAnimationFrame = fn => { rafQueue.push(fn); return rafQueue.length; };
globalThis.requestAnimationFrame = window.requestAnimationFrame;
const runFrames = (n = 3) => {
  for (let i = 0; i < n; i++) {
    const q = rafQueue.splice(0, rafQueue.length);
    for (const fn of q) fn(performance.now() + i * 16.7);
  }
};
/* 带**显式时间轴**的跑帧：rAF 的时间戳按固定步长单调递增。
   为什么需要它：上面的 runFrames 每次都用 performance.now()，
   在紧凑的测试循环里几乎不动 —— 而"抽技能动画"是按时间推进的，
   喂同一个时间戳它永远走不完。 */
let mockNow = 100000;
const runTimeline = (n, stepMs = 16.7) => {
  for (let i = 0; i < n; i++) {
    mockNow += stepMs;
    const q = rafQueue.splice(0, rafQueue.length);
    for (const fn of q) fn(mockNow);
  }
};

// linkedom 不提供 localStorage，这里补一个最小实现（准备界面靠它记住上次设置）
function makeStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    clear: () => m.clear(),
    get length() { return m.size; },
    key: i => [...m.keys()][i] ?? null
  };
}
const localStorageStub = makeStorage();
globalThis.localStorage = localStorageStub;
window.localStorage = localStorageStub;

const root = document.getElementById('app');

/* ---------- 2. 模块导入 ---------- */
console.log('【1】模块导入');
console.log(`  （canvas 原型已改写: ${protoPatched ? '是' : '否'}）`);
const mods = {};
for (const name of ['balls', 'arenas', 'skills', 'prefs', 'core', 'audio', 'balance', 'live-reload', 'asset-schema', 'ui-codex', 'ui-prepare', 'ui-battle', 'sketch', 'render']) {
  try { mods[name] = await import(`../js/${name}.js`); check(`${name}.js 导入成功`, true); }
  catch (e) { check(`${name}.js 导入成功`, false, e.message); }
}

/* ---------- 3. 图鉴 ---------- */
console.log('\n【2】图鉴界面');
try {
  mods['ui-codex'].renderCodex(root);
  const cards = root.querySelectorAll('.codex-card');
  check('图鉴渲染无异常', true);
  check('图鉴列出了所有小球', cards.length === mods.balls.SPECIES.length,
    `${cards.length} 张卡片 / ${mods.balls.SPECIES.length} 个球种`);
  const detail = root.querySelector('#cdDetail');
  check('右侧详情面板已填充', !!detail && detail.innerHTML.length > 50,
    detail ? `${detail.innerHTML.length} 字符` : '未找到');
  check('详情面板包含基础属性', !!detail && detail.innerHTML.includes('碰撞伤害'));

  /* 切到"技能测试球"，确认技能卡片真的有名字和说明（而不是两张空白卡）。 */
  const skillBall = mods.balls.SPECIES.find(s => s.skills && s.skills.length);
  if (skillBall) {
    const idx = mods.balls.SPECIES.indexOf(skillBall);
    cards[idx].onclick();
    const html = root.querySelector('#cdDetail').innerHTML;
    const names = skillBall.skills.map(id => mods.skills.getSkill(id).name);
    check('图鉴里技能卡片显示了技能名', names.every(n => html.includes(n)),
      names.join('、'));
    check('技能卡片不是空白（带触发方式）', html.includes('触发：'));
  } else {
    check('图鉴里技能卡片显示了技能名', false, '没有挂技能的小球，无法验证');
  }

  /* ---------- 简要 / 详细 技能描述切换 ----------
     每个技能有两套描述：desc = 作者给的官方措辞，descDetail = 展开数值的详细版。
     两个界面（图鉴 / 准备界面）共用 prefs 里的一份偏好。 */
  {
    const P = mods.prefs;
    P._resetPrefsCache();
    P.setSkillDetail(false);
    /* 拿晕彩验（它 7 个技能都写了两套描述） */
    const y = mods.balls.SPECIES_BY_ID.yuncai;
    const yIdx = mods.balls.SPECIES.indexOf(y);
    cards[yIdx].onclick();
    const briefHtml = root.querySelector('#cdDetail').innerHTML;
    const caiguang = mods.skills.getSkill('yuncai_caiguang');
    check('默认显示简要描述（作者措辞）',
      briefHtml.includes(caiguang.desc), caiguang.desc.slice(0, 22) + '…');

    /* 点"详细" */
    const seg = root.querySelector('#cdDescMode');
    check('图鉴里有 简要/详细 切换', !!seg && seg.querySelectorAll('button').length === 2);
    let switched = false;
    if (seg) {
      const btns = [...seg.querySelectorAll('button')];
      check('默认选中"简要"', btns[0].classList.contains('on'));
      btns[1].onclick();
      switched = true;
    }
    check('点"详细"后偏好被记下', switched && P.getSkillDetail() === true);
    const detailHtml = root.querySelector('#cdDetail').innerHTML;
    check('图鉴切到详细描述后显示的是展开版',
      detailHtml.includes('球与墙面的接触点') || detailHtml.includes(caiguang.descDetail.slice(0, 12)),
      caiguang.descDetail.slice(0, 26) + '…');
    check('详细描述确实比简要长', caiguang.descDetail.length > caiguang.desc.length,
      `${caiguang.desc.length} → ${caiguang.descDetail.length} 字`);

    /* 每个晕彩技能都必须两套都有 —— 少一套切过去就是空白 */
    const missing = y.skills.filter(id => {
      const sk = mods.skills.getSkill(id);
      return !sk || !sk.desc || !sk.descDetail;
    });
    check('晕彩 7 个技能都写了简要 + 详细两套描述', missing.length === 0,
      missing.length ? '缺少：' + missing.join('、') : `${y.skills.length} 个技能都有`);

    /* 偏好要持久化 */
    check('偏好写进了 localStorage', (() => {
      const raw = localStorage.getItem('ballBattle.prefs.v1');
      return !!raw && JSON.parse(raw).skillDetail === true;
    })());

    /* ---------- 作者定稿的"简要描述"要原样显示 ----------
       2026-10 作者把桃夭 5 个 + 缇娜 7 个技能的简要描述统一改写过一遍，
       这里的判据是"面板上显示的就是 desc 本身"（不是别的字段、也不做加工）——
       以后他再改文案，测试不会因为"文案变了"而红，只有"显示错字段"才会红。 */
    {
      /* ⚠ 上面刚把偏好切成"详细"，这里要先切回"简要" ——
         否则量到的是 descDetail（第一版就是这么假红的）。 */
      P.setSkillDetail(false);
      const cases = [
        ['taoyao', '映霞[荣]', mods.skills.getSkill('taoyao_rong').desc],
        ['tina', '公主传承3', mods.skills.getSkill('tina_p3').desc],
        ['jianqing', '水镜·魔力共鸣（攻击）', mods.skills.getSkill('jianqing_mirror_borrow').desc],
      ];
      let allShown = true, detail = '';
      for (const [speciesId, skillName, desc] of cases) {
        const idx = mods.balls.SPECIES.findIndex(s => s.id === speciesId);
        cards[idx].onclick();
        const html = root.querySelector('#cdDetail').innerHTML;
        if (!html.includes(desc)) { allShown = false; detail = `${skillName}: ${desc}`; }
        /* 技能名同样要"显示的就是 name 字段"——③ 这一轮刚刚改过名 */
        if (!html.includes(skillName)) { allShown = false; detail = `名字没显示：${skillName}`; }
      }
      check('图鉴简要模式显示的就是 desc 原文（桃夭 / 缇娜 / 见晴 各抽一个）', allShown, detail || '都对上了');
      const twelve = ['taoyao_rong', 'taoyao_ku', 'taoyao_aim', 'taoyao_chunjing', 'taoyao_top',
        'tina_suck', 'tina_bat', 'tina_shot', 'tina_scepter', 'tina_p1', 'tina_p2', 'tina_p3',
        'jianqing_mirror_def', 'jianqing_mirror_sword', 'jianqing_mirror_borrow',
        'jianqing_takeoff', 'jianqing_transform', 'jianqing_feather'];
      const bad = twelve.filter(id => {
        const sk = mods.skills.getSkill(id);
        return !sk || !sk.desc || !sk.descDetail || sk.descDetail.length <= sk.desc.length;
      });
      check('桃夭 5 + 缇娜 7 + 见晴 6 个技能都是"简要短、详细长"两套齐全', bad.length === 0,
        bad.length ? '有问题：' + bad.join('、') : `${twelve.length} 个都对`);
    }

    /* 换回简要，别影响后面的测试 */
    P._resetPrefsCache();
    P.setSkillDetail(false);
  }
  const back = root.querySelector('#cdBack');
  check('返回按钮存在', !!back);
  if (back) { back.onclick && back.onclick(); check('返回按钮可点击（无异常）', true); }
} catch (e) {
  check('图鉴渲染无异常', false, e.message + ' | ' + (e.stack || '').split('\n')[1]);
}

/* ---------- 4. 准备界面 ---------- */
console.log('\n【3】斗蛐蛐准备界面');
// 先注入一份存档，验证能否读回上次设置
localStorage.setItem('ballBattle.prepare.v1', JSON.stringify({
  teamCount: 3,
  teamSizes: [2, 2, 2, 3, 3, 3],
  // 第 1 队第 2 个用"测试球·技能型"：它是目前唯一带技能的球种，
  // 后面的技能装配测试需要一个有技能可选的球。
  species: [['test', 'test_skill'], ['test_heavy', 'test'], ['test_charge', 'test'], [], [], []],
  arenaId: 'rect',
  sizeScale: 0.6,
  rules: { ...mods.balls.DEFAULT_RULES, respawn: true, respawnDelay: 2, timeLimit: 60 },
  playerUnit: 0
}));

let startCfg = null;
try {
  mods['ui-prepare'].renderPrepare(root, cfg => { startCfg = cfg; });
  check('准备界面渲染无异常', true);

  // 队伍数量
  const segs = root.querySelectorAll('[data-n]');
  check('队伍数量选项齐全（2–6 方）', segs.length === 5, `找到 ${segs.length} 个选项`);
  check('读回了存档的队伍数量（3 方）',
    !!root.querySelector('#teamCountSeg') &&
    [...root.querySelectorAll('[data-n]')].some(b => b.classList.contains('on') && b.getAttribute('data-n') === '3'));

  // 场地
  const arenaCards = root.querySelectorAll('.arena-card');
  check('场地卡片全部渲染', arenaCards.length === mods.arenas.ARENAS.length,
    `${arenaCards.length} 个场地`);
  check('读回了存档的场地（方形竞技场）',
    !!root.querySelector('#arenaInfo') && root.querySelector('#arenaInfo').innerHTML.includes('方形'));

  // 队伍与小球选择器
  const teamBlocks = root.querySelectorAll('.team-block');
  check('按存档渲染了 3 个队伍配置块', teamBlocks.length === 3, `实际 ${teamBlocks.length}`);
  const selects = root.querySelectorAll('select');
  check('每队都有球种下拉框', selects.length >= 6, `共 ${selects.length} 个下拉框`);

  // 特殊选项
  const rulesHost = root.querySelector('#rulesHost');
  check('特殊选项区已渲染', !!rulesHost && rulesHost.innerHTML.length > 200);
  check('包含"玩家操控"选项', rulesHost.innerHTML.includes('由我操控其中一个小球'));
  check('包含"边界收缩"选项', rulesHost.innerHTML.includes('边界收缩'));
  check('包含"复活"选项', rulesHost.innerHTML.includes('阵亡后复活'));
  check('包含"同队互相伤害"选项', rulesHost.innerHTML.includes('同队伍之间也会互相伤害'));
  check('包含"比赛时长上限"选项', rulesHost.innerHTML.includes('比赛时长上限'));

  // 场地大小（默认 50%：小球尺寸正常时靠它提高交手频率）
  const sizeSlider = root.querySelector('#sizeScale');
  check('场地大小滑块存在', !!sizeSlider);
  check('读回了存档的场地大小（60%）',
    !!sizeSlider && Math.abs(Number(sizeSlider.value) - 0.6) < 1e-6,
    sizeSlider ? `滑块值 ${sizeSlider.value}` : '未找到');
  check('显示了场地大小百分比与交手频率换算',
    !!root.querySelector('#sizeVal') && root.querySelector('#sizeVal').textContent.includes('%'),
    root.querySelector('#sizeVal') ? root.querySelector('#sizeVal').textContent : '');

  // 汇总与开战
  check('汇总信息已生成', root.querySelector('#prepSummary').innerHTML.includes('对阵'));
  const startBtn = root.querySelector('#startBtn');
  check('开战按钮存在', !!startBtn);
  if (startBtn && startBtn.onclick) {
    startBtn.onclick();
    check('点击开战能生成配置', !!startCfg,
      startCfg ? `${startCfg.teams.length} 方 / ${startCfg.teams.reduce((s, t) => s + t.units.length, 0)} 球 / 场地 ${startCfg.arena.name}` : '未生成');
    if (startCfg) {
      check('配置里每队都有小球', startCfg.teams.every(t => t.units.length > 0));
      check('配置带上了场地对象', !!startCfg.arena && !!startCfg.arena.shape);
      check('配置带上了规则对象', !!startCfg.rules && startCfg.rules.timeLimit === 60);
      check('配置带上了场地大小', Math.abs((startCfg.sizeScale ?? 1) - 0.6) < 1e-6,
        `sizeScale=${startCfg.sizeScale}`);
      check('每个小球都有完整属性', startCfg.teams.every(t =>
        t.units.every(u => u.stats && u.stats.maxHp > 0 && typeof u.stats.melee === 'number')));
    }
  }

  // 按钮交互：加减队伍人数不应报错
  const plus = root.querySelector('[data-act=plus]');
  const minus = root.querySelector('[data-act=minus]');
  let interactOk = true;
  try { plus && plus.onclick && plus.onclick(); minus && minus.onclick && minus.onclick(); }
  catch (e) { interactOk = false; }
  check('增减参战数量的按钮可点击', interactOk);
} catch (e) {
  check('准备界面渲染无异常', false, e.message + ' | ' + (e.stack || '').split('\n')[1]);
}

/* ---------- 4b. 技能装配（准备界面） ----------
   每个小球单独挑技能带，上限 MAX_SKILLS_PER_UNIT。
   这一节要覆盖三件事：旧存档能不能兼容、UI 能不能改装配、上限管不管用。 */
console.log('\n【3b】技能装配');
{
  const B = mods.balls;
  const MAXS = B.MAX_SKILLS_PER_UNIT;
  /* 必须用这个局部变量接开战配置 —— 不能复用上面那节的 startCfg，
     那是另一次 renderPrepare 的回调写的，拿到的会是旧配置。 */
  let loadoutCfg = null;

  /* --- 旧存档兼容：上面注入的那份存档里没有 loadouts 字段 --- */
  try {
    mods['ui-prepare'].renderPrepare(root, cfg => { loadoutCfg = cfg; });
    const saved = JSON.parse(localStorage.getItem('ballBattle.prepare.v1'));
    check('旧存档没有 loadouts 字段也能读出默认装配',
      Array.isArray(saved.loadouts) && saved.loadouts[0].length > 0,
      `第 1 队装配：${JSON.stringify(saved.loadouts[0])}`);
    check('读回的装配里都是该球种真的有的技能',
      saved.species.every((arr, t) => arr.every((sid, i) =>
        (saved.loadouts[t][i] || []).every(id => (B.SPECIES_BY_ID[sid].skills || []).includes(id)))));
    check('读回的装配不超过上限',
      saved.loadouts.every(arr => arr.every(a => (a || []).length <= MAXS)));

    /* --- 技能按钮：数量和文案 --- */
    const btns = [...root.querySelectorAll('.unit-row .skill-btn')];
    check('每个小球都有技能按钮', btns.length === root.querySelectorAll('.unit-row').length,
      `${btns.length} 个按钮 / ${root.querySelectorAll('.unit-row').length} 行`);
    const withSkill = btns.find(b => /技能 \d+\/\d+/.test(b.textContent));
    check('技能按钮显示"技能 已装/可选"', !!withSkill,
      withSkill ? withSkill.textContent.trim() : btns.map(b => b.textContent.trim()).join(' | '));
    const noSkill = btns.find(b => b.textContent.trim() === '无技能');
    check('无技能的球种按钮显示"无技能"且不可点', !!noSkill && noSkill.disabled);

    /* --- 展开面板 --- */
    withSkill.onclick();
    const panel = root.querySelector('.unit-skills');
    check('点击技能按钮会展开装配面板', !!panel);
    if (panel) {
      const boxes = [...panel.querySelectorAll('input[data-skill]')];
      check('面板里列出了该球种的全部技能', boxes.length >= 2, `${boxes.length} 个勾选框`);
      check('已装配的技能是勾上的', boxes.filter(isChecked).length >= 1,
        `${boxes.filter(isChecked).length} 个已勾选`);

      /* --- 取消勾选后真的少一个 --- */
      const first = boxes.find(isChecked);
      const before = boxes.filter(isChecked).length;
      first.checked = false;                 // 模拟用户取消勾选
      first.onchange();
      const boxes2 = [...root.querySelector('.unit-skills').querySelectorAll('input[data-skill]')];
      check('取消勾选会真的从装配里去掉',
        boxes2.filter(isChecked).length === before - 1,
        `${before} -> ${boxes2.filter(isChecked).length}`);

      /* ---- 装配面板里的 简要 / 详细 切换（与图鉴共用同一份偏好）---- */
      mods.prefs._resetPrefsCache();
      mods.prefs.setSkillDetail(false);
      const seg2 = root.querySelector('[data-act=descmode]');
      check('装配面板里有 简要/详细 切换', !!seg2 && seg2.querySelectorAll('button').length === 2);
      if (seg2) {
        const sk0 = mods.skills.getSkill(mods.balls.SPECIES_BY_ID.test_skill.skills[0]);
        const briefPanel = root.querySelector('.unit-skills').innerHTML;
        check('装配面板默认显示简要描述', briefPanel.includes(sk0.desc),
          sk0.desc.slice(0, 20) + '…');
        [...seg2.querySelectorAll('button')][1].onclick();
        check('装配面板切到详细后偏好同步为 true', mods.prefs.getSkillDetail() === true);
        const detailPanel = root.querySelector('.unit-skills').innerHTML;
        check('装配面板切到详细后按 skillDesc 渲染',
          detailPanel.includes(mods.skills.skillDesc(sk0, true)),
          mods.skills.skillDesc(sk0, true).slice(0, 24) + '…');
        /* 测试球的两个技能没写详细版 —— 切到详细时必须**回退**成简要，
           不能变成空白（新技能可以只写一套描述）。 */
        check('没写详细版的技能会回退成简要版（不会空白）',
          !sk0.descDetail && mods.skills.skillDesc(sk0, true) === sk0.desc,
          sk0.id);
        /* 还原成简要，避免影响后面的断言 */
        mods.prefs.setSkillDetail(false);
      }
    }
  } catch (e) {
    check('技能装配界面可用', false, e.message + ' | ' + (e.stack || '').split('\n')[1]);
  }

  /* --- 上限：现成球种都只有 2 个技能，测不到"最多 3 个"。
         这里临时给技能球挂两个假技能，验证第 4 个勾不上，测完还原。 --- */
  try {
    const sp = B.SPECIES_BY_ID.test_skill;
    const backup = [...sp.skills];
    const fake = ['__t_extra1', '__t_extra2'];
    for (const id of fake) {
      sp.skills.push(id);
      mods.skills.SKILLS[id] = {
        id, name: '临时技能' + id.slice(-1), desc: '仅用于测试上限',
        trigger: { type: 'cooldown', cd: 99 }, run() { return false; },
      };
    }
    try {
      mods['ui-prepare'].renderPrepare(root, cfg => { loadoutCfg = cfg; });
      // 找到技能球那一行（它的按钮文案是 技能 n/4）
      const btn = [...root.querySelectorAll('.unit-row .skill-btn')].find(b => /\/4$/.test(b.textContent.trim()));
      check('临时注入后该球种有 4 个技能可选', !!btn, btn ? btn.textContent.trim() : '没找到');
      if (btn) {
        btn.onclick();
        const panel = root.querySelector('.unit-skills');
        // 先"全部"（只会装上 3 个），再看第 4 个是不是被禁用
        panel.querySelector('[data-act=all]').onclick();
        const boxes = [...root.querySelector('.unit-skills').querySelectorAll('input[data-skill]')];
        const checked = boxes.filter(isChecked);
        check(`"全部"最多也只装上 ${MAXS} 个`, checked.length === MAXS,
          `实际勾上 ${checked.length} 个 / 共 ${boxes.length} 个`);
        check('达到上限后其余勾选框被禁用（点不了第 4 个）',
          boxes.filter(isDisabled).length === boxes.length - MAXS,
          `禁用 ${boxes.filter(isDisabled).length} 个`);

        // 强行触发一个被禁用框的 onchange，也不该突破上限
        const locked = boxes.find(isDisabled);
        if (locked) {
          locked.disabled = false; locked.checked = true; locked.onchange();
          const after = [...root.querySelector('.unit-skills').querySelectorAll('input[data-skill]')]
            .filter(isChecked).length;
          check('绕过禁用状态也突破不了上限（引擎侧双保险）', after === MAXS,
            `实际 ${after} 个`);
        }

        /* --- 生成的战斗配置必须带上装配 --- */
        const savedSkills = JSON.parse(localStorage.getItem('ballBattle.prepare.v1'));
        const slotUnit = savedSkills.loadouts
          .flatMap((arr, t) => arr.map((sk, i) => ({ t, i, sk, sid: savedSkills.species[t][i] })))
          .find(u => u.sid === 'test_skill');
        check('存档里记下了每个球的装配', !!slotUnit && slotUnit.sk.length === MAXS,
          slotUnit ? JSON.stringify(slotUnit.sk) : '没找到技能球');

        root.querySelector('#startBtn').onclick();
        const made = loadoutCfg;
        const su = made && made.teams
          .flatMap(t => t.units)
          .find(u => u.stats && u.stats.speciesId === 'test_skill');
        check('开战时装配被带进战斗配置', !!su && su.stats.skills.length === MAXS,
          su ? `skills=${JSON.stringify(su.stats.skills)}` : '配置里没有技能球');
      }
    } finally {
      // 还原，别污染后面的测试
      sp.skills.length = 0;
      sp.skills.push(...backup);
      for (const id of fake) delete mods.skills.SKILLS[id];
    }
    check('临时技能已还原（不影响真实数据）',
      B.SPECIES_BY_ID.test_skill.skills.length === backup.length &&
      !mods.skills.SKILLS.__t_extra1);
  } catch (e) {
    check('技能上限验证', false, e.message + ' | ' + (e.stack || '').split('\n')[1]);
  }
}

/* ---------- 4b. 回归：老存档里被固化的"空装配" ----------
   真实事故：缇娜刚注册时技能表是空的（为了让球先进场试手感），
   defaultSkillsFor('tina') 当时返回空数组，而准备界面会把默认**固化**进存档。
   之后补上 7 个技能，存档里那个空数组依然生效 —— 玩家看到的就是
   "缇娜的技能全都没有特效"（其实是压根没发动）。
   这里注入一份那样的存档，验证迁移会把它还原成"跟随默认"。 */
{
  const slot = (sp) => ({ species: [[sp]], loadouts: [[[]]], teamSizes: [1, 1, 1, 1, 1, 1] });
  /* ① 有迁移标记缺失的老存档：空装配应被还原成默认 */
  localStorage.setItem('ballBattle.prepare.v1', JSON.stringify({
    teamCount: 2,
    teamSizes: [1, 1, 1, 1, 1, 1],
    species: [['tina'], ['test']],
    loadouts: [[[]], [[]]],          // ← 被固化的空装配
    arenaId: 'rect', sizeScale: 0.5,
    rules: { ...mods.balls.DEFAULT_RULES }, playerUnit: 0
  }));
  let cfg2 = null;
  try { mods['ui-prepare'].renderPrepare(root, c => { cfg2 = c; }); } catch (e) { /* 渲染失败不影响下面 */ }
  const migrated = JSON.parse(localStorage.getItem('ballBattle.prepare.v1'));
  check('老存档里的空装配被迁移成"跟随默认"',
    migrated && Array.isArray(migrated.loadouts) && migrated.loadouts[0][0] === null,
    JSON.stringify(migrated && migrated.loadouts && migrated.loadouts[0]));
  check('迁移记了标记（不会每次加载都重复抹掉用户的选择）',
    migrated && migrated.migrations && migrated.migrations.loadoutDefaults >= 2,
    JSON.stringify(migrated && migrated.migrations));

  /* ② 迁移之后：缇娜**真的会带默认的三个技能**（不是空） */
  const defTina = mods.balls.defaultSkillsFor('tina');
  check('缇娜的默认装配现在非空（事故的前提是它当时为空）',
    defTina.length === 3, defTina.join('、'));
  localStorage.setItem('ballBattle.prepare.v1', JSON.stringify({
    teamCount: 2,
    teamSizes: [1, 1, 1, 1, 1, 1],
    species: [['tina'], ['test']],
    loadouts: [[null], [null]],      // 迁移后的正常状态
    migrations: { loadoutDefaults: 2 },
    arenaId: 'rect', sizeScale: 0.5,
    rules: { ...mods.balls.DEFAULT_RULES }, playerUnit: 0
  }));
  let started = null;
  try {
    mods['ui-prepare'].renderPrepare(root, c => { started = c; });
    const btn = root.querySelector('#startBtn');
    if (btn && btn.onclick) btn.onclick();
  } catch (e) { /* 同上 */ }
  const units = started && started.teams && started.teams[0] && started.teams[0].units;
  const tinaStats = units && units.find(u => u.stats && u.stats.speciesId === 'tina');
  check('null 装配在开战时解析成默认的三个技能',
    !!tinaStats && Array.isArray(tinaStats.stats.skills) && tinaStats.stats.skills.length === 3,
    tinaStats ? String(tinaStats.stats.skills) : '没找到缇娜的战斗配置');
  /* ③ 用户**主动**清空仍然要生效（不能因为迁移把选择抹掉） */
  localStorage.setItem('ballBattle.prepare.v1', JSON.stringify({
    teamCount: 2,
    teamSizes: [1, 1, 1, 1, 1, 1],
    species: [['tina'], ['test']],
    loadouts: [[[]], [[]]],
    migrations: { loadoutDefaults: 2 },   // 已经迁移过了
    arenaId: 'rect', sizeScale: 0.5,
    rules: { ...mods.balls.DEFAULT_RULES }, playerUnit: 0
  }));
  let started2 = null;
  try {
    mods['ui-prepare'].renderPrepare(root, c => { started2 = c; });
    const btn = root.querySelector('#startBtn');
    if (btn && btn.onclick) btn.onclick();
  } catch (e) { /* 同上 */ }
  const u2 = started2 && started2.teams && started2.teams[0] && started2.teams[0].units;
  const t2 = u2 && u2.find(u => u.stats && u.stats.speciesId === 'tina');
  check('迁移之后用户主动清空的装配仍然生效（不会被反复还原）',
    !!t2 && Array.isArray(t2.stats.skills) && t2.stats.skills.length === 0,
    t2 ? String(t2.stats.skills) : '没找到缇娜的战斗配置');
}

/* ---------- 5. 战斗界面 ---------- */
console.log('\n【4】战斗界面');
try {
  const cfg = startCfg || {
    teams: [
      { units: [{ slot: 0, stats: mods.balls.makeUnitStats('test') }] },
      { units: [{ slot: 100, stats: mods.balls.makeUnitStats('test_heavy') }] }
    ],
    arena: mods.arenas.ARENAS[0],
    rules: { ...mods.balls.DEFAULT_RULES },
    playerSlot: null
  };
  drawCalls.n = 0;
  mods['ui-battle'].renderBattle(root, cfg, () => {});
  check('战斗界面渲染无异常', true);
  check('画布已创建', !!root.querySelector('#battleCanvas'));
  check('播放控件齐全（暂停/单步/倍速/进度条/跳到结果）',
    !!root.querySelector('#btPlay') && !!root.querySelector('#btStep') &&
    !!root.querySelector('#btStepBack') && !!root.querySelector('#speedSeg') &&
    !!root.querySelector('#btSeek') && !!root.querySelector('#btSkip'));
  check('HUD 开关存在（血条与资源条）', !!root.querySelector('#cbHud'));
  check('伤害飘字开关存在', !!root.querySelector('#cbDmg'));

  /* ---------- 音效控件 ----------
     无头环境里没有 AudioContext，audio 模块应当整体降级为空操作：
     控件照常存在、能点、不抛错。 */
  const cbSound = root.querySelector('#cbSound');
  const volSound = root.querySelector('#volSound');
  check('音效开关存在', !!cbSound);
  check('音量滑块存在', !!volSound);
  check('音效默认关闭（浏览器要求用户手势才能出声，不让玩家困惑）',
    !!cbSound && cbSound.checked === false);
  check('音量滑块默认 0.6', !!volSound && Math.abs(Number(volSound.value) - 0.6) < 1e-6,
    volSound ? volSound.value : '-');
  check('无 AudioContext 时 audio 模块降级为空操作',
    mods.audio.audio.supported === false);

  check('态势条已生成', root.querySelector('#hpStrip').childElementCount > 0,
    `${root.querySelector('#hpStrip').childElementCount} 支队伍`);
  check('战报区已生成', !!root.querySelector('#btLog'));

  // 真正跑几帧渲染循环，确认绘制管线通
  runFrames(5);
  check('画面确实被绘制（有 canvas 调用）', drawCalls.n > 0, `${drawCalls.n} 次绘制调用`);
  check('渲染循环持续推进播放头', rafQueue.length > 0, `待执行回调 ${rafQueue.length} 个`);

  // 关键交互
  let uiOk = true, uiErr = '';
  try {
    root.querySelector('#btPlay').onclick();
    root.querySelector('#btStep').onclick();
    root.querySelector('#btStepBack').onclick();
    root.querySelector('#btSkip').onclick();
    root.querySelector('#cbHud').onchange({ target: { checked: false } });
    root.querySelector('#cbDmg').onchange({ target: { checked: false } });
    root.querySelector('#cbSound').onchange({ target: { checked: true } });
    root.querySelector('#volSound').oninput({ target: { value: '0.3' } });
    root.querySelector('#cbSound').onchange({ target: { checked: false } });
    root.querySelector('#btSeek').oninput({ target: { value: '10' } });
  } catch (e) { uiOk = false; uiErr = e.message; }
  check('播放控制交互无异常', uiOk, uiErr);
  check('音效开关被记进了偏好',
    mods.prefs.getSoundEnabled() === false && Math.abs(mods.prefs.getSoundVolume() - 0.3) < 1e-6,
    `sound=${mods.prefs.getSoundEnabled()} vol=${mods.prefs.getSoundVolume()}`);
} catch (e) {
  check('战斗界面渲染无异常', false, e.message + ' | ' + (e.stack || '').split('\n')[1]);
}

/* ---------- 5.5 技能规则：无限火力 / 随机技能 / 详细设置 ---------- */
console.log('\n【5.5】技能规则与详细设置');
{
  const balls = mods.balls;
  const prefs = mods.prefs;
  const root2 = document.createElement('div');

  /* ---- 详细设置：默认收起，但里面的控件**仍然在 DOM 里** ---- */
  prefs.setDetailOpen(false);
  mods['ui-prepare'].renderPrepare(root2, () => {});
  check('详细设置默认收起', root2.querySelector('#detailPanel').style.display === 'none');
  check('收起时里面的控件仍然存在（只是看不见）',
    !!root2.querySelector('#speedScale') && !!root2.querySelector('#rPlayer') &&
    !!root2.querySelector('#spawnModeSeg'),
    '运动参数 / 特殊选项 / 开局方向都在面板里');
  root2.querySelector('#detailBtn').onclick();
  check('点一下「详细设置」就展开', root2.querySelector('#detailPanel').style.display === 'block');
  check('展开状态被记进偏好（来回切界面不会折回去）', prefs.getDetailOpen() === true);

  /* ---- 玩家操控：自定义按键面板（作者 2026-10） ----
     默认六个键：鼠标左键 / 鼠标右键 / E / 1 / 2 / 3；
     面板要把"哪个键 → 哪个技能"写出来，而且**和引擎同一份口径**
     （skills.js 的 manualSkillIds）。 */
  {
    prefs._resetPrefsCache();
    localStorage.setItem('ballBattle.prepare.v1', JSON.stringify({
      teamCount: 2, teamSizes: [1, 1, 1, 1, 1, 1],
      species: [['yuncai'], ['test']], loadouts: [[['yuncai_modan']], [null]],
      migrations: { loadoutDefaults: 2 },
      arenaId: 'rect', sizeScale: 0.5,
      rules: { ...balls.DEFAULT_RULES, playerControl: true },
      playerUnit: 0,
    }));
    mods['ui-prepare'].renderPrepare(root2, () => {});
    root2.querySelector('#detailBtn').onclick();     // 展开详细设置
    const keysHost = root2.querySelector('#keybindList');
    const btns = keysHost ? [...keysHost.querySelectorAll('[data-kb]')] : [];
    check('玩家操控：按键面板出现（默认 6 个键位）', btns.length === 6, `${btns.length} 个`);
    check('默认键位就是作者指定的那六个',
      btns.map(b => b.textContent.trim()).join('/') === '鼠标左键/鼠标右键/E/1/2/3',
      btns.map(b => b.textContent.trim()).join('/'));
    const mapText = root2.querySelector('#keybindMap').textContent;
    check('面板写出"哪个键 → 哪个技能"',
      mapText.includes('鼠标左键') && mapText.includes('魔弹'), mapText.slice(0, 60));
    /* 点一个键位再按新键 → 改键成功（模拟真实按键） */
    btns[2].onclick();
    check('点键位进入"按下新键"状态',
      root2.querySelectorAll('[data-kb]')[2].textContent.includes('按下新键'),
      root2.querySelectorAll('[data-kb]')[2].textContent.trim());
    const ev = new window.Event('keydown', { bubbles: true, cancelable: true });
    ev.code = 'KeyQ';
    window.dispatchEvent(ev);
    check('按 Q 之后第三个键位变成 Q',
      root2.querySelectorAll('[data-kb]')[2].textContent.trim() === 'Q',
      root2.querySelectorAll('[data-kb]')[2].textContent.trim());
    check('改键写进了偏好（跨界面/刷新都在）',
      prefs.getPlayerKeys()[2] === 'KeyQ', prefs.getPlayerKeys().join(','));
    root2.querySelector('#kbReset').onclick();
    check('「恢复默认」把六个键位还原',
      prefs.getPlayerKeys().join(',') === 'Mouse0,Mouse2,KeyE,Digit1,Digit2,Digit3',
      prefs.getPlayerKeys().join(','));
    /* 换成"一个主动技能都不带"的球 → 面板应当说明不需要按键（而不是空着） */
    localStorage.setItem('ballBattle.prepare.v1', JSON.stringify({
      teamCount: 2, teamSizes: [1, 1, 1, 1, 1, 1],
      species: [['yuncai'], ['test']], loadouts: [[[]], [null]],
      migrations: { loadoutDefaults: 2 },
      arenaId: 'rect', sizeScale: 0.5,
      rules: { ...balls.DEFAULT_RULES, playerControl: true },
      playerUnit: 0,
    }));
    mods['ui-prepare'].renderPrepare(root2, () => {});
    root2.querySelector('#detailBtn').onclick();
    check('不带主动技能时：面板说明"不需要按键"',
      /没有主动技能/.test(root2.querySelector('#keybindMap').textContent),
      root2.querySelector('#keybindMap').textContent.slice(0, 40));
  }

  /* ---- 无限火力（① 走「全部」按钮）---- */
  const yuncaiAll = balls.SPECIES_BY_ID.yuncai.skills.length;
  const unSaved = (over = {}) => JSON.stringify({
    teamCount: 2, teamSizes: [1, 1, 1, 1, 1, 1],
    species: [['yuncai'], ['test']], loadouts: [[null], [null]],
    migrations: { loadoutDefaults: 2 },
    arenaId: 'rect', sizeScale: 0.5,
    rules: { ...balls.DEFAULT_RULES, unlimitedSkills: true, ...over },
    playerUnit: 0
  });
  localStorage.setItem('ballBattle.prepare.v1', unSaved());
  let cfgUn = null;
  mods['ui-prepare'].renderPrepare(root2, c => { cfgUn = c; });
  root2.querySelector('.skill-btn').onclick();                       // 展开装配面板
  root2.querySelector('[data-act=all]').onclick();                   // 全部
  root2.querySelector('#startBtn').onclick();
  const unSkills = cfgUn && cfgUn.teams[0].units[0].stats.skills;
  check(`无限火力：能把 ${yuncaiAll} 个技能全带上（不再是 3 个）`,
    !!unSkills && unSkills.length === yuncaiAll,
    unSkills ? `${unSkills.length} 个：${unSkills.join(',')}` : '没拿到战斗配置');
  const unLocked = [...root2.querySelectorAll('.unit-skills input[data-skill]')].filter(cb => cb.disabled !== true);
  check('无限火力下没有"已达上限"的置灰（互斥除外）',
    unLocked.length === yuncaiAll, `${unLocked.length} 个可点`);

  /* ---- 无限火力（② 逐个勾选）——**这一条是补的回归** ----
     背景：上面那条走的是「全部」按钮，它一次就把整份装配写进存档，
     所以**测不出**"逐个点"这条路上的问题。作者实际就是这么点的，结果：
     点第 4 个 → 存档里进了 4 个 → 面板重绘时读回被截断的 3 个 →
     看起来"点了没用"，而且永远长不到第 5 个。
     根因是 equippedOf() / ensureSpecies() 调 normalizeSkills 时没传上限。
     所以这里**必须逐个点**，并且每一步都核对"面板显示的个数 = 存档的个数"。 */
  {
    localStorage.setItem('ballBattle.prepare.v1', unSaved());
    let cfgClick = null;
    mods['ui-prepare'].renderPrepare(root2, c => { cfgClick = c; });
    root2.querySelector('.skill-btn').onclick();
    const boxes = () => [...root2.querySelectorAll('.unit-skills input[data-skill]')];
    const onBoxes = () => boxes().filter(b => isChecked(b));
    const pool = boxes().length;
    check(`无限火力的技能池有 ${yuncaiAll} 个可选项`, pool === yuncaiAll, `${pool} 个`);
    check('默认装配是 3 个（跟着球种的默认走）',
      onBoxes().length === balls.MAX_SKILLS_PER_UNIT, `${onBoxes().length} 个`);

    const steps = [];
    let guard = 0;
    while (guard++ < pool + 2) {
      const next = boxes().find(b => !isChecked(b) && !b.disabled);
      if (!next) break;
      next.checked = true; next.setAttribute('checked', 'checked');
      next.onchange({ target: next });
      const saved = JSON.parse(localStorage.getItem('ballBattle.prepare.v1')).loadouts[0][0];
      steps.push({ shown: onBoxes().length, stored: Array.isArray(saved) ? saved.length : 0 });
    }
    check('逐个勾技能能一路点到 7 个（每次点完面板与存档个数一致）',
      steps.length === yuncaiAll - balls.MAX_SKILLS_PER_UNIT &&
      steps.every(s => s.shown === s.stored) &&
      steps[steps.length - 1].shown === yuncaiAll,
      steps.map(s => `${s.shown}/${s.stored}`).join(' → '));

    root2.querySelector('#startBtn').onclick();
    const got = cfgClick && cfgClick.teams[0].units[0].stats.skills;
    check(`逐个勾完再开战：交给引擎的也是 ${yuncaiAll} 个`,
      !!got && got.length === yuncaiAll, got ? `${got.length} 个` : '没拿到配置');

    /* 面板说 7 个、引擎也认 7 个 —— 这才是"真的带上了"。
       只看配置不看引擎的话，"界面显示装了 N 个、实际只跑 3 个"会溜过去。 */
    const built = new mods.core.Battle({
      teams: [{ units: [{ stats: { ...cfgClick.teams[0].units[0].stats } }] },
              { units: [{ stats: { ...cfgClick.teams[1].units[0].stats } }] }],
      arena: cfgClick.arena, sizeScale: cfgClick.sizeScale, rules: cfgClick.rules, seed: 5
    });
    check(`引擎真的按 ${yuncaiAll} 个技能建了单位（不是只认前 3 个）`,
      built.units[0].skills.length === yuncaiAll,
      `${built.units[0].skills.length} 个：${built.units[0].skills.join(',')}`);
  }

  /* ---- 关掉无限火力：超出的装配要收回到 3 个（否则界面 7 个、引擎只认 3 个） ---- */
  localStorage.setItem('ballBattle.prepare.v1', unSaved());
  mods['ui-prepare'].renderPrepare(root2, c => { cfgUn = c; });
  root2.querySelector('.skill-btn').onclick();
  root2.querySelector('[data-act=all]').onclick();
  check('（前置）关闭前确实是 7 个',
    JSON.parse(localStorage.getItem('ballBattle.prepare.v1')).loadouts[0][0].length === yuncaiAll);
  root2.querySelector('#rUnlimited').onchange({ target: { checked: false } });
  check('关掉无限火力后，存档立即收回 3 个',
    JSON.parse(localStorage.getItem('ballBattle.prepare.v1')).loadouts[0][0].length === balls.MAX_SKILLS_PER_UNIT,
    `${JSON.parse(localStorage.getItem('ballBattle.prepare.v1')).loadouts[0][0].length} 个`);
  /* 面板可能已经开着 —— 再点一次 `.skill-btn` 是"收起"，所以先判断（踩过：
     这一条最初报"0 个勾选"，实际是面板被收起来了，不是勾选丢了）。 */
  if (!root2.querySelector('.unit-skills')) root2.querySelector('.skill-btn').onclick();
  check('关掉之后面板也只剩 3 个勾选（界面与存档一致）',
    [...root2.querySelectorAll('.unit-skills input[data-skill]')].filter(isChecked).length === balls.MAX_SKILLS_PER_UNIT,
    `${[...root2.querySelectorAll('.unit-skills input[data-skill]')].filter(isChecked).length} 个`);

  /* ---- 随机技能：配置时不能选 ---- */
  localStorage.setItem('ballBattle.prepare.v1', JSON.stringify({
    teamCount: 2, teamSizes: [1, 1, 1, 1, 1, 1],
    species: [['yuncai'], ['test']], loadouts: [[null], [null]],
    migrations: { loadoutDefaults: 2 },
    arenaId: 'rect', sizeScale: 0.5,
    rules: { ...balls.DEFAULT_RULES, randomSkills: true },
    playerUnit: 0
  }));
  let cfgRnd = null;
  mods['ui-prepare'].renderPrepare(root2, c => { cfgRnd = c; });
  const rndBtn = root2.querySelector('.skill-btn');
  check('随机技能：装配按钮被禁用且写着"本局随机"',
    !!rndBtn && rndBtn.disabled === true && rndBtn.textContent.includes('本局随机'),
    rndBtn ? `"${rndBtn.textContent.trim()}" disabled=${rndBtn.disabled}` : '没有按钮');
  rndBtn.onclick && rndBtn.onclick();
  check('随机技能：点它也不会展开装配面板', !root2.querySelector('.unit-skills'));
  root2.querySelector('#startBtn').onclick();     // 别忘了真的开一次战才拿得到配置
  check('随机技能：规则传进了战斗配置',
    !!cfgRnd && cfgRnd.rules.randomSkills === true,
    cfgRnd ? `randomSkills=${cfgRnd.rules.randomSkills}` : '没拿到战斗配置');
}

/* ---------- 5.6 战前抽技能：三格老虎机 ---------- */
console.log('\n【5.6】战前抽技能动画');
{
  const root3 = document.createElement('div');
  const cfg = {
    teams: [
      { units: [{ slot: 0, stats: mods.balls.makeUnitStats('yuncai') }] },
      { units: [{ slot: 100, stats: mods.balls.makeUnitStats('tina') }] },
    ],
    arena: mods.arenas.ARENA_BY_ID.rect,
    rules: { ...mods.balls.DEFAULT_RULES, randomSkills: true, timeLimit: 30 },
    playerSlot: null,
    sizeScale: 1,
    seed: 20261008
  };
  /* 只在**开局就在场**的单位（第 0 帧快照里的球数）——
     整局是开战前算完的，战斗中途召唤的分身也在 battle.units 里，
     战前抽签不该给它们发牌（踩过：1v1 的两球抽签界面上出现了 4 张卡）。 */
  const startingFew = (b) => {
    const n = Math.floor((b.snapshots[0]?.data.length || 0) / mods.core.SNAP_STRIDE);
    return b.units.slice(0, n > 0 ? n : b.units.length);
  };
  let err = null;
  try {
    mods['ui-battle'].renderBattle(root3, cfg, () => {});
  } catch (e) { err = e.message; }
  check('随机技能的战斗界面渲染无异常', !err, err || '');

  const layer = root3.querySelector('#lotteryLayer');
  check('战前出现抽签层，覆盖在画布上', !!layer && layer.hidden === false);
  check('两颗球各三格转轮（每格一个技能）',
    root3.querySelectorAll('.reel').length === 6,
    `${root3.querySelectorAll('.reel').length} 格`);
  check('抽签层的背景就是画布那一层（.stage 包住 canvas 与它）',
    !!root3.querySelector('.stage > #battleCanvas') && !!root3.querySelector('.stage > #lotteryLayer'));

  /* 时间轴推进：第一格 0.9 秒停下、之后每 0.52 秒停一格。
     先推到"第一格刚停、第二格还在转"的时刻，验"依次停下"。 */
  runTimeline(58);                       // ≈0.97s
  const reels = [...root3.querySelectorAll('.reel')];
  const doneAt = reels.filter(r => r.dataset.stopped === '1').length;
  check('第一格先停、其余还在转（这就是"依次展示"）',
    doneAt >= 2 && doneAt < 6, `已停 ${doneAt} / 6 格`);

  /* 再推 2.5 秒：动画应当全部结束、层收起来，然后**停在「斗蛐蛐开始」**上
     （作者 2026-10 的要求：进战斗界面不立刻开打）。 */
  runTimeline(150);
  check('抽完自动收起抽签层', layer.hidden === true);
  const seek = root3.querySelector('#btSeek');
  const startLayer = root3.querySelector('#startLayer');
  check('抽完之后出现「斗蛐蛐开始」遮罩（还没开打）',
    !!startLayer && startLayer.classList.contains('show'), startLayer ? startLayer.className : '没有遮罩');
  check('没点开始之前播放头一动不动', Number(seek.value) === 0, `播放头 ${seek.value}`);
  root3.querySelector('#btStart').onclick();
  runTimeline(20);
  check('点「斗蛐蛐开始」之后战斗才真的开始推进（播放头向前走）',
    Number(seek.value) > 0, `播放头 ${seek.value}`);

  /* 抽到的必须是**这颗球自己的**技能，而且和引擎记录的是同一套。
     注意用 `.lottery-card` 逐张卡比：两张卡各有三格，
     直接取所有转轮的话顺序会被 DOM 顺序影响。
     对照物用**战报里的抽签记录**（引擎为这一局写的 skillDraw 事件）——
     不能在测试里另建一个 Battle 来比：界面的种子是 nextSeed() 现取的随机值，
     另建的那个用别的种子，抽到的自然不一样（第一版就是这么错的）。 */
  const cardNames = [...root3.querySelectorAll('.lottery-card')].map(card =>
    [...card.querySelectorAll('.reel')]
      .filter(r => r.dataset.stopped === '1')
      .map(r => (r.querySelector('span').textContent || '').trim()));
  const yuncaiNames = mods.balls.SPECIES_BY_ID.yuncai.skills
    .map(id => (mods.skills.getSkill(id) || {}).name);
  const tinaNames = mods.balls.SPECIES_BY_ID.tina.skills
    .map(id => (mods.skills.getSkill(id) || {}).name);
  check('每张卡三格、都停稳了',
    cardNames.length === 2 && cardNames.every(n => n.length === 3),
    cardNames.map(n => n.join('/')).join('  ||  '));
  check('转轮上显示的都是对应球种自己的技能',
    cardNames.length === 2 &&
    cardNames[0].every(n => yuncaiNames.includes(n)) &&
    cardNames[1].every(n => tinaNames.includes(n)),
    cardNames.map(n => n.join('/')).join('  ||  '));

  const drawLines = [...root3.querySelectorAll('#btLog div')]
    .map(d => d.textContent || '')
    .filter(t => t.includes('抽到：'))
    .map(t => t.split('抽到：')[1].trim().split('、'));
  check('战报里记下了抽签结果（拖进度条回 0 秒也看得到）',
    drawLines.length === 2, drawLines.map(l => l.join('/')).join('  ||  ') || '战报里没有抽签记录');
  check('界面显示的抽签结果 = 引擎记录的同一套（不是各抽各的）',
    JSON.stringify(cardNames) === JSON.stringify(drawLines),
    `界面 ${JSON.stringify(cardNames)} / 引擎 ${JSON.stringify(drawLines)}`);

  /* ---------- 抽签层必须**真的**藏起来 ----------
     踩过的坑：`.lottery-layer` 上写了 `display: flex`，而 `hidden` 属性
     靠浏览器默认样式 `[hidden]{display:none}` 生效 —— 作者样式优先级更高，
     于是 `layer.hidden = true` 完全没用，那块"90% 白纱 + 背景模糊"的层
     一直盖在战斗画面上。现象是**整个画面发白、发糊**，排查时还怀疑过辉光领域。
     linkedom 不做 CSS 计算，所以这里分两步守：
       ① 源码里有那条全局 `[hidden]` 规则（兜住所有同类写法）；
       ② 抽签层靠 `.show` 类显隐，收起时要摘掉它。 */
  {
    const cssRaw = readFileSync(new URL('../css/styles.css', import.meta.url), 'utf8');
    /* 先**剥掉注释**再查规则：文件开头的说明里正好引用了那段坏写法
       （`.lottery-layer { display: flex }`），不剥的话正则先命中注释，
       于是"修复其实已经做对了"却报失败（这一条我自己就先踩了一遍）。 */
    const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');
    check('CSS 里有全局 `[hidden]{display:none !important}`（否则 display 会压过 hidden）',
      /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/i.test(css),
      (css.match(/\[hidden\][^}]*\}/) || ['没找到'])[0].replace(/\s+/g, ' '));
    const rule = (css.match(/\.lottery-layer\s*\{[^}]*\}/) || [''])[0];
    check('抽签层默认是 display:none，只有加 .show 才显示',
      /display\s*:\s*none/i.test(rule) && /\.lottery-layer\.show\s*\{[^}]*display\s*:\s*flex/i.test(css),
      rule.replace(/\s+/g, ' ').slice(0, 80));
  }
  check('抽签跑完后抽签层被收起（hidden + 摘掉 show）',
    layer.hidden === true && !layer.classList.contains('show'),
    `hidden=${layer.hidden} show=${layer.classList.contains('show')}`);
}

/* ---------- 6. 画布几何一致性（防止画面被非均匀拉伸） ---------- */
console.log('\n【6】画布几何一致性');
{
  /* 踩过的坑：canvas 若只设 CSS width:100%，浏览器会把绘图缓冲区再拉伸一次，
     而 draw() 的比例是按缓冲区算的，两者不一致就会出现非均匀拉伸 ——
     表现为小球变形、血条被拉成怪异的矩形。
     另外画布高度必须贴合场地包围盒，否则半场会在上下留一大块空白，
     看起来像"战斗画面没显示全"。 */
  const { Renderer } = mods.render;
  const { WORLD_W } = mods.balls;

  const mkCtx = () => new Proxy({}, {
    get(_t, p) {
      if (p === 'canvas') return { width: 100, height: 100 };
      if (p === 'createRadialGradient' || p === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (p === 'measureText') return () => ({ width: 10 });
      return () => {};
    },
    set() { return true; }
  });

  const make = (arena, sizeScale, width) => {
    const cv = document.createElement('canvas');
    Object.defineProperty(cv, 'parentElement', { get: () => ({ clientWidth: width }), configurable: true });
    cv.getContext = () => mkCtx();
    const r = new Renderer(cv);
    r.dpr = 2;
    r.setArena(arena, sizeScale);
    return { r, cv };
  };

  for (const arena of mods.arenas.ARENAS) {
    for (const sizeScale of [0.5, 1.0]) {
      const scaled = mods.arenas.scaleArena(arena, sizeScale);
      const { r, cv } = make(scaled, sizeScale, 880);
      /* 等比的核心：横纵共用同一个 scale。
         缓冲区与 CSS 的比例天然相差一个 dpr 倍数（高清屏缓冲区更大），那是对的；
         要防的是"横纵比例不同"造成的拉伸。 */
      const scaleFromW = cv.width / r.boxW;
      const scaleFromH = cv.height / r.boxH;
      /* 相机把场地包围盒映射到整块画布：横纵必须共用同一个比例。
         缓冲区只能取整数像素，所以两者会有亚像素级差异（<0.6%），
         真正要防的是"横纵比例不同"造成的拉伸。 */
      const uniform = Math.abs(scaleFromW - scaleFromH) / scaleFromW < 0.006;
      const key = `${arena.name}/${Math.round(sizeScale * 100)}%`;
      check(`画布等比不失真 ${key}`, uniform,
        uniform ? `scale=${scaleFromW.toFixed(4)}` : `横 ${scaleFromW.toFixed(4)} vs 纵 ${scaleFromH.toFixed(4)}`);
    }
  }

  /* 相机取景的正确性：场地应当铺满画布宽度，且在画布内居中。
     半场与全场的画布"形状"相同（都是场地的形状），但半场时坐标系更小，
     同一个世界尺寸会占更多像素 —— 这正是"半场看起来更大"的原因。 */
  const rect = mods.arenas.ARENA_BY_ID['rect'];
  {
    /* make() 返回 { r, cv }：断言要同时看渲染器状态和缓冲区尺寸 */
    const { r: full, cv: fullCv } = make(rect, 1.0, 880);
    const { r: half, cv: halfCv } = make(mods.arenas.scaleArena(rect, 0.5), 0.5, 880);
    /* 判据必须落在**绘图缓冲区**上，不是 CSS 宽度。
       踩过：这里原来比的是 camScale × boxW ≈ cssW —— 按构造必然成立，
       于是 dpr=2 时"场地只铺满画布一半"这个 bug 一路绿灯放行，
       直到作者在 135% 缩放的机器上肉眼发现"战场铺不满画布"。
       draw() 在缓冲区坐标系上做 ctx.scale()，所以唯一有意义的断言是
       "场地包围盒正好铺满 cv.width × cv.height"。 */
    const fullFit = Math.abs(full.camScale * full.boxW - fullCv.width) < 2;
    const halfFit = Math.abs(half.camScale * half.boxW - halfCv.width) < 2;
    check('相机把场地精确铺满画布缓冲区（不是 CSS 宽度）', fullFit && halfFit,
      `全场 ${(full.camScale * full.boxW).toFixed(0)}/${fullCv.width}px 缓冲区，半场 ${(half.camScale * half.boxW).toFixed(0)}/${halfCv.width}px`);
    const fullH = Math.abs(full.camScale * full.boxH - fullCv.height) < 2;
    const halfH = Math.abs(half.camScale * half.boxH - halfCv.height) < 2;
    check('纵向同样铺满缓冲区（右边和下边都不留空白）', fullH && halfH,
      `全场 ${(full.camScale * full.boxH).toFixed(0)}/${fullCv.height}px，半场 ${(half.camScale * half.boxH).toFixed(0)}/${halfCv.height}px`);
    // 半场的世界尺寸只有一半，因此同样画布宽度下 scale 更大 => 球看起来更大
    check('半场时相机更贴近（同样屏幕宽度下世界更小）', half.camScale > full.camScale * 1.5,
      `scale ${full.camScale.toFixed(3)} -> ${half.camScale.toFixed(3)}`);
    // 相机原点应当精确贴合场地包围盒左上角（场地贴边铺满、不留额外边距）
    const b = mods.arenas.arenaBounds(mods.arenas.scaleArena(rect, 0.5).shape);
    const exact = Math.abs(half.camX - b.minX) < 1 && Math.abs(half.camY - b.minY) < 1;
    check('相机原点精确贴合场地包围盒（不留额外边距）', exact,
      `cam=(${half.camX.toFixed(1)},${half.camY.toFixed(1)}) 场地 min=(${b.minX},${b.minY})`);
    // 场地边缘必须恰好落在画布边缘上
    const flushRight = Math.abs((b.maxX - b.minX) - half.boxW) < 2;
    const flushBottom = Math.abs((b.maxY - b.minY) - half.boxH) < 2;
    check('场地边缘与画布边缘对齐', flushRight && flushBottom,
      `场地 ${b.maxX - b.minX}×${b.maxY - b.minY}  视窗 ${half.boxW.toFixed(1)}×${half.boxH.toFixed(1)}`);
  }

  /* 分工必须清晰：CSS 管显示尺寸（宽度填满 + aspect-ratio 推高度），
     JS 只管绘图缓冲区。绝不能一边用 width:100%、一边又让 JS 写死 CSS 宽高 ——
     两套尺寸互相打架，实测出现过"设置缩放 2.317、渲染实际用 1.0"的矛盾。 */
  const cssText = readFileSync(new URL('../css/styles.css', import.meta.url), 'utf8');
  const battleRule = cssText.match(/#battleCanvas\s*\{[^}]*\}/);
  const fillsWidth = battleRule && /(^|[^-])width\s*:\s*100%/.test(battleRule[0]);
  check('CSS 让画布宽度填满容器', !!fillsWidth,
    battleRule ? battleRule[0].replace(/\s+/g, ' ').slice(0, 80) : '未找到规则');
  const rjs = readFileSync(new URL('../js/render.js', import.meta.url), 'utf8');
  /* 关键分工：**宽度**始终由 CSS（width:100%）决定，JS 绝不写 style.width，
     否则两套尺寸会互相打架。高度由 JS 按宽度与场地比例算出并写死 ——
     实测依赖 aspect-ratio 时浏览器不总会算出预期高度，画布偏高、
     场地只占上半部分。 */
  const writesWidth = /cv\.style\.width\s*=\s*[^;]*(px|\d)/.test(rjs);
  check('JS 不写画布宽度（宽度交给 CSS）', !writesWidth,
    writesWidth ? '仍在写 style.width' : '宽度由 CSS 决定');
  const writesHeight = /cv\.style\.height\s*=\s*dispH/.test(rjs);
  check('JS 按宽度算出的高度写死（不依赖 aspect-ratio）', writesHeight,
    writesHeight ? '由单一数据源 clientWidth 推导' : '未找到');
  check('JS 仍设置 aspect-ratio 作为兜底', /style\.aspectRatio/.test(rjs));

  /* 防回退：画布尺寸必须在"布局完成后"重算，而且要有自愈机制。
     实测曾出现 resize 次数为 0 —— 初始化时布局还没完成、量到旧宽度，
     之后再也不重算，于是相机按旧宽度取景，场地只占画布一小块。 */
  const bjs = readFileSync(new URL('../js/ui-battle.js', import.meta.url), 'utf8');
  check('用 ResizeObserver 盯住画布自身', /ro\.observe\(canvas\)/.test(bjs));
  check('渲染循环里有宽度自愈检查', /_?sizeCheck|clientWidth/.test(bjs) && /renderer\.resize\(\)/.test(bjs));
  check('resize 读的是画布内容宽度（不含边框）', /cv\.clientWidth/.test(rjs));
}
/* ---------- 7. 数据层完整性 ---------- */
console.log('\n【7】数据层');
{
  const { ARENAS } = mods.arenas;
  /* 作者 2026-10 要求"场地只保留几个几何图形的基本场地"，
     所以数量上限跟着改了 —— 但**下限**仍要守住：
     不能只剩一个（选择器就没意义了），也不能混进重复 id。 */
  check('场地是精简后的几何场地（4~10 个）',
    ARENAS.length >= 4 && ARENAS.length <= 10, `${ARENAS.length} 个`);
  check('场地字段完整', ARENAS.every(a => a.id && a.name && a.shape && Array.isArray(a.zones)));
  check('场地 id 不重复', new Set(ARENAS.map(a => a.id)).size === ARENAS.length);
  /* 「启用场地自带边界收缩」这条设置需要一个会收缩的场地才有意义 ——
     没有的话它就是个勾了没反应的死开关。 */
  const shrinkArenas = ARENAS.filter(a => a.effects && a.effects.shrink);
  check('保留了一个会收缩的场地（否则"边界收缩"设置是死开关）',
    shrinkArenas.length > 0, shrinkArenas.map(a => a.name).join('、') || '一个都没有');

  const { SPECIES, SPECIES_BY_ID } = mods.balls;
  /* 这条测的是"基础测试球"（test），不是 SPECIES[0]。
     SPECIES[0] 现在是正式角色晕彩（1500 血 / 7 个技能），
     拿它当"无技能测试球"来断言是早期写下的，早就该改。 */
  const t = SPECIES_BY_ID.test;
  check('测试球符合需求：无技能 / 1000 血 / 碰撞 100',
    t.hp === 1000 && t.melee === 100 && t.skills.length === 0,
    `${t.name}: HP ${t.hp} / 伤害 ${t.melee} / 技能 ${t.skills.length}`);
  /* 晕彩的正式数值（作者 2026-10 设计） */
  const y = SPECIES_BY_ID.yuncai;
  check('晕彩：1500 血 / 速度 120 / 没有碰撞伤害',
    y.hp === 1500 && y.speed === 120 && y.melee === 0,
    `HP ${y.hp} / 速度 ${y.speed} / 碰撞 ${y.melee}`);
  check('晕彩有 7 个技能，默认装配取前 3 个',
    y.skills.length === 7 && mods.balls.defaultSkillsFor('yuncai').length === 3,
    `${y.skills.length} 个技能 → 默认 ${mods.balls.defaultSkillsFor('yuncai').join('、')}`);
  check('晕彩有开华形态的第二张贴图', !!y.stickerBloom && !!y.stickerBloom.src, y.stickerBloom && y.stickerBloom.src);
  /* 桃夭的正式数值（作者 2026-10 设计） */
  const ty = SPECIES_BY_ID.taoyao;
  check('桃夭：1750 血 / 速度 120 / 碰撞 66',
    ty.hp === 1750 && ty.speed === 120 && ty.melee === 66,
    `HP ${ty.hp} / 速度 ${ty.speed} / 碰撞 ${ty.melee}`);
  check('桃夭有 5 个技能，默认装配取 3 个',
    ty.skills.length === 5 && mods.balls.defaultSkillsFor('taoyao').length === 3,
    `${ty.skills.length} 个技能 → 默认 ${mods.balls.defaultSkillsFor('taoyao').join('、')}`);
  check('桃夭有贴图', !!ty.sticker && !!ty.sticker.src, ty.sticker && ty.sticker.src);
  /* ---------- 手持物件（弓）：动作动画的载体 ----------
     这几条守的是"弓一定看得见"这个最低要求 ——
     弓画在球外面，只要弓太小，它就会被球整个盖住，
     而这种事在别处不会报错、只有进游戏才发现"弓没了"。 */
  /* 桃夭有**两把外观完全不同的弓**（映霞[荣] 粉弓 / 映霞[枯] 墨色花枝弓），
     所以 bow 是 { kindArt, arts } 而不是单独一套。
     下面这些断言对**每一套**都跑一遍 —— 只测第一套的话，
     枯那一套的几何量写错了根本发现不了。 */
  const bowArts = (ty.bow && ty.bow.arts) || (ty.bow ? [ty.bow] : []);
  check('桃夭的弓有两套美术（荣 / 枯 各一把）',
    bowArts.length === 2, `${bowArts.length} 套`);
  check('每套都有 平时 / 拉弓 / 箭矢 三张图',
    bowArts.every(a => a.idle && a.draw && a.arrow),
    bowArts.map(a => (a.idle || '?').split('/').pop()).join('、'));
  check('两套美术的图**不重复**（确实是两把不同的弓）',
    new Set(bowArts.map(a => a.idle)).size === bowArts.length,
    bowArts.map(a => (a.idle || '?').split('/').pop()).join(' vs '));
  /* castKind → 美术套 的映射：0/1（荣普通/五连发）→ 第 1 套，2（枯）→ 第 2 套。
     技能侧 SKILL_KU.castKind() 返回 2，两边必须对上，
     否则枯会顶着荣的粉弓射黑白箭。 */
  const kindArt = ty.bow && ty.bow.kindArt;
  check('castKind → 美术套 的映射对得上（0/1→荣，2→枯）',
    Array.isArray(kindArt) && kindArt[0] === 0 && kindArt[1] === 0 && kindArt[2] === 1,
    JSON.stringify(kindArt));
  const kuSkill = mods.skills.getSkill('taoyao_ku');
  check('枯声明的 castKind 落在映射表里（= 2，指向第二套）',
    typeof kuSkill.castKind === 'function' && kuSkill.castKind({ flags: {} }) === 2,
    String(typeof kuSkill.castKind === 'function' ? kuSkill.castKind({ flags: {} }) : '没实现'));
  check('荣的 castKind 只取 0 / 1（不会误指到枯那一套）',
    [0, 1].includes(mods.skills.getSkill('taoyao_rong').castKind({ flags: { rongShots: 0 } })) &&
    [0, 1].includes(mods.skills.getSkill('taoyao_rong').castKind({ flags: { rongShots: 5 } })));

  bowArts.forEach((art, i) => {
    const who = `第 ${i + 1} 套`;
    check(`${who}：锚点 / 尺寸 / 搭箭点 / 箭长都是有限数`,
      [art.anchor.x, art.anchor.y, art.nock.x, art.nock.y]
        .every(v => Number.isFinite(v) && v >= 0 && v <= 1) &&
      Number.isFinite(art.bowH) && art.bowH > 0 &&
      Number.isFinite(art.arrowLenFrac) && art.arrowLenFrac > 0,
      `anchor(${art.anchor.x}, ${art.anchor.y}) bowH ${art.bowH} 箭长 ${art.arrowLenFrac}`);
    /* 锚点的 y 必须落在搭箭点的高度上 —— 否则箭会从球的旁边射出去，
       而不是从球身上射出去。这是"球 = 射手"的几何前提。 */
    check(`${who}：球心（anchor.y）与搭箭点（nock.y）同高`,
      Math.abs(art.anchor.y - art.nock.y) < 0.01,
      `anchor.y ${art.anchor.y} vs nock.y ${art.nock.y}`);
    check(`${who}：射箭那一帧的状态有定义（shot 留空 = 回退成平时）`,
      art.shot === null || typeof art.shot === 'string',
      art.shot === null ? 'null（用 idle）' : String(art.shot));
  });
  check('每一套弓都比球高（否则弓臂伸不出球外，等于没有）',
    bowArts.length > 0 && bowArts.every(a => a.bowH > ty.r * 2),
    bowArts.map(a => a.bowH).join(' / ') + ` vs 球直径 ${ty.r * 2}`);
  check('makeUnitStats 把弓带进了单位属性', !!mods.balls.makeUnitStats('taoyao').bow);
  check('没配弓的球种不受影响', !mods.balls.makeUnitStats('test').bow);
  /* "拉弓"是射出**之前**的动作，所以引擎必须提前告诉渲染层。
     没装带 windup 的技能时这两个字段恒为 0 —— 见 tests/diag/bow.mjs。 */
  const aiming = ['taoyao_rong', 'taoyao_ku'].every(id => {
    const k = mods.skills.getSkill(id);
    return k && k.aims === true && k.windup > 0;
  });
  check('映霞两式都声明了 aims + windup（引擎据此算瞄准角与拉弓进度）', aiming,
    '荣 / 枯');
  check('SNAP_STRIDE 与文档一致（castP / aimAngle / castKind / 水镜两色 / 状态位 / 长剑朝向各占一位）',
    mods.core.SNAP_STRIDE === 20, String(mods.core.SNAP_STRIDE));

  /* ---------- 见晴（球种 4 · 白水仙） ---------- */
  const jq = SPECIES_BY_ID.jianqing;
  check('见晴：1500 血 / 速度 120 / 碰撞 30 / 标准体型 r=16',
    jq && jq.hp === 1500 && jq.speed === 120 && jq.melee === 30 && jq.r === 16,
    jq ? `HP ${jq.hp} / 速度 ${jq.speed} / 碰撞 ${jq.melee} / r ${jq.r}` : '没有这个球种');
  check('见晴有 6 个技能，默认装配取前 3 个（三面水镜）',
    jq.skills.length === 6 && mods.balls.defaultSkillsFor('jianqing').length === 3,
    `${jq.skills.length} 个 → 默认 ${mods.balls.defaultSkillsFor('jianqing').join('、')}`);
  check('见晴六个技能全部注册且互不互斥（作者确认可以分开装配）',
    jq.skills.every(id => !!mods.skills.getSkill(id) && !mods.skills.getSkill(id).group),
    jq.skills.join('、'));
  check('见晴带「水镜护盾」资源条（上限 300）',
    !!jq.resource && jq.resource.id === 'mirror' && jq.resource.max === 300,
    jq.resource ? `${jq.resource.name} ${jq.resource.max}` : '无');
  check('见晴有小球贴图（作者给的「魔法少女[白水仙]（贴图）」）',
    !!jq.sticker && jq.sticker.src === 'assets/characters/jianqing_ball.png',
    jq.sticker ? jq.sticker.src : 'sticker = null');
  check('见晴的贴图文件真的在磁盘上', (() => {
    try { readFileSync(jq.sticker.src); return true; } catch { return false; }
  })(), jq.sticker ? jq.sticker.src : '-');
  /* 三个水镜必须各有自己的颜色状态：快照里给了两个颜色位 + 一个状态位 */
  check('快照为"两面水镜同时开着"留了两个颜色位 + 一个状态位（后来又加了长剑朝向位）',
    mods.core.SNAP_STRIDE === 20, String(mods.core.SNAP_STRIDE));

  /* ---------- 缇娜（球种 3） ---------- */
  const tn = SPECIES_BY_ID.tina;
  check('缇娜：1500 血 / 速度 125 / 碰撞 50',
    tn.hp === 1500 && tn.speed === 125 && tn.melee === 50,
    `HP ${tn.hp} / 速度 ${tn.speed} / 碰撞 ${tn.melee}`);
  check('缇娜有 7 个技能，默认装配取 3 个',
    tn.skills.length === 7 && mods.balls.defaultSkillsFor('tina').length === 3,
    `${tn.skills.length} 个 → 默认 ${mods.balls.defaultSkillsFor('tina').join('、')}`);
  check('缇娜有球体贴图', !!tn.sticker && !!tn.sticker.src, tn.sticker && tn.sticker.src);
  /* 魔力计数：由蝙蝠返回时逐点积攒，不是随时间自动涨 */
  check('缇娜带「魔力」资源条，上限 5',
    !!tn.resource && tn.resource.max === 5 && tn.resource.gainPerSec === 0,
    tn.resource ? `${tn.resource.name} ${tn.resource.max}（gainPerSec ${tn.resource.gainPerSec}）` : '无');
  /* ⑤⑥⑦ 三个「公主传承」互斥 —— 作者确认过"三选一"。
     这条是**通用不变量**（遍历全部球种的互斥组）之外的单点补充：
     它确保这三个确实被归到同一组，而不是各成一个组。
     注意这里直接用 mods.skills.xxx：下面的解构声明在文件更靠后的位置，
     在这里用会踩 const 的暂时性死区。 */
  check('三个「公主传承」同属 princess 互斥组',
    ['tina_p1', 'tina_p2', 'tina_p3'].every(id => mods.skills.skillGroup(id) === 'princess'),
    ['tina_p1', 'tina_p2', 'tina_p3'].map(id => mods.skills.skillGroup(id)).join('/'));
  check('同时装三个传承时只留下一个',
    mods.skills.resolveLoadout(['tina_p1', 'tina_p2', 'tina_p3']).length === 1);
  /* 权杖与吸血习性的联动（作者："+15 不影响吸血习性的碰撞伤害"）是纯数值关系，
     放在诊断里定量测（tests/diag/tina.mjs）—— 那里能真的建一局来比。 */
  check('小球字段完整', SPECIES.every(s => s.id && s.name && s.color));
  const res = SPECIES.filter(s => s.resource);
  check('存在带特殊资源的小球（验证血条下方资源条）', res.length > 0, res.map(s => s.name).join('、'));

  /* 技能引用必须能在注册表里查到。
     以前图鉴把 SPECIES.skills 里的字符串 id 直接当对象用（s.name / s.desc），
     卡片渲染成空白 —— 数据没错，是取值方式错了。
     这里同时守住"id 能解析"和"名字/说明都非空"。 */
  const { getSkill, SKILLS } = mods.skills;
  const refs = SPECIES.flatMap(s => (s.skills || []).map(id => ({ sp: s, id })));
  const missing = refs.filter(r => !getSkill(r.id));
  check('所有小球的技能 id 都能在注册表里解析', missing.length === 0,
    missing.length ? missing.map(r => `${r.sp.name}→${r.id}`).join('、') : `${refs.length} 处引用`);
  const blank = refs.filter(r => { const k = getSkill(r.id); return k && (!k.name || !k.desc); });
  check('技能都有名字与说明（图鉴卡片不会空白）', blank.length === 0,
    blank.length ? blank.map(r => r.id).join('、') : `${Object.keys(SKILLS).length} 个技能`);
  const badTrigger = Object.values(SKILLS).filter(k =>
    !k.trigger || !['cooldown', 'onWall', 'onHit', 'onHpBelow', 'onHits', 'passive'].includes(k.trigger.type));
  check('技能的触发方式合法', badTrigger.length === 0,
    badTrigger.map(k => k.id).join('、') || '全部合法');
  /* 声明了 passive 触发方式的技能必须真的实现 passive()，
     否则它会是一个"装了但什么都不做"的空技能。 */
  const fakePassive = Object.values(SKILLS).filter(k =>
    k.trigger && k.trigger.type === 'passive' && typeof k.passive !== 'function');
  check('被动技能都实现了 passive()', fakePassive.length === 0,
    fakePassive.map(k => k.id).join('、') || '全部有实现');
  /* ---------- 通用不变量：弹道半径的单位 ----------
     弹道的 r 是**定点数**（要乘 SCALE），但技能里写起来很容易顺手写成
     "世界单位的那个数"。写漏了不会报错：半径变成 0.005 世界单位，
     画面上是一个亚像素点（作者的原话是"看不到特效"），碰撞也几乎撞不到。
     实测缇娜的蝙蝠和霰弹都栽在这一个乘号上。
     与其给每个技能单独写一条断言，不如**遍历所有球种**跑一局、
     检查每一枚出现过的弹道：以后谁再写漏，这里立刻变红。 */
  {
    const SCALE_V = mods.balls.SCALE;
    const badR = [];
    /* 贴图弹道另记两份：条目本身合不合法（spriteLen），以及用到的图在不在磁盘上。
       图在循环里只登记、跑完再统一读一次 —— 每帧读几百次文件会把自检拖垮。 */
    const badSpr = [];
    const spriteSrcs = new Map();
    for (const sp of SPECIES) {
      if (!sp.skills || !sp.skills.length) continue;
      let b = null;
      try {
        b = new mods.core.Battle({
          teams: [
            { units: [{ stats: { ...mods.balls.makeUnitStats(sp.id) } }] },
            { units: [{ stats: { ...mods.balls.makeUnitStats('test') } }] },
          ],
          arena: ARENAS.find(a => a.id === 'rect') || ARENAS[0],
          sizeScale: 1,
          rules: { ...mods.balls.DEFAULT_RULES, timeLimit: 4 },
          seed: 11,
        });
      } catch { continue; }
      for (let i = 0; i < 260 && !b.over; i++) {
        b.step();
        for (const pr of b.projectiles) {
          const rw = pr.r / SCALE_V;
          if (!(rw >= 1 && rw <= 40)) {
            badR.push(`${sp.name}/${pr.tag || '?'}: r=${rw}`);
          }
          /* 宽度同理：激光/光柱的 w 是**世界单位**，也不该是天文数字或 0 */
          if (pr.w != null && !(pr.w > 0 && pr.w <= 200)) {
            badR.push(`${sp.name}/${pr.tag || '?'}: w=${pr.w}`);
          }
          /* ---------- 通用不变量：贴图弹道的 spriteLen + 光晕色 + 呼吸开关 + 偏移 ----------
             给了图就必须同时给长度：渲染层在 len <= 0 时会退回 r*6，
             那等于"配了图但尺寸没配"，画面大小会随半径悄悄漂。
             必须给**光晕色**（每种弹道都有一圈对应颜色的柔光）：漏了的话
             那一枚就是"光秃秃一张图"，而画面上少一圈光不会报错。
             必须给**显式的呼吸开关**（作者只让蝙蝠呼吸）：这个字段要是没被
             引擎带进调色板，渲染层会当成"不呼吸"—— 于是蝙蝠静默地不呼吸了。
             必须给**数值型偏移**：编辑器里拖判定圆改的就是它，
             漏了这个管道就变成"界面能拖、游戏里没反应"。
             图还必须真的在磁盘上 —— 配置写错路径时运行时不报错，
             只是静默变回程序化光点，属于最难归因的一类问题。 */
          if (pr.spriteIdx >= 0) {
            const pal = (b.projSpritePalette || [])[pr.spriteIdx];
            if (!pal || !(pal.len > 0)) {
              badSpr.push(`${sp.name}/${pr.tag || '?'}: spriteLen=${pal ? pal.len : '无调色板条目'}`);
            } else if (!/^#[0-9a-f]{6}$/i.test(String(pal.glow || ''))) {
              badSpr.push(`${sp.name}/${pr.tag || '?'}: 光晕色=${pal.glow}`);
            } else if (typeof pal.pulse !== 'boolean') {
              badSpr.push(`${sp.name}/${pr.tag || '?'}: 呼吸开关=${typeof pal.pulse}`);
            } else if (typeof pal.offX !== 'number' || typeof pal.offY !== 'number') {
              badSpr.push(`${sp.name}/${pr.tag || '?'}: 偏移=${typeof pal.offX}/${typeof pal.offY}`);
            } else {
              spriteSrcs.set(pal.src, `${sp.name}/${pr.tag || '?'}`);
            }
          }
        }
      }
    }
    check('所有球种的弹道半径都在合理范围（1~40 世界单位）',
      badR.length === 0,
      badR.length ? [...new Set(badR)].slice(0, 6).join('、') : `巡检了 ${SPECIES.filter(x => x.skills && x.skills.length).length} 个球种`);
    check('贴图弹道都带了正的 spriteLen、光晕色、呼吸开关与数值偏移',
      badSpr.length === 0,
      badSpr.length ? [...new Set(badSpr)].slice(0, 6).join('、') : `巡检了 ${spriteSrcs.size} 张弹道贴图`);
    const missingArt = [];
    for (const src of spriteSrcs.keys()) {
      try { readFileSync(src); } catch { missingArt.push(`${src}（${spriteSrcs.get(src)}）`); }
    }
    check('贴图弹道用到的图都真的在磁盘上',
      missingArt.length === 0,
      missingArt.length ? missingArt.join('、') : [...spriteSrcs.keys()].join('、'));
  }

  check('存在挂了技能的小球（技能系统有实际用例）', refs.length > 0,
    refs.map(r => `${r.sp.name}:${r.id}`).join('、'));

  /* ---------- 技能互斥（映霞[荣] / 映霞[枯]） ----------
     互斥由 skills.js 的 group 声明，balls.js 只负责把默认装配的前 3 个
     排成不冲突的组合（否则默认装出来的桃夭会自带一对互斥技能，
     界面显示装了 3 个、引擎只认 2 个）。这几条把三层口径钉在一起。 */
  const { resolveLoadout, conflictsWithChosen, skillGroup } = mods.skills;
  check('映霞[荣] 与 映霞[枯] 同属一个互斥组',
    skillGroup('taoyao_rong') === 'yingxia' && skillGroup('taoyao_ku') === 'yingxia',
    `荣→${skillGroup('taoyao_rong')} / 枯→${skillGroup('taoyao_ku')}`);
  const both = resolveLoadout(['taoyao_rong', 'taoyao_ku', 'taoyao_aim']);
  check('同时装两个映霞时只保留一个',
    both.filter(x => skillGroup(x) === 'yingxia').length === 1,
    both.join('、'));
  check('已选荣时枯被判为冲突（准备界面据此置灰）',
    conflictsWithChosen('taoyao_ku', ['taoyao_rong']) &&
    !conflictsWithChosen('taoyao_aim', ['taoyao_rong']),
    '荣 vs 枯 = 冲突；荣 vs 认真拉矢 = 不冲突');
  /* 通用不变量：以后加新角色 / 新技能组，默认装配也不能自带冲突。 */
  const badDefault = SPECIES.map(sp => {
    const d = mods.balls.defaultSkillsFor(sp.id);
    const r = resolveLoadout(d);
    return r.length === d.length ? null : `${sp.name}（${d.join('、')} → 只剩 ${r.join('、')}）`;
  }).filter(Boolean);
  check('每个球种的默认装配都没有互斥冲突', badDefault.length === 0,
    badDefault.join('；') || `${SPECIES.length} 个球种`);
  /* 通用不变量：用户把某球种所有技能全勾上，也不能选出同组两个。
     （准备界面上限是 3 个，这里刻意绕过上限直接喂全量，
       测的是"互斥"而不是"数量上限"。） */
  const dupGroup = SPECIES.map(sp => {
    const r = resolveLoadout(sp.skills || []);
    const groups = r.map(skillGroup).filter(Boolean);
    return new Set(groups).size === groups.length ? null : `${sp.name}：${r.join('、')}`;
  }).filter(Boolean);
  check('resolveLoadout 不会选出同组两个技能', dupGroup.length === 0,
    dupGroup.join('；') || '全部合法');
}

console.log('\n【5.7】数值（平衡）编辑器');
{
  /* ---------- 字段清单 ---------- */
  const schema = mods['asset-schema'];
  const group = schema.ASSET_GROUPS.find(g => g.id === 'balance');
  const fields = schema.allFields().filter(f => f.group === 'balance');
  check('「数值（平衡）」这一组存在', !!group, group ? group.name : '没有这一组');
  check('九项：5 个球种基础数值（含见晴 / 木桩）+ 4 个角色的技能数值',
    (group ? group.items.length : 0) === 9,
    group ? group.items.map(i => i.name).join('、') : '');
  check('字段覆盖血量 / 速度 / 技能伤害（≥ 40 个）', fields.length >= 40, `${fields.length} 个`);
  check('每个字段都有 pick（编辑器靠它读现值）；数字字段都带取值范围',
    fields.every(f => f.pick && (f.type === 'bool' || (Number.isFinite(f.min) && Number.isFinite(f.max)))),
    fields.filter(f => !f.pick).map(f => f.id).join(',') || '全部具备');
  check('每个字段都标了 ⚠ 平衡数值', fields.every(f => f.balance === true));
  check('没有把测试球的数值也放进来（那几个数被 skill3 守卫写死）',
    !fields.some(f => /test/i.test(f.pick)));

  /* ---------- 数字数组（裁光的两档接触伤害） ---------- */
  const { formatValue } = await import('../tools/lib/asset-patch.mjs');
  check('数组类型能写出 [1, 2]', formatValue('nums', '1, 2') === '[1, 2]', formatValue('nums', '1, 2'));
  let arrThrew = false;
  try { formatValue('nums', '  '); } catch { arrThrew = true; }
  check('空数组被拒绝（不能把一档伤害改没了）', arrThrew);

  /* ---------- 派生面板（实时推算） ---------- */
  const bal = mods['balance'];
  const rows = bal.rowsFor('stat_yuncai', { hp: 1500, speed: 120, melee: 0 });
  const get = (label) => (rows.find(r => r.label === label) || {}).text;
  check('基础数值面板给出"能挨几下"', get('能挨几下') === `${Math.ceil(1500 / bal.REF_HIT)} 下`, get('能挨几下'));
  check('碰撞伤害为 0 时不会算出"撞 0 次"这种鬼话',
    get('撞死一个标准目标') === '不会造成碰撞伤害', get('撞死一个标准目标'));
  const md = bal.rowsFor('numYuncaiSkill', { modanDmg: 75, modanCd: 2, caiguangDmgByStage: [1, 2] });
  check('技能面板给出每秒伤害（75 ÷ 2 秒 = 37.5，不能被四舍五入成 38）',
    (md.find(r => r.label === '魔弹 · 每秒伤害') || {}).text === '37.5',
    (md.find(r => r.label === '魔弹 · 每秒伤害') || {}).text);
  check('变化百分比算得对（+20% / 无变化为空）',
    bal.deltaText(100, 120) === '+20%' && bal.deltaText(66, 66) === '',
    `${bal.deltaText(100, 120)} / "${bal.deltaText(66, 66)}"`);

  /* ---------- 保存后的"跨标签页刷新提示" ---------- */
  const lr = mods['live-reload'];
  const handlers = [];
  const savedWindow = globalThis.window;
  globalThis.window = {
    addEventListener: (t, fn) => { if (t === 'storage') handlers.push(fn); },
    removeEventListener: (t, fn) => {
      if (t !== 'storage') return;
      const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1);
    },
  };
  let got = null;
  const off = lr.installLiveReload(info => { got = info; });
  lr.notifyAssetsSaved('魔弹伤害: 75 → 150');
  check('编辑器写完通知能在 localStorage 里读到',
    !!localStorageStub.getItem(lr.ASSETS_SAVED_KEY),
    localStorageStub.getItem(lr.ASSETS_SAVED_KEY).slice(0, 48));
  handlers.slice().forEach(fn => fn({ key: '别的键', newValue: 'x' }));
  check('别的 localStorage 变化不会误触发提示', got === null);
  handlers.slice().forEach(fn => fn({ key: lr.ASSETS_SAVED_KEY, newValue: localStorageStub.getItem(lr.ASSETS_SAVED_KEY) }));
  check('游戏页收到通知并拿到摘要', !!got && /魔弹伤害/.test(got.summary || ''), got ? got.summary : '没收到');
  off();
  check('监听可以卸载', handlers.length === 0);
  globalThis.window = savedWindow;

  /* ---------- 页面接线（静态核对，避免"功能写了但没接上"） ---------- */
  const mainSrc = readFileSync('js/main.js', 'utf8');
  const uiSrc = readFileSync('js/ui-assets.js', 'utf8');
  const cssSrc = readFileSync('css/styles.css', 'utf8');
  check('游戏入口装了刷新提示', /installLiveReload\s*\(/.test(mainSrc));
  check('编辑器保存成功后发通知', /notifyAssetsSaved\s*\(/.test(uiSrc));
  check('编辑器支持数组字段的类型', /type === 'nums'/.test(uiSrc));
  check('数值面板与自检共用 balance.js 的公式', /rowsFor\s*\(/.test(uiSrc));
  check('小条用 .show 类显隐（不用 hidden 属性）',
    /\.asset-toast\s*\{[^}]*display:\s*none/.test(cssSrc) &&
    /\.asset-toast\.show\s*\{\s*display:\s*block/.test(cssSrc));
}

console.log('\n' + log.join('\n'));
console.log(`\n=========== 通过 ${pass} 项，失败 ${fail} 项 ===========`);
process.exit(fail ? 1 : 0);

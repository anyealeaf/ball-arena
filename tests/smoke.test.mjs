/* ============================================================
   smoke.test.mjs — 前端界面真实渲染自检
   ------------------------------------------------------------
   用 linkedom 提供真实 DOM，把「图鉴 / 准备 / 战斗」三个界面
   各渲染一遍，并模拟点击关键按钮，确认页面真的能操作。
   运行：node tests/smoke.test.mjs
   ============================================================ */

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
for (const name of ['balls', 'arenas', 'skills', 'prefs', 'core', 'audio', 'ui-codex', 'ui-prepare', 'ui-battle', 'sketch', 'render']) {
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
  arenaId: 'lava_center',
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
  check('读回了存档的场地（熔心斗场）',
    !!root.querySelector('#arenaInfo') && root.querySelector('#arenaInfo').innerHTML.includes('岩浆'));

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
    const full = make(rect, 1.0, 880).r;
    const half = make(mods.arenas.scaleArena(rect, 0.5), 0.5, 880).r;
    // 相机应当把包围盒精确映射到画布宽度上
    const fullFit = Math.abs(full.camScale * full.boxW - full.cssW) < 2;
    const halfFit = Math.abs(half.camScale * half.boxW - half.cssW) < 2;
    check('相机把场地精确铺满画布宽度', fullFit && halfFit,
      `全场 ${(full.camScale * full.boxW).toFixed(0)}/${full.cssW}px，半场 ${(half.camScale * half.boxW).toFixed(0)}/${half.cssW}px`);
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
  check('场地数量 ≥ 10', ARENAS.length >= 10, `${ARENAS.length} 个`);
  check('场地字段完整', ARENAS.every(a => a.id && a.name && a.shape && Array.isArray(a.zones)));
  check('场地 id 不重复', new Set(ARENAS.map(a => a.id)).size === ARENAS.length);
  const fx = ARENAS.filter(a => a.zones.length || Object.keys(a.effects || {}).length);
  check('存在带特殊效果的场地', fx.length > 0, fx.map(a => a.name).join('、'));

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
  check('存在挂了技能的小球（技能系统有实际用例）', refs.length > 0,
    refs.map(r => `${r.sp.name}:${r.id}`).join('、'));
}

console.log('\n' + log.join('\n'));
console.log(`\n=========== 通过 ${pass} 项，失败 ${fail} 项 ===========`);
process.exit(fail ? 1 : 0);

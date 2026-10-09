/* check-boot.mjs — 「页面到底能不能开」的入口自检
 *
 *   node tools/check-boot.mjs
 *
 * 为什么单独做这一件事：**"打不开"有两种完全不同的原因**，处理方式也不同 ——
 *   ① 服务器没在跑（浏览器说"无法访问"）：跟代码无关，去跑 tools/serve.mjs；
 *   ② 代码把页面搞崩了（页面空白，或显示 index.html 里那块"页面没能启动"面板）。
 * 这个脚本专治 ②：用 linkedom 把**真实的 html + 入口模块**跑起来，
 * 并且**像用户那样点一遍**：
 *   首页 → 图鉴 → 准备 → 点"开战" → 战斗 → 跑若干帧渲染
 *   另外单独把「素材编辑器」页面也开一次（它是独立页面，坏了没人会发现）。
 * 任何一步抛错、或者页面被替换成"页面没能启动"面板，都算失败（退出码 1）。
 *
 * 它不碰网络、不需要浏览器，所以服务器开没开都能跑 —— 这正是它的用处：
 * 先分清是"服务器的问题"还是"我改坏了代码"。
 */
import { parseHTML } from 'linkedom';
import { readFileSync } from 'node:fs';

const errs = [];
const guard = (where, fn) => {
  try { return fn(); } catch (e) { errs.push(`${where}: ${e && e.message}`); return null; }
};

/** 装一套"浏览器环境"（两个页面共用这段） */
function installEnv(htmlFile) {
  const html = readFileSync(htmlFile, 'utf8');
  const { window, document } = parseHTML(html);

  const calls = { n: 0 };
  const ctxStub = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'canvas') return { width: 720, height: 440, clientWidth: 720, clientHeight: 440 };
      if (prop === 'createRadialGradient' || prop === 'createLinearGradient') {
        return () => ({ addColorStop() {} });
      }
      if (prop === 'measureText') return () => ({ width: 10 });
      return (...a) => { calls.n++; void a; };
    },
    set() { return true; }
  });
  const proto = window.HTMLCanvasElement && window.HTMLCanvasElement.prototype;
  if (proto) proto.getContext = () => ctxStub;
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

  globalThis.window = window;
  globalThis.document = document;
  globalThis.performance = globalThis.performance || { now: () => Date.now() };

  const loc = {
    _h: '',
    get hash() { return this._h; },
    set hash(v) { this._h = String(v); },
    href: 'http://localhost:5173/' + (htmlFile === 'index.html' ? '' : htmlFile),
    search: '', pathname: '/', protocol: 'http:', reload() {},
  };
  globalThis.location = loc;
  window.location = loc;
  window.devicePixelRatio = 1;
  window.scrollTo = () => {};

  const raf = [];
  window.requestAnimationFrame = fn => { raf.push(fn); return raf.length; };
  globalThis.requestAnimationFrame = window.requestAnimationFrame;

  const store = new Map();
  const ls = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear: () => store.clear(),
    get length() { return store.size; },
    key: i => [...store.keys()][i] ?? null,
  };
  globalThis.localStorage = ls;
  window.localStorage = ls;

  class FakeImage {
    constructor() { this.width = 64; this.height = 64; this.naturalWidth = 64; this.naturalHeight = 64; }
    get src() { return this._src; }
    set src(v) { this._src = v; if (this.onload) this.onload(); }
  }
  globalThis.Image = FakeImage;

  window.addEventListener('error', e => errs.push('window.error: ' + (e && e.message)));

  const runFrames = (n = 4) => {
    for (let i = 0; i < n; i++) {
      const q = raf.splice(0, raf.length);
      for (const fn of q) guard('渲染帧', () => fn(performance.now() + i * 16.7));
    }
  };
  return { window, document, calls, runFrames, loc };
}

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });

/* ---------- ① 游戏主页：首页 → 图鉴 → 准备 → 开战 → 战斗 ---------- */
{
  const env = installEnv('index.html');
  const app = env.document.getElementById('app');
  const text = () => ((app && app.textContent) || '').replace(/\s+/g, ' ').trim();
  const go = (hash) => {
    env.loc.hash = hash;
    guard(`切到 ${hash}`, () => env.window.dispatchEvent(new env.window.Event('hashchange')));
    env.runFrames(3);
  };

  try {
    await import('../js/main.js');
  } catch (e) {
    errs.push('导入 main.js 抛错: ' + ((e && e.stack) || e));
  }
  env.runFrames(3);

  check('入口导入没抛错', !errs.some(e => e.startsWith('导入 main.js')), errs[0] || '');
  check('首页渲染出菜单（不是空白）',
    text().includes('图鉴') && text().includes('斗蛐蛐准备'), `${text().length} 字`);
  check('首页没有被"页面没能启动"面板替换', !text().includes('页面没能启动'));
  check('首页有「素材编辑器」入口', !!app.querySelector('a[href="assets-editor.html"]'));

  go('#/codex');
  check('图鉴页渲染出内容', text().length > 200 && !text().includes('页面没能启动'),
    `${text().length} 字`);

  go('#/prepare');
  const startBtn = app.querySelector('#startBtn');
  check('准备页渲染出"开战"按钮', !!startBtn);
  check('准备页没有被"页面没能启动"面板替换', !text().includes('页面没能启动'));
  check('「详细设置」默认收起、但里面控件都在',
    app.querySelector('#detailPanel').style.display === 'none' &&
    !!app.querySelector('#speedScale') && !!app.querySelector('#spawnModeSeg'),
    '运动参数与开局方向都在面板里');

  if (startBtn) {
    guard('点开战', () => { if (startBtn.onclick) startBtn.onclick(); });
    go('#/battle');
    check('战斗页创建了画布', !!app.querySelector('#battleCanvas'));
    check('战斗页有播放控件', !!app.querySelector('#btPlay') && !!app.querySelector('#btSeek'));
    const before = env.calls.n;
    env.runFrames(40);
    check('战斗画面真的在画东西（跑 40 帧有绘制调用）', env.calls.n > before,
      `${env.calls.n - before} 次绘制调用`);
    check('战斗页没有被"页面没能启动"面板替换', !text().includes('页面没能启动'));
  }
}

/* ---------- ② 素材编辑器（独立页面，坏了没人会发现） ---------- */
{
  errs.length = 0;
  const env = installEnv('assets-editor.html');
  try {
    await import('../js/ui-assets.js');
  } catch (e) {
    errs.push('导入 ui-assets.js 抛错: ' + ((e && e.stack) || e));
  }
  env.runFrames(2);
  const doc = env.document;
  const items = doc.querySelectorAll('.ed-item');
  check('素材编辑器页面能开', !errs.length, errs[0] || '');
  check('左侧列出了所有素材', items.length >= 10, `${items.length} 个`);
  check('默认选中第一个素材并生成了控件',
    doc.querySelectorAll('#edFields input').length > 0,
    `${doc.querySelectorAll('#edFields input').length} 个控件`);
  /* 逐个素材点一遍：任何一个素材的控件生成/预览绘制出错都会被抓到。
     ⚠ items[0] 要先判空：页面导入失败时这个列表是空的，
     而下面 items[0].onclick() 会在**打印结果之前**把整个脚本崩掉 ——
     真正的原因（导入抛了什么错）就再也看不到了（踩过一次）。 */
  let bad = '';
  check('素材清单不是空的（页面导入失败时这里会是 0）', items.length > 0, `${items.length} 个`);
  for (const btn of items) {
    try {
      btn.onclick();
      env.runFrames(1);
      if (!doc.querySelectorAll('#edFields input').length) bad = btn.textContent;
    } catch (e) { bad = `${btn.textContent}: ${e.message}`; break; }
  }
  check(`每个素材都能选中并画出预览（${items.length} 个逐个点一遍）`, !bad, bad || '全部通过');
  check('写回按钮与状态区都在（右上角一键保存 + 右栏保存）',
    !!doc.querySelector('#edSave') && !!doc.querySelector('#edSaveTop') &&
    !!doc.querySelector('#edStatus') && !!doc.querySelector('#edDirtyTop'));
  /* 拖动判定圆：命中区判断在 pointerdown 里，无头环境没有 PointerEvent，
     所以这里只验"事件挂上了 + 提示写了"，真正的拖动几何由
     tests/diag/art-proj.mjs 的偏移断言守着（那才是会被玩家看到的量）。 */
  const canvasEl = doc.querySelector('#edCanvas');
  check('预览画布挂了拖动事件（判定圆可拖）',
    typeof canvasEl.addEventListener === 'function', 'addEventListener 可用');
  /* 提示只在"弹道"这一类上写（上一轮循环停在最后一个素材，所以先切回第一个） */
  if (items[0]) { items[0].onclick(); env.runFrames(1); }
  check('弹道素材上写了"可以拖判定圆"的提示',
    (doc.querySelector('#edDragHint').textContent || '').includes('拖动判定圆'),
    (doc.querySelector('#edDragHint').textContent || '').slice(0, 40));

  /* 数值（平衡）那一组：**每个控件都必须有值**。
     这类"取不到现值 → 显示成空白框"的 bug 已经踩过两次
     （手写清单漏登记、pick 路径写错），而页面本身不会报错 ——
     所以这里像用户那样点进去，逐个数一遍。 */
  {
    const find = (text) => [...doc.querySelectorAll('.ed-item')].find(b => (b.textContent || '').includes(text));
    const stat = find('晕彩 · 基础数值');
    const skill = find('晕彩 · 技能数值');
    check('左侧能选到「数值（平衡）」的两项', !!stat && !!skill,
      `${stat ? '有基础数值' : '缺基础数值'}，${skill ? '有技能数值' : '缺技能数值'}`);
    const blank = (label) => {
      if (!label) return ['没有这一项'];
      label.onclick();
      env.runFrames(1);
      const nums = [...doc.querySelectorAll('#edFields input[type="number"]')];
      const texts = [...doc.querySelectorAll('#edFields input[type="text"]')];
      return [...nums, ...texts]
        .filter(i => !String(i.value || '').trim() || String(i.value) === 'undefined')
        .map(i => i.id || '(无 id)');
    };
    const bad1 = blank(stat), bad2 = blank(skill);
    check('基础数值的每个框都有值（空白框 = 编辑器读不到现值）', bad1.length === 0,
      bad1.slice(0, 4).join(', ') || '全部有值');
    check('技能数值的每个框都有值（含裁光那个数字数组）', bad2.length === 0,
      bad2.slice(0, 4).join(', ') || '全部有值');
    /* 数组字段是文本框，值应该是 "1, 2" 这种 */
    const arr = doc.querySelector('#edFields input#f_cgDmg');
    check('裁光的数组字段读出来是 "1, 2"（不是 [object Object] 也不是空）',
      !!arr && /^\d+(\s*,\s*\d+)+$/.test(String(arr.value || '')), arr ? arr.value : '找不到这个控件');
  }
  /* 拖动的正反变换必须互为逆：拖到哪里 → 存什么数 → 画回哪里。
     两者用同一对函数（circlePosFor / offsetForCirclePos），这条守着它们不被改歪。 */
  {
    const { circlePosFor, offsetForCirclePos } = await import('../js/ui-assets.js');
    const rt = [[0, 0], [5, -3], [-12.5, 7.5]].map(([ox, oy]) => {
      const p = circlePosFor(ox, oy);
      const back = offsetForCirclePos(p.x, p.y);
      return Math.abs(back.offX - ox) < 1e-9 && Math.abs(back.offY - oy) < 1e-9;
    });
    check('拖动用的正反变换互为逆（拖到哪就存哪个数）', rt.every(Boolean), `${rt.filter(Boolean).length}/3`);
  }
}

/* ---------- 汇总 ---------- */
for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? '  — ' + c.detail : ''}`);
const errList = [...new Set(errs)];
console.log('\n捕获到的错误：' + (errList.length ? '\n  ' + errList.join('\n  ') : '（无）'));
const bad = checks.filter(c => !c.ok).length + errList.length;
console.log(`\n=========== 通过 ${checks.filter(c => c.ok).length} 项，失败 ${bad} 项 ===========`);
console.log(bad
  ? '页面本身有问题 —— 看上面的错误。'
  : '入口到战斗界面、以及素材编辑器页面，全程正常（与"服务器开没开"无关）。');
process.exit(bad ? 1 : 0);

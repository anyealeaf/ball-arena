/* ============================================================
   main.js — 应用入口：哈希路由 + 首页菜单
   ============================================================ */

import { renderCodex } from './ui-codex.js';
import { renderPrepare } from './ui-prepare.js';
import { renderBattle } from './ui-battle.js';
import { installLiveReload } from './live-reload.js';

const root = document.getElementById('app');

/* ============================================================
   素材 / 数值改完之后的"刷新提示"
   ------------------------------------------------------------
   编辑器是另一个标签页。它保存成功后会在 localStorage 里留一条消息，
   这里收到（同源跨标签页的 storage 事件）就弹一个小条：
   **为什么要刷新**：引擎在页面加载时把 balls.js / skills.js 读进内存，
   改完源码它不会自己知道；就算重新 import 也是第二个模块实例，
   引擎手里还是旧的那份。所以"刷新"是必须的一步，
   那就别让作者自己去想 Ctrl+F5 —— 点一下这个按钮就行。
   ============================================================ */
let assetToast = null, assetToastTimer = 0;

function showAssetToast(info) {
  if (!document.body) return;
  if (!assetToast) {
    assetToast = document.createElement('div');
    assetToast.className = 'asset-toast';
    document.body.appendChild(assetToast);
  }
  /* summary 来自编辑器（字段名 + 改前 → 改后）。它进的是 innerHTML，
     所以把尖括号之类全部转义掉 —— 字段名是中文，但没必要赌它永远干净。 */
  const summary = String((info && info.summary) || '')
    .replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  assetToast.innerHTML =
    '<div class="at-head"><b>素材已更新</b>' +
    '<span class="hint">数值改完要刷新页面才会生效</span></div>' +
    (summary ? `<div class="at-sum mono">${summary}</div>` : '') +
    '<div class="at-btns">' +
    '<button class="btn sm primary" id="assetReload">点击刷新</button>' +
    '<button class="btn sm" id="assetLater">稍后</button>' +
    '</div>';
  assetToast.classList.add('show');
  const reloadBtn = assetToast.querySelector('#assetReload');
  const laterBtn = assetToast.querySelector('#assetLater');
  if (reloadBtn) reloadBtn.onclick = () => location.reload();
  if (laterBtn) laterBtn.onclick = () => assetToast.classList.remove('show');
  clearTimeout(assetToastTimer);
  /* 30 秒后自己收起来：不挡住看对局 */
  assetToastTimer = setTimeout(() => assetToast && assetToast.classList.remove('show'), 30000);
}

installLiveReload(showAssetToast);

/**
 * 调试辅助：
 *   ?shot=codex|prepare|battle  直接跳到某个界面（截图/排查用）
 *   ?seed=123456                固定对局种子（复现特定一局用）
 */
const params = new URLSearchParams(location.search);
let forcedSeed = null;
if (params.has('seed')) {
  const v = Number(params.get('seed'));
  if (Number.isFinite(v)) forcedSeed = v >>> 0;
}
export function nextSeed() {
  return forcedSeed !== null ? forcedSeed : ((Math.random() * 0xffffffff) >>> 0);
}

/** 当前战斗配置（准备界面生成后交给战斗界面） */
let pendingConfig = null;

const MENU = [
  {
    hash: '#/codex',
    ic: '📖',
    title: '图鉴',
    desc: '查看每个小球的属性、特殊资源与技能。战斗中的一切行为都由这张表决定。'
  },
  {
    hash: '#/prepare',
    ic: '⚔️',
    title: '斗蛐蛐准备',
    desc: '设置队伍数量、场地、参与小球与特殊规则。开战之后就不再干预，所以配置决定胜负。'
  },
  {
    /* 单开一个页面（不是哈希路由里的界面）：它不参与战斗流程，
       只是调素材与数值的工具，改完写回 js/*.js。 */
    href: 'assets-editor.html',
    ic: '🎛️',
    title: '素材编辑器',
    desc: '可视化调尺寸、透明度与光晕，也能改血量 / 速度 / 技能伤害等平衡数值；改完一键写回配置。'
  }
];

function renderMenu() {
  root.innerHTML = `
    <div class="topbar">
      <div class="brand">小球角斗场<small>斗蛐蛐玩法框架</small></div>
    </div>
    <p class="lead">选择要进行的操作。</p>
    <div class="menu">
      ${MENU.map(m => `
        <a class="menu-card" href="${m.href || m.hash}" style="text-decoration:none;color:inherit">
          <span class="ic">${m.ic}</span>
          <h3>${m.title}</h3>
          <p>${m.desc}</p>
        </a>
      `).join('')}
    </div>
    <div class="card" style="margin-top:18px">
      <h3>当前阶段说明</h3>
      <p class="hint" style="margin:0">
        目前有四个球种：<b>晕彩</b>（7 技能）、<b>桃夭</b>（5 技能）、<b>缇娜</b>（7 技能），
        以及演示用的<b>木桩</b>（不移动、5000 血，拿它当靶子看技能效果最直观）。
        新角色与立绘的接口均已预留：<span class="mono">balls.js</span> 里的
        <span class="mono">skills</span> / <span class="mono">sticker</span> 字段填上内容即可生效，引擎无需改动。
      </p>
    </div>
  `;
}

function route() {
  const h = location.hash || '';
  /* ---------- 战斗界面的"守门人" ----------
     右键是玩家操控的 2 号技能键，而"按住右键拖动"在不少浏览器/鼠标驱动里
     是**后退手势** —— 一触发就会跳走，这一局当场没了（作者实测）。
     所以战斗界面会把一个守门人挂在 window 上：
       · block(h) 返回 true → 这次跳转拦下、地址改回 #/battle，界面原样留着；
       · 已经在打 (#/battle) 且守门人还活着 → 不重开一局。 */
  const screen = window.__battleScreen;
  if (screen && typeof screen.block === 'function' && screen.block(h)) {
    if (location.hash !== '#/battle') location.hash = '#/battle';
    return;
  }
  if (h.startsWith('#/battle') && screen && screen.alive) return;   // 已经在打，别重开
  if (screen && typeof screen.detach === 'function') screen.detach();   // 换界面：先拆监听
  window.__battleScreen = null;

  if (h.startsWith('#/codex')) {
    renderCodex(root);
  } else if (h.startsWith('#/prepare')) {
    renderPrepare(root, cfg => {
      pendingConfig = cfg;
      location.hash = '#/battle';
    });
  } else if (h.startsWith('#/battle')) {
    if (!pendingConfig) { location.hash = '#/prepare'; return; }
    const cfg = pendingConfig;
    renderBattle(root, cfg, (again) => {
      if (again) {
        // 换个种子重开同一套配置
        renderBattle(root, cfg, () => { location.hash = '#/prepare'; });
      } else {
        location.hash = '#/prepare';
      }
    });
  } else {
    renderMenu();
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);

// 支持 ?shot=... 直接进入指定界面（截图与排查用）
const shot = params.get('shot');
if (shot && ['codex', 'prepare', 'battle'].includes(shot)) {
  location.hash = '#/' + shot;
}
route();

/* ============================================================
   main.js — 应用入口：哈希路由 + 首页菜单
   ============================================================ */

import { renderCodex } from './ui-codex.js';
import { renderPrepare } from './ui-prepare.js';
import { renderBattle } from './ui-battle.js';

const root = document.getElementById('app');

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
        <a class="menu-card" href="${m.hash}" style="text-decoration:none;color:inherit">
          <span class="ic">${m.ic}</span>
          <h3>${m.title}</h3>
          <p>${m.desc}</p>
        </a>
      `).join('')}
    </div>
    <div class="card" style="margin-top:18px">
      <h3>当前阶段说明</h3>
      <p class="hint" style="margin:0">
        框架已搭好，小球暂时只有测试用的空白球（无技能、1000 生命、碰撞 100 伤害）。
        技能与角色立绘的接口均已预留：<span class="mono">balls.js</span> 里的
        <span class="mono">skills</span> 与 <span class="mono">image</span> 字段填上内容即可生效，引擎无需改动。
      </p>
    </div>
  `;
}

function route() {
  const h = location.hash || '';
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

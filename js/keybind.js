/* ============================================================
   keybind.js — 「按下新键」的捕捉 + 键位编辑器（多个界面共用）
   ------------------------------------------------------------
   为什么单独一个模块：同一套东西现在有**两个**入口要用 ——
     · 斗蛐蛐准备界面的「详细设置 → 自定义按键」；
     · 战斗界面顶栏的「⌨ 按键设置」（闯关肉鸽里没有准备界面，
       技能又是打一关抽一次、随时会多出新技能，必须能在战斗中改键）。
   两处各写一份的下场是"一边能绑、一边绑了不生效"，所以捕捉逻辑
   与那张键位表只留这一份，prefs.js 仍是唯一的存储。

   捕捉状态是**模块级单例**：同时只可能有一个编辑器在等按键
   （另一个界面此刻已经不在树上了），所以一个槽位就够。

   监听只注册一次（`kbBound`）：route() 每次切界面都会重跑渲染，
   一次渲染注册一对 window 监听的话，来回切几趟就会积一堆 ——
   按一下键会连改好几个键位（准备界面第一版就是这么写的）。
   ============================================================ */

import {
  getPlayerKeys, setPlayerKeys, keyLabel, DEFAULT_PLAYER_KEYS, MAX_PLAYER_KEYS,
} from './prefs.js';
import { getSkill } from './skills.js';

/** 正在等待"按下新键"的那个键位（`at` = 下标）；`host` 用来确认编辑器还在树上 */
export const kbCapture = { at: null, host: null, apply: null };
let kbBound = false;

/** 处理一次"按键/点击"：正在捕捉就把这一下吃掉并落到对应键位上。
 *  返回 true = 这一下被捕捉消费掉了（调用方不必再管）。 */
export function kbHandle(code, ev) {
  if (kbCapture.at == null) return false;
  /* "那个键位列表还在树上吗"：用 parentNode 判，不用 isConnected ——
     准备界面整体渲染在一个容器里，容器本身**未必挂在 document 上**
     （诊断脚本就是拿一个游离的 div 渲染的），用 isConnected 会把正常的
     改键操作一起挡掉。换成"有没有被重新渲染掉"这个真正要防的情况：
     重绘之后旧节点会从父节点上摘下来，parentNode 变成 null。 */
  if (!kbCapture.host || !kbCapture.host.parentNode) { kbCapture.at = null; return false; }
  if (ev) {
    ev.preventDefault();
    ev.stopPropagation();
  }
  const apply = kbCapture.apply;
  const at = kbCapture.at;
  kbCapture.at = null;
  if (apply) apply(code === 'Escape' ? null : code, at);
  return true;
}

export function bindKbCapture() {
  if (kbBound) return;
  kbBound = true;
  /* ⚠ 用**捕获阶段**（第三个参数 true）：战斗界面自己也在 window 上听 keydown
     （技能键），capture 阶段先跑 + stopPropagation 才能保证"改键时按的那一下"
     不会同时把技能放出去。 */
  window.addEventListener('keydown', e => { kbHandle(e.code, e); }, true);
  window.addEventListener('mousedown', e => { kbHandle('Mouse' + e.button, e); }, true);
  /* 右键要顺手挡掉系统菜单，否则绑完右键会弹出上下文菜单 */
  window.addEventListener('contextmenu', e => { if (kbCapture.at != null) e.preventDefault(); }, true);
}

/** 取消"正在等按键"的状态（切界面 / 重绘时调用） */
export function cancelKeyCapture() {
  kbCapture.at = null;
}

/** 键位编辑器的 HTML 片段：键位按钮 + 加/删/复位 + "键位 → 技能"对照表。
 *  `host` 是将来放这些控件的容器（编辑器渲染进它的 #keybindList 等节点里）。 */
export function keybindEditorHtml(manualIds) {
  return `
    <div class="keybind-list" id="keybindList"></div>
    <div class="btnrow" style="margin-bottom:6px">
      <button class="btn sm" id="kbAdd" type="button">＋ 添加按键</button>
      <button class="btn sm" id="kbReset" type="button">恢复默认</button>
    </div>
    <div class="hint keybind-map" id="keybindMap"></div>
    <div class="hint" style="margin-top:4px">
      点一个键位再按新键即可改（鼠标左键 / 右键也能绑）。默认：
      <span class="kbd">鼠标左键</span><span class="kbd">鼠标右键</span>
      <span class="kbd">E</span><span class="kbd">1</span><span class="kbd">2</span><span class="kbd">3</span>。
      ${manualIds && manualIds.length ? `当前有 <b>${manualIds.length}</b> 个主动技能。` : ''}
    </div>`;
}

/**
 * 把键位编辑器渲染进 `host`（host 内部要有 #keybindList / #keybindMap / #kbAdd / #kbReset，
 * 用 keybindEditorHtml() 生成）。
 *   · `manualIds`：当前这个球有哪些主动技能（顺序 = 键位顺序，来自 skills.js 的 manualSkillIds）；
 *   · `onChange`：键位变化后的回调（界面重画别的地方用；重画编辑器本身由这里负责）。
 */
export function drawKeybindEditor(host, manualIds, onChange) {
  if (!host) return;
  const nameOf = id => ((getSkill(id) || {}).name) || id;
  const listHost = host.querySelector('#keybindList');
  if (!listHost) return;
  const manual = (manualIds || []).slice();
  const keys = getPlayerKeys();
  const bound = Math.max(keys.length, manual.length);
  const cap = kbCapture.at;

  listHost.innerHTML = Array.from({ length: bound }, (_, i) => `
    <span class="keybind-row">
      <button class="btn sm kb-key${cap === i ? ' capturing' : ''}" data-kb="${i}" type="button">
        ${cap === i ? '按下新键…' : keyLabel(keys[i])}
      </button>
      ${bound > 1 ? `<button class="kb-del" data-kbdel="${i}" type="button" title="删掉这个键位">×</button>` : ''}
    </span>`).join('');

  const map = host.querySelector('#keybindMap');
  if (map) {
    if (!manual.length) {
      map.innerHTML = '<span class="kb-slot">这个球没有主动技能 —— 所有技能都是被动/形态类，全自动触发，不需要按键。</span>';
    } else {
      const skillsOf = manual.map(nameOf);
      map.innerHTML = manual.map((id, i) => {
        const label = keys[i]
          ? `<span class="kbd">${keyLabel(keys[i])}</span>`
          : '<span class="kb-none">未绑定</span>';
        return `${label} → ${skillsOf[i]}`;
      }).join('　·　')
        + (manual.length > keys.length
          ? `<br><span class="kb-none">有 ${manual.length - keys.length} 个主动技能没有按键 —— 点「＋ 添加按键」补上。</span>`
          : '')
        + (keys.length > manual.length && manual.length
          ? `<br><span class="hint">还有 ${keys.length - manual.length} 个空键位（以后抽到新技能会按顺序用上）。</span>`
          : '');
    }
  }

  /* 捕捉的落点交给模块级的监听（见 kbHandle）：它把"按下的键 + 哪个键位"传回来 */
  kbCapture.host = listHost;
  kbCapture.apply = (code, at) => {
    if (code && at != null) {
      const list = getPlayerKeys();
      while (list.length <= at) list.push('');
      list[at] = code;
      setPlayerKeys(list);
    }
    if (onChange) onChange();
    drawKeybindEditor(host, manualIds, onChange);   // code = null（按了 Esc）时只是恢复界面
  };

  listHost.querySelectorAll('[data-kb]').forEach(btn => {
    btn.onclick = () => { kbCapture.at = Number(btn.dataset.kb); drawKeybindEditor(host, manualIds, onChange); };
  });
  listHost.querySelectorAll('[data-kbdel]').forEach(btn => {
    btn.onclick = () => {
      const i = Number(btn.dataset.kbdel);
      setPlayerKeys(getPlayerKeys().filter((_, k) => k !== i));
      kbCapture.at = null;
      if (onChange) onChange();
      drawKeybindEditor(host, manualIds, onChange);
    };
  });
  const add = host.querySelector('#kbAdd');
  if (add) add.onclick = () => {
    const cur = getPlayerKeys();
    if (cur.length >= MAX_PLAYER_KEYS) return;
    setPlayerKeys([...cur, '']);
    if (onChange) onChange();
    drawKeybindEditor(host, manualIds, onChange);
  };
  const reset = host.querySelector('#kbReset');
  if (reset) reset.onclick = () => {
    setPlayerKeys(DEFAULT_PLAYER_KEYS.slice());
    kbCapture.at = null;
    if (onChange) onChange();
    drawKeybindEditor(host, manualIds, onChange);
  };
}

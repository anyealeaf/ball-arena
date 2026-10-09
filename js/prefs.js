/* ============================================================
   prefs.js — 界面偏好（跨界面共享、可持久化）
   ------------------------------------------------------------
   为什么单独放一个模块：同一份偏好在多个界面都要读
   （图鉴的技能卡片、准备界面的技能装配面板），
   各自存一份迟早会不一致。放这里统一读写，谁改谁广播一下即可。
   ============================================================ */

const KEY = 'ballBattle.prefs.v1';

const DEFAULTS = {
  /* 技能描述用"详细版"还是"简要版"。
     简要版是作者给的官方措辞；详细版把机制与数值全部展开。
     默认简要 —— 第一次看的人先看人话，需要抠数值时再切详细。 */
  skillDetail: false,

  /* 音效开关与音量。默认关闭：浏览器要求用户手势才能出声，
     与其"想响却响不了"的困惑，不如让玩家自己点开。 */
  sound: false,
  soundVolume: 0.6,

  /* 准备界面的「详细设置」是否展开。
     默认收起 —— 运动参数与特殊规则都属于"想折腾时才找"的东西。
     记住状态是因为调参时来回切界面（或者刷新）很常见。 */
  detailOpen: false,

  /* 屏幕抖动（开华那一瞬间轻微晃一下）。
     默认开启 —— 它是"形态强化"这个瞬间的一部分；
     但有人看镜头晃会不舒服，所以战斗界面控制条上留了开关。 */
  screenShake: true,

  /* 玩家操控的技能按键（作者 2026-10 指定的默认值）。
     数组下标 = 第几个主动技能（顺序见 skills.js 的 manualSkillIds）。
     记的是**物理键位**（KeyboardEvent.code / Mouse0|1|2），
     不是 e.key —— 后者会跟着输入法、大小写与 Shift 变，
     "按 E 却放出了别的技能"这种问题最难查。 */
  playerKeys: ['Mouse0', 'Mouse2', 'KeyE', 'Digit1', 'Digit2', 'Digit3'],
};

/* ---------- 玩家按键 ---------- */
/** 默认按键：鼠标左键、鼠标右键、E、数字键 1/2/3（作者指定的六个）。
 *  主动技能多于六个时（无限火力），要自己再加键 ——
 *  准备界面的「自定义按键」里可以加。 */
export const DEFAULT_PLAYER_KEYS = ['Mouse0', 'Mouse2', 'KeyE', 'Digit1', 'Digit2', 'Digit3'];
export const MAX_PLAYER_KEYS = 12;

let cache = null;
const listeners = new Set();

function load() {
  if (cache) return cache;
  let saved = null;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) saved = JSON.parse(raw);
  } catch (e) { /* 隐私模式 / 坏数据：退回默认值 */ }
  cache = { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
  return cache;
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) { /* 忽略 */ }
}

/** 技能描述是否使用详细版 */
export function getSkillDetail() {
  return !!load().skillDetail;
}

/** 设置技能描述版本，并通知所有订阅者重绘 */
export function setSkillDetail(v) {
  setPref('skillDetail', !!v);
}

/** 订阅偏好变化，返回取消订阅的函数 */
export function onPrefsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 只给测试用：清掉缓存，强制下次重新读 localStorage */
export function _resetPrefsCache() {
  cache = null;
}

/* ---------- 准备界面的「详细设置」---------- */

/** 详细设置面板是否展开 */
export function getDetailOpen() {
  return !!load().detailOpen;
}

/** 设置详细设置面板的展开状态（会广播，订阅者可以跟着重绘） */
export function setDetailOpen(v) {
  setPref('detailOpen', !!v);
}

/* ---------- 屏幕抖动 ---------- */

/** 屏幕抖动是否开启（开华那一下） */
export function getShakeEnabled() {
  return load().screenShake !== false;   // 默认开：只有显式关掉才是 false
}

export function setShakeEnabled(v) {
  setPref('screenShake', !!v);
}

/* ---------- 玩家操控的技能按键 ---------- */

/** 当前按键表（数组下标 = 第几个主动技能）。
 *  坏数据要能兜住：手工改过 localStorage、或者以后默认值变短了，
 *  这里都退回默认值，而不是把 undefined 丢给界面去崩。 */
export function getPlayerKeys() {
  const v = load().playerKeys;
  if (!Array.isArray(v) || !v.length) return DEFAULT_PLAYER_KEYS.slice();
  return v.filter(k => typeof k === 'string' && k)
    .slice(0, MAX_PLAYER_KEYS);
}

/** 覆盖整张按键表（准备界面的「自定义按键」用） */
export function setPlayerKeys(list) {
  const arr = (Array.isArray(list) ? list : [])
    .filter(k => typeof k === 'string' && k)
    .slice(0, MAX_PLAYER_KEYS);
  setPref('playerKeys', arr.length ? arr : DEFAULT_PLAYER_KEYS.slice());
}

/** 把按键码翻译成人看的标签（界面上显示用） */
export function keyLabel(code) {
  if (!code) return '未绑定';
  if (code === 'Mouse0') return '鼠标左键';
  if (code === 'Mouse1') return '鼠标中键';
  if (code === 'Mouse2') return '鼠标右键';
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit(\d)$/.exec(code);
  if (m) return m[1];
  m = /^Numpad(\d)$/.exec(code);
  if (m) return '小键盘' + m[1];
  const named = {
    Space: '空格', ShiftLeft: '左Shift', ShiftRight: '右Shift', ControlLeft: '左Ctrl',
    ControlRight: '右Ctrl', AltLeft: '左Alt', AltRight: '右Alt', Tab: 'Tab',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Enter: '回车', Backspace: '退格', Minus: '−', Equal: '=', BracketLeft: '[',
    BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    Backquote: '`', Backslash: '\\',
  };
  if (named[code]) return named[code];
  return code.replace(/^(Key|Digit)/, '');
}

/* ---------- 音效 ---------- */

export function getSoundEnabled() {
  return !!load().sound;
}

export function setSoundEnabled(v) {
  setPref('sound', !!v);
}

export function getSoundVolume() {
  const v = Number(load().soundVolume);
  return isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.6;
}

export function setSoundVolume(v) {
  const n = Number(v);
  setPref('soundVolume', isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.6);
}

/** 写一个偏好项并广播（值没变就不折腾） */
function setPref(key, value) {
  const cur = load();
  if (cur[key] === value) return;
  cur[key] = value;
  persist();
  for (const fn of listeners) {
    try { fn(key, value); } catch (e) { /* 单个界面出错不能拖垮其他界面 */ }
  }
}

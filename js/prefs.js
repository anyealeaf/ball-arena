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
};

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

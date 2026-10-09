/* ============================================================
   live-reload.js — 「素材 / 数值改完了，游戏页那边知道一下」
   ------------------------------------------------------------
   编辑器是**另一个标签页**，游戏页是静态模块 —— 页面加载时就把
   balls.js / skills.js 读进内存了，之后你改源码它不会自己知道。
   真相是：**必须刷新页面**新数值才生效（引擎不再重新 import 一次；
   就算重新 import 也是第二个模块实例，引擎手里还是旧的那份）。

   既然"必须刷新"躲不掉，那就别让作者自己去想 Ctrl+F5：
   编辑器保存成功后往 localStorage 写一条消息，**其它标签页**会收到
   `storage` 事件（同源、跨标签页，这是浏览器原生行为），
   游戏页收到就弹一个小条：「素材已更新 · 点击刷新」。

   两个容易踩的点：
     · `storage` 事件**只发给别的标签页**，不发给写入者自己 ——
       所以编辑器自己不会闪，正合需要；
     · 写 localStorage 可能抛错（隐私模式 / 配额满），一律吞掉：
       通知只是顺手的体验优化，绝不能因为它让"保存"失败。
   ============================================================ */

/** 消息用的键。带项目前缀，免得和别的页面撞。 */
export const ASSETS_SAVED_KEY = 'qjb-arena:assets-saved';

/** 编辑器保存成功后调用（写在 localStorage 里给别的标签页看） */
export function notifyAssetsSaved(summary) {
  try {
    const g = globalThis;
    if (!g.localStorage) return false;
    g.localStorage.setItem(ASSETS_SAVED_KEY, JSON.stringify({
      at: Date.now(),
      summary: String(summary == null ? '' : summary).slice(0, 400),
    }));
    return true;
  } catch (e) {
    return false;      // 通知失败不影响保存本身
  }
}

/** 游戏页调用：装上监听。返回"卸载"函数（诊断里要用）。
 *  @param onSaved 收到消息时调用，参数 { at, summary } */
export function installLiveReload(onSaved) {
  const w = globalThis.window;
  if (!w || typeof w.addEventListener !== 'function') return () => {};
  const handler = (e) => {
    if (!e || e.key !== ASSETS_SAVED_KEY || !e.newValue) return;
    let info = null;
    try { info = JSON.parse(e.newValue); } catch (err) { info = null; }
    if (typeof onSaved === 'function') onSaved(info || {});
  };
  w.addEventListener('storage', handler);
  return () => w.removeEventListener('storage', handler);
}

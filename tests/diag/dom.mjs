/* Inspect the real DOM structure of the battle screen and the widths that
   the code would read. Catches "parentElement is not what you think" bugs.
   (ASCII only.) */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { parseHTML } from 'linkedom';
import { readFileSync } from 'node:fs';

const { window, document } = parseHTML('<!DOCTYPE html><html><body><div id="app"></div></body></html>');
globalThis.window = window;
globalThis.document = document;
globalThis.performance = globalThis.performance || { now: () => Date.now() };
const loc = { _h: '', get hash() { return this._h; }, set hash(v) { this._h = String(v); } };
globalThis.location = loc; window.location = loc;
window.devicePixelRatio = 1;
window.scrollTo = () => {};
window.requestAnimationFrame = () => 0;
globalThis.requestAnimationFrame = window.requestAnimationFrame;
const st = new Map();
const storage = {
  getItem: k => (st.has(k) ? st.get(k) : null),
  setItem: (k, v) => st.set(k, String(v)),
  removeItem: k => st.delete(k), clear: () => st.clear()
};
globalThis.localStorage = storage; window.localStorage = storage;
if (typeof ResizeObserver === 'undefined') globalThis.ResizeObserver = class { observe() {} disconnect() {} };

const ctxStub = new Proxy({}, {
  get(_t, p) {
    if (p === 'canvas') return { width: 100, height: 100 };
    if (p === 'createRadialGradient' || p === 'createLinearGradient') return () => ({ addColorStop() {} });
    if (p === 'measureText') return () => ({ width: 10 });
    return () => {};
  },
  set() { return true; }
});
window.HTMLCanvasElement.prototype.getContext = () => ctxStub;

const { makeUnitStats, DEFAULT_RULES } = await import('../../js/balls.js');
const { ARENA_BY_ID } = await import('../../js/arenas.js');
const { renderBattle } = await import('../../js/ui-battle.js');

const root = document.getElementById('app');
renderBattle(root, {
  teams: [
    { units: [{ slot: 0, stats: makeUnitStats('test') }] },
    { units: [{ slot: 100, stats: makeUnitStats('test') }] }
  ],
  arena: ARENA_BY_ID['rect'],
  sizeScale: 0.5,
  rules: { ...DEFAULT_RULES },
  playerSlot: null
}, () => {});

const canvas = root.querySelector('#battleCanvas');
console.log('canvas found:', !!canvas);
console.log('canvas tagName:', canvas && canvas.tagName);

// walk up the ancestor chain
let el = canvas;
const chain = [];
while (el && chain.length < 8) {
  chain.push({
    tag: el.tagName,
    id: el.id || '',
    cls: (typeof el.className === 'string' ? el.className : '') || '',
    style: el.getAttribute ? (el.getAttribute('style') || '') : ''
  });
  el = el.parentElement;
}
console.log('\nDOM chain from canvas upward:');
for (const c of chain) {
  console.log(`  <${c.tag}${c.id ? ' id=' + c.id : ''}${c.cls ? ' class="' + c.cls + '"' : ''}>${c.style ? '  style=' + c.style : ''}`);
}

console.log('\n--- what the code reads ---');
const host = canvas.parentElement;
console.log('  canvas.parentElement  =', host && `<${host.tagName} class="${host.className}">`);
console.log('  host === the div holding canvas+playbar? ',
  !!(host && host.querySelector && host.querySelector('#btPlay')));

console.log('\n--- expected structure check ---');
const wrap = root.querySelector('.battle-wrap');
console.log('  .battle-wrap found:', !!wrap);
if (wrap) {
  console.log('  .battle-wrap children:', wrap.children.length);
  for (const c of wrap.children) {
    console.log(`    - <${c.tagName} class="${c.className}">`);
  }
}
console.log('\n  canvas is first child of .battle-wrap\'s first child? ',
  !!(wrap && wrap.children[0] && wrap.children[0].children[0] === canvas));

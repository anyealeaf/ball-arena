/* ============================================================
   check-asset-schema.mjs — 素材编辑器"每个旋钮都拧得动"自检
   ------------------------------------------------------------
     node tools/check-asset-schema.mjs

   编辑器上的每个控件，背后都是"在某个锚点之后改某个键"。
   锚点写错、或者不够具体（同名键有好几个），并不会在界面上表现出来 ——
   要等到作者拖了滑块、点了保存，才会发现"写不进去"或者"改错了地方"。
   所以这里把**每一个字段**都在真实源码上试算一遍：

     · 锚点存在且唯一；
     · 锚点之后的窗口里该键只出现一次；
     · 试写一个值，能读回同样的值（往返一致）。

   任何一条不过就退出码 1 —— 加了新旋钮忘了配锚点，这里立刻红。
   ============================================================ */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASSET_GROUPS, EDIT_FILES, allFields } from '../js/asset-schema.js';
import { locateField, patchField } from './lib/asset-patch.mjs';
/* 编辑器读"现值"用的就是这份命名空间（field.key 即导出名）—— 见下面的守卫 */
import * as RENDER from '../js/render.js';
/* 数值字段的 pick 路径解析到这两份真实配置上（球种表 + 技能参数表） */
import { SPECIES_BY_ID } from '../js/balls.js';
import { YUNCAI, TAOYAO, TINA, JIANQING } from '../js/skills.js';

const PICK_ROOTS = { SPECIES_BY_ID, YUNCAI, TAOYAO, TINA, JIANQING };

const ROOT = join(import.meta.dirname, '..');
const cache = new Map();
const srcOf = (short) => {
  if (!cache.has(short)) {
    const rel = EDIT_FILES[short];
    if (!rel) throw new Error(`不在白名单里的文件短名：${short}`);
    cache.set(short, readFileSync(join(ROOT, rel), 'utf8'));
  }
  return cache.get(short);
};

let pass = 0, fail = 0;
const log = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; log.push(`  ✅ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; log.push(`  ❌ ${name}${detail ? '  — ' + detail : ''}`); }
};

const fields = allFields();
console.log('=========== 素材编辑器 · 旋钮自检 ===========');
console.log(`共 ${ASSET_GROUPS.length} 组 / ${fields.length} 个字段\n`);

const ids = new Set();
for (const f of fields) {
  if (ids.has(f.id)) check(`字段 id 唯一：${f.id}`, false, '重复的 id 会让两个控件抢同一份状态');
  ids.add(f.id);
}
check('字段 id 全局唯一', true, `${ids.size} 个`);

/* ---------- 编辑器能不能读到"现值" ----------
   编辑器生成控件时是拿 field.key **按导出名**去 render.js 取的
   （见 ui-assets.js 的 liveValue）。如果 key 打错、或者常量被改名，
   liveValue 会返回 undefined —— 界面不会报错，只会显示成**空白输入框**、
   滑条停在中间，作者以为"这个参数是空的"。
   上一轮加开华常量时就踩过：清单忘登记，四个旋钮全是空白。
   所以这里逐个核：只要是 render 文件的字段，那个导出名必须真的存在。 */
{
  const missing = fields
    .filter(f => f.file === 'render')
    .filter(f => RENDER[f.key] === undefined);
  check('render 的字段都能按导出名取到现值（否则编辑器里是空白框）',
    missing.length === 0,
    missing.length ? missing.map(f => `${f.item}.${f.key}`).join(', ') : `${fields.filter(f => f.file === 'render').length} 个字段都能取到`);
}

/* ---------- 「数值（平衡）」的 pick 路径也要能取到值 ----------
   数值字段的 key 很短（`damage`、`cd`、`hp`），光靠它推不出属于哪个技能，
   所以字段上带一个 pick 点分路径（例如 `YUNCAI.modan`）。
   路径写错同样是**静默的空白框**，这里逐个真解析一遍。 */
{
  const picked = fields.filter(f => f.pick);
  const resolve = (path) => {
    const parts = String(path).split('.');
    let v = PICK_ROOTS[parts[0]];
    for (let i = 1; i < parts.length && v != null; i++) v = v[parts[i]];
    return v;
  };
  const missing = picked.filter(f => {
    const obj = resolve(f.pick);
    return !obj || obj[f.key] === undefined;
  });
  check('带 pick 的数值字段都能取到现值（否则编辑器里是空白框）',
    missing.length === 0,
    missing.length
      ? missing.map(f => `${f.item}.${f.pick}.${f.key}`).join(', ')
      : `${picked.length} 个数值字段都能取到（${[...new Set(picked.map(f => f.pick))].length} 个技能/球种对象）`);
  check('数值（平衡）这一组确实有字段（别把整组删空了还以为在跑）',
    picked.length >= 40, `${picked.length} 个`);
}

for (const f of fields) {
  const label = `[${f.item} · ${f.id}]`;
  const src = srcOf(f.file);
  let loc = null;
  try {
    loc = locateField(src, f);
  } catch (e) {
    check(`${label} 定位`, false, e.message);
    continue;
  }
  check(`${label} 定位`, true, `${EDIT_FILES[f.file]}:${loc.lineNo}  现值 ${loc.before}`);

  /* 往返一致：写一个同类型的合法值，再读回来必须一样。
     数字用"现值 + 1 步"（保证与现值不同），字符串/颜色用固定值。 */
  let probe;
  if (f.type === 'number') probe = Number(loc.before) + (f.step || 1);
  else if (f.type === 'bool') probe = !/true/.test(loc.before);
  else if (f.type === 'color') probe = loc.before.toLowerCase() === "'#123456'" ? '#654321' : '#123456';
  /* 数字数组：每个元素 +1 步 —— 保证与现值不同，且**元素个数不变**
     （个数变化会掩盖"只改了这一处"的判断） */
  else if (f.type === 'nums') {
    const arr = JSON.parse(loc.before);
    probe = arr.map(v => Number(v) + (f.step || 1));
  } else probe = 'assets/characters/__probe__.png';

  try {
    const out = patchField(src, f, probe);
    const back = locateField(out.src, f);
    check(`${label} 往返一致`, back.before === out.after,
      `${loc.before} → ${out.after} → 读回 ${back.before}`);
    /* 只动了这一个值：别处的字节数变化必须恰好等于值长度的变化 */
    const delta = out.src.length - src.length;
    check(`${label} 只改了这一处`, delta === out.after.length - loc.before.length,
      `长度变化 ${delta}`);
  } catch (e) {
    check(`${label} 试写`, false, e.message);
  }
}

/* 反向断言：故意把锚点写错，必须**拒绝**而不是改到别处 */
{
  const bad = { id: 'bad', key: 'bowH', type: 'number', file: 'balls', anchor: '不存在的锚点' };
  let threw = false;
  try { locateField(srcOf('balls'), bad); } catch { threw = true; }
  check('锚点不存在时必须报错（而不是默默改到别处）', threw);

  const amb = { id: 'amb', key: 'r', type: 'number', file: 'balls', anchor: 'sticker: {', window: 200 };
  let threw2 = false;
  try { locateField(srcOf('balls'), amb); } catch { threw2 = true; }
  check('窗口内同名键有多个时也必须报错', threw2);

  let threw3 = false;
  try { locateField(srcOf('balls'), { id: 'x', key: 'r', type: 'number', file: 'balls', anchor: 'sticker: {' , window: 10 }); } catch { threw3 = true; }
  check('窗口内找不到键时也必须报错', threw3);
}

console.log(log.join('\n'));
console.log(`\n=========== 通过 ${pass} 项，失败 ${fail} 项 ===========`);
process.exit(fail ? 1 : 0);

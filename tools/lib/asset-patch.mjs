/* ============================================================
   asset-patch.mjs — 把"某个锚点之后的某个键"安全地改成新值
   ------------------------------------------------------------
   给「素材编辑器」写回源码用。设计原则只有一条：
   **宁可拒绝，也不猜。** 这个函数改的是人写的源码，改错地方
   可能悄悄把别的数值改掉（那比不生效难查得多），所以：

     1. 锚点必须在整个文件里**只出现一次**；
     2. 锚点之后（受 stop 限制的窗口内）该键必须**只出现一次**；
     3. 只替换"键: 值"里的**值**那一段 —— 后面的逗号、分号、注释都原样留着；
     4. 返回值带上改前/改后的那一行，界面能原样显示给作者核对。

   任何一条不满足 → throw，并说清是哪一条、在哪一行附近。
   离线自检：node tools/check-asset-schema.mjs（把每个字段都试算一次）
   ============================================================ */

/** 转义正则里的特殊字符 */
function rx(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把注释内容替换成等长空格（换行保留）—— **长度与偏移完全不变**。
 *
 *  为什么必须这么做：注释里会写到键名。例如
 *    `**不配 spritePulse = 这一枚不呼吸**`
 *  这行注释里的 `spritePulse =` 会被"找键"的正则当成真代码命中，
 *  于是同一个字段在窗口里"出现了 2 次"、直接拒绝写入（实测踩到）。
 *  锚点与 stop 反过来**通常就是注释**（`/* ② 魔弹 *​/`、`// ---------- 荣 ----------`），
 *  所以那两个在原文里找，键在掩码后的文本里找。 */
function maskComments(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i++; }
    } else if (c === '/' && src[i + 1] === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n' && src[i] !== '\r') out[i] = ' ';
        i++;
      }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
    } else if (c === "'" || c === '"' || c === '`') {
      /* 字符串里的注释符号不算注释 —— 跳过整个字符串 */
      const q = c; i++;
      while (i < n && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      i++;
    } else i++;
  }
  return out.join('');
}

/** 求某个字段在源码里的位置。返回 { start, end, line, lineNo, before } */
export function locateField(src, field) {
  const { key, anchor, window: win = 80, stop } = field;
  if (!key) throw new Error('字段缺少 key');
  if (!anchor) throw new Error(`字段 ${key} 缺少 anchor`);

  /* 1) 锚点唯一 */
  const first = src.indexOf(anchor);
  if (first < 0) throw new Error(`锚点找不到：${JSON.stringify(anchor)}`);
  if (src.indexOf(anchor, first + 1) >= 0) {
    throw new Error(`锚点不唯一（出现多次）：${JSON.stringify(anchor)} —— 换一个更具体的锚点`);
  }

  /* 2) 窗口：**从锚点本身**开始数 win 个字符，遇到 stop 就提前结束。
     为什么从锚点开头而不是结尾：有些字段的锚点就是把键名本身写进去的
     （例如 `const PROJ_ALPHA_MIN` —— 它出现两次，只有带上 `const` 才唯一），
     那样键就落在锚点内部；从结尾开始找会永远找不到。 */
  const winStart = first;
  let winEnd = Math.min(src.length, winStart + win);
  if (stop) {
    const si = src.indexOf(stop, winStart + anchor.length);
    if (si >= 0 && si < winEnd) winEnd = si;
  }
  /* 3) 键唯一（支持 `键:` 与 `键 =` 两种写法）—— 在**去注释**的文本里找，
        否则注释里提到键名就会被误当成代码（见 maskComments 的说明）。 */
  const masked = maskComments(src);
  const seg = masked.slice(winStart, winEnd);
  const re = new RegExp('\\b' + rx(key) + '\\s*[:=]', 'g');
  const hits = [...seg.matchAll(re)];
  if (hits.length === 0) {
    throw new Error(`锚点之后没找到键 ${key}（窗口 ${win} 字符）`);
  }
  if (hits.length > 1) {
    throw new Error(`锚点之后键 ${key} 出现了 ${hits.length} 次 —— 窗口太大或锚点不够具体`);
  }
  const at = winStart + hits[0].index;
  const keyEnd = at + hits[0][0].length;

  /* 4) 值的范围：从键后面的空白开始，到下一个 , 或 ; 或换行为止。
        例外：值以 `[` 开头（数字数组，例如 `dmgByStage: [1, 2]`）——
        数组里的逗号不是"值的结束"，要一路扫到配对的 `]` 才算完，
        否则 before 会变成半个 `[1`（实测：JSON 解析直接抛错）。
        这里只需要支持**一维、无嵌套、无字符串**的数组，也就是数值编辑器要写的那种；
        真出现嵌套结构会扫到深度归零为止，仍然安全（不会切错位置）。 */
  let vs = keyEnd;
  while (vs < src.length && (src[vs] === ' ' || src[vs] === '\t')) vs++;
  let ve = vs;
  if (src[vs] === '[') {
    let depth = 0;
    while (ve < src.length) {
      const c = src[ve];
      if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) { ve++; break; } }
      else if (c === '\n' && depth === 0) break;
      ve++;
    }
  } else {
    /* 结束符除了 `,` `;` 换行，还要含 `}` 与 `)` —— 行内对象/调用里的值
       是靠括号收尾的：`domain: { dodge: 0.10, dodgeBloomed: 0.15 },`
       若只认逗号，最后一个值会被读成 `0.15 }`（Number → NaN，实测踩到）。 */
    while (ve < src.length && src[ve] !== ',' && src[ve] !== ';' &&
           src[ve] !== '\n' && src[ve] !== '\r' && src[ve] !== '}' && src[ve] !== ')') ve++;
  }
  /* 值末尾的空格不吞 */
  while (ve > vs && (src[ve - 1] === ' ' || src[ve - 1] === '\t')) ve--;

  const lineStart = src.lastIndexOf('\n', at) + 1;
  const lineEnd = src.indexOf('\n', at);
  return {
    start: vs, end: ve,
    before: src.slice(vs, ve),
    line: src.slice(lineStart, lineEnd < 0 ? src.length : lineEnd).trim(),
    lineNo: src.slice(0, at).split('\n').length
  };
}

/** 把值格式化成源码里的写法 */
export function formatValue(type, value) {
  if (type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`不是有限数：${value}`);
    return String(Math.round(n * 1e6) / 1e6);
  }
  if (type === 'bool') return value ? 'true' : 'false';
  if (type === 'color') {
    const s = String(value).trim();
    if (!/^#[0-9a-f]{6}$/i.test(s)) throw new Error(`颜色要写成 #rrggbb：${s}`);
    return `'${s.toLowerCase()}'`;
  }
  if (type === 'text') {
    const s = String(value);
    if (s.includes("'") || s.includes('\n')) throw new Error('文本不能含单引号或换行');
    return `'${s}'`;
  }
  /* 一维数字数组（例如裁光的 `dmgByStage: [1, 2]`）。
     值可以传数组，也可以传界面上的 "1, 2" 这种字符串 ——
     两种写法都收，因为作者在输入框里敲的就是后者。
     **不接受嵌套/非数字**：这里是改数值，不是写代码。 */
  if (type === 'nums') {
    const arr = Array.isArray(value)
      ? value
      : String(value).split(/[,，\s]+/).filter(s => s !== '');
    if (!arr.length) throw new Error('数组不能为空');
    if (arr.length > 8) throw new Error('数组元素太多（最多 8 个）');
    const nums = arr.map(v => {
      const x = Number(v);
      if (!Number.isFinite(x)) throw new Error(`不是数字：${v}`);
      if (Math.abs(x) > 1e6) throw new Error(`数字太大：${v}`);
      return Math.round(x * 1e6) / 1e6;
    });
    return `[${nums.join(', ')}]`;
  }
  throw new Error(`不认识的字段类型：${type}`);
}

/**
 * 在源码里替换一个字段的值。
 * @returns {{src: string, before: string, after: string, lineNo: number, line: string}}
 */
export function patchField(src, field, value) {
  const loc = locateField(src, field);
  const after = formatValue(field.type, value);
  return {
    src: src.slice(0, loc.start) + after + src.slice(loc.end),
    before: loc.before, after, lineNo: loc.lineNo, line: loc.line
  };
}

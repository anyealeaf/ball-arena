/* 通过二分 + 逐步排除，定位 JS 文件中导致 "Invalid or unexpected token" 的字符位置。
 * 该错误是词法级错误，会在编译最早期抛出，且通常不带行号。
 * 用法：node tools/scan-token.mjs js/core.js
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] || 'js/core.js';
const src = readFileSync(file, 'utf8');

/* 逐字符扫描：找出所有不属于合法 JS 源码的字符（控制字符、U+FFFD、NBSP 等），
   以及不配对的引号位置。 */
const illegal = [];
for (let i = 0; i < src.length; i++) {
  const c = src.charCodeAt(i);
  const ch = src[i];
  // 允许的空白：空格、制表、换行、回车
  const okWs = c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D;
  // 控制字符
  if (c < 0x20 && !okWs) illegal.push({ i, c, kind: '控制字符' });
  else if (c === 0xA0) illegal.push({ i, c, kind: '不换行空格 NBSP' });
  else if (c === 0xFEFF && i !== 0) illegal.push({ i, c, kind: 'BOM 出现在文件中部' });
  else if (c === 0x2028 || c === 0x2029) illegal.push({ i, c, kind: '行/段分隔符' });
  else if (c === 0xFFFD) illegal.push({ i, c, kind: '替换字符 U+FFFD' });
  else if (c === 0x200B || c === 0x200C || c === 0x200D) illegal.push({ i, c, kind: '零宽字符' });
}

function lineOf(idx) { return src.slice(0, idx).split('\n').length; }

console.log(`${file} 长度 ${src.length} 字符`);
if (!illegal.length) {
  console.log('未发现非法字符');
} else {
  console.log(`发现 ${illegal.length} 个可疑字符：`);
  for (const x of illegal.slice(0, 10)) {
    console.log(`  第 ${lineOf(x.i)} 行  偏移 ${x.i}  ${x.kind} (U+${x.c.toString(16).toUpperCase()})`);
    const ls = src.split('\n')[lineOf(x.i) - 1];
    console.log(`    ${ls.slice(0, 120)}`);
  }
}

/* 再检查引号配平：逐行统计未转义的 ' 和 " ，奇偶失衡通常就是问题所在 */
console.log('\n检查字符串引号配平（仅看非注释部分，粗略）：');
const lines = src.split('\n');
for (let n = 0; n < lines.length; n++) {
  const raw = lines[n];
  const code = raw.replace(/\/\/.*$/, '');
  let s = 0, d = 0, bt = 0;
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '\\') { i++; continue; }
    if (code[i] === "'") s++;
    else if (code[i] === '"') d++;
    else if (code[i] === '`') bt++;
  }
  if (s % 2 || d % 2 || bt % 2) {
    console.log(`  第 ${n + 1} 行引号数为奇数: '=${s} "=${d} \`=${bt}`);
    console.log(`    ${raw.trim().slice(0, 130)}`);
  }
}

/* 二分定位词法级语法错误（"Invalid or unexpected token"）。
 * 这类错误不依赖上下文，所以可用行切片二分；截断产生的
 * "Unexpected end of input" 要排除掉。
 * 用法：node tools/locate-lexerror.mjs js/core.js
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const file = process.argv[2] || 'js/core.js';
const lines = readFileSync(file, 'utf8').split('\n');
const probe = '.lexprobe.mjs';

/** 返回该切片是否触发了"词法级"错误 */
function lexError(n) {
  writeFileSync(probe, lines.slice(0, n).join('\n') + '\n', 'utf8');
  try {
    execFileSync(process.execPath, ['--check', probe], { stdio: 'pipe' });
    return null;
  } catch (e) {
    const msg = (e.stderr ? e.stderr.toString() : '') + (e.stdout ? e.stdout.toString() : '');
    if (/Unexpected end of input|Unexpected token '}'|Unexpected token '\)'/.test(msg)) return null; // 截断
    const m = /Invalid or unexpected token/.exec(msg);
    return m ? msg : null;
  }
}

let lo = 1, hi = lines.length, found = -1;
while (lo <= hi) {
  const mid = (lo + hi) >> 1;
  if (lexError(mid)) { found = mid; hi = mid - 1; }
  else lo = mid + 1;
}

try { unlinkSync(probe); } catch { /* ignore */ }

if (found < 0) {
  console.log('未检出词法级错误（该文件的语法问题可能是结构性的）');
} else {
  console.log(`词法错误首个出现在第 ${found} 行附近：`);
  for (let i = Math.max(0, found - 4); i < Math.min(lines.length, found + 2); i++) {
    console.log(`${String(i + 1).padStart(5)}${i + 1 === found ? ' >>>' : '    '} ${lines[i]}`);
  }
  const snippet = lines[found - 1];
  console.log('\n该行字符码点：');
  console.log('  ' + [...snippet].map(c => {
    const cc = c.codePointAt(0);
    return cc > 126 || cc < 32 ? `[${c}=U+${cc.toString(16).toUpperCase()}]` : c;
  }).join('').slice(0, 200));
}

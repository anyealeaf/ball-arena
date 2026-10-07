/* 定位 core.js 的语法错误位置：逐行累加编译，找第一个失败的边界。 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const file = process.argv[2] || 'js/core.js';
const lines = readFileSync(file, 'utf8').split('\n');
console.log(`${file} 共 ${lines.length} 行`);

/* 用一个宽松的解析方式：把源码包进函数体里逐行尝试。
   模块语法（import/export）会干扰，所以先剥掉它们。 */
const cleaned = lines.map(l =>
  /^\s*(import|export)\s/.test(l) ? l.replace(/^\s*(import|export)\s+/, '') : l
);

let firstBad = -1;
for (let n = 1; n <= cleaned.length; n++) {
  const src = cleaned.slice(0, n).join('\n');
  try {
    new vm.Script(src, { filename: file });
  } catch (e) {
    // 只有当错误出现在"新增的那一行"时才算真正定位到
    if (e instanceof SyntaxError) {
      const m = /:(\d+)/.exec(e.stack || '');
      const at = m ? Number(m[1]) : -1;
      if (at === n || at === -1) { firstBad = n; break; }
    }
  }
}

if (firstBad < 0) {
  console.log('未检出逐步编译错误（可能是模块级语法问题）');
} else {
  console.log(`\n首个可疑位置：第 ${firstBad} 行`);
  for (let i = Math.max(0, firstBad - 4); i < Math.min(lines.length, firstBad + 3); i++) {
    console.log(`${String(i + 1).padStart(5)}${i + 1 === firstBad ? ' >>>' : '    '} ${lines[i]}`);
  }
}

/* 额外检查：全角字符混入代码（中文注释以外的地方） */
const suspicious = [];
lines.forEach((l, i) => {
  const code = l.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (/[\uFF08\uFF09\uFF0C\uFF1A\uFF1B\u201C\u201D\u2018\u2019]/.test(code)) {
    suspicious.push(i + 1);
  }
});
if (suspicious.length) {
  console.log(`\n代码区（非注释）出现全角标点的行：${suspicious.join(', ')}`);
  for (const n of suspicious.slice(0, 5)) console.log(`  ${n}: ${lines[n - 1].trim().slice(0, 110)}`);
}

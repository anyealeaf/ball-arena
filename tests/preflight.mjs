/* 上线前自检：导入路径 + 模块加载 + DOM 依赖 + 常见浏览器错误 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const gameRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const jsDir = join(gameRoot, 'js');

console.log('=== 1. import 路径完整性 ===');
let bad = 0;
for (const f of readdirSync(jsDir).filter(x => x.endsWith('.js'))) {
  const src = readFileSync(join(jsDir, f), 'utf8');
  const re = /from\s+['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const target = join(jsDir, m[1].replace(/^\.\//, ''));
    if (!existsSync(target)) { console.log(`  ❌ ${f} -> ${m[1]}`); bad++; }
  }
}
console.log(bad ? `  发现 ${bad} 个坏路径` : '  ✅ 所有相对 import 都存在');

console.log('\n=== 2. index.html 引用的资源是否存在 ===');
const html = readFileSync(join(gameRoot, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]);
for (const r of refs) {
  const p = join(gameRoot, r);
  console.log(`  ${existsSync(p) ? '✅' : '❌'} ${r}`);
}

console.log('\n=== 3. 逐个模块导入（捕获顶层运行时错误）===');
const mods = ['balls', 'arenas', 'core', 'render', 'sketch', 'ui-codex', 'ui-prepare', 'ui-battle'];
for (const m of mods) {
  try {
    await import(`file:///${join(jsDir, m + '.js').replace(/\\/g, '/')}`);
    console.log(`  ✅ ${m}.js`);
  } catch (e) {
    console.log(`  ❌ ${m}.js  ${e.message}`);
  }
}

console.log('\n=== 4. 浏览器全局依赖检查（这些在 Node 里没有，浏览器里有）===');
// 扫描模块里用到的浏览器 API，确认它们在浏览器中确实存在
const browserApis = ['document', 'window', 'localStorage', 'requestAnimationFrame',
  'performance', 'location', 'Image', 'devicePixelRatio', 'getContext'];
for (const m of mods.concat(['main'])) {
  const src = readFileSync(join(jsDir, m + '.js'), 'utf8');
  const used = browserApis.filter(a => new RegExp(`\\b${a}\\b`).test(src));
  if (used.length) console.log(`  ${m}.js 使用: ${used.join(', ')}`);
}

console.log('\n=== 5. 检查是否有 file:// 下会失败的东西 ===');
const allSrc = mods.concat(['main']).map(m => readFileSync(join(jsDir, m + '.js'), 'utf8')).join('\n');
const issues = [];
if (/fetch\(/.test(allSrc)) issues.push('使用了 fetch');
if (/import\s*\(/.test(allSrc)) issues.push('使用了动态 import()');
if (/new Worker/.test(allSrc)) issues.push('使用了 Worker');
if (/\.wasm/.test(allSrc)) issues.push('引用了 wasm');
console.log(issues.length ? '  注意: ' + issues.join('; ') : '  ✅ 无 fetch / Worker / wasm 依赖');
console.log('  模块化脚本（type="module"）在 file:// 下会被 CORS 拦截 —— 必须走 HTTP 服务器');

console.log('\n=== 6. 检查核心文件大小与关键导出 ===');
const core = await import(`file:///${join(jsDir, 'core.js').replace(/\\/g, '/')}`);
console.log(`  core.js 导出: ${Object.keys(core).join(', ')}`);
const balls = await import(`file:///${join(jsDir, 'balls.js').replace(/\\/g, '/')}`);
console.log(`  balls.js 导出: ${Object.keys(balls).join(', ')}`);
const arenas = await import(`file:///${join(jsDir, 'arenas.js').replace(/\\/g, '/')}`);
console.log(`  arenas.js 导出: ${Object.keys(arenas).join(', ')}`);
console.log(`  球种数: ${balls.SPECIES.length}, 场地数: ${arenas.ARENAS.length}`);

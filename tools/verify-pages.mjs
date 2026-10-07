// verify-pages.mjs — 发布后回读验证
//
//   node tools/verify-pages.mjs <user> <repo>
//
// 为什么要单独做：手册第 7.4 节明确要求「发布后必做回读验证」——
// 只看上传脚本的退出码不算数，要真的从线上拉一遍关键资源，
// 确认拿到的是真内容（而不是 GitHub 的 404 页面，或者被缓存住的旧版本）。
//
// 顺便记两条 Pages 的脾气（手册实测）：
//   · 首次发布要 1~2 分钟才出站点；
//   · 全站 Cache-Control: max-age=600，改动最多 10 分钟才可见 ——
//     所以这里给 URL 加一个时间戳参数绕开缓存，否则会误判成"没推上去"。
const USER = process.argv[2];
const REPO = process.argv[3];
if (!USER || !REPO) {
  console.error('用法: node tools/verify-pages.mjs <user> <repo>');
  process.exit(1);
}
const BASE = `https://${USER}.github.io/${REPO}/`;
const bust = () => `?v=${Date.now()}`;

/* 新鲜度抽查要读本地的 js/balls.js 来现取球种清单（见文件末尾） */
import fs from 'node:fs/promises';

/* 要抽查的资源：入口、引擎、音效、技能表、样式、文档。
   角色贴图**不写在这里** —— 它们由下面的 `characterAssets` 从本地球种表自动取。
   为什么要自动取：贴图最容易因为路径大小写或漏传而 404，
   而 404 页面也是 200 之外最常见的坑（靠 content-type 判定）。
   写死清单的话，每加一个角色都要记得回来加一行 —— **我自己就忘过**：
   加缇娜时补了球种 id 的检查，贴图那几行漏了。
   从 balls.js 现取就永远不会漏，也不需要谁记得。 */
const CHECKS = [
  ['index.html', 'text/html', 'HTML 入口'],
  ['js/main.js', 'javascript', '入口脚本'],
  ['js/core.js', 'javascript', '战斗引擎'],
  ['js/skills.js', 'javascript', '技能表'],
  ['js/audio.js', 'javascript', '音效模块'],
  ['css/styles.css', 'css', '样式'],
  ['README.md', '', '说明文档'],
];

/* 每个球种用到的所有贴图。
   **不逐个字段去取**（src / frames / idle / draw / arrow …），而是把球种配置
   整棵对象扫一遍，凡是"看起来像图片路径"的字符串都算 —— 字段名各角色不一样
   （桃夭的弓用 idle/draw/arrow 而不是 src），按名字取一定会漏。 */
const IMG_RE = /\.(png|jpe?g|webp|gif)$/i;
const characterAssets = new Map();
function collect(sp, node, path) {
  if (!node) return;
  if (typeof node === 'string') {
    if (IMG_RE.test(node)) characterAssets.set(node, `${sp.name}·${path}`);
    return;
  }
  if (Array.isArray(node)) { node.forEach((v, i) => collect(sp, v, `${path}[${i}]`)); return; }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) collect(sp, node[k], path ? `${path}.${k}` : k);
  }
}
try {
  const { SPECIES } = await import('../js/balls.js');
  for (const sp of SPECIES) collect(sp, sp, '');
} catch (e) {
  console.error(`✘ 读不到球种表，无法自动列出贴图：${e.message}`);
  process.exit(1);
}
for (const [src, label] of characterAssets) CHECKS.push([src, 'image/', label]);

console.log(`验证站点: ${BASE}\n`);
let bad = 0;
/* 线上可能落后于本地（发布是按需触发的），所以长度对不上本身不是错误，
   但**必须显式报出来** —— 否则"拿到旧缓存"和"内容是对的"看起来一模一样。
   这条是实测踩出来的：第一次回读十个资源全 200 就报了"通过"，
   结果引擎 97 KB（实际 105 KB）、技能表 30 KB（实际 47 KB），
   全是推送前的旧缓存。旧的 balls.js 配新的 index.html 页面能开、不报错，
   只有进游戏才会发现少角色 —— 看响应码永远发现不了。 */
const stale = [];

for (const [path, wantType, label] of CHECKS) {
  const url = BASE + path + bust();
  try {
    const r = await fetch(url, { redirect: 'follow' });
    const buf = new Uint8Array(await r.arrayBuffer());
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const typeOk = !wantType || ct.includes(wantType);
    const ok = r.status === 200 && buf.length > 0 && typeOk;
    if (!ok) bad++;
    /* 本地也有这个文件就比一下长度（逐字节比对内容，长度不同必然不同） */
    let localLen = null;
    try {
      localLen = (await fs.stat(new URL('../' + path, import.meta.url))).size;
    } catch { /* 本地没有这个文件（比如只存在线上的），跳过比对 */ }
    const same = localLen === null || localLen === buf.length;
    if (!same) stale.push({ label, path, served: buf.length, local: localLen });
    const mark = same ? '✅' : '⚠️ ';
    console.log(`  ${ok ? mark : '❌'} ${label.padEnd(10)} ${String(r.status).padStart(3)} ` +
      `${String(buf.length).padStart(8)} bytes  ${ct.split(';')[0]}` +
      (same ? '' : `  ← 本地 ${localLen} bytes（线上是旧版本）`));
  } catch (e) {
    bad++;
    console.log(`  ❌ ${label.padEnd(10)} 请求失败: ${e.message}`);
  }
}

/* 内容抽查：index.html 必须用**相对**路径。
   Pages 项目页挂在 /<repo>/ 下，绝对路径（/js/main.js）会指到域名根目录去，
   线上表现为"页面出来了但一片空白"。 */
try {
  const html = await (await fetch(BASE + 'index.html' + bust())).text();
  const rel = html.includes('css/styles.css');
  const abs = /(?:src|href)="\//.test(html);
  console.log('');
  console.log(`  ${rel ? '✅' : '❌'} index.html 用相对路径引用资源`);
  console.log(`  ${!abs ? '✅' : '❌'} index.html 没有域名根绝对路径（Pages 项目页会挂）`);
  if (!rel || abs) bad++;
} catch (e) {
  bad++;
  console.log(`  ❌ 读取 index.html 失败: ${e.message}`);
}

/* 新鲜度抽查：线上的 js/balls.js 必须**包含本地每一个球种 id**。
   为什么要这么测：Pages 全站 max-age=600，刚发完常常拿到的是旧缓存，
   而"旧的 balls.js + 新的 index.html"这种半新半旧的组合看起来完全正常，
   只有进游戏才会发现少了角色 —— 靠肉眼看响应码是看不出来的。
   判据从本地文件现取，所以**加了新角色不用改这里**。 */
try {
  const localSpec = await fs.readFile(new URL('../js/balls.js', import.meta.url), 'utf8');
  /* 球种条目的写法是 `id: 'xxx',` —— 从本地文件里把它们抽出来 */
  const ids = [...localSpec.matchAll(/^\s{4}id:\s*'([a-z0-9_]+)'/gim)].map(m => m[1]);
  const served = await (await fetch(BASE + 'js/balls.js' + bust())).text();
  const missing = ids.filter(id => !served.includes(`'${id}'`));
  const ok = ids.length > 0 && missing.length === 0;
  console.log('');
  console.log(`  ${ok ? '✅' : '❌'} 线上球种与本地一致 ` +
    `（本地 ${ids.length} 个：${ids.join('、')}）`);
  if (!ok) {
    console.log(`     线上缺少: ${missing.join('、') || '（本地没抽到球种 id，正则可能失效了）'}`);
    bad++;
  }
} catch (e) {
  bad++;
  console.log(`  ❌ 新鲜度抽查失败: ${e.message}`);
}

/* 收尾：把"线上落后于本地"的资源汇总报出来。
   这不是错误（发布是按需触发的），但**绝不能不吭声** ——
   否则下一次"发布完了吗"就得靠人肉翻代码。 */
if (stale.length) {
  console.log('');
  console.log(`  ⚠️  ${stale.length} 个资源线上仍是旧版本（发布按需触发，属正常）：`);
  for (const s of stale) {
    console.log(`     ${s.label}（${s.path}）：线上 ${s.served} / 本地 ${s.local} bytes`);
  }
  console.log('     刚推完就出现这一栏 → CDN 还没刷完，等 1~2 分钟再跑一次。');
}

console.log('');
if (bad === 0) {
  console.log('✅ 线上站点验证通过');
  console.log(`   仓库: https://github.com/${USER}/${REPO}`);
  console.log(`   站点: ${BASE}`);
} else {
  console.log(`❌ 有 ${bad} 项异常`);
}
process.exit(bad ? 1 : 0);

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

/* 要抽查的资源：入口、引擎、音效、技能表、样式，以及每个角色的贴图。
   贴图必须验 —— 它最容易因为路径大小写或漏传而 404，
   而 404 页面也是 200 之外最常见的坑（这里靠 content-type 判定）。
   **每加一个角色就要在这里加一行**：漏加不会报错，
   只会让"新角色线上没有贴图"这件事一直没人发现。 */
const CHECKS = [
  ['index.html', 'text/html', 'HTML 入口'],
  ['js/main.js', 'javascript', '入口脚本'],
  ['js/core.js', 'javascript', '战斗引擎'],
  ['js/skills.js', 'javascript', '技能表'],
  ['js/audio.js', 'javascript', '音效模块'],
  ['css/styles.css', 'css', '样式'],
  ['assets/characters/yuncai_ball.png', 'image/', '晕彩贴图'],
  ['assets/characters/yuncai_ball_bloom.png', 'image/', '开华贴图'],
  ['assets/characters/taoyao_ball.png', 'image/', '桃夭贴图'],
  ['README.md', '', '说明文档'],
];

console.log(`验证站点: ${BASE}\n`);
let bad = 0;

for (const [path, wantType, label] of CHECKS) {
  const url = BASE + path + bust();
  try {
    const r = await fetch(url, { redirect: 'follow' });
    const buf = new Uint8Array(await r.arrayBuffer());
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const typeOk = !wantType || ct.includes(wantType);
    const ok = r.status === 200 && buf.length > 0 && typeOk;
    if (!ok) bad++;
    console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(10)} ${String(r.status).padStart(3)} ` +
      `${String(buf.length).padStart(8)} bytes  ${ct.split(';')[0]}`);
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

console.log('');
if (bad === 0) {
  console.log('✅ 线上站点验证通过');
  console.log(`   仓库: https://github.com/${USER}/${REPO}`);
  console.log(`   站点: ${BASE}`);
} else {
  console.log(`❌ 有 ${bad} 项异常`);
}
process.exit(bad ? 1 : 0);

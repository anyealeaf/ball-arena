/* 本地启动器自检（launcher.html + 两个 .bat + 服务器横幅）
 *
 *   node tests/diag/launcher.mjs
 *
 * 启动器是"出问题就全盘打不开"的那一环，而它的逻辑偏偏是**分支最多**的：
 *   · 被服务器托管（正常）→ 两个按钮用同源相对路径，端口顺延也跟得上；
 *   · 被直接双击（file://）→ 链接要退回 http://localhost:5173，并提示先跑启动器；
 *   · 服务器没跑 / 跑着的是旧版（没有 /__edit）→ 状态区要说清是哪一种、怎么办；
 *   · 线上访问 → 根本不该去探测本机。
 * 这些分支在浏览器里都不好复现（要真的把服务器关掉、换个版本），
 * 所以这里把 launcher.html 的**内联脚本原样取出来**，套上假的 location/fetch 跑一遍，
 * 再核对它写了什么状态文字、把按钮指到了哪里。
 *
 * 另外顺手守住"文件名/文案别对不上"：页面提示的 启动器.bat 必须真的存在，
 * 旧快捷方式用的 启动预览.bat 必须还能转发过去。
 */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
let pass = 0, fail = 0;
const log = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; log.push(`  ✅ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; log.push(`  ❌ ${name}${detail ? '  — ' + detail : ''}`); }
};

const HTML = readFileSync('launcher.html', 'utf8');
const BAT = readFileSync('启动器.bat', 'utf8');
const OLD_BAT = readFileSync('启动预览.bat', 'utf8');
const SERVE = readFileSync('tools/serve.mjs', 'utf8');
const INDEX = readFileSync('index.html', 'utf8');
const GITATTR = readFileSync('.gitattributes', 'utf8');

/* ---------- 把内联脚本取出来，在假的 location/fetch 上跑一遍 ---------- */
const settle = () => new Promise(r => setTimeout(r, 20));

async function runLauncher({ protocol = 'http:', hostname = 'localhost', port = '5173', fetchImpl } = {}) {
  const { window, document } = parseHTML(HTML);
  const scriptEl = [...document.querySelectorAll('script')].find(s => !s.getAttribute('src'));
  const src = scriptEl ? scriptEl.textContent : '';

  const loc = {
    protocol, hostname, port,
    href: `${protocol}//${hostname}${port ? ':' + port : ''}/launcher.html`,
    host: port ? `${hostname}:${port}` : hostname,
  };
  const calls = [];
  const fakeFetch = (url, opt) => {
    calls.push({ url: String(url), method: (opt && opt.method) || 'GET' });
    if (fetchImpl) return fetchImpl(String(url), opt || {});
    return Promise.reject(new Error('no fetch stub'));
  };

  const fn = new Function('window', 'document', 'location', 'fetch',
    'setTimeout', 'clearTimeout', 'AbortController', src);
  fn(window, document, loc, fakeFetch, setTimeout, clearTimeout,
    typeof AbortController !== 'undefined' ? AbortController : undefined);
  await settle();
  await settle();

  const txt = el => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
  const cls = el => ((el && el.getAttribute('class')) || '');
  return {
    doc: document, calls, loc,
    badge: txt(document.getElementById('srv')),
    badgeClass: cls(document.querySelector('#srv span')),
    detail: txt(document.getElementById('detail')),
    gameHref: document.getElementById('goGame').getAttribute('href'),
    editorHref: document.getElementById('goEditor').getAttribute('href'),
    key: (k) => {
      const ev = new window.Event('keydown');
      try { ev.key = k; } catch (e) { /* linkedom 的 Event 可能不可扩展 */ }
      document.dispatchEvent(ev);
    },
  };
}

/** 一个"正常服务器"的假 fetch：HEAD 有文件、POST /__edit 回 400（空 edits） */
const okServer = (url, opt) => {
  if (opt.method === 'HEAD') return Promise.resolve({ ok: true, status: 200 });
  return Promise.resolve({ ok: false, status: 400 });
};

console.log('=========== 本地启动器自检 ===========\n');

/* ---------- 1) 页面结构 ---------- */
console.log('【1】页面结构');
{
  const { document } = parseHTML(HTML);
  const game = document.getElementById('goGame');
  const editor = document.getElementById('goEditor');
  check('两个入口按钮都在（进入游戏 / 素材编辑器）', !!game && !!editor,
    `${game ? '有' : '缺'} goGame，${editor ? '有' : '缺'} goEditor`);
  check('按钮文字分别是"进入游戏"与"素材编辑器"',
    /进入游戏/.test(game.querySelector('h3').textContent) &&
    /素材编辑器/.test(editor.querySelector('h3').textContent),
    `${game.querySelector('h3').textContent} / ${editor.querySelector('h3').textContent}`);
  check('默认链接指向同源相对路径（自动跟着实际端口）',
    game.getAttribute('href') === 'index.html' && editor.getAttribute('href') === 'assets-editor.html',
    `${game.getAttribute('href')} , ${editor.getAttribute('href')}`);
  check('样式用的是游戏本体的 styles.css（观感一致）',
    [...document.querySelectorAll('link')].some(l => l.getAttribute('href') === 'css/styles.css'));
  check('没有 ES 模块脚本（file:// 双击也能打开启动器自己）',
    !/type\s*=\s*["']module["']/.test(HTML) && !/\bimport\s+[\w{*]/.test(HTML));
  check('页面上给了说明文档与两个自检命令的入口',
    /href="README\.md"/.test(HTML) && /check-server\.mjs/.test(HTML) && /check-boot\.mjs/.test(HTML));
  check('页面里说清了"关掉黑窗口 = 停止服务器"', /关掉/.test(HTML) && /服务器/.test(HTML));
}

/* ---------- 2) 正常：服务器在跑、写回接口可用 ---------- */
console.log('\n【2】正常情况（服务器在跑）');
{
  const r = await runLauncher({ fetchImpl: okServer });
  check('状态显示"服务器运行中"', /运行中/.test(r.badge), r.badge);
  check('状态点是绿色（ok 类）', /dot ok/.test(r.badgeClass), r.badgeClass);
  check('状态区说明写回接口可用（编辑器能存）', /写回接口可用/.test(r.detail), r.detail.slice(0, 60));
  check('状态区报出了当前端口', /5173/.test(r.detail), r.detail.slice(0, 60));
  check('确实探测了页面与写回接口两个地址',
    r.calls.some(c => c.url === 'js/balls.js') && r.calls.some(c => c.url === '__edit'),
    r.calls.map(c => c.method + ' ' + c.url).join(', '));
}

/* ---------- 3) 端口顺延：按钮要跟着实际端口走 ---------- */
console.log('\n【3】端口顺延（5174）');
{
  const r = await runLauncher({ port: '5174', fetchImpl: okServer });
  check('按钮仍然是同源相对路径（不会写死 5173）',
    r.gameHref === 'index.html' && r.editorHref === 'assets-editor.html',
    `${r.gameHref} , ${r.editorHref}`);
  check('状态区报出的是 5174', /5174/.test(r.detail), r.detail.slice(0, 60));
}

/* ---------- 4) 旧版服务器：能玩但不能存 ---------- */
console.log('\n【4】旧版服务器（没有 /__edit 接口）');
{
  const r = await runLauncher({
    fetchImpl: (url, opt) => opt.method === 'HEAD'
      ? Promise.resolve({ ok: true, status: 200 })
      : Promise.resolve({ ok: false, status: 404 }),
  });
  check('识别出"服务器是旧版"', /旧版/.test(r.badge), r.badge);
  check('状态区给出重启服务器的办法', /重新双击|重启/.test(r.detail) && /启动器\.bat/.test(r.detail),
    r.detail.slice(0, 80));
}

/* ---------- 5) 服务器没跑 ---------- */
console.log('\n【5】服务器没连上');
{
  const r = await runLauncher({ fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')) });
  check('状态显示"服务器没连上"', /没连上/.test(r.badge), r.badge);
  check('状态点是红色（bad 类）', /dot bad/.test(r.badgeClass), r.badgeClass);
  check('状态区指向 启动器.bat', /启动器\.bat/.test(r.detail), r.detail.slice(0, 80));
}

/* ---------- 6) 被直接双击（file://） ---------- */
console.log('\n【6】直接双击打开（file://）');
{
  const r = await runLauncher({ protocol: 'file:', hostname: '', port: '', fetchImpl: okServer });
  check('链接退回 http://localhost:5173（猜默认端口）',
    r.gameHref === 'http://localhost:5173/index.html' &&
    r.editorHref === 'http://localhost:5173/assets-editor.html',
    `${r.gameHref} , ${r.editorHref}`);
  check('状态说明本页没有被服务器托管', /没有被服务器托管|file:/.test(r.badge + r.detail), r.badge);
  check('不去探测本机（file:// 下探测只会得到一堆报错）', r.calls.length === 0,
    `${r.calls.length} 次探测`);
}

/* ---------- 7) 线上访问：不探测本机 ---------- */
console.log('\n【7】线上访问（GitHub Pages）');
{
  const r = await runLauncher({ hostname: 'anyealeaf.github.io', port: '', fetchImpl: okServer });
  check('线上不探测本机服务器', r.calls.length === 0, `${r.calls.length} 次探测`);
  check('状态区说明线上与本地无关', /线上/.test(r.badge + r.detail), r.badge);
  check('线上按钮仍是相对路径（指向线上页面）',
    r.gameHref === 'index.html' && r.editorHref === 'assets-editor.html');
}

/* ---------- 8) 快捷键 ---------- */
console.log('\n【8】快捷键');
{
  const r = await runLauncher({ fetchImpl: okServer });
  const before = r.loc.href;
  /* 快捷键要落到**和按钮同一个地址**（served 时是相对路径，file:// 时是绝对地址） */
  check('按 1 进游戏（落到和按钮同一个地址）', (() => {
    r.key('1');
    return r.loc.href === r.gameHref;
  })(), r.loc.href);
  r.loc.href = before;
  check('按 2 进编辑器（同上）', (() => {
    r.key('2');
    return r.loc.href === r.editorHref;
  })(), r.loc.href);
  r.loc.href = before;
  const n = r.calls.length;
  r.key('r');
  await settle();
  check('按 R 重新检测', r.calls.length > n, `${n} → ${r.calls.length} 次探测`);
}

/* ---------- 9) bat / 提示文案 / 服务器横幅 对得上 ---------- */
console.log('\n【9】文件之间的对得上（改名/改文案最容易漏的地方）');
{
  check('启动器.bat 存在且会打开 launcher.html', /launcher\.html/.test(BAT));  check('启动器.bat 会启动 tools\\serve.mjs', /tools\\serve\.mjs/.test(BAT));
  check('启动器.bat 用轮询探测端口（不是写死"3 秒后打开"）',
    /Invoke-WebRequest/.test(BAT) && /5173/.test(BAT) && /5180/.test(BAT),
    '等待服务器真的起来再开浏览器');
  check('启动器.bat 覆盖了端口顺延（5173..5180）', /5173; \$p -le 5180/.test(BAT));
  check('启动器.bat 会识别"已经在跑"的服务器（不会起第二个）',
    /已经在运行/.test(BAT) && /netstat/.test(BAT));
  check('旧名字 启动预览.bat 仍然转发到 启动器.bat（桌面快捷方式不作废）',
    /启动器\.bat/.test(OLD_BAT) && /call/.test(OLD_BAT));
  check('服务器启动横幅里印了启动器地址', /launcher\.html/.test(SERVE), 'serve.mjs');
  check('游戏页的"页面没能启动"提示指向 启动器.bat（不再是旧名字）',
    /启动器\.bat/.test(INDEX) && !/启动预览\.bat/.test(INDEX));
  check('启动器页面提到的 启动器.bat 与本名一致', /启动器\.bat/.test(HTML));
}

/* ---------- 10) 批处理文件的行尾与编码 ----------
   实测踩过一次，而且症状完全指不到原因：文件是 UTF-8 却用 **LF 行尾**，
   cmd.exe 解析带括号的代码块时错乱，跑出来是
     '面（服务器顺延到' 不是内部或外部命令
     '5173' 不是内部或外部命令
   而它照样会执行**一半**（打印了提示、还 pause 了），看起来像"脚本逻辑写错了"。
   真正的原因只是行尾。所以这里把两个 .bat 的行尾/编码钉住。 */
console.log('\n【10】批处理文件的行尾与编码');
{
  const inspect = (name) => {
    const b = readFileSync(name);
    let crlf = 0, lf = 0;
    for (let i = 0; i < b.length; i++) {
      if (b[i] === 10) { if (i > 0 && b[i - 1] === 13) crlf++; else lf++; }
    }
    const bom = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
    return { crlf, lf, bom, size: b.length };
  };
  for (const name of ['启动器.bat', '启动预览.bat']) {
    const b = inspect(name);
    check(`${name} 是 CRLF 行尾（LF 会让 cmd 把括号块解析错乱）`,
      b.lf === 0 && b.crlf > 0, `CRLF ${b.crlf} / 裸 LF ${b.lf}`);
    check(`${name} 没有 BOM（BOM 会让第一行 @echo off 失效）`, !b.bom, `${b.size} 字节`);
  }
  check('启动器.bat 在第 2 行就切到 UTF-8 代码页（中文才不会乱码）',
    /^@echo off\r?\nchcp 65001/.test(BAT), (BAT.split(/\r?\n/)[1] || '').trim());
  check('.gitattributes 里钉住了 *.bat 用 CRLF（万一以后真用 git 克隆）',
    /\.bat\s+text\s+eol=crlf/.test(GITATTR), '.gitattributes');
}

console.log('\n' + log.join('\n'));
console.log(`\n=========== 通过 ${pass} 项，失败 ${fail} 项 ===========`);
process.exit(fail ? 1 : 0);

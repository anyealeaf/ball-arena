/* ============================================================
   check-server.mjs — 「服务器在跑的这一刻，它到底正常吗」
   ------------------------------------------------------------
   用法：node tools/check-server.mjs          （默认从 5173 起找）
         node tools/check-server.mjs 5174     （指定端口）

   和 tools/check-boot.mjs 的分工：
     · check-boot.mjs  —— **不联网**，用 linkedom 把页面跑一遍，
                          回答"是我改坏了代码，还是服务器没开"；
     · check-server.mjs —— **只看真实 HTTP**，回答"服务器这一侧对不对"：
                          html/js/css 的 MIME、404、只读与写回接口的约定。

   为什么值得单独跑一次：素材编辑器"存不上"有一大半不是编辑器的问题，
   而是**服务器这一侧**的问题（跑了旧版 / 接口没挂上 / MIME 不对导致模块被拦）。
   这里把每条都打出来，是哪一层坏了一眼能看到。

   ⚠ 只发**只读**或**必然被拒绝**的请求（空 edits、不认识的字段 id），
     绝不写任何文件 —— 这个脚本可以在作者正在用编辑器的时候随时跑。
   ============================================================ */

const BASE = Number(process.argv[2] || 5173);
const MAX_TRIES = 8;

let pass = 0, fail = 0, skip = 0;
const log = [];
const ok = (name, detail = '') => { pass++; log.push(`  ✅ ${name}${detail ? '  — ' + detail : ''}`); };
const bad = (name, detail = '') => { fail++; log.push(`  ❌ ${name}${detail ? '  — ' + detail : ''}`); };
const chk = (name, cond, detail) => (cond ? ok(name, detail) : bad(name, detail));

/** 找到正在跑的服务器（serve.mjs 会从 5173 顺延） */
async function findServer() {
  for (let p = BASE; p < BASE + MAX_TRIES; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/js/balls.js`, { method: 'HEAD' });
      if (r.ok) return p;
    } catch { /* 这个端口没人 */ }
  }
  return null;
}

async function get(port, path) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await r.text();
  return { status: r.status, type: r.headers.get('content-type') || '', body };
}
async function post(port, path, obj) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });
  let json = null;
  const text = await r.text();
  try { json = JSON.parse(text); } catch { /* 非 JSON 也算一种结果 */ }
  return { status: r.status, json, text };
}

console.log('=========== 本地服务器自检 ===========\n');

const port = await findServer();
if (!port) {
  console.log(`  没有找到正在运行的服务器（试过 ${BASE}~${BASE + MAX_TRIES - 1}）。`);
  console.log('');
  console.log('  这不是代码的问题：请双击 启动器.bat（或在命令行跑 node tools/serve.mjs），');
  console.log('  等它打印出地址之后，再跑一次这个脚本。');
  process.exit(0);
}
console.log(`  服务器：http://localhost:${port}\n`);

/* ---------- 1) 三个页面都能取到 ---------- */
{
  const home = await get(port, '/');
  chk('首页 200', home.status === 200, `HTTP ${home.status}`);
  chk('首页是 HTML 且带 utf-8（否则中文会乱码）',
    /text\/html/.test(home.type) && /charset=utf-8/i.test(home.type), home.type);
  chk('首页里挂了入口模块 js/main.js', /js\/main\.js/.test(home.body));

  const launch = await get(port, '/launcher.html');
  chk('启动器页面 200', launch.status === 200, `HTTP ${launch.status}`);
  chk('启动器页面里有「进入游戏」与「素材编辑器」两个入口',
    /进入游戏/.test(launch.body) && /素材编辑器/.test(launch.body));
  chk('启动器页面的两个按钮指向正确',
    /id="goGame"[^>]*href="index\.html"/.test(launch.body) &&
    /id="goEditor"[^>]*href="assets-editor\.html"/.test(launch.body));

  const editor = await get(port, '/assets-editor.html');
  chk('素材编辑器页面 200', editor.status === 200, `HTTP ${editor.status}`);
  chk('编辑器页面引的是模块化的 ui-assets.js',
    /type="module"/.test(editor.body) && /ui-assets\.js/.test(editor.body));
}

/* ---------- 2) 静态资源的 MIME（错了浏览器会直接拒跑模块） ---------- */
{
  const js = await get(port, '/js/balls.js');
  chk('js 的 MIME 是 javascript（不是 octet-stream）',
    /javascript/.test(js.type), js.type);
  const css = await get(port, '/css/styles.css');
  chk('css 的 MIME 是 text/css', /text\/css/.test(css.type), css.type);
  const md = await get(port, '/README.md');
  chk('README.md 按纯文本给（浏览器里能直接看，不会变成下载）',
    /text\/plain/.test(md.type) && /charset=utf-8/i.test(md.type), md.type);
  const nope = await get(port, '/这个文件不存在.txt');
  chk('不存在的文件回 404（而不是 200 的空白页）', nope.status === 404, `HTTP ${nope.status}`);
}

/* ---------- 3) 写回接口的约定（只发必然被拒的请求） ---------- */
{
  const empty = await post(port, '/__edit', { edits: [] });
  chk('写回接口在（空 edits 回 400 而不是 404）', empty.status === 400, `HTTP ${empty.status}`);
  chk('空 edits 的报错是 JSON 且说得清原因',
    empty.json && /edits/.test(empty.json.error || ''), empty.json ? empty.json.error : empty.text.slice(0, 60));

  const unknown = await post(port, '/__edit', { edits: [{ id: '这不是一个字段', value: 1 }] });
  chk('不认识的字段被白名单挡下（400）', unknown.status === 400, `HTTP ${unknown.status}`);
  chk('报错里点名了那个字段 id',
    unknown.json && /不认识的字段 id/.test(unknown.json.error || ''),
    unknown.json ? unknown.json.error.slice(0, 60) : unknown.text.slice(0, 60));
}

console.log(log.join('\n'));
console.log(`\n=========== 通过 ${pass} 项，失败 ${fail} 项 ===========`);
console.log(fail
  ? '服务器这一侧有问题 —— 看上面的红项。'
  : `服务器正常（端口 ${port}）。页面没开的话，问题不在服务器。`);
process.exit(fail ? 1 : 0);

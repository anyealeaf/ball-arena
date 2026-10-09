/* ============================================================
   serve.mjs — 零依赖本地静态服务器
   ------------------------------------------------------------
   为什么需要它：项目用 ES 模块（<script type="module">），
   浏览器的同源策略不允许从 file:// 加载模块，直接双击 index.html 会失败。
   运行：node tools/serve.mjs   然后打开 http://localhost:5173

   它还带一个**只在本机开发时用的写回接口**（`POST /__edit`），
   给「素材编辑器」用：在页面上拖滑块改尺寸/透明度，直接写回 js/*.js。
   只允许改 `js/asset-schema.js` 里登记过的字段，且只监听本机 ——
   它不是一个通用文件写入接口，别把它当成后端。
   ============================================================ */

import { createServer } from 'node:http';
import { readFile, stat, writeFile, copyFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDIT_FILES } from '../js/asset-schema.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BASE_PORT = Number(process.env.PORT || 5173);
const MAX_TRIES = 20;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  /* .md 给 README 用：浏览器里按纯文本直接看（不然会变成"下载文件"） */
  '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
};

const server = createServer(async (req, res) => {
  try {
    /* ---------- 素材编辑器的写回接口 ---------- */
    if (req.method === 'POST' && req.url === '/__edit') {
      await handleEdit(req, res);
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';

    // 阻止目录穿越
    const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    let filePath = join(ROOT, safe);

    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    let info;
    try { info = await stat(filePath); }
    catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 找不到：' + safe); return; }

    if (info.isDirectory()) {
      filePath = join(filePath, 'index.html');
      try { info = await stat(filePath); }
      catch { res.writeHead(404).end('404'); return; }
    }

    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Length': body.length
    });
    res.end(body);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('500 ' + e.message);
  }
});

/* ---------- 素材编辑器：写回源码 ----------
   请求体：{ edits: [{ id: '字段id', value: 新值 }, ...] }
   只接受 `js/asset-schema.js` 里登记过的字段 id；每个字段的定位规则见
   tools/lib/asset-patch.mjs（锚点唯一 + 窗口内键唯一，否则拒绝）。
   写入前给原文件留一份 `.bak`，一次请求里同一个文件只写一次。 */

/** 每次都**重新读一遍**字段清单。
 *
 *  为什么不在启动时 import 一次：字段清单是"改编辑器"时最常动的东西，
 *  而服务器是长驻进程 —— 启动时读一份的话，加了新旋钮就得重启服务器，
 *  否则页面能拖、保存却报"不认识的字段 id"（作者第一次点保存就撞上了这个）。
 *  加个时间戳查询串让 Node 的 ESM 缓存失效，代价是每次保存多读一个小文件。 */
async function loadFields() {
  const mod = await import(`../js/asset-schema.js?t=${Date.now()}`);
  return new Map(mod.allFields().map(f => [f.id, f]));
}

/** 写回实现也**每次重新读**。
 *
 *  和上面同一个理由，而且是被"数值（平衡）"这一轮实测打中的：
 *  那一轮给 `formatValue` 加了 `nums`（数字数组）类型，
 *  但正在跑的服务器还是启动时 import 的旧版本 —— 于是保存直接 409
 *  「字段 cgDmg 改不动：不认识的字段类型：nums」，
 *  而文件一个字节都没动（这是好事：宁可拒绝也不写一半）。
 *  加个时间戳动态 import，以后改写回逻辑也不用重启服务器。 */
async function loadPatcher() {
  return import(`./lib/asset-patch.mjs?t=${Date.now()}`);
}

async function handleEdit(req, res) {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  let body = '';
  try {
    for await (const chunk of req) body += chunk;
    const { edits } = JSON.parse(body || '{}');
    if (!Array.isArray(edits) || !edits.length) return send(400, { error: 'edits 不能为空' });

    const FIELD_BY_ID = await loadFields();
    const { patchField } = await loadPatcher();

    /* 按文件分组：同一个文件只读一次、只写一次 */
    const byFile = new Map();
    for (const e of edits) {
      const f = FIELD_BY_ID.get(e && e.id);
      if (!f) {
        return send(400, {
          error: `不认识的字段 id：${e && e.id}` +
            '（如果刚改过 js/asset-schema.js，刷新一下编辑器页面再试）'
        });
      }
      if (!byFile.has(f.file)) byFile.set(f.file, []);
      byFile.get(f.file).push({ field: f, value: e.value });
    }

    const applied = [];
    for (const [short, list] of byFile) {
      const rel = EDIT_FILES[short];
      if (!rel) return send(400, { error: `不在白名单里的文件：${short}` });
      const abs = join(ROOT, rel);
      let src = await readFile(abs, 'utf8');
      const per = [];
      for (const { field, value } of list) {
        try {
          const out = patchField(src, field, value);
          src = out.src;
          per.push({
            id: field.id, key: field.key, short,
            before: out.before, after: out.after, lineNo: out.lineNo
          });
        } catch (err) {
          /* 一条改不动就整份不写 —— 避免"改了一半"的源码更难收拾 */
          return send(409, {
            error: `字段 ${field.id} 改不动：${err.message}`,
            applied: [], file: rel
          });
        }
      }
      await copyFile(abs, abs + '.bak');
      await writeFile(abs, src);
      applied.push(...per);
    }
    send(200, { ok: true, applied });
  } catch (e) {
    send(500, { error: String((e && e.message) || e) });
  }
}


function listen(port, triesLeft) {
  return new Promise((resolve, reject) => {
    const onError = err => {
      if (err.code === 'EADDRINUSE' && triesLeft > 0) {
        console.log(`  端口 ${port} 已被占用，改用 ${port + 1} …`);
        server.removeListener('error', onError);
        resolve(listen(port + 1, triesLeft - 1));
      } else {
        reject(err);
      }
    };
    server.once('error', onError);
    server.listen(port, () => {
      server.removeListener('error', onError);
      resolve(port);
    });
  });
}

try {
  const port = await listen(BASE_PORT, MAX_TRIES);
  console.log('');
  console.log('  小球角斗场 · 本地服务器已启动');
  console.log('');
  console.log(`  →  本地启动器（推荐从这里进）：  http://localhost:${port}/launcher.html`);
  console.log(`  →  直接进游戏：                  http://localhost:${port}/`);
  console.log(`  →  素材编辑器：                  http://localhost:${port}/assets-editor.html`);
  console.log('');
  console.log('  提示：双击 启动器.bat 会连服务器和启动器页面一起开好，不用记地址。');
  console.log('  注意：不要直接双击 index.html 打开（地址栏是 file://），');
  console.log('        那样浏览器会拦下模块脚本，页面是空白的。');
  console.log('');
  console.log('  按 Ctrl+C 停止服务器');
  console.log('');
} catch (e) {
  console.error('');
  console.error('  启动失败：' + e.message);
  console.error(`  已尝试端口 ${BASE_PORT}–${BASE_PORT + MAX_TRIES}`);
  console.error('  可以指定其它端口，例如：  set PORT=8080 && node tools/serve.mjs');
  console.error('');
  process.exit(1);
}

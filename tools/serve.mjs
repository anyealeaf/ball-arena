/* ============================================================
   serve.mjs — 零依赖本地静态服务器
   ------------------------------------------------------------
   为什么需要它：项目用 ES 模块（<script type="module">），
   浏览器的同源策略不允许从 file:// 加载模块，直接双击 index.html 会失败。
   运行：node tools/serve.mjs   然后打开 http://localhost:5173
   ============================================================ */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BASE_PORT = Number(process.env.PORT || 5173);
const MAX_TRIES = 20;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
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

/* 端口被占用时自动顺延，避免静默失败（"打不开"最常见的原因之一） */
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
  console.log('  小球角斗场 · 本地预览已启动');
  console.log('');
  console.log(`  →  请在浏览器打开：  http://localhost:${port}`);
  console.log('');
  console.log('  注意：不要直接双击 index.html 打开（地址栏是 file://），');
  console.log('        那样浏览器会拦下模块脚本，页面是空白的。');
  console.log('');
  console.log('  按 Ctrl+C 停止预览');
  console.log('');
} catch (e) {
  console.error('');
  console.error('  启动失败：' + e.message);
  console.error(`  已尝试端口 ${BASE_PORT}–${BASE_PORT + MAX_TRIES}`);
  console.error('  可以指定其它端口，例如：  set PORT=8080 && node tools/serve.mjs');
  console.error('');
  process.exit(1);
}

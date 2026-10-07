// publish-via-api.mjs — 用 GitHub Git Data API 上传，绕开 git 的网络层
//
//   $env:GIT_PUSH_TOKEN="<PAT>"; node tools/publish-via-api.mjs <user> <repo> [--message "..."]
//
// 为什么要这样传（来自本地发布手册第 7.2 节，本机实测）：
//   · 本机 git 的 HTTPS 传输是坏的：`git ls-remote` 都过不去，报
//     `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS` ——
//     连不涉及凭据的请求都失败，说明是沙箱挡了 schannel，不是 token 的问题。
//   · Node 自己的 TLS 栈是好的（同一个 shell 能直接调 GitHub API）。
//   所以上传走 create blobs → create tree → create commit → 移动分支 ref。
//
// 另外两个沙箱限制也一并绕开：child_process 用管道 stdio 会 EPERM；
// Git Credential Manager 起不来。
//
// 安全：**分支 ref 只在最后一步移动**，中途失败仓库保持原样。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const USER = positional[0];
const REPO = positional[1];
if (!USER || !REPO) {
  console.error('用法: node tools/publish-via-api.mjs <user> <repo> [--dir <dir>] [--message "..."] [--create]');
  process.exit(1);
}
const opt = (name, fb) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fb;
};
const has = (name) => args.includes(`--${name}`);

const DIR = path.resolve(ROOT, opt('dir', '.'));
const BRANCH = opt('branch', 'main');
const MESSAGE = opt('message', '更新小球角斗场');
const CREATE = has('create');

const TOKEN = process.env.GIT_PUSH_TOKEN || process.env.GH_TOKEN;
if (!TOKEN) {
  console.error('✘ 需要 token：设置环境变量 GIT_PUSH_TOKEN（不要写成命令行参数，会进进程列表）');
  process.exit(1);
}

const API_ROOT = 'https://api.github.com';
const API = `${API_ROOT}/repos/${USER}/${REPO}`;
const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'ball-arena-publish',
  'Content-Type': 'application/json',
};

async function api(method, url, body, tries = 4) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    let r;
    try {
      r = await fetch(url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    } catch (err) {
      if (attempt === tries) throw new Error(`网络失败: ${err.message}`);
      await new Promise(res => setTimeout(res, 500 * attempt));
      continue;
    }
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON 响应 */ }
    if ((r.status === 403 || r.status === 429 || r.status >= 500) && attempt < tries) {
      await new Promise(res => setTimeout(res, 700 * attempt));
      continue;
    }
    if (r.status >= 400) {
      const e = new Error(`${method} ${url} -> HTTP ${r.status}: ${(json && json.message) || text.slice(0, 200)}`);
      e.status = r.status;
      throw e;
    }
    return json;
  }
}

/* ============================================================
   防泄漏闸门（手册第 7.1 节纪律 5）
   ------------------------------------------------------------
   上传前把产出扫一遍，确认没有绝对路径 / 秘钥字样。
   两个设计要点：
     · **规则只有一份**（LEAK_PATTERNS）。自测若复制一份正则，
       闸门改了而自测没改，就会出现"自测通过但闸门失效"。
     · 自测样本**在运行时拼出来**，不能把泄漏样本写死在源码里 ——
       否则闸门扫到自己就把整个仓库拦下了（第一版就是这么翻车的）。
   ============================================================ */
const LEAK_PATTERNS = [
  { re: /[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\s"')]+/g, what: '本机绝对路径' },
  { re: /[A-Za-z]:[\\/](?:Plugins|WorkBuddy)[\\/][^\s"')]*/g, what: '本机绝对路径' },
  { re: /(?:ghp_|github_pat_|gho_|ghs_)[A-Za-z0-9_]{16,}/g, what: '疑似 token' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, what: '私钥' },
];

/** 纯函数：一段文本里有没有泄漏形状。抽出来是为了让自测能直接测它 */
export function matchLeaks(text) {
  const hits = [];
  for (const p of LEAK_PATTERNS) {
    p.re.lastIndex = 0;
    const m = text.match(p.re);
    if (m) hits.push({ what: p.what, sample: m[0].slice(0, 60) });
  }
  return hits;
}

export function findLeaks(files) {
  const hits = [];
  const pats = LEAK_PATTERNS;
  for (const f of files) {
    if (!f.text) continue;                 // 图片是二进制，扫了只会误报
    let src;
    try { src = fs.readFileSync(f.full, 'utf8'); } catch (e) { continue; }
    for (const p of pats) {
      p.re.lastIndex = 0;
      const m = src.match(p.re);
      if (m) hits.push({ rel: f.rel, what: p.what, sample: m[0].slice(0, 60) });
    }
  }
  return hits;
}

/* 闸门自测：真泄漏必须命中、正常内容不许误报。
   误报会让人开始忽略闸门，那比没有闸门更糟。 */
function leakGateSelfTest() {
  const S = String.fromCharCode(92);                     // 反斜杠，避免样本被自己扫到
  const drive = 'C:' + S;
  const driveFwd = 'D:' + '/';
  const tok = 'ghp' + '_';
  const pkHead = '-----BEGIN RSA ' + 'PRIVATE KEY-----';
  const cases = [
    ['路径是 ' + drive + 'Users' + S + 'admin' + S + 'x.png', true, '盘符绝对路径'],
    [driveFwd + 'Plugins/foo', true, '正斜杠盘符'],
    ['token = ' + tok + 'a'.repeat(36), true, 'token 形状'],
    [pkHead, true, '私钥'],
    ['const p = "js/main.js"', false, '相对路径不该误报'],
    ['https://anyealeaf.github.io/ball-arena/', false, '正常网址不该误报'],
    ['canvas.width = 720', false, '普通数字不该误报'],
    ['assets/characters/yuncai_ball.png', false, '资源相对路径不该误报'],
  ];
  let ok = true;
  for (const [text, want, label] of cases) {
    const got = matchLeaks(text).length > 0;
    if (got !== want) { ok = false; console.error(`  ✘ 闸门自测失败: ${label}（期望 ${want} 实得 ${got}）`); }
  }
  return ok;
}

/* ---------------------------------------------------------------------------
   收集要上传的文件
   --------------------------------------------------------------------------- */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.npm-cache', '.chrome', '.edge-cache', '.tmp']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);
const TEXT_EXT = new Set(['.html', '.css', '.js', '.mjs', '.json', '.txt', '.md', '.svg', '.ps1', '.yml', '.yaml']);
const files = [];
function walk(dir, base) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && SKIP_DIRS.has(e.name)) continue;
    if (SKIP_DIRS.has(e.name) || SKIP_FILES.has(e.name)) continue;
    const full = path.join(dir, e.name);
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) walk(full, rel);
    else files.push({ rel, full, text: TEXT_EXT.has(path.extname(e.name).toLowerCase()) });
  }
}

if (!fs.existsSync(path.join(DIR, 'index.html'))) {
  console.error(`✘ ${DIR} 里没有 index.html —— 这不是一个可直接托管的站点目录`);
  process.exit(1);
}
walk(DIR, '');

/* GitHub Pages 要它，否则会跑 Jekyll，下划线开头的文件会被特殊处理 */
const nojekyll = path.join(DIR, '.nojekyll');
if (!fs.existsSync(nojekyll)) fs.writeFileSync(nojekyll, '');
if (!files.some(f => f.rel === '.nojekyll')) {
  files.push({ rel: '.nojekyll', full: nojekyll, text: true });
}

const totalBytes = files.reduce((n, f) => n + fs.statSync(f.full).size, 0);
console.log(`目录   : ${DIR}`);
console.log(`文件   : ${files.length} 个, ${(totalBytes / 1048576).toFixed(2)} MB`);
console.log(`目标   : ${USER}/${REPO} @ ${BRANCH}`);
console.log('');

/* ---------------------------------------------------------------------------
   闸门：先自测，再真的扫
   --------------------------------------------------------------------------- */
console.log('防泄漏闸门 …');
if (!leakGateSelfTest()) {
  console.error('✘ 闸门自测没过 —— 拒绝上传（自测不过说明闸门本身不可信）');
  process.exit(1);
}
const leaks = findLeaks(files);
if (leaks.length) {
  console.error(`✘ 发现 ${leaks.length} 处疑似泄漏，拒绝上传：`);
  for (const l of leaks.slice(0, 20)) console.error(`   ${l.rel}: ${l.what} —— ${l.sample}`);
  process.exit(1);
}
console.log('  ✓ 自测通过，未发现绝对路径 / 密钥字样');
console.log('');

/* ---------------------------------------------------------------------------
   0) 仓库不存在就建（--create）
   --------------------------------------------------------------------------- */
try {
  await api('GET', API);
  console.log('仓库已存在');
} catch (err) {
  if (err.status !== 404) throw err;
  if (!CREATE) {
    console.error(`✘ 仓库 ${USER}/${REPO} 不存在。加 --create 让我建，或先去 GitHub 手动建。`);
    process.exit(1);
  }
  console.log('仓库不存在，创建中（public）…');
  await api('POST', `${API_ROOT}/user/repos`, {
    name: REPO,
    description: '小球角斗场 —— 斗蛐蛐玩法框架（纯前端 · 单机 · 确定性模拟）',
    homepage: `https://${USER}.github.io/${REPO}/`,
    private: false,
    has_issues: true,
    has_wiki: false,
    auto_init: false,
  });
  console.log('  ✓ 已创建');
}

/* ---------------------------------------------------------------------------
   0.5) 空仓库要先"播种"一次提交
   ------------------------------------------------------------
   坑：刚建出来的空仓库上，Git Data API（blobs / trees / commits）会一律返回
       409 "Git Repository is empty." —— 必须先有一次提交才可用。
   做法：用 Contents API 写一个占位文件，它会顺带建出分支与首个提交，
        之后正常的 blobs → tree → commit 流程就能接上（作为它的子提交）。
   --------------------------------------------------------------------------- */
const refPath = `${API}/git/refs/heads/${BRANCH}`;
let parentSha = null;
try {
  const cur = await api('GET', refPath);
  parentSha = cur.object.sha;
} catch (err) {
  if (err.status === 409 || err.status === 404) {
    console.log(`远端还没有 ${BRANCH} 分支，先播种一次初始提交 …`);
    await api('PUT', `${API}/contents/.nojekyll`, {
      message: '初始化仓库',
      content: Buffer.from('').toString('base64'),
      branch: BRANCH,
    });
    const cur = await api('GET', refPath);
    parentSha = cur.object.sha;
    console.log(`  ✓ 已播种: ${parentSha}`);
  } else {
    throw err;
  }
}

console.log('上传 blobs …');
const shaByPath = new Map();
let done = 0, uploadedBytes = 0;
for (const f of files) {
  const buf = fs.readFileSync(f.full);
  const blob = await api('POST', `${API}/git/blobs`, { content: buf.toString('base64'), encoding: 'base64' });
  shaByPath.set(f.rel, blob.sha);
  done++; uploadedBytes += buf.length;
  if (done % 10 === 0 || done === files.length) {
    process.stdout.write(`\r  ${done}/${files.length}  ${(uploadedBytes / 1048576).toFixed(2)} MB   `);
  }
}
console.log('');

/* ---------------------------------------------------------------------------
   2) 构造 tree
   显式建 tree（而不是让 GitHub 按父提交推断），这样"删掉的文件"也会真的消失。
   --------------------------------------------------------------------------- */
console.log('构造 tree …');
const root = { files: {}, dirs: {} };
for (const [rel, sha] of shaByPath) {
  const parts = rel.split('/');
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    node.dirs[parts[i]] = node.dirs[parts[i]] || { files: {}, dirs: {} };
    node = node.dirs[parts[i]];
  }
  node.files[parts[parts.length - 1]] = sha;
}
async function makeTree(node) {
  const tree = [];
  for (const [name, sha] of Object.entries(node.files)) {
    tree.push({ path: name, mode: '100644', type: 'blob', sha });
  }
  for (const [name, child] of Object.entries(node.dirs)) {
    const sub = await makeTree(child);
    tree.push({ path: name, mode: '040000', type: 'tree', sha: sub });
  }
  return (await api('POST', `${API}/git/trees`, { tree })).sha;
}
const treeSha = await makeTree(root);
console.log(`  tree: ${treeSha}`);

/* ---------------------------------------------------------------------------
   3) 建 commit
   ref 端点必须是 /git/refs/ + 完整 ref（"heads/main"），
   写成单数 /git/ref/heads/main 会返回一个看起来像权限问题的 404 ——
   手册里记着这一条，说是"害人白查了一轮 token"。
   （refPath 与 parentSha 在上面"播种"那一步已经取好了。）
   --------------------------------------------------------------------------- */
console.log(`父提交: ${parentSha}`);
const commit = await api('POST', `${API}/git/commits`, {
  message: MESSAGE, tree: treeSha, parents: parentSha ? [parentSha] : [],
});
console.log(`新提交: ${commit.sha}`);

/* ---------------------------------------------------------------------------
   4) 移动分支（这一步之后才真正生效）
   --------------------------------------------------------------------------- */
if (parentSha) {
  await api('PATCH', refPath, { sha: commit.sha, force: false });
  console.log(`已更新 ${BRANCH} -> ${commit.sha}`);
} else {
  await api('POST', `${API}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
  console.log(`已创建 ${BRANCH} -> ${commit.sha}`);
}

/* ---------------------------------------------------------------------------
   5) 回读确认（手册：提交后要回读 sha 与文件数，别只看脚本退出码）
   --------------------------------------------------------------------------- */
const after = await api('GET', refPath);
/* 注意：ref 对象上是 .object.sha（**提交**的 sha），不是 .object.tree.sha。
   要数文件得先拿提交、再从提交取 tree。（第一版就在这里写错，白崩了一次。） */
const remoteCommit = await api('GET', `${API}/git/commits/${after.object.sha}`);
const remoteTree = await api('GET', `${API}/git/trees/${remoteCommit.tree.sha}?recursive=1`);
const remoteBlobs = (remoteTree.tree || []).filter(t => t.type === 'blob').length;
console.log('');
console.log(`回读 ${BRANCH}: ${after.object.sha}`);
console.log(`sha 一致 : ${after.object.sha === commit.sha ? '是' : '否'}`);
console.log(`文件数   : 本地 ${files.length} / 远端 ${remoteBlobs}  ${remoteBlobs === files.length ? '✓' : '✘'}`);

/* ---------------------------------------------------------------------------
   6) 尝试开启 Pages（失败不算致命，但要明说怎么手动开）
   --------------------------------------------------------------------------- */
console.log('');
try {
  await api('POST', `${API}/pages`, { source: { branch: BRANCH, path: '/' } });
  console.log('✓ 已开启 GitHub Pages');
} catch (err) {
  try {
    const cur = await api('GET', `${API}/pages`);
    console.log(`Pages 已在运行: ${cur.html_url || ''}`);
  } catch (e2) {
    console.log(`Pages 未开启（HTTP ${err.status}）：请到 Settings → Pages 手动选 branch=${BRANCH} / root`);
  }
}

console.log('');
console.log(`仓库 : https://github.com/${USER}/${REPO}`);
console.log(`站点 : https://${USER}.github.io/${REPO}/`);
console.log('提示 : Pages 首次生效要 1~2 分钟，且全站 max-age=600，改动最多 10 分钟才可见');

/* ============================================================
   ui-assets.js — 素材编辑器（可视化改尺寸 / 透明度 / 光晕 / 判定）
   ------------------------------------------------------------
   为什么要有这个页面：这些数值原本只能"改源码 → 刷新 → 看效果"，
   而观感问题（大一点小一点、亮一点淡一点、图偏了半个身位）恰恰最需要来回试。
   这里把每个可调项做成滑块/取色器，中间实时预览，右上角一键写回 js/*.js。

   三块内容：
     · 左：素材清单（由 js/asset-schema.js 描述，加新旋钮只改那个文件）
     · 中：预览（按**真实渲染公式**画：尺寸、光晕椭圆、判定圆、呼吸透明度）
           弹道那一类可以**直接拖判定圆**改位置与半径
     · 右：参数控件 + 写回

   写回走本地开发服务器（`tools/serve.mjs` 的 POST /__edit），
   所以**必须用 node tools/serve.mjs 打开这个页面**；
   直接双击 html 只能看不能存（页面上会明确提示）。
   ============================================================ */

import { ASSET_GROUPS, EDIT_FILES, allFields } from './asset-schema.js';
import { SPECIES_BY_ID, SCALE } from './balls.js';
import { YUNCAI, TAOYAO, TINA, JIANQING } from './skills.js';
/* 数值（平衡）那一组的派生面板：把"生命 1500 / 伤害 75 / 冷却 2 秒"
   实时算成"能挨 15 下 / 每秒 37.5 / 打空 1500 血要 40 秒"。公式只此一份。 */
import { rowsFor, deltaText, BALANCE_TITLES, REF_HP } from './balance.js';
/* 保存成功后通知已打开的游戏页（同源跨标签页，见那个文件的说明） */
import { notifyAssetsSaved } from './live-reload.js';
/* render.js 的**整份命名空间**：字段的 key 就是导出名，直接按名字取。
   早先这里手写了一份 GLOBAL_VALUES 清单，结果加开华那一批常量（BLOOM_… / SHAKE_…）
   时忘了登记，编辑器里那几个旋钮就显示成空白（滑条也停在中间）——
   现在不写清单了，加常量不用再动这个文件。 */
import * as RENDER from './render.js';
/* 伤害权重：飘字的字号与打击音的轻重共用这一份刻度（预览里要标出它） */
import { hitWeight } from './audio.js';

const root = document.body;
const canvas = root.querySelector('#edCanvas');
const ctx = canvas.getContext('2d');
const listHost = root.querySelector('#edList');
const fieldsHost = root.querySelector('#edFields');
const titleEl = root.querySelector('#edTitle');
const noteEl = root.querySelector('#edNote');
const groupHintEl = root.querySelector('#edGroupHint');
const statusEl = root.querySelector('#edStatus');
const saveTopBtn = root.querySelector('#edSaveTop');
const dirtyTopEl = root.querySelector('#edDirtyTop');

const PAPER = '#fdfcf7';
const BALL_D = 2 * (SPECIES_BY_ID.test ? SPECIES_BY_ID.test.r : 16);   // 参考尺寸：一个球
const PX_PER_UNIT = 3.2;      // 预览里每个世界单位画多少像素

/* ---------- 1. 现值：直接从运行中的配置里读（不另抄一份默认值） ---------- */

/** pick 路径的根（例如 `YUNCAI.modan` 的第一个名字） */
const PICK_ROOTS = { SPECIES_BY_ID, YUNCAI, TAOYAO, TINA, JIANQING };

/** 按 `A.b.c` 从真实配置里取对象 —— 数值字段用它拿"这个字段属于谁"。
 *  取不到就返回 undefined，于是控件是空的：**不静默猜**，
 *  由 tools/check-asset-schema.mjs 的自检把这种情况揪出来。 */
function pickObject(path) {
  const parts = String(path || '').split('.');
  let v = PICK_ROOTS[parts[0]];
  for (let i = 1; i < parts.length && v != null; i++) v = v[parts[i]];
  return v;
}

function liveValue(field, item) {
  const key = field.key;
  if (field.file === 'render') return RENDER[key];
  /* 数值（平衡）那一组：按 pick 找到对象，再按键取值 */
  if (field.pick) {
    const obj = pickObject(field.pick);
    return obj ? obj[key] : undefined;
  }
  if (item.kind === 'globals') return undefined;
  if (field.file === 'skills') {
    if (field.id.startsWith('yuncai')) return YUNCAI.modan[key];
    if (field.id.startsWith('tinaShot')) return TINA.shot[key];
    if (field.id.startsWith('tinaBat')) return TINA.bat[key];
    if (field.id.startsWith('rongArrow')) return TAOYAO[key];
    if (field.id.startsWith('kuArrow')) return TAOYAO[key];
    return undefined;
  }
  if (item.kind === 'domain') return (SPECIES_BY_ID.yuncai.domain || {})[key];
  if (item.kind === 'bow') {
    const art = SPECIES_BY_ID.taoyao.bow.arts[item.id === 'taoyao_ku_bow' ? 1 : 0];
    return art[key];
  }
  if (item.kind === 'ball') {
    const sp = SPECIES_BY_ID[item.species] || {};
    if (field.id.endsWith('BallR')) return sp.r;
    const st = sp.sticker || {};
    if (field.id.endsWith('BallCx')) return st.cx;
    if (field.id.endsWith('BallCy')) return st.cy;
    if (field.id.endsWith('BallCr')) return st.r;
  }
  return undefined;
}

/* ---------- 2. 状态 ---------- */
const items = [];
for (const g of ASSET_GROUPS) for (const it of g.items) items.push({ ...it, group: g });

const state = {
  itemId: items[0].id,
  values: {},      // field.id → 当前（可能是改过的）值
  base: {},        // field.id → 上一次"落盘"的值（用于算改动量）
  pulseT: 0,
};

const currentItem = () => items.find(i => i.id === state.itemId);
const fieldById = (id) => allFields().find(f => f.id === id);

for (const it of items) {
  for (const f of it.fields) {
    const v = liveValue(f, it);
    state.values[f.id] = v;
    state.base[f.id] = v;
  }
}

/* 改动 = 与 baseline 不同。用比较而不是"打标记"：
   改回原值就不再算改动，保存后也不会残留待写回项（踩过：用 Set 记脏，
   改回原值仍显示待写回，保存后还把相同值又写了一遍）。 */
const isDirty = (id) => {
  const a = state.values[id], b = state.base[id];
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) > 1e-9;
  /* 数字数组（裁光的两档伤害）：按内容比，不能比引用 ——
     否则"编辑过又改回原值"会一直显示成待写回（踩过一次的同类问题）。 */
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length !== b.length || a.some((v, i) => Math.abs(Number(v) - Number(b[i])) > 1e-9);
  }
  return a !== b;
};
const dirtyIds = () => Object.keys(state.values).filter(isDirty);

/* ---------- 3. 左侧清单 ---------- */
function drawList() {
  let html = '';
  let lastGroup = null;
  for (const it of items) {
    if (it.group.id !== lastGroup) {
      lastGroup = it.group.id;
      html += `<div class="ed-group">${it.group.name}</div>`;
    }
    html += `<button class="ed-item${it.id === state.itemId ? ' on' : ''}" data-item="${it.id}">${it.name}</button>`;
  }
  listHost.innerHTML = html;
  listHost.querySelectorAll('[data-item]').forEach(btn => {
    btn.onclick = () => { state.itemId = btn.dataset.item; drawList(); drawEditor(); };
  });
}

/* ---------- 4. 右侧控件 ---------- */
function drawEditor() {
  const it = currentItem();
  titleEl.textContent = it.name;
  noteEl.textContent = it.note || '';
  groupHintEl.textContent = it.group.hint || '';
  /* 弹道这一类可以拖判定圆 —— 提示一下，否则没人知道能拖 */
  const note2 = it.kind === 'proj'
    ? '在预览里**直接拖动判定圆**可以移动它（改的是"图相对判定中心的偏移"），拖圆右边的小方块可以改半径。'
    : '';
  root.querySelector('#edDragHint').textContent = note2;

  fieldsHost.innerHTML = it.fields.map(f => {
    const v = state.values[f.id];
    const id = 'f_' + f.id;
    const warn = f.balance ? ' <span class="ed-warn">⚠ 平衡数值</span>' : '';
    const src = `${EDIT_FILES[f.file]}`;
    if (f.type === 'bool') {
      return `
        <label class="chk">
          <input type="checkbox" id="${id}" ${v ? 'checked' : ''}>
          <span><span class="t">${f.label}${warn}</span>
          <span class="d">${src}</span></span>
        </label>`;
    }
    if (f.type === 'color') {
      return `
        <div class="ed-row">
          <label for="${id}">${f.label}${warn}</label>
          <input type="color" id="${id}" value="${String(v || '#888888')}">
          <span class="ed-val" data-val="${f.id}">${v}</span>
        </div>`;
    }
    if (f.type === 'text') {
      return `
        <div class="ed-row">
          <label for="${id}">${f.label}${warn}</label>
          <input type="text" id="${id}" value="${String(v || '')}" style="flex:1;padding:4px 7px;border:1px solid var(--line);border-radius:7px">
        </div>`;
    }
    /* 数字数组（`dmgByStage: [1, 2]`）：一行小数字框，用逗号/空格分隔。
       用文本框而不是两根滑条 —— 元素个数以后可能会变（两档 → 三档），
       固定两根滑条就把结构写死了。 */
    if (f.type === 'nums') {
      const shown = Array.isArray(v) ? v.join(', ') : String(v ?? '');
      return `
        <div class="ed-field" data-fid="${f.id}">
          <div class="ed-head">
            <span>${f.label}${warn}</span>
            <input type="text" id="${id}" value="${shown}"
                   placeholder="例如 1, 2" style="width:120px;padding:4px 7px;border:1px solid var(--line);border-radius:7px">
          </div>
          <div class="hint">用逗号分隔的一串数字（每个 ${f.min}~${f.max}）</div>
        </div>`;
    }
    /* 数字：一行"标签 + 数字框"，下一行滑块。原来把标签和数字框挤在
       同一行，长标签会折成三行、数字框被挤到角落（截图里就是这样）。 */
    return `
      <div class="ed-field" data-fid="${f.id}">
        <div class="ed-head">
          <span>${f.label}${warn}</span>
          <input type="number" id="${id}" value="${v}" min="${f.min}" max="${f.max}" step="${f.step || 1}">
        </div>
        <input type="range" id="${id}_r" min="${f.min}" max="${f.max}" step="${f.step || 1}" value="${v}">
      </div>`;
  }).join('');

  for (const f of it.fields) {
    const id = 'f_' + f.id;
    const num = fieldsHost.querySelector('#' + id);
    const rng = fieldsHost.querySelector('#' + id + '_r');
    const setVal = (raw) => {
      let v = raw;
      if (f.type === 'number') {
        v = Number(raw);
        if (!Number.isFinite(v)) return;
        v = Math.min(f.max, Math.max(f.min, v));
      } else if (f.type === 'bool') {
        v = !!raw;
      } else if (f.type === 'nums') {
        /* "1, 2" → [1, 2]：逐项夹到 min~max；留空/非法项直接丢掉。
           全是空的就**不改**（而不是写一个空数组进源码 —— 那会让
           引擎拿到 [] 而静默失去这一档伤害）。 */
        const nums = String(raw).split(/[,，\s]+/).filter(s => s !== '')
          .map(Number).filter(Number.isFinite)
          .map(x => Math.min(f.max, Math.max(f.min, x)));
        if (!nums.length) return;
        v = nums;
      }
      state.values[f.id] = v;
      if (num && f.type !== 'bool') num.value = f.type === 'nums' ? v.join(', ') : v;
      if (rng) rng.value = v;
      if (f.type === 'color') {
        const label = fieldsHost.querySelector(`[data-val="${f.id}"]`);
        if (label) label.textContent = v;
      }
      drawPreview();
      drawStatus();
    };
    if (num) {
      num.oninput = () => setVal(f.type === 'bool' ? num.checked : num.value);
      num.onchange = num.oninput;
    }
    if (rng) rng.oninput = () => setVal(rng.value);
    /* 标出改动过的字段，一眼能看出哪几个动过 */
    const box = fieldsHost.querySelector(`[data-fid="${f.id}"]`);
    if (box && isDirty(f.id)) box.classList.add('dirty');
  }
  drawPreview();
  drawStatus();
}

/* ---------- 5. 预览 ---------- */
function hexA(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return `rgba(125,211,252,${a})`;
  const v = parseInt(m[1], 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}

const imgCache = new Map();
function loadImg(src) {
  if (!imgCache.has(src)) {
    const img = new Image();
    img.src = src;
    imgCache.set(src, img);
  }
  return imgCache.get(src);
}

/** 预览里"判定圆"的位置与半径（画布像素）。拖动逻辑与绘制共用同一份计算。 */
export function circlePosFor(offX, offY) {
  const cx = canvas.width / 2, cy = canvas.height / 2;
  /* 图固定在画布中心，圆按"图相对判定中心的偏移"反向偏 ——
     这样拖动时图不会跟着跑，手感就是"把判定圆拖到图上该在的位置"。 */
  return { x: cx - offX * PX_PER_UNIT, y: cy - offY * PX_PER_UNIT };
}

/** circlePosFor 的逆：把判定圆拖到 (x, y) 等于把偏移改成多少。
 *  拖动逻辑只用这一个函数，所以"拖到哪 → 存什么数"不可能和绘制对不上。 */
export function offsetForCirclePos(x, y) {
  const cx = canvas.width / 2, cy = canvas.height / 2;
  return { offX: (cx - x) / PX_PER_UNIT, offY: (cy - y) / PX_PER_UNIT };
}

function hitCirclePx(it) {
  const offX = Number(state.values[it.fields.find(f => f.id.endsWith('OffX')).id] ?? 0);
  const offY = Number(state.values[it.fields.find(f => f.id.endsWith('OffY')).id] ?? 0);
  const rField = it.fields.find(f => f.id.endsWith('R') && f.balance);
  const r = Number(state.values[rField.id] ?? 5);
  const p = circlePosFor(offX, offY);
  return { x: p.x, y: p.y, r: r * PX_PER_UNIT, rWorld: r };
}

function drawPreview() {
  const it = currentItem();
  const W = canvas.width, H = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);

  if (root.querySelector('#edGrid').checked) {
    ctx.strokeStyle = '#eee9db';
    ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += 24) { ctx.beginPath(); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, H); ctx.stroke(); }
    for (let y = 0; y <= H; y += 24) { ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(W, y + .5); ctx.stroke(); }
  }

  const cx = W / 2, cy = H / 2;
  const showRing = root.querySelector('#edRing').checked;
  const animate = root.querySelector('#edPulse').checked;
  const pulse = animate
    ? 0.5 - 0.5 * Math.cos((state.pulseT / 60) * RENDER.PROJ_PULSE_HZ * Math.PI * 2)
    : 0.5;
  const px = PX_PER_UNIT;

  if (it.kind === 'proj') {
    const lenField = it.fields.find(f => f.id.endsWith('Len'));
    const len = lenField ? Number(state.values[lenField.id] ?? 20) : 45;
    const glowField = it.fields.find(f => f.id.endsWith('Glow'));
    const glow = glowField ? String(state.values[glowField.id] ?? '#a855f7') : '#a855f7';
    const pulseField = it.fields.find(f => f.id.endsWith('Pulse'));
    const breathing = pulseField ? !!state.values[pulseField.id] : false;
    const offX = Number(state.values[it.fields.find(f => f.id.endsWith('OffX')).id] ?? 0);
    const offY = Number(state.values[it.fields.find(f => f.id.endsWith('OffY')).id] ?? 0);
    const img = loadImg(it.src);
    const ratio = (img.naturalHeight && img.naturalWidth) ? img.naturalHeight / img.naturalWidth : 0.78;
    const L = len * px, Hg = L * ratio;
    const artA = breathing ? RENDER.PROJ_ALPHA_MIN + (RENDER.PROJ_ALPHA_MAX - RENDER.PROJ_ALPHA_MIN) * pulse : 1;
    const ga = RENDER.PROJ_GLOW_ALPHA * (breathing ? RENDER.PROJ_GLOW_FLOOR + (1 - RENDER.PROJ_GLOW_FLOOR) * pulse : 1);

    /* 图的位置 = 判定中心 + 偏移；预览里判定中心固定在画布中心，
       所以图直接画在中心，圆按反向偏 —— 见 hitCirclePx 的说明。 */
    const grx = Math.max(1, L * RENDER.PROJ_GLOW_RX), gry = Math.max(1, Hg * RENDER.PROJ_GLOW_RY);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(grx, gry));
    g.addColorStop(0, hexA(glow, ga));
    g.addColorStop(0.55, hexA(glow, ga * 0.4));
    g.addColorStop(1, hexA(glow, 0));
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 0, grx, gry, 0, 0, Math.PI * 2);
    ctx.fill();
    if (img.complete && img.naturalWidth) {
      ctx.globalAlpha = artA;
      ctx.drawImage(img, -L / 2, -Hg / 2, L, Hg);
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = '#ddd';
      ctx.fillRect(-L / 2, -Hg / 2, L, Hg);
    }
    ctx.restore();

    /* 判定圆：位置与半径都可拖/可改 */
    const c = hitCirclePx(it);
    ctx.strokeStyle = dragging.mode ? '#b45309' : '#0e7490';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    /* 手柄：拖它改半径 */
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillRect(c.x + c.r - 4, c.y - 4, 8, 8);
    /* 从判定中心到图中心的连线，直观看出偏移 */
    if (offX || offY) {
      ctx.strokeStyle = 'rgba(180,83,9,.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(cx, cy); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(14,116,144,.9)';
    ctx.font = '11px sans-serif';
    ctx.fillText(`判定半径 ${c.rWorld}`, c.x + c.r + 8, c.y - 4);
    ctx.fillStyle = '#b45309';
    ctx.fillText(`偏移 (${offX}, ${offY})`, c.x - 24, c.y + c.r + 15);

    if (showRing) {
      ctx.strokeStyle = 'rgba(120,113,98,.45)';
      ctx.beginPath();
      ctx.moveTo(cx - BALL_D * px / 2, 16); ctx.lineTo(cx + BALL_D * px / 2, 16);
      ctx.stroke();
      ctx.fillStyle = 'rgba(90,85,72,.8)';
      ctx.font = '11px sans-serif';
      ctx.fillText(`球直径 ${BALL_D}`, cx + BALL_D * px / 2 + 6, 20);
    }
    ctx.fillStyle = '#5b5546';
    ctx.font = '12px sans-serif';
    ctx.fillText(`尺寸 ${len} × 图高 ${(len * ratio).toFixed(1)}`, 10, H - 12);
    ctx.fillText(`图透明度 ${(artA * 100).toFixed(0)}%${breathing ? '（呼吸中）' : '（不呼吸）'}`, 10, H - 30);
  } else if (it.kind === 'bow') {
    const art = SPECIES_BY_ID.taoyao.bow.arts[it.id === 'taoyao_ku_bow' ? 1 : 0];
    const bowH = Number(state.values[it.fields.find(f => f.id.endsWith('BowH')).id] ?? art.bowH);
    const lenFrac = Number(state.values[it.fields.find(f => f.id.endsWith('ArrowLen')).id] ?? art.arrowLenFrac);
    const img = loadImg(it.src);
    if (img.complete && img.naturalWidth) {
      const dw = bowH * px, dh = bowH * px;
      ctx.drawImage(img, cx - art.anchor.x * dw, cy - art.anchor.y * dh, dw, dh);
      if (showRing) {
        ctx.strokeStyle = '#0e7490'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, 2, 0, Math.PI * 2); ctx.stroke();
        const nx = cx + (art.nock.x - art.anchor.x) * dw;
        const ny = cy + (art.nock.y - art.anchor.y) * dh;
        ctx.strokeStyle = '#d97706';
        ctx.beginPath(); ctx.arc(nx, ny, 3, 0, Math.PI * 2); ctx.stroke();
        const aLen = bowH * lenFrac * px;
        ctx.beginPath(); ctx.moveTo(nx, ny); ctx.lineTo(nx + aLen, ny); ctx.stroke();
        ctx.strokeStyle = 'rgba(120,113,98,.45)';
        ctx.beginPath(); ctx.arc(cx, cy, BALL_D * px / 2, 0, Math.PI * 2); ctx.stroke();
      }
    }
    const bw = (img.naturalWidth && img.naturalHeight) ? bowH * (img.naturalWidth / img.naturalHeight) : bowH * 0.35;
    ctx.fillStyle = '#5b5546'; ctx.font = '12px sans-serif';
    ctx.fillText(`弓高 ${bowH} → 弓宽 ${bw.toFixed(1)}`, 10, H - 12);
    ctx.fillText(`箭长 = 弓高 × ${lenFrac} = ${(bowH * lenFrac).toFixed(1)}`, 10, H - 30);
    ctx.fillText('青点 = 球心（锚点）　橙点 = 搭箭点', 10, 20);
  } else if (it.kind === 'ball') {
    const sp = SPECIES_BY_ID[it.species];
    const r = Number(state.values[it.fields.find(f => f.id.endsWith('BallR')).id] ?? sp.r);
    const st = sp.sticker || {};
    const vCx = Number(state.values[it.fields.find(f => f.id.endsWith('BallCx')).id] ?? st.cx);
    const vCy = Number(state.values[it.fields.find(f => f.id.endsWith('BallCy')).id] ?? st.cy);
    const vCr = Number(state.values[it.fields.find(f => f.id.endsWith('BallCr')).id] ?? st.r);
    const img = loadImg(it.src);
    const R = r * px;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
    if (img.complete && img.naturalWidth) {
      const iw = img.naturalWidth, ih = img.naturalHeight;
      const srcR = vCr * Math.min(iw, ih);
      ctx.drawImage(img, vCx * iw - srcR, vCy * ih - srcR, srcR * 2, srcR * 2, cx - R, cy - R, R * 2, R * 2);
    }
    ctx.restore();
    if (showRing) {
      ctx.strokeStyle = '#0e7490'; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = '#5b5546'; ctx.font = '12px sans-serif';
    ctx.fillText(`半径 ${r}（直径 ${(r * 2).toFixed(1)}，同时是判定直径）`, 10, H - 12);
  } else if (it.kind === 'domain') {
    const op = Number(state.values[it.fields.find(f => f.id === 'domOpacity').id] ?? 0.42);
    const img = loadImg(it.src);
    if (img.complete && img.naturalWidth) {
      ctx.globalAlpha = op;
      ctx.drawImage(img, 0, 0, W, H);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = '#5b5546'; ctx.font = '12px sans-serif';
    ctx.fillText(`不透明度 ${(op * 100).toFixed(0)}%`, 10, H - 12);
  } else if (it.kind === 'balance') {
    /* 数值面板：左边是"原料"（生命 / 速度 / 每个技能的伤害与冷却），
       右边是**实时算出来的结论**（能挨几下、每秒打多少、打空 1500 血要几秒）。
       作者的诉求是"实时修改"，光看输入框里的数字没有体感 ——
       改一个伤害，右边立刻告诉你这一改意味着什么。
       公式全部来自 js/balance.js（预览与诊断共用一份，不会漂）。 */
    const values = {};
    for (const f of it.fields) values[f.id] = state.values[f.id];

    const changed = it.fields.filter(f => isDirty(f.id));
    const deriveRows = rowsFor(it.id, values);
    /* 行高自适应：晕彩技能那一项有 24 个字段，固定 19px 会画到画布外面去
       （画布高度随窗口变）。宁可行距挤一点，也不要让作者以为"后面几项不存在"。 */
    const rowCount = Math.max(it.fields.length, deriveRows.length, 1);
    const rh = Math.max(12, Math.min(19, Math.floor((H - 96) / rowCount)));
    const fs = rh >= 17 ? 12.5 : 11.5;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    /* 顶栏：这一项是什么 + 改了几项 */
    ctx.fillStyle = '#5b5546';
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText(BALANCE_TITLES[it.id] || it.name, 14, 26);
    ctx.font = '12px sans-serif';
    ctx.fillStyle = changed.length ? '#b45309' : '#8a8375';
    ctx.fillText(changed.length
      ? `⚠ 有 ${changed.length} 项改动还没保存（保存后刷新游戏页才生效）`
      : '没有未保存的改动 —— 改右边的数字，这里会立刻重算', 14, 46);

    /* 左侧：原料（名称 + 值 + 相对基线的变化） */
    let y = 70 + rh;
    const colW = Math.floor(W / 2) - 20;
    for (const f of it.fields) {
      const v = state.values[f.id];
      const dirty = isDirty(f.id);
      const text = Array.isArray(v) ? v.join(' / ') : String(v);
      ctx.font = `${fs}px sans-serif`;
      ctx.fillStyle = dirty ? '#b45309' : '#5b5546';
      ctx.fillText(f.label, 14, y);
      ctx.fillStyle = '#221f18';
      ctx.font = `bold ${fs}px sans-serif`;
      ctx.textAlign = 'right';
      ctx.fillText(text, colW, y);
      ctx.textAlign = 'left';
      if (dirty) {
        const d = deltaText(state.base[f.id], v);
        if (d) {
          ctx.fillStyle = '#b45309';
          ctx.fillText(d, colW + 6, y);
        }
      }
      y += rh;
      if (y > H - 24) break;      // 放不下就不画了（不硬挤成乱码）
    }

    /* 右侧：派生结论 */
    const rx = Math.floor(W / 2) + 10;
    ctx.fillStyle = '#0e7490';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText('实时推算（按当前值）', rx, 70 + rh);
    let ry = 70 + rh * 2;
    ctx.font = `${fs}px sans-serif`;
    for (const r of deriveRows) {
      ctx.fillStyle = '#5b5546';
      ctx.fillText(r.label, rx, ry);
      ctx.fillStyle = '#0f172a';
      ctx.font = `bold ${fs}px sans-serif`;
      ctx.textAlign = 'right';
      ctx.fillText(String(r.text), W - 14, ry);
      ctx.textAlign = 'left';
      ctx.font = `${fs}px sans-serif`;
      ry += rh;
      if (ry > H - 24) break;
    }
    ctx.fillStyle = '#8a8375';
    ctx.font = '11.5px sans-serif';
    ctx.fillText(`参考靶血量 ${REF_HP}（晕彩默认生命）；"每帧伤害 × 60" 是按 60 帧 = 1 秒折算`, 14, H - 10);
  } else if (it.id === 'dmgtext') {
    /* 伤害飘字：三档伤害各画两遍 —— 左边压在浅色纸上、右边压在深色球面上，
       因为"显不显眼"必须在这两种底色上都成立（红字在纸上飘、在球面上糊，
       都是真实会出现的情况）。公式调的是 render.js 的 drawDamageNumber()，
       和游戏里画的是**同一个函数**。
       画在 ageFrames = 0 的瞬间，也就是"出现时最大"的那一帧。 */
    const num = (id, dflt) => {
      const v = state.values[id];
      return Number.isFinite(Number(v)) ? Number(v) : dflt;
    };
    const opts = {
      px: num('dmgPx', RENDER.DMG_FONT_PX),
      weight: num('dmgWeight', RENDER.DMG_WEIGHT),
      color: state.values.dmgColor || RENDER.DMG_COLOR,
      outline: state.values.dmgOutline || RENDER.DMG_OUTLINE,
      outlineW: num('dmgOutlineW', RENDER.DMG_OUTLINE_W),
      sizeGain: num('dmgGain', RENDER.DMG_SIZE_GAIN),
      pop: num('dmgPop', RENDER.DMG_POP),
    };
    const samples = [
      { dmg: 66, name: '球撞球 66' },
      { dmg: 200, name: '技能 200' },
      { dmg: 400, name: '重击 400' },
    ];
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const y = 100 + i * 118;
      const w = hitWeight(s.dmg);
      /* 右边这一列垫一颗"球"：深色贴图是伤害数字最常出现的背景 */
      const darkX = cx + 150;
      ctx.fillStyle = '#3b3550';
      ctx.beginPath(); ctx.arc(darkX, y, 52, 0, Math.PI * 2); ctx.fill();
      RENDER.drawDamageNumber(ctx, `-${s.dmg}`, cx - 130, y, w, 0, opts);
      RENDER.drawDamageNumber(ctx, `-${s.dmg}`, darkX, y, w, 0, opts);
      ctx.fillStyle = '#8a8375';
      ctx.font = '12px sans-serif';
      ctx.fillText(`${s.name}　权重 ${w.toFixed(2)}　字号 ${(opts.px * (1 + opts.sizeGain * w)).toFixed(1)}px`,
        14, y + 78);
    }
    ctx.fillStyle = '#5b5546';
    ctx.font = '12px sans-serif';
    ctx.fillText('左：压在浅色方格纸上　右：压在深色球面上（两种底色都要看得清）', 14, 26);
    ctx.fillText(`出现瞬间放大 ${opts.pop}× 然后收回 1.0；上升 ${num('dmgRise', RENDER.DMG_RISE)} 世界单位 / 22 帧`,
      14, H - 14);
  } else {
    ctx.fillStyle = '#5b5546'; ctx.font = '13px sans-serif';
    ctx.fillText('这些是全局参数，改动会影响所有贴图弹道与光柱。', 14, 24);
    const img = loadImg('assets/characters/yuncai_bolt.png');
    const L = 20 * px, Hg = L * 0.78;
    const artA = RENDER.PROJ_ALPHA_MIN + (RENDER.PROJ_ALPHA_MAX - RENDER.PROJ_ALPHA_MIN) * pulse;
    const ga = RENDER.PROJ_GLOW_ALPHA * (RENDER.PROJ_GLOW_FLOOR + (1 - RENDER.PROJ_GLOW_FLOOR) * pulse);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(L * RENDER.PROJ_GLOW_RX, Hg * RENDER.PROJ_GLOW_RY));
    g.addColorStop(0, hexA('#a855f7', ga));
    g.addColorStop(0.55, hexA('#a855f7', ga * 0.4));
    g.addColorStop(1, hexA('#a855f7', 0));
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(0, 0, Math.max(1, L * RENDER.PROJ_GLOW_RX), Math.max(1, Hg * RENDER.PROJ_GLOW_RY), 0, 0, Math.PI * 2); ctx.fill();
    if (img.complete && img.naturalWidth) {
      ctx.globalAlpha = artA;
      ctx.drawImage(img, -L / 2, -Hg / 2, L, Hg);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    ctx.fillStyle = '#5b5546';
    ctx.fillText(`样本（魔弹 20 单位）：图透明度 ${(artA * 100).toFixed(0)}%，光晕峰值 ${(ga * 100).toFixed(0)}%`, 14, H - 14);
  }
}

/* ---------- 6. 拖动判定圆（移动 + 改半径） ---------- */
const dragging = { mode: null, dx: 0, dy: 0 };

/** 鼠标/触摸坐标 → 画布坐标（画布被 CSS 缩放过，必须换算） */
function toCanvas(e) {
  const rect = canvas.getBoundingClientRect();
  const sx = rect.width ? canvas.width / rect.width : 1;
  const sy = rect.height ? canvas.height / rect.height : 1;
  return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
}

canvas.addEventListener('pointerdown', (e) => {
  const it = currentItem();
  if (it.kind !== 'proj') return;
  const c = hitCirclePx(it);
  const p = toCanvas(e);
  const d = Math.hypot(p.x - c.x, p.y - c.y);
  const onHandle = Math.abs(p.x - (c.x + c.r)) <= 9 && Math.abs(p.y - c.y) <= 9;
  if (onHandle) dragging.mode = 'resize';
  else if (d <= c.r + 10) dragging.mode = 'move';
  else return;
  e.preventDefault();
  if (canvas.setPointerCapture && e.pointerId !== undefined) {
    try { canvas.setPointerCapture(e.pointerId); } catch { /* 无头环境没有 */ }
  }
  dragging.dx = p.x - c.x;
  dragging.dy = p.y - c.y;
  drawPreview();
});

function onDragMove(e) {
  if (!dragging.mode) return;
  const it = currentItem();
  if (it.kind !== 'proj') return;
  const c = hitCirclePx(it);
  const p = toCanvas(e);
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const round = (v, step) => Math.round(v / step) * step;
  if (dragging.mode === 'resize') {
    const rField = it.fields.find(f => f.id.endsWith('R') && f.balance);
    const raw = Math.hypot(p.x - c.x, p.y - c.y) / PX_PER_UNIT;
    applyValue(rField, round(Math.min(rField.max, Math.max(rField.min, raw)), rField.step || 0.5));
  } else {
    /* 把圆拖到 p：圆心 = p - 抓取偏移；再由圆心反推偏移（offsetForCirclePos） */
    const nx = p.x - dragging.dx, ny = p.y - dragging.dy;
    const off = offsetForCirclePos(nx, ny);
    const offXField = it.fields.find(f => f.id.endsWith('OffX'));
    const offYField = it.fields.find(f => f.id.endsWith('OffY'));
    applyValue(offXField, round(Math.min(offXField.max, Math.max(offXField.min, off.offX)), 0.5));
    applyValue(offYField, round(Math.min(offYField.max, Math.max(offYField.min, off.offY)), 0.5));
  }
}
/** 改一个字段的值，并把它在右栏的控件同步过来 */
function applyValue(field, value) {
  if (!field) return;
  state.values[field.id] = value;
  const num = fieldsHost.querySelector('#f_' + field.id);
  const rng = fieldsHost.querySelector('#f_' + field.id + '_r');
  if (num) num.value = value;
  if (rng) rng.value = value;
  const box = fieldsHost.querySelector(`[data-fid="${field.id}"]`);
  if (box) box.classList.toggle('dirty', isDirty(field.id));
  drawPreview();
  drawStatus();
}
canvas.addEventListener('pointermove', onDragMove);
canvas.addEventListener('pointermove', (e) => {
  if (dragging.mode) return;
  const it = currentItem();
  /* 光标提示：圆上是"可拖"，手柄上是"可缩放" */
  if (it.kind !== 'proj') { canvas.style.cursor = 'default'; return; }
  const c = hitCirclePx(it);
  const p = toCanvas(e);
  const onHandle = Math.abs(p.x - (c.x + c.r)) <= 9 && Math.abs(p.y - c.y) <= 9;
  const inside = Math.hypot(p.x - c.x, p.y - c.y) <= c.r + 10;
  canvas.style.cursor = onHandle ? 'nwse-resize' : (inside ? 'move' : 'default');
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
  canvas.addEventListener(ev, () => {
    if (!dragging.mode) return;
    dragging.mode = null;
    drawPreview();
  });
}

/* ---------- 7. 状态与保存 ---------- */
function drawStatus() {
  const ids = dirtyIds();
  dirtyTopEl.textContent = ids.length ? `● 未保存 ${ids.length} 项` : '';
  dirtyTopEl.style.color = ids.length ? '#b45309' : '';
  if (!ids.length) {
    statusEl.innerHTML = '<span class="hint">没有改动。改完点右上角「一键保存」写入 js/*.js。</span>';
    return;
  }
  statusEl.innerHTML = `<span class="ed-dirty">${ids.length} 项待写回</span>` +
    '<div class="ed-out mono hint">' + ids.map(id => {
      const f = fieldById(id);
      return f ? `${EDIT_FILES[f.file]}  ${f.key}: ${state.base[id]} → ${state.values[id]}` : id;
    }).join('\n') + '</div>';
}

async function saveAll() {
  const ids = dirtyIds();
  if (!ids.length) { statusEl.innerHTML = '<span class="hint">没有改动，不用保存。</span>'; return; }
  const edits = ids.map(id => ({ id, value: state.values[id] }));
  statusEl.textContent = '正在写回…';
  saveTopBtn.disabled = true;
  try {
    const r = await fetch('/__edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edits })
    });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* 不是 JSON —— 多半是打到了静态文件处理器 */ }
    if (!j) {
      /* 服务器版本太旧：老 serve.mjs 没有 /__edit，会把 POST 当静态请求处理。
         这条提示是给"页面开着、服务器没重启"的情况写的（作者第一次点保存就撞上了）。 */
      statusEl.innerHTML = '<span class="ed-bad">写回失败：服务器没有 /__edit 接口。</span>' +
        '<div class="hint">说明当前跑着的 <b>tools/serve.mjs 是旧版</b>：' +
        '关掉那个窗口、重新 <b>node tools/serve.mjs</b>，再刷新本页即可。</div>';
      return;
    }
    if (!r.ok || !j.ok) {
      statusEl.innerHTML = `<span class="ed-bad">写回失败：${j.error || r.status}</span>` +
        '<div class="hint">这一步没有改动任何文件。可以直接把上面的参数手工抄进源码。</div>';
      return;
    }
    /* 落盘成功 → 更新 baseline：这样"放弃改动"回到的是刚保存的值，
       待写回列表也会清空（而不是继续显示刚保存过的东西）。 */
    for (const id of ids) state.base[id] = state.values[id];
    /* 顺手通知**已打开的游戏页**：引擎在页面加载时读一次配置，
       改完不刷新是不会生效的。以前这要靠作者自己记得 Ctrl+F5，
       现在游戏页会弹一条「素材已更新 · 点击刷新」。 */
    const summary = j.applied.map(a => {
      const f = fieldById(a.id);
      return `${f ? f.label : a.key}: ${a.before} → ${a.after}`;
    }).join('；');
    const noticed = notifyAssetsSaved(summary);
    statusEl.innerHTML = `<span class="ed-ok">✅ 已保存 ${j.applied.length} 项</span>` +
      '<div class="ed-out mono hint">' + j.applied.map(a =>
        `${EDIT_FILES[a.short]}:${a.lineNo}  ${a.key}: ${a.before} → ${a.after}`).join('\n') + '</div>' +
      '<div class="hint">原文件已备份为同名 .bak。' +
      (noticed
        ? '已打开的游戏页会弹出<b>「素材已更新 · 点击刷新」</b>，点一下就生效（引擎只在页面加载时读配置）。'
        : '刷新游戏页面就能看到新数值。') + '</div>';
    drawEditor();
  } catch (e) {
    statusEl.innerHTML = `<span class="ed-bad">写回失败：${e.message}</span>` +
      '<div class="hint">这个页面需要通过 <b>node tools/serve.mjs</b> 打开' +
      '（直接双击 html 时没有后端，改不了文件）。</div>';
  } finally {
    saveTopBtn.disabled = false;
    drawStatus();
  }
}

root.querySelector('#edSave').onclick = saveAll;
saveTopBtn.onclick = saveAll;
/* Ctrl/Cmd + S 也走同一条路 */
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 's') {
    e.preventDefault();
    saveAll();
  }
});

root.querySelector('#edReset').onclick = () => {
  for (const id of Object.keys(state.values)) state.values[id] = state.base[id];
  drawEditor();
};

root.querySelector('#edCopy').onclick = async () => {
  const ids = dirtyIds();
  const lines = ids.length
    ? ids.map(id => {
      const f = fieldById(id);
      return `${EDIT_FILES[f.file]}  ${f.key}: ${state.values[id]}`;
    }).join('\n')
    : '（没有改动）';
  try {
    await navigator.clipboard.writeText(lines);
    statusEl.textContent = '已复制改动清单到剪贴板。';
  } catch {
    statusEl.innerHTML = '<div class="ed-out mono hint">' + lines + '</div>';
  }
};

for (const id of ['edPulse', 'edRing', 'edGrid']) {
  root.querySelector('#' + id).onchange = () => drawPreview();
}

/* ---------- 8. 启动 ---------- */
drawList();
drawEditor();

let last = performance.now();
function tick(now) {
  const dt = Math.min(120, now - last);
  last = now;
  if (root.querySelector('#edPulse').checked && !dragging.mode) {
    state.pulseT += dt / 1000 * 60;
    drawPreview();
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

for (const it of items) {
  if (!it.src) continue;
  const img = loadImg(it.src);
  img.onload = () => drawPreview();
}

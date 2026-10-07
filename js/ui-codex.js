/* ============================================================
   ui-codex.js — 图鉴：查看每个小球的属性与技能
   ============================================================ */

import { SPECIES, SPECIES_BY_ID, SCALE } from './balls.js';
import { getSkill, TRIGGER_LABELS, skillDesc } from './skills.js';
import { getSkillDetail, setSkillDetail, onPrefsChange } from './prefs.js';
import { sketchBall } from './sketch.js';

export function renderCodex(root) {
  const state = { selected: SPECIES[0].id };

  root.innerHTML = `
    <div class="topbar">
      <div class="brand">图鉴<small>查看每个小球的属性、特殊资源与技能</small></div>
      <div class="spacer"></div>
      <button class="btn" id="cdBack">返回主菜单</button>
    </div>
    <p class="lead">
      这里是小球的内容库。战斗中的一切行为都由这张表决定 ——
      接入原创角色时只需往表里加条目，引擎不需要改动。
    </p>
    <div class="prep-grid">
      <div>
        <div class="codex-grid" id="cdGrid"></div>
      </div>
      <div>
        <div class="card" id="cdDetail"></div>
      </div>
    </div>
  `;

  root.querySelector('#cdBack').onclick = () => { location.hash = ''; };

  const grid = root.querySelector('#cdGrid');
  const detail = root.querySelector('#cdDetail');

  function drawGrid() {
    grid.innerHTML = '';
    for (const sp of SPECIES) {
      const el = document.createElement('div');
      el.className = 'codex-card' + (sp.id === state.selected ? ' on' : '');
      el.innerHTML = `
        <canvas></canvas>
        <div class="nm">${sp.name}</div>
        <div class="sub">HP ${sp.hp} · ${sp.r >= 20 ? '大型' : sp.r <= 14 ? '小型' : '中型'}</div>
        <div class="mini">${sp.skills.length ? sp.skills.length + ' 个技能' : '无技能'}${sp.resource ? ' · 有资源' : ''}</div>
      `;
      el.onclick = () => { state.selected = sp.id; drawGrid(); drawDetail(); };
      grid.appendChild(el);
      sketchBall(el.querySelector('canvas'), sp, 78);
    }
  }

  function drawDetail() {
    const sp = SPECIES_BY_ID[state.selected];
    /* 简要 / 详细 由 prefs 统一决定（注意别用 detail 当变量名 —— 
       下面 detail 是详情面板的 DOM 元素，重名会把它覆盖掉） */
    const useDetail = getSkillDetail();
    // 优先用小球贴图（角色头部圆形贴图），其次立绘，最后用 canvas 画一个示意球
    const stickerSrc = sp.sticker ? sp.sticker.src : null;
    const img = sp.image || stickerSrc;
    detail.innerHTML = `
      <div style="display:flex;gap:14px;align-items:center;margin-bottom:12px">
        ${img
          ? `<img src="${img}" alt="" style="width:76px;height:76px;border-radius:${stickerSrc && !sp.image ? '50%' : '50%'};object-fit:cover;border:2px solid #3a352a">`
          : `<canvas id="cdBig" style="width:76px;height:76px"></canvas>`}
        <div>
          <div style="font-size:17px;font-weight:700">${sp.name}</div>
          <div style="margin-top:3px">${sp.tags.map(t => `<span class="tag">${t}</span>`).join('')}</div>
        </div>
      </div>

      <p style="margin:0 0 12px;font-size:13px;color:#7b7466">${sp.desc}</p>

      <h3>基础属性</h3>
      <div class="statgrid">
        <div class="statbox"><div class="k">生命</div><div class="v">${sp.hp}</div></div>
        <div class="statbox"><div class="k">移速</div><div class="v">${sp.speed}</div></div>
        <div class="statbox"><div class="k">碰撞伤害</div><div class="v">${sp.melee}</div></div>
        <div class="statbox"><div class="k">半径</div><div class="v">${sp.r}</div></div>
      </div>

      <h3 style="margin-top:16px">特殊资源</h3>
      ${sp.resource ? `
        <div class="statbox" style="background:${sp.resource.color}18;border-color:${sp.resource.color}55">
          <div class="k">${sp.resource.name}</div>
          <div class="v" style="font-size:13px;font-weight:600;margin-top:2px">
            上限 ${sp.resource.max} · 每秒 +${sp.resource.gainPerSec}${sp.resource.gainOnHit ? ` · 命中 +${sp.resource.gainOnHit}` : ''}
          </div>
          <div class="hint" style="margin-top:4px">战斗中显示在小球下方</div>
        </div>
      ` : `<div class="hint">该小球没有特殊资源，战斗中只显示上方的血条。</div>`}

      <div style="display:flex;align-items:center;gap:8px;margin-top:16px">
        <h3 style="margin:0">技能</h3>
        <span class="spacer" style="flex:1"></span>
        <span class="hint">描述：</span>
        <div class="seg sm" id="cdDescMode">
          <button data-detail="0">简要</button>
          <button data-detail="1">详细</button>
        </div>
      </div>
      ${sp.skills.length ? sp.skills.map(id => {
        /* SPECIES.skills 里存的是技能 id（字符串），要查注册表拿到名字和说明。
           这里以前直接当对象用（s.name / s.desc），卡片会渲染成空白。 */
        const sk = getSkill(id);
        if (!sk) {
          return `<div class="card" style="padding:10px 12px;margin-bottom:8px">
            <div style="font-weight:600">未知技能</div>
            <div class="hint mono">${id} —— 在 js/skills.js 的 SKILLS 注册表里找不到</div>
          </div>`;
        }
        const trg = sk.trigger && sk.trigger.type;
        const cd = sk.trigger && sk.trigger.cd;
        return `
        <div class="card" style="padding:10px 12px;margin-bottom:8px">
          <div style="font-weight:600">${sk.name}</div>
          <div class="hint">${skillDesc(sk, useDetail)}</div>
          <div class="mini" style="margin-top:4px">
            <span class="mono">${sk.id}</span> · 触发：${TRIGGER_LABELS[trg] || trg || '—'}${cd ? `（冷却 ${cd}s）` : ''}
          </div>
        </div>`;
      }).join('') : `
        <div class="hint">
          暂无技能。框架已预留技能接口（<span class="mono">onThink / onBeforeDamage / onHit / onDeath</span>），
          后续录入角色时再填。
        </div>
      `}
    `;
    if (!img) sketchBall(detail.querySelector('#cdBig'), sp, 76);

    /* 简要 / 详细 切换：状态存在 prefs 里，两个界面共用同一份偏好 */
    const seg = detail.querySelector('#cdDescMode');
    if (seg) {
      seg.querySelectorAll('button').forEach(b => {
        if ((b.dataset.detail === '1') === useDetail) b.classList.add('on');
        b.onclick = () => { setSkillDetail(b.dataset.detail === '1'); };
      });
    }
  }

  /* 别的界面（准备界面）改了偏好，这里也要跟着重画 */
  onPrefsChange(() => drawDetail());

  drawGrid();
  drawDetail();
}

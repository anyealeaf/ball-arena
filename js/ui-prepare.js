/* ============================================================
   ui-prepare.js — 斗蛐蛐准备：队伍数量 / 场地 / 参与小球 / 特殊选项
   ------------------------------------------------------------
   说明：斗蛐蛐类游戏里，"准备"界面承担了几乎全部的策略乐趣，
   因为开战之后玩家就不再干预了。所以这里做得比战斗界面更厚。
   ============================================================ */

import {
  SPECIES, SPECIES_BY_ID, PLAYABLE_SPECIES, DEFAULT_SPECIES_ID, DEFAULT_RULES,
  TIME_LIMIT_OPTIONS, MAX_TEAMS, teamColor, makeUnitStats,
  MAX_SKILLS_PER_UNIT, defaultSkillsFor, normalizeSkills
} from './balls.js';
import { getSkill, skillDesc, resolveLoadout, conflictsWithChosen, manualSkillIds } from './skills.js';
import {
  getSkillDetail, setSkillDetail, onPrefsChange, getDetailOpen, setDetailOpen,
} from './prefs.js';
import { ARENAS, ARENA_BY_ID, zoneLabel, effectLabels } from './arenas.js';
import { sketchArena, sketchBall } from './sketch.js';
import { bindKbCapture, cancelKeyCapture, drawKeybindEditor } from './keybind.js';

const STORAGE_KEY = 'ballBattle.prepare.v1';

/* ---------- 玩家按键的"按下新键"捕捉 ----------
   实现在 keybind.js（准备界面与战斗界面的「按键设置」共用同一份捕捉逻辑 +
   同一张键位表；两处各写一份的下场是"一边能绑、一边绑了不生效"）。
   这里只留一个"切界面时把捕捉状态清掉"的动作。 */

/* 每个队伍最多 / 最少放几个小球 */
const MIN_PER_TEAM = 1;
const MAX_PER_TEAM = 20;

export function renderPrepare(root, onStart) {
  /* ---------- 状态 ---------- */
  /* 上一次渲染留下的"正在改键"状态要清掉：重绘之后那个键位已经不在了，
     留着它会让下一次按键莫名其妙地改到一个看不见的键位上。 */
  cancelKeyCapture();
  const saved = loadSaved();
  // 首个球种非测试球时，说明是旧结构的存档，直接弃用，避免读到不兼容的数据
  const savedLooksValid = saved && Array.isArray(saved.species)
    && saved.species.some(arr => Array.isArray(arr) && arr.length);
  const state = savedLooksValid ? saved : {
    teamCount: 2,
    teamSizes: [3, 3, 3, 3, 3, 3],
    species: [[], [], [], [], [], []],
    loadouts: [[], [], [], [], [], []],   // 每个小球装配的技能 id（最多 MAX_SKILLS_PER_UNIT 个）
    arenaId: ARENAS[0].id,
    sizeScale: 0.5,          // 默认半场：小球尺寸正常时靠它提高交手频率
    rules: { ...DEFAULT_RULES },
    playerUnit: 0
  };
  // 兼容旧存档：补齐长度与缺省字段
  while (state.teamSizes.length < MAX_TEAMS) state.teamSizes.push(3);
  while (state.species.length < MAX_TEAMS) state.species.push([]);
  // loadouts 是后加的字段：旧存档没有它，下面 ensureSpecies 会补成默认装配
  if (!Array.isArray(state.loadouts)) state.loadouts = [[], [], [], [], [], []];
  while (state.loadouts.length < MAX_TEAMS) state.loadouts.push([]);
  if (typeof state.sizeScale !== 'number' || !isFinite(state.sizeScale)) state.sizeScale = 0.5;

  /* ---------- 一次性迁移：把"被固化的空装配"还原成"跟随默认" ----------
     背景：缇娜刚注册时技能表是空的（为了让球先进场试手感），
     defaultSkillsFor('tina') 当时返回空数组，而 ensureSpecies 会把默认
     **固化**成具体数组写进存档。补上 7 个技能之后，存档里那个空数组依然生效 ——
     表现为"缇娜什么技能都不放"，玩家看到的就是"她的技能全都没有特效"。

     只做一次（记在 state.migrations 里）。为什么必须记：
     迁移完成后用户仍然可以**主动**清空某个球的技能（那是合法选择，存空数组），
     若每次加载都无条件还原，就会把用户的选择反复抹掉。 */
  const LOADOUT_DEFAULTS_MIGRATION = 2;
  if (((state.migrations || {}).loadoutDefaults || 0) < LOADOUT_DEFAULTS_MIGRATION) {
    let touched = 0;
    for (const lo of state.loadouts) {
      if (!Array.isArray(lo)) continue;
      for (let i = 0; i < lo.length; i++) {
        if (Array.isArray(lo[i]) && lo[i].length === 0) { lo[i] = null; touched++; }
      }
    }
    state.migrations = { ...(state.migrations || {}), loadoutDefaults: LOADOUT_DEFAULTS_MIGRATION };
    if (touched) save();
  }

  /* 球种列表与技能装配必须始终一一对应。
     旧存档只有 species、没有 loadouts，所以这里统一在 ensureSpecies 里补齐：
     缺的那一格就按该球种的默认装配填（前 MAX_SKILLS_PER_UNIT 个）。 */
  function ensureSpecies(t, n) {
    const arr = state.species[t];
    const lo = state.loadouts[t];
    /* 先把"球种变了但装配还是旧的"这种不一致修掉：
       装配里出现了当前球种没有的技能，就整格回落到默认装配。
       **必须带上 skillCap()**：不带的话 normalizeSkills 按默认上限 3 截断，
       于是开着无限火力也会被这里悄悄砍回 3 个（这就是"勾了不生效"的根因）。 */
    const cap = skillCap();
    for (let i = 0; i < arr.length; i++) {
      if (!Array.isArray(lo[i])) continue;
      const fixed = normalizeSkills(arr[i], lo[i], cap);
      if (fixed.length !== lo[i].length || fixed.some((v, k) => v !== lo[i][k])) lo[i] = fixed;
    }
    while (arr.length < n) arr.push(DEFAULT_SPECIES_ID);
    arr.length = n;
    while (lo.length < n) lo.push(null);      // null = 用默认装配
    /* **不要把默认固化进存档**（lo[i] 保持 null）。
       踩过：以前这里写的是"缺省就填 defaultSkillsFor(...)"，
       于是"跟随默认"变成了"写死成当前默认"。后果是**改了默认装配对老存档不生效** ——
       缇娜那次正好赶上：注册时默认是空数组，被写死成空数组，
       后来补了 7 个技能，老存档里那格还是空的，玩家看到的就是"技能全都没特效"。
       现在 null 一路保持到读取端，由 equippedOf() 现算。 */
    for (let i = 0; i < n; i++) {
      if (lo[i] !== null && lo[i] !== undefined) lo[i] = normalizeSkills(arr[i], lo[i], cap);
    }
    lo.length = n;
  }

  /* 取某个格子里**实际生效**的装配：
     null / undefined = 跟随该球种当前的默认装配（现算，不读存档里的旧值）。 */
  function equippedOf(t, i) {
    const raw = state.loadouts[t] && state.loadouts[t][i];
    if (raw === null || raw === undefined) return defaultSkillsFor(state.species[t][i]);
    /* 同样必须带 skillCap()：这个函数是**面板勾选框、汇总统计、下一次点击的起点**
       三处的共同数据源。不带上限的话它会返回被截断的 3 个，
       于是"点第 4 个 → 存档进了 4 个 → 面板重绘读回 3 个 → 看起来点不动"，
       而且永远长不到第 5 个（每次都从被截断的 3 个重建）。 */
    return normalizeSkills(state.species[t][i], raw, skillCap());
  }
  for (let t = 0; t < MAX_TEAMS; t++) ensureSpecies(t, state.teamSizes[t]);

  /* ---------- 骨架 ---------- */
  root.innerHTML = `
    <div class="topbar">
      <div class="brand">斗蛐蛐准备<small>开战之后就不再干预，所以配置决定了胜负</small></div>
      <div class="spacer"></div>
      <button class="btn" id="pfBack">返回主菜单</button>
    </div>

    <div class="prep-grid">
      <div>
        <!-- 队伍数量 -->
        <div class="card">
          <h3>队伍数量</h3>
          <p class="hint" style="margin:0 0 9px">
            默认为双方对决，也可以做多方大混战。同队伍的小球之间不会互相造成伤害。
          </p>
          <div class="seg" id="teamCountSeg">
            ${[2, 3, 4, 5, 6].map(n => `<button data-n="${n}">${n} 方</button>`).join('')}
          </div>
        </div>

        <!-- 场地 -->
        <div class="card">
          <h3>场地</h3>
          <p class="hint" style="margin:0 0 10px">只有几何形状的区别：形状决定撞墙角度与可走位空间。</p>
          <div class="arena-grid" id="arenaGrid"></div>

          <div class="field" style="margin-top:14px">
            <label>场地大小：<b id="sizeVal">50%</b>
              <span class="hint" id="sizeHint"></span></label>
            <input type="range" id="sizeScale" min="0.3" max="1.5" step="0.05" value="0.5"
                   style="width:100%">
            <div class="hint">
              按比例缩放整个场地（含区域效果与起始站位）。
              <b>场地越小、交手越频繁</b>——碰撞频率与场地面积成反比。
            </div>
          </div>

          <div id="arenaInfo" style="margin-top:12px"></div>
        </div>

        <!-- 参与小球 -->
        <div class="card">
          <h3>参与小球</h3>
          <p class="hint" style="margin:0 0 10px">
            设置每队参战数量与具体球种。每队 ${MIN_PER_TEAM}–${MAX_PER_TEAM} 个。
          </p>

          <!-- 技能规则：这两条直接决定"技能怎么来"，所以放在选技能的地方 -->
          <div class="skill-rules">
            <label class="chk">
              <input type="checkbox" id="rUnlimited" ${state.rules.unlimitedSkills ? 'checked' : ''}>
              <span><span class="t">无限火力</span>
              <span class="d">不限制技能数量：可以把一个球种的技能<b>全带上</b>，
              也可以一个都不带。（互斥的二选一仍然生效 —— 那是设计，不是数量上限。）</span></span>
            </label>
            <label class="chk">
              <input type="checkbox" id="rRandomSkill" ${state.rules.randomSkills ? 'checked' : ''}>
              <span><span class="t">随机技能</span>
              <span class="d">配置时<b>不能选技能</b>；开战前每颗球用三格老虎机抽出本局的技能
              （只从它自己的技能池里抽），抽完才开打。</span></span>
            </label>
          </div>

          <div id="teamsHost"></div>
          <div class="btnrow" style="margin-top:8px">
            <button class="btn sm" id="mirrorBtn">让所有队伍使用同一套阵容</button>
          </div>
        </div>
      </div>

      <div>
        <!-- 详细设置：特殊规则 + 运动参数 + 开局冲量方向都收在这里 -->
        <div class="card">
          <h3>详细设置</h3>
          <p class="hint" style="margin:0 0 10px">
            特殊规则、运动参数与开局冲量方向都在这里。默认收起 —— 不动它们就是标准玩法。
          </p>
          <button class="btn" id="detailBtn" style="width:100%"></button>
          <div id="detailPanel" style="display:none;margin-top:14px">

            <div class="subhead">开局冲量方向</div>
            <p class="hint" style="margin:6px 0 10px">
              开局时给每个小球一个<b>力道相等、方向不同</b>的初速。之后就靠弹性碰撞自行发展 ——
              没有外力时小球只会做匀速直线运动，撞墙或撞球才改变方向。
            </p>

            <div class="seg" id="spawnModeSeg" style="margin-bottom:10px">
              <button data-mode="random">方向随机</button>
              <button data-mode="custom">我来指定方向</button>
            </div>

            <div id="randomOpts">
              <div class="hint">
                每个小球会得到一个方向随机的初速，方向由本局种子决定 ——
                同一条种子必然得到同一套方向。想改力道或弹性，见下面的「运动参数」。
              </div>
            </div>

            <div id="customOpts" style="display:none">
              <div class="btnrow" style="margin-bottom:8px">
                <span class="hint">批量设置：</span>
                <button class="btn sm" data-preset="inward">朝场地中心</button>
                <button class="btn sm" data-preset="outward">朝外扩散</button>
                <button class="btn sm" data-preset="spread">均匀铺开</button>
                <button class="btn sm" data-preset="random">随机</button>
              </div>
              <div class="hint" style="margin-bottom:8px">
                拖动下面的圆盘即可改变方向（橙色箭头即该球的出发方向）。
              </div>
              <div id="angleGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(74px,1fr));gap:6px"></div>
            </div>

            <div style="border-top:2px solid var(--line);margin:16px 0 12px"></div>
            <div class="subhead">特殊选项</div>
            <div id="rulesHost" style="margin-top:8px"></div>
          </div>
        </div>

        <!-- 开战 -->
        <div class="card" style="margin-top:12px">
          <div id="prepSummary" class="hint" style="margin-bottom:10px"></div>
          <button class="btn primary" id="startBtn" style="width:100%;padding:11px">开始斗蛐蛐</button>
          <div id="prepErr" class="err" style="margin-top:8px"></div>
          <div class="btnrow" style="margin-top:10px">
            <button class="btn sm" id="verifyBtn">确定性自检（同配置跑 3 次比对）</button>
          </div>
          <div id="verifyOut" class="mono hint" style="margin-top:8px;white-space:pre-wrap"></div>
        </div>
      </div>
    </div>
  `;

  const teamsHost = root.querySelector('#teamsHost');
  const arenaGrid = root.querySelector('#arenaGrid');
  const arenaInfo = root.querySelector('#arenaInfo');
  const rulesHost = root.querySelector('#rulesHost');
  const detailPanel = root.querySelector('#detailPanel');
  const detailBtn = root.querySelector('#detailBtn');

  /* ---------- 详细设置：展开 / 收起 ----------
     状态记在 prefs 里（与"技能描述用简要还是详细"同一套机制），
     所以来回切界面、刷新页面都不会把它折回去。 */
  function drawDetailToggle() {
    const open = getDetailOpen();
    detailPanel.style.display = open ? 'block' : 'none';
    detailBtn.textContent = open ? '收起详细设置' : '展开详细设置';
    detailBtn.classList.toggle('on', open);
  }
  detailBtn.onclick = () => { setDetailOpen(!getDetailOpen()); drawDetailToggle(); };

  /* ---------- 技能规则：无限火力 / 随机技能 ----------
     两条都写进 state.rules（跟特殊选项一起存档），
     界面上的即时影响是"技能装配面板还能不能选、能选几个"。 */
  function drawSkillRules() {
    const un = root.querySelector('#rUnlimited');
    const rs = root.querySelector('#rRandomSkill');
    if (!un || !rs) return;
    un.checked = !!state.rules.unlimitedSkills;
    rs.checked = !!state.rules.randomSkills;
    /* 勾选状态以**事件里的 target** 为准，没有事件（直接调 onchange()）才回退读元素。
       浏览器里点复选框会先改 .checked 再触发 change，两种写法都对；
       但无头测试是合成事件，不读 target 就会"点了没反应"（踩过）。 */
    const checkedOf = (el, e) => (e && e.target && 'checked' in e.target ? !!e.target.checked : !!el.checked);
    un.onchange = (e) => {
      state.rules.unlimitedSkills = checkedOf(un, e);
      un.checked = state.rules.unlimitedSkills;
      /* 关掉无限火力时，已经装了超过 3 个的格子要**收回到上限**，
         否则界面上显示 7 个、引擎里只认前 3 个（两边不一致的经典静默故障）。
         收的时候按装配顺序保留前 N 个，并过一遍互斥整理。 */
      if (!state.rules.unlimitedSkills) {
        for (let t = 0; t < state.teamCount; t++) {
          for (let i = 0; i < state.teamSizes[t]; i++) {
            if (state.loadouts[t][i] == null) continue;
            state.loadouts[t][i] = resolveLoadout(state.loadouts[t][i]).slice(0, MAX_SKILLS_PER_UNIT);
          }
        }
      }
      save(); drawSkillRules(); drawTeams(); drawSummary();
    };
    rs.onchange = (e) => {
      state.rules.randomSkills = checkedOf(rs, e);
      rs.checked = state.rules.randomSkills;
      /* 随机技能开着时不再展开装配面板，收起它以免留下一个半开的面板 */
      if (state.rules.randomSkills) openSkillRow = null;
      save(); drawSkillRules(); drawTeams(); drawSummary();
    };
  }

  /* ---------- 场地大小 ----------
     按比例缩放整个场地。碰撞频率与场地面积成反比，
     所以这是控制对局节奏最直接的开关。 */
  function drawSizeControl() {
    const el = root.querySelector('#sizeScale');
    const val = root.querySelector('#sizeVal');
    const hint = root.querySelector('#sizeHint');
    if (!el) return;
    el.value = String(state.sizeScale);
    const paint = () => {
      const pct = Math.round(state.sizeScale * 100);
      val.textContent = pct + '%';
      const a = state.sizeScale * state.sizeScale;
      hint.textContent = Math.abs(a - 1) < 0.05
        ? '（标准大小）'
        : `（面积 ${Math.round(a * 100)}% → 交手频率约 ×${(1 / a).toFixed(1)}）`;
    };
    paint();
    el.oninput = () => {
      state.sizeScale = Number(el.value);
      paint(); save(); drawSummary();
    };
  }

  /* ---------- 队伍数量 ---------- */
  function drawTeamCount() {
    const seg = root.querySelector('#teamCountSeg');
    [...seg.children].forEach(b => {
      b.classList.toggle('on', Number(b.dataset.n) === state.teamCount);
      b.onclick = () => { state.teamCount = Number(b.dataset.n); save(); refreshAll(); };
    });
  }

  /* ---------- 场地 ---------- */
  function drawArenas() {
    arenaGrid.innerHTML = '';
    for (const a of ARENAS) {
      const el = document.createElement('div');
      el.className = 'arena-card' + (a.id === state.arenaId ? ' on' : '');
      el.innerHTML = `<canvas></canvas><div class="nm">${a.name}</div>`;
      el.onclick = () => { state.arenaId = a.id; save(); drawArenas(); drawArenaInfo(); };
      arenaGrid.appendChild(el);
      sketchArena(el.querySelector('canvas'), a);
    }
  }

  function drawArenaInfo() {
    const a = ARENA_BY_ID[state.arenaId];
    const eff = effectLabels(a);
    arenaInfo.innerHTML = `
      <div style="font-weight:700;margin-bottom:4px">${a.name}
        ${a.tags.map(t => `<span class="tag">${t}</span>`).join('')}</div>
      <div class="hint" style="margin-bottom:8px">${a.desc}</div>
      ${a.zones.length ? `
        <div style="font-size:12.5px;margin-bottom:6px"><b>区域效果</b></div>
        ${a.zones.map(z => `<div class="hint">· ${zoneLabel(z)}</div>`).join('')}
      ` : ''}
      ${eff.length ? `
        <div style="font-size:12.5px;margin:8px 0 6px"><b>场地效果</b></div>
        ${eff.map(e => `<div class="hint">· ${e}</div>`).join('')}
      ` : ''}
    `;
  }

  /* ---------- 队伍与小球 ---------- */
  /* ---------- 参与小球 ----------
     每个小球一行：左边选球种，右边的「技能」按钮展开装配面板。
     技能上限 MAX_SKILLS_PER_UNIT —— 魔法少女的技能会很多，
     全带上既难平衡也没有取舍，所以做成"每局挑几个带"。 */
  let openSkillRow = null;          // 记着哪一行展开了装配面板（同时只开一个）

  /** 当前的装配上限：无限火力 = 不限制（用 Infinity 表示），否则 3。
   *  集中成一处，是为了"界面能选几个"和"交给引擎几个"永远同一个数 ——
   *  两处各算一次就会出现"界面显示装了 7 个、引擎只认 3 个"。 */
  function skillCap() {
    return state.rules.unlimitedSkills ? Infinity : MAX_SKILLS_PER_UNIT;
  }

  function skillNamesOf(id) {
    const sk = getSkill(id);
    return sk ? sk.name : id;
  }

  function drawTeams() {
    teamsHost.innerHTML = '';
    for (let t = 0; t < state.teamCount; t++) {
      const tc = teamColor(t);
      const block = document.createElement('div');
      block.className = 'team-block';
      block.style.borderLeftColor = tc.main;
      block.style.borderLeftWidth = '4px';
      block.innerHTML = `
        <div class="team-head">
          <span class="team-dot" style="background:${tc.main}"></span>
          <span class="team-name" style="color:${tc.text}">${tc.name}</span>
          <span class="spacer" style="flex:1"></span>
          <span class="hint">参战数量</span>
          <button class="btn sm" data-act="minus">−</button>
          <b style="min-width:20px;text-align:center">${state.teamSizes[t]}</b>
          <button class="btn sm" data-act="plus">＋</button>
        </div>
        <div data-rows></div>
      `;
      const rows = block.querySelector('[data-rows]');
      for (let i = 0; i < state.teamSizes[t]; i++) {
        rows.appendChild(buildUnitRow(t, i));
      }
      block.querySelector('[data-act=minus]').onclick = () => {
        if (state.teamSizes[t] <= MIN_PER_TEAM) return;
        state.teamSizes[t]--; ensureSpecies(t, state.teamSizes[t]); save(); refreshAll();
      };
      block.querySelector('[data-act=plus]').onclick = () => {
        if (state.teamSizes[t] >= MAX_PER_TEAM) return;
        state.teamSizes[t]++; ensureSpecies(t, state.teamSizes[t]); save(); refreshAll();
      };
      teamsHost.appendChild(block);
    }
  }

  /** 单行：球种下拉 + 技能装配按钮 +（展开时的）技能勾选面板 */
  function buildUnitRow(t, i) {
    const speciesId = state.species[t][i];
    const sp = SPECIES_BY_ID[speciesId];
    const owned = sp.skills || [];
    const equipped = equippedOf(t, i);
    const useDetail = getSkillDetail();   // 简要 / 详细：与图鉴共用一份偏好
    const key = t + ':' + i;

    const wrap = document.createElement('div');
    wrap.className = 'unit-block';

    /* 两条技能规则的即时影响：
       · 随机技能 → 这一格根本不能选，按钮显示"本局随机"并禁用；
       · 无限火力 → 上限抬成"该球种的全部技能"，不再是 3。 */
    const random = !!state.rules.randomSkills;
    const cap = skillCap();

    const row = document.createElement('div');
    row.className = 'unit-row';
    const skillLabel = random
      ? '本局随机'
      : (owned.length === 0
        ? '无技能'
        : `技能 ${equipped.length}/${owned.length}`);
    row.innerHTML = `
      <span class="idx">#${i + 1}</span>
      <select>${PLAYABLE_SPECIES.map(s =>
        `<option value="${s.id}"${s.id === speciesId ? ' selected' : ''}>${s.name}（HP ${s.hp}）</option>`
      ).join('')}</select>
      <button class="btn sm skill-btn${equipped.length && !random ? ' has' : ''}"${owned.length && !random ? '' : ' disabled'}
        title="${random ? '本局为随机技能：开战前用老虎机抽取，配置时不能选'
          : (owned.length ? '选择这个球装配哪些技能' : '这个球种没有技能')}">${skillLabel}</button>
    `;
    row.querySelector('select').onchange = e => {
      state.species[t][i] = e.target.value;
      /* 换球种后，旧装配里可能有新球种没有的技能 —— 整格回落到新球种的默认装配。
         这比"尽量保留"更可预测：玩家换球种时看到的就是一套完整的新配置。 */
      /* 换球种：整格回落到"跟随新球种的默认"，而不是把当前默认写死 */
    state.loadouts[t][i] = null;
      save(); drawTeams(); drawSummary();
    };
    const btn = row.querySelector('.skill-btn');
    if (owned.length && !random) {
      btn.onclick = () => {
        openSkillRow = (openSkillRow === key) ? null : key;
        drawTeams();
      };
    }
    wrap.appendChild(row);

    if (openSkillRow === key && owned.length && !random) {
      const panel = document.createElement('div');
      panel.className = 'unit-skills';
      panel.innerHTML = `
        <div class="unit-skills-head">
          <b>${sp.name}</b>
          <span class="hint">装配 ${equipped.length} / ${Number.isFinite(cap) ? cap : owned.length} 个${
            Number.isFinite(cap) ? '' : '（无限火力）'}</span>
          <span class="spacer" style="flex:1"></span>
          <div class="seg sm" data-act="descmode">
            <button data-detail="0"${useDetail ? '' : ' class="on"'}>简要</button>
            <button data-detail="1"${useDetail ? ' class="on"' : ''}>详细</button>
          </div>
          <button class="btn sm" data-act="all">全部</button>
          <button class="btn sm" data-act="none">清空</button>
          <button class="btn sm" data-act="close">收起</button>
        </div>
        ${owned.map(id => {
          const sk = getSkill(id);
          const on = equipped.includes(id);
          /* 两种置灰的理由不一样，提示也不一样：
             ① 已达装配上限；② 与已选的另一个技能互斥（映霞[荣]/[枯]）。
             把理由写在标题里，否则玩家只看到"点不动"，会以为是 bug。 */
          const conflict = conflictsWithChosen(id, equipped);
          const full = equipped.length >= cap;
          const locked = !on && (full || conflict);
          const why = conflict ? '与已选技能互斥'
            : (locked ? `最多只能装 ${cap} 个` : '');
          return `
            <label class="sk${on ? ' on' : ''}${locked ? ' locked' : ''}"${why ? ` title="${why}"` : ''}>
              <input type="checkbox" data-skill="${id}"${on ? ' checked' : ''}${locked ? ' disabled' : ''}>
              <span>
                <span class="t">${skillNamesOf(id)}${conflict ? ' <span class="mini">· 与已选互斥</span>' : ''}</span>
                <span class="d">${sk ? skillDesc(sk, useDetail) : '（技能表里找不到这个 id）'}</span>
              </span>
            </label>`;
        }).join('')}
        ${owned.length > cap
          ? `<div class="hint" style="margin-top:6px">该球种共 ${owned.length} 个技能，最多只能带 ${cap} 个。
             （想要全带上就打开上面的「无限火力」。）</div>`
          : ''}
      `;
      panel.querySelectorAll('[data-act=descmode] button').forEach(b => {
        b.onclick = () => { setSkillDetail(b.dataset.detail === '1'); };
      });
      panel.querySelectorAll('input[data-skill]').forEach(cb => {
        cb.onchange = () => {
          const id = cb.dataset.skill;
          const cur = equippedOf(t, i);
          if (cb.checked) {
            if (cur.includes(id)) return;
            if (cur.length >= cap) { cb.checked = false; return; }   // 双保险
            if (conflictsWithChosen(id, cur)) { cb.checked = false; return; }       // 互斥双保险
            state.loadouts[t][i] = resolveLoadout([...cur, id]);
          } else {
            state.loadouts[t][i] = cur.filter(x => x !== id);
          }
          save(); drawTeams(); drawSummary();
        };
      });
      panel.querySelector('[data-act=all]').onclick = () => {
        /* "全部"也要过互斥整理：直接 slice 会把互斥的两个都装上 */
        const all = resolveLoadout(owned);
        state.loadouts[t][i] = Number.isFinite(cap) ? all.slice(0, cap) : all;
        save(); drawTeams(); drawSummary();
      };
      panel.querySelector('[data-act=none]').onclick = () => {
        state.loadouts[t][i] = [];
        save(); drawTeams(); drawSummary();
      };
      panel.querySelector('[data-act=close]').onclick = () => {
        openSkillRow = null; drawTeams();
      };
      wrap.appendChild(panel);
    }
    return wrap;
  }

  /* ---------- 特殊选项 ---------- */
  function drawRules() {
    const r = state.rules;
    rulesHost.innerHTML = `
      <label class="chk">
        <input type="checkbox" id="rPlayer" ${r.playerControl ? 'checked' : ''}>
        <span><span class="t">由我操控其中一个小球</span>
        <span class="d"><span class="kbd">W</span><span class="kbd">A</span><span class="kbd">S</span><span class="kbd">D</span>
        八向移动、鼠标瞄准，主动技能改为按键发动（原来的间隔变成技能冷却）；
        被动技能（裁光、见晴的变色…）照旧自动触发。关掉则全部由 AI 自动战斗。</span></span>
      </label>
      <div id="playerPick" style="display:${r.playerControl ? 'block' : 'none'};padding:6px 0 8px 26px">
        <label class="hint" style="display:block;margin-bottom:4px">选择要操控的小球（默认：蓝色方第一个）</label>
        <select id="playerUnitSel" style="width:100%;padding:5px 8px;border:1px solid var(--line);border-radius:7px"></select>
        <div id="playerKeyBox" style="margin-top:10px">
          <label class="hint" style="display:block;margin-bottom:2px">技能按键（按顺序对应这个球的主动技能）</label>
          <div class="keybind-list" id="keybindList"></div>
          <div class="btnrow" style="margin-bottom:6px">
            <button class="btn sm" id="kbAdd" type="button">＋ 添加按键</button>
            <button class="btn sm" id="kbReset" type="button">恢复默认</button>
          </div>
          <div class="hint keybind-map" id="keybindMap"></div>
          <div class="hint" style="margin-top:4px">
            点一个键位再按新键即可改（鼠标左键 / 右键也能绑）。默认：
            <span class="kbd">鼠标左键</span><span class="kbd">鼠标右键</span>
            <span class="kbd">E</span><span class="kbd">1</span><span class="kbd">2</span><span class="kbd">3</span>。
          </div>
        </div>
      </div>

      <label class="chk">
        <input type="checkbox" id="rBoundary" ${r.allowShrink ? 'checked' : ''}>
        <span><span class="t">启用场地自带边界收缩</span>
        <span class="d">仅对设置了收缩的场地生效；勾掉则强制不收缩，适合慢慢观察。</span></span>
      </label>

      <label class="chk">
        <input type="checkbox" id="rRespawn" ${r.respawn ? 'checked' : ''}>
        <span><span class="t">阵亡后复活</span>
        <span class="d">适用于想看长期拉锯的场合；关闭则为标准淘汰赛。</span></span>
      </label>
      <div id="respawnDelayBox" style="display:${r.respawn ? 'block' : 'none'};padding:2px 0 8px 26px">
        <label class="hint" style="display:block;margin-bottom:4px">复活等待（秒）</label>
        <input type="number" id="respawnDelay" min="1" max="30" value="${r.respawnDelay}"
               style="width:100%;padding:5px 8px;border:1px solid var(--line);border-radius:7px">
      </div>

      <label class="chk">
        <input type="checkbox" id="rFriendly" ${r.friendlyFire ? 'checked' : ''}>
        <span><span class="t">同队伍之间也会互相伤害</span>
        <span class="d">默认关闭（同队不互攻）。打开后混战会更混乱。</span></span>
      </label>

      <div class="field" style="margin-top:12px">
        <label>比赛时长上限</label>
        <select id="rTime">
          ${TIME_LIMIT_OPTIONS.map(o =>
            `<option value="${o.value}"${o.value === r.timeLimit ? ' selected' : ''}>${o.label}</option>`
          ).join('')}
        </select>
      </div>

      <label class="chk" style="border-bottom:0">
        <input type="checkbox" id="rDmg" ${r.showDamageNumbers ? 'checked' : ''}>
        <span><span class="t">显示伤害飘字</span>
        <span class="d">关卡复杂时可以关掉，画面更干净。</span></span>
      </label>

      <div style="border-top:2px solid var(--line);margin:12px 0 12px"></div>
      <div style="font-weight:600;font-size:13.5px;margin-bottom:9px">运动参数</div>

      <div class="field">
        <label>初速强度倍率：<b id="speedScaleVal">${Number(r.speedScale ?? 1).toFixed(2)}×</b></label>
        <input type="range" id="speedScale" min="0.3" max="3" step="0.1"
               value="${Number(r.speedScale ?? 1)}" style="width:100%">
        <div class="hint">1× 为标准力道。调大 = 场面更快更乱，调小 = 缓慢游走。</div>
      </div>

      <div class="field">
        <label>弹性系数：<b id="restitutionVal">${Number(r.restitution ?? 1).toFixed(2)}</b></label>
        <input type="range" id="restitution" min="0.3" max="1" step="0.05"
               value="${Number(r.restitution ?? 1)}" style="width:100%">
        <div class="hint">1.00 = 完全弹性（撞击不损失速度）；调小会让撞击越来越"闷"。</div>
      </div>

      <div class="field">
        <label>空气阻力：<b id="dragVal">${Number(r.drag ?? 0).toFixed(2)}</b> /秒</label>
        <input type="range" id="drag" min="0" max="0.5" step="0.01"
               value="${Number(r.drag ?? 0)}" style="width:100%">
        <div class="hint">0 = 永不减速。调大会让小球逐渐停下并互相挤住、谁也追不上谁；
          现在没有僵局兜底机制，调大可能让对局一直拖到时间上限。建议不超过 0.1。</div>
      </div>

      <div class="field">
        <label>撞墙偏转上限：<b id="wallDeflectVal">${Number(r.wallDeflectDeg ?? 10).toFixed(0)}</b> 度</label>
        <input type="range" id="wallDeflect" min="0" max="45" step="1"
               value="${Number(r.wallDeflectDeg ?? 10)}" style="width:100%">
        <div class="hint">小球撞墙反弹后，新方向会朝最近的敌人偏转，最多这么多度。
          设为 0 即变成完全镜面反射。</div>
      </div>

      <div class="field">
        <label>持续微转向：<b id="steerVal">${Number(r.steerDegPerSec ?? 30).toFixed(0)}</b> 度/秒</label>
        <input type="range" id="steer" min="0" max="120" step="5"
               value="${Number(r.steerDegPerSec ?? 30)}" style="width:100%">
        <div class="hint">除了撞墙，每帧还会让航向缓慢朝最近的敌人修正（速度大小不变）。
          调到 0 就变成"只有碰撞才改变方向"的纯粹模型，但 1v1 可能要打很久才碰面。</div>
      </div>
    `;

    const bind = (id, key, after) => {
      const el = rulesHost.querySelector('#' + id);
      el.onchange = () => {
        state.rules[key] = el.type === 'checkbox' ? el.checked : Number(el.value);
        save(); drawRules(); drawSummary();
        if (after) after();
      };
    };
    bind('rPlayer', 'playerControl');
    bind('rBoundary', 'allowShrink');
    bind('rRespawn', 'respawn');
    bind('rFriendly', 'friendlyFire');
    bind('rTime', 'timeLimit');
    bind('rDmg', 'showDamageNumbers');
    const rd = rulesHost.querySelector('#respawnDelay');
    if (rd) rd.onchange = () => { state.rules.respawnDelay = Number(rd.value); save(); };

    /* 运动参数滑块 */
    const bindRange = (id, key, valId, fmt) => {
      const el = rulesHost.querySelector('#' + id);
      if (!el) return;
      el.oninput = () => {
        state.rules[key] = Number(el.value);
        const v = rulesHost.querySelector('#' + valId);
        if (v) v.textContent = fmt(Number(el.value));
        save(); drawSummary();
      };
    };
    bindRange('speedScale', 'speedScale', 'speedScaleVal', v => v.toFixed(2) + '×');
    bindRange('restitution', 'restitution', 'restitutionVal', v => v.toFixed(2));
    bindRange('drag', 'drag', 'dragVal', v => v.toFixed(2));
    bindRange('wallDeflect', 'wallDeflectDeg', 'wallDeflectVal', v => v.toFixed(0));
    bindRange('steer', 'steerDegPerSec', 'steerVal', v => v.toFixed(0));

    // 玩家操控目标下拉
    const sel = rulesHost.querySelector('#playerUnitSel');
    if (sel) {
      const list = buildUnitList();
      sel.innerHTML = list.map(u =>
        `<option value="${u.slot}"${u.slot === state.playerUnit ? ' selected' : ''}>${u.label}</option>`
      ).join('');
      sel.onchange = () => { state.playerUnit = Number(sel.value); save(); drawKeybinds(); };
    }
    drawKeybinds();
  }

  /* ---------- 玩家操控的「自定义按键」 ----------
     键位表存在 prefs.js 里（跨界面共享 + 持久化），下标 = 第几个主动技能。
     "哪些技能要用按键"由 skills.js 的 manualSkillIds 一口定死，
     这里只负责把它翻成界面文字 —— 两边不能各定一套（否则界面写着 3 个键、
     引擎却要 4 个，作者按下去就会觉得"有个技能放不出来"）。 */
  bindKbCapture();
  function currentPlayerUnit() {
    const list = ballList();
    const idx = list.findIndex((_, i) => unitSlotOf(i) === state.playerUnit);
    const at = idx < 0 ? 0 : idx;
    const t = at < 0 ? 0 : teamIndexOf(at);
    const i = indexInTeam(at);
    const speciesId = state.species[t] && state.species[t][i] ? state.species[t][i] : DEFAULT_SPECIES_ID;
    /* ⚠ 参数顺序是 (speciesId, wanted, maxSkills) —— 写反了会"看不出报错但一个技能都没有" */
    const skills = normalizeSkills(
      speciesId, (state.loadouts[t] && state.loadouts[t][i]) || defaultSkillsFor(speciesId));
    return { speciesId, skills };
  }
  /** 全场的第 at 个球属于哪个 slot（与 buildUnitList / makeConfig 同一套编号） */
  function unitSlotOf(at) {
    let base = 0, k = 0;
    for (let t = 0; t < state.teamCount; t++) {
      for (let i = 0; i < state.teamSizes[t]; i++, k++) {
        if (k === at) return base + i;
      }
      base += 100;
    }
    return 0;
  }
  function teamIndexOf(at) {
    let k = 0;
    for (let t = 0; t < state.teamCount; t++) {
      for (let i = 0; i < state.teamSizes[t]; i++, k++) if (k === at) return t;
    }
    return 0;
  }
  function indexInTeam(at) {
    let k = 0;
    for (let t = 0; t < state.teamCount; t++) {
      for (let i = 0; i < state.teamSizes[t]; i++, k++) if (k === at) return i;
    }
    return 0;
  }

  /** 键位面板：内容与交互都在 keybind.js（战斗界面的「按键设置」用的是同一份），
   *  这里只负责"告诉它这个球有哪些主动技能"。 */
  function drawKeybinds() {
    drawKeybindEditor(rulesHost, manualSkillIds(currentPlayerUnit()), null);
  }

  /** 列出所有将参战的小球（用于"选择我操控哪个"） */
  function buildUnitList() {
    const out = [];
    let slotBase = 0;
    for (let t = 0; t < state.teamCount; t++) {
      for (let i = 0; i < state.teamSizes[t]; i++) {
        out.push({
          slot: slotBase + i,
          label: `${teamColor(t).name} #${i + 1} · ${SPECIES_BY_ID[state.species[t][i]].name}`
        });
      }
      slotBase += 100;   // 与 makeConfig 的编号规则保持一致
    }
    return out;
  }

  /* ---------- 开局冲量方向 ---------- */
  function ballList() {
    // 与 makeConfig 生成战斗时的顺序完全一致：逐队、逐位
    const out = [];
    for (let t = 0; t < state.teamCount; t++) {
      for (let i = 0; i < state.teamSizes[t]; i++) {
        out.push({ team: t, index: i, speciesId: state.species[t][i] });
      }
    }
    return out;
  }

  function ensureAngles() {
    const list = ballList();
    if (!Array.isArray(state.rules.customAngles)) state.rules.customAngles = [];
    // 长度不足时，用"朝场地中心"的合理默认值补齐，避免出现 undefined
    const cx = 360, cy = 220;
    const shape = ARENA_BY_ID[state.arenaId].shape;
    // 用与战斗核心相同的方式估算每个球的出生位置
    const b = shape.type === 'circle'
      ? { minX: shape.cx - shape.r, maxX: shape.cx + shape.r, minY: shape.cy - shape.r, maxY: shape.cy + shape.r }
      : (() => {
          const xs = shape.points.map(p => p[0]), ys = shape.points.map(p => p[1]);
          return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
        })();
    const ccx = (b.minX + b.maxX) / 2, ccy = (b.minY + b.maxY) / 2;
    const nTeams = state.teamCount;

    list.forEach((item, idx) => {
      if (typeof state.rules.customAngles[idx] === 'number' && isFinite(state.rules.customAngles[idx])) return;
      // 估算出生方位（与 core.js 的 buildUnits 同构，够用即可）
      let baseAngle = nTeams === 2
        ? (item.team === 0 ? Math.PI : 0)
        : (item.team / nTeams) * Math.PI * 2 - Math.PI / 2;
      const count = state.teamSizes[item.team];
      const off = count > 1 ? (item.index / (count - 1) - 0.5) * 2 : 0;
      const ang = baseAngle + off * (nTeams === 2 ? 0.30 : 0.45);
      const rx = (b.maxX - b.minX) / 2 * 0.74, ry = (b.maxY - b.minY) / 2 * 0.74;
      const px = ccx + Math.cos(ang) * rx, py = ccy + Math.sin(ang) * ry;
      const toCenter = Math.atan2(ccy - py, ccx - px);
      state.rules.customAngles[idx] = Math.round(((toCenter * 180) / Math.PI + 360) % 360);
    });
    state.rules.customAngles.length = list.length;
  }

  function drawSpawnOpts() {
    const mode = state.rules.spawnMode || 'random';
    [...root.querySelectorAll('#spawnModeSeg button')].forEach(b => {
      b.classList.toggle('on', b.dataset.mode === mode);
      b.onclick = () => { state.rules.spawnMode = b.dataset.mode; save(); drawSpawnOpts(); drawSummary(); };
    });

    root.querySelector('#randomOpts').style.display = mode === 'custom' ? 'none' : 'block';
    root.querySelector('#customOpts').style.display = mode === 'custom' ? 'block' : 'none';

    const ss = root.querySelector('#speedScale');
    if (ss) {
      ss.value = String(state.rules.speedScale ?? 1);
      root.querySelector('#speedScaleVal').textContent = Number(ss.value).toFixed(2) + '×';
      ss.oninput = () => {
        state.rules.speedScale = Number(ss.value);
        root.querySelector('#speedScaleVal').textContent = Number(ss.value).toFixed(2) + '×';
        save(); drawSummary();
      };
    }

    if (mode !== 'custom') return;

    ensureAngles();
    const grid = root.querySelector('#angleGrid');
    grid.innerHTML = '';
    const list = ballList();

    list.forEach((item, idx) => {
      const tc = teamColor(item.team);
      const cell = document.createElement('div');
      cell.style.cssText = 'text-align:center';
      cell.innerHTML = `
        <canvas width="70" height="70" style="width:70px;height:70px;cursor:grab;touch-action:none"></canvas>
        <div style="font-size:11px;color:${tc.text};font-weight:600">${tc.name} #${item.index + 1}</div>
        <div class="hint angleVal" style="font-size:11px">${Math.round(state.rules.customAngles[idx])}°</div>
      `;
      grid.appendChild(cell);

      const cv = cell.querySelector('canvas');
      const valEl = cell.querySelector('.angleVal');
      const ctx = cv.getContext('2d');
      let dragging = false;

      const drawDial = () => {
        const w = 70, h = 70, cx = w / 2, cy = h / 2, r = 24;
        const a = (state.rules.customAngles[idx] * Math.PI) / 180;
        ctx.clearRect(0, 0, w, h);
        // 圆盘
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = '#f5f2e8'; ctx.fill();
        ctx.strokeStyle = '#ddd7c8'; ctx.lineWidth = 1.5; ctx.stroke();
        // 十字刻度
        ctx.strokeStyle = '#e9e4d6'; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
        ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
        ctx.stroke();
        // 方向箭头
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * r * 0.92, cy + Math.sin(a) * r * 0.92);
        ctx.strokeStyle = tc.main; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * r * 0.92, cy + Math.sin(a) * r * 0.92, 3.6, 0, Math.PI * 2);
        ctx.fillStyle = tc.main; ctx.fill();
        // 中心点
        ctx.beginPath(); ctx.arc(cx, cy, 2.6, 0, Math.PI * 2);
        ctx.fillStyle = '#3a352a'; ctx.fill();
      };

      const setFromEvent = ev => {
        const rect = cv.getBoundingClientRect();
        const pt = ev.touches ? ev.touches[0] : ev;
        const x = pt.clientX - rect.left - 35;
        const y = pt.clientY - rect.top - 35;
        if (Math.abs(x) < 2 && Math.abs(y) < 2) return;
        const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
        state.rules.customAngles[idx] = Math.round(deg);
        valEl.textContent = Math.round(deg) + '°';
        drawDial();
      };

      cv.addEventListener('mousedown', e => { dragging = true; setFromEvent(e); e.preventDefault(); });
      cv.addEventListener('mousemove', e => { if (dragging) { setFromEvent(e); e.preventDefault(); } });
      window.addEventListener('mouseup', () => { if (dragging) { dragging = false; save(); } });
      cv.addEventListener('touchstart', e => { dragging = true; setFromEvent(e); e.preventDefault(); }, { passive: false });
      cv.addEventListener('touchmove', e => { if (dragging) { setFromEvent(e); e.preventDefault(); } }, { passive: false });
      cv.addEventListener('touchend', () => { if (dragging) { dragging = false; save(); } });

      drawDial();
    });

    // 批量预设
    root.querySelectorAll('[data-preset]').forEach(btn => {
      btn.onclick = () => {
        const preset = btn.dataset.preset;
        const shape = ARENA_BY_ID[state.arenaId].shape;
        const b = shape.type === 'circle'
          ? { minX: shape.cx - shape.r, maxX: shape.cx + shape.r, minY: shape.cy - shape.r, maxY: shape.cy + shape.r }
          : (() => {
              const xs = shape.points.map(p => p[0]), ys = shape.points.map(p => p[1]);
              return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
            })();
        const ccx = (b.minX + b.maxX) / 2, ccy = (b.minY + b.maxY) / 2;
        const n = list.length;

        if (preset === 'spread') {
          // 均匀铺满 360°
          list.forEach((_, i) => { state.rules.customAngles[i] = Math.round((i / n) * 360); });
        } else if (preset === 'random') {
          // 用 Math.random 只是为了生成一组可编辑的初值，战斗本身仍由种子决定
          list.forEach((_, i) => { state.rules.customAngles[i] = Math.round(Math.random() * 360); });
        } else {
          // inward / outward：需要知道每个球的出生方位，这里按队伍方位近似
          list.forEach((item, i) => {
            const nTeams = state.teamCount;
            const baseAngle = nTeams === 2
              ? (item.team === 0 ? Math.PI : 0)
              : (item.team / nTeams) * Math.PI * 2 - Math.PI / 2;
            const count = state.teamSizes[item.team];
            const off = count > 1 ? (item.index / (count - 1) - 0.5) * 2 : 0;
            const ang = baseAngle + off * (nTeams === 2 ? 0.30 : 0.45);
            const rx = (b.maxX - b.minX) / 2 * 0.74, ry = (b.maxY - b.minY) / 2 * 0.74;
            const px = ccx + Math.cos(ang) * rx, py = ccy + Math.sin(ang) * ry;
            const toCenter = Math.atan2(ccy - py, ccx - px);
            const deg = preset === 'inward'
              ? (toCenter * 180) / Math.PI
              : (toCenter * 180) / Math.PI + 180;
            state.rules.customAngles[i] = Math.round((deg + 360) % 360);
          });
        }
        save(); drawSpawnOpts();
      };
    });
  }

  /* ---------- 汇总 ---------- */
  function drawSummary() {
    const a = ARENA_BY_ID[state.arenaId];
    const total = state.teamSizes.slice(0, state.teamCount).reduce((s, n) => s + n, 0);
    const mode = state.rules.spawnMode === 'custom' ? '我来指定' : '方向随机';
    /* 统计本局一共装配了多少个技能 —— 技能是本作主要的平衡杠杆，
       开战前让玩家一眼看到"我给这套阵容装了几个技能"很有用。 */
    let skillCount = 0, unitWithSkills = 0;
    for (let t = 0; t < state.teamCount; t++) {
      for (let i = 0; i < state.teamSizes[t]; i++) {
        const n = equippedOf(t, i).length;
        skillCount += n;
        if (n) unitWithSkills++;
      }
    }
    const random = !!state.rules.randomSkills;
    const un = !!state.rules.unlimitedSkills;
    /* 随机技能时上面的统计没有意义（开战前才知道抽到什么），
       所以那一行改说规则本身，避免显示一个"看起来是配置结果"的假数字。 */
    const skillLine = random
      ? `<div>技能：<b>随机抽取</b>（开战前老虎机决定，抽完才开打）</div>`
      : `<div>技能：<b>${skillCount}</b> 个装配在 <b>${unitWithSkills}</b> 个小球上
        （每个最多 ${un ? '不限（无限火力）' : MAX_SKILLS_PER_UNIT} 个）</div>`;
    root.querySelector('#prepSummary').innerHTML = `
      <div>对阵：<b>${state.teamCount} 方</b> · 共 <b>${total}</b> 个小球</div>
      <div>场地：<b>${a.name}</b> · 大小 <b>${Math.round(state.sizeScale * 100)}%</b>
        （面积 ${Math.round(state.sizeScale * state.sizeScale * 100)}%）</div>
      <div>开局：<b>${mode}</b> · 力道 <b>${Number(state.rules.speedScale ?? 1).toFixed(2)}×</b></div>
      <div>操控：<b>${state.rules.playerControl ? '玩家操控 1 个' : '全自动'}</b>
        · 复活：<b>${state.rules.respawn ? '开' : '关'}</b>
        · 时限：<b>${state.rules.timeLimit ? state.rules.timeLimit + ' 秒' : '不限'}</b></div>
      ${skillLine}
    `;
  }

  /* ---------- 生成战斗配置 ---------- */
  function makeConfig() {
    const teams = [];
    let slotBase = 0;
    for (let t = 0; t < state.teamCount; t++) {
      const units = [];
      for (let i = 0; i < state.teamSizes[t]; i++) {
        units.push({
          slot: slotBase + i,
          /* 直接把 raw 值传下去：null 会被 makeUnitStats → normalizeSkills 解析成默认装配。
         不要在这里传 equippedOf(t,i) —— 那会把默认又固化进战斗配置。
         maxSkills 用同一个 skillCap()：界面能选几个，这里就必须能收几个。 */
      stats: makeUnitStats(state.species[t][i], state.loadouts[t][i], { maxSkills: skillCap() })
        });
      }
      teams.push({ units });
      slotBase += 100;
    }
    // 自定义方向时，确保角度数组与球序一一对应
    const rules = { ...state.rules };
    if (rules.spawnMode === 'custom') {
      ensureAngles();
      rules.customAngles = [...state.rules.customAngles];
    }
    return {
      teams,
      arena: ARENA_BY_ID[state.arenaId],
      sizeScale: state.sizeScale,
      rules,
      playerSlot: state.rules.playerControl ? state.playerUnit : null
    };
  }

  /* ---------- 刷新 ---------- */
  function refreshAll() {
    drawDetailToggle();
    drawSkillRules();
    drawTeamCount();
    drawArenas();
    drawSizeControl();
    drawArenaInfo();
    drawTeams();
    drawRules();
    drawSpawnOpts();
    drawSummary();
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* 忽略隐私模式失败 */ }
  }
  function loadSaved() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  /* ---------- 事件 ---------- */
  root.querySelector('#pfBack').onclick = () => { location.hash = ''; };

  /* 别的界面（图鉴）改了"简要/详细"，这里也要跟着重画技能面板 */
  onPrefsChange(() => drawTeams());

  root.querySelector('#mirrorBtn').onclick = () => {
    // 让 2..N 队全部复制第 1 队的阵容（做公平对局时最常用）
    // 技能装配也要一起复制，否则"同一套阵容"其实并不相同
    for (let t = 1; t < state.teamCount; t++) {
      state.teamSizes[t] = state.teamSizes[0];
      state.species[t] = [...state.species[0]];
      state.loadouts[t] = state.loadouts[0].map(a => (Array.isArray(a) ? [...a] : a));
    }
    save(); refreshAll();
  };

  root.querySelector('#startBtn').onclick = () => {
    const err = root.querySelector('#prepErr');
    err.textContent = '';
    const cfg = makeConfig();
    const total = cfg.teams.reduce((s, t) => s + t.units.length, 0);
    if (total < 2) { err.textContent = '至少需要 2 个小球才能开战。'; return; }
    onStart(cfg);
  };

  /* ---------- 确定性自检 ---------- */
  root.querySelector('#verifyBtn').onclick = () => {
    const out = root.querySelector('#verifyOut');
    out.textContent = '正在模拟…';
    // 延后一帧，让界面先刷出提示
    setTimeout(async () => {
      const { Battle } = await import('./core.js');
      const cfg = makeConfig();
      const lines = [];
      const seeds = [12345, 12345, 12345];
      const fps = [];
      for (const sd of seeds) {
        const b = new Battle({ ...cfg, seed: sd });
        b.runToEnd();
        fps.push({ seed: sd, f: b.frame, w: b.winner, fp: b.fingerprint() });
      }
      lines.push(`配置：${cfg.teams.length} 方 / ${cfg.teams.reduce((s, t) => s + t.units.length, 0)} 球 / 场地「${cfg.arena.name}」`);
      fps.forEach((r, i) => lines.push(`  第 ${i + 1} 次  种子 ${r.seed}  结束帧 ${r.f}  胜方 ${r.w < 0 ? '待定' : r.w + 1}队  指纹 ${r.fp}`));
      const same = fps.every(r => r.fp === fps[0].fp);
      lines.push(same ? '✅ PASS：三次结果完全一致，同一配置必然得到同一场战斗。' : '❌ FAIL：出现漂移。');
      out.textContent = lines.join('\n');
    }, 30);
  };

  refreshAll();
}

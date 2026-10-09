/* ============================================================
   ui-battle.js — 战斗界面：观战、操控、回放
   ------------------------------------------------------------
   播放模型：
     整局战斗在开始时被一次性算完并录成快照序列，
     界面只负责推动"播放头"。因此倍速、暂停、单步、回放
     全部是免费获得的，且任何倍速下结果都完全一致。
   ============================================================ */

import { Battle, SNAP_STRIDE } from './core.js';
import { Renderer, preloadProjSprites, preloadStickers } from './render.js';
import { audio } from './audio.js';
import { getSoundEnabled, setSoundEnabled, getSoundVolume, setSoundVolume, getShakeEnabled, setShakeEnabled, getPlayerKeys, keyLabel } from './prefs.js';
import { DT, SCALE, teamColor, SPECIES_BY_ID } from './balls.js';
import { getSkill, manualSkillIds } from './skills.js';
import { ARENA_BY_ID, zoneLabel } from './arenas.js';
import { nextSeed } from './main.js';

export function renderBattle(root, cfg, onExit) {
  /* ---------- 1) 建局 ---------- */
  const seed = nextSeed();
  const battle = new Battle({ ...cfg, seed });

  /* 玩家操控 = **实时推进**（作者 2026-10 的玩家操控功能）。
     为什么不沿用"开局一次性算完整局"：那一套要求提前知道玩家的每一次操作，
     而操纵只能边打边给。所以这个模式下按真实时间逐帧 step，
     但**照样逐帧录快照** —— 打完之后倍速/暂停/拖动进度条回看全都照旧可用。 */
  const live = !!cfg.rules.playerControl;

  /* 提前加载本局用到的角色贴图：否则第一帧会是纯色兜底圆，随后才"变脸"。
     开华形态的贴图与手持物件（弓）也要带上 —— 之前这里只传了 sticker，
     于是晕彩开华那一瞬间会闪一下纯色圆，现在一并修掉。 */
  preloadStickers(battle.units.map(u => ({
    sticker: u.sticker, stickerBloom: u.stickerBloom, bow: u.bow, domain: u.domain
  })));

  /* ---------- 2) 模拟 ----------
     全自动：一次性算完（播放头只是在读快照，任何倍速结果都一样）。
     玩家操控：实时推进（见 loop），这里只把输入状态准备好。 */
  let totalFrames = 0;
  if (!live) {
    battle.runToEnd();
    totalFrames = battle.frame;
  }

  /* 弹道贴图（箭矢 / 蝙蝠 / 能量弹）在这时候才预热得上：
     它们是**技能放出来的**，配置写在 skills.js 的技能参数里，
     球种配置里没有；而且 projSpritePalette 要等整局算完才有内容。
     漏了这一步的话，某种弹道第一次出现的那一两帧什么都不画
     （渲染层对没加载好的贴图是"宁可不画"），看着像"第一发没特效"。

     ⚠ 实时模式（玩家操控）在这里调等于白调 —— 那一刻**还没有任何弹道**，
     调色板是空的。所以下面还有一个 `warmSprites()` 每帧补一次。 */
  preloadProjSprites(battle);

  /** 实时模式的补预热：调色板/单位一变就再预热一次。
   *  · `projSpritePalette` 每多一种弹道贴图 → 立刻开始加载它（不是等第一次绘制）；
   *  · `units` 每多一个单位（析光的分身）→ 把它的球贴图/开华贴图/弓也预热。
   *  少了它，"手操时放出来的技能"会有一两帧只画程序化光点，看着像特效没了。 */
  let warmedUnits = battle.units.length, warmedSprites = (battle.projSpritePalette || []).length;
  function warmSprites(force = false) {
    const nUnits = battle.units.length;
    const nSpr = (battle.projSpritePalette || []).length;
    if (!force && nUnits === warmedUnits && nSpr === warmedSprites) return;
    warmedUnits = nUnits;
    warmedSprites = nSpr;
    if (nSpr) preloadProjSprites(battle);
    if (nUnits > 0) {
      preloadStickers(battle.units.map(u => ({
        sticker: u.sticker, stickerBloom: u.stickerBloom, bow: u.bow, domain: u.domain,
      })));
    }
  }

  /* ---------- 3) 界面骨架 ---------- */
  const arena = ARENA_BY_ID[cfg.arena.id] || cfg.arena;

  root.innerHTML = `
    <div class="topbar">
      <div class="brand">斗蛐蛐<small>${cfg.teams.length} 方 · ${battle.units.length} 球 · ${arena.name}${
        (battle.sizeScale ?? 1) !== 1 ? `（场地 ${Math.round(battle.sizeScale * 100)}%）` : ''
      }</small></div>
      <div class="spacer"></div>
      <button class="btn" id="btBack">重新准备</button>
      <button class="btn" id="btAgain">换种子重开</button>
    </div>

    <div class="battle-wrap">
      <div>
        <div class="stage">
          <canvas id="battleCanvas"></canvas>
          <div id="startLayer" class="start-layer">
            <div class="start-box">
              <div class="start-title">斗蛐蛐</div>
              <div class="hint" id="startHint"></div>
              <button class="btn" id="btStart">斗蛐蛐开始</button>
            </div>
          </div>
          <div id="lotteryLayer" class="lottery-layer" hidden></div>
        </div>

        <div id="ctrlHud" class="ctrl-hud" hidden></div>

        <div class="playbar">
          <button class="btn" id="btPlay" style="min-width:74px">⏸ 暂停</button>
          <button class="btn sm" id="btStepBack">◀|</button>
          <button class="btn sm" id="btStep">|▶</button>
          <span class="seg" id="speedSeg">
            <button data-s="0.5">0.5×</button>
            <button data-s="1" class="on">1×</button>
            <button data-s="2">2×</button>
            <button data-s="4">4×</button>
            <button data-s="8">8×</button>
          </span>
          <div class="timeline">
            <input type="range" id="btSeek" min="0" max="${totalFrames}" value="0" step="1">
          </div>
          <span class="mono hint" id="btTime">0.0s</span>
          <button class="btn sm" id="btSkip">跳到结果</button>
        </div>

        <div class="card" style="margin-top:12px">
          <div class="btnrow" style="margin-bottom:8px">
            <label class="hint" style="display:flex;gap:6px;align-items:center">
              <input type="checkbox" id="cbHud" checked> 显示血条与资源条
            </label>
            <label class="hint" style="display:flex;gap:6px;align-items:center">
              <input type="checkbox" id="cbDmg" ${cfg.rules.showDamageNumbers ? 'checked' : ''}> 伤害飘字
            </label>
            <label class="hint" style="display:flex;gap:6px;align-items:center">
              <input type="checkbox" id="cbShake" ${getShakeEnabled() ? 'checked' : ''}> 屏幕抖动
            </label>
            <label class="hint" style="display:flex;gap:6px;align-items:center">
              <input type="checkbox" id="cbSound"> 音效
            </label>
            <input type="range" id="volSound" min="0" max="1" step="0.05" value="0.6"
                   title="音量" style="width:74px">
            <label class="hint" style="display:flex;gap:6px;align-items:center">
              <input type="checkbox" id="cbDebug"> 显示尺寸信息
            </label>
            <span class="spacer" style="flex:1"></span>
            <span class="mono hint" id="btFp"></span>
          </div>
          <div id="dbgBox" class="mono hint" style="display:none;white-space:pre-wrap;line-height:1.5"></div>
          ${cfg.rules.playerControl ? `
            <div class="hint" id="ctrlHint">
              你操控的球体带黑色光环 · <span class="kbd">W</span><span class="kbd">A</span><span class="kbd">S</span><span class="kbd">D</span>
              （或方向键）八向移动 · 鼠标位置决定弹道方向 · 主动技能按下方技能栏的按键发动，
              被动技能（裁光 / 见晴的变色…）自动触发。按键可以在准备界面的「详细设置 → 自定义按键」里改。
            </div>
          ` : `
            <div class="hint">全自动模式：所有小球由 AI 自行战斗。</div>
          `}
        </div>
        <div class="hint guard-hint" id="guardHint" hidden></div>
      </div>

      <div>
        <div class="card">
          <h3>战场态势</h3>
          <div class="hp-strip" id="hpStrip"></div>
        </div>

        <div class="card" style="margin-top:12px" id="resultCard" hidden></div>

        <div class="card" style="margin-top:12px">
          <h3>战报</h3>
          <div class="log" id="btLog"></div>
        </div>

        <div class="card" style="margin-top:12px">
          <h3>场地</h3>
          <div class="hint" style="margin-bottom:6px">${arena.desc}</div>
          ${(arena.zones || []).map(z => `<div class="hint">· ${zoneLabel(z)}</div>`).join('')}
        </div>
      </div>
    </div>
  `;

  /* ---------- 4) 渲染器与状态 ---------- */
  const canvas = root.querySelector('#battleCanvas');
  /* 把引擎对象挂在画布上：诊断脚本（tests/diag/player.mjs、dom.mjs）要读它，
     排查"操作到底有没有喂进去"时也直接可用。界面本身不用它。 */
  canvas.__battle = battle;
  const renderer = new Renderer(canvas);
  /* 画布裁到场地包围盒上：小场地不再在四周留一大圈空白
     （否则看着就像"战斗画面没显示全"）。 */
  renderer.setArena(battle.arena, battle.sizeScale ?? 1);
  renderer.showDamage = cfg.rules.showDamageNumbers;
  renderer.screenShake = getShakeEnabled();

  const ui = {
    frame: 0,
    playing: true,
    /* 进战斗界面**不立刻开打**：先把战场画出来、等玩家点「斗蛐蛐开始」
       （作者 2026-10 的要求）。这两种模式都适用。 */
    started: false,
    /* 点开始那一帧要把计时基准重置，否则"等待的这段时间"会被当成
       已经过去了（dtms 一夹到 120ms 就是开局白跑 7 帧）。 */
    resetClock: false,
    speed: 1,
    acc: 0,
    last: performance.now(),
    finished: false
  };

  const speedSeg = root.querySelector('#speedSeg');
  const seek = root.querySelector('#btSeek');
  const playBtn = root.querySelector('#btPlay');
  const timeLabel = root.querySelector('#btTime');
  const fpLabel = root.querySelector('#btFp');
  const hpStrip = root.querySelector('#hpStrip');
  const logHost = root.querySelector('#btLog');
  const resultCard = root.querySelector('#resultCard');
  const hudBox = root.querySelector('#ctrlHud');
  const stepBackBtn = root.querySelector('#btStepBack');
  const stepBtn = root.querySelector('#btStep');
  const skipBtn = root.querySelector('#btSkip');
  const startLayer = root.querySelector('#startLayer');
  const startHint = root.querySelector('#startHint');

  /* 开始遮罩上的说明：把"这一局你能做什么"写在按下去之前 */
  if (startHint) {
    startHint.textContent = live
      ? 'WASD 八向移动 · 鼠标决定弹道方向 · 主动技能按下方技能栏的按键发动（被动技能自动触发）'
      : `全自动对局：${cfg.teams.length} 方 AI 自行战斗，点开始后按正常速度播放。`;
  }

  /* ---------- 4.5) 玩家操控：输入状态 ----------
     记的都是**物理键位**（KeyboardEvent.code / Mouse0|1|2）：
     用 e.key 的话，输入法、大小写、Shift 都会让它变，
     "按 E 却放出别的技能"这种问题最难查。 */
  const playerUnit = live ? battle.units[battle.playerIdx] : null;
  const manualIds = playerUnit ? manualSkillIds(playerUnit) : [];
  /* keysDown = 当前按住；keysEdge = "自上次喂给引擎以来按下过"。
     为什么要两个：**一次很快的点按可能夹在两帧之间**（按下和松开都在同一帧
     的间隙里），只看"按住"的话那一发就永远放不出来 —— 表现就是
     "有时候点了没反应 / 特效不见了"。所以按下的动作要**锁存**到被消费为止。 */
  const keysDown = new Set();
  const keysEdge = new Set();
  let aimWorld = null;                 // 鼠标在世界坐标里的位置（null = 还没动过鼠标）
  window.__battleKeyState = keysDown;  // 兼容旧诊断脚本的观察口

  const MOVE_CODES = ['KeyW', 'KeyA', 'KeyS', 'KeyD',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

  /** 组装这一帧要喂给引擎的操控意图（见 core.js 的 step 注释）
   *  ⚠ 技能键用 `按住 ∪ 这一帧按下过`：点一下和按住都算，
   *  而且快速点按不会因为"按下与松开都在同一帧间隙里"而丢失。 */
  function readPlayerInput() {
    let dx = 0, dy = 0;
    if (keysDown.has('KeyA') || keysDown.has('ArrowLeft')) dx -= 1;
    if (keysDown.has('KeyD') || keysDown.has('ArrowRight')) dx += 1;
    if (keysDown.has('KeyW') || keysDown.has('ArrowUp')) dy -= 1;
    if (keysDown.has('KeyS') || keysDown.has('ArrowDown')) dy += 1;
    const bindings = getPlayerKeys();
    const fire = [];
    for (let i = 0; i < manualIds.length; i++) {
      const code = bindings[i];
      if (code && (keysDown.has(code) || keysEdge.has(code))) fire.push(manualIds[i]);
    }
    keysEdge.clear();      // 消费掉：一次"按下"至少喂给一帧
    const inp = { dx, dy, fire };
    if (aimWorld) { inp.aimX = aimWorld.x; inp.aimY = aimWorld.y; }
    return inp;
  }

  /* 键鼠监听：只在本界面存在期间生效，返回时统一摘掉 */
  const boundCodes = () => {
    const set = new Set(MOVE_CODES);
    for (const c of getPlayerKeys()) if (c) set.add(c);
    set.add('Escape');
    return set;
  };
  const onKeyDown = e => {
    if (!live) return;
    if (e.repeat) return;
    if (!boundCodes().has(e.code)) return;
    /* 方向键 / 空格之类会滚动页面，绑定的技能键也一律吞掉默认行为 */
    e.preventDefault();
    keysDown.add(e.code);
    keysEdge.add(e.code);
  };
  const onKeyUp = e => { if (live) keysDown.delete(e.code); };
  const onBlurWin = () => keysDown.clear();       // 切走窗口时别把键"卡住"
  const onMouseMove = e => {
    if (!live) return;
    aimWorld = renderer.screenToWorld(e.clientX, e.clientY);
  };
  const onCanvasDown = e => {
    if (!live) return;
    aimWorld = renderer.screenToWorld(e.clientX, e.clientY);
    const code = 'Mouse' + e.button;
    if (boundCodes().has(code)) { keysDown.add(code); keysEdge.add(code); e.preventDefault(); }
  };
  const onCanvasUp = e => { if (live) keysDown.delete('Mouse' + e.button); };
  const onCtxMenu = e => { if (live) e.preventDefault(); };   // 右键是技能键，别弹菜单
  if (live) {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlurWin);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onCanvasUp);
    canvas.addEventListener('mousedown', onCanvasDown);
    canvas.addEventListener('contextmenu', onCtxMenu);
  }

  /* ---------- 5) 战报预编译 ----------
     全自动：开局一次性把事件流翻成文本行并记录帧号，之后二分查表。
     玩家操控：事件是边打边产生的，所以走 appendLogLines() 增量追加
     （每帧只看新来的那几条，不会把上万个事件重扫一遍）。 */
  const logLines = buildLogLines(battle);
  let logCursor = 0;
  let logScan = live ? battle.events.length : 0;

  /** 把一条事件翻成战报文本（不需要记的行返回 null） */
  function logLineFor(b, e) {
    const nameOf = i => (b.units[i] ? b.units[i].name : '?');
    const teamOf = i => (b.units[i] ? teamColor(b.units[i].team).name : '?');
    const t = (e.f * DT).toFixed(1);
    if (e.type === 'hit') {
      return `${t}s  ${teamOf(e.a)}${nameOf(e.a)} → ${teamOf(e.b)}${nameOf(e.b)}  −${Math.round(e.value)}`;
    } else if (e.type === 'death') {
      return `${t}s  ✖ ${teamOf(e.b)}${nameOf(e.b)} 阵亡${e.a >= 0 ? `（被 ${nameOf(e.a)} 击破）` : ''}`;
    } else if (e.type === 'respawn') {
      return `${t}s  ↻ ${teamOf(e.a)}${nameOf(e.a)} 复活`;
    } else if (e.type === 'skillDraw') {
      /* 随机技能：把抽签结果写进战报 —— 抽签动画放完就收起来了，
         之后想回看"这颗球这局带了什么"只有这里找得到。 */
      return `${t}s  🎲 ${teamOf(e.a)}${nameOf(e.a)} 抽到：${(e.skills || []).join('、') || '（空）'}`;
    } else if (e.type === 'end') {
      return `${t}s  【结束】${e.value < 0 ? '平局' : teamColor(e.value).name + '获胜'} — ${e.reason || ''}`;
    }
    return null;
  }

  function buildLogLines(b) {
    const out = [];
    for (const e of b.events) {
      const text = logLineFor(b, e);
      if (text) out.push({ f: e.f, text });
    }
    return out;
  }

  /** 实时模式：把新产生的事件追加进战报（帧号天然递增，二分查表照旧成立） */
  function appendLogLines() {
    if (!live) return;
    for (; logScan < battle.events.length; logScan++) {
      const e = battle.events[logScan];
      const text = logLineFor(battle, e);
      if (text) logLines.push({ f: e.f, text });
    }
  }

  /* ---------- 6) 态势条 ---------- */
  function teamTotals(snapIdx) {
    const d = battle.snapshots[Math.min(snapIdx, battle.snapshots.length - 1)].data;
    const teams = new Map();
    battle.units.forEach((u, i) => {
      const o = i * SNAP_STRIDE;
      /* 析光的分身是战斗中才出现的，它出现之前的快照里没有这一格。
         没有数据就当作"还没上场"，不能当成 0 血（那会让态势条一开始就少一队血）。 */
      const has = d.length >= o + SNAP_STRIDE;
      const hp = has ? d[o + 2] : u.maxHp;
      const alive = has ? d[o + 3] > 0.5 : false;
      const t = teams.get(u.team) || { hp: 0, max: 0, alive: 0, total: 0 };
      t.hp += Math.max(0, hp);
      t.max += u.maxHp;
      t.total++;
      if (alive) t.alive++;
      teams.set(u.team, t);
    });
    return teams;
  }

  function drawStrip(snapIdx) {
    const teams = teamTotals(snapIdx);
    // 只在队伍数量变化时重建 DOM，其余帧仅改数值与宽度，避免每帧重排
    if (hpStrip.childElementCount !== teams.size) {
      hpStrip.innerHTML = '';
      for (const t of [...teams.keys()].sort((a, b) => a - b)) {
        const tc = teamColor(t);
        const row = document.createElement('div');
        row.className = 'hp-team';
        row.innerHTML = `
          <span class="nm" style="color:${tc.text};font-weight:600">${tc.name}</span>
          <div class="hp-bar"><i style="background:${tc.main}"></i></div>
          <span class="pc"></span>`;
        hpStrip.appendChild(row);
      }
    }
    let idx = 0;
    for (const t of [...teams.keys()].sort((a, b) => a - b)) {
      const v = teams.get(t);
      const row = hpStrip.children[idx++];
      const pct = v.max ? Math.max(0, v.hp / v.max) : 0;
      row.querySelector('.hp-bar i').style.width = (pct * 100).toFixed(1) + '%';
      row.querySelector('.pc').textContent = `${v.alive}/${v.total}`;
    }
  }

  /* ---------- 7) 结果 ---------- */
  function drawResult() {
    if (!battle.over || ui.frame < totalFrames) return;
    if (!resultCard.hidden) return;
    const s = battle.summary();
    const winTeam = s.winner;
    const cols = winTeam >= 0 ? teamColor(winTeam) : null;
    const rows = s.units.slice().sort((a, b) => b.dmg - a.dmg);
    resultCard.hidden = false;
    resultCard.innerHTML = `
      <div class="result-banner" style="${cols ? `border-color:${cols.main};background:${cols.soft}` : ''}">
        <div class="big" style="${cols ? `color:${cols.text}` : ''}">
          ${winTeam < 0 ? '平局' : cols.name + ' 获胜'}
        </div>
        <div class="sm">${s.endReason} · 全长 ${s.seconds} 秒 · 结果指纹 <span class="mono">${s.fingerprint}</span></div>
      </div>
      <h3>伤害统计</h3>
      <table class="tbl">
        <thead><tr><th>小球</th><th>队伍</th><th class="num">造成</th><th class="num">承受</th><th class="num">击杀</th></tr></thead>
        <tbody>
          ${rows.map(u => `
            <tr>
              <td><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${u.color};margin-right:5px"></span>${u.name}${u.alive ? '' : ' <span class="hint">阵亡</span>'}</td>
              <td style="color:${teamColor(u.team).text}">${teamColor(u.team).name}</td>
              <td class="num">${u.dmg}</td>
              <td class="num">${u.taken}</td>
              <td class="num">${u.kills}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    `;
  }

  /* ---------- 8) 日志刷新（二分查表） ---------- */
  function drawLog() {
    // 找到 <= ui.frame 的最后一条
    let lo = 0, hi = logLines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (logLines[mid].f <= ui.frame) lo = mid + 1; else hi = mid;
    }
    if (lo === logCursor) return;
    logCursor = lo;
    const start = Math.max(0, lo - 26);
    logHost.innerHTML = logLines.slice(start, lo)
      .map(l => `<div>${l.text}</div>`).join('') || '<div class="hint">（尚无事件）</div>';
    logHost.scrollTop = logHost.scrollHeight;
  }

  const dbgBox = root.querySelector('#dbgBox');
  let dbgOn = false;

  /* ---------- 8.2) 玩家技能栏（HUD） ----------
     不做这个的话，玩家根本不知道"哪个键放哪个技能、还要等几秒" ——
     作者的原话是"原间隔改为技能冷却"，而冷却必须看得见才谈得上用它。
     内容全部来自引擎：技能列表来自 manualSkillIds、
     冷却读 unit.skillCd（这两个都是权威口径，界面不自己算）。 */
  let hudCache = '';
  function drawHud() {
    if (!live || !hudBox || !playerUnit) return;
    const bindings = getPlayerKeys();
    const cdOf = id => Math.max(0, playerUnit.skillCd[id] || 0);
    const hpNow = Math.max(0, Math.round(playerUnit.hp));
    const chips = manualIds.map((id, i) => {
      const sk = getSkill(id) || { name: id };
      const code = bindings[i];
      const left = cdOf(id);
      const ready = left <= 0;
      const cd = sk.trigger && sk.trigger.cd ? sk.trigger.cd : 0;
      const pct = cd > 0 ? Math.max(0, Math.min(1, 1 - left / cd)) : 1;
      return `<span class="ch-slot${ready ? ' ready' : ''}${code ? '' : ' unbound'}">
        <b class="ch-key">${code ? keyLabel(code) : '未绑定'}</b>
        <span class="ch-name">${sk.name}</span>
        <i class="ch-cd">${ready ? '就绪' : left.toFixed(1) + 's'}</i>
        <span class="ch-fill" style="width:${(pct * 100).toFixed(0)}%"></span>
      </span>`;
    }).join('');
    /* 自动触发的技能也列出来 —— 玩家得知道"这些不用按键" */
    const autos = (playerUnit.skills || []).map(getSkill).filter(Boolean)
      .filter(sk => !manualIds.includes(sk.id))
      .map(sk => sk.name).join('　·　');
    const html = `<div class="ch-head">你操控：<b>${teamColor(playerUnit.team).name} #${playerUnit.slot % 100 + 1}</b>
      ${playerUnit.name} · 生命 <b>${hpNow}</b>/${playerUnit.maxHp}${
      battle.over ? ' · <span class="ch-over">本局已结束，可拖动进度条回看</span>' : ''}</div>
      <div class="ch-row">${chips || '<span class="hint">这个球没有主动技能（全是被动/形态类，自动触发）</span>'}</div>
      ${autos ? `<div class="ch-auto">自动触发：${autos}</div>` : ''}`;
    /* 每帧重排 DOM 会让鼠标事件闪烁、也浪费；只在内容真的变了才写 */
    if (html !== hudCache) { hudBox.innerHTML = html; hudCache = html; }
    hudBox.hidden = false;
  }

  /** 尺寸信息面板：排查"场地显示与页面不一致"这类布局问题用 */
  function updateDebug() {
    if (!dbgBox) return;
    const r = renderer;
    const px = v => (v === undefined || v === null ? '-' : Math.round(v));
    /* 关键核对项：画布实际内容宽度 vs 渲染器记录值。
       两者不一致 => 相机是按旧宽度算的，场地就会只占画布一部分。 */
    const liveW = canvas.clientWidth;
    const drift = liveW && r.cssW ? Math.abs(liveW - r.cssW) : 0;
    dbgBox.textContent = [
      `视口            ${window.innerWidth} × ${window.innerHeight}`,
      `画布内容宽(实测) ${px(liveW)}`,
      `画布内容宽(记录) ${px(r.cssW)}   ${drift > 1 ? '← 不一致，正在重算' : '一致'}`,
      `画布内容高(实测) ${px(canvas.clientHeight)}   应为 ${px(r.cssH)}` +
        (canvas.clientHeight && r.cssH && Math.abs(canvas.clientHeight - r.cssH) > 1 ? '  ← 不一致' : '  一致'),
      `画布缓冲区      ${canvas.width} × ${canvas.height}（dpr ${r.dpr}）`,
      `resize 次数     ${r._resizeCount || 0}`,
      `相机缩放        ${(r.camScale || 0).toFixed(3)}（渲染实际用 ${(r._usedScale || 0).toFixed(3)}）`,
      `世界窗口        ${px(r.boxW)} × ${px(r.boxH)}`,
      /* camScale 是"缓冲区像素 / 世界单位"，换成 CSS 像素要除 _bufScale
         （不是 dpr —— 缓冲区超过 MAX_BUF_W 时 bufScale 会被压低）。 */
      `场地应占        ${px((r.camScale || 0) * (r.boxW || 0) / (r._bufScale || r.dpr || 1))} × ` +
        `${px((r.camScale || 0) * (r.boxH || 0) / (r._bufScale || r.dpr || 1))} CSS 像素`,
      `场地            ${arena.name} ${Math.round((battle.sizeScale ?? 1) * 100)}%`,
      `在场小球        ${battle.units.filter(u => u.alive).length} / ${battle.units.length}`,
      `播放头          ${ui.frame} / ${totalFrames}`
    ].join('\n');
  }

  /* ---------- 8.5) 战前抽技能：三格老虎机 ----------
   *  只有开了「随机技能」才有这一段。规则由引擎定（core.js 用本局种子抽），
   *  这里**只负责把已经抽好的结果显示出来** —— 界面不参与抽签，
   *  所以不存在"界面显示的和引擎跑的不是同一套"。
   *
   *  每颗球一张卡：球体头像 + 三格转轮。三格依次停下（一格一停），
   *  全部停稳后再等一下才开打，让人看清抽到了什么。
   *  时间基准用 rAF 传进来的 now，暂停/重放不会影响它（它在播放之前就结束了）。 */
  const lottery = cfg.rules.randomSkills ? buildLottery() : null;

  /** 开局就在场上的单位（用于战前抽签）。
   *
   *  **不能直接用 `battle.units`**：整局是开战前一次性算完的，
   *  所以战斗中途召唤出来的分身（晕彩的「析光」）也已经在 units 里了。
   *  实测 1v1 的一局，units 有 4 个 —— 抽签界面上会凭空多出两张卡，
   *  显示的是"还没出生的那个分身"抽到了什么。
   *  判据用第 0 帧快照里的单位数（渲染层反推单位数用的是同一招）。 */
  function startingUnits() {
    const n = Math.floor((battle.snapshots[0]?.data.length || 0) / SNAP_STRIDE);
    const k = n > 0 ? Math.min(n, battle.units.length) : battle.units.length;
    return battle.units.slice(0, k);
  }

  function buildLottery() {
    const layer = root.querySelector('#lotteryLayer');
    const SPIN_MS = 70;          // 转轮每格跳动的间隔
    const FIRST_STOP = 900;      // 第一格停下的时刻
    const STOP_STEP = 520;       // 每格之间的间隔
    const HOLD = 800;            // 全部停下后再停留多久
    const FADE = 260;            // 淡出时长

    const cards = startingUnits().map(u => {
      const sp = SPECIES_BY_ID[u.speciesId] || {};
      const pool = (sp.skills || []).map(id => (getSkill(id) || {}).name || id);
      const picked = (u.skills || []).map(id => (getSkill(id) || {}).name || id);
      return { unit: u, sp, pool, picked, spins: picked.map(() => 0) };
    });
    /* 转轮的格数 = 实际抽到的个数（互斥组在抽的时候就避开了，
       所以正常都是三格；球种技能太少就少几格），下面按 picked 逐个渲染。
       **显隐靠 .show 类，不靠 hidden 属性** ——
       `.lottery-layer` 自己有 `display:none`，加上 `.show` 才变成 flex；
       只用 `hidden` 的话会被这个 `display` 压过去（踩过：那块白纱一直盖在画面上）。 */
    layer.hidden = false;
    layer.classList.add('show');
    layer.innerHTML = `
      <div class="lottery-box">
        <div class="lottery-title">本局技能抽取</div>
        <div class="lottery-cards">
          ${cards.map((c, ci) => `
            <div class="lottery-card" data-card="${ci}">
              <div class="lottery-who">
                <span class="dot" style="background:${c.unit.color}"></span>
                ${c.unit.name}
                <span class="hint">${teamColor(c.unit.team).name}</span>
              </div>
              <div class="lottery-reels">
                ${c.picked.map((_, ri) => `
                  <div class="reel" data-reel="${ci}:${ri}">
                    <span>${c.pool.length ? c.pool[0] : '无技能'}</span>
                  </div>`).join('')}
              </div>
              <div class="lottery-pool hint">技能池：${c.pool.join(' / ') || '（没有技能）'}</div>
            </div>`).join('')}
        </div>
        <div class="lottery-foot">
          <span class="hint">三格依次停下即抽签结束，随后自动开打。</span>
          <span class="spacer" style="flex:1"></span>
          <button class="btn sm" id="lotterySkip">直接开打</button>
        </div>
      </div>
    `;
    const reelEls = new Map();
    layer.querySelectorAll('.reel').forEach(el => reelEls.set(el.dataset.reel, el));

    const totalStops = cards.reduce((n, c) => Math.max(n, c.picked.length), 0);
    const endAt = FIRST_STOP + Math.max(0, totalStops - 1) * STOP_STEP;
    let t0 = null;
    const api = {
      started: false, done: false,
      start(now) { t0 = now; },
      /* 直接开打：点"跳过"或超时兜底都走这里。
         只隐藏、**不清空内容** —— 抽签结果留在 DOM 里，
         之后想核对"到底抽到了什么"（诊断、测试）还能查得到。 */
      finish() {
        api.done = true;
        layer.hidden = true;
        layer.classList.remove('show');
      },
      tick(now) {
        const el = (now - t0);
        /* 转轮：还没停的那几格每 SPIN_MS 换一个名字 */
        cards.forEach((c, ci) => {
          c.picked.forEach((finalName, ri) => {
            const stopAt = FIRST_STOP + ri * STOP_STEP;
            const node = reelEls.get(ci + ':' + ri);
            if (!node) return;
            if (el >= stopAt) {
              if (node.dataset.stopped !== '1') {
                node.dataset.stopped = '1';
                node.classList.add('done', 'pop');
                node.querySelector('span').textContent = finalName;
              }
              return;
            }
            const tickNo = Math.floor(el / SPIN_MS);
            if (tickNo !== c.spins[ri]) {
              c.spins[ri] = tickNo;
              const pool = c.pool.length ? c.pool : ['无技能'];
              /* 用下标错开每格的名字，看起来才像真的在滚 */
              node.querySelector('span').textContent = pool[(tickNo + ri) % pool.length];
            }
          });
        });
        if (el >= endAt + HOLD) { api.finish(); return; }
        if (el >= endAt) layer.querySelector('.lottery-box').classList.add('settled');
      }
    };
    layer.querySelector('#lotterySkip').onclick = () => api.finish();
    return api;
  }

  /* ---------- 9) 播放循环 ---------- */
  function loop(now) {
    /* 点「斗蛐蛐开始」的那一帧要重置计时基准（见 ui.resetClock 的注释） */
    if (ui.resetClock) { ui.last = now; ui.resetClock = false; }
    const dtms = Math.min(120, now - ui.last);
    ui.last = now;

    /* 战前抽技能（随机技能开着时）：抽签动画没走完之前**不推播放头**。
       用的是 rAF 传进来的 now（不是 Date.now），所以无头测试里
       只要按固定步长喂帧就能把动画跑完 —— 见 tests/smoke.test.mjs。
       注意 start() 必须先于 tick()：t0 为 null 时 `now - t0` 会把 null 当 0，
       于是"已经过去 10 万毫秒"，第一帧就直接收摊开打了。 */
    if (lottery && !lottery.done) {
      if (!lottery.started) { lottery.start(now); lottery.started = true; }
      lottery.tick(now);
      renderer.draw(battle, 0, {});            // 背后先画第 0 帧，不黑屏
      drawStrip(0);
      requestAnimationFrame(loop);
      return;
    }

    /* ---------- 开战闸门 ----------
       进战斗界面**不立刻开打**：抽签（如果有）先放完，然后停在第 0 帧
       等玩家点「斗蛐蛐开始」（作者 2026-10 的要求）。
       注意这里只是"不推进"：画面、技能栏、战报都照常画，
       所以玩家在按下去之前就能看清自己带的是什么。 */
    if (!ui.started) {
      startLayer.classList.add('show');
      if (startBtn) startBtn.focus({ preventScroll: true });
      renderer.draw(battle, Math.min(ui.frame, battle.snapshots.length - 1), {});
      drawStrip(Math.min(ui.frame, battle.snapshots.length - 1));
      drawLog();
      drawHud();
      syncControls();
      seek.value = ui.frame;
      timeLabel.textContent = (ui.frame * DT).toFixed(1) + 's';
      requestAnimationFrame(loop);
      return;
    }

    /* 实时模式里"播放头到末尾"是**常态**（播放头永远跟着引擎走），
       所以"打完了没有"只能看 battle.over —— 不能拿 frame >= totalFrames 判断，
       否则开局第一批帧一跑完就自己按暂停（第一版就是这么写的，
       表现是"按了 WASD 球不动、技能也放不出来"）。 */
    const simDone = live ? battle.over : true;
    if (ui.playing) {
      if (!simDone) {
        /* 玩家操控：**实时推进**（一到多帧，看倍速）。
           每一帧都重新读一次输入，所以按键是"按下即生效"；
           0.5× 时不满一帧就攒着，1× 以上一帧跑多步。 */
        ui.acc += (dtms / 1000) * 60 * ui.speed;
        const adv = Math.floor(ui.acc);
        if (adv > 0) {
          ui.acc -= adv;
          const before = ui.frame;
          for (let k = 0; k < adv && !battle.over; k++) battle.step(readPlayerInput());
          ui.frame = battle.frame;
          totalFrames = battle.frame;
          warmSprites();
          audio.playRange(battle, before, ui.frame);
        }
      } else if (ui.frame < totalFrames) {
        /* 打完之后就是普通的快照回放（拖动进度条 / 从头重看都走这里） */
        ui.acc += (dtms / 1000) * 60 * ui.speed;      // 逻辑帧
        const adv = Math.floor(ui.acc);
        if (adv > 0) {
          ui.acc -= adv;
          const before = ui.frame;
          ui.frame = Math.min(totalFrames, ui.frame + adv);
          /* 音效跟着播放头走：只播放刚过去这一段里的事件。
             暂停时不进这个分支 = 自然静音；拖动进度条那一跳帧数很大，
             audio 会判定为"跳转"而不发声。 */
          audio.playRange(battle, before, ui.frame);
        }
      }
    } else if (live) {
      /* 暂停时把"按下过"也清掉：不然暂停期间点的那一下会在恢复后突然放一发 */
      keysEdge.clear();
    }

    const snapIdx = Math.min(ui.frame, battle.snapshots.length - 1);
    renderer.draw(battle, snapIdx, {});
    /* 鼠标准星：画在引擎画面之后（它自己重设一次变换），
       所以不受绘制顺序影响；玩家看到"弹道会朝哪飞"才有得瞄。
       打完（进入回看）之后就不画了 —— 那时候鼠标已经不是在瞄准了。 */
    if (live && aimWorld && !battle.over) {
      const d = battle.snapshots[snapIdx].data;
      const o = battle.playerIdx * SNAP_STRIDE;
      const has = d.length >= o + SNAP_STRIDE;
      renderer.drawAim(aimWorld, {
        from: has ? { x: d[o] / SCALE, y: d[o + 1] / SCALE } : null,
        color: 'rgba(253,230,138,0.75)',
      });
    }

    /* 自愈：每秒核对一次画布的实际显示宽度。
       CSS 布局完成、窗口变化、侧栏内容变化都可能让宽度改变，
       漏掉任何一次都会导致"场地只占画布一部分"。
       这里直接读 canvas.clientWidth（内容宽度），与渲染器记录的值比对。 */
    ui.sizeCheck = (ui.sizeCheck || 0) + 1;
    if (ui.sizeCheck % 60 === 0) {
      const w = canvas.clientWidth;
      if (w && Math.abs(w - (renderer.cssW || 0)) > 1) renderer.resize();
    }
    seek.value = ui.frame;
    if (seek.max !== String(totalFrames)) seek.max = String(totalFrames);
    timeLabel.textContent = (ui.frame * DT).toFixed(1) + 's';

    appendLogLines();
    drawStrip(snapIdx);
    drawLog();
    drawHud();
    syncControls();
    /* "手势被拦下"的提示：只显示一会儿（帧数倒计时，不依赖墙上时钟） */
    if (guardHint) {
      if (guardNoticeFrames > 0) {
        guardNoticeFrames--;
        if (guardHint.hidden) {
          guardHint.hidden = false;
          guardHint.textContent = '⚠ 对局进行中：右键手势 / 浏览器后退已被拦下（再按一次后退可退出，或点「重新准备」）';
        }
      } else if (!guardHint.hidden) {
        guardHint.hidden = true;
      }
    }
    if (dbgBox && dbgOn) updateDebug();
    /* 打完了就停下播放键 + 出结算卡（实时模式下只有 simDone 才是真的"打完"） */
    if (simDone && ui.frame >= totalFrames) {
      if (ui.playing) { ui.playing = false; playBtn.textContent = '▶ 播放'; }
      drawResult();
    }

    requestAnimationFrame(loop);
  }

  /** 播放控件的可用性，两种情况要锁住：
   *  ① **还没点「斗蛐蛐开始」**：单步/拖动/跳到结果都没有意义；
   *  ② 实时模式打到一半：快照还没录完（拖过去只能看到半局）。
   *  锁住的是"改播放头"的那几个控件，暂停/倍速照常可用。 */
  function syncControls() {
    const locked = !ui.started || (live && !battle.over);
    if (seek.disabled !== locked) seek.disabled = locked;
    if (stepBtn.disabled !== locked) stepBtn.disabled = locked;
    if (stepBackBtn.disabled !== locked) stepBackBtn.disabled = locked;
    if (skipBtn.disabled !== locked) skipBtn.disabled = locked;
    if (locked && !seek.title) {
      seek.title = !ui.started ? '先点「斗蛐蛐开始」' : '实时战斗：本局打完后才能回看';
    }
  }

  /* 「斗蛐蛐开始」：进战斗界面后的唯一入口（详见 ui.started 的注释）。
     注意**不清 keysDown** —— 玩家可能一直按着 W 在等开始；
     只把"按下过"的边沿清掉，免得等开始期间点的那一下在开打瞬间放出来。 */
  const startBtn = root.querySelector('#btStart');
  function beginBattle() {
    if (ui.started) return;
    ui.started = true;
    ui.playing = true;
    ui.resetClock = true;
    keysEdge.clear();
    startLayer.classList.remove('show');
    playBtn.textContent = '⏸ 暂停';
    syncControls();
  }
  if (startBtn) startBtn.onclick = beginBattle;

  /* ---------- 10) 交互 ---------- */
  root.querySelector('#btBack').onclick = () => onExit();
  root.querySelector('#btAgain').onclick = () => onExit(true);

  playBtn.onclick = () => {
    /* 还没开始：播放键不做事（开战只有「斗蛐蛐开始」那一个入口） */
    if (!ui.started) return;
    /* "从头重看"只在**这一局已经打完**时才做：
       实时操控打到一半时播放头就一直等于总帧数，若照旧判 frame >= totalFrames
       就会把播放头归 0 —— 那和引擎当前状态对不上，画面会跳回开局（第一版踩过）。 */
    const simDone = live ? battle.over : true;
    if (simDone && ui.frame >= totalFrames) ui.frame = 0;      // 从头回放
    ui.playing = !ui.playing;
    playBtn.textContent = ui.playing ? '⏸ 暂停' : '▶ 播放';
  };
  stepBtn.onclick = () => {
    if (!ui.started) return;
    ui.playing = false; playBtn.textContent = '▶ 播放';
    ui.frame = Math.min(totalFrames, ui.frame + 1);
  };
  stepBackBtn.onclick = () => {
    if (!ui.started) return;
    ui.playing = false; playBtn.textContent = '▶ 播放';
    ui.frame = Math.max(0, ui.frame - 1);
  };
  skipBtn.onclick = () => {
    if (!ui.started) return;
    ui.playing = false; playBtn.textContent = '▶ 播放';
    ui.frame = totalFrames;
  };
  speedSeg.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    ui.speed = Number(b.dataset.s);
    [...speedSeg.children].forEach(c => c.classList.toggle('on', c === b));
  };
  seek.oninput = () => {
    /* 还没开始 / 实时战斗期间进度条是禁用的：这里再兜一道，
       免得有人用脚本触发 oninput 把播放头拖到不存在的帧上。 */
    if (!ui.started || (live && !battle.over)) { seek.value = ui.frame; return; }
    ui.playing = false; playBtn.textContent = '▶ 播放';
    ui.frame = Number(seek.value);
    audio.silence();          // 拖动时把正在响的声音掐掉，否则会拖着一串尾音
  };
  root.querySelector('#cbHud').onchange = e => { renderer.showHud = e.target.checked; };
  root.querySelector('#cbDmg').onchange = e => { renderer.showDamage = e.target.checked; };
  root.querySelector('#cbShake').onchange = e => {
    renderer.screenShake = e.target.checked;   // 立刻生效（不用重开一局）
    setShakeEnabled(e.target.checked);         // 记进偏好，下次进战斗沿用
  };

  /* ---------- 音效 ----------
     浏览器不允许在用户手势之前出声，所以这里在**第一次点击/按键**时才
     真正创建 AudioContext。用户点「开始斗蛐蛐」时已经有一次点击了，
     但战斗界面也可能是直接刷新进来的，所以两条路都要兜住。 */
  const cbSound = root.querySelector('#cbSound');
  const volSound = root.querySelector('#volSound');
  const unlockAudio = () => {
    if (!audio.unlock()) return;      // 不支持的环境直接静默
    audio.setEnabled(!!(cbSound && cbSound.checked));
    audio.setVolume(volSound ? Number(volSound.value) : 0.6);
  };
  if (cbSound) {
    cbSound.checked = getSoundEnabled();       // 记住上次的选择
    cbSound.onchange = e => {
      unlockAudio();
      audio.setEnabled(e.target.checked);
      setSoundEnabled(e.target.checked);
    };
  }
  if (volSound) {
    volSound.value = String(getSoundVolume());
    volSound.oninput = e => {
      audio.setVolume(Number(e.target.value));
      setSoundVolume(Number(e.target.value));
    };
  }
  /* 首次手势解锁（只解一次，之后解绑） */
  const onceUnlock = () => {
    unlockAudio();
    root.removeEventListener('pointerdown', onceUnlock);
    root.removeEventListener('keydown', onceUnlock);
  };
  root.addEventListener('pointerdown', onceUnlock);
  root.addEventListener('keydown', onceUnlock);
  /* 直接刷新进战斗界面、用户又没点过任何东西时，
     点一下播放按钮也算手势 —— 由上面的事件委托覆盖。 */

  const cbDebug = root.querySelector('#cbDebug');
  if (cbDebug) {
    cbDebug.onchange = e => {
      dbgOn = e.target.checked;
      dbgBox.style.display = dbgOn ? 'block' : 'none';
      renderer.showFrame = dbgOn;      // 同时画出画布边界标线
      if (dbgOn) updateDebug();
    };
  }

  fpLabel.textContent = live
    ? `种子 ${seed} · 实时操控（打完可回看）`
    : `种子 ${seed} · 指纹 ${battle.fingerprint()} · 全自动`;

  /* ---------- 11) （已移除）旧的"触屏拖动操控" ----------
     那一套是配合"开局一次性算完整局"写的：拖动只改一个键盘状态集合，
     而那个集合只在**预算阶段**被读一次，实战里其实什么都不会发生。
     现在玩家操控是实时推进、鼠标用来瞄准（左键/右键还是技能键），
     再按住拖动就会和开火打架，所以整段删掉。键鼠之外的操控方式以后再说。 */

  /* ---------- 11) 误触 / 鼠标手势保护 ----------
     右键是 2 号技能键（作者指定的默认键位），而"按住右键拖动"在很多浏览器
     或鼠标驱动里是**后退手势** —— 一旦触发，浏览器就退回上一页/上一个路由，
     这一局当场没了（作者实测就是这个）。

     两道防线：
       ① **整个战斗界面**屏蔽右键菜单与中键（以前只挡了画布，
          在顶栏/侧栏上按右键照样弹菜单）；
       ② 给路由挂一个"守门人"（`window.__battleScreen`）：对局**进行中**时，
          非本界面主动发起的跳转会被拦下，并给一句提示。
          连按两次后退（1.5 秒内）才放行 —— 想退出的人不会被硬关在里面。 */
  let leaveRequested = false;
  let guardHits = 0, lastGuardAt = 0, guardNoticeFrames = 0;
  const guardHint = root.querySelector('#guardHint');

  function detach() {
    screenGuard.alive = false;
    keysDown.clear();
    keysEdge.clear();
    window.removeEventListener('resize', onResize);
    if (live) {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlurWin);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onCanvasUp);
      canvas.removeEventListener('mousedown', onCanvasDown);
      canvas.removeEventListener('contextmenu', onCtxMenu);
    }
    root.removeEventListener('contextmenu', onCtxRoot);
    root.removeEventListener('auxclick', onAuxRoot);
    if (ro) { ro.disconnect(); ro = null; }
    if (window.__battleScreen === screenGuard) window.__battleScreen = null;
  }

  const screenGuard = {
    alive: true,
    /** 这一局还"值得保护"吗？
     *  实时模式看引擎（battle.over）；全自动模式**开局就 over 了**（整局已算完），
     *  所以那种情况要看播放头有没有播到头 —— 用 battle.over 判会把全自动模式
     *  当成"打完了"，守门人等于没挂（check-boot 就是这么抓出来的）。 */
    running() {
      if (!ui.started) return false;
      return live ? !battle.over : ui.frame < totalFrames;
    },
    /** 路由问它："这次跳转能走吗？" true = 拦下来（地址会被改回 #/battle）。 */
    block(hash) {
      if (!screenGuard.alive || leaveRequested) return false;
      /* 还没点开始 / 已经播完：随便走（没什么可丢的） */
      if (!screenGuard.running()) return false;
      const h = String(hash || '');
      if (h === '#/battle' || h.startsWith('#/battle')) return false;
      const now = performance.now();
      if (now - lastGuardAt > 1500) guardHits = 0;        // 隔久了重新数
      lastGuardAt = now;
      guardHits++;
      if (guardHits >= 2) return false;                   // 连按两次：放行
      guardNoticeFrames = 160;
      return true;
    },
    detach,
  };

  /* 右键/中键：在战斗界面里一律不弹菜单、也不做浏览器默认动作 */
  const onCtxRoot = e => { e.preventDefault(); };
  const onAuxRoot = e => { e.preventDefault(); };
  root.addEventListener('contextmenu', onCtxRoot);
  root.addEventListener('auxclick', onAuxRoot);

  /* 画布尺寸依赖场地大小（小场地放大铺满），窗口变化时按当前缩放重算 */
  const onResize = () => renderer.resize();
  window.addEventListener('resize', onResize);

  /* 画布尺寸依赖容器实测宽度。容器宽度由 CSS 网格决定，
     而首次渲染时布局可能还没算完，量到的会是旧宽度 ——
     表现就是"场地只占画布一小块、右侧留一大片空白"。
     实测曾出现 resize 次数为 0（初始化之后再没重算过），所以这里做三件事：
       ① ResizeObserver 直接盯住 canvas —— 它的 CSS 宽度由父容器撑开，
          contentBoxSize.inlineSize 就是不含边框的内容宽度，正是需要的值；
       ② 下一帧与稍后各再量一次，覆盖首次布局；
       ③ 渲染循环里持续核对实际宽度（见 loop 中的自愈检查）。 */
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(entries => {
      const e = entries[0];
      const box = e && e.contentBoxSize && e.contentBoxSize[0];
      const w = box ? box.inlineSize : (e && e.contentRect ? e.contentRect.width : 0);
      // 只在真正变化时重算，避免与自身写入产生循环
      if (w && Math.abs(w - (renderer.cssW || 0)) > 1) renderer.resize();
    });
    ro.observe(canvas);
  }
  requestAnimationFrame(() => renderer.resize());
  setTimeout(() => renderer.resize(), 120);

  /* 退出：先"拆监听"（detach），再交给上层去换界面。
     `leaveRequested` 是给守门人看的 —— 我们自己点的退出不该被自己拦下。 */
  const origExit = onExit;
  const leave = (again) => {
    leaveRequested = true;
    detach();
    origExit(again);
  };
  root.querySelector('#btBack').onclick = () => leave(false);
  root.querySelector('#btAgain').onclick = () => leave(true);

  /* ---------- 12) 启动 ---------- */
  /* 上一个战斗界面（例如"换种子重开"）先拆干净，再把这一个挂给路由当守门人 */
  if (window.__battleScreen && typeof window.__battleScreen.detach === 'function') {
    window.__battleScreen.detach();
  }
  window.__battleScreen = screenGuard;
  renderer.resize();
  drawStrip(0);
  drawLog();
  drawHud();
  syncControls();
  requestAnimationFrame(now => { ui.last = now; loop(now); });
}

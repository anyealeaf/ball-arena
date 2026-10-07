/* ============================================================
   ui-battle.js — 战斗界面：观战、操控、回放
   ------------------------------------------------------------
   播放模型：
     整局战斗在开始时被一次性算完并录成快照序列，
     界面只负责推动"播放头"。因此倍速、暂停、单步、回放
     全部是免费获得的，且任何倍速下结果都完全一致。
   ============================================================ */

import { Battle, SNAP_STRIDE } from './core.js';
import { Renderer, preloadStickers } from './render.js';
import { audio } from './audio.js';
import { getSoundEnabled, setSoundEnabled, getSoundVolume, setSoundVolume } from './prefs.js';
import { DT, SCALE, teamColor } from './balls.js';
import { ARENA_BY_ID, zoneLabel } from './arenas.js';
import { nextSeed } from './main.js';

/** 玩家输入采样间隔（帧）。越小越跟手，越大模拟越快。 */
const INPUT_SAMPLE_FRAMES = 6;

export function renderBattle(root, cfg, onExit) {
  /* ---------- 1) 建局 ---------- */
  const seed = nextSeed();
  const battle = new Battle({ ...cfg, seed });

  /* 提前加载本局用到的角色贴图：否则第一帧会是纯色兜底圆，随后才"变脸"。
     开华形态的贴图与手持物件（弓）也要带上 —— 之前这里只传了 sticker，
     于是晕彩开华那一瞬间会闪一下纯色圆，现在一并修掉。 */
  preloadStickers(battle.units.map(u => ({
    sticker: u.sticker, stickerBloom: u.stickerBloom, bow: u.bow, domain: u.domain
  })));

  /* ---------- 2) 预算整局 ----------
     玩家操控时无法"预先知道"操作，因此按固定节奏采样键盘意图后
     把整局算完。代价是开战前有一次极短的计算停顿，收益是
     倍速/暂停/回放全部可用，且结果可复现。 */
  const inputLog = [];
  if (cfg.rules.playerControl) {
    const held = new Set();
    const onKey = (e, down) => {
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
        e.preventDefault();
        if (down) held.add(k); else held.delete(k);
      }
    };
    window.addEventListener('keydown', e => onKey(e, true), { passive: false });
    window.addEventListener('keyup', e => onKey(e, false), { passive: false });

    let lastDx = 0, lastDy = 0;
    let sample = { dx: 0, dy: 0 };
    battle.runToEnd(b => {
      if (b.frame % INPUT_SAMPLE_FRAMES === 0) {
        sample = readDir(held);
        inputLog.push(sample);
      }
      return sample;
    });
    window.__battleKeyState = held;
  } else {
    battle.runToEnd();
  }

  const totalFrames = battle.frame;

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
        <canvas id="battleCanvas"></canvas>

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
              / 方向键移动，也可以在画面上按住拖动
            </div>
          ` : `
            <div class="hint">全自动模式：所有小球由 AI 自行战斗。</div>
          `}
        </div>
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
  const renderer = new Renderer(canvas);
  /* 画布裁到场地包围盒上：小场地不再在四周留一大圈空白
     （否则看着就像"战斗画面没显示全"）。 */
  renderer.setArena(battle.arena, battle.sizeScale ?? 1);
  renderer.showDamage = cfg.rules.showDamageNumbers;

  const ui = {
    frame: 0,
    playing: true,
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

  /* ---------- 5) 战报预编译 ----------
     一次性把事件流翻成文本行并记录帧号，之后用二分查表，
     避免每帧重扫上万个事件。 */
  const logLines = buildLogLines(battle);
  let logCursor = 0;

  function buildLogLines(b) {
    const out = [];
    const nameOf = i => (b.units[i] ? b.units[i].name : '?');
    const teamOf = i => (b.units[i] ? teamColor(b.units[i].team).name : '?');
    for (const e of b.events) {
      const t = (e.f * DT).toFixed(1);
      if (e.type === 'hit') {
        out.push({ f: e.f, text: `${t}s  ${teamOf(e.a)}${nameOf(e.a)} → ${teamOf(e.b)}${nameOf(e.b)}  −${Math.round(e.value)}` });
      } else if (e.type === 'death') {
        out.push({ f: e.f, text: `${t}s  ✖ ${teamOf(e.b)}${nameOf(e.b)} 阵亡${e.a >= 0 ? `（被 ${nameOf(e.a)} 击破）` : ''}` });
      } else if (e.type === 'respawn') {
        out.push({ f: e.f, text: `${t}s  ↻ ${teamOf(e.a)}${nameOf(e.a)} 复活` });
      } else if (e.type === 'end') {
        out.push({ f: e.f, text: `${t}s  【结束】${e.value < 0 ? '平局' : teamColor(e.value).name + '获胜'} — ${e.reason || ''}` });
      }
    }
    return out;
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

  /* ---------- 9) 播放循环 ---------- */
  function loop(now) {
    const dtms = Math.min(120, now - ui.last);
    ui.last = now;

    if (ui.playing && ui.frame < totalFrames) {
      ui.acc += (dtms / 1000) * 60 * ui.speed;      // 逻辑帧
      const adv = Math.floor(ui.acc);
      if (adv > 0) {
        ui.acc -= adv;
        const before = ui.frame;
        // 玩家操控时按采样节奏推进，保证"你看到的"和"重放"完全一致
        ui.frame = Math.min(totalFrames, ui.frame + adv);
        /* 音效跟着播放头走：只播放刚过去这一段里的事件。
           暂停时不进这个分支 = 自然静音；拖动进度条那一跳帧数很大，
           audio 会判定为"跳转"而不发声。 */
        audio.playRange(battle, before, ui.frame);
      }
    }

    const snapIdx = Math.min(ui.frame, battle.snapshots.length - 1);
    renderer.draw(battle, snapIdx, {});

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
    timeLabel.textContent = (ui.frame * DT).toFixed(1) + 's';

    drawStrip(snapIdx);
    drawLog();
    if (dbgBox && dbgOn) updateDebug();
    if (ui.frame >= totalFrames) { ui.playing = false; playBtn.textContent = '▶ 播放'; drawResult(); }

    requestAnimationFrame(loop);
  }

  /* ---------- 10) 交互 ---------- */
  root.querySelector('#btBack').onclick = () => onExit();
  root.querySelector('#btAgain').onclick = () => onExit(true);

  playBtn.onclick = () => {
    if (ui.frame >= totalFrames) ui.frame = 0;      // 从头回放
    ui.playing = !ui.playing;
    playBtn.textContent = ui.playing ? '⏸ 暂停' : '▶ 播放';
  };
  root.querySelector('#btStep').onclick = () => {
    ui.playing = false; playBtn.textContent = '▶ 播放';
    ui.frame = Math.min(totalFrames, ui.frame + 1);
  };
  root.querySelector('#btStepBack').onclick = () => {
    ui.playing = false; playBtn.textContent = '▶ 播放';
    ui.frame = Math.max(0, ui.frame - 1);
  };
  root.querySelector('#btSkip').onclick = () => {
    ui.playing = false; playBtn.textContent = '▶ 播放';
    ui.frame = totalFrames;
  };
  speedSeg.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    ui.speed = Number(b.dataset.s);
    [...speedSeg.children].forEach(c => c.classList.toggle('on', c === b));
  };
  seek.oninput = () => {
    ui.playing = false; playBtn.textContent = '▶ 播放';
    ui.frame = Number(seek.value);
    audio.silence();          // 拖动时把正在响的声音掐掉，否则会拖着一串尾音
  };
  root.querySelector('#cbHud').onchange = e => { renderer.showHud = e.target.checked; };
  root.querySelector('#cbDmg').onchange = e => { renderer.showDamage = e.target.checked; };

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

  fpLabel.textContent = `种子 ${seed} · 指纹 ${battle.fingerprint()} · ${inputLog.length ? '含玩家操作采样' : '全自动'}`;

  /* ---------- 11) 触屏 / 鼠标拖动操控 ---------- */
  if (cfg.rules.playerControl) {
    let dragging = false;
    const worldPos = ev => {
      const r = canvas.getBoundingClientRect();
      const cx = (ev.touches ? ev.touches[0].clientX : ev.clientX);
      const cy = (ev.touches ? ev.touches[0].clientY : ev.clientY);
      return {
        x: ((cx - r.left) / r.width) * (canvas.width / (window.devicePixelRatio > 2 ? 2 : window.devicePixelRatio || 1)),
        y: ((cy - r.top) / r.height) * (canvas.height / (window.devicePixelRatio > 2 ? 2 : window.devicePixelRatio || 1))
      };
    };
    // 触屏拖动：按住的方向即为移动方向（简化而稳定的移动端方案）
    const setDrag = (dx, dy) => {
      const ks = window.__battleKeyState;
      if (!ks) return;
      ks.clear();
      if (dx > 0.35) ks.add('d');
      if (dx < -0.35) ks.add('a');
      if (dy > 0.35) ks.add('s');
      if (dy < -0.35) ks.add('w');
    };
    let origin = null;
    const start = ev => { dragging = true; origin = worldPos(ev); ev.preventDefault(); };
    const move = ev => {
      if (!dragging || !origin) return;
      const p = worldPos(ev);
      const dx = p.x - origin.x, dy = p.y - origin.y;
      const m = Math.hypot(dx, dy) || 1;
      setDrag(dx / m, dy / m);
      ev.preventDefault();
    };
    const end = () => {
      dragging = false; origin = null;
      const ks = window.__battleKeyState; if (ks) ks.clear();
    };
    canvas.addEventListener('mousedown', start);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', end);
  }

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

  /* 返回时清掉键盘状态、移除监听，避免"卡键"和监听叠加 */
  const origExit = onExit;
  const leave = (again) => {
    window.__battleKeyState?.clear();
    window.removeEventListener('resize', onResize);
    if (ro) { ro.disconnect(); ro = null; }
    origExit(again);
  };
  root.querySelector('#btBack').onclick = () => leave(false);
  root.querySelector('#btAgain').onclick = () => leave(true);

  /* ---------- 12) 启动 ---------- */
  renderer.resize();
  drawStrip(0);
  drawLog();
  requestAnimationFrame(now => { ui.last = now; loop(now); });
}

/* ---------- 把按键集合读成方向向量 ---------- */
function readDir(held) {
  let dx = 0, dy = 0;
  if (held.has('a') || held.has('arrowleft')) dx -= 1;
  if (held.has('d') || held.has('arrowright')) dx += 1;
  if (held.has('w') || held.has('arrowup')) dy -= 1;
  if (held.has('s') || held.has('arrowdown')) dy += 1;
  return { dx, dy };
}

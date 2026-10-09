/* ============================================================
   ui-rogue.js — 闯关肉鸽模式的界面
   ------------------------------------------------------------
   流程（作者 2026-10 的规格）：
     选 3 个球种 → 合成技能池 → **抽两次技能**开局 → 第 1 关
     → 过关：+250 血 + 再抽一次 → 下一关（难度 +1；过 BOSS 关额外 +2）
     → 阵亡：结算本次闯到第几关，并更新最高记录

   规则全在 rogue.js（纯逻辑，能单独测）；这里只负责"画出来 + 收玩家的选择"。
   ============================================================ */

import {
  PLAYABLE_SPECIES, SPECIES_BY_ID,
} from './balls.js';
import { getSkill } from './skills.js';
import {
  STAT_GAIN,
  difficultyOf, isBossLevel, sizeName,
  rollLevel, rollDraw, newRun, applyStatGain, buildLevelConfig,
  LIGHT_ENCHANT_CARD,
  getBestLevel, recordLevel,
} from './rogue.js';
import { mulberry32 } from './core.js';
import { renderBattle } from './ui-battle.js';

/** 简单可复现的随机源：一局的关卡编成用它抽，种子写在状态里（重开会换种子）。 */
const newSeed = () => (Math.floor(Math.random() * 0xffffffff) >>> 0);

export function renderRogue(root, onExit) {
  /* ---------- 状态 ---------- */
  const state = {
    phase: 'pool',        // pool（选技能池）| draw（抽技能）| battle | over
    picks: [],            // 选中的三个球种
    seed: newSeed(),
    rnd: null,            // 每关重算（用 seed + level 派生，保证"这一关"重进也一致）
    run: null,
    levelSpec: null,
    drawsLeft: 0,         // 开局两次；过关后一次
    draw: null,           // 当前这一手的 { cards, stats }（含重抽后的结果）
    rerolled: {},         // 这一手里哪些卡已经重抽过
    enchantPick: false,   // 正在为光附魔选技能
    message: '',
    best: getBestLevel(),
    cleared: 0,           // 已经过了几关（用于记录）
  };

  const rndFor = (level) => mulberry32((state.seed ^ (level * 2654435761)) >>> 0);

  root.innerHTML = `
    <div class="topbar">
      <div class="brand">闯关肉鸽<small>逐关变强 · 每次开局都不一样</small></div>
      <div class="spacer"></div>
      <button class="btn" id="rgBack">返回首页</button>
    </div>
    <div id="rgBody"></div>
  `;
  const body = root.querySelector('#rgBody');
  root.querySelector('#rgBack').onclick = () => onExit();

  /* ---------- 公共片段 ---------- */
  const skillLine = id => {
    const sk = getSkill(id);
    if (!sk) return `<b>${id}</b>`;
    return `<b>${sk.name}</b><span class="hint"> — ${sk.desc || ''}</span>`;
  };
  const enemyLine = e => {
    const sp = SPECIES_BY_ID[e.speciesId];
    if (!sp) return '';
    const skills = (e.skills || []).map(id => (getSkill(id) || {}).name || id);
    return `<li>${e.boss ? '<b class="rg-boss">BOSS </b>' : ''}${sp.name}
      <span class="hint">${sp.hp * (e.hpMul || 1)} 血 · ${sizeName(sp.id)} · ${sp.speed} 速 · ` +
      `碰撞 ${sp.melee}${e.atkMul > 1 ? ` · 伤害 ×${e.atkMul}` : ''}` +
      `${skills.length ? ' · 技能：' + skills.join('、') : ''}</span></li>`;
  };

  /* ---------- ① 选技能池 ---------- */
  function drawPool() {
    const need = 3 - state.picks.length;
    body.innerHTML = `
      <div class="card">
        <h3>开局：选定三个小球，它们的技能就是本局的总技能池</h3>
        <div class="hint" style="margin-bottom:8px">
          已选 <b>${state.picks.length}</b>/3${need > 0 ? `（还要选 ${need} 个）` : '，可以开始了'} ·
          最高记录：<b>${state.best ? `第 ${state.best} 关` : '暂无'}</b>
        </div>
        <div class="rg-grid">
          ${PLAYABLE_SPECIES.map(sp => {
            const on = state.picks.includes(sp.id);
            const n = (sp.skills || []).length;
            return `<button class="rg-card${on ? ' on' : ''}" data-pick="${sp.id}">
              <div class="rg-name">${sp.name}</div>
              <div class="hint">${sp.hp} 血 · ${sizeName(sp.id)} · ${sp.speed} 速 · 碰撞 ${sp.melee}</div>
              <div class="hint">技能 ${n} 个${n ? '：' + sp.skills.map(id => (getSkill(id) || {}).name || id).join('、') : '（无）'}</div>
            </button>`;
          }).join('')}
        </div>
        <div class="btnrow" style="margin-top:12px">
          <button class="btn" id="rgStart" ${state.picks.length === 3 ? '' : 'disabled'}>开始闯关</button>
          <span class="hint">开场先抽两次技能（每次三选一，可重抽一次，也可以选属性）。</span>
        </div>
      </div>`;
    body.querySelectorAll('[data-pick]').forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.pick;
        const i = state.picks.indexOf(id);
        if (i >= 0) state.picks.splice(i, 1);
        else if (state.picks.length < 3) state.picks.push(id);
        drawPool();
      };
    });
    const start = body.querySelector('#rgStart');
    if (start) start.onclick = () => {
      state.run = newRun(state.picks);
      state.drawsLeft = 2;                 // 开局两次抽取
      state.phase = 'draw';
      nextDraw();
    };
  }

  /* ---------- ② 抽技能 / 选属性 ---------- */
  function nextDraw() {
    if (state.drawsLeft <= 0) { startLevel(); return; }
    state.draw = rollDraw(state.run.pool, state.run.skills, rndFor(state.run.level * 100 + state.drawsLeft));
    state.rerolled = {};
    drawDraw();
  }

  function drawDraw() {
    const run = state.run;
    const head = state.cleared === 0
      ? `开局抽取（还剩 ${state.drawsLeft} 次）`
      : `通过第 ${state.cleared} 关 · 抽取奖励（还剩 ${state.drawsLeft} 次）`;
    const learned = run.skills.length
      ? run.skills.map(id => `<span class="rg-tag">${(getSkill(id) || {}).name || id}` +
          `${run.light.includes(id) ? '<i class="rg-light">光</i>' : ''}</span>`).join('')
      : '<span class="hint">（还没有技能）</span>';

    /* 光附魔：选了它之后再选一个已有技能 */
    if (state.enchantPick) {
      body.innerHTML = `
        <div class="card">
          <h3>光附魔：选一个技能，让它的攻击也附带"光"</h3>
          <div class="hint" style="margin-bottom:8px">
            效果：该技能造成的伤害 +${50}（与开华的"光"加成同一套），弹道带上"光"特质
            （能被裁光的细线吸收、喂光）。
          </div>
          <div class="rg-grid">
            ${run.skills.map(id => `<button class="rg-card" data-enchant="${id}">
              <div class="rg-name">${(getSkill(id) || {}).name || id}</div>
              <div class="hint">${((getSkill(id) || {}).desc || '').slice(0, 40)}</div>
            </button>`).join('') || '<div class="hint">还没有技能可以附魔。</div>'}
          </div>
        </div>`;
      body.querySelectorAll('[data-enchant]').forEach(b => {
        b.onclick = () => {
          const id = b.dataset.enchant;
          if (!run.light.includes(id)) run.light.push(id);
          state.enchantPick = false;
          state.drawsLeft--;
          nextDraw();
        };
      });
      return;
    }

    body.innerHTML = `
      <div class="card">
        <h3>${head}</h3>
        <div class="hint" style="margin-bottom:8px">
          第 ${run.level} 关 · 难度 ${difficultyOf(run.level)}${isBossLevel(run.level) ? '（BOSS 关）' : ''}
          · 生命 ${run.hp}/${run.maxHp} · 移速 ${run.speed} · 伤害 +${run.bonusDmg}
        </div>
        <div class="rg-grid">
          ${state.draw.cards.map((c, i) => `
            <div class="rg-card${c.isEnchant ? ' ench' : ''}">
              <div class="rg-name">${c.name}</div>
              <div class="hint">${c.desc || ''}</div>
              <div class="btnrow" style="margin-top:8px">
                <button class="btn sm" data-take="${c.id}">选择</button>
                <button class="btn sm" data-reroll="${i}" ${state.rerolled[i] ? 'disabled' : ''}>
                  ${state.rerolled[i] ? '已重抽' : '重抽一次'}
                </button>
              </div>
            </div>`).join('')}
        </div>
        <div class="separator"></div>
        <div class="hint" style="margin-bottom:6px">不要技能也行 —— 换成提高基础属性：</div>
        <div class="btnrow">
          ${state.draw.stats.map(s => `<button class="btn sm" data-stat="${s.id}">${s.label}</button>`).join('')}
        </div>
        <div class="separator"></div>
        <div class="hint" style="margin-bottom:4px">已获得 ${run.skills.length} 个技能：</div>
        <div class="rg-tags">${learned}</div>
      </div>`;

    body.querySelectorAll('[data-take]').forEach(b => {
      b.onclick = () => {
        const id = b.dataset.take;
        if (id === LIGHT_ENCHANT_CARD.id) { state.enchantPick = true; drawDraw(); return; }
        if (!state.run.skills.includes(id)) state.run.skills.push(id);
        state.drawsLeft--;
        nextDraw();
      };
    });
    body.querySelectorAll('[data-reroll]').forEach(b => {
      b.onclick = () => {
        const i = Number(b.dataset.reroll);
        if (state.rerolled[i]) return;
        /* 重抽：把这一张换成池子里另一个还没拥有的技能（没有别的可换就原样留着） */
        const owned = state.run.skills.concat(
          state.draw.cards.map(c => c.id).filter(id => id !== LIGHT_ENCHANT_CARD.id));
        const alt = rollDraw(state.run.pool, owned, rndFor(state.run.level * 1000 + i + state.drawsLeft), 1);
        if (alt.cards.length) state.draw.cards[i] = alt.cards[0];
        state.rerolled[i] = true;
        drawDraw();
      };
    });
    body.querySelectorAll('[data-stat]').forEach(b => {
      b.onclick = () => {
        applyStatGain(state.run, b.dataset.stat);
        state.drawsLeft--;
        nextDraw();
      };
    });
  }

  /* ---------- ③ 开打 ---------- */
  function startLevel() {
    const run = state.run;
    const spec = rollLevel(run.level, rndFor(run.level));
    state.levelSpec = spec;
    state.phase = 'battle';
    const cfg = buildLevelConfig(run, spec);
    const enemies = spec.enemies.length;
    renderBattle(root, cfg, () => { state.phase = 'over'; drawOver(false); }, {
      title: `第 ${run.level} 关 · 难度 ${spec.difficulty}${spec.boss ? ' · BOSS' : ''}`,
      subtitle: `${spec.arena.name}（场地 ${Math.round(spec.sizeScale * 100)}%）· ${enemies} 个敌人`,
      hideAgain: true,
      exitLabel: '退出闯关',
      onEnd: (battle) => afterBattle(battle),
    });
  }

  /** 一关打完之后：判定过关 / 阵亡，并给出下一步 */
  function afterBattle(battle) {
    const run = state.run;
    const hero = battle.units[battle.playerIdx];
    run.hp = Math.max(0, Math.round(hero ? hero.hp : 0));
    const boss = isBossLevel(run.level);
    if (hero && hero.alive) {
      /* 过关：回 250 血（BOSS 关完全回血 + 额外一次"三样全给"） */
      state.cleared = run.level;
      recordLevel(state.cleared);
      state.best = getBestLevel();
      if (boss) {
        run.hp = run.maxHp;
        applyStatGain(run, 'all');
        state.message = `通过第 ${run.level} 关（BOSS）：生命全满，并且额外获得 ` +
          `+${STAT_GAIN.hp} 生命 / +${STAT_GAIN.speed} 移速 / +${STAT_GAIN.dmg} 伤害。`;
      } else {
        run.hp = Math.min(run.maxHp, run.hp + 250);
        state.message = `通过第 ${run.level} 关：回复 250 生命（${run.hp}/${run.maxHp}）。`;
      }
      run.level++;
      state.drawsLeft = 1;
      state.phase = 'draw';
    } else {
      state.phase = 'over';
      state.message = `第 ${run.level} 关阵亡。`;
    }
  }

  /** 战斗结束后的过渡页（过关直接回到抽取页；阵亡停在这里） */
  function drawOver(dead) {
    if (dead) { /* 由下面统一画 */ }
    const run = state.run;
    const best = state.best;
    if (state.message && !state.message.startsWith('第')) state.message = state.message;
    body.innerHTML = `
      <div class="card">
        <h3>闯关结束</h3>
        <div class="hint" style="margin-bottom:8px">
          本次闯到 <b>第 ${state.cleared + 1} 关</b>${state.cleared ? `（已通过 ${state.cleared} 关）` : ''} ·
          最高记录：<b>${best ? `第 ${best} 关` : '暂无'}</b>
        </div>
        <div class="hint" style="margin-bottom:10px">${state.message || ''}</div>
        <div class="btnrow">
          <button class="btn" id="rgAgain">再来一局</button>
          <button class="btn" id="rgHome">返回首页</button>
        </div>
      </div>`;
    body.querySelector('#rgAgain').onclick = () => {
      state.phase = 'pool';
      state.picks = [];
      state.seed = newSeed();
      state.run = null;
      state.cleared = 0;
      state.message = '';
      state.best = getBestLevel();
      drawPool();
    };
    body.querySelector('#rgHome').onclick = () => onExit();
  }

  /* ---------- 启动 ---------- */
  drawPool();
}

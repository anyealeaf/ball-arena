/* ============================================================
   audio.js — 音效（程序化合成，不需要任何音频素材）
   ------------------------------------------------------------
   为什么用 Web Audio 现场合成而不是加载音频文件：
     · 项目是零依赖、无构建步骤的纯前端，加素材就要多一套加载/缓存/降级；
     · 现场合成不牵扯任何素材版权（原创 IP 项目里这点很重要）；
     · 参数就是代码，音量/音高/时长随时可调，还能跟着伤害数值走。

   架构位置：**和 render.js 平级的一层"消费者"**。
   引擎一行都不用改 —— 音效挂在已有的事件流上，和画面用同一份数据。
   因此它天然跟随"播放头"：暂停就停、回放就重来、倍速自动节流。

   三个必须守住的点（都是踩过或推演过的坑）：
     1. 自动播放限制：浏览器在用户手势前不许出声，
        必须由一次真实点击来 unlock()。
     2. 事件洪流：裁光的质点/细线是"每帧 1 点"，一秒能出 60 条 hit。
        每条都发声 = 噪音墙 + 掉帧。所以按类型节流、再加上同时发声数上限。
     3. 拖动进度条会跳帧：跳跃太大时整段事件都不发声，
        否则拖一下会"炸"出一片声音。
   ============================================================ */

import { arenaBounds } from './arenas.js';
import { WORLD_W } from './balls.js';

/* 同一类声音的最小间隔（毫秒）。数字越小越密，越密越吵。 */
const MIN_GAP = {
  hit: 55,          // 打击音：混战时最密，卡得最紧
  tick: 200,        // 每帧持续伤害：只偶尔"嘶"一下，绝不逐帧响
  wall: 70,
  bounce: 70,
  projHit: 60,
  projWall: 60,
  shoot: 70,
  default: 40,
};

/* 同时发声上限。超过就丢弃新的 —— 宁可少响一声，也不能因为音频节点
   堆积把帧率拖下去（每个声音要建 2~3 个节点）。 */
const MAX_VOICES = 8;

/* ---------- 打击感：伤害 → 力度权重 ----------
   作者 2026-10 的要求：「增强小球攻击命中时候的打击感（伤害越高反馈越强）」。
   原来是一条线性映射 k = dmg/300，有两个毛病：
     · 66 的碰撞伤害只拿到 0.22 —— 而这恰恰是整局里响得最多的一声，
       "最常听到的打击"永远停在最轻的那一档；
     · 300 以上全被压成 1.0，"200 的技能"和"400 的爆炸"听起来一样重。
   换成**对数映射**：小伤害就有可观的力度，大伤害才拉满，中间拉开档次。
   HIT_SOFT 附近是轻碰，HIT_HARD 及以上拉满。

   ⚠ **render.js 的伤害飘字也用这一个权重**（伤害越高字越大）——
   视听必须成套：若各算各的，"重击"会出现"看起来比听起来轻"的错位。 */
export const HIT_SOFT = 30;
export const HIT_HARD = 300;
/** 低于这个权重就不出低频那一层（它最占发声名额，而轻碰本来就该是轻的） */
export const HIT_SUB_FLOOR = 0.25;

/** 伤害 → 力度权重（0~1）。对数刻度：30 伤害 ≈ 0.26，66 ≈ 0.49，200 ≈ 0.85，300+ = 1 */
export function hitWeight(dmg) {
  const d = Math.max(0, Number(dmg) || 0);
  if (d >= HIT_HARD) return 1;
  return clamp(Math.log(1 + d / HIT_SOFT) / Math.log(1 + HIT_HARD / HIT_SOFT), 0, 1);
}

/* 播放头一次前进超过这么多帧，就认为是在拖动进度条而不是在播放，
   这一段不做声 —— 否则拖动时会瞬间触发成百上千个声音。 */
const MAX_STEP_FRAMES = 24;

const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.volume = 0.6;
    /* 没有 Web Audio 的环境（无头测试、老浏览器）直接退化成空操作，
       上层代码不用到处写 if。 */
    this.supported = typeof globalThis.AudioContext !== 'undefined'
      || typeof globalThis.webkitAudioContext !== 'undefined';
    this._last = Object.create(null);   // 每类声音上次发声的时间
    /* 正在发声的声源：存它们的"结束时刻"（用 AudioContext 的时间轴）。
       刻意**不用** setTimeout 回收 —— 那是墙上时间，而声音活在 ctx 时间轴上；
       倍速播放时两者差好几倍，名额会被永久占满，结果就是"越打越没声音"。
       诊断脚本里就是这么把它抓出来的（8 倍速下 40 秒只响了 8 声）。 */
    this._active = [];
    this._peakVoices = 0;               // 同时发声数的历史峰值（供诊断核对）
    this._noiseBuf = null;
    this.comp = null;                   // 总线软限幅（有的环境没有这个节点）
    this._box = null;                   // 缓存的场地范围（用于声场定位）
    this._boxFor = null;
  }

  /** 当前真正在响的声源数（顺手清掉已经播完的） */
  _voicesNow() {
    const t = this.ctx ? this.ctx.currentTime : 0;
    if (this._active.length) this._active = this._active.filter(end => end > t);
    /* 记峰值：诊断脚本要靠它核对"名额有没有真的守住" */
    if (this._active.length > this._peakVoices) this._peakVoices = this._active.length;
    return this._active.length;
  }

  /** 必须在一次真实用户手势里调用（浏览器不允许自动出声） */
  unlock() {
    if (!this.supported) return false;
    if (!this.ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      try {
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.enabled ? this.volume : 0;
        /* 总线加一级软限幅：混战时十几下打击叠在一起也不会削顶爆音，
           而且限幅本身让"重击"听起来更结实（动态是打击感的另一半）。
           没有这个节点的环境（无头诊断里的伪 ctx）就直接接到输出。 */
        if (this.ctx.createDynamicsCompressor) {
          const comp = this.ctx.createDynamicsCompressor();
          comp.threshold.value = -12;
          comp.knee.value = 20;
          comp.ratio.value = 6;
          comp.attack.value = 0.003;
          comp.release.value = 0.12;
          this.master.connect(comp);
          comp.connect(this.ctx.destination);
          this.comp = comp;
        } else {
          this.master.connect(this.ctx.destination);
        }
      } catch (e) {
        this.supported = false;
        return false;
      }
    }
    // Safari / iOS 会把它挂起，每次手势都要尝试恢复
    if (this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume();
    return this.ctx.state !== 'suspended';
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (this.master) {
      this.master.gain.value = this.enabled ? this.volume : 0;
    }
  }

  setVolume(v) {
    this.volume = clamp(Number(v) || 0, 0, 1);
    if (this.master && this.enabled) this.master.gain.value = this.volume;
  }

  /** 暂停/单步时把正在响的声音立刻掐掉（短促音不处理听不出来） */
  silence() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(0, t);
    this.master.gain.linearRampToValueAtTime(
      this.enabled ? this.volume : 0, t + 0.06);
    this._active.length = 0;
  }

  /* ---------- 播放头推进时调用：只播放 (from, to] 这一段里的事件 ---------- */
  playRange(battle, from, to) {
    if (!this.supported || !this.enabled || !this.ctx) return;
    if (!(to > from)) return;
    /* 跳帧（拖进度条）= 不出声。这一条很重要：
       拖到对局末尾会一次性扫过几千条事件，不拦住就是一片噪音。 */
    if (to - from > MAX_STEP_FRAMES) return;
    const ev = battle.events;
    if (!ev || !ev.length) return;
    for (let i = lowerBound(ev, from); i < ev.length && ev[i].f <= to; i++) {
      this.play(ev[i], battle);
    }
  }

  /** 播放一个事件对应的音效 */
  play(e, battle) {
    if (!this.supported || !this.enabled || !this.ctx) return;
    if (this._voicesNow() >= MAX_VOICES) return;

    const pan = this._pan(e, battle);
    const now = this.ctx.currentTime;

    /* 每帧持续伤害单独节流：一秒 60 条，绝不能逐条响 */
    if (e.type === 'hit' && e.tick) {
      if (!this._gate('tick', now, MIN_GAP.tick)) return;
      this._tone({ freq: 140, dur: 0.07, type: 'triangle', gain: 0.05, pan });
      return;
    }

    switch (e.type) {
      /* ---- 打击 ---- */
      case 'hit': {
        if (!this._gate('hit', now, MIN_GAP.hit)) return;
        /* 近战（球撞球）用低沉些的撞击音，弹道命中用偏高一点的脆音；
           轻重完全交给伤害权重，见 hitWeight() */
        this._impact(hitWeight(e.value), pan, e.kind === 'melee' ? 220 : 420);
        break;
      }
      case 'death': {
        this._tone({ freq: 300, freq2: 60, dur: 0.42, type: 'sawtooth', gain: 0.22, pan });
        this._noise({ dur: 0.28, gain: 0.16, lp: 1400, pan });
        break;
      }
      case 'knock':
        this._tone({ freq: 160, freq2: 90, dur: 0.14, type: 'square', gain: 0.12, pan });
        break;
      case 'crescent':
        this._tone({ freq: 1800, freq2: 900, dur: 0.11, type: 'sine', gain: 0.13, pan });
        break;

      /* ---- 技能：发射类 ---- */
      case 'shoot': {
        if (!this._gate('shoot', now, MIN_GAP.shoot)) return;
        const isBeam = e.tag === 'laser' || e.tag === 'cannon';
        if (isBeam) {
          this._tone({ freq: 900, freq2: 2200, dur: 0.16, type: 'sawtooth', gain: 0.15, pan });
        } else if (e.tag === 'shard') {
          this._tone({ freq: 1200, freq2: 700, dur: 0.08, type: 'sine', gain: 0.09, pan });
        } else {
          this._tone({ freq: 620, freq2: 980, dur: 0.10, type: 'sine', gain: 0.11, pan });
        }
        break;
      }
      case 'projHit': {
        if (!this._gate('projHit', now, MIN_GAP.projHit)) return;
        /* 弹道命中：爆点也要跟着伤害走（比近战脆、比近战轻，免得盖住那一下打击音） */
        const w = hitWeight(e.value);
        this._tone({ freq: 700 - w * 160, freq2: 380 - w * 120, dur: 0.08 + w * 0.06,
          type: 'triangle', gain: 0.10 + w * 0.10, pan });
        this._noise({ dur: 0.04 + w * 0.03, gain: 0.05 + w * 0.05,
          lp: 3200 + w * 1600, hp: 900, pan });
        break;
      }
      case 'projWall':
      case 'projBounce': {
        if (!this._gate(e.type, now, MIN_GAP.projWall)) return;
        this._noise({ dur: 0.05, gain: 0.05, lp: 4000, pan });
        break;
      }

      /* ---- 裁光 ---- */
      case 'moteDrop':
        this._tone({ freq: 420, freq2: 250, dur: 0.07, type: 'sine', gain: 0.07, pan });
        break;
      case 'lineForm':
        this._tone({ freq: 180, freq2: 300, dur: 0.22, type: 'sine', gain: 0.11, pan });
        break;
      case 'lineStage':
      case 'lineAbsorb': {
        /* 阶段越高音越高：一阶一个音，能听出"线在变强" */
        const f = 520 + (Number(e.value) || 1) * 220;
        this._tone({ freq: f, freq2: f * 1.5, dur: 0.13, type: 'triangle', gain: 0.13, pan });
        break;
      }
      case 'lineBoom':
        this._noise({ dur: 0.34, gain: 0.26, lp: 2200, pan });
        this._tone({ freq: 130, freq2: 55, dur: 0.30, type: 'sawtooth', gain: 0.18, pan });
        break;

      /* ---- 状态类 ---- */
      case 'bloom':
        /* 开华是对局里最重要的瞬间：来一个上行的三音，听得出来"升级了" */
        this._arp([523, 659, 784, 1047], 0.075, 0.16, 'triangle', pan);
        break;
      case 'stealth':
        this._tone({ freq: 900, freq2: 300, dur: 0.22, type: 'sine', gain: 0.09, pan });
        break;
      case 'dodge':
        this._tone({ freq: 1500, freq2: 2600, dur: 0.08, type: 'sine', gain: 0.10, pan });
        break;
      case 'summon':
      case 'xiguangSplit':
        this._arp([392, 523, 659], 0.06, 0.13, 'sine', pan);
        break;
      case 'gateSpawn':
        this._arp([784, 1047], 0.07, 0.12, 'sine', pan);
        break;
      case 'gateSplit':
        this._arp([880, 1109, 1319, 1760], 0.05, 0.11, 'triangle', pan);
        break;
      case 'hpCost':
        this._tone({ freq: 260, freq2: 150, dur: 0.16, type: 'sine', gain: 0.10, pan });
        break;
      case 'respawn':
        this._arp([392, 587], 0.08, 0.12, 'sine', pan);
        break;

      /* ---- 场地与结算 ---- */
      case 'wall': {
        if (!this._gate('wall', now, MIN_GAP.wall)) return;
        this._tone({ freq: 150, dur: 0.05, type: 'square', gain: 0.06, pan });
        break;
      }
      case 'bounce': {
        if (!this._gate('bounce', now, MIN_GAP.bounce)) return;
        this._tone({ freq: 320, dur: 0.045, type: 'sine', gain: 0.05, pan });
        break;
      }
      case 'end':
        this._arp([523, 659, 784], 0.12, 0.22, 'triangle', pan);
        break;
      default:
        break;    // 没配音的事件（domainOn / fieldEnd 等）静默处理
    }
  }

  /* ---------- 内部：发声原语 ---------- */

  /** 同一类声音的最小间隔闸门 */
  _gate(key, now, ms) {
    const last = this._last[key] || 0;
    if (now - last < ms / 1000) return false;
    this._last[key] = now;
    return true;
  }

  /** 声场定位：按 x 坐标左右分布。场地范围会缓存，不必每帧算 */
  _pan(e, battle) {
    if (!battle) return 0;
    try {
      if (this._boxFor !== battle) {
        this._boxFor = battle;
        const b = arenaBounds(battle.shape());
        this._box = { min: b.minX, w: Math.max(1, b.maxX - b.minX) };
      }
      const x = (e.bx || e.px || e.ax || 0);
      return clamp(((x - this._box.min) / this._box.w) * 2 - 1, -1, 1) * 0.7;
    } catch (err) {
      return 0;
    }
  }

  _voice(dur) {
    const t = this.ctx ? this.ctx.currentTime : 0;
    this._active.push(t + Math.max(0.02, dur));
  }

  /** 单个音：振荡器 + 指数衰减包络 */
  _tone({ freq, freq2, dur = 0.12, type = 'sine', gain = 0.2, pan = 0, delay = 0 }) {
    const ctx = this.ctx;
    if (!ctx || this._voicesNow() >= MAX_VOICES) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freq2 && freq2 !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq2), t0 + dur);
    /* 2ms 起音避免"啪"的爆音，然后指数衰减到静音 */
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    this._connect(g, pan);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    this._voice(dur + (delay || 0));
  }

  /** 噪声：用来做撞击、爆炸这类"没有音高"的声音。
   *  给了 {@code hp} 就再串一级高通，只留高频那一小段 —— 那是"脆"的打击瞬态。 */
  _noise({ dur = 0.12, gain = 0.12, lp = 3000, hp = 0, pan = 0 }) {
    const ctx = this.ctx;
    if (!ctx || this._voicesNow() >= MAX_VOICES) return;
    if (!this._noiseBuf) {
      const n = Math.floor(ctx.sampleRate * 0.5);
      const buf = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = buf.getChannelData(0);
      /* 固定种子的伪随机：同一次会话里噪声可复现，也免得每次建大数组 */
      let s = 12345;
      for (let i = 0; i < n; i++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        d[i] = (s / 0x3fffffff) - 1;
      }
      this._noiseBuf = buf;
    }
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = lp;
    /* 可选的高通：低通 + 高通叠起来就是一段带通，打出来是"啪"而不是"噗" */
    let tail = filt;
    if (hp > 0) {
      const hpF = ctx.createBiquadFilter();
      hpF.type = 'highpass';
      hpF.frequency.value = hp;
      filt.connect(hpF);
      tail = hpF;
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt); tail.connect(g);
    this._connect(g, pan);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
    this._voice(dur);
  }

  /** 打击音：三层叠出来的"手感" —— 作者要的"打击感"就是这三样凑出来的
   *    ① 脆 —— 极短的带通噪声，负责"打到了"（没有它听起来像隔着一层布）
   *    ② 实 —— 带下滑音高的三角波，负责"多轻多重"
   *    ③ 沉 —— 60~110Hz 的正弦，负责"胸口那一下"
   *  三层用**同一个权重**放量、放长：伤害越高是整体变强，
   *  而不是只把音量拧大 —— 只拧音量听起来像"同一拳离麦克风更近了"。
   *  轻碰不出第三层（见 HIT_SUB_FLOOR）：低频最占发声名额，而轻碰本就该轻。 */
  _impact(w, pan, base = 300) {
    const k = clamp(w, 0, 1);
    this._noise({ dur: 0.018 + k * 0.022, gain: 0.04 + k * 0.06,
      lp: 5200 + k * 2400, hp: 600, pan });
    /* 本体音高只滑 45%：滑太多会掉进低频层那一带，两层叠起来就"糊"了 */
    const f0 = base * (1 - 0.45 * k);
    this._tone({ freq: f0, freq2: f0 * 0.55,
      dur: 0.08 + k * 0.14, type: 'triangle', gain: 0.09 + k * 0.13, pan });
    if (k >= HIT_SUB_FLOOR) {
      this._tone({ freq: 110 - k * 50, freq2: 55 - k * 12,
        dur: 0.10 + k * 0.20, type: 'sine', gain: 0.04 + k * 0.16, pan });
    }
  }

  /** 琶音：几个音依次响起，用来做"升级/召唤/结算"这类有情绪的瞬间 */
  _arp(freqs, step, dur, type, pan) {
    freqs.forEach((f, i) => {
      this._tone({ freq: f, dur, type, gain: 0.13, pan, delay: i * step });
    });
  }

  _connect(node, pan) {
    const ctx = this.ctx;
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      node.connect(p);
      p.connect(this.master);
    } else {
      node.connect(this.master);
    }
  }
}

/** 事件流按帧号有序，二分找出第一个 f > frame 的下标 */
function lowerBound(events, frame) {
  let lo = 0, hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].f <= frame) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export const audio = new AudioEngine();
export { MAX_STEP_FRAMES, MAX_VOICES, MIN_GAP };

/* 音效逻辑自检
 *
 * 音效没法用耳朵验证（也没有音频文件可对比），所以这里伪装一个
 * AudioContext，把"建了哪些声源、什么频率、多大音量、左右多偏"全部录下来，
 * 再按事件流核对。
 *
 * 重点盯四件容易悄悄坏掉的事：
 *   · 每帧持续伤害（一秒 60 条）有没有被节流 —— 不节流就是噪音墙
 *   · 拖动进度条跳帧时有没有"炸"出一片声音
 *   · 同时发声数有没有上限（每个声音要建 2~3 个节点，堆积会掉帧）
 *   · 关闭音效后是不是真的一声不出
 *
 * 用法：node tests/diag/audio.mjs
 */
import '../lib/test-balls.mjs';   // 测试球夹具（那几个球已从游戏里移除，只给诊断脚本用）
import { Battle } from '../../js/core.js';
import { ARENA_BY_ID } from '../../js/arenas.js';
import { DEFAULT_RULES, SPECIES_BY_ID, makeUnitStats } from '../../js/balls.js';

let pass = 0, fail = 0;
const log = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; log.push(`  ✅ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; log.push(`  ❌ ${name}${detail ? '  — ' + detail : ''}`); }
};

/* ---------- 伪 AudioContext：记录一切发声行为 ---------- */
function makeFakeCtx() {
  const rec = {
    osc: [], noise: 0, pans: [], gains: [],
    sources: 0, maxConcurrent: 0, live: 0,
    filters: [], comps: [],
  };
  const param = (v = 0) => ({
    value: v,
    /* 这是个"记录器"不是忠实的参数模型：真实 Web Audio 里
       setValueAtTime 只是排程、不会立刻改 .value，
       但测试要的正是"排了什么值"，所以这里把它记进 .value。
       hist 保留每一次排程 —— 音量要看**峰值**：我们每个音都是
       "起振 → 峰值 → 衰减到 0.0001"，只看最后的 .value 会全是 0.0001，
       那就永远比不出"谁更响"（踩过）。 */
    hist: [],
    setValueAtTime(x) { this.value = x; this.hist.push(x); return this; },
    linearRampToValueAtTime(x) { this.value = x; this.hist.push(x); return this; },
    exponentialRampToValueAtTime(x) { this.value = x; this.hist.push(x); return this; },
    cancelScheduledValues() { return this; },
  });
  const trackSrc = () => {
    rec.live++; rec.sources++;
    rec.maxConcurrent = Math.max(rec.maxConcurrent, rec.live);
    return () => { rec.live--; };
  };
  const ctx = {
    sampleRate: 48000,
    state: 'running',
    currentTime: 0,
    destination: { connect() {} },
    resume() { this.state = 'running'; },
    /* 注意：只有**真正的声源**（振荡器 / 噪声源）算"同时发声"。
       gain / filter / panner 是配套节点，播完就不可达、会被 GC 回收，
       把它们也算进并发数会得出"堆积了 700 多个节点"的假结论。 */
    createGain() {
      const g = { gain: param(0), connect() {} };
      rec.gains.push(g.gain);
      return g;
    },
    createOscillator() {
      const done = trackSrc();
      const o = {
        type: 'sine',
        /* 记录**每次**排程的频率：只记最后一个值没法判断"起音高低"，
           因为我们的音都是"从 f 滑到 f2"，末值往往相同。 */
        freqSeq: [],
        frequency: {
          get value() { return o.freqSeq.length ? o.freqSeq[o.freqSeq.length - 1] : 440; },
          setValueAtTime(x) { o.freqSeq.push(x); return this; },
          linearRampToValueAtTime(x) { o.freqSeq.push(x); return this; },
          exponentialRampToValueAtTime(x) { o.freqSeq.push(x); return this; },
          cancelScheduledValues() { return this; },
        },
        connect() {},
        start(t) { o._t = t; },
        stop() { done(); },
      };
      rec.osc.push(o);
      return o;
    },
    createBufferSource() {
      const done = trackSrc();
      rec.noise++;
      return { buffer: null, connect() {}, start() {}, stop() { done(); } };
    },
    createBiquadFilter() {
      /* 记下这一级滤波器的类型与截止频率：打击音的"脆"是靠高通做出来的，
         而"沉"是低频音 —— 只数声源个数看不出这两件事有没有真的发生。 */
      const f = { type: 'lowpass', frequency: param(1000), connect() {} };
      rec.filters.push(f);
      return f;
    },
    createDynamicsCompressor() {
      /* 总线软限幅：混战时不让十几下打击叠成爆音（真实浏览器里有这一级） */
      const c = {
        threshold: param(-24), knee: param(30), ratio: param(12),
        attack: param(0.003), release: param(0.25), connect() {},
      };
      rec.comps.push(c);
      return c;
    },
    createStereoPanner() {
      const p = { pan: param(0), connect() {} };
      rec.pans.push(p.pan);
      return p;
    },
    createBuffer(ch, len) {
      return { getChannelData: () => new Float32Array(len) };
    },
  };
  return { ctx, rec };
}

/* ---------- 1) 没有 AudioContext 时必须安全降级 ---------- */
console.log('=========== 音效自检 ===========\n');
console.log('【1】环境不支持时降级');
{
  const saved = globalThis.AudioContext;
  delete globalThis.AudioContext;
  delete globalThis.webkitAudioContext;
  const { AudioEngine } = await import('../../js/audio.js');
  const a = new AudioEngine();
  check('无 AudioContext 时标记为不支持', a.supported === false);
  let threw = null;
  try {
    a.unlock(); a.setEnabled(true); a.playRange({ events: [{ f: 1, type: 'hit' }] }, 0, 1);
    a.silence();
  } catch (e) { threw = e; }
  check('不支持时所有调用都是空操作（不抛错）', !threw, threw ? threw.message : '无异常');
  globalThis.AudioContext = saved;
}

/* ---------- 之后都用伪 AudioContext ---------- */
const { ctx: fakeCtx, rec } = makeFakeCtx();
globalThis.AudioContext = function () { return fakeCtx; };
const { AudioEngine, MAX_VOICES, MAX_STEP_FRAMES, hitWeight, HIT_SOFT, HIT_HARD } =
  await import('../../js/audio.js');

function mk(skills, opts = {}) {
  const stats = (id, sk) => ({ ...makeUnitStats(id), skills: sk });
  return new Battle({
    teams: [
      { units: [{ stats: stats('yuncai', skills) }] },
      { units: [{ stats: stats(opts.foeId || 'test', []) }] },
    ],
    arena: ARENA_BY_ID[opts.arenaId || 'rect'],
    sizeScale: 1,
    rules: { ...DEFAULT_RULES, timeLimit: opts.timeLimit ?? 60 },
    seed: opts.seed ?? 31,
  });
}

/** 按 1× 的速度逐帧推进播放头，和战斗界面的播放循环一致 */
function playback(a, battle, { speed = 1, until = Infinity } = {}) {
  let f = 0;
  const total = Math.min(until, battle.snapshots.length - 1);
  while (f < total) {
    const next = Math.min(total, f + speed);
    fakeCtx.currentTime += (next - f) / 60;
    a.playRange(battle, f, next);
    f = next;
  }
  return f;
}

/* ---------- 2) 主要事件真的会发声 ---------- */
console.log('\n【2】主要事件发声');
{
  const b = mk(['yuncai_caiguang', 'yuncai_modan', 'yuncai_kaihua', 'yuncai_xiguang',
    'yuncai_prism', 'yuncai_domain'], { timeLimit: 40 });
  b.runToEnd();
  const a = new AudioEngine();
  a.unlock();
  a.setEnabled(true);
  a.setVolume(0.6);
  rec.osc.length = 0; rec.noise = 0;
  playback(a, b);

  const types = new Set(b.events.map(e => e.type));
  check('对局里确实有可发声的事件', types.size > 5, `${types.size} 种事件`);
  check('产生了振荡器声源', rec.osc.length > 0, `${rec.osc.length} 个`);
  check('产生了噪声声源（撞击/爆炸类）', rec.noise > 0, `${rec.noise} 个`);
  check('声源总数远少于事件总数（说明确实在按类型发声，不是逐条）',
    rec.osc.length < b.events.length,
    `事件 ${b.events.length} 条 → 声源 ${rec.osc.length + rec.noise} 个`);
}

/* ---------- 3) 每帧持续伤害必须被节流 ---------- */
console.log('\n【3】持续伤害节流');
{
  /* 裁光的质点/细线一秒能出 60 条 tick 事件 */
  const b = mk(['yuncai_caiguang'], { timeLimit: 30 });
  b.runToEnd();
  const ticks = b.events.filter(e => e.type === 'hit' && e.tick).length;
  const a = new AudioEngine();
  a.unlock(); a.setEnabled(true);
  rec.osc.length = 0; rec.noise = 0;
  const t0 = fakeCtx.currentTime;
  playback(a, b);
  const played = rec.osc.length + rec.noise;
  check('本局确实产生了大量持续伤害事件', ticks > 40, `${ticks} 条 tick`);
  check('持续伤害没有逐条发声（被节流）', played < ticks,
    `${ticks} 条 tick → ${played} 个声源`);
  check('节流后仍然听得到"在掉血"（不是完全静音）', played > 0, `${played} 个声源`);
  fakeCtx.currentTime = t0;
}

/* ---------- 4) 拖动进度条不该炸出一片声音 ---------- */
console.log('\n【4】跳帧（拖动进度条）静音');
{
  const b = mk(['yuncai_caiguang', 'yuncai_modan'], { timeLimit: 30 });
  b.runToEnd();
  const a = new AudioEngine();
  a.unlock(); a.setEnabled(true);

  /* 小幅前进 = 正常播放，应当有声 */
  rec.osc.length = 0; rec.noise = 0;
  a.playRange(b, 100, 100 + MAX_STEP_FRAMES);
  const normal = rec.osc.length + rec.noise;
  check(`正常播放（前进 ≤ ${MAX_STEP_FRAMES} 帧）会发声`, normal > 0, `${normal} 个声源`);

  /* 大幅跳跃 = 拖进度条，应当一声不出 */
  rec.osc.length = 0; rec.noise = 0;
  a.playRange(b, 100, 3000);
  check('一次跳过 2900 帧时完全不发声', rec.osc.length + rec.noise === 0,
    `${rec.osc.length + rec.noise} 个声源`);
}

/* ---------- 5) 静音开关 ---------- */
console.log('\n【5】静音开关与音量');
{
  const b = mk(['yuncai_modan'], { timeLimit: 20 });
  b.runToEnd();
  const a = new AudioEngine();
  a.unlock();
  a.setEnabled(false);
  rec.osc.length = 0; rec.noise = 0;
  playback(a, b);
  check('关闭音效后一声不出', rec.osc.length + rec.noise === 0,
    `${rec.osc.length + rec.noise} 个声源`);

  a.setEnabled(true);
  rec.osc.length = 0;
  playback(a, b);
  check('重新打开后又能发声', rec.osc.length + rec.noise > 0,
    `${rec.osc.length + rec.noise} 个声源`);

  /* 音量要真的写进 master gain */
  a.setVolume(0.25);
  check('音量写进了 master gain', Math.abs(a.master.gain.value - 0.25) < 1e-6,
    String(a.master.gain.value));
  a.setVolume(5);
  check('音量被限制在 0~1', a.volume === 1, String(a.volume));
}

/* ---------- 6) 同时发声数上限 ---------- */
console.log('\n【6】同时发声数上限');
{
  /* 造一场极端密集的战斗：4v4 全部晕彩全技能，按 8 倍速推进 */
  const b = new Battle({
    teams: [0, 1].map(() => ({
      units: Array.from({ length: 4 }, () => ({
        stats: { ...makeUnitStats('yuncai'), skills: SPECIES_BY_ID.yuncai.skills },
      })),
    })),
    arena: ARENA_BY_ID.rect, sizeScale: 0.5,
    rules: { ...DEFAULT_RULES, timeLimit: 30 }, seed: 7,
  });
  b.runToEnd();
  const a = new AudioEngine();
  a.unlock(); a.setEnabled(true);
  rec.sources = 0; rec.osc.length = 0; rec.noise = 0;
  playback(a, b, { speed: 8 });
  check('8 倍速下仍在发声（只是被节流）', rec.osc.length + rec.noise > 0,
    `${rec.osc.length + rec.noise} 个声源`);
  check('整局下来引擎自己的发声名额从未超过上限',
    a._peakVoices <= MAX_VOICES, `峰值 ${a._peakVoices} / 上限 ${MAX_VOICES}`);

  /* 直接把时间冻住、连发 40 个声音 —— 这时候名额是真会被占满的，
     验证"超了就丢新的"确实生效（宁可少响一声，也不能让节点堆积）。 */
  const b2 = new AudioEngine();
  b2.unlock(); b2.setEnabled(true);
  fakeCtx.currentTime += 10;          // 换个时间点，避开之前的节流记录
  b2._last = Object.create(null);
  b2._active.length = 0;
  let created = 0;
  for (let i = 0; i < 40; i++) {
    rec.osc.length = 0;
    b2._last = Object.create(null);   // 清节流，只让"名额"这一个因素起作用
    b2.play({ type: 'hit', kind: 'melee', value: 100 }, null);
    if (rec.osc.length) created++;
  }
  check('时间冻住时连发 40 个声音会被名额挡住', created <= MAX_VOICES && created > 0,
    `实际发声 ${created} 次（上限 ${MAX_VOICES}）`);
}

/* ---------- 7) 声场定位 ---------- */
console.log('\n【7】声场定位');
{
  const b = mk(['yuncai_modan'], { timeLimit: 20 });
  b.runToEnd();
  const a = new AudioEngine();
  a.unlock(); a.setEnabled(true);
  rec.pans.length = 0;
  playback(a, b);
  const vals = rec.pans.map(p => p.value);
  check('发声时用到了立体声定位', vals.length > 0, `${vals.length} 次`);
  check('声场范围在 -1 ~ 1 之间', vals.every(v => v >= -1 && v <= 1),
    `范围 ${Math.min(...vals).toFixed(2)} ~ ${Math.max(...vals).toFixed(2)}`);
  const spread = Math.max(...vals) - Math.min(...vals);
  check('左右确实有区分度（不是全挤在中间）', spread > 0.05, `跨度 ${spread.toFixed(2)}`);
}

/* ---------- 8) 关键瞬间的音色区分 ---------- */
console.log('\n【8】关键瞬间的音色区分');
{
  const a = new AudioEngine();
  a.unlock(); a.setEnabled(true);

  const playOne = (ev) => {
    /* 每次发声之间推进一点音频时间 —— 真实播放时时间是流动的，
       声源会自然播完并让出名额；测试里若让时间冻住，
       连着播几个音就会撞上 MAX_VOICES 上限而"后面全哑"。 */
    fakeCtx.currentTime += 0.5;
    rec.osc.length = 0;
    a._last = Object.create(null);          // 清掉节流记录，保证这次一定响
    a.play(ev, null);
    /* 取**起音**频率：我们的音都是"从 f 滑到 f2"，末值往往相同，看不出差别 */
    return rec.osc.map(o => o.freqSeq[0]);
  };

  const hitLight = playOne({ type: 'hit', kind: 'melee', value: 50 });
  const hitHeavy = playOne({ type: 'hit', kind: 'melee', value: 300 });
  check('命中有声音', hitLight.length > 0);
  check('伤害越高音高越低（听得出一击轻重）',
    hitHeavy[0] < hitLight[0], `${hitLight[0]}Hz → ${hitHeavy[0]}Hz`);

  const bloom = playOne({ type: 'bloom' });
  check('开华是多音琶音（对局里最重要的瞬间）', bloom.length >= 3, `${bloom.length} 个音`);
  check('开华的音是上行的',
    bloom.every((f, i) => i === 0 || f > bloom[i - 1]), bloom.map(f => Math.round(f)).join('→'));

  const boom = playOne({ type: 'lineBoom' });
  check('细线爆炸有低音冲击', boom.some(f => f < 200), boom.map(f => Math.round(f)).join(','));

  const stage1 = playOne({ type: 'lineStage', value: 1 });
  const stage2 = playOne({ type: 'lineStage', value: 2 });
  check('细线阶段越高音越高', stage2[0] > stage1[0], `${stage1[0]}Hz → ${stage2[0]}Hz`);

  /* 没配音的事件不该报错 */
  let threw = null;
  try { a.play({ type: 'domainOn' }, null); a.play({ type: 'fieldEnd' }, null); }
  catch (e) { threw = e; }
  check('没配音的事件静默处理（不抛错）', !threw, threw ? threw.message : '无异常');
}

/* ---------- 9) 打击感：伤害越高，反馈越强 ----------
   作者的要求是「增强小球攻击命中时候的打击感（伤害越高反馈越强）」。
   "打击感"在这份实现里是三层声音的合成（脆 / 实 / 沉），
   所以这里不只验"有声音"，而是逐层核对：
     · 权重曲线单调、两端有定义（不然轻碰和重击听不出差别）；
     · 层数随伤害增加（轻碰只有脆 + 实，重击才加低频那一层）；
     · 音高、音量、余音三者都随伤害走（只放大音量听起来像"离麦克风更近"）。 */
console.log('\n【9】打击感（伤害越高反馈越强）');
{
  check('0 伤害的权重是 0', hitWeight(0) === 0, String(hitWeight(0)));
  check(`伤害 ≥ ${HIT_HARD} 时权重拉满到 1`,
    hitWeight(HIT_HARD) === 1 && hitWeight(9999) === 1,
    `${HIT_HARD} → ${hitWeight(HIT_HARD)}`);
  check(`伤害 ≤ ${HIT_SOFT} 时权重仍然很低（轻碰就是轻碰）`,
    hitWeight(HIT_SOFT) < 0.3, `${HIT_SOFT} → ${hitWeight(HIT_SOFT).toFixed(3)}`);
  const seq = [0, 10, 20, 50, 66, 100, 200, 300, 800].map(hitWeight);
  check('权重随伤害单调不减',
    seq.every((v, i) => i === 0 || v >= seq[i - 1] - 1e-9),
    seq.map(v => v.toFixed(2)).join(' ≤ '));
  check('中间几档确实拉开了档次（不是一刀切）',
    hitWeight(66) > 0.3 && hitWeight(200) - hitWeight(66) > 0.2 && hitWeight(200) < 1,
    `66→${hitWeight(66).toFixed(2)}　200→${hitWeight(200).toFixed(2)}`);

  const a = new AudioEngine();
  a.unlock(); a.setEnabled(true);
  check('总线接上了软限幅（混战不削顶爆音）',
    !!a.comp && a.comp.threshold.value === -12,
    a.comp ? `threshold ${a.comp.threshold.value}dB、ratio ${a.comp.ratio.value}` : '没有限幅节点');

  /** 播一条事件，把"这一下"的声源、频率、音量峰值、余音长度全部录下来 */
  const impact = (ev) => {
    fakeCtx.currentTime += 0.5;       // 让上一声自然播完，别撞上发声名额上限
    rec.osc.length = 0; rec.noise = 0; rec.filters.length = 0; rec.gains.length = 0;
    a._last = Object.create(null);
    a._active.length = 0;
    const t0 = fakeCtx.currentTime;
    a.play(ev, null);
    return {
      tones: rec.osc.map(o => ({ f0: o.freqSeq[0], f1: o.freqSeq[o.freqSeq.length - 1] })),
      noises: rec.noise,
      filters: rec.filters.map(f => ({ type: f.type, hz: f.frequency.value })),
      durs: a._active.map(end => end - t0),
      gains: rec.gains.map(g => Math.max(...(g.hist.length ? g.hist : [0]))),
    };
  };
  const loudest = (r) => Math.max(...r.gains, 0);
  const longest = (r) => Math.max(...r.durs, 0);

  const light = impact({ type: 'hit', kind: 'melee', value: 5 });
  const mid = impact({ type: 'hit', kind: 'melee', value: 66 });
  const heavy = impact({ type: 'hit', kind: 'melee', value: 300 });

  check('轻碰只有两层（脆 + 实），不出低频那一层',
    light.tones.length === 1 && light.noises === 1,
    `${light.tones.length} 个音 + ${light.noises} 个噪声`);
  check('中等伤害开始有"沉"的低频层', mid.tones.length === 2, `${mid.tones.length} 个音`);
  check('重击三层全上（脆 + 实 + 沉）',
    heavy.tones.length === 2 && heavy.noises === 1,
    `${heavy.tones.length} 个音 + ${heavy.noises} 个噪声`);
  check('伤害越高音高越低',
    heavy.tones[0].f0 < mid.tones[0].f0 && mid.tones[0].f0 < light.tones[0].f0,
    `${light.tones[0].f0.toFixed(0)} → ${mid.tones[0].f0.toFixed(0)} → ${heavy.tones[0].f0.toFixed(0)} Hz`);
  check('伤害越高音量越大',
    loudest(heavy) > loudest(mid) && loudest(mid) > loudest(light),
    `${loudest(light).toFixed(3)} → ${loudest(mid).toFixed(3)} → ${loudest(heavy).toFixed(3)}`);
  check('伤害越高余音越长',
    longest(heavy) > longest(mid) && longest(mid) > longest(light),
    `${(longest(light) * 1000).toFixed(0)} → ${(longest(mid) * 1000).toFixed(0)} → ${(longest(heavy) * 1000).toFixed(0)} ms`);
  check('"脆"的那一下真的做了高通（低通 + 高通 = 带通）',
    heavy.filters.some(f => f.type === 'highpass' && f.hz >= 400),
    heavy.filters.map(f => `${f.type}@${f.hz}`).join(', '));
  check('低频层落在 110Hz 以下（是"沉"，不是"闷"）',
    heavy.tones.some(t => t.f0 <= 110),
    heavy.tones.map(t => t.f0.toFixed(0)).join(' / ') + ' Hz');
  check('本体音高不会滑进低频层那一带（两层不打架）',
    heavy.tones[0].f0 > 110 && heavy.tones[0].f1 > 40,
    `本体 ${heavy.tones[0].f0.toFixed(0)} → ${heavy.tones[0].f1.toFixed(0)} Hz`);

  /* 弹道命中也要跟着伤害走（它是另一条事件，容易只顾了近战那一条） */
  const shotLight = impact({ type: 'projHit', value: 10 });
  const shotHeavy = impact({ type: 'projHit', value: 300 });
  check('弹道命中同样"伤害越高越重"',
    shotHeavy.tones[0].f0 < shotLight.tones[0].f0 && loudest(shotHeavy) > loudest(shotLight),
    `${shotLight.tones[0].f0.toFixed(0)}Hz/${loudest(shotLight).toFixed(3)} → ${shotHeavy.tones[0].f0.toFixed(0)}Hz/${loudest(shotHeavy).toFixed(3)}`);
  check('弹道命中比近战更脆（音高更高）',
    shotHeavy.tones[0].f0 > heavy.tones[0].f0,
    `近战 ${heavy.tones[0].f0.toFixed(0)}Hz vs 弹道 ${shotHeavy.tones[0].f0.toFixed(0)}Hz`);

  /* 每帧持续伤害（tick）不能变成"每下都重击"：它走的是单独的分支 */
  const tick = impact({ type: 'hit', tick: true, value: 300 });
  check('每帧持续伤害不走打击音那一套（伤害再高也只有一个轻音）',
    tick.tones.length === 1 && tick.noises === 0 && loudest(tick) < 0.1,
    `${tick.tones.length} 个音、峰值 ${loudest(tick).toFixed(3)}`);
}

console.log('\n' + log.join('\n'));
console.log(`\n=========== 通过 ${pass} 项，失败 ${fail} 项 ===========`);
process.exit(fail ? 1 : 0);

/* ============================================================
   test-balls.mjs — **只给诊断脚本用**的测试球夹具
   ------------------------------------------------------------
   作者 2026-10 的要求：「删去除了晕彩、缇娜、桃夭之外的所有测试用小球」
   （另外新增一个演示用的「木桩」）。

   于是游戏里只剩 4 个球：晕彩 / 桃夭 / 缇娜 / 木桩。
   但二十多个诊断脚本一直拿"测试球"当**参照物**：
     · `test`        —— 1000 血 / 速度 120 / 碰撞 100，纯物理类断言全靠它；
     · `test_skill`  —— 带「定点射击 50」与「蓄力冲刺 200」，用来验技能链路；
     · `test_charge` / `test_lowhp` / `test_heavy` —— 资源条、脆皮、体型推挤。
   这些数（50 / 200 / 100）还被 `skill3.mjs` 写死当守卫。
   如果把它们从游戏里删掉的同时也删掉夹具，这些脚本要么报错、要么
   **悄悄回落到默认球种**（`makeUnitStats` 对认不出的 id 有兜底），
   后者更糟：断言会"通过"，但测的已经不是它以为的东西了。

   所以：**球种从游戏里搬到这里**。诊断脚本 import 本文件（只为了副作用），
   夹具就把这几个球注册进 `SPECIES` 与 `SPECIES_BY_ID`。
   这样两边都干净：
     · 玩家/作者看到的是 4 个球（图鉴、准备界面、编辑器都只列这 4 个）；
     · 诊断脚本显式声明"我要用夹具球"，不再偷偷依赖游戏内容。

   ⚠ 本文件**只放测试球**。正式角色（晕彩/桃夭/缇娜）与木桩都在 `js/balls.js`，
     诊断脚本要用真实角色就直接用真实 id。
   ============================================================ */

import { SPECIES, SPECIES_BY_ID } from '../../js/balls.js';

/** 与当年 `js/balls.js` 里那几颗**逐字一致** —— 改了数就等于改了所有断言的口径。
 *  （这也是把它们搬出来而不是"重新设计一套测试球"的原因。） */
export const TEST_BALLS = [
  {
    id: 'test_skill',
    name: '测试球·技能型',
    color: '#c084fc',
    hp: 1000,
    r: 16,
    speed: 120,
    melee: 100,
    reach: 0,
    desc: '用来验证技能机制的测试球，带两个技能：' +
      '① 每 2.5 秒自动瞄准对手发射一枚攻击力 50 的特效小球；' +
      '② 撞到场地边界时停止移动，蓄力 2 秒后加速冲向对手（加速期间碰撞伤害 200，并把对手推远）。',
    tags: ['测试', '技能'],
    image: null,
    sticker: null,
    resource: null,
    skills: ['test_shot', 'test_dash'],
  },
  {
    id: 'test',
    name: '测试球',
    color: '#8a94a6',
    hp: 1000,
    r: 16,
    speed: 120,
    melee: 100,          // 碰撞造成 100 伤害
    reach: 0,
    desc: '框架验证用的空白小球：无技能、1000 点生命、贴身碰撞造成 100 点伤害。',
    tags: ['测试'],
    image: null,
    sticker: null,
    resource: null,
    skills: [],
  },
  {
    id: 'test_charge',
    name: '测试球·蓄能型',
    color: '#6d8cff',
    hp: 1000,
    r: 16,
    speed: 120,
    melee: 100,
    reach: 0,
    desc: '与测试球数值完全相同，但带一条「蓄能」资源条，用于验证特殊资源的显示与积攒逻辑。',
    tags: ['测试', '资源'],
    image: null,
    sticker: null,
    resource: {
      id: 'charge',
      name: '蓄能',
      max: 100,
      init: 0,
      gainPerSec: 12,
      gainOnHit: 6,
      color: '#4f7cff',
    },
    skills: [],
  },
  {
    id: 'test_lowhp',
    name: '测试球·脆皮型',
    color: '#e0a03a',
    hp: 400,
    r: 13,
    speed: 150,
    melee: 100,
    reach: 0,
    desc: '生命只有 400 但速度更快，用于验证不同体型/血量在混战中的表现差异。',
    tags: ['测试'],
    image: null,
    sticker: null,
    resource: null,
    skills: [],
  },
  {
    id: 'test_heavy',
    name: '测试球·重装型',
    color: '#3f8f7f',
    hp: 1600,
    r: 21,
    speed: 88,
    melee: 100,
    reach: 0,
    desc: '生命 1600、体型更大、移动更慢，用于验证体积与推挤手感。',
    tags: ['测试'],
    image: null,
    sticker: null,
    resource: null,
    skills: [],
  },
];

/** 注册（幂等：同一个进程里 import 两次不会装两遍） */
export function registerTestBalls() {
  for (const sp of TEST_BALLS) {
    if (SPECIES_BY_ID[sp.id]) continue;
    SPECIES.push(sp);
    SPECIES_BY_ID[sp.id] = sp;
  }
  return TEST_BALLS.map(s => s.id);
}

/* import 本文件即注册 —— 诊断脚本只需要写一行 import。 */
registerTestBalls();

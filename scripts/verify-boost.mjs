// 「按住方向键临时加速」的确定性验证。
//
// 为什么不用浏览器跑：这套行为的几个关键点（阈值、松手的归属、恢复目标、
// 档位与速率）全部与**时间**有关，而在真实浏览器里做毫秒级断言既慢又不稳；
// headless 下媒体元素还会因为自动播放策略停在 paused，导致「只在播放中加速」
// 这条前提永远不成立、测出来一律是「没反应」。
// 这里用假时钟 + 假 video 直接验状态机本身，浏览器那边只做连通性检查。
//
// 运行：npm run verify:boost

import {
  BOOST_LEVELS,
  DEFAULT_BOOST_LEVEL,
  createBoostController,
  cycleBoostLevel,
  levelLabel,
  levelRate,
  smartBoostRate,
} from '../src/services/boostController.ts';

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass += 1;
  else fail += 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  期望=' + JSON.stringify(expected) + ' 实际=' + JSON.stringify(actual)));
}

/** 假时钟：只有调用 tick() 才推进，杜绝真实定时器的抖动。 */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const jobs = new Map();
  return {
    now: () => now,
    setTimer(handler, ms) {
      const id = nextId += 1;
      jobs.set(id, { at: now + ms, handler });
      return id;
    },
    clearTimer(id) {
      jobs.delete(id);
    },
    tick(ms) {
      now += ms;
      for (const [id, job] of Array.from(jobs)) {
        if (job.at <= now) {
          jobs.delete(id);
          job.handler();
        }
      }
    },
    pending: () => jobs.size,
  };
}

function harness({ paused = false, baseRate = 1, duration = 120 } = {}) {
  const clock = fakeClock();
  const video = { paused, playbackRate: baseRate, duration };
  let base = baseRate;
  const notices = [];
  const controller = createBoostController({
    getVideo: () => video,
    getBaseRate: () => base,
    onChange: (boosting, rate, level) => notices.push({ boosting, rate, level }),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, video, controller, notices, setBase: (v) => { base = v; } };
}

const last = (list) => list[list.length - 1];

// 0) 档位表本身：顺序就是滚轮顺序，且首档（长按起点）是「智能」。
check('档位表顺序（决定滚轮邻居）', BOOST_LEVELS, ['smart', 1.5, 2, 3]);
check('长按起点固定为智能档', DEFAULT_BOOST_LEVEL, 'smart');
check('智能档在 UI 上就叫"智能"', levelLabel('smart'), '智能');
check('固定档位显示为 NX（大写，与提示条一致）', levelLabel(1.5), '1.5X');

// 1) 智能档按时长选速率；时长不可知时保守取 2。
check('智能档：10 分钟以内 → 3x', smartBoostRate(120), 3);
check('智能档：10 分钟整 → 3x（含边界）', smartBoostRate(600), 3);
check('智能档：刚过 10 分钟 → 2x', smartBoostRate(601), 2);
check('智能档：30 分钟整 → 2x（含边界）', smartBoostRate(1800), 2);
check('智能档：刚过 30 分钟 → 1.5x', smartBoostRate(1801), 1.5);
check('智能档：时长未知（NaN）→ 2x', smartBoostRate(NaN), 2);
check('智能档：时长 0 → 2x', smartBoostRate(0), 2);
check('固定档位不受时长影响', levelRate(2, 60), 2);

// 2) 换档是环形的：智能的上邻是 3x、下邻是 1.5x（与红果的滚轮一致）。
check('智能档按上一档 → 3x（环形回绕）', cycleBoostLevel('smart', -1), 3);
check('智能档按下一档 → 1.5x', cycleBoostLevel('smart', 1), 1.5);
check('3x 按下一档 → 回到智能', cycleBoostLevel(3, 1), 'smart');
check('多按几档仍然回到自己', cycleBoostLevel('smart', 4), 'smart');

// 3) 短按（不到阈值）不加速，且这次按下算一次快退/快进。
{
  const { clock, video, controller } = harness();
  controller.press();
  clock.tick(120);
  const shouldSeek = controller.release();
  check('短按 120ms：倍速不变', video.playbackRate, 1);
  check('短按 120ms：归还给快进/快退', shouldSeek, true);
}

// 4) 长按超过阈值：进入加速，起点是智能档（2 分钟的片子 → 3x）。
{
  const { clock, video, controller } = harness();
  controller.press();
  clock.tick(400);
  check('长按 400ms：按智能档加速到 3x', video.playbackRate, 3);
  check('长按 400ms：处于加速态', controller.isBoosting(), true);
  check('长按 400ms：档位是智能', controller.getLevel(), 'smart');
}

// 5) 加速生效后松手：恢复原速，且这次按下不再跳转。
{
  const { clock, video, controller } = harness({ baseRate: 1.25 });
  controller.press();
  clock.tick(400);
  const shouldSeek = controller.release();
  check('加速后松手：回到基准倍速 1.25x（不是 1x）', video.playbackRate, 1.25);
  check('加速后松手：不再跳转', shouldSeek, false);
  check('加速后松手：退出加速态', controller.isBoosting(), false);
}

// 6) 加速期间 ↑ / ↓ 换档，且速率立刻跟着变。
{
  const { clock, video, controller } = harness();
  controller.press();
  clock.tick(400);
  check('起点：智能档 = 3x', video.playbackRate, 3);
  controller.cycleLevel(1);
  check('按下一档：1.5x', video.playbackRate, 1.5);
  check('按下一档：档位记录同步', controller.getLevel(), 1.5);
  controller.cycleLevel(1);
  check('再下一档：2x', video.playbackRate, 2);
  controller.cycleLevel(-1);
  check('按上一档：回到 1.5x', video.playbackRate, 1.5);
  controller.cycleLevel(-1);
  check('按上一档：回到智能档', controller.getLevel(), 'smart');
  controller.cycleLevel(-1);
  check('再按上一档：环形绕到 3x', controller.getLevel(), 3);
  check('环形绕到 3x 的速率也是 3x', video.playbackRate, 3);
  controller.cycleLevel(1);
  check('从 3x 按下一档：环形回到智能', controller.getLevel(), 'smart');
}

// 7) 长片（>30 分钟）时智能档只给 1.5x：不能把 1.5x 的档位写死成 3x。
{
  const { clock, video, controller } = harness({ duration: 3600 });
  controller.press();
  clock.tick(400);
  check('长片：智能档 = 1.5x', video.playbackRate, 1.5);
}

// 8) 「加速」不该反而降速：基准 3x 时切到 1.5x 档仍是 3x。
{
  const { clock, video, controller, notices } = harness({ baseRate: 3 });
  controller.press();
  clock.tick(400);
  check('基准 3x + 智能档：保持 3x', video.playbackRate, 3);
  controller.cycleLevel(1);
  check('基准 3x + 1.5x 档：不降到 1.5x', video.playbackRate, 3);
  check('基准 3x：回调给出的是真实生效的速率', last(notices).rate, 3);
  controller.release();
  check('基准 3x：松手仍回到 3x', video.playbackRate, 3);
}

// 9) 每次长按都从默认档重新起步（不记住上次档位）。
{
  const { clock, video, controller } = harness();
  controller.press();
  clock.tick(400);
  controller.cycleLevel(1);
  controller.cycleLevel(1);
  check('本次长按：已切到 2x', video.playbackRate, 2);
  controller.release();
  controller.press();
  clock.tick(400);
  check('下一次长按：重新从智能档起步', controller.getLevel(), 'smart');
  check('下一次长按：速率回到智能档的 3x', video.playbackRate, 3);
}

// 10) 未加速时换档是空操作（↑ / ↓ 那时候属于音量键，不该偷偷改档位）。
{
  const { controller } = harness();
  controller.cycleLevel(1);
  check('未加速：换档无效', controller.getLevel(), 'smart');
}

// 11) 暂停中长按不加速，但松手仍是一次快退/快进（用户是在找位置）。
{
  const { clock, video, controller } = harness({ paused: true });
  controller.press();
  clock.tick(400);
  const shouldSeek = controller.release();
  check('暂停中长按：不加速', video.playbackRate, 1);
  check('暂停中长按：松手仍算跳转', shouldSeek, true);
}

// 12) cancel（失焦 / Esc / 卸载）必须收掉定时器与加速态，不留悬空任务。
{
  const { clock, video, controller } = harness();
  controller.press();
  controller.cancel();
  check('cancel 后：无挂起定时器', clock.pending(), 0);
  clock.tick(500);
  check('cancel 后：即使时间推进也不加速', video.playbackRate, 1);
}

{
  const { clock, video, controller } = harness();
  controller.press();
  clock.tick(400);
  controller.cancel();
  check('加速中 cancel：立即恢复基准倍速', video.playbackRate, 1);
  check('加速中 cancel：定时器已清', clock.pending(), 0);
  check('加速中 cancel：退出加速态', controller.isBoosting(), false);
}

// 13) 连续按下只留一个定时器（异常重复按下不应叠加）。
{
  const { clock, video, controller } = harness();
  controller.press();
  clock.tick(200);
  controller.press();
  clock.tick(200);
  check('重复按下：尚未加速（定时器被重置）', video.playbackRate, 1);
  clock.tick(200);
  check('重复按下后再等满阈值：加速', video.playbackRate, 3);
  check('重复按下：只留一个定时器', clock.pending(), 0);
}

// 14) 视频元素尚未挂载（切集/退出播放器）时不崩、不加速。
{
  const clock = fakeClock();
  const controller = createBoostController({
    getVideo: () => null,
    getBaseRate: () => 1,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  controller.press();
  clock.tick(400);
  const shouldSeek = controller.release();
  check('无 video：不抛异常且视为未加速', shouldSeek, true);
}

// 15) 用户倍速在按住期间被改动：恢复目标取最新值（getBaseRate 用函数的原因）。
{
  const { clock, video, controller, setBase } = harness();
  controller.press();
  clock.tick(400);
  setBase(2);
  controller.release();
  check('按住期间改倍速：恢复到最新的 2x', video.playbackRate, 2);
}

// 16) 提示回调：进入 / 换档 / 退出都带上真实速率与档位，UI 不需要自己再算一遍。
{
  const { clock, controller, notices } = harness({ baseRate: 1.25 });
  controller.press();
  clock.tick(400);
  controller.cycleLevel(1);
  controller.release();
  check('回调序列：进入(智能 3x) → 换档(1.5x) → 退出(回到基准)', notices, [
    { boosting: true, rate: 3, level: 'smart' },
    { boosting: true, rate: 1.5, level: 1.5 },
    { boosting: false, rate: 1.25, level: 1.5 },
  ]);
}

// 17) 短按不应触发任何提示（一次普通快进不该闪出加速提示）。
{
  const { clock, controller, notices } = harness();
  controller.press();
  clock.tick(100);
  controller.release();
  check('短按：不触发加速提示', notices, []);
}

// 18) 换集必须结束加速，且倍速回到基准。
//
// 这是 0.2.25 修的那个 bug：长按加速时切下一集，`openEpisode` 会把
// `video.playbackRate` 重置成基准倍速（新一集不该继承上一集的临时加速），
// 但加速控制器不自知 —— `boosting` 仍是 true、提示条留在画面上。
// `useBoostKeys` 现在把「会话号变化」翻译成一次 `cancel()`。
//
// 这里直接验 `cancel()` 的语义：它必须同时（a）写回基准倍速、
// （b）发出 boosting=false 的回调，两者缺一都会让 UI 与实际脱钩。
{
  const { clock, controller, notices, video } = harness({ baseRate: 1 });
  controller.press();
  clock.tick(400);
  check('换集前：处于加速', controller.isBoosting(), true);
  check('换集前：倍速已被提高', video.playbackRate, 3);

  // 模拟 useBoostKeys 在会话号变化时调的那一次 cancel()。
  controller.cancel();

  check('换集后：不再处于加速', controller.isBoosting(), false);
  check('换集后：倍速回到基准', video.playbackRate, 1);
  check('换集后：发出退出回调（提示条据此消失）', notices.at(-1), {
    boosting: false,
    rate: 1,
    level: 'smart',
  });
}

// 19) 未加速时 cancel() 必须是空操作。
//
// `useBoostKeys` 的会话 effect 在换集时无条件调一次 cancel()。如果 cancel()
// 在未加速时也写 playbackRate，那么「用户设了 1.25x、换集」就会被写回……
// 恰好也是 1.25x（基准），看起来无害。但若用户在换集瞬间正把倍速从 2x 改到
// 1.25x，这个写入会用**旧闭包里的基准值**覆盖新值。空操作才是安全的。
{
  const { controller, notices } = harness({ baseRate: 1.25 });
  controller.cancel();
  check('未加速时 cancel：不产生任何回调', notices, []);
  check('未加速时 cancel：仍不处于加速', controller.isBoosting(), false);
}

console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);

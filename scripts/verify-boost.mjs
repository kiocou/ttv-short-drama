// 「按住方向键临时加速」的确定性验证。
//
// 为什么不用浏览器跑：这套行为的几个关键点（阈值、松手的归属、恢复目标、
// 速率是固定值而与所选档位无关）全部与**时间**有关，而在真实浏览器里做毫秒级
// 断言既慢又不稳；headless 下媒体元素还会因为自动播放策略停在 paused，导致
// 「只在播放中加速」这条前提永远不成立、测出来一律是「没反应」。
// 这里用假时钟 + 假 video 直接验状态机本身，浏览器那边只做连通性检查。
//
// 运行：npm run verify:boost

import { BOOST_RATE, createBoostController } from '../src/services/boostController.ts';

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

function harness({ paused = false, baseRate = 1 } = {}) {
  const clock = fakeClock();
  const video = { paused, playbackRate: baseRate };
  let base = baseRate;
  const notices = [];
  const controller = createBoostController({
    getVideo: () => video,
    getBaseRate: () => base,
    onChange: (boosting, rate) => notices.push({ boosting, rate }),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, video, controller, notices, setBase: (v) => { base = v; } };
}

// 0) 速率常量本身：用户要求固定 2 倍。
check('BOOST_RATE 固定为 2', BOOST_RATE, 2);

// 1) 短按（不到阈值）不加速，且这次按下算一次快退/快进。
{
  const { clock, video, controller } = harness();
  controller.press();
  clock.tick(120);
  const shouldSeek = controller.release();
  check('短按 120ms：倍速不变', video.playbackRate, 1);
  check('短按 120ms：归还给快进/快退', shouldSeek, true);
}

// 2) 长按（超过阈值）加速到 2x。
{
  const { clock, video, controller } = harness();
  controller.press();
  clock.tick(400);
  check('长按 400ms：固定加速到 2x', video.playbackRate, 2);
  check('长按 400ms：处于加速态', controller.isBoosting(), true);
}

// 3) 加速生效后松手：恢复原速，且这次按下不再跳转。
{
  const { clock, video, controller } = harness();
  controller.press();
  clock.tick(400);
  const shouldSeek = controller.release();
  check('加速后松手：倍速回到 1', video.playbackRate, 1);
  check('加速后松手：不再跳转', shouldSeek, false);
  check('加速后松手：退出加速态', controller.isBoosting(), false);
}

// 4) **加速速率与所选档位无关**：这是用户明确要求的行为（固定 2x，不是「档位 × N」）。
//    基准低于 2x 时一律加速到 2x；松手一律回到用户自己的档位。
for (const base of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
  const { clock, video, controller } = harness({ baseRate: base });
  controller.press();
  clock.tick(400);
  check(`基准 ${base}x：长按固定加速到 2x`, video.playbackRate, 2);
  controller.release();
  check(`基准 ${base}x：松手回到 ${base}x（不是 1x）`, video.playbackRate, base);
}

// 5) 基准已经是 3x（比加速值还快）时，长按不应把它**降**到 2x。
//    这是固定速率方案特有的边界：旧版「档位 × N」不会遇到，因为结果总是更高。
{
  const { clock, video, controller, notices } = harness({ baseRate: 3 });
  controller.press();
  clock.tick(400);
  check('基准 3x：长按不降速，仍是 3x', video.playbackRate, 3);
  check('基准 3x：不弹出加速提示（没有加速）', notices, []);
  check('基准 3x：不处于加速态', controller.isBoosting(), false);
}

// 6) 暂停中长按不加速，但松手仍是一次快退/快进（用户是在找位置）。
{
  const { clock, video, controller } = harness({ paused: true });
  controller.press();
  clock.tick(400);
  const shouldSeek = controller.release();
  check('暂停中长按：不加速', video.playbackRate, 1);
  check('暂停中长按：松手仍算跳转', shouldSeek, true);
}

// 7) cancel（失焦 / Esc / 卸载）必须收掉定时器与加速态，不留悬空任务。
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
  check('加速中 cancel：立即恢复', video.playbackRate, 1);
  check('加速中 cancel：定时器已清', clock.pending(), 0);
}

// 8) 连续按下只留一个定时器（异常重复按下不应叠加）。
{
  const { clock, video, controller } = harness();
  controller.press();
  clock.tick(200);
  controller.press();
  clock.tick(200);
  check('重复按下：尚未加速（定时器被重置）', video.playbackRate, 1);
  clock.tick(200);
  check('重复按下后再等满阈值：加速', video.playbackRate, 2);
  check('重复按下：只留一个定时器', clock.pending(), 0);
}

// 9) 视频元素尚未挂载（切集/退出播放器）时不崩、不加速。
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

// 10) 用户倍速在按住期间被改动：恢复目标取最新值（getBaseRate 用函数的原因）。
{
  const { clock, video, controller, setBase } = harness();
  controller.press();
  clock.tick(400);
  setBase(2);
  controller.release();
  check('按住期间改倍速：恢复到最新的 2x', video.playbackRate, 2);
}

// 11) 提示回调：进入与退出各一次，加速速率恒为 2。
{
  const { clock, controller, notices } = harness({ baseRate: 1.25 });
  controller.press();
  clock.tick(400);
  controller.release();
  check('提示回调：加速速率恒为 2', notices, [{ boosting: true, rate: 2 }, { boosting: false, rate: 1.25 }]);
}

// 12) 短按不应触发任何提示（一次普通快进不该闪出加速提示）。
{
  const { clock, controller, notices } = harness();
  controller.press();
  clock.tick(100);
  controller.release();
  check('短按：不触发加速提示', notices, []);
}

console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);

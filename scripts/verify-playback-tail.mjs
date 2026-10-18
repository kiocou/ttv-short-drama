// 验证“缓冲到结尾”判定不会把倍速切换/短暂抖动误当成播完。
//
// 运行：npm run verify:tail

import { shouldFinishAtBufferedTail } from '../src/services/playbackTail.ts';

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass += 1;
  else fail += 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  期望=' + JSON.stringify(expected) + ' 实际=' + JSON.stringify(actual)));
}

const base = {
  currentTime: 98.6,
  duration: 100,
  bufferedEnd: 98.6,
  paused: false,
  seeking: false,
};

check('最后一小段未落地、播放头追上缓冲末端：按播完处理', shouldFinishAtBufferedTail(base), true);
check('数据已完整缓冲，只是切换倍速短暂 waiting：不能按播完处理', shouldFinishAtBufferedTail({
  ...base,
  bufferedEnd: 100,
}), false);
check('播放头还没追上缓冲末端：先继续等数据', shouldFinishAtBufferedTail({
  ...base,
  currentTime: 98.2,
}), false);
check('中段卡在缓冲末端：不能按播完处理', shouldFinishAtBufferedTail({
  ...base,
  currentTime: 30,
  bufferedEnd: 30,
}), false);
check('正在 seek：不能按播完处理', shouldFinishAtBufferedTail({
  ...base,
  seeking: true,
}), false);
check('已暂停：不能按播完处理', shouldFinishAtBufferedTail({
  ...base,
  paused: true,
}), false);
check('时长未知：不能按播完处理', shouldFinishAtBufferedTail({
  ...base,
  duration: 0,
}), false);
check('没有缓冲信息：不能按播完处理', shouldFinishAtBufferedTail({
  ...base,
  bufferedEnd: 0,
}), false);

console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);

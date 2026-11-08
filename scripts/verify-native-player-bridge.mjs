import assert from 'node:assert/strict';
import { normalizeNativePlayerState, readNativePlayerPort } from '../src/services/nativePlayerBridge.ts';

let checks = 0;
function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name);
  checks += 1;
  console.log(`PASS ${name}`);
}

check('reads a valid local control port', readNativePlayerPort('?controlPort=49152'), 49152);
check('rejects a missing control port', readNativePlayerPort(''), null);
check('rejects port zero', readNativePlayerPort('?controlPort=0'), null);
check('rejects values outside the TCP port range', readNativePlayerPort('?controlPort=65536'), null);
check('rejects non-numeric control ports', readNativePlayerPort('?controlPort=abc'), null);

const state = {
  playing: true,
  pos: 1.25,
  dur: 60,
  volume: 75,
  speed: 1,
  fg: true,
  mult: 2,
  fullscreen: false,
  title: '窗口合成验证',
  ep: 3,
};
check('normalizes the complete native state', normalizeNativePlayerState(state), {
  playing: true,
  position: 1.25,
  duration: 60,
  volume: 75,
  speed: 1,
  frameInterpolation: true,
  frameMultiplier: 2,
  fullscreen: false,
  title: '窗口合成验证',
  episode: 3,
});
check('rejects incomplete native state', normalizeNativePlayerState({ playing: true }), null);
check('rejects non-finite playback positions', normalizeNativePlayerState({ ...state, pos: null }), null);

console.log(`${checks} passed, 0 failed`);

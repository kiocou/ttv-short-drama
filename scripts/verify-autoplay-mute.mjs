import assert from 'node:assert/strict';
import { retryMutedAutoplay } from '../src/services/playbackStart.ts';

let preferenceUpdates = 0;
const blockedVideo = { muted: false };
const blocked = await retryMutedAutoplay(
  blockedVideo,
  () => Promise.reject(new DOMException('gesture required', 'NotAllowedError')),
  () => { preferenceUpdates += 1; },
);
assert.equal(blocked, false);
assert.equal(blockedVideo.muted, true);
assert.equal(preferenceUpdates, 0, 'A rejected silent retry must not overwrite the saved mute preference');

const allowedVideo = { muted: false };
const startedMuted = await retryMutedAutoplay(
  allowedVideo,
  () => Promise.resolve(),
  () => { preferenceUpdates += 1; },
);
assert.equal(startedMuted, true);
assert.equal(allowedVideo.muted, true);
assert.equal(preferenceUpdates, 1, 'A successful silent retry must update the player mute state');

let playCalls = 0;
const alreadyMuted = await retryMutedAutoplay(
  { muted: true },
  () => { playCalls += 1; return Promise.resolve(); },
  () => { preferenceUpdates += 1; },
);
assert.equal(alreadyMuted, false);
assert.equal(playCalls, 0, 'An already-muted video must not retry autoplay');
assert.equal(preferenceUpdates, 1);

console.log('3 passed, 0 failed');

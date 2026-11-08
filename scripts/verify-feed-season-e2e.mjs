import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { nextPlayableSeason, seasonNumberFromTitle } from '../src/services/feedSource.ts';

const port = Number(process.env.TTV_CDP_PORT ?? 9225);
const baseUrl = `http://127.0.0.1:${port}`;
const targets = await (await fetch(`${baseUrl}/json/list`)).json();
const page = targets.find(target => target.type === 'page'
  && (target.url.startsWith('http://tauri.localhost/')
    || target.url.startsWith('http://127.0.0.1:5175/')));
assert.ok(page, `No Tauri WebView found on CDP port ${port}`);

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 0;
const pending = new Map();
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  const resolve = pending.get(message.id);
  if (resolve) {
    pending.delete(message.id);
    resolve(message);
  }
});

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP call timed out: ${method}`));
    }, 30_000);
    pending.set(id, message => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

async function evaluate(expression) {
  const response = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.exception?.description ?? response.result.exceptionDetails.text);
  }
  return response.result?.result?.value;
}

async function clickPlaybackPrompt() {
  const point = await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='点击播放');if(!button)return null;const rect=button.getBoundingClientRect();return rect.width&&rect.height?{x:rect.left+rect.width/2,y:rect.top+rect.height/2}:null})()`);
  if (!point) return false;
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  return true;
}

async function waitFor(expression, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await evaluate(expression);
    if (lastValue) return lastValue;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(lastValue)}`);
}

const invoke = async (command, args = {}) => {
  const encodedArgs = JSON.stringify(args);
  const result = await evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${encodedArgs}).then(JSON.stringify)`,
  );
  return JSON.parse(result);
};

async function swipeVertically(deltaY) {
  const point = JSON.parse(await evaluate('JSON.stringify({ x: innerWidth / 2, y: innerHeight / 2 })'));
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y + deltaY, button: 'left', buttons: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y + deltaY, button: 'left', clickCount: 1 });
}

async function showPlayerHud() {
  const point = JSON.parse(await evaluate('JSON.stringify({ x: innerWidth / 2, y: innerHeight / 2 })'));
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await waitFor("document.querySelector('.ttv-hud')&&!document.querySelector('.ttv-hud').classList.contains('is-hidden')", 'player HUD visible');
}

async function swipeToEpisode(deltaY, episodeNumber) {
  await evaluate('(()=>{window.__feedSwipeEvents=[];const video=document.querySelector("video");video?.addEventListener("play",()=>window.__feedSwipeEvents.push("play"));video?.addEventListener("pause",()=>window.__feedSwipeEvents.push("pause"))})()');
  await swipeVertically(deltaY);
  await waitFor(`document.querySelector('[aria-hidden="false"] section[aria-label="当前短剧"] p')?.textContent.startsWith('第 ${episodeNumber} 集')`, `swipe to episode ${episodeNumber}`);
  await waitFor('window.__feedSwipeEvents.includes("play")||[...document.querySelectorAll("button")].some(button=>button.textContent.trim()==="点击播放")', `episode ${episodeNumber} starts or requests a click`, 60_000);
  if (await evaluate('document.querySelector("video")?.paused ?? true')) {
    assert.ok(await clickPlaybackPrompt(), `Episode ${episodeNumber} autoplay was blocked but the manual play prompt was not available`);
    await waitFor('document.querySelector("video")&&!document.querySelector("video").paused', `manual play for episode ${episodeNumber}`);
  }
  await delay(350);
  const playback = JSON.parse(await evaluate('JSON.stringify({ paused: document.querySelector("video")?.paused, events: window.__feedSwipeEvents })'));
  assert.equal(playback.paused, false, `Swiping to episode ${episodeNumber} paused playback: ${playback.events.join(",")}`);
}

let originalWindowBounds = null;

try {
  assert.equal(await evaluate("typeof window.__TAURI_INTERNALS__?.invoke"), 'function', 'Tauri IPC is unavailable');
  const settings = await invoke('settings_get');
  assert.equal(settings.autoNext, true, 'Enable episode auto-play before running this acceptance check');
  if (await evaluate("Boolean(document.querySelector('[aria-hidden=\"false\"] [aria-label=\"推荐频道\"]'))")) {
    await evaluate("document.querySelector('[aria-hidden=\"false\"] button[aria-label=\"返回短剧精选\"]')?.click()");
    await waitFor("!document.querySelector('[aria-hidden=\"false\"] [aria-label=\"推荐频道\"]')", 'return to home before test reset');
    await waitFor('document.querySelector("video")?.paused === true', 'stop playback before test reset');
  }
  if (process.env.TTV_CLEAR_TEST_HISTORY === '1') {
    await invoke('history_clear');
    await delay(500);
    await invoke('history_clear');
  }
  const history = await invoke('history_list');
  assert.equal(history.length, 0, 'Run against a clean test database; use TTV_CLEAR_TEST_HISTORY=1 only for isolated test data');

  const recommendationItems = [];
  let candidate = null;
  let nextSeason = null;
  let cursor = null;
  for (let pageNumber = 0; pageNumber < 10 && !candidate; pageNumber += 1) {
    const page = await invoke('hongguo_discover', { channel: 'comic', cursor });
    const items = page.items ?? [];
    recommendationItems.push(...items);
    for (const item of items) {
      const seasons = await invoke('catalog_series_seasons', { seriesId: item.id });
      const currentSeason = seasons.find(season => season.seriesId === item.id);
      if (!currentSeason) continue;
      const next = nextPlayableSeason(seasons, seasonNumberFromTitle(item.title), item.id);
      if (next) {
        candidate = item;
        nextSeason = next;
        break;
      }
    }
    if (candidate || !page.hasMore || !page.cursor || page.cursor === cursor) break;
    cursor = page.cursor;
  }
  assert.ok(candidate && nextSeason, 'No playable multi-season comic appears in the first ten live recommendation pages');

  const nextDetail = await invoke('hongguo_series_detail', {
    seriesId: nextSeason.seriesId,
    channel: 'comic',
  });
  const expectedEpisode = nextDetail.episodes?.[0];
  assert.ok(expectedEpisode?.id, `Season ${nextSeason.seasonIndex} has no first episode`);
  assert.equal(expectedEpisode.number, 1, 'The next season detail must begin with episode 1');

  await evaluate(`(()=>{if(!document.querySelector('[aria-hidden="false"] [aria-label="推荐频道"]')){[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='短剧推荐'&&button.getBoundingClientRect().width>0)?.click()}return true})()`);
  await waitFor("Boolean(document.querySelector('[aria-hidden=\"false\"] [aria-label=\"推荐频道\"]'))", 'feed view');
  await waitFor("document.activeElement?.textContent.trim()==='短剧推荐'", 'feed heading focus');
  const selectedComic = await evaluate("document.querySelector('[aria-hidden=\"false\"] [aria-label=\"推荐频道\"] button[aria-pressed=\"true\"]')?.textContent.trim()==='漫剧'");
  if (selectedComic) {
    await evaluate(`(()=>{const group=document.querySelector('[aria-hidden="false"] [aria-label="推荐频道"]');[...group.querySelectorAll('button')].find(button=>button.textContent.trim()==='短剧')?.click();return true})()`);
    await waitFor("document.querySelector('[aria-hidden=\"false\"] [aria-label=\"推荐频道\"] button[aria-pressed=\"true\"]')?.textContent.trim()==='短剧'", 'drama channel reset');
  }
  await evaluate(`(()=>{const group=document.querySelector('[aria-hidden="false"] [aria-label="推荐频道"]');[...group.querySelectorAll('button')].find(button=>button.textContent.trim()==='漫剧')?.click();return true})()`);
  await waitFor("document.querySelector('[aria-hidden=\"false\"] [aria-label=\"推荐频道\"] button[aria-pressed=\"true\"]')?.textContent.trim()==='漫剧'", 'comic channel refresh');

  const currentTitleExpression = "(()=>{const title=document.querySelector('[aria-hidden=\"false\"] section[aria-label=\"当前短剧\"] h1');return title?.textContent.trim()||''})()";
  const recommendationTitles = recommendationItems.map(item => item.title);
  let currentTitle = await waitFor(
    `(()=>{const title=${currentTitleExpression};return ${JSON.stringify(recommendationTitles)}.includes(title)?title:null})()`,
    'first live comic recommendation',
  );
  for (let attempts = 0; currentTitle !== candidate.title && attempts <= recommendationItems.length; attempts += 1) {
    await waitFor(
      "(()=>{const button=document.querySelector('[aria-hidden=\"false\"] button[aria-label=\"换一部短剧\"]');return button&&!button.disabled})()",
      'feed switch control to become ready',
    );
    await evaluate("document.querySelector('[aria-hidden=\"false\"] button[aria-label=\"换一部短剧\"]')?.click()");
    currentTitle = await waitFor(
      `(()=>{const title=${currentTitleExpression};return title!==${JSON.stringify(currentTitle)}&&${JSON.stringify(recommendationTitles)}.includes(title)?title:null})()`,
      'next recommendation',
    );
  }
  assert.equal(currentTitle, candidate.title, 'The playable multi-season title was not reachable in the feed queue');

  assert.ok(await evaluate(`(()=>{const hud=document.querySelector('.ttv-hud');return hud?.classList.contains('is-feed')&&hud.querySelector('[role="slider"][aria-label="播放进度"]')&&hud.querySelector('[role="slider"][aria-label="音量"]')&&[...hud.querySelectorAll('button')].some(button=>button.title.startsWith('切换播放倍速'))&&[...hud.querySelectorAll('button')].some(button=>button.getAttribute('aria-label')==='进入全屏')})()`), 'The shared HUD is missing feed playback controls');

  const firstEpisode = await evaluate("document.querySelector('[aria-hidden=\"false\"] section[aria-label=\"当前短剧\"] p')?.textContent");
  assert.ok(firstEpisode?.startsWith('第 1 集'), `The feed did not start at episode 1: ${firstEpisode}`);
  await waitFor('(()=>{const video=document.querySelector("video");return video&&video.readyState>=2&&(!video.paused||[...document.querySelectorAll("button")].some(button=>button.textContent.trim()==="点击播放"))})()', 'first feed episode ready to play', 120_000);
  if (await evaluate('document.querySelector("video")?.paused ?? true')) {
    assert.ok(await clickPlaybackPrompt(), 'The first feed episode was blocked but the manual play prompt was not available');
    await waitFor('document.querySelector("video")&&!document.querySelector("video").paused', 'first feed episode playback');
  }
  await swipeToEpisode(-90, 2);
  await swipeToEpisode(90, 1);

  await evaluate("document.querySelector('[aria-hidden=\"false\"] button[aria-label=\"加入追剧收藏\"]')?.click()");
  await waitFor("document.querySelector('[aria-hidden=\"false\"] button[aria-label=\"取消追剧收藏\"]')?.getAttribute('aria-pressed')==='true'", 'favorite added');
  const savedFavorites = await invoke('favorites_list', { mark: null });
  assert.ok(savedFavorites.some(item => item.seriesId === candidate.id && item.mark === 'want'), 'The feed favorite was not persisted');
  await evaluate("document.querySelector('[aria-hidden=\"false\"] button[aria-label=\"取消追剧收藏\"]')?.click()");
  await waitFor("document.querySelector('[aria-hidden=\"false\"] button[aria-label=\"加入追剧收藏\"]')?.getAttribute('aria-pressed')==='false'", 'favorite removed');
  const removedFavorites = await invoke('favorites_list', { mark: null });
  assert.ok(!removedFavorites.some(item => item.seriesId === candidate.id), 'The feed favorite was not removed');

  const danmakuState = "(()=>[...document.querySelectorAll('.ttv-hud button')].find(button=>button.textContent.trim()==='弹幕')?.getAttribute('aria-pressed'))()";
  const danmakuBefore = await evaluate(danmakuState);
  assert.equal(danmakuBefore, String(settings.danmakuEnabled !== false), 'The HUD danmaku state does not match saved settings');
  await evaluate(`(()=>[...document.querySelectorAll('.ttv-hud button')].find(button=>button.textContent.trim()==='弹幕')?.click())()`);
  await waitFor(`${danmakuState}===${JSON.stringify(danmakuBefore === 'true' ? 'false' : 'true')}`, 'danmaku toggle');
  assert.equal((await invoke('settings_get')).danmakuEnabled, danmakuBefore !== 'true', 'The danmaku toggle was not persisted');
  await evaluate(`(()=>[...document.querySelectorAll('.ttv-hud button')].find(button=>button.textContent.trim()==='弹幕')?.click())()`);
  await waitFor(`${danmakuState}===${JSON.stringify(danmakuBefore)}`, 'restore danmaku setting');
  await showPlayerHud();
  await evaluate("document.querySelector('.ttv-hud button[title=\"弹幕设置\"]')?.click()");
  await waitFor("document.querySelector('[role=\"dialog\"][aria-label=\"弹幕设置\"]')?.classList.contains('open')", 'danmaku settings panel');
  const danmakuSliders = await evaluate("JSON.stringify([...document.querySelectorAll('[role=\"dialog\"][aria-label=\"弹幕设置\"] input[type=\"range\"]')].map(input=>input.getAttribute('aria-label')))");
  assert.equal(JSON.parse(danmakuSliders).length, 4, 'The danmaku appearance controls are incomplete');
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor("!document.querySelector('[role=\"dialog\"][aria-label=\"弹幕设置\"]')?.classList.contains('open')", 'close danmaku settings with Escape');

  await evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='选集')?.click()");
  await waitFor("Boolean(document.querySelector('[role=\"dialog\"][aria-label=\"选集播放\"]'))", 'episode drawer');
  await evaluate(`(()=>{const input=document.querySelector('[role="dialog"] input[aria-label="搜索集数"]');if(!input)throw new Error('Episode search is missing');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,String(${candidate.episodesCount}));input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  const lastEpisodeButton = await waitFor(
    `(()=>{const dialog=document.querySelector('[role="dialog"][aria-label="选集播放"]');return [...(dialog?.querySelectorAll('button.ep-card-item')??[])].find(button=>button.textContent.trim()===String(${candidate.episodesCount}))?.textContent.trim()||null})()`,
    `episode ${candidate.episodesCount}`,
  );
  assert.equal(lastEpisodeButton, String(candidate.episodesCount));
  await evaluate(`(()=>{const dialog=document.querySelector('[role="dialog"][aria-label="选集播放"]');[...dialog.querySelectorAll('button.ep-card-item')].find(button=>button.textContent.trim()===String(${candidate.episodesCount}))?.click();return true})()`);

  await waitFor(
    `(()=>{const section=document.querySelector('[aria-hidden="false"] section[aria-label="当前短剧"]');const episode=section?.querySelector('p')?.textContent??'';const video=document.querySelector('video');const prompt=[...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='点击播放');return episode.includes('第 ${candidate.episodesCount} 集')&&video&&video.readyState>=3&&((!video.paused&&video.currentTime>0.5)||prompt)})()`,
    `last episode ${candidate.episodesCount} ready to play`,
    180_000,
  );
  const pausedAtSeasonEnd = await evaluate('document.querySelector(\'video\')?.paused ?? true');
  if (pausedAtSeasonEnd) assert.ok(await clickPlaybackPrompt(), 'Playback was blocked but the manual play prompt was not available');
  await waitFor(
    '(()=>{const video=document.querySelector("video");return video&&video.readyState>=3&&!video.paused&&video.currentTime>0.5})()',
    'last episode playback after user gesture',
    60_000,
  );
  await delay(2_500);
  const ending = await evaluate(`(()=>{const video=document.querySelector('video');if(!video||!Number.isFinite(video.duration))throw new Error('Video duration is not ready');video.currentTime=Math.max(0,video.duration-0.75);return {duration:video.duration,currentTime:video.currentTime}})()`);

  await waitFor(
    `(()=>{const section=document.querySelector('[aria-hidden="false"] section[aria-label="当前短剧"]');const title=section?.querySelector('h1')?.textContent.trim()??'';const episode=section?.querySelector('p')?.textContent??'';const video=document.querySelector('video');const prompt=[...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='点击播放');return title===${JSON.stringify(nextSeason.title)}&&episode.startsWith('第 1 集')&&video&&video.readyState>=2&&(!video.paused||prompt)})()`,
    `season ${nextSeason.seasonIndex} episode 1 ready`,
    120_000,
  );
  const pausedAtNextSeason = await evaluate('document.querySelector(\'video\')?.paused ?? true');
  if (pausedAtNextSeason) assert.ok(await clickPlaybackPrompt(), 'Next season autoplay was blocked but the manual play prompt was not available');
  await waitFor(
    `(()=>{const video=document.querySelector('video');return video&&video.readyState>=2&&!video.paused&&video.currentTime>0.25})()`,
    'next season playback progress',
    120_000,
  );
  const updatedHistory = await invoke('history_list');
  assert.ok(updatedHistory.some(item => item.seriesId === nextSeason.seriesId
    && item.episodeId === expectedEpisode.id
    && item.episodeNumber === 1), 'The first episode of the next season was not written to local history');

  const resumeRow = await waitFor(
    `(()=>window.__TAURI_INTERNALS__.invoke('history_list').then(rows=>{const row=rows.find(item=>item.seriesId===${JSON.stringify(nextSeason.seriesId)}&&item.episodeId===${JSON.stringify(expectedEpisode.id)});return row&&row.positionSeconds>=2?JSON.stringify(row):null}))()`,
    'playback position persisted for resume',
    30_000,
  );
  const resumePosition = JSON.parse(resumeRow).positionSeconds;

  const windowResult = await call('Browser.getWindowForTarget');
  assert.ok(windowResult.result?.bounds, 'The feed window bounds are unavailable');
  originalWindowBounds = { windowId: windowResult.result.windowId, bounds: windowResult.result.bounds };
  await call('Browser.setWindowBounds', {
    windowId: originalWindowBounds.windowId,
    bounds: { ...originalWindowBounds.bounds, width: 1200, height: 800 },
  });
  await waitFor('innerWidth===1200&&innerHeight===800', 'resized feed viewport');
  const resizedLayout = JSON.parse(await evaluate(`JSON.stringify({overflow:document.documentElement.scrollWidth>innerWidth,hudRight:document.querySelector('.ttv-hud')?.getBoundingClientRect().right,feedRight:document.querySelector('[aria-hidden="false"] [aria-label="推荐频道"]')?.getBoundingClientRect().right})`));
  assert.equal(resizedLayout.overflow, false, 'The feed overflows horizontally after window resize');
  assert.ok(resizedLayout.hudRight <= 1200 && resizedLayout.feedRight <= 1200, 'Feed controls escape the resized window');
  await call('Browser.setWindowBounds', originalWindowBounds);
  await waitFor(`innerWidth===${originalWindowBounds.bounds.width}&&innerHeight===${originalWindowBounds.bounds.height}`, 'restore feed window size');
  originalWindowBounds = null;

  await evaluate("document.querySelector('[aria-hidden=\"false\"] button[aria-label=\"返回短剧精选\"]')?.click()");
  await waitFor("!document.querySelector('[aria-hidden=\"false\"] [aria-label=\"推荐频道\"]')", 'return to home');
  await waitFor("[...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='短剧推荐'&&button.getBoundingClientRect().width>0)", 'home feed entry');
  await evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='短剧推荐'&&button.getBoundingClientRect().width>0)?.click()");
  await waitFor("Boolean(document.querySelector('[aria-hidden=\"false\"] [aria-label=\"推荐频道\"]'))", 'reopen feed from home');
  await evaluate("[...document.querySelectorAll('[aria-hidden=\"false\"] [aria-label=\"推荐频道\"] button')].find(button=>button.textContent.trim()==='漫剧')?.click()");
  await waitFor(
    `(()=>{const section=document.querySelector('[aria-hidden="false"] section[aria-label="当前短剧"]');const video=document.querySelector('video');return section?.querySelector('h1')?.textContent.trim()===${JSON.stringify(nextSeason.title)}&&section?.querySelector('p')?.textContent.startsWith('第 1 集')&&video&&video.currentTime>=${Math.max(0, resumePosition - 1)}})()`,
    'resume the latest feed episode and position',
    60_000,
  );
  await evaluate("document.querySelector('[aria-hidden=\"false\"] button[aria-label=\"返回短剧精选\"]')?.click()");
  await waitFor("!document.querySelector('[aria-hidden=\"false\"] [aria-label=\"推荐频道\"]')", 'finish on home');

  console.log(JSON.stringify({
    status: 'PASS',
    series: candidate.title,
    completedSeason: 1,
    endedEpisode: candidate.episodesCount,
    nextSeason: nextSeason.title,
    nextEpisodeId: expectedEpisode.id,
    ending,
    verified: ['live recommendation membership', 'feed heading focus', 'swipe next and previous episode', 'favorite add and remove persistence', 'shared HUD progress, volume, speed and fullscreen controls', 'danmaku state and appearance controls', 'natural media ended', 'next season episode 1', 'playback history position and resume', 'window resize and restore', 'return to home'],
  }, null, 2));
} finally {
  if (originalWindowBounds) {
    await call('Browser.setWindowBounds', originalWindowBounds).catch(() => {});
  }
  socket.close();
}

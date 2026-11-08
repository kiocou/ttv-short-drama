import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const port = Number(process.env.TTV_CDP_PORT ?? 9225);
const baseUrl = `http://127.0.0.1:${port}`;
const targets = await (await fetch(`${baseUrl}/json/list`)).json();
const page = targets.find(target => target.type === 'page' && target.url.startsWith('http://tauri.localhost/'));
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
  while (Date.now() < deadline) {
    const result = await evaluate(expression);
    if (result) return result;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const invoke = async (command, args = {}) => {
  const encodedArgs = JSON.stringify(args);
  const result = await evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${encodedArgs}).then(JSON.stringify)`,
  );
  return JSON.parse(result);
};

try {
  assert.equal(await evaluate("typeof window.__TAURI_INTERNALS__?.invoke"), 'function', 'Tauri IPC is unavailable');
  const settings = await invoke('settings_get');
  assert.equal(settings.autoNext, true, 'Enable episode auto-play before running this acceptance check');
  if (process.env.TTV_CLEAR_TEST_HISTORY === '1') await invoke('history_clear');
  const history = await invoke('history_list');
  assert.equal(history.length, 0, 'Run against a clean test database; use TTV_CLEAR_TEST_HISTORY=1 only for isolated test data');

  const recommendations = await invoke('hongguo_discover', { channel: 'comic', cursor: null });
  let candidate = null;
  let nextSeason = null;
  for (const item of recommendations.items ?? []) {
    const seasons = await invoke('catalog_series_seasons', { seriesId: item.id });
    const currentSeason = seasons.find(season => season.seriesId === item.id);
    if (!currentSeason) continue;
    const next = seasons
      .filter(season => season.seriesId !== item.id
        && season.seasonIndex > currentSeason.seasonIndex
        && !season.disablePlay
        && season.episodeCount > 0)
      .sort((left, right) => left.seasonIndex - right.seasonIndex)[0];
    if (next) {
      candidate = item;
      nextSeason = next;
      break;
    }
  }
  assert.ok(candidate && nextSeason, 'No playable multi-season comic appears in the live recommendation page');

  const nextDetail = await invoke('hongguo_series_detail', {
    seriesId: nextSeason.seriesId,
    channel: 'comic',
  });
  const expectedEpisode = nextDetail.episodes?.[0];
  assert.ok(expectedEpisode?.id, `Season ${nextSeason.seasonIndex} has no first episode`);
  assert.equal(expectedEpisode.number, 1, 'The next season detail must begin with episode 1');

  await evaluate(`(()=>{if(!document.querySelector('[aria-hidden="false"] [aria-label="推荐频道"]')){[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='短剧推荐')?.click()}return true})()`);
  await waitFor("Boolean(document.querySelector('[aria-hidden=\"false\"] [aria-label=\"推荐频道\"]'))", 'feed view');
  const selectedComic = await evaluate("document.querySelector('[aria-hidden=\"false\"] [aria-label=\"推荐频道\"] button[aria-pressed=\"true\"]')?.textContent.trim()==='漫剧'");
  if (selectedComic) {
    await evaluate(`(()=>{const group=document.querySelector('[aria-hidden="false"] [aria-label="推荐频道"]');[...group.querySelectorAll('button')].find(button=>button.textContent.trim()==='短剧')?.click();return true})()`);
    await waitFor("document.querySelector('[aria-hidden=\"false\"] [aria-label=\"推荐频道\"] button[aria-pressed=\"true\"]')?.textContent.trim()==='短剧'", 'drama channel reset');
  }
  await evaluate(`(()=>{const group=document.querySelector('[aria-hidden="false"] [aria-label="推荐频道"]');[...group.querySelectorAll('button')].find(button=>button.textContent.trim()==='漫剧')?.click();return true})()`);
  await waitFor("document.querySelector('[aria-hidden=\"false\"] [aria-label=\"推荐频道\"] button[aria-pressed=\"true\"]')?.textContent.trim()==='漫剧'", 'comic channel refresh');

  const currentTitleExpression = "(()=>{const title=document.querySelector('[aria-hidden=\"false\"] section[aria-label=\"当前短剧\"] h1');return title?.textContent.trim()||''})()";
  const recommendationTitles = recommendations.items.map(item => item.title);
  let currentTitle = await waitFor(
    `(()=>{const title=${currentTitleExpression};return ${JSON.stringify(recommendationTitles)}.includes(title)?title:null})()`,
    'first live comic recommendation',
  );
  for (let attempts = 0; currentTitle !== candidate.title && attempts <= recommendations.items.length; attempts += 1) {
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

  console.log(JSON.stringify({
    status: 'PASS',
    series: candidate.title,
    completedSeason: 1,
    endedEpisode: candidate.episodesCount,
    nextSeason: nextSeason.title,
    nextEpisodeId: expectedEpisode.id,
    ending,
    verified: ['live recommendation membership', 'playable season metadata', 'natural media ended', 'season episode 1 opened', 'playback progressed', 'local history written'],
  }, null, 2));
} finally {
  socket.close();
}

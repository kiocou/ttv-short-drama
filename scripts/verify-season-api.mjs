// 「系列剧弹窗」权威链路（后端 `catalog_series_seasons`）的确定性验证。
//
// 为什么单独一组用例：这一版把弹窗的数据源从"剧名 + 猜季号打搜索"换成了后端的结构化
// 季表，随之而来的四个契约在界面上**都表现为同一句话**——"弹窗里少了几季 / 点开是空的"：
//   1. 命中季表后不能再打搜索（打开弹窗的延迟从最多 4 次往返降到 1 次）；
//   2. 长系列不能被搜索链路的 48 季上限截断（实测《烬九州》35 季）；
//   3. `available` 必须同时认 `episodeCount === 0` 与 `disablePlay` 两个信号；
//   4. 季表为空 / 抛错 / 命令不存在时必须静默回退旧链路，且不能抛给详情页。
// 纯函数 + 受控假 IPC 就能把四条钉住，不需要 Tauri。
//
// 运行：npm run verify:season-api

import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const outDir = await mkdtemp(path.join(tmpdir(), 'ttv-verify-season-api-'));
const outFile = path.join(outDir, 'bundle.mjs');
const ipcStub = path.join(outDir, 'ipc-stub.ts');

/**
 * ipc 的受控假实现。
 *
 * 与 `verify-related-pick.mjs` 的 stub 保持同一套开关（`globalThis.__FAKE__` 里的
 * `fast / suggest / catalog`），只多一个 `api` 槽表达季表命令的三种状态：
 * - 数组 → 命令可用，照单返回；
 * - `'missing'` → 命令**不存在**（旧后端，以及本 stub 的默认态）；
 * - `'reject'` → 命令在但抛错。
 *
 * `seriesSeasons` 特意用 getter 挂：`'missing'` 要能让属性本身读成 `undefined`
 * （与真实旧版 ipc 对象一致），而 `Object.assign` 一个 `undefined` 做不到这件事。
 */
await writeFile(
  ipcStub,
  `type Fake = {
    fast?: unknown[] | 'reject';
    suggest?: unknown[] | 'reject';
    catalog?: unknown[] | 'reject';
    api?: unknown[] | 'reject' | 'missing';
  };
  type Calls = string[];
  const calls: Calls = [];
  (globalThis as any).__CALLS__ = calls;
  function fake(): Fake {
    return ((globalThis as any).__FAKE__ ?? {}) as Fake;
  }
  function pick(value: unknown[] | 'reject' | undefined): unknown[] {
    if (value === 'reject') throw new Error('fake failure');
    return Array.isArray(value) ? value : [];
  }
  const catalog: Record<string, unknown> = {
    async searchFast() {
      calls.push('searchFast');
      return { items: pick(fake().fast), total: 0, hasMore: false, page: 1, categories: [] };
    },
    async searchSuggest() {
      calls.push('searchSuggest');
      return pick(fake().suggest);
    },
    async list() {
      calls.push('list');
      return { items: pick(fake().catalog), total: 0, hasMore: false, page: 1, categories: [] };
    },
  };
  Object.defineProperty(catalog, 'seriesSeasons', {
    get() {
      const api = fake().api;
      if (api === 'missing' || api === undefined) return undefined;
      return async (_seriesId: string) => {
        calls.push('seriesSeasons');
        if (api === 'reject') throw new Error('fake api failure');
        return api;
      };
    },
  });
  export const ipcService = { catalog };
  `,
  'utf8',
);

const ipcStubPlugin = {
  name: 'ipc-stub',
  setup(build) {
    build.onResolve({ filter: /(^|\/)ipc$/ }, () => ({ path: ipcStub }));
  },
};

await build({
  entryPoints: [path.resolve('scripts/season-api-probe.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  plugins: [ipcStubPlugin],
  logLevel: 'warning',
});

try {
  await import(pathToFileURL(outFile).href);
} finally {
  await rm(outDir, { recursive: true, force: true });
}

// 「搜索页系列聚合」的确定性验证。
//
// 为什么单独一组用例：聚合做错的两种表现都很难在界面上认出来 —— 一种是"搜到了系列
// 却一张都没补进来"（锚点挑错，看起来像"这个系列本来就只有三条"），另一种是"补进来
// 一堆不相干的剧"（锚点挑多了，看起来像搜索变松了）。第三种更隐蔽：补进来的季点开
// 是空的。这三种都只能靠纯函数 + 受控假 IPC 钉住。
//
// 用 esbuild 打包是为了让 `./ipc` 整体换成受控假实现（真实 ipc 依赖 Tauri 运行时，
// 在 Node 里连不上），与 verify-related-pick / verify-season-api 同一套写法。
//
// 运行：npm run verify:search-season-expand

import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const outDir = await mkdtemp(path.join(tmpdir(), 'ttv-verify-season-expand-'));
const outFile = path.join(outDir, 'bundle.mjs');
const ipcStub = path.join(outDir, 'ipc-stub.ts');

/**
 * ipc 的受控假实现。
 *
 * `seriesSeasons` 按**锚点 id** 发牌（探针通过 `globalThis.__SEASONS__` 注入），
 * 这样"两个锚点各拿到不同季表""两个锚点拿到重复 id"都能直接摆出来；
 * 值写成 `'reject'` 表示这一路抛错（验证 d）。
 *
 * 搜索三路返回空：这组用例只关心聚合，不希望搜索链路往结果里掺东西。
 */
await writeFile(
  ipcStub,
  `type Table = Record<string, unknown[] | 'reject'>;
  (globalThis as any).__CALLS__ = [];
  function table(): Table {
    return ((globalThis as any).__SEASONS__ ?? {}) as Table;
  }
  export const ipcService = {
    catalog: {
      async searchFast() {
        return { items: [], total: 0, hasMore: false, page: 1, categories: [] };
      },
      async searchSuggest() {
        return [];
      },
      async list() {
        return { items: [], total: 0, hasMore: false, page: 1, categories: [] };
      },
      async seriesSeasons(seriesId: string) {
        (globalThis as any).__CALLS__.push(seriesId);
        const value = table()[seriesId];
        if (value === 'reject') throw new Error('fake season table failure');
        return Array.isArray(value) ? value : [];
      },
    },
  };
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
  entryPoints: [path.resolve('scripts/search-season-expand-probe.ts')],
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

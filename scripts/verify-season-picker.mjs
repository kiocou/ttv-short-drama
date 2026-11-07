// 「搜索页选季窗口」的确定性验证。
//
// 为什么单独一组用例：这个窗口的数据源是 `fetchAllSeriesSeasons`，它与详情页的
// `fetchSeriesSeasons` 只有一处差别 —— **不排除代表那一季** —— 而这一处差别正是
// 用户最容易察觉的错（"我搜到的这个系列怎么少了第一季"）。加上回退链路与折叠开关
// (`seriesFoldedCount`)，三件事都得钉住。
//
// 用 esbuild 打包 + ipc 假实现：真实 ipc 依赖 Tauri 运行时，在 Node 里连不上。
//
// 运行：npm run verify:season-picker

import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const outDir = await mkdtemp(path.join(tmpdir(), 'ttv-verify-season-picker-'));
const outFile = path.join(outDir, 'bundle.mjs');
const ipcStub = path.join(outDir, 'ipc-stub.ts');

/**
 * ipc 的受控假实现。
 *
 * 与 `verify-search-season-expand.mjs` 同一套开关（`__FAKE__`）：`fast / suggest`
 * 控制回退链路的搜索，`api` 控制季节表命令的三种状态（数组 / `'reject'` / `'missing'`）。
 */
await writeFile(
  ipcStub,
  `type Fake = {
    fast?: unknown[] | 'reject';
    suggest?: unknown[] | 'reject';
    catalog?: unknown[] | 'reject';
    api?: unknown[] | 'reject' | 'missing';
  };
  function fake(): Fake {
    return ((globalThis as any).__FAKE__ ?? {}) as Fake;
  }
  function pick(value: unknown[] | 'reject' | undefined): unknown[] {
    if (value === 'reject') throw new Error('fake failure');
    return Array.isArray(value) ? value : [];
  }
  const catalog: Record<string, unknown> = {
    async searchFast() {
      return { items: pick(fake().fast), total: 0, hasMore: false, page: 1, categories: [] };
    },
    async searchSuggest() {
      return pick(fake().suggest);
    },
    async list() {
      return { items: pick(fake().catalog), total: 0, hasMore: false, page: 1, categories: [] };
    },
  };
  Object.defineProperty(catalog, 'seriesSeasons', {
    get() {
      const api = fake().api;
      if (api === 'missing' || api === undefined) return undefined;
      return async (_seriesId: string) => {
        if (api === 'reject') throw new Error('fake api failure');
        return api;
      };
    },
  });
  export const ipcService = {
    catalog,
    series: {
      async getDetail() {
        return null;
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
  entryPoints: [path.resolve('scripts/season-picker-probe.ts')],
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

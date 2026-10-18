// 「同系列筛选 + 接续排序」的确定性验证。
//
// 为什么单独跑：`fetchRelatedSeries` 里真正容易错的是**筛选口径**——哪些候选算
// "同一系列的其它季"、当前季要不要排除、量词不同的组会不会串味、同系列凑满一屏
// 时还要不要去拉兜底目录。这些都是纯判断，用真实形状的候选数据直接断言即可，
// 不需要真的连红果。
//
// 用 esbuild 打包是为了绕开 `.tsx`/路径解析的差异，并让 ipc 层可以被整体替换成
// 一个受控的假实现（真实 ipc 依赖 Tauri 运行时，在 Node 里连不上）。
//
// 运行：npm run verify:related-pick

import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const outDir = await mkdtemp(path.join(tmpdir(), 'ttv-verify-pick-'));
const outFile = path.join(outDir, 'bundle.mjs');
const ipcStub = path.join(outDir, 'ipc-stub.ts');

/**
 * ipc 的受控假实现。
 *
 * 断言点：搜索两路各返回什么、兜底目录返回什么，都由用例通过 `globalThis.__FAKE__`
 * 注入；这里只负责"照单发牌"，并记录**哪些路被真的调用了**——用来证明
 * "同系列凑满一屏就不该再拉兜底目录"这类成本契约。
 */
await writeFile(
  ipcStub,
  `type Fake = {
    fast?: unknown[] | 'reject';
    suggest?: unknown[] | 'reject';
    catalog?: unknown[] | 'reject';
  };
  const calls: string[] = [];
  function pick(value: unknown[] | 'reject' | undefined): unknown[] {
    if (value === 'reject') throw new Error('fake failure');
    return Array.isArray(value) ? value : [];
  }
  export const ipcService = {
    catalog: {
      async searchFast() {
        calls.push('searchFast');
        const fake = (globalThis as any).__FAKE__ as Fake;
        return { items: pick(fake.fast), total: 0, hasMore: false, page: 1, categories: [] };
      },
      async searchSuggest() {
        calls.push('searchSuggest');
        const fake = (globalThis as any).__FAKE__ as Fake;
        return pick(fake.suggest);
      },
      async list() {
        calls.push('list');
        const fake = (globalThis as any).__FAKE__ as Fake;
        return { items: pick(fake.catalog), total: 0, hasMore: false, page: 1, categories: [] };
      },
    },
  };
  export function __calls() { return calls; }
  export function __reset() { calls.length = 0; }
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
  entryPoints: [path.resolve('scripts/related-pick-probe.ts')],
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

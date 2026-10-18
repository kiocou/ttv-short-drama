// 「后续季优先铺满一屏」的确定性验证。
//
// 用户要求：播放第 5 季时，展示第 6、7、8、9、10 季，优先展示后面。
// 这组用例从**用户视角的屏内容**倒推，而不是只验筛选口径——因为即使筛选与排序都对，
// 只要切片时给兜底内容留了座位，第 10 季就会被挤出屏幕（这正是上一版的行为）。
//
// 运行：npm run verify:season-priority

import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const outDir = await mkdtemp(path.join(tmpdir(), 'ttv-verify-priority-'));
const outFile = path.join(outDir, 'bundle.mjs');
const ipcStub = path.join(outDir, 'ipc-stub.ts');

/** ipc 的受控假实现：由用例通过 `globalThis.__FAKE__` 注入返回什么。 */
await writeFile(
  ipcStub,
  `type Fake = {
    fast?: unknown[] | 'reject';
    suggest?: unknown[] | 'reject';
    catalog?: unknown[] | 'reject';
  };
  function pick(value: unknown[] | 'reject' | undefined): unknown[] {
    if (value === 'reject') throw new Error('fake failure');
    return Array.isArray(value) ? value : [];
  }
  export const ipcService = {
    catalog: {
      async searchFast() {
        const fake = (globalThis as any).__FAKE__ as Fake;
        return { items: pick(fake.fast), total: 0, hasMore: false, page: 1, categories: [] };
      },
      async searchSuggest() {
        const fake = (globalThis as any).__FAKE__ as Fake;
        return pick(fake.suggest);
      },
      async list() {
        const fake = (globalThis as any).__FAKE__ as Fake;
        return { items: pick(fake.catalog), total: 0, hasMore: false, page: 1, categories: [] };
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
  entryPoints: [path.resolve('scripts/season-priority-probe.ts')],
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

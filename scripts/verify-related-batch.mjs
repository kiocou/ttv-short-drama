// 「换一批」轮换契约的确定性验证。
//
// 为什么单独一组用例：用户报的「换一批点了没反应」有两层根因——数据层的候选池被
// 截断到一屏（没有第二批可换）、以及切片层若不随 batch 变化则屏幕照样不动。这两层
// 都要被钉住，而且必须断言**相邻两批不同**，不能只断言"池子里有几条"。
//
// 运行：npm run verify:related-batch

import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const outDir = await mkdtemp(path.join(tmpdir(), 'ttv-verify-batch-'));
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
  entryPoints: [path.resolve('scripts/related-batch-probe.ts')],
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

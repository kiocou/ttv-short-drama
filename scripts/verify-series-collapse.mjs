// 「搜索页同系列折叠成单卡」的确定性验证。
//
// 为什么单独一组用例：折叠这件事有三个口径，错了都只在界面上表现为"看着还行" ——
// ① 代表卡选谁（按位置还是按季号）；② 季数角标什么时候能给；③ 无归属条目会不会被
// 顺手并进某个系列。只能用纯函数 + 真实数据序列钉住。
//
// `seriesGrouping.ts` 只依赖 `seasonLabel.ts`（纯函数，不碰 ipc / Tauri），esbuild
// 直接打包即可，不需要注入 ipc 假实现。
//
// 运行：npm run verify:series-collapse

import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const outDir = await mkdtemp(path.join(tmpdir(), 'ttv-verify-series-collapse-'));
const outFile = path.join(outDir, 'bundle.mjs');

await build({
  entryPoints: [path.resolve('scripts/series-collapse-probe.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'warning',
});

try {
  await import(pathToFileURL(outFile).href);
} finally {
  await rm(outDir, { recursive: true, force: true });
}

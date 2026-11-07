// 「搜索页同系列聚块」的确定性验证。
//
// 为什么单独一组用例：分组有两个用户能直接看见、但极难在界面上复现的口径 ——
// ① 裸名的第 1 季（季表 index=1 的标题就是「烬九州」）会不会被踢出组；
// ② 别的剧会不会被顺手排动。两者都是"多看两眼好像也没错"的那种错，只能用纯函数
// 加真实数据序列钉住。
//
// `seriesGrouping.ts` 只依赖 `seasonLabel.ts`（纯函数，不碰 ipc / Tauri），所以这里
// 不需要像 verify-related-pick 那样注入 ipc 假实现，esbuild 直接打包即可。
//
// 运行：npm run verify:series-grouping

import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const outDir = await mkdtemp(path.join(tmpdir(), 'ttv-verify-series-grouping-'));
const outFile = path.join(outDir, 'bundle.mjs');

await build({
  entryPoints: [path.resolve('scripts/series-grouping-probe.ts')],
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

// 「猜你喜欢」渲染契约的确定性验证。
//
// 为什么单独跑：这一栏的关键契约是**结构**——季号角标文案、接续季与前作的配色
// 区分、不传角标时不该凭空多出一个、旧面板的两句文案彻底消失。这些用服务端渲染
// 一次断言完，比开窗口点一遍快得多，也不依赖 Tauri 运行时。
//
// 两个必须绕开的坑：
// 1. 组件是 `.tsx`，Node 的 `--experimental-strip-types` 只认 `.ts`，遇到 JSX 直接
//    ERR_UNKNOWN_FILE_EXTENSION。所以先 esbuild 打包再交给 Node。
// 2. `SeriesCard` 通过 `useFavoriteMark` 订阅收藏表，那是 `useSyncExternalStore`，
//    SSR 下没有 `getServerSnapshot` 会抛错。这里把收藏 store 换成一个"永远未收藏"
//    的桩——验证的是卡片的**结构**，收藏角标本来就不在这条契约里。
//
// 运行：npm run verify:related-section

import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const outDir = await mkdtemp(path.join(tmpdir(), 'ttv-verify-'));
const outFile = path.join(outDir, 'bundle.mjs');
const stubFile = path.join(outDir, 'favorites-stub.tsx');

await writeFile(
  stubFile,
  `import type { FavoriteMark } from '${path
    .resolve('src/types/favorite.ts')
    .replace(/\\/g, '/')}';
export const FAVORITE_MARK_LABEL: Record<FavoriteMark, string> = {
  want: '想看',
  watching: '在看',
  done: '已看',
};
export function useFavoriteMark(_seriesId: string): FavoriteMark | null {
  return null;
}
export function useFavorites() {
  return { markBySeriesId: new Map<string, FavoriteMark>() };
}
`,
  'utf8',
);

/** 把收藏 store 换成桩：见文件头第 2 条。 */
const favoritesStub = {
  name: 'favorites-stub',
  setup(build) {
    build.onResolve({ filter: /useFavoritesStore$/ }, () => ({ path: stubFile }));
  },
};

await build({
  entryPoints: [path.resolve('scripts/related-section-probe.tsx')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react-dom/server', 'lucide-react'],
  plugins: [favoritesStub],
  logLevel: 'warning',
});

try {
  await import(pathToFileURL(outFile).href);
} finally {
  await rm(outDir, { recursive: true, force: true });
}

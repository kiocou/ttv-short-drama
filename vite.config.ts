import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 判断某路径是否应当被文件监听忽略。
 *
 * 为什么用函数而不是 glob 列表：glob 只能枚举已知模式，而临时文件的名字是
 * 不可预测的。实测两次 dev server 崩溃都来自这类文件——
 *   1. build.bat 把 TEMP 指向项目内 .tmp，编译期间生成被独占的文件；
 *   2. 编辑器/工具在源码目录里创建 .<文件名>.<随机串>.tmpdir/ 再原子替换。
 * 二者都不是本项目源码，却都会让 Windows 上的 fs.watch 抛 EBUSY。
 * 这里用谓词覆盖全部隐藏临时目录，新增工具也不会再踩到。
 */
const IGNORED_PATH = /(^|[\\/])(\.tmp|\.app-data|\.git|node_modules|dist|src-tauri)([\\/]|$)/;
const IGNORED_TEMPDIR = /\.tmpdir([\\/]|$)/;

/**
 * 吞掉文件监听的瞬时错误。
 *
 * 即便做了路径过滤，仍可能有别的进程（杀毒、索引、构建工具）短暂独占文件。
 * chokidar 的 watcher 一旦发出 error 事件而无人处理，Node 会直接终止进程——
 * 开发服务器就这样莫名退出（实测两次）。开发期监听失败只意味着某次热更新
 * 没触发，绝不该让整个服务挂掉，因此这里降级为告警。
 */
function ignoreWatcherErrors() {
  return {
    name: "ttv-ignore-watcher-errors",
    configureServer(server: { watcher?: { on: (e: string, cb: (err: Error & { code?: string }) => void) => void } }) {
      server.watcher?.on("error", (err) => {
        if (err && (err.code === "EBUSY" || err.code === "EPERM" || err.code === "ENOENT")) {
          return;
        }
        console.warn("[vite] watcher error:", err);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), ignoreWatcherErrors()],
  server: {
    host: "127.0.0.1",
    port: 5175,
    strictPort: false,
    watch: {
      ignored: [(p: string) => IGNORED_PATH.test(p) || IGNORED_TEMPDIR.test(p)],
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: false,
  },
  clearScreen: false,
});

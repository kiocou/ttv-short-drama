import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5175,
    strictPort: false,
    watch: {
      // src-tauri 整体排除（Rust 产物巨大且无需热更）。
      // .tmp / .app-data 也必须排除：build.bat 与 start-dev-safe.bat 把 TEMP
      // 指向项目内 .tmp，编译期间会生成被独占占用的临时文件；Windows 上
      // chokidar 对这类文件调用 fs.watch 会抛 EBUSY，未捕获即导致 dev server
      // 直接退出（实测：先 build.bat 再启 dev server 必崩）。
      ignored: ["**/src-tauri/**", "**/.tmp/**", "**/.app-data/**", "**/dist/**"],
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: false,
  },
  clearScreen: false,
});

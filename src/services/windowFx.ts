import { isTauriEnvironment } from './ipc';

/**
 * 原生窗口全屏的唯一入口。
 *
 * ## 为什么不能直接 `setFullscreen(true)`
 *
 * 只有"窗口未最大化"时，原生全屏才真的铺满屏幕。窗口一旦处于最大化状态，
 * 全屏就退化成"看起来进了全屏、任务栏还在、画面没铺满"。根因在 tao 的
 * Windows 窗口过程里（wry/tao 0.35 的 `window.rs`，WM_NCCALCSIZE 分支）：
 *
 * ```rust
 * // adjust the maximized borderless window so it doesn't cover the taskbar
 * if util::is_maximized(window).unwrap_or(false) {
 *     params.rgrc[0] = monitor_info.monitorInfo.rcWork;  // 工作区 = 屏幕 - 任务栏
 * }
 * ```
 *
 * 本应用是 `decorations: false` 的无边框窗口，tao 为了保证"最大化时不要盖住
 * 任务栏"，对**仍带 WS_MAXIMIZE 的窗口**把客户区裁到 `rcWork`。而 tao 的
 * `set_fullscreen` 只改 `MARKER_BORDERLESS_FULLSCREEN`，**从不清除最大化标记**，
 * 于是进入全屏后客户区依旧被裁到任务栏之上——现象就是用户报告的
 * "最大化状态下进全屏，任务栏还在/没铺满"。
 *
 * ## 因此
 *
 * 1. 进全屏前先解除最大化：清掉 WS_MAXIMIZE，客户区才会铺满整个显示器；
 * 2. **解除最大化必须静默**（Rust 侧 `window_prepare_fullscreen`，用
 *    `SetWindowPlacement` 原地改状态），不能调 tao 的 `unmaximize()`
 *    ——后者会走 `ShowWindow(SW_RESTORE)` 的还原动画，实测窗口高度
 *    1019 → 920 → 1067，用户看到"进全屏回弹一下"；
 * 3. 记住进全屏前的最大化状态，退出全屏时还原，用户不会"退出全屏后窗口变小了"；
 * 4. 状态以窗口真实查询结果为准。tao 的 `set_fullscreen` 是把任务派发到
 *    窗口线程后立即返回的，乐观地写死 UI 状态会与实际脱节——旧实现正是因此
 *    出现过"退出全屏后程序还是全屏"。
 */

/** 进全屏前窗口是否处于最大化（退出全屏时还原）。 */
let wasMaximizedBeforeFullscreen = false;

/**
 * `set_fullscreen` / `maximize` 都是异步落到窗口线程的，调用返回时状态未必已生效。
 * 这里轮询真实状态，最多等 `tries × 90ms`，拿到"已生效"就立刻返回。
 * 查询本身失败时返回 `expected`，不谎报也不卡死。
 */
async function waitForState(
  win: { isFullscreen: () => Promise<boolean> },
  expected: boolean,
  tries = 6,
): Promise<boolean> {
  let last = expected;
  for (let i = 0; i < tries; i += 1) {
    try {
      last = await win.isFullscreen();
      if (last === expected) return last;
    } catch {
      return expected;
    }
    await new Promise(resolve => setTimeout(resolve, 90));
  }
  return last;
}

/**
 * 进全屏前解除最大化。
 *
 * **必须走 Rust 侧的 `window_prepare_fullscreen`，不能用 `unmaximize()`。**
 * tao 的 `set_maximized(false)` 内部是 `ShowWindow(SW_RESTORE)`，带系统还原动画：
 * 实测进全屏时窗口高度先 1019 → 920（缩回原始尺寸）→ 1067，用户看到的就是
 * "进全屏回弹一下"，观感很怪。Rust 侧改用 `SetWindowPlacement` 原地改状态，
 * 窗口位置与尺寸都不动，紧接着的 setFullscreen 就能一步铺满整屏（1019 → 1067）。
 */
async function clearMaximizedSilently(): Promise<boolean> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return Boolean(await invoke<boolean>('window_prepare_fullscreen'));
  } catch {
    // 命令不可用（旧版本后端）时退回普通 unmaximize：会有还原动画，但功能正确。
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      if (await win.isMaximized()) {
        await win.unmaximize();
        return true;
      }
    } catch {
      // 忽略：进全屏仍会执行，只是可能被任务栏裁切。
    }
    return false;
  }
}

/** 进入全屏。返回**已核实**的全屏状态。 */
export async function enterFullscreen(): Promise<boolean> {
  if (!isTauriEnvironment()) return true;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();

  // 关键步骤：先静默解除最大化，否则客户区会被裁到工作区（任务栏之上）。
  try {
    wasMaximizedBeforeFullscreen = await win.isMaximized();
  } catch {
    wasMaximizedBeforeFullscreen = false;
  }
  if (wasMaximizedBeforeFullscreen) {
    await clearMaximizedSilently();
  }

  try {
    await win.setFullscreen(true);
  } catch {
    // 权限或环境不支持：如实返回当前真实状态。
    try {
      return await win.isFullscreen();
    } catch {
      return false;
    }
  }
  return waitForState(win, true);
}

/** 退出全屏，并还原进入前的最大化状态。返回**已核实**的全屏状态。 */
export async function leaveFullscreen(): Promise<boolean> {
  if (!isTauriEnvironment()) return false;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();

  try {
    if (await win.isFullscreen()) await win.setFullscreen(false);
    await waitForState(win, false);
    if (wasMaximizedBeforeFullscreen) await win.maximize();
  } catch {
    // 忽略：下次进入播放器时会重新校正。
  } finally {
    wasMaximizedBeforeFullscreen = false;
  }
  return false;
}

/** 查询窗口真实全屏状态；非 Tauri 环境恒为 false。 */
export async function queryFullscreen(): Promise<boolean> {
  if (!isTauriEnvironment()) return false;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return await getCurrentWindow().isFullscreen();
  } catch {
    return false;
  }
}

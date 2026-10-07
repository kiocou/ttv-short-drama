import { isTauriEnvironment } from './ipc';
import { tracePlayback } from './playbackTrace';

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
 * 全屏状态的所有权令牌。
 *
 * 上面那两个模块级变量只应该属于**最后进入全屏的那一次**调用。
 * 历史坑：快速连按 F（或 enter 与 leave 交叠）时两次调用会共用一个变量：
 * A 记下"进全屏前是最大化"、还没走到 setFullscreen；B 也记一次（可能是 false）
 * 并覆盖掉 A 的值 —— 之后谁也说不清该不该 maximize()，后果是还原矩形被钉死。
 *
 * 用自增令牌做所有权判定：`enterFullscreen` 开头领取令牌，只有仍持有它的那次
 * 才允许写 wasMaximized；`leaveFullscreen` 开头把令牌作废（置 0），使任何还在
 * 半路上的 enter 都不会再改状态。
 */
let fullscreenToken = 0;

/** 让还在途的 enter 失去对全屏状态的写入权（退出全屏时调用）。 */
function revokeFullscreenOwnership(): void {
  fullscreenToken += 1;
}

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
/** 记一行「窗口此刻的真实状态」，供全屏时间线使用。 */
async function describeWindow(win: {
  isFullscreen: () => Promise<boolean>;
  isMaximized: () => Promise<boolean>;
}): Promise<string> {
  try {
    const [fullscreen, maximized] = await Promise.all([
      win.isFullscreen(),
      win.isMaximized(),
    ]);
    return '全屏=' + fullscreen + ' 最大化=' + maximized;
  } catch {
    return '全屏=? 最大化=?';
  }
}

export async function enterFullscreen(): Promise<boolean> {
  if (!isTauriEnvironment()) return true;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();

  // 用户报「退出全屏有诡异的回弹」：界面上只看到弹一下，日志里必须能分辨成因——
  // 是 maximize 状态被改了、还是矩形跳了、还是 tao 的还原动画在跑。
  // 因此进出的每一步都打点，和时间线（Rust 侧 [窗口] 尺寸变化）对得上。
  const startedAt = performance.now();
  tracePlayback('全屏 进入开始 ' + (await describeWindow(win)));

  // 领取本次进入的所有权令牌：之后每一步写状态前都要复核自己还持有它。
  fullscreenToken += 1;
  const token = fullscreenToken;
  const stillOwner = () => fullscreenToken === token;

  // 关键步骤：先静默解除最大化，否则客户区会被裁到工作区（任务栏之上）。
  let wasMaximized = false;
  try {
    wasMaximized = await win.isMaximized();
  } catch {
    wasMaximized = false;
  }
  // 只在仍持有令牌时落账；中途被 leaveFullscreen 作废就整段放弃，
  // 免得把"上一次进入"的状态写进这一次的记录里。
  if (stillOwner()) wasMaximizedBeforeFullscreen = wasMaximized;
  if (wasMaximized) {
    const cleared = await clearMaximizedSilently();
    tracePlayback(
      '全屏 静默解除最大化 返回=' + cleared + ' ' + (await describeWindow(win)),
    );
  }

  try {
    await win.setFullscreen(true);
  } catch {
    // 权限或环境不支持：如实返回当前真实状态。
    // 这里**必须**把状态复位：旧实现在这条退出路径上留着 wasMaximized=true，
    // 下一次 leaveFullscreen 会消费这个脏值去走 window_finish_fullscreen，
    // 而窗口其实从没进过全屏 —— 按 Rust 侧注释，后果是把"还原矩形"钉死。
    tracePlayback('全屏 setFullscreen(true) 抛错，改用真实查询');
    if (stillOwner()) wasMaximizedBeforeFullscreen = false;
    try {
      return await win.isFullscreen();
    } catch {
      return false;
    }
  }
  // 进全屏失败（轮询没等到 true）：同样不留脏状态，否则它会在退出时被消费。
  const actual = await waitForState(win, true);
  if (!actual && stillOwner()) wasMaximizedBeforeFullscreen = false;
  tracePlayback(
    '全屏 进入完成 结果=' +
      actual +
      ' 耗时=' +
      Math.round(performance.now() - startedAt) +
      'ms',
  );
  return actual;
}

/** 退出全屏，并还原进入前的最大化状态。返回**已核实**的全屏状态。 */
export async function leaveFullscreen(): Promise<boolean> {
  if (!isTauriEnvironment()) return false;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();

  // 作废任何还在半路上的 enter 的所有权，然后才读状态。
  revokeFullscreenOwnership();
  const startedAt = performance.now();
  tracePlayback(
    '全屏 退出开始 ' +
      (await describeWindow(win)) +
      ' 进全屏前曾最大化=' +
      wasMaximizedBeforeFullscreen,
  );

  try {
    if (await win.isFullscreen()) await win.setFullscreen(false);
    // 收尾必须紧跟 setFullscreen(false)，不能等状态轮询跑完。
    //
    // 2026-10 用户报告「退出全屏有诡异回弹」。tao 的 set_fullscreen(false) 走
    // ShowWindow(SW_RESTORE)，系统会播一段"从全屏缩回窗口"的过渡动画；旧实现
    // 先 waitForState 轮询最多 6×90ms（≈0.5 秒）才做收尾，动画基本播完了，用户
    // 完整看到"先缩一下、再弹回去"。这里改成短等待（2 次，够了就让 tao 把状态
    // 切过去）后**立刻**用一次 SetWindowPlacement 把窗口钉到最终状态，动画刚起
    // 头就被打断；剩下的轮询只作事后校验，不再决定收尾时机。
    await waitForState(win, false, 2);
    if (wasMaximizedBeforeFullscreen) {
      // 收尾必须走后端：prepare 已把窗口"常规位置"覆盖成整屏矩形（原地解除最大化
      // 的代价），这里直接 maximize() 会把还原尺寸永久钉死在整屏——标题栏的
      // "向下还原"从此还原回整屏，放大缩小一个样。后端把进全屏前暂存的矩形写回，
      // 再一步最大化。返回 false 表示没有暂存（进全屏前没最大化，或走了
      // unmaximize 回退——那条路不覆盖还原矩形），按旧路径普通最大化即可。
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const restored = await invoke<boolean>('window_finish_fullscreen');
        tracePlayback('全屏 收尾 window_finish_fullscreen 返回=' + restored);
        if (!restored) await win.maximize();
      } catch {
        // 旧版本后端没有该命令：退回普通最大化，不阻塞退出全屏。
        await win.maximize();
      }
    }
    const stillFullscreen = await waitForState(win, false, 4);
    if (stillFullscreen) {
      // 极少数情况（窗口线程忙）：如实记一笔，别让日志谎报已退出。
      tracePlayback('全屏 退出后仍为全屏状态（轮询超时）');
    }
  } catch {
    // 忽略：下次进入播放器时会重新校正。
  } finally {
    wasMaximizedBeforeFullscreen = false;
  }
  tracePlayback(
    '全屏 退出完成 耗时=' + Math.round(performance.now() - startedAt) + 'ms',
  );
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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, X, Download, CheckCircle2, Power } from 'lucide-react';
import {
  cancelUpdateDownload,
  createDownloadJobId,
  downloadUpdate,
  formatBytes,
  installUpdate,
  listenDownloadProgress,
  probeUpdateNetwork,
  revealUpdate,
  type DownloadProgress,
  type NetworkProbe,
  type UpdateInfo,
} from '../../services/updater';
import { FluentButton } from './FluentButton';

interface UpdateDialogProps {
  /** 已确认存在的新版本信息。 */
  info: UpdateInfo;
  /** 用户选了"稍后"或安装失败后关掉。 */
  onClose: () => void;
}

/**
 * 更新流程的四个相位。
 *
 * 刻意用判别式而不是 `isDownloading && hasError && ...` 那套布尔组合：
 * 那些组合能表达出"正在下载又已完成"这种非法态，而非法态就是界面上
 * 按钮全灰、进度条不动这类 bug 的来源。
 */
type Phase = 'idle' | 'downloading' | 'downloaded' | 'installing';

/**
 * 「发现新版本，是否升级？」弹窗。
 *
 * 受控组件：**谁发现的新版本谁负责传 info 进来**，这里只管下载与安装。
 * 之前这段逻辑和"启动时自动检查"是写死在同一个组件里的，于是标题栏想复用
 * 就只能再抄一份下载/安装流程——两处各自维护进度与错误处理，必然漂移。
 *
 * 三条克制：
 *   1. 下载与安装全程有进度与可取消的退路，不是黑盒；
 *   2. 安装失败不静默：把安装程序的报错原样显示，并给出"打开所在文件夹"的退路；
 *   3. 关闭过后不再重复打扰同一个版本（由调用方记忆）。
 */
export const UpdateDialog: React.FC<UpdateDialogProps> = ({ info, onClose }) => {
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 静默安装失败时保留路径，让用户能自己把包打开。 */
  const [savedPath, setSavedPath] = useState<string | null>(null);
  /** 下载速率（字节/秒），给"还有多久"一个直观参考。 */
  const [speed, setSpeed] = useState(0);
  /** 网络预检结论：决定展示"直连"还是"国内加速通道"。null 表示还没测出来。 */
  const [network, setNetwork] = useState<NetworkProbe | null>(null);

  /**
   * 本次下载的任务号。
   *
   * 后端的进度是**广播**（`app.emit`），而设置页也常驻 DOM 且订阅同一个事件。
   * 不带任务号就会出现：在弹窗里下载，设置页跟着弹一个「安装包已下载」的 toast，
   * 两边的进度条还互相覆盖。这里只认自己这一号。
   */
  const jobIdRef = useRef<string | null>(null);
  /** 上一次收到进度的时间与字节数，用来算速率。 */
  const sampleRef = useRef<{ at: number; received: number } | null>(null);
  /** 已经处理过 `done`，避免"事件先到 + Promise 后 resolve"重复收尾。 */
  const settledRef = useRef(false);

  // 下载进度挂成常驻监听，而不是等 phase 变化后才订阅：首包可能先于 effect 到达。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenDownloadProgress(next => {
      if (disposed) return;
      // 只处理自己发起的那一次下载（见 jobIdRef 的注释）。
      if (!jobIdRef.current || next.jobId !== jobIdRef.current) return;
      if (settledRef.current && !next.done) return;

      setProgress(next);

      if (next.done) {
        settledRef.current = true;
        setSpeed(0);
        return;
      }

      // 速率：每 500ms 采样一次，避免数字疯狂跳动。
      const now = Date.now();
      const sample = sampleRef.current;
      if (!sample) {
        sampleRef.current = { at: now, received: next.received };
      } else if (now - sample.at >= 500) {
        const elapsed = (now - sample.at) / 1000;
        const delta = next.received - sample.received;
        if (elapsed > 0 && delta >= 0) setSpeed(delta / elapsed);
        sampleRef.current = { at: now, received: next.received };
      }
    }).then(off => {
      if (disposed) off();
      else unlisten = off;
    });
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  /**
   * 下载。
   *
   * ## 先预检网络，再下载（2026-10-18 用户需求）
   *
   * 点「立即下载」时先探测 GitHub 能不能正常访问：
   *   - 能 → 走默认方案（直连），不碰镜像；
   *   - 不能/太慢 → 走国内加速通道。
   *
   * 预检失败**不阻断下载**：后端在真正下载时会再判一次，这里只是为了让用户
   * 在进度条出现前就看到"正在检测网络/已切换到加速通道"，而不是干等。
   *
   * 下载完成后**不自动安装**：需求是"下载完成后提示，询问是否关闭程序"。
   * 自动安装会在用户还没读完提示时就把进程干掉，等于剥夺了最后一步的决定权。
   */
  const startUpdate = useCallback(async () => {
    if (!info.assetUrl || !info.assetName) {
      setError('该发布没有可下载的安装包。');
      return;
    }
    const jobId = createDownloadJobId();
    jobIdRef.current = jobId;
    settledRef.current = false;
    sampleRef.current = null;

    setPhase('downloading');
    setProgress(null);
    setError(null);
    setSpeed(0);
    setNetwork(null);

    // 预检：只影响提示文案，不阻断流程。
    try {
      const probe = await probeUpdateNetwork(info.assetUrl);
      setNetwork(probe);
    } catch {
      // 探测失败就用后端下载时的判定，不打扰用户。
    }

    try {
      const path = await downloadUpdate(info.assetUrl, info.assetName, jobId, info.assetDigest);
      setSavedPath(path);
      setPhase('downloaded');
      setProgress(current => (current
        ? { ...current, percent: 100, done: true, error: null, path }
        : current));
    } catch (downloadError) {
      setPhase('idle');
      setError(downloadError instanceof Error ? downloadError.message : String(downloadError));
    }
  }, [info]);

  /** 确认安装：启动安装向导，后端会先返回、再退出本进程。 */
  const confirmInstall = useCallback(async () => {
    if (!savedPath) return;
    setPhase('installing');
    setError(null);
    try {
      await installUpdate(savedPath);
      // 正常情况下后端已经 spawn 了安装器，800ms 后退出本进程。
      // 保持 installing 相位：界面停在"正在启动安装程序…"，不再给可点按钮。
    } catch (installError) {
      setPhase('downloaded');
      setError(installError instanceof Error ? installError.message : String(installError));
    }
  }, [savedPath]);

  /**
   * 关闭弹窗。
   *
   * ## 顺序很重要（2026-10-18 修「取消也关不掉」）
   *
   * 旧实现是 `await cancelUpdateDownload()` **再** `onClose()`。后端那条命令如果
   * 卡住（或 IPC 恰好没回），`onClose` 就永远不执行 —— 用户点「取消」和点「X」
   * 都没反应，弹窗变成一个关不掉的死层。
   *
   * 现在反过来：**先关界面**（这是用户唯一感知得到的动作），取消下载作为
   * 后台副作用发出去、失败也不影响关闭。取消是"尽力而为"，关闭必须是"一定发生"。
   */
  const requestClose = useCallback(() => {
    const jobId = jobIdRef.current;
    onClose();
    if (phase === 'downloading' && jobId) {
      void cancelUpdateDownload(jobId).catch(() => {});
    }
  }, [onClose, phase]);

  const downloading = phase === 'downloading';
  const installing = phase === 'installing';
  const downloaded = phase === 'downloaded';
  const percent = progress?.percent ?? 0;

  /** 已下载 / 总大小 · 速率。信息不够时降级成"正在连接…"。 */
  const progressLabel = (() => {
    if (!progress) return '正在连接…';
    if (progress.total > 0) {
      const base = `${formatBytes(progress.received)} / ${formatBytes(progress.total)} · ${progress.percent}%`;
      return speed > 0 ? `${base} · ${formatBytes(speed)}/s` : base;
    }
    if (progress.received > 0) {
      const base = `已下载 ${formatBytes(progress.received)}`;
      return speed > 0 ? `${base} · ${formatBytes(speed)}/s` : base;
    }
    return '正在连接…';
  })();

  /**
   * 必须用 Portal 挂到 `<body>`，不能就地渲染。
   *
   * ## 为什么（2026-10-18 修「更新弹窗撑破、文字竖排」）
   *
   * 这个弹窗的宿主是 `VersionBadge` → `TitleBar`，而标题栏上有 `backdrop-blur-xl`。
   * **`backdrop-filter` 会为后代创建包含块**，于是弹窗根节点的 `fixed inset-0`
   * 不再是"相对视口"，而是**相对那条 40px 高的标题栏** —— 宽高被压扁成一条，
   * 里面的文字只能逐字换行，看起来就是"弹窗炸了、界面出错"。
   *
   * 同类坑在项目里已有记录（`App.tsx` 关于 `contain: layout paint` 与 fixed 的注释）。
   * 挂到 body 之后，`fixed` 恢复相对视口，与宿主有没有滤镜/变换/contain 全都无关。
   *
   * 用 Portal 而不是把弹窗上提到 `App` 顶层：前者不需要把"谁发现了新版本"这件事
   * 沿着组件树往上搬，`VersionBadge` 仍然是唯一的发现方与持有方。
   *
   * ## ⚠️ 但 Portal 只搬 DOM，**不搬 React 事件树**（2026-10-18 修「所有按钮点了没反应」）
   *
   * 这是让整块弹窗变成死层的真正原因，也是前几次修复没打到的地方：
   *
   * React 的事件是**按 fiber 树**（也就是组件树）派发的，不是按 DOM 树。
   * 这个弹窗的 fiber 父链仍然是 `VersionBadge → TitleBar`，而 `TitleBar` 的
   * `<header>` 上挂着 `onMouseDown={handleDragStart}`，里面会调
   * `getCurrentWindow().startDragging()`。
   *
   * 于是用户按下弹窗里任何一颗按钮时：
   *   1. mousedown 沿组件树冒泡到 `<header>`，命中 `handleDragStart`；
   *   2. `target.closest('[data-window-interactive]')` 判断的是**弹窗里的按钮**，
   *      它当然不在标题栏的交互区里，于是判定为"拖窗口"；
   *   3. 系统进入窗口拖动模态 —— 鼠标被窗口捕获，**`mouseup` 不会落到按钮上**，
   *      浏览器因此不派发 `click`。
   *
   * 表现就是：三颗按钮（立即下载 / 取消 / 关闭）全都"点了没反应"，
   * 连取消都关不掉——因为取消按钮的 click 根本没触发过。
   *
   * 修复分两层，这里和 `TitleBar` 各一道：
   *   - 这里：根节点 `stopPropagation`，把事件挡在弹窗内；
   *   - `TitleBar`：拖拽前校验 `currentTarget.contains(target)`，从源头拒绝
   *     任何来自 Portal 的事件（见那里的注释）。
   */
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh] px-6"
      data-window-interactive
      // 挡掉标题栏的拖拽处理器：Portal 只搬 DOM，不搬 React 事件树。
      onMouseDown={event => event.stopPropagation()}
      onPointerDown={event => event.stopPropagation()}
    >
      <div className="absolute inset-0 bg-slate-900/25" onClick={requestClose} />
      <div
        className="relative w-full max-w-md rounded-2xl bg-white shadow-fluent-lg border border-slate-200/80 p-5 flex flex-col gap-3"
        role="dialog"
        aria-modal="true"
        aria-label={`发现新版本 v${info.latestVersion}`}
      >
        <div className="flex items-start gap-2">
          <Sparkles className="w-4 h-4 text-blue-600 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-slate-800">
              发现新版本 v{info.latestVersion}，是否升级？
            </p>
            <p className="text-[11px] text-slate-500 mt-0.5">
              当前 v{info.currentVersion}
              {info.assetSize > 0 ? ` · 安装包 ${formatBytes(info.assetSize)}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            aria-label="关闭更新弹窗"
            className="shrink-0 text-slate-400 hover:text-slate-600 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {info.notes.trim() && (
          <p className="text-[11px] text-slate-600 leading-relaxed whitespace-pre-wrap max-h-28 overflow-hidden">
            {info.notes.trim()}
          </p>
        )}

        {/* 下载前告知走的是加速通道，并说明会做完整性校验。
            用户有权知道"安装包不是直接从 GitHub 拿的"——镜像加速对国内网络是刚需，
            但透明度不能因此打折。 */}
        {!downloading && !downloaded && !installing && (
          <p className="text-[10px] text-slate-400 leading-relaxed">
            国内网络会自动选择最快的下载通道并分片并发下载，完成后校验 SHA-256 确保文件未被篡改。
          </p>
        )}

        {/* ── 下载进度：位于操作按钮的**正上方**（需求 1）────────────── */}
        {downloading && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] font-semibold text-slate-700">正在下载更新</span>
              <span className="text-[11px] font-mono font-bold text-blue-600">{percent}%</span>
            </div>
            <div
              className="h-2 w-full rounded-full bg-blue-200/60 overflow-hidden"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full bg-blue-600 rounded-full transition-[width] duration-200 ease-out"
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="text-[10px] font-mono text-slate-500">{progressLabel}</span>
            {/* 走的是哪条通道：直连还是国内加速。用户有权知道。
                预检还没回来时显示"正在检测网络"，避免这一行忽隐忽现。 */}
            <span className="text-[10px] text-slate-400">
              {network
                ? network.route === 'direct'
                  ? '通道：GitHub 直连'
                  : '通道：国内加速（分片并发）'
                : '正在检测网络…'}
            </span>
          </div>
        )}

        {/* ── 下载完成：询问是否关闭程序（需求 2）────────────────────── */}
        {downloaded && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 flex items-start gap-2">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-bold text-emerald-800">安装包已下载完成</p>
              <p className="text-[11px] leading-relaxed text-emerald-700 mt-0.5">
                安装需要先关闭本程序。是否现在关闭程序并开始安装？
              </p>
              {savedPath && (
                <p
                  className="text-[10px] font-mono text-emerald-600/80 mt-1 truncate"
                  title={savedPath}
                >
                  {savedPath}
                </p>
              )}
            </div>
          </div>
        )}

        {installing && (
          <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5 text-[11px] leading-relaxed text-blue-800">
            正在关闭程序并启动安装向导…若窗口未自动关闭，请手动关闭本程序后按向导完成安装。
          </div>
        )}

        {error && (
          <div className="text-[11px] text-amber-700 leading-relaxed">
            {error}
            {savedPath && (
              <button
                type="button"
                onClick={() => {
                  void revealUpdate(savedPath).catch(() => {});
                }}
                className="ml-1 underline cursor-pointer"
              >
                打开所在文件夹
              </button>
            )}
          </div>
        )}

        {/* ── 操作区 ────────────────────────────────────────────── */}
        <div className="flex items-center justify-end gap-2 pt-0.5">
          {!installing && (
            <FluentButton variant="secondary" size="sm" onClick={requestClose}>
              {downloading ? '取消下载' : downloaded ? '稍后' : '取消'}
            </FluentButton>
          )}

          {downloaded ? (
            <FluentButton
              variant="primary"
              size="sm"
              icon={<Power className="w-3.5 h-3.5" />}
              onClick={() => void confirmInstall()}
            >
              关闭程序并安装
            </FluentButton>
          ) : (
            <FluentButton
              variant="primary"
              size="sm"
              disabled={installing || downloading || !info.assetUrl}
              icon={<Download className="w-3.5 h-3.5" />}
              onClick={() => void startUpdate()}
            >
              {installing ? '正在启动…' : downloading ? '正在下载…' : '立即下载'}
            </FluentButton>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};

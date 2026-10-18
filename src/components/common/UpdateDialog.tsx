import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, X, Download } from 'lucide-react';
import {
  downloadUpdate,
  formatBytes,
  installUpdate,
  listenDownloadProgress,
  revealUpdate,
  type DownloadProgress,
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
  const [phase, setPhase] = useState<'idle' | 'downloading' | 'installing'>('idle');
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 静默安装失败时保留路径，让用户能自己把包打开。 */
  const [savedPath, setSavedPath] = useState<string | null>(null);

  // 下载进度挂成常驻监听，而不是在点击时才订阅（StrictMode 重挂会丢事件）。
  useEffect(() => {
    if (phase !== 'downloading') return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenDownloadProgress(next => {
      if (disposed) return;
      setProgress(next);
    }).then(off => {
      if (disposed) off();
      else unlisten = off;
    });
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [phase]);

  const startUpdate = useCallback(async () => {
    if (!info.assetUrl || !info.assetName) {
      setError('该发布没有可下载的安装包。');
      return;
    }
    setPhase('downloading');
    setProgress(null);
    setError(null);
    try {
      const path = await downloadUpdate(info.assetUrl, info.assetName);
      setSavedPath(path);
      setPhase('installing');
      /**
       * 安装这一步**必然会把本进程结束掉**（后端 spawn 安装包后 800ms 退出）。
       *
       * 所以这里不能像旧实现那样在 resolve 之后写一句"应用未能自动退出"——
       * 那是在描述一个正常流程。现在改成：
       *   - resolve  → 显示"正在重启，请稍候"，然后什么都不做，等进程消失；
       *   - reject   → 只有真的启动失败（路径非法、文件损坏）才落错误态。
       *
       * `installUpdate` 抛错时前端还活着，用户能看错误、能点"打开所在文件夹"。
       */
      try {
        await installUpdate(path);
        setError(null);
        // 保持 `installing` 相位：界面停在"正在重启…"，不再给任何可点按钮。
      } catch (installError) {
        setPhase('idle');
        setError(installError instanceof Error ? installError.message : String(installError));
      }
    } catch (downloadError) {
      setPhase('idle');
      setError(downloadError instanceof Error ? downloadError.message : String(downloadError));
    }
  }, [info]);

  const busy = phase !== 'idle';

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
   */
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh] px-6">
      <div className="absolute inset-0 bg-slate-900/25" onClick={busy ? undefined : onClose} />
      <div className="relative w-full max-w-md rounded-2xl bg-white shadow-fluent-lg border border-slate-200/80 p-5 flex flex-col gap-3">
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
          {!busy && (
            <button
              type="button"
              onClick={onClose}
              aria-label="稍后再说"
              className="shrink-0 text-slate-400 hover:text-slate-600 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {info.notes.trim() && (
          <p className="text-[11px] text-slate-600 leading-relaxed whitespace-pre-wrap max-h-28 overflow-hidden">
            {info.notes.trim()}
          </p>
        )}

        {busy && (
          <div className="flex flex-col gap-1.5">
            <div className="h-1.5 w-full rounded-full bg-blue-200/60 overflow-hidden">
              {phase === 'installing' ? (
                <div className="h-full w-1/3 bg-blue-600 animate-pulse" />
              ) : (
                <div
                  className="h-full bg-blue-600 rounded-full transition-[width] duration-200 ease-out"
                  style={{ width: `${progress?.percent ?? 0}%` }}
                />
              )}
            </div>
            <span className="text-[10px] font-mono text-slate-500">
              {phase === 'installing'
                ? '安装程序已启动，应用即将重启…'
                : progress && progress.total > 0
                  ? `${formatBytes(progress.received)} / ${formatBytes(progress.total)} · ${progress.percent}%`
                  : '正在连接…'}
            </span>
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

        <div className="flex items-center justify-end gap-2 pt-0.5">
          {!busy && (
            <FluentButton variant="secondary" size="sm" onClick={onClose}>
              稍后
            </FluentButton>
          )}
          <FluentButton
            variant="primary"
            size="sm"
            disabled={busy || !info.assetUrl}
            icon={<Download className="w-3.5 h-3.5" />}
            onClick={() => void startUpdate()}
          >
            {busy ? '正在处理…' : '立即更新'}
          </FluentButton>
        </div>
      </div>
    </div>,
    document.body,
  );
};

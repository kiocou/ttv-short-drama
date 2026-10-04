import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, X, Download } from 'lucide-react';
import {
  checkForUpdate,
  downloadUpdate,
  formatBytes,
  installUpdate,
  listenDownloadProgress,
  revealUpdate,
  type DownloadProgress,
  type UpdateInfo,
} from '../../services/updater';
import { isTauriEnvironment } from '../../services/ipc';
import { FluentButton } from './FluentButton';

/** 两次自动检查之间的最短间隔。GitHub 未认证配额是 60 次/小时，共享给所有用户之外的本机。 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** localStorage 键：上次自动检查的时刻，以及用户已对哪个版本说过"稍后"。 */
const LAST_CHECK_KEY = 'ttv_auto_update_check';
const DISMISSED_KEY = 'ttv_auto_update_dismissed';

/**
 * 启动时的更新提示：有新版本就主动问用户要不要更新。
 *
 * 与设置页「检查更新」是两条独立入口：那条由用户主动触发，这条只在启动时出现一次，
 * 且**必须让用户选**——自动更新不等于可以不打招呼就把应用换掉。
 *
 * 三条克制，避免它变成骚扰：
 *   1. 检查失败一律静默。启动路径上的网络错误不该变成一个红框（设置页那条才会报错）。
 *   2. 6 小时内只自动检查一次，且用户对某个版本点过「稍后」后不再问同一个版本。
 *   3. 下载与安装全程有进度与可取消的退路，不是黑盒。
 */
export const UpdatePrompt: React.FC = () => {
  const canUpdate = isTauriEnvironment();

  /** 有新版本时的信息；null 表示不提示。 */
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [phase, setPhase] = useState<'idle' | 'downloading' | 'installing'>('idle');
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 静默安装失败时保留路径，让用户能自己把包打开。 */
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const dismissedRef = useRef(false);

  // 启动时检查一次。放在 effect 里而不是模块顶层：StrictMode 会双调用 effect，
  // 模块顶层则每次热更新都会打一次 GitHub API。
  useEffect(() => {
    if (!canUpdate) return;
    let disposed = false;

    const last = Number(window.localStorage.getItem(LAST_CHECK_KEY) || '0');
    if (Date.now() - last < CHECK_INTERVAL_MS) return;

    void (async () => {
      try {
        const result = await checkForUpdate();
        if (disposed) return;
        window.localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
        if (!result.hasUpdate) return;
        if (window.localStorage.getItem(DISMISSED_KEY) === result.latestVersion) return;
        setInfo(result);
      } catch {
        // 静默：启动路径上的检查失败不该打扰用户。设置页里手动检查才会报出来。
        window.localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
      }
    })();

    return () => {
      disposed = true;
    };
  }, [canUpdate]);

  // 下载进度同样挂成常驻监听，而不是在点击时才订阅（StrictMode 重挂会丢事件）。
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

  const dismiss = useCallback(() => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    // 记住"对这个版本不再问"，否则用户点一次「稍后」，下次启动还会被同一个弹窗拦路。
    if (info) window.localStorage.setItem(DISMISSED_KEY, info.latestVersion);
    setInfo(null);
  }, [info]);

  const startUpdate = useCallback(async () => {
    if (!info?.assetUrl || !info.assetName) {
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
      try {
        await installUpdate(path);
        // 正常情况下后端已经 exit 了，应用正在关闭。走到这里说明没退出，
        // 如实说明而不是让界面永远转下去。
        setPhase('idle');
        setError('安装器已启动，但应用未能自动退出，请手动关闭后重试。');
      } catch (installError) {
        setPhase('idle');
        setError(installError instanceof Error ? installError.message : String(installError));
      }
    } catch (downloadError) {
      setPhase('idle');
      setError(downloadError instanceof Error ? downloadError.message : String(downloadError));
    }
  }, [info]);

  if (!info) return null;

  const busy = phase !== 'idle';

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh] px-6">
      <div className="absolute inset-0 bg-slate-900/25" onClick={busy ? undefined : dismiss} />
      <div className="relative w-full max-w-md rounded-2xl bg-white shadow-fluent-lg border border-slate-200/80 p-5 flex flex-col gap-3">
        <div className="flex items-start gap-2">
          <Sparkles className="w-4 h-4 text-blue-600 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-slate-800">
              发现新版本 v{info.latestVersion}
            </p>
            <p className="text-[11px] text-slate-500 mt-0.5">
              当前 v{info.currentVersion}
              {info.assetSize > 0 ? ` · 安装包 ${formatBytes(info.assetSize)}` : ''}
            </p>
          </div>
          {!busy && (
            <button
              type="button"
              onClick={dismiss}
              aria-label="稍后再说"
              className="shrink-0 text-slate-400 hover:text-slate-600 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {info.notes.trim() && (
          <p className="text-[11px] text-slate-600 leading-relaxed whitespace-pre-wrap line-clamp-5 max-h-28 overflow-hidden">
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
                ? '下载完成，正在启动安装程序…'
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
            <FluentButton variant="secondary" size="sm" onClick={dismiss}>
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
    </div>
  );
};

export default UpdatePrompt;
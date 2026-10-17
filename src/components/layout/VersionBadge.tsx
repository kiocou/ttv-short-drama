import React, { useCallback, useEffect, useState } from 'react';
import { isTauriEnvironment } from '../../services/ipc';
import { checkForUpdate, type UpdateInfo } from '../../services/updater';
import { useAppStore } from '../../stores/useAppStore';
import { UpdateDialog } from '../common/UpdateDialog';

/** 两次自动检查之间的最短间隔。GitHub 未认证配额是 60 次/小时，全机共享。 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LAST_CHECK_KEY = 'ttv_auto_update_check';
/**
 * 上一次检查的结论。
 *
 * 必须缓存：徽章是常驻显示，如果只在检查的那一刻知道"有新版本"，用户重启一次
 * 就又看到蓝色的旧版本号——而节流是 6 小时，等于坏消息被藏起来了。
 */
const CACHED_LATEST_KEY = 'ttv_auto_update_latest';

/**
 * 标题栏上的版本徽章：平时显示当前版本，有新版本时整块变红。
 *
 * 点一下两种情况：
 *   - 有新版 → 弹出「发现新版本，是否升级？」（`UpdateDialog`）；
 *   - 没新版 → 一句话告诉他已是最新，不弹窗。
 *
 * 为什么把更新提示从"启动弹窗"改成这里：启动弹窗会拦在用户要做的事前面，而版本
 * 本来就是一个**状态**——状态该常驻显示、由用户决定何时处理。顺带省掉了"同一天
 * 反复弹同一个版本"的打扰。
 */
export const VersionBadge: React.FC = () => {
  const { showToast } = useAppStore();
  const [version, setVersion] = useState('');
  /** 已知的可用新版本号；null 表示当前已是最新（或还没检查过）。 */
  const [pendingVersion, setPendingVersion] = useState<string | null>(null);
  /** 弹窗数据：只有点开徽章、真正拿到 Release 详情后才非空。 */
  const [dialogInfo, setDialogInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    let disposed = false;

    // 当前版本不联网（`app_version` 读的是编译进二进制的 crate 版本）。
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<string>('app_version'))
      .then(value => {
        if (!disposed) setVersion(value);
      })
      .catch(() => {});

    const cached = window.localStorage.getItem(CACHED_LATEST_KEY);
    if (cached) setPendingVersion(cached);

    const last = Number(window.localStorage.getItem(LAST_CHECK_KEY) || '0');
    if (Date.now() - last < CHECK_INTERVAL_MS) {
      return () => {
        disposed = true;
      };
    }

    void (async () => {
      try {
        const result = await checkForUpdate();
        window.localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
        const latest = result.hasUpdate ? result.latestVersion : '';
        window.localStorage.setItem(CACHED_LATEST_KEY, latest);
        // 用户刚在设置页手动查过、或点过更新：以本次结果为准，别让缓存的旧结论打架。
        if (!disposed) setPendingVersion(latest || null);
      } catch {
        // 启动路径上的网络失败一律静默：这不是用户主动发起的操作，弹红字只会吓人。
        window.localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
      }
    })();

    return () => {
      disposed = true;
    };
  }, []);

  const handleClick = useCallback(
    async (event: React.MouseEvent) => {
      // 外层是"点标题回发现页"的可点区域，徽章的点击不能漏出去。
      event.stopPropagation();
      if (checking) return;
      setChecking(true);
      try {
        const info = await checkForUpdate();
        const latest = info.hasUpdate ? info.latestVersion : '';
        window.localStorage.setItem(CACHED_LATEST_KEY, latest);
        window.localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
        setPendingVersion(latest || null);
        if (info.hasUpdate) setDialogInfo(info);
        else showToast(`当前已是最新版本 v${info.currentVersion}`, 'success');
      } catch (error) {
        showToast(error instanceof Error ? error.message : '检查更新失败', 'error');
      } finally {
        setChecking(false);
      }
    },
    [checking, showToast],
  );

  const closeDialog = useCallback(() => setDialogInfo(null), []);

  return (
    <>
      <button
        type="button"
        onClick={event => void handleClick(event)}
        data-window-interactive
        title={
          pendingVersion
            ? `发现新版本 v${pendingVersion}，点击查看`
            : `当前版本 v${version || '—'}，点击检查更新`
        }
        className={`text-[9px] font-bold px-1.5 py-0.5 rounded-md border shadow-2xs cursor-pointer transition-colors active:scale-95 ${
          pendingVersion
            ? 'text-white bg-red-500 border-red-400/70 hover:bg-red-600'
            : 'text-blue-600 bg-blue-50/90 border-blue-200/60 hover:bg-blue-100'
        }`}
      >
        {pendingVersion ? `有新版本 v${pendingVersion}` : `v${version || '—'}`}
      </button>

      {dialogInfo && <UpdateDialog info={dialogInfo} onClose={closeDialog} />}
    </>
  );
};

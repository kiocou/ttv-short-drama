import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useAppStore } from '../../stores/useAppStore';
import { MicaCard } from '../common/MicaCard';
import { FluentButton } from '../common/FluentButton';
import { FluentSlider } from '../common/FluentSlider';
import {
  checkForUpdate,
  downloadUpdate,
  formatBytes,
  listenDownloadProgress,
  revealUpdate,
  type DownloadProgress,
  type UpdateInfo,
} from '../../services/updater';
import { isTauriEnvironment } from '../../services/ipc';
import { 
  Settings, 
  Tv, 
  HardDrive, 
  FileText, 
  Check, 
  RefreshCw,
  FolderOpen,
  MonitorPlay,
  Clock,
  Gauge,
  Download,
  Sparkles,
  FolderSearch
} from 'lucide-react';

export const SettingsView: React.FC = () => {
  const { settings, updateSettings, clearCache, cacheUsage, refreshCacheUsage } = useSettingsStore();
  const { showToast } = useAppStore();

  const [isCleaning, setIsCleaning] = useState(false);

  /**
   * 检查更新的状态机。
   *
   * 刻意只用一个判别式而不是四个布尔值：`isChecking && hasUpdate && error` 这种
   * 组合没有意义，但布尔值能表达出来——那些非法态就是界面上一堆小 bug 的来源。
   */
  const [updateState, setUpdateState] = useState<
    | { kind: 'idle' }
    | { kind: 'checking' }
    | { kind: 'result'; info: UpdateInfo }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  /** 已下载的安装包路径；“打开所在文件夹”按钮用它。 */
  const [savedPath, setSavedPath] = useState<string | null>(null);
  /** 当前版本号：从二进制里拿，不在前端另写一份。 */
  const [appVersion, setAppVersion] = useState('');
  const canUpdate = isTauriEnvironment();

  // 版本号只在挂载时取一次（纯本地，不走网络）。
  useEffect(() => {
    if (!canUpdate) return;
    let disposed = false;
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<string>('app_version'))
      .then(version => { if (!disposed) setAppVersion(version); })
      .catch(() => {});
    return () => { disposed = true; };
  }, [canUpdate]);

  // 订阅下载进度。放 useEffect 而不是在点击里临时监听：React 18+ 的 StrictMode
  // 会刻意重挂组件，临时监听很容易被重挂弄丢一次进度。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenDownloadProgress(next => {
      if (disposed) return;
      setProgress(next);
      if (next.done) {
        setIsDownloading(false);
        if (next.path) {
          setSavedPath(next.path);
          showToast(`安装包已下载（${next.path}）`, 'success');
        } else if (next.error) {
          showToast(`下载失败：${next.error}`, 'error');
        }
      }
    }).then(off => {
      if (disposed) off();
      else unlisten = off;
    });
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [showToast]);

  const handleCheckUpdate = async () => {
    setUpdateState({ kind: 'checking' });
    setSavedPath(null);
    setProgress(null);
    try {
      const info = await checkForUpdate();
      setUpdateState({ kind: 'result', info });
      showToast(info.hasUpdate ? `发现新版本 ${info.latestVersion}` : '当前已是最新版本', info.hasUpdate ? 'info' : 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setUpdateState({ kind: 'error', message });
      showToast(`检查更新失败：${message}`, 'error');
    }
  };

  const handleDownload = async () => {
    if (updateState.kind !== 'result') return;
    const { info } = updateState;
    if (!info.assetUrl || !info.assetName) {
      showToast('该发布没有可下载的安装包', 'warning');
      return;
    }
    setIsDownloading(true);
    setProgress(null);
    try {
      // 进度走事件，这里只等最终路径；下载失败会抛错，同时事件也会带一次 done。
      const path = await downloadUpdate(info.assetUrl, info.assetName);
      setSavedPath(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast(`下载失败：${message}`, 'error');
      setIsDownloading(false);
    }
  };

  const handleReveal = async () => {
    if (!savedPath) return;
    try {
      await revealUpdate(savedPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast(`无法打开文件夹：${message}`, 'error');
    }
  };

  // 进入设置页时刷新真实占用：缓存由后台自动增删，静态快照会过期。
  useEffect(() => {
    void refreshCacheUsage();
  }, [refreshCacheUsage]);

  const cacheMb = cacheUsage.bytes / 1024 / 1024;
  const cacheLabel = cacheMb >= 1024 ? (cacheMb / 1024).toFixed(2) + ' GB' : cacheMb.toFixed(1) + ' MB';

  const handleClearCache = async () => {
    setIsCleaning(true);
    try {
      const freed = await clearCache();
      showToast(freed > 0 ? `已成功释放 ${freed} MB 缓存` : '缓存已清理（后端未提供容量统计）', 'success');
    } catch {
      showToast('缓存清理失败', 'error');
    } finally {
      setIsCleaning(false);
    }
  };

  const handleExportLogs = () => {
    const logData = {
      timestamp: new Date().toISOString(),
      // 版本号不再写死：曾经这里是 `v1.0.0`（与实际发布的 0.2.x 完全不符），
      // 导出的诊断日志会带着一个假版本号，反而误导排查。
      app: `TTV Short Drama Desktop v${appVersion || 'unknown'}`,
      os: 'Windows 11 (Mica Light)',
      settings: settings,
    };
    const blob = new Blob([JSON.stringify(logData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ttv-short-drama-diagnostics-${Date.now()}.json`;
    a.click();
    // 延后释放：立刻 revoke 有可能在浏览器的下载真正开工前就把 blob 撤掉，
    // 表现为"提示已导出但文件没出现"。
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    showToast('诊断日志已导出', 'success');
  };

  const qualityOptions = [
    { label: '自动适应', value: 'auto' },
  ];

  return (
    <div className="w-full h-full overflow-y-auto select-none p-6 sm:p-8">
      <div className="max-w-4xl mx-auto flex flex-col gap-6 pb-24">
        {/* 页面主标题 */}
        <div className="pb-4 border-b border-black/[0.05] shrink-0">
          <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-200/50">
              <Settings className="w-4 h-4" />
            </div>
            <span>系统与播放偏好设置</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            自定义默认清晰度、自动连播参数与本地高速缓存
          </p>
        </div>

        {/* 1. 播放偏好设置卡片 */}
        <MicaCard className="p-6 flex flex-col gap-5 shrink-0 animate-fluent-card-in">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-800 pb-3 border-b border-black/[0.04]">
            <Tv className="w-4 h-4 text-blue-600" />
            <span>播放体验偏好</span>
          </div>

          {/* 默认清晰度选择（分段按钮组件） */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h4 className="text-xs font-semibold text-slate-800">首选视频清晰度</h4>
              <p className="text-[11px] text-slate-400 mt-0.5">当剧集包含多个清晰度档位时优先自动切换</p>
            </div>
            <div className="flex items-center p-1 bg-slate-100/90 rounded-xl border border-slate-200/70 shadow-inner flex-shrink-0">
              {qualityOptions.map((opt) => {
                const isActive = settings.defaultQuality === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => updateSettings({ defaultQuality: opt.value as any })}
                    className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150 cursor-pointer ${
                      isActive
                        ? 'fluent-convex-tab text-blue-600'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 自动连播开关（标准的 Windows 11 开关按钮） */}
          <div className="flex items-center justify-between pt-4 border-t border-black/[0.04]">
            <div>
              <h4 className="text-xs font-semibold text-slate-800">剧集自动连播</h4>
              <p className="text-[11px] text-slate-400 mt-0.5">本集临近结尾时弹出圆环倒计时并自动平滑播放下一集</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.autoNext}
              onClick={() => updateSettings({ autoNext: !settings.autoNext })}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                settings.autoNext ? 'bg-blue-600' : 'bg-slate-300'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                  settings.autoNext ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {/* 倒计时秒数滑块 */}
          {settings.autoNext && (
            <div className="flex flex-col gap-2.5 pt-3.5 pb-3 px-4 bg-slate-50/80 rounded-xl border border-slate-200/80 shrink-0 transition-all duration-200 animate-fluent-slide-down">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-700 flex items-center gap-2">
                  <Clock className="w-3.5 h-3.5 text-blue-600" />
                  连播倒计时等待时间
                </span>
                <span className="font-bold text-blue-600 font-mono bg-blue-50 px-2.5 py-0.5 rounded-md border border-blue-200/60">
                  {settings.countdownSeconds} 秒
                </span>
              </div>
              <div className="py-1">
                <FluentSlider
                  value={settings.countdownSeconds}
                  min={3}
                  max={15}
                  step={1}
                  onChange={(val) => updateSettings({ countdownSeconds: val })}
                  tooltipFormat={(v) => `${v} 秒`}
                />
              </div>
              <div className="flex justify-between text-[11px] text-slate-400 font-medium">
                <span>3 秒 (极速连播)</span>
                <span>15 秒 (充裕反应)</span>
              </div>
            </div>
          )}
        </MicaCard>

        {/* 3. 本地存储与缓存卡片 */}
        <MicaCard className="p-6 flex flex-col gap-5 shrink-0 animate-fluent-card-in">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-800 pb-3 border-b border-black/[0.04]">
            <HardDrive className="w-4 h-4 text-slate-700" />
            <span>存储空间与本地缓存</span>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <h4 className="text-xs font-semibold text-slate-800">剧集缓存</h4>
                <span className="text-[11px] font-bold text-blue-600 font-mono bg-blue-50 px-2.5 py-0.5 rounded-md border border-blue-200/60">
                  {cacheLabel}
                </span>
                {cacheUsage.files > 0 && (
                  <span className="text-[10px] text-slate-400 font-mono">
                    {cacheUsage.files} 集
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">
                播放过的剧集会缓存到本地，以便回看与换集时秒开。
                <span className="text-slate-600 font-medium">已开启全自动清理</span>
                ：超过 7 天未播放的剧集、以及总量超过 1 GB 时最旧的剧集，都会自动移除，无需手动操作。
              </p>
            </div>

            {/* 嵌入式按钮底座 */}
            <div className="p-1 bg-slate-100/90 rounded-xl border border-slate-200/70 shadow-inner inline-flex shrink-0 self-start sm:self-center">
              <FluentButton
                variant="secondary"
                size="md"
                disabled={isCleaning}
                icon={<RefreshCw className={`w-3.5 h-3.5 ${isCleaning ? 'animate-spin' : ''}`} />}
                onClick={handleClearCache}
                className="shadow-sm"
              >
                {isCleaning ? '正在清理...' : '立即全部清空'}
              </FluentButton>
            </div>
          </div>
        </MicaCard>

        {/* 4. 版本与更新 */}
        <MicaCard className="p-6 flex flex-col gap-5 shrink-0 animate-fluent-card-in">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-800 pb-3 border-b border-black/[0.04]">
            <Sparkles className="w-4 h-4 text-blue-600" />
            <span>版本与更新</span>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <h4 className="text-xs font-semibold text-slate-800">当前版本</h4>
                <span className="text-[11px] font-bold text-blue-600 font-mono bg-blue-50 px-2.5 py-0.5 rounded-md border border-blue-200/60">
                  v{appVersion || '—'}
                </span>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">
                从 GitHub Releases 拉取最新安装包。下载完成后只会打开文件夹定位到安装包，
                <span className="text-slate-600 font-medium">不会自动安装</span>。
              </p>
            </div>

            <div className="p-1 bg-slate-100/90 rounded-xl border border-slate-200/70 shadow-inner inline-flex shrink-0 self-start sm:self-center">
              <FluentButton
                variant="secondary"
                size="md"
                disabled={!canUpdate || updateState.kind === 'checking'}
                icon={<RefreshCw className={`w-3.5 h-3.5 ${updateState.kind === 'checking' ? 'animate-spin' : ''}`} />}
                onClick={handleCheckUpdate}
                className="shadow-sm"
              >
                {updateState.kind === 'checking' ? '正在检查…' : '检查更新'}
              </FluentButton>
            </div>
          </div>

          {/* 检查失败：如实展示原因（超时 / 限流 / 无 release 都是不同的可排查信号） */}
          {updateState.kind === 'error' && (
            <div className="px-4 py-3 rounded-xl bg-rose-50/80 border border-rose-200/70 text-xs text-rose-700 leading-relaxed">
              检查更新失败：{updateState.message}
            </div>
          )}

          {/* 已是最新 */}
          {updateState.kind === 'result' && !updateState.info.hasUpdate && (
            <div className="px-4 py-3 rounded-xl bg-emerald-50/70 border border-emerald-200/70 text-xs text-emerald-700 flex items-center gap-2">
              <Check className="w-3.5 h-3.5" />
              <span>当前已是最新版本（v{updateState.info.latestVersion}）</span>
            </div>
          )}

          {/* 有新版本 */}
          {updateState.kind === 'result' && updateState.info.hasUpdate && (
            <div className="px-4 py-4 rounded-xl bg-blue-50/60 border border-blue-200/70 flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                <span className="text-xs font-bold text-blue-700">新版本 v{updateState.info.latestVersion} 可用</span>
                {updateState.info.assetSize > 0 && (
                  <span className="text-[10px] font-mono text-slate-500">
                    {formatBytes(updateState.info.assetSize)}
                  </span>
                )}
              </div>

              {/* Release notes：只取前几行，完整内容去 GitHub 看。
                  排版用 `whitespace-pre-wrap` 保留 Markdown 原文的换行。 */}
              {updateState.info.notes.trim() && (
                <p className="text-[11px] text-slate-600 leading-relaxed whitespace-pre-wrap line-clamp-4 max-h-24 overflow-hidden">
                  {updateState.info.notes.trim()}
                </p>
              )}

              {/* 下载进度：只在下载中出现，完成后面板换成“打开文件夹” */}
              {isDownloading && (
                <div className="flex flex-col gap-1.5">
                  <div className="h-1.5 w-full rounded-full bg-blue-200/60 overflow-hidden">
                    <div
                      className="h-full bg-blue-600 rounded-full transition-[width] duration-200 ease-out"
                      style={{ width: `${progress?.percent ?? 0}%` }}
                    />
                  </div>
                  <span className="text-[10px] font-mono text-slate-500">
                    {progress && progress.total > 0
                      ? `${formatBytes(progress.received)} / ${formatBytes(progress.total)} · ${progress.percent}%`
                      : '正在连接…'}
                  </span>
                </div>
              )}

              <div className="flex items-center gap-2 flex-wrap">
                {!savedPath ? (
                  <FluentButton
                    variant="primary"
                    size="sm"
                    disabled={isDownloading || !updateState.info.assetUrl}
                    icon={<Download className="w-3.5 h-3.5" />}
                    onClick={handleDownload}
                  >
                    {isDownloading ? '正在下载…' : '下载安装包'}
                  </FluentButton>
                ) : (
                  <FluentButton
                    variant="primary"
                    size="sm"
                    icon={<FolderSearch className="w-3.5 h-3.5" />}
                    onClick={handleReveal}
                  >
                    打开所在文件夹
                  </FluentButton>
                )}

              </div>
            </div>
          )}
        </MicaCard>

        {/* 5. 关于与日志诊断 */}
        <MicaCard className="p-6 flex flex-col gap-5 shrink-0 animate-fluent-card-in">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-800 pb-3 border-b border-black/[0.04]">
            <FileText className="w-4 h-4 text-slate-700" />
            <span>客户端信息与诊断</span>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex flex-col gap-1.5 text-xs leading-relaxed">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-slate-800">TTV Short Drama 独立桌面客户端</span>
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-200/50">
                  v{appVersion || '—'} Mica Light
                </span>
              </div>
              <p className="text-xs text-slate-500">
                基于 Tauri + React 19 + TypeScript 构建 · 硬件加速渲染已启用
              </p>
            </div>

            {/* 嵌入式按钮底座 */}
            <div className="p-1 bg-slate-100/90 rounded-xl border border-slate-200/70 shadow-inner inline-flex shrink-0 self-start sm:self-center">
              <FluentButton
                variant="secondary"
                size="md"
                icon={<FolderOpen className="w-3.5 h-3.5 text-slate-600" />}
                onClick={handleExportLogs}
                className="shadow-sm"
              >
                导出匿名运行日志
              </FluentButton>
            </div>
          </div>
        </MicaCard>
      </div>
    </div>
  );
};

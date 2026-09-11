import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useEnhancementStore } from '../../stores/useEnhancementStore';
import { useAppStore } from '../../stores/useAppStore';
import { MicaCard } from '../common/MicaCard';
import { FluentButton } from '../common/FluentButton';
import { FluentSlider } from '../common/FluentSlider';
import { 
  Settings, 
  Tv, 
  Sparkles, 
  HardDrive, 
  FileText, 
  Check, 
  RefreshCw,
  FolderOpen,
  MonitorPlay,
  Clock,
  Gauge
} from 'lucide-react';
import { EnhancementEngine } from '../../types/enhancement';

export const SettingsView: React.FC = () => {
  const { settings, updateSettings, clearCache, cacheUsage, refreshCacheUsage } = useSettingsStore();
  const { capabilities, engine, setEngine } = useEnhancementStore();
  const { showToast } = useAppStore();

  const [isCleaning, setIsCleaning] = useState(false);

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
      app: 'TTV Short Drama Desktop v1.0.0',
      os: 'Windows 11 (Mica Light)',
      gpu: capabilities?.gpuName || '未探测',
      driver: capabilities?.driverVersion || '未探测',
      settings: settings,
      engine: engine,
    };
    const blob = new Blob([JSON.stringify(logData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ttv-short-drama-diagnostics-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('诊断日志已导出', 'success');
  };

  const engineOptions: { id: EnhancementEngine; name: string; tag: string; desc: string }[] =
    (capabilities?.supportedEngines ?? []).map(item => ({
      id: item.id,
      name: item.name,
      tag: item.id === 'off' ? '原生' : `${item.targetFps} FPS`,
      desc: item.description,
    }));

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
            自定义默认清晰度、自动连播参数、AI 插帧引擎与本地高速缓存
          </p>
        </div>

        {/* 1. 播放偏好设置卡片 */}
        <MicaCard className="p-6 flex flex-col gap-5 shrink-0 animate-fluent-card-in" style={{ animationDelay: '40ms' }}>
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

        {/* 2. 补帧增强偏好卡片 */}
        <MicaCard className="p-6 flex flex-col gap-5 shrink-0 animate-fluent-card-in" style={{ animationDelay: '90ms' }}>
          <div className="flex items-center justify-between pb-3 border-b border-black/[0.04] flex-wrap gap-2">
            <div className="flex items-center gap-2 text-sm font-bold text-slate-800">
              <Sparkles className="w-4 h-4 text-amber-500" />
              <span>AI 插帧与画质增强</span>
            </div>
            <span className="text-[11px] font-medium text-slate-500 bg-slate-100 px-2.5 py-1 rounded-md">
              硬件环境: {capabilities?.gpuName || '正在探测'}
            </span>
          </div>

          {/* 引擎选项网格 (嵌入式凹槽托盘) */}
          <div className="p-2.5 bg-slate-100/80 rounded-2xl border border-slate-200/70 shadow-inner grid grid-cols-1 sm:grid-cols-2 gap-3">
            {engineOptions.map((item) => {
              const isSelected = engine === item.id;

              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => void setEngine(item.id).catch(error => showToast((error as Error).message, 'error'))}
                  className={`p-4 rounded-xl border text-left transition-all duration-200 fluent-press cursor-pointer flex flex-col justify-between gap-3 min-h-[96px] ${
                    isSelected
                      ? 'fluent-convex-tab border-blue-500 shadow-md ring-1 ring-blue-500/50 -translate-y-1'
                      : 'fluent-raised-tile hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between w-full">
                    <div className="flex items-center gap-2">
                      <div className={`w-4 h-4 rounded-full border flex items-center justify-center transition-colors ${
                        isSelected ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white'
                      }`}>
                        {isSelected && <Check className="w-2.5 h-2.5 stroke-[3]" />}
                      </div>
                      <span className={`text-xs font-bold ${isSelected ? 'text-blue-600' : 'text-slate-800'}`}>
                        {item.name}
                      </span>
                    </div>

                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md ${
                      isSelected ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'
                    }`}>
                      {item.tag}
                    </span>
                  </div>

                  <p className="text-xs text-slate-500 leading-relaxed pl-6">
                    {item.desc}
                  </p>
                </button>
              );
            })}
          </div>
        </MicaCard>

        {/* 3. 本地存储与缓存卡片 */}
        <MicaCard className="p-6 flex flex-col gap-5 shrink-0 animate-fluent-card-in" style={{ animationDelay: '140ms' }}>
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

        {/* 4. 关于与日志诊断 */}
        <MicaCard className="p-6 flex flex-col gap-5 shrink-0 animate-fluent-card-in" style={{ animationDelay: '190ms' }}>
          <div className="flex items-center gap-2 text-sm font-bold text-slate-800 pb-3 border-b border-black/[0.04]">
            <FileText className="w-4 h-4 text-slate-700" />
            <span>客户端信息与诊断</span>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex flex-col gap-1.5 text-xs leading-relaxed">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-slate-800">TTV Short Drama 独立桌面客户端</span>
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-200/50">
                  v1.0.0 Mica Light
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

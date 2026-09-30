import React, { useState, useEffect, useRef } from 'react';
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
import { isTauriEnvironment, ipcService, type GuoSourceCheck, type GuoSourceStatus } from '../../services/ipc';
import { GUO_SOURCES, type GuoSource } from '../../services/guoSources';
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
  Server,
  Sparkles,
  FolderSearch,
  Activity,
  ChevronDown
} from 'lucide-react';

/**
 * 一组同类视频源的勾选列表。
 *
 * `locked` 是 18+ 总开关关闭时的状态：整组置灰不可点，而不是把已勾选的悄悄
 * 取消——后者会让用户回来开开关时发现自己的选择没了。
 *
 * 这里**不再**显示「不可用 / 部分」角标：它读的是 `guoSources.ts` 里手填的
 * 2026-09-29 探针快照，早已过期（芽果当时就记着"未返回有效的访问令牌"，
 * 却被填成 available）。健康度改由下方「站源状态」面板实时查，同一处显示两
 * 份可能互相矛盾的状态比不显示更糟。
 *
 * `header` 挂在标题行右侧，用来放管辖这一组的控件（目前只有 18+ 那个总开关）——
 * 它就是这一组的门闩，另开一张卡片只会让用户在两张卡之间来回找对应关系。
 */
const SourceGroup: React.FC<{
  title: string;
  hint: string;
  sources: GuoSource[];
  enabled: string[];
  locked: boolean;
  onToggle: (id: string) => void;
  header?: React.ReactNode;
}> = ({ title, hint, sources, enabled, locked, onToggle, header }) => {
  if (sources.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h4 className="text-xs font-semibold text-slate-800">{title}</h4>
        <span className="text-[10px] text-slate-400">{sources.length} 个源</span>
        {header && <span className="ml-auto">{header}</span>}
      </div>
      <p className="text-[11px] text-slate-400 leading-relaxed">{hint}</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
        {sources.map(item => {
          const on = enabled.includes(item.id);
          return (
            <button
              key={item.id}
              type="button"
              disabled={locked}
              aria-pressed={on}
              onClick={() => onToggle(item.id)}
              className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-left text-xs transition-all duration-150 ${
                locked
                  ? 'border-slate-200/60 bg-slate-50 text-slate-300 cursor-not-allowed'
                  : on
                    ? 'border-blue-300/80 bg-blue-50/70 text-blue-700 font-semibold'
                    : 'border-slate-200/80 bg-white/70 text-slate-600 hover:bg-white'
              }`}
            >
              <span
                className={`w-3.5 h-3.5 rounded-[4px] border flex items-center justify-center flex-shrink-0 ${
                  on ? 'border-blue-500 bg-blue-500 text-white' : 'border-slate-300 bg-white'
                }`}
              >
                {on && <Check className="w-2.5 h-2.5" />}
              </span>
              <span className="truncate">{item.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

/** 单源体检的 UI 状态。用判别式而不是几个布尔——"既在跑又已完成"是合法布尔组合却是无意义画面。 */
type SourceCheckUi =
  | { kind: 'checking' }
  | { kind: 'error' }
  | { kind: 'result'; report: GuoSourceCheck };

/**
 * 状态徽章。四态必须肉眼可分，尤其「未检测」不能长得像「可用」——
 * guo-core 的 `health` 是可选字段，缺它就是**没有结论**。
 */
/** 徽章配色。与文案分开抽出来，是为了让"上次记录"这层前缀能套在任何状态色上。 */
const HEALTH_TONE = {
  ok: 'text-emerald-600 bg-emerald-50 border-emerald-200/70',
  catalogOnly: 'text-amber-600 bg-amber-50 border-amber-200/70',
  failed: 'text-rose-600 bg-rose-50 border-rose-200/70',
  checking: 'text-blue-600 bg-blue-50 border-blue-200/70',
  unknown: 'text-slate-500 bg-slate-50 border-slate-200',
} as const;

/**
 * 状态徽章。四态必须肉眼可分，尤其「未检测」不能长得像「可用」——
 * guo-core 的 `health` 是可选字段，缺它就是**没有结论**。
 */
function healthBadge(row: GuoSourceStatus | undefined, check: SourceCheckUi | undefined) {
  if (check?.kind === 'checking') return { text: '检查中', tone: HEALTH_TONE.checking };
  // 「本次体检没拿到报告」不能盖掉站方自己记下的健康度。`row.health` 是已落盘的真
  // 实结论，而一次失败可能只是网络抖动、或该源正被另一个任务占用——凭什么据此
  // 断言这个源现在坏了？旧实现无条件返回"检查失败"，于是 row.health 明明是 ok
  // 也永远显示"检查失败"，而 checks 又没有过期路径，一次抖动就把这一行钉死。
  // 现在：有历史结论就显示它，配「上次」前缀把"这是旧记录"说清楚（颜色仍代表
  // 站方结论的严重级，不因为过期就淡化）；站方从未体检过、没有可回落的历史，
  // 才如实显示"检查失败"。
  const stale = check?.kind === 'error';
  const lastTime = (text: string, tone: string) => ({ text: '上次' + text, tone });
  const failedNow = { text: '检查失败', tone: HEALTH_TONE.failed };
  switch (row?.health?.state) {
    case 'ok': return stale ? lastTime('可用', HEALTH_TONE.ok) : { text: '可用', tone: HEALTH_TONE.ok };
    // catalogOnly = 只验到目录就停了（checkCatalog 模式，不验播放链路），不是"坏了"。
    case 'catalogOnly':
      return stale
        ? lastTime('部分可用', HEALTH_TONE.catalogOnly)
        : { text: '部分可用', tone: HEALTH_TONE.catalogOnly };
    case 'failed':
      return stale
        ? lastTime('暂不可用', HEALTH_TONE.failed)
        : { text: '暂不可用', tone: HEALTH_TONE.failed };
    // 后端体检可能仍在跑（结果已落盘、任务未收尾），别当成未检测。
    case 'checking':
      return stale ? lastTime('检查中', HEALTH_TONE.checking) : { text: '检查中', tone: HEALTH_TONE.checking };
    default: return stale ? failedNow : { text: '未检测', tone: HEALTH_TONE.unknown };
  }
}

/**
 * Go 的 `time.Time` 序列化成 RFC3339，零值是 `0001-01-01T00:00:00Z`——
 * 那是"从未更新"，不能当成公元 1 年显示给用户。
 */
function formatUpdatedAt(value: string | undefined): string {
  if (!value || value.startsWith('0001-01-01')) return '从未更新';
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? '时间无效' : at.toLocaleString('zh-CN', { hour12: false });
}

/**
 * 站源状态面板，折叠态不发任何请求。
 *
 * 拉一次 `guoSourceStatus` 是 19 次跨进程调用，进设置页就顺手打一遍会把整页首屏
 * 拖住，所以只在**首次展开**时拉一次，之后靠面板里的「刷新」和每个源自己的
 * 「检查」推进。19 行始终按 `GUO_SOURCES` 渲染——后端漏掉某个源时该行落到
 * 「未检测」，而不是整行消失（消失会让人以为这个源不存在了）。
 */
const SourceStatusPanel: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<GuoSourceStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [checks, setChecks] = useState<Record<string, SourceCheckUi>>({});
  /**
   * 并发闸（进行中的源 id 集合）。
   *
   * `setChecks` 到 re-render 之间存在间隔，同一帧里的第二次点击读到的还是提交前
   * 的旧 state，于是两次 `runCheck` 会一起进 `await guoSourceCheck`——后端把同一
   * 源当成"正被另一个任务占用"直接失败，用户看到的是两次都没结果。所以 ref 立即
   * 置位（同步生效，挡同帧重入），state 只负责把按钮画成"检查中"。
   */
  const checkingRef = useRef<Set<string>>(new Set());
  /** 首次展开才拉一次；面板关掉再打开不重打（站源状态由用户主动「检查」改变）。 */
  const loadedRef = useRef(false);
  const canCheck = isTauriEnvironment();

  const load = async () => {
    setLoading(true);
    try {
      setRows(await ipcService.catalog.guoSourceStatus());
      // 只有真的拿到数据才算"已加载"。此前 `loadedRef` 在 `toggle` 里于 await
      // 之前就置位，首次拉失败（后端刚起、DLL 还没 ready）会让门闩永久为 true，
      // 面板再展开也不再重试 —— 用户只能手动点「刷新状态」。
      loadedRef.current = true;
    } catch {
      loadedRef.current = false;
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !loadedRef.current) {
      loadedRef.current = true;
      void load();
    }
  };

  const runCheck = async (source: string) => {
    // 两道闸：ref 同步置位挡同帧重入，state 是重渲染后的兜底（ref 可能在别处被清）。
    if (checkingRef.current.has(source) || checks[source]?.kind === 'checking') return;
    checkingRef.current.add(source);
    setChecks(prev => ({ ...prev, [source]: { kind: 'checking' } }));
    try {
      const report = await ipcService.catalog.guoSourceCheck(source);
      setChecks(prev => ({ ...prev, [source]: { kind: 'result', report } }));
      // 体检结果会写回 guo-core 的源记录，顺手把状态列刷一次。
      void load();
    } catch {
      setChecks(prev => ({ ...prev, [source]: { kind: 'error' } }));
    } finally {
      // 必须放在 finally：失败也要放行，否则这个源再也点不动。
      checkingRef.current.delete(source);
    }
  };

  /**
   * 清除面板里的体检报告。
   *
   * `checks` 是纯前端状态、没有过期策略：一次网络抖动写下的 `error` 会一直挂在
   * 那一行上（healthBadge 现在会回落显示站方的历史结论，但那句"没拿到体检报告"
   * 仍挂在行底）。给一条手动清除，别让一次抖动变成一整页的历史沉积。
   * 不动 `checkingRef`——正在跑的那次该回来还是回来。
   */
  const clearChecks = () => setChecks({});

  const byId = new Map(rows.map(row => [row.source, row]));
  const checksCount = Object.keys(checks).length;

  return (
    <div className="flex flex-col gap-3">
      <button type="button" onClick={toggle} aria-expanded={open} className="flex items-center gap-2 text-left cursor-pointer">
        <Activity className="w-3.5 h-3.5 text-blue-600" />
        <span className="text-xs font-semibold text-slate-700">站源状态与链路体检</span>
        <span className="text-[10px] text-slate-400">展开后查询 guo-core 的 19 个站源</span>
        <ChevronDown className={`w-3.5 h-3.5 text-slate-400 ml-auto transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="flex flex-col gap-2 animate-fluent-slide-down">
          <p className="text-[11px] text-slate-400 leading-relaxed">
            状态读的是 guo-core 自己的体检结果，<span className="text-slate-500">不再是源表里那份手填快照</span>。
            「未检测」表示还没跑过体检——既不代表源坏了，<span className="text-slate-500">也不代表它可用</span>。
            「检查」会真连站方走一遍入口→目录→分集→播放地址→密钥→媒体，秒级到十几秒。
          </p>

          {rows.length === 0 && !loading && (
            <p className="text-[11px] text-amber-600 leading-relaxed">
              {canCheck
                ? '后端没有返回任何站源状态：19 个源都还没跑过体检，点「检查」可按需触发。'
                : '演示模式没有后端，19 个源一律显示未检测。'}
            </p>
          )}

          {GUO_SOURCES.map(source => {
            const row = byId.get(source.id);
            const check = checks[source.id];
            const badge = healthBadge(row, check);
            const busy = check?.kind === 'checking';
            return (
              <div key={source.id} className="flex flex-col px-3 py-2 rounded-xl bg-slate-50/70 border border-slate-200/70">
                <div className="flex items-center gap-2 flex-wrap text-xs">
                  <span className="font-semibold text-slate-700 w-24 truncate">{source.name}</span>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md border ${badge.tone}`}>{badge.text}</span>
                  <span className="text-[10px] font-mono text-slate-500">{row && row.count > 0 ? `${row.count} 条` : '未拉取'}</span>
                  {/* hasMore 在源从未被收录时也是 true（Go: `!found || state.HasMore`），
                      所以只有真有条目时才有资格谈"更多页"。 */}
                  <span className="text-[10px] text-slate-400">
                    {row && row.count > 0 ? (row.hasMore ? '有更多页' : '已到底') : '—'}
                  </span>
                  <span className="text-[10px] font-mono text-slate-400 ml-auto">{formatUpdatedAt(row?.updatedAt)}</span>
                  <button
                    type="button"
                    disabled={!canCheck || busy}
                    onClick={() => void runCheck(source.id)}
                    className={`text-[10px] font-bold px-2 py-1 rounded-lg border transition-colors ${
                      !canCheck || busy
                        ? 'border-slate-200 bg-slate-100 text-slate-400 cursor-not-allowed'
                        : 'border-blue-200/80 bg-blue-50/80 text-blue-600 hover:bg-blue-100'
                    }`}
                  >
                    {busy ? '检查中…' : '检查'}
                  </button>
                </div>

                {/* 任务错误 / 存储告警：Go 侧已过 publicError（URL 的 query 被打码），
                    且都是 host + HTTP 码 + 固定措辞的格式化文本，不是站方原文。 */}
                {row?.error && <p className="mt-1 text-[10px] text-rose-600 leading-relaxed break-words">{row.error}</p>}
                {row?.storageError && <p className="mt-1 text-[10px] text-amber-600 leading-relaxed break-words">{row.storageError}</p>}
                {check?.kind === 'error' && (
                  <p className="mt-1 text-[10px] text-rose-600 leading-relaxed">
                    检查失败：没拿到体检报告（可能已超时，或该源正被另一个任务占用）。
                  </p>
                )}

                {check?.kind === 'result' && (
                  <div className="mt-1.5 pl-2.5 border-l-2 border-slate-200 flex flex-col gap-1">
                    <div className="flex items-center gap-2 flex-wrap text-[10px] text-slate-500">
                      <span>{check.report.sample ? `抽检《${check.report.sample}》` : '未取到抽检剧名'}</span>
                      <span className="font-mono">{formatUpdatedAt(check.report.checkedAt)}</span>
                      {check.report.steps.length === 0 && <span>（没有步骤数据）</span>}
                    </div>
                    {check.report.steps.map(step => (
                      <div key={step.name} className="flex items-baseline gap-2 flex-wrap text-[10px]">
                        <span className={`font-semibold ${step.state === 'ok' ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {step.state === 'ok' ? '✓' : '✕'} {step.name}
                        </span>
                        {step.httpStatus ? <span className="font-mono text-slate-500">HTTP {step.httpStatus}</span> : null}
                        {step.host ? <span className="font-mono text-slate-400">{step.host}</span> : null}
                        <span className="font-mono text-slate-400">{step.elapsedMs} ms</span>
                        {/* message 只在成功时展示：Go 侧成功文案是写死的字面量
                            （"已解析 N 部剧"等），失败文案来自 `publicError(err)`
                            ——那是站方响应的派生物，只把 URL 的 query 打了码，
                            不挡本地路径与裸 token。失败统一换中性措辞。 */}
                        <span className="text-slate-500">{step.state === 'ok' ? step.message : '该步骤未通过'}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          <div className="pt-1 flex items-center gap-2 flex-wrap">
            <FluentButton
              variant="secondary"
              size="sm"
              disabled={loading}
              icon={<RefreshCw className={`w-3 w-3 ${loading ? 'animate-spin' : ''}`} />}
              onClick={() => void load()}
            >
              {loading ? '正在读取…' : '刷新状态'}
            </FluentButton>
            <FluentButton variant="secondary" size="sm" disabled={checksCount === 0} onClick={clearChecks}>
              清除检查结果
            </FluentButton>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * 「站源网络」开关：直连 / 跟随系统代理。
 *
 * guo 的 19 个站全是境内 CDN 站点。实测（2026-09-29）：开着系统代理（Clash/
 * V2Ray 类，出口在境外）访问花果站恒为 HTTP 403，同一请求直连 200——站方
 * CDN 拒绝数据中心出口 IP。后端首次运行已默认直连，这里给的是可见的切换：
 * 境外网络环境（直连到不了境内站点）才需要「跟随系统代理」。
 *
 * 状态只存 guo-core 的 resource-settings.json（命令读写 + 热应用），故意不进
 * UserSettings：同一份状态存两处必然漂移。读取失败（null）时禁用开关——宁可
 * 不可用，也不能显示一个按下去却没有后端接住的开关（不变量 8）。
 */
const GuoNetworkRow: React.FC = () => {
  const [mode, setMode] = useState<'auto' | 'direct' | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    ipcService.catalog.guoProxyMode().then(value => {
      if (active) setMode(value);
    });
    return () => {
      active = false;
    };
  }, []);

  const pick = async (next: 'auto' | 'direct') => {
    if (saving || next === mode) return;
    setSaving(true);
    try {
      await ipcService.catalog.setGuoProxyMode(next);
      setMode(next);
    } catch {
      // 切换失败保持原显示：不能让 UI 呈现一个后端没接受的状态。
    } finally {
      setSaving(false);
    }
  };

  const options = [
    { id: 'direct' as const, label: '直连', hint: '推荐。境内站点不经代理，最快也最稳。' },
    { id: 'auto' as const, label: '跟随系统代理', hint: '仅境外网络环境需要。' },
  ];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h4 className="text-xs font-semibold text-slate-800">站源网络</h4>
        {mode === null && <span className="text-[10px] text-slate-400">读取中…</span>}
      </div>
      <p className="text-[11px] text-slate-400 leading-relaxed">
        这些站源的请求全部走本地 guo-core。站方 CDN 会拒绝代理（机场）出口 IP——挂着系统代理时
        目录能看（缓存）、点开就报「获取剧集详情失败」，就是它。默认直连；只有直连到不了站点的境外网络才选代理。
      </p>
      <div className="grid grid-cols-2 gap-1.5">
        {options.map(option => {
          const on = mode === option.id;
          const disabled = mode === null || saving;
          return (
            <button
              key={option.id}
              type="button"
              disabled={disabled}
              aria-pressed={on}
              onClick={() => void pick(option.id)}
              title={option.hint}
              className={`px-2.5 py-1.5 rounded-lg border text-xs transition-all duration-150 ${
                disabled
                  ? 'border-slate-200/60 bg-slate-50 text-slate-300 cursor-not-allowed'
                  : on
                    ? 'border-blue-300/80 bg-blue-50/70 text-blue-700 font-semibold'
                    : 'border-slate-200/80 bg-white/70 text-slate-600 hover:bg-white'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export const SettingsView: React.FC = () => {
  const { settings, updateSettings, clearCache, cacheUsage, refreshCacheUsage } = useSettingsStore();
  const { showToast } = useAppStore();

  const [isCleaning, setIsCleaning] = useState(false);
  const enabledSources = settings.enabledSources;

  /**
   * 勾选/取消一个源。
   *
   * 存的是 id 全集而不是"禁用集"：源表在前端，后端不认识这些 id，勾选结果直接
   * 落库即可。18+ 总开关关闭时不在这里拦——那样会让用户之前的选择被静默清空，
   * 而"置灰不可点 + 重新勾选"更符合预期（真正的生效判断在 `enabledSourceIds`）。
   */
  const toggleSource = (id: string) => {
    const current = settings.enabledSources;
    updateSettings({
      enabledSources: current.includes(id)
        ? current.filter(item => item !== id)
        : [...current, id],
    });
  };

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

        {/* 2. 视频源启用（按真人/漫剧归纳，18+ 总开关就在该组顶部） */}
        <MicaCard className="p-6 flex flex-col gap-5 shrink-0 animate-fluent-card-in">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-800 pb-3 border-b border-black/[0.04]">
            <Server className="w-4 h-4 text-blue-600" />
            <span>视频源</span>
          </div>

          <p className="text-[11px] text-slate-400 leading-relaxed">
            勾选后这些源会一起汇入发现页——前两组进「短剧专区」与「漫剧次元」，
            18+ 那组只在打开开关后进「神秘小窝」独占，不混进前两个专区。
            归类是逐源实测目录内容得出的
            （2026-09-29 拉每个源的前 12 条看标题/分类/集数），不是按站名猜的。
            <span className="text-slate-500">勾得越多，首屏要并发等待的站点也越多</span>
            ——实测 19 个源全开会打 19 个站点，最慢的那个决定首屏时间。
          </p>

          <GuoNetworkRow />

          {/* 分组必须与 `sourceMatchesTab` 同一套判据：18+ 源归「神秘小窝」独占，
              这里两个组都要排除，否则设置页显示它属于短剧专区、点进去却找不到。 */}
          <SourceGroup
            title="真人短剧"
            hint="实拍短剧，条目有剧情简介、几十至上百集。汇入发现页的「短剧专区」。"
            sources={GUO_SOURCES.filter(item => item.kind === 'live' && !item.adult)}
            enabled={enabledSources}
            locked={false}
            onToggle={toggleSource}
          />
          <SourceGroup
            title="真人 + 漫剧"
            hint="同一个源里两种内容都有。汇入「短剧专区」与「漫剧次元」。"
            sources={GUO_SOURCES.filter(item => item.kind === 'both' && !item.adult)}
            enabled={enabledSources}
            locked={false}
            onToggle={toggleSource}
          />
          <SourceGroup
            title="18+ 成人内容"
            hint="实测逐源确认含成人条目（母子同欢 / 同学妈妈无删减版 / 无码中字番号 等）。只汇入发现页的「神秘小窝」专区，不进短剧专区与漫剧次元。"
            sources={GUO_SOURCES.filter(item => item.adult)}
            enabled={enabledSources}
            locked={!settings.showAdultSources}
            onToggle={toggleSource}
            /* 总开关就放在它管辖的那一组顶部，而不是另开一张卡片：分开时用户
               要在两张卡之间来回找"这个开关管的是上面那几行"，而它其实就是
               这一组的门闩。关闭时该组置灰不可点，但**不取消已勾选项**——静默
               清空会让用户回来开开关时发现自己的选择没了。 */
            header={
              <button
                type="button"
                role="switch"
                aria-checked={settings.showAdultSources}
                onClick={() => updateSettings({ showAdultSources: !settings.showAdultSources })}
                className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                  settings.showAdultSources ? 'bg-blue-600' : 'bg-slate-300'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                    settings.showAdultSources ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </button>
            }
          />

          {enabledSources.length === 0 && (
            <p className="text-[11px] text-amber-600 leading-relaxed">
              一个源都没勾：发现页会临时回落到红果，不会变成空目录。
            </p>
          )}

          <div className="pt-4 border-t border-black/[0.04]">
            <SourceStatusPanel />
          </div>
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

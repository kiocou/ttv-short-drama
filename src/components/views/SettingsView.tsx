import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useAppStore } from '../../stores/useAppStore';
import type { UserSettings } from '../../types/settings';
import { MicaCard } from '../common/MicaCard';
import { FluentButton } from '../common/FluentButton';
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
import { isTauriEnvironment, ipcService, type GuoSourceCheck, type GuoSourceStatus } from '../../services/ipc';
// 播放诊断日志面板：放在「客户端信息与诊断」卡片里，与已有的导出按钮同一处——
// 用户诉求是「根据日志一步一步优化」，日志必须能在应用里直接看到。
import { PlaybackLogPanel } from '../common/PlaybackLogPanel';
import { GUO_SOURCES, type GuoSource } from '../../services/guoSources';
import {
  Settings,
  Tv,
  HardDrive,
  FileText,
  Check,
  RefreshCw,
  FolderOpen,
  Download,
  Server,
  Sparkles,
  FolderSearch,
  Activity,
  ChevronDown,
  Palette,
  Sun,
  Moon,
  MonitorSmartphone,
  Wifi,
} from 'lucide-react';
import {
  readThemePreference,
  saveTheme,
  systemPrefersDark,
  type ThemePreference,
} from '../../services/theme';

/* ==========================================================================
   统一样式原语

   这一段以前不存在：卡片标题、开关、徽章、分段选项、按钮底座各自在 5 张卡片里
   手写了一遍，于是同一种控件在页面上出现了 2~3 种尺寸（开关有 h-6 w-11 和
   h-5 w-9 两种、徽章有两种蓝、chip 有三份几乎相同的字符串），而其中一份还
   带 `as any`。控件抽出来后，"改一处样式"才真的只改一处。
   ========================================================================== */

/** 条目标题 / 说明文字的字阶。全页只有这两级，不要再随手加第三级。 */
const TITLE_CLS = 'text-xs font-semibold text-slate-800';
const HINT_CLS = 'text-[11px] text-slate-400 leading-relaxed';

/**
 * 外观卡片的分段选项。
 *
 * 三项而不是两项：`system` 是**用户的选择**，不是一个主题——它必须和浅色/暗色
 * 并列出现，因为对用户来说这三者是同一道单选题（"我要什么外观"），而不是
 * "选主题 + 一个开关"。若做成"跟随系统"的开关，用户会遇到"开关开着但下面
 * 还高亮着暗色"这种自相矛盾的画面。
 */
const THEME_OPTIONS: {
  id: ThemePreference;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: 'light', label: '浅色', icon: Sun },
  { id: 'dark', label: '暗色', icon: Moon },
  { id: 'system', label: '跟随系统', icon: MonitorSmartphone },
];

/**
 * 默认清晰度的分段选项。
 *
 * 只列 `auto` 与 1080P 两档，**刻意不给 4K/720P**：
 * 源站实测最高就是 1080p（设置页旧注释与 `.learnings` 都记着"4K 实为 1080p"），
 * 列一个源里根本不存在的档位等于让用户选一个必然回退的选项。类型里保留
 * `'4k' | '720p'` 是为了兼容旧设置记录，不是鼓励新写入。
 */
const QUALITY_OPTIONS: { id: UserSettings['defaultQuality']; label: string; hint: string }[] = [
  { id: 'auto', label: '自动', hint: '跟随源里最高的一档，绝大多数情况选它。' },
  { id: '1080p', label: '1080P', hint: '强制请求 1080p。源里没有该档时后端自动回退。' },
];

/**
 * 红果官网链路的代理选项。
 *
 * 三项对应用户能做出的三种判断，没有第四种：
 * - `auto`：让程序探一下（默认，绝大多数人该选它）
 * - `direct`：我知道我这台机器不该走代理
 * - `proxy`：我知道必须走代理（企业网、非常规代理）
 *
 * 为什么不做成"自动探测 + 一个覆盖开关"：那样用户要先理解"自动探测是什么"，
 * 才能判断自己该不该动它。三个并列的选项把这件事变成一次选择。
 */
const PROXY_OPTIONS: { id: UserSettings['proxyMode']; label: string; hint: string }[] = [
  { id: 'auto', label: '自动', hint: '启动时探测系统代理，通就用、不通就直连。' },
  { id: 'direct', label: '直连', hint: '永远不走代理。代理软件退出后仍报「目录加载失败」时选它。' },
  { id: 'proxy', label: '总是代理', hint: '强制走系统代理。企业网或非常规代理环境用。' },
];

/**
 * 分段选择控件的单项样式。
 *
 * 与「外观」那一组共用：同一个页面上两处分段控件长得一样，用户只需要学一次。
 * 选中态用 `fluent-convex-tab`（凸起白片），未选中只留文字 + hover 底色——
 * 与 `CategoryBar` 的交互语言一致，也不给每个选项套边框（那会让两个选项
 * 看起来像两个独立按钮，而不是"二选一"）。
 */
function segmentedClass(selected: boolean): string {
  return `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors duration-150 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 ${
    selected ? 'fluent-convex-tab text-slate-800' : 'text-slate-500 hover:text-slate-800'
  }`;
}

/**
 * 分段选项（单选 chip）的状态样式。
 *
 * 「站源网络」与源分组共用这一套，所以两个看起来像控件的东西在页面上是同一件
 * 东西——此前一个带勾选框一个不带，视觉上像两种控件，用户要重新学一遍。
 *
 * **刻意不加边框**：这里曾给每个选项套 `border-slate-200/80 bg-white/70`，而
 * 源分组有 19 个选项，一屏 19 个带边框的圆角盒子排成网格，整块看着像一堆散沙
 * 而不是一组可选项。现在只靠底色 + 字重区分状态：选中有浅蓝底，未选中只有
 * 文字与 hover 底色——信息量没减，视觉噪音降一个数量级。
 */
function chipClass(selected: boolean, disabled: boolean): string {
  const base = 'px-2.5 py-1.5 rounded-lg text-xs transition-colors duration-150';
  if (disabled) return `${base} text-slate-300 cursor-not-allowed`;
  if (selected) return `${base} bg-blue-50/90 text-blue-700 font-semibold`;
  return `${base} text-slate-600 hover:bg-slate-100/80`;
}

/** 一行「标题 + 说明 + 右侧控件」。
 *
 * 右侧控件给一个**最小**宽度而不是定宽（`sm:min-w-[152px]` + 靠右）：
 * 定宽 `w-[168px]` 试过，会把左侧说明文字压窄、「默认清晰度」那段 hint
 * 被迫折成两行——说明文字才是这一行要读的东西，控件只是操作入口，
 * 不该为了对齐去牺牲正文的行宽。最小宽度只解决"开关和下拉框起点乱跳"，
 * 内容更宽时（比如分段控件）允许自己撑开。
 */
const SettingRow: React.FC<{
  title: string;
/** 说明文字。允许传节点：有些说明要在中间嵌一个加粗片段（“不会自动安装”之类）。 */
  hint?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, hint, children }) => (
  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
    <div className="min-w-0">
      <h4 className={TITLE_CLS}>{title}</h4>
      {hint && <p className={`${HINT_CLS} mt-0.5`}>{hint}</p>}
    </div>
    <div className="flex-shrink-0 self-start sm:self-center sm:min-w-[152px] flex sm:justify-end">
      {children}
    </div>
  </div>
);

/**
 * 开关。
 *
 * 全页只有一个尺寸。旧的连播开关是 h-6 w-11、18+ 开关是 h-5 w-9 并排出现在
 * 同一页里，同一个开关在两处长得不一样；现在统一成后者（小一号更适合 40px
 * 级的行高，也与卡片里的 chip 同一套密度）。
 *
 * `focus-visible` 环是补的：原来两个开关都写了 `focus:outline-none` 又没有任何
 * 替代样式，键盘 Tab 过去焦点完全不可见。
 */
const Toggle: React.FC<{
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}> = ({ checked, onChange, label, disabled }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 focus-visible:ring-offset-1 ${
      checked ? 'bg-blue-600' : 'bg-slate-300'
    } ${disabled ? 'opacity-45 pointer-events-none' : ''}`}
  >
    <span
      className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition duration-200 ease-in-out ${
        checked ? 'translate-x-4' : 'translate-x-0'
      }`}
    />
  </button>
);

/**
 * 数值徽章（缓存大小、版本号）。
 *
 * 之前这些徽章在两张卡片里各写了一份完全相同的 className 字符串。
 *
 * 原本还有一个 `tone?: 'info' | 'neutral'` 参数，唯一传 `neutral` 的调用点是
 * 「客户端信息」里那个写死的 `Mica Light` 徽章。那个徽章删掉之后，`tone`
 * 只剩 `info` 一个取值 —— 一个永远走同一分支的参数不如没有，于是收成单一样式。
 * 将来真需要第二种配色时再加，而不是留一个空壳让人以为有得选。
 */
const ValueBadge: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="text-[11px] font-bold font-mono px-2 py-0.5 rounded-md border text-blue-600 bg-blue-50 border-blue-200/60">
    {children}
  </span>
);

/**
 * 卡片骨架： MicaCard + 统一标题行。
 *
 * 卡片标题此前在 5 张卡片里手写了 5 遍同款 className（`text-sm font-bold` + 底部
 * 分隔线），改一次字号要改五处；图标颜色也不统一（两张 blue-600、两张 slate-700）。
 * 现在标题行只有这一处，字阶与图标色一起定死。
 */

/** 卡片骨架： MicaCard + 统一标题行。
 *
 * `gap-4`（16px）而不是原来的 `gap-5`（20px）：卡片内部各行的分隔线是
 * `<div className="pt-4 border-t">`，它自带 16px 上边距。外层 gap 也是 20px 时，
 * 分隔线上方是 20px、下方是 16px，每条线都歪一点点——单看一处不明显，但本页
 * 有 6 张卡片、十几条分隔线，累积起来整页的纵向节奏是"每段都差一点"。
 * 把外层 gap 对齐到 16px 后，分隔线上下等距，整页只靠**间距本身**分组，
 * 不再需要靠加粗或换色来区分段落。
 */
const SectionCard: React.FC<{
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}> = ({ icon, title, children }) => (
  <MicaCard className="p-6 flex flex-col gap-4 shrink-0 animate-fluent-card-in">
    <div className="flex items-center gap-2 text-[13px] font-semibold text-slate-800 pb-3 border-b border-black/[0.04]">
      {icon}
      <span>{title}</span>
    </div>
    {children}
  </MicaCard>
);

/** 卡片内一节的小标题（对应原来的 `<h4>` + 说明 + 控件的组合）。 */
const SubSection: React.FC<{
  title: string;
hint?: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, hint, aside, children }) => (
  <div className="flex flex-col gap-2">
    <div className="flex items-center gap-2">
      <h4 className={TITLE_CLS}>{title}</h4>
      {aside && <span className="ml-auto">{aside}</span>}
    </div>
    {hint && <p className={HINT_CLS}>{hint}</p>}
    {children}
  </div>
);

/* ==========================================================================
   视频源
   ========================================================================== */

/**
 * 代理自检（「站源网络」那张卡里的测试按钮）。
 *
 * ## 为什么值得一块 UI
 *
 * 这个项目在代理上栽过三次，每次的症状都一样：**「目录加载失败」**，
 * 而真实原因（代理端口没人监听）藏在几十行日志之外。用户的排查成本全部
 * 花在"这到底是不是代理的问题"上。
 *
 * 这个按钮把那个推理一次做完并如实报告三件事：
 *   ① 系统代理配的是什么（没有就明说没有）
 *   ② 那个端口此刻通不通
 *   ③ 绕开代理直连，能不能取到红果目录
 *
 * ③ 是最终判据：它成立就说明"关掉代理就能用"，用户据此改上面的开关即可。
 */
const ProxyDiagnose: React.FC = () => {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'done'; result: { proxyAddress: string | null; proxyReachable: boolean; directCatalogOk: boolean; proxyDead: boolean } }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const run = async () => {
    setState({ kind: 'running' });
    try {
      const result = await ipcService.diagnostics.proxyDiagnose();
      setState({ kind: 'done', result });
    } catch (error) {
      setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <FluentButton
          variant="secondary"
          size="sm"
          disabled={state.kind === 'running' || !isTauriEnvironment()}
          icon={<Activity className={`w-3 h-3 ${state.kind === 'running' ? 'animate-pulse' : ''}`} />}
          onClick={() => void run()}
        >
          {state.kind === 'running' ? '正在检测…' : '检测网络'}
        </FluentButton>
        <span className="text-[10px] text-slate-400">排查「目录加载失败」时先点它</span>
      </div>

      {state.kind === 'done' && (
        <div className="flex flex-col gap-1 px-3 py-2 rounded-xl bg-slate-50/70 border border-slate-200/70 text-[11px]">
          <span className="text-slate-600">
            系统代理：{state.result.proxyAddress
              ? <span className="font-mono">{state.result.proxyAddress}</span>
              : <span className="text-slate-500">未配置</span>}
          </span>
          {state.result.proxyAddress && (
            <span className={state.result.proxyReachable ? 'text-emerald-600' : 'text-rose-600'}>
              {state.result.proxyReachable ? '✓ 代理端口可连接' : '✕ 代理端口连不上（这就是「目录加载失败」的常见原因）'}
            </span>
          )}
          <span className={state.result.directCatalogOk ? 'text-emerald-600' : 'text-rose-600'}>
            {state.result.directCatalogOk ? '✓ 直连可以取到目录' : '✕ 直连也取不到目录（可能是网络本身不通）'}
          </span>
          {state.result.proxyDead && (
            <span className="text-amber-600">当前已判定代理不可用，所有请求走直连。</span>
          )}
        </div>
      )}

      {state.kind === 'error' && (
        <p className="text-[11px] text-rose-600">检测失败：{state.message}</p>
      )}
    </div>
  );
};

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
    <SubSection
      title={title}
      hint={hint}
      aside={
        /* 必须给 gap：此前这两个元素直接相邻，`6 个源` 与 18+ 开关会贴在一起
           （截图实测：开关左边缘压在文字右边缘上，读起来像"6 个源"是开关的一部分）。
           顺序也调成「开关在前、计数在后」——开关是操作，计数是信息，
           操作靠右是这一页所有行的统一朝向。 */
        <span className="flex items-center gap-2.5">
          {header}
          <span className="text-[10px] text-slate-400">{sources.length} 个源</span>
        </span>
      }
    >
      <div className="flex flex-wrap gap-1.5">
        {sources.map(item => {
          const on = enabled.includes(item.id);
          return (
            <button
              key={item.id}
              type="button"
              disabled={locked}
              aria-pressed={on}
              onClick={() => onToggle(item.id)}
              title={item.name}
              className={`flex items-center gap-1.5 text-left ${chipClass(on, locked)}`}
            >
              <span
                className={`w-3 h-3 rounded-[3px] border flex items-center justify-center flex-shrink-0 transition-colors ${
                  on ? 'border-blue-500 bg-blue-500 text-white' : 'border-slate-300'
                }`}
              >
                {on && <Check className="w-2 h-2" strokeWidth={3} />}
              </span>
              <span className="truncate">{item.name}</span>
            </button>
          );
        })}
      </div>
    </SubSection>
  );
};

/** 单源体检的 UI 状态。用判别式而不是几个布尔——"既在跑又已完成"是合法布尔组合却是无意义画面。 */
type SourceCheckUi =
  | { kind: 'checking' }
  | { kind: 'error' }
  | { kind: 'result'; report: GuoSourceCheck };

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
      {/* 折叠标题统一成 `SubSection` 的写法：图标 + 标题 + 右侧箭头。
          此前中间还塞了一句「展开后查询 guo-core 的 19 个站源」——它把
          一个 12 字的标题行拉长到 30 多字，且「19 个源」与右侧「N 个源」
          计数重复。那句话的信息已由下方展开后的说明段落完整覆盖。 */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex items-center gap-2 text-left cursor-pointer group py-0.5"
      >
        <Activity className="w-3.5 h-3.5 text-blue-600" />
        <span className={TITLE_CLS}>站源状态与链路体检</span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-slate-400 ml-auto transition-transform duration-200 group-hover:text-slate-600 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="flex flex-col gap-2 animate-fluent-slide-down">
          <p className={HINT_CLS}>
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
    <SubSection
      title="站源网络"
      hint="这些站点会拒绝代理出口 IP：挂着系统代理时目录能看，点开却报「获取剧集详情失败」。默认直连；只有身处境外、直连到不了站点时才选代理。"
      aside={mode === null ? <span className="text-[11px] text-slate-400">读取中…</span> : undefined}
    >
      {/* `inline-flex` + 自适应宽度，而不是 `grid grid-cols-2`。
          两列网格会让每个选项各占半行（约 380px），而「直连」「跟随系统代理」
          加起来才 12 个字——中间全是空白，看着像两个被拉长的空盒子。
          自适应后两个 chip 紧挨着，视觉密度与上面「浅色/暗色」那组一致。 */}
      <div className="inline-flex items-center gap-1.5 p-1 rounded-xl bg-slate-100/80">
        {options.map(option => (
          <button
            key={option.id}
            type="button"
            disabled={mode === null || saving}
            aria-pressed={mode === option.id}
            onClick={() => void pick(option.id)}
            title={option.hint}
            className={chipClass(mode === option.id, mode === null || saving)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </SubSection>
  );
};

/* ==========================================================================
   页面
   ========================================================================== */

export const SettingsView: React.FC = () => {
  const { settings, updateSettings, clearCache, cacheUsage, refreshCacheUsage } = useSettingsStore();
  // currentView 用于「进入设置页时刷新」的守卫（本组件常驻 DOM、只挂载一次）。
  const { showToast, currentView } = useAppStore();

  const [isCleaning, setIsCleaning] = useState(false);
  // 主题不进 UserSettings（那是 Rust 契约，见 services/theme.ts 的说明）。
  //
  // 这里存的是**用户的选择**（可能为 `'system'`），不是实际生效的模式。
  // 单选按钮必须反映"用户选了什么"，否则选了「跟随系统」之后按钮会跳到
  // 「暗色」上去，看起来像是自己改了主意。
  const [themePreference, setThemePreference] = useState<ThemePreference>(readThemePreference);
  /**
   * 「跟随系统」时，系统当前是暗是浅。
   *
   * 这个 state 唯一的用途是：在「跟随系统」选项旁边标出此刻实际落到哪一档
   * （`跟随系统 · 暗色`）。没有它，用户选了跟随之后无从知道当前生效的是什么
   * ——尤其当系统就是浅色、界面看起来"没变化"时，会怀疑按钮没生效。
   *
   * 它由下面的 effect 跟随系统事件更新；固定主题下不参与任何判断。
   */
  const [systemIsDark, setSystemIsDark] = useState<boolean>(systemPrefersDark);
  const enabledSources = settings.enabledSources;

  /**
   * 系统配色变化的本地订阅。
   *
   * `main.tsx` 里已经挂了一个进程级的监听器负责**真正切换主题**；这里这一个
   * 只负责把"系统现在是暗还是浅"同步到组件 state，好让「跟随系统」旁边那行
   * 小字准确。两处订阅同一事件，职责不同，都不重。
   *
   * 必须用 `addEventListener('change')` 而不是轮询：Windows 改应用模式时
   * 这个事件是即时的，轮询既费电又会有一拍延迟。
   */
  useEffect(() => {
    let media: MediaQueryList;
    try {
      media = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return;
    }
    const onChange = (event: MediaQueryListEvent) => setSystemIsDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

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
  /** 已下载的安装包路径；安装向导没能打开时用它做「打开文件夹」退路。 */
  const [savedPath, setSavedPath] = useState<string | null>(null);
  /** 下载完成后正在打开安装向导（此时应用即将退出，界面不该再给可点的操作）。 */
  const [isInstalling, setIsInstalling] = useState(false);
  /** 安装向导没能打开的原因。非 null 时才显示「打开文件夹」退路。 */
  const [installError, setInstallError] = useState<string | null>(null);
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
    setInstallError(null);
    setIsInstalling(false);
    setInstallError(null);
    setIsInstalling(false);
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
      // 下载完成就装上：用户点的是「更新」，不是「帮我把文件存下来」。
      // installUpdate 成功会让后端直接退出应用，这里不会返回。
      setIsInstalling(true);
      try {
        await installUpdate(path);
        // 走到这里说明应用没有退出——后端已 exit，属于不该发生的状态，如实报出来，
        // 免得界面永远停在「正在安装…」。
        setIsInstalling(false);
        setInstallError('安装器已启动，但应用未能自动退出，请手动关闭后重试。');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setIsInstalling(false);
        setInstallError(message);
        showToast(`自动安装未启动：${message}`, 'error');
      }
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
  // 与收藏页同理，本组件常驻 DOM、一生只挂载一次，依赖数组里必须带 currentView，
  // 否则这段"进入设置页时刷新"只在启动瞬间执行一次，之后每次进来看到的都是旧数字。
  useEffect(() => {
    if (currentView !== 'settings') return;
    void refreshCacheUsage();
  }, [currentView, refreshCacheUsage]);

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

  return (
    /* 滚动容器**撑满整个面板**，内容限宽交给内层。
       此前 `max-w-5xl mx-auto` 直接挂在滚动容器上：那个容器的宽度就成了
       1024px 并居中，于是**滚动条出现在容器右边缘**（面板内部约 3/4 处），
       右侧留出一条与内容同宽的空白——看起来像"页面没铺满"，而实际是
       滚动条被限宽框住了。把限宽下移一层，滚动条回到面板右边缘，
       内容仍然居中、行宽仍然可控。 */
    <div className="w-full h-full overflow-y-auto select-none">
      <div className="w-full max-w-5xl mx-auto p-8 flex flex-col gap-6 pb-24">
        {/* 页面主标题
            —— 与「我的追剧」「观看历史」对齐到同一套标题语言：`text-xl font-bold`
            + 一个 20px 的彩色 lucide 图标 + 一行 `text-xs` 说明。
            这里此前是「蓝底圆角方框包着 16px 图标」——那是**卡片标题**的语汇
            （本页每张卡的标题行正是这个写法），放在页面级标题上会让设置页的
            第一屏比其他页面重一个层级，用户从发现页切过来会觉得"换了一套设计"。
            图标色选 `text-blue-600`：设置页在本应用里属于"工具"类页面，
            与收藏页的玫瑰色、历史页的中性色一样，只用一处语义色点出身份。 */}
        <div className="pb-4 border-b border-black/[0.05] shrink-0">
          <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <Settings className="w-5 h-5 text-blue-600" />
            <span>设置</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            外观、播放体验、视频源与本地缓存
          </p>
        </div>

        {/* 1. 外观 */}
        <SectionCard icon={<Palette className="w-4 h-4 text-blue-600" />} title="外观">
          <SettingRow
            title="界面主题"
            hint={
              themePreference === 'system'
                // 「跟随系统」时必须告诉用户此刻落到哪一档：否则系统本身就是浅色时，
                // 点了"跟随系统"界面毫无变化，看起来像没生效。
                ? `正在跟随 Windows 的应用模式，当前为${systemIsDark ? '暗色' : '浅色'}。在系统设置里切换，这里会立即跟随。`
                : '暗色模式是黑红配色：黑底 + 红色强调，界面与播放器控制条一起变。选择会记住，重启后仍生效。'
            }
          >
            {/* 分段选择沿用 CategoryBar 那套：选中项凸起、未选中只留文字。
                样式与「默认清晰度」共用 `segmentedClass`，全页只长一个样。 */}
            <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100/80">
              {THEME_OPTIONS.map(option => {
                const Icon = option.icon;
                const selected = themePreference === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      // `saveTheme` 内部会 `resolveTheme`：选「跟随系统」时写进
                      // `data-theme` 的是系统此刻的值，不是字符串 "system"。
                      saveTheme(option.id);
                      setThemePreference(option.id);
                      // 切到跟随系统时，顺手同步一次当前系统状态，避免 hint 里
                      // 还留着上一次的旧值（系统事件只在**变化**时才会来）。
                      if (option.id === 'system') setSystemIsDark(systemPrefersDark());
                    }}
                    className={segmentedClass(selected)}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {option.label}
                  </button>
                );
              })}
            </div>
          </SettingRow>
        </SectionCard>

        {/* 2. 播放体验 */}
        <SectionCard icon={<Tv className="w-4 h-4 text-blue-600" />} title="播放体验">
          <SettingRow
            title="默认清晰度"
            hint="只决定「第一次打开某部剧」时请求哪一档。之后在播放器里切过的档位优先，不会每次都被这里覆盖。源里没有该档时后端自动回退到最接近的一档。"
          >
            {/* 这里此前是一个**只读的**「自动」徽章：字段 `defaultQuality` 在
                `usePlaybackStore` 里是真的被读去起播的，但用户没有任何入口改它 ——
                设置页展示了一个自己无权决定的设置。现在改成与「外观」同款分段控件，
                两项共用 `segmentedClass`，全页的分段选择只长一个样。 */}
            <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100/80">
              {QUALITY_OPTIONS.map(option => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={settings.defaultQuality === option.id}
                  onClick={() => updateSettings({ defaultQuality: option.id })}
                  title={option.hint}
                  className={segmentedClass(settings.defaultQuality === option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </SettingRow>

          <div className="pt-4 border-t border-black/[0.04]">
            <SettingRow
              title="剧集自动连播"
              hint="本集临近结尾时弹出圆环倒计时并自动平滑播放下一集"
            >
              <Toggle
                checked={settings.autoNext}
                onChange={value => updateSettings({ autoNext: value })}
                label="剧集自动连播"
              />
            </SettingRow>
          </div>

          {/* 启动音效：声音不走任何资源文件，是 Web Audio 现场合成的
              （services/launchAudio.ts），这里只是一个开关键。
              关掉它不会影响播放器的音量与音频，两者完全独立。 */}
          <div className="pt-4 border-t border-black/[0.04]">
            <SettingRow
              title="启动音效"
              hint="打开程序时的进场音与底噪。与播放器音量无关，关掉只影响启动动画。"
            >
              <Toggle
                checked={settings.launchSound !== false}
                onChange={value => updateSettings({ launchSound: value })}
                label="启动音效"
              />
            </SettingRow>
          </div>

          {/* RTX VSR 播放链路：开 = 源流转 H.264 分片（让驱动触发 VSR，首次起播
              稍慢），关 = 原始源直连（起播更快、无 VSR 增强）。文案必须如实——
              增强是完全由转码换来的，没有"档位"可选，见 AGENTS.md 不变量 8。
              与「视频清晰度」那行的"档位来自源流实测"是同一套诚实边界。 */}
          <div className="pt-4 border-t border-black/[0.04]">
            <SettingRow
              title="RTX VSR 视频增强"
              hint="打开：源流转码成 H.264 分片，让 NVIDIA 驱动做 RTX VSR 增强（首次起播多等一次转码）。关闭：回到原始源直连，起播更快，但没有 RTX VSR 增强。"
            >
              <Toggle
                checked={settings.vsrEnabled !== false}
                onChange={value => updateSettings({ vsrEnabled: value })}
                label="RTX VSR 视频增强"
              />
            </SettingRow>
          </div>
        </SectionCard>

        {/* 3. 网络与代理
            单独成卡而不是塞进「视频源」：这张卡管的是**红果官网链路**
            （provider.rs 抓 /category），而「视频源」管的是 guo 那 19 个站。
            两条链路用的是完全不同的网络栈，混在一张卡里会让用户以为
            改一处就能同时影响两边 —— 而它们互不相干。 */}
        <SectionCard icon={<Wifi className="w-4 h-4 text-blue-600" />} title="网络与代理">
          <SettingRow
            title="红果目录网络"
            hint="决定拉取红果短剧/漫剧目录时走不走系统代理。程序会在启动时探测一次；代理软件退出后仍报「目录加载失败」时，手动选「直连」。"
          >
            <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100/80">
              {PROXY_OPTIONS.map(option => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={settings.proxyMode === option.id}
                  title={option.hint}
                  onClick={() => updateSettings({ proxyMode: option.id })}
                  className={segmentedClass(settings.proxyMode === option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </SettingRow>

          <div className="pt-4 border-t border-black/[0.04]">
            <ProxyDiagnose />
          </div>
        </SectionCard>

        {/* 4. 视频源（按真人/漫剧归纳，18+ 总开关就在该组顶部） */}
        <SectionCard icon={<Server className="w-4 h-4 text-blue-600" />} title="视频源">
          {/* 这段说明此前混着实现细节（"2026-09-29 拉每个源的前 12 条看标题"），
              那是给维护者看的溯源信息，不是用户决策需要的东西。用户只需知道
              三件事：勾了会去哪、开多了会怎样、默认为什么这么少。
              长度从 4 行压到 2 行，卡片首屏就能看到第一个可点的源。 */}
          <p className={HINT_CLS}>
            勾选的源会一起汇入发现页：前两组进「短剧专区」与「漫剧次元」，18+ 那组在打开开关后独占「神秘小窝」。
            <span className="text-slate-500">勾得越多，首屏要并发等待的站点也越多</span>，最慢的那个决定首屏时间。
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
            /* 不再列举具体片名：那是维护期逐源核对的产物，对用户没有决策价值，
               而且把几个露骨片名直接印在设置页上，也超出了这一行的用途。
               用户只需要知道「它归哪个专区、受哪个开关管辖」。 */
            hint="逐源确认含成人条目。只汇入发现页的「神秘小窝」专区，不进短剧专区与漫剧次元。"
            sources={GUO_SOURCES.filter(item => item.adult)}
            enabled={enabledSources}
            locked={!settings.showAdultSources}
            onToggle={toggleSource}
            /* 总开关就放在它管辖的那一组顶部，而不是另开一张卡片：分开时用户
               要在两张卡之间来回找"这个开关管的是上面那几行"，而它其实就是
               这一组的门闩。关闭时该组置灰不可点，但**不取消已勾选项**——静默
               清空会让用户回来开开关时发现自己的选择没了。 */
            header={
              <Toggle
                checked={settings.showAdultSources}
                onChange={value => updateSettings({ showAdultSources: value })}
                label="显示 18+ 内容源"
              />
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
        </SectionCard>

        {/* 4. 本地存储与缓存 */}
        <SectionCard icon={<HardDrive className="w-4 h-4 text-blue-600" />} title="存储空间与本地缓存">
          <SettingRow
            title="剧集缓存"
            hint="播放过的剧集会缓存到本地，回看与换集时秒开。清理全自动，无需手动操作。"
          >
            <div className="flex items-center gap-2">
              <ValueBadge>{cacheLabel}</ValueBadge>
              {cacheUsage.files > 0 && (
                <span className="text-[11px] text-slate-400 font-mono">{cacheUsage.files} 集</span>
              )}
            </div>
          </SettingRow>

          <div className="pt-4 border-t border-black/[0.04]">
            <SettingRow
              title="自动清理上限"
              hint="短剧与漫剧缓存合计达到上限后，自动保留最近使用的剧集并淘汰最旧内容。默认 1 GB。"
            >
              <div className="flex items-center gap-2">
                <select
                  value={settings.playbackCacheMb}
                  onChange={event => updateSettings({ playbackCacheMb: Number(event.target.value) })}
                  className="h-8 rounded-lg border border-slate-200/80 bg-white px-2.5 text-xs font-semibold text-slate-700 shadow-xs outline-none focus:ring-2 focus:ring-blue-400/40 cursor-pointer"
                  aria-label="剧集缓存自动清理上限"
                >
                  <option value="512">512 MB</option>
                  <option value="1024">1 GB</option>
                  <option value="2048">2 GB</option>
                  <option value="4096">4 GB</option>
                </select>
                {/* 清理按钮从"卡片底部孤零零靠右"移进这一行。
                    理由有二：
                    ① 它清的就是这一行在配置的那份缓存，放一起才看得出因果关系；
                    ② 原来那颗按钮是页面上唯一 `size="md"` 的（其余全是 `sm`），
                       在卡片底部独占一行、比同卡所有控件都大一号，视觉重心被一个
                       破坏性操作抢走——那正好是最不该被强调的东西。
                    文案也从「立即全部清空」收敛成「清空缓存」：前者像一句警告，
                    而这是一个可随时重建的缓存，不是不可逆的数据删除。 */}
                <FluentButton
                  variant="secondary"
                  size="sm"
                  disabled={isCleaning}
                  icon={<RefreshCw className={`w-3 h-3 ${isCleaning ? 'animate-spin' : ''}`} />}
                  onClick={handleClearCache}
                >
                  {isCleaning ? '正在清理…' : '清空缓存'}
                </FluentButton>
              </div>
            </SettingRow>
          </div>
        </SectionCard>

        {/* 5. 版本与更新 */}
        <SectionCard icon={<Sparkles className="w-4 h-4 text-blue-600" />} title="版本与更新">
          <SettingRow
            title="当前版本"
            hint={
              <>
               从 GitHub Releases 拉取最新安装包，<span className="text-slate-600 font-medium">下载完成后会打开安装向导</span>，按提示完成即可。
              </>
            }
          >
            <div className="flex items-center gap-2">
              <ValueBadge>v{appVersion || '—'}</ValueBadge>
              <FluentButton
                variant="secondary"
                size="sm"
                disabled={!canUpdate || updateState.kind === 'checking'}
                icon={<RefreshCw className={`w-3.5 h-3.5 ${updateState.kind === 'checking' ? 'animate-spin' : ''}`} />}
                onClick={handleCheckUpdate}
              >
                {updateState.kind === 'checking' ? '正在检查…' : '检查更新'}
              </FluentButton>
            </div>
          </SettingRow>

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

              {/* 下载 / 安装进度。安装阶段没有百分比，用一条不确定宽度的脉冲条如实表达
                  "正在进行"，而不是拿下载的百分比假装还在下载。 */}
              {(isDownloading || isInstalling) && (
                <div className="flex flex-col gap-1.5">
                  <div className="h-1.5 w-full rounded-full bg-blue-200/60 overflow-hidden">
                    {isInstalling ? (
                      <div className="h-full w-1/3 bg-blue-600 animate-pulse" />
                    ) : (
                      <div
                        className="h-full bg-blue-600 rounded-full transition-[width] duration-200 ease-out"
                        style={{ width: `${progress?.percent ?? 0}%` }}
                      />
                    )}
                  </div>
                  <span className="text-[10px] font-mono text-slate-500">
                    {isInstalling
                      ? '下载完成，正在启动安装程序…'
                      : progress && progress.total > 0
                        ? `${formatBytes(progress.received)} / ${formatBytes(progress.total)} · ${progress.percent}%`
                        : '正在连接…'}
                  </span>
                </div>
              )}

              <div className="flex items-center gap-2 flex-wrap">
                {isInstalling ? (
                  // 安装阶段应用即将退出，不给任何可点的东西——点了也只是白点。
                  <span className="text-[11px] text-slate-500">安装程序启动后本应用会自动关闭…</span>
                ) : installError && savedPath ? (
                  // 安装向导没跑起来时的退路：把包暴露给用户自己双击，而不是重试一次
                  // 大概率同样失败的下载。
                  <FluentButton
                    variant="primary"
                    size="sm"
                    icon={<FolderSearch className="w-3.5 h-3.5" />}
                    onClick={handleReveal}
                  >
                    打开安装包所在文件夹
                  </FluentButton>
                ) : (
                  <FluentButton
                    variant="primary"
                    size="sm"
                    disabled={isDownloading || !updateState.info.assetUrl}
                    icon={<Download className="w-3.5 h-3.5" />}
                    onClick={handleDownload}
                  >
                    {isDownloading ? '正在下载…' : '下载并安装'}
                  </FluentButton>
                )}
              </div>
              {installError && (
                <p className="text-[11px] text-amber-700 leading-relaxed">
                  安装程序未能启动：{installError}。已下载的安装包在下方可手动打开。
                </p>
              )}
            </div>
          )}
        </SectionCard>

        {/* 6. 关于与日志诊断 */}
        <SectionCard icon={<FileText className="w-4 h-4 text-blue-600" />} title="客户端信息与诊断">
          <SettingRow
            title="TTV Short Drama 独立桌面客户端"
            hint="基于 Tauri + React 19 + TypeScript 构建 · 硬件加速渲染已启用"
          >
            {/* 这里曾有一个写死的「Mica Light」徽章。删掉的理由不是它占地方，
                而是它**恒为 Light**：暗色主题下界面已经变成黑红配色，这个徽章
                仍宣称 "Mica Light"，是一句当场就能被用户证伪的陈述。
                它也不携带任何可操作信息——真正的构建信息在下面那行 hint 里，
                导出日志里也有完整快照（`os` 字段）。 */}
            <FluentButton
              variant="secondary"
              size="sm"
              icon={<FolderOpen className="w-3.5 h-3.5" />}
              onClick={handleExportLogs}
            >
              导出匿名运行日志
            </FluentButton>
          </SettingRow>

          <PlaybackLogPanel />
        </SectionCard>
      </div>
    </div>
  );
};

import { isTauriEnvironment } from './ipc';
import { currentWindowLabel } from './pip';

/**
 * 智能体联动的前端侧协议（与 `src-tauri/src/agent_bridge.rs` 一一对应）。
 *
 * ## 全链路
 *
 * 智能体工具的 hook（一段 shell 命令，由设置页一键复制）在事件发生时 POST
 * 到 `127.0.0.1:7812` → Rust 桥校验后 `emit_to('main', 'agent://event', …)`
 * → `AgentWatchBridge`（组件）监听并驱动暂停/呼叫/收起/回播。
 *
 * ## 为什么"天然支持所有智能体工具"
 *
 * 各家智能体的 hook 机制（Claude Code settings.json / Codex hooks.json /
 * Gemini settings.json / Cursor hooks.json / opencode 插件……）千差万别，但都
 * 有一个共同点：**事件发生时能执行任意 shell 命令**。桥只约定一行 POST，
 * 所以"新增支持一个智能体"= 多复制一段 hook 配置，桥与前端零改动——这是
 * agent-notifications（817★）与 Clawd on Desk（6.5k★）共同验证过的架构。
 */

/** 与 Rust 侧 `EVENT_AGENT_EVENT` 必须一致。 */
export const AGENT_EVENT_EVENT = 'agent://event';

/** 事件分类（与 agent-notifications 的通知类型对齐）。 */
export type AgentEventType = 'done' | 'action' | 'question' | 'error';

/** Rust 侧 `AgentEvent` 的前端镜像（camelCase）。 */
export interface AgentEvent {
  eventType: AgentEventType;
  /** 智能体工具标识，如 "claude-code" / "codex" / "gemini" / "ttv-test"。 */
  agent: string;
  /** 事件摘要（已截断；不可信数据，仅展示）。 */
  message: string;
  /** 项目目录名（用于区分是哪个任务在呼叫）。 */
  project: string | null;
  /** 桥收到事件的本地时间戳（毫秒）。 */
  timestamp: number;
}

/** 事件的用户可读文案（呼叫卡与悬浮卡共用）。 */
export function agentEventLabel(type: AgentEventType): string {
  switch (type) {
    case 'done': return '任务完成';
    case 'action': return '需要操作';
    case 'question': return '需要抉择';
    case 'error': return '运行出错';
  }
}

/** 智能体工具的显示名（未知标识原样展示）。 */
export function agentDisplayName(agent: string): string {
  const known: Record<string, string> = {
    'claude-code': 'Claude Code',
    'claude': 'Claude Code',
    'codex': 'Codex CLI',
    'gemini': 'Gemini CLI',
    'cursor': 'Cursor Agent',
    'copilot': 'Copilot CLI',
    'opencode': 'OpenCode',
    'qwen': 'Qwen Code',
    'grok': 'Grok Build',
    'kimi': 'Kimi Code',
    'opencclaw': 'OpenClaw',
    'ttv-test': '链路测试',
  };
  return known[agent] ?? agent;
}

/** 查询桥状态（端口）。非 Tauri 环境返回 0。 */
export async function agentBridgePort(): Promise<number> {
  if (!isTauriEnvironment()) return 0;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const r = await invoke<{ port: number }>('agent_bridge_status');
    return r.port ?? 0;
  } catch {
    return 0;
  }
}

/**
 * 发送测试事件（设置页「测试联动」按钮）。广播一条 question 事件走完整链路
 * （桥 → 前端事件 → 暂停 → 卡片），让用户不开智能体也能验证联动是否工作。
 */
export async function agentTestCall(eventType: AgentEventType = 'question'): Promise<void> {
  if (!isTauriEnvironment()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('agent_test_call', { eventType });
}

/** 订阅智能体事件。返回 unlisten；非 Tauri 环境返回空操作（照 listenPip 模式）。 */
export async function listenAgentEvent(
  handler: (event: AgentEvent) => void,
): Promise<() => void> {
  if (!isTauriEnvironment()) return () => {};
  try {
    const { listen } = await import('@tauri-apps/api/event');
    return await listen<AgentEvent>(AGENT_EVENT_EVENT, message => handler(message.payload));
  } catch {
    return () => {};
  }
}

/** 智能体悬浮窗的窗口标签（与 Rust `agent_dock::WINDOW_LABEL` 一致）。 */
export const AGENT_DOCK_WINDOW_LABEL = 'agentdock';

/** 当前是否运行在智能体悬浮窗里。 */
export function isAgentDockWindow(): boolean {
  return currentWindowLabel() === AGENT_DOCK_WINDOW_LABEL;
}

// ---------------------------------------------------------------------------
// 自动接入：由 Rust 侧直接改写各智能体工具的 hook 配置
// ---------------------------------------------------------------------------

/** 一个智能体工具的接入状态（Rust `AgentTarget` 的镜像）。 */
export interface AgentTarget {
  id: string;
  name: string;
  configPath: string;
  installed: boolean;
  connected: boolean;
  events: string[];
  note: string | null;
}

/** 自动接入结果。 */
export interface AttachReport {
  targets: AgentTarget[];
  attached: string[];
  failed: Array<[string, string]>;
  backups: string[];
}

async function invokeAgent<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauriEnvironment()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<T>(cmd, args);
  } catch (error) {
    console.warn(`[agent] ${cmd} 失败`, error);
    return null;
  }
}

/** 列出本机智能体工具的接入状态。 */
export async function agentTargets(port: number): Promise<AgentTarget[]> {
  return (await invokeAgent<AgentTarget[]>('agent_targets', { port })) ?? [];
}

/**
 * 一键自动接入：把**已安装**的工具全部接上（幂等，可重复调用）。
 *
 * 这是"全面实现自动接入"的入口：用户只需打开开关，程序自己识别本机装了
 * 哪些智能体工具、各自配置在哪、事件叫什么，然后合并式写入（不覆盖用户已有
 * 配置，写前备份）。
 */
export async function agentAttachAll(port: number): Promise<AttachReport | null> {
  return invokeAgent<AttachReport>('agent_attach_all', { port });
}

/** 断开：把本程序写入的 hook 条目全部摘干净（用户关掉开关时调用）。 */
export async function agentDetachAll(): Promise<string[]> {
  return (await invokeAgent<string[]>('agent_detach_all')) ?? [];
}

// ---------------------------------------------------------------------------
// 独立悬浮窗控制
// ---------------------------------------------------------------------------

/** 悬浮窗要展示的内容（与 Rust `agent_dock::DockState` 同形）。 */
export interface DockState {
  title: string;
  cover: string;
  episodeNumber: number;
  position: number;
  duration: number;
  agentName: string;
  eventType: AgentEventType;
  message: string;
  project: string;
  isAnime: boolean;
}

/** 显示/更新悬浮窗。 */
export async function showAgentDock(state: DockState): Promise<void> {
  await invokeAgent('agent_dock_show', { state });
}

/** 收起悬浮窗。 */
export async function hideAgentDock(): Promise<void> {
  await invokeAgent('agent_dock_hide');
}

/** 订阅悬浮窗动作（resume / close），主窗口据此续播或清理。 */
export async function listenAgentDockAction(
  handler: (action: 'resume' | 'close') => void,
): Promise<() => void> {
  if (!isTauriEnvironment()) return () => {};
  try {
    const { listen } = await import('@tauri-apps/api/event');
    return await listen<string>('agent://dock-action', message => {
      if (message.payload === 'resume' || message.payload === 'close') handler(message.payload);
    });
  } catch {
    return () => {};
  }
}

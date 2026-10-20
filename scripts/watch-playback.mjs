#!/usr/bin/env node
/**
 * 播放链路实时监测。
 *
 * ## 为什么单独做一个脚本
 *
 * 阶段 A / B 修的是两类"看不见"的问题：
 *   1. HTTP 状态语义 —— 分片该等还是该死，取决于后端返 503 还是 410；
 *   2. 产物身份 —— 换集后旧 URL 会不会读到新目录。
 *
 * 这两件事在界面上只表现为"卡了一下"或"没卡"，无法区分原因。而这个脚本把
 * 日志里散落的多行拼成**可判读的结论**：
 *
 *   - `fragLoadError` 连续出现 → 分片供给断了，看后面跟的是 503（在等）还是 410（判死）
 *   - `410` 出现在换集之后 → 身份串线的嫌疑
 *   - `恢复预算耗尽` → 无界重试；不该出现
 *   - `timeupdate 心跳` 停止 → 画面真的停了
 *
 * ## 用法
 *
 *   node scripts/watch-playback.mjs            # 实时跟随
 *   node scripts/watch-playback.mjs --from-tail 500   # 只看最后 500 行
 *   node scripts/watch-playback.mjs --summary  # 只打汇总，不逐条
 *
 * 退出：Ctrl+C。退出时打印本次会话的完整统计。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOG_PATH = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'com.ttv.shortdrama',
  'ttv-playback.log',
);

/** 只看最后 N 行（避免一上来刷屏）。0 表示从头。 */
const args = process.argv.slice(2);
const tailIndex = args.indexOf('--from-tail');
const FROM_TAIL = tailIndex >= 0 ? Number(args[tailIndex + 1] || 300) : 200;
const SUMMARY_ONLY = args.includes('--summary');

// ── 颜色：无依赖，Windows Terminal / VS Code 终端都认 ANSI ──────────────
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

/**
 * 本次会话的累计统计。退出时打出来 —— 这是判断"有没有变好"的唯一客观依据。
 */
const stats = {
  fragErrors: 0,
  manifestErrors: 0,
  http410: 0,
  http503: 0,
  http403: 0,
  recoveries: 0,
  budgetExhausted: 0,
  finalErrors: 0,
  staleDrops: 0,
  heartbeats: 0,
  /** 连续 fragLoadError 的最长链条（条数）。对应"卡了多久"。 */
  worstFragStreak: 0,
  /** 当前连续 fragLoadError 计数。 */
  fragStreak: 0,
  /** 最后一条心跳的播放位置，用于判断画面是否真的在走。 */
  lastPosition: null,
  lastHeartbeatAt: null,
  startedAt: Date.now(),
  /** 产物身份相关：从日志里抽到的 (会话 → 产物目录) 映射，用于发现串线。 */
  sessionArtifacts: new Map(),
};

/** 一行日志是否值得高亮。返回 null 表示按普通行处理。 */
function classify(line) {
  // ── 致命：分片/清单拉不到 ──
  if (line.includes('details=fragLoadError')) {
    stats.fragErrors += 1;
    stats.fragStreak += 1;
    stats.worstFragStreak = Math.max(stats.worstFragStreak, stats.fragStreak);
    return { level: 'warn', tag: '分片' };
  }
  // 其它行打断连续失败链
  stats.fragStreak = 0;

  if (line.includes('details=manifestLoadError')) {
    stats.manifestErrors += 1;
    return { level: 'warn', tag: '清单' };
  }
  // ── HTTP 状态语义（阶段 A 的核心）──
  if (line.includes('401') || line.includes('410 Gone')) {
    stats.http410 += 1;
    return { level: 'error', tag: '410' };
  }
  if (line.includes('503 Service') || line.includes('503')) {
    stats.http503 += 1;
    return { level: 'info', tag: '503' };
  }
  if (line.includes('403 Forbidden') || line.includes('令牌无效')) {
    stats.http403 += 1;
    return { level: 'error', tag: '403' };
  }
  // ── 恢复链路 ──
  if (line.includes('流式源自愈')) {
    stats.recoveries += 1;
    return { level: 'info', tag: '自愈' };
  }
  if (line.includes('恢复预算耗尽')) {
    stats.budgetExhausted += 1;
    return { level: 'error', tag: '预算耗尽' };
  }
  if (line.includes('自愈额度已用尽')) {
    return { level: 'warn', tag: '内层额度' };
  }
  // ── 终态 ──
  if (line.includes('MediaError') || line.includes('重挂源') || line.includes('判死')) {
    stats.finalErrors += 1;
    return { level: 'error', tag: '终态' };
  }
  // ── 换集 / 身份（阶段 B 的核心）──
  if (line.includes('打开集')) return { level: 'mark', tag: '换集' };
  if (line.includes('产物=')) return { level: 'mark', tag: '产物' };
  if (line.includes('收到旧形态地址')) return { level: 'warn', tag: '旧URL' };
  if (line.includes('timeupdate 丢弃') || line.includes('迟到事件')) {
    stats.staleDrops += 1;
    return { level: 'dim', tag: '迟到' };
  }
  // ── 心跳：判断画面是否真的在走 ──
  if (line.includes('timeupdate 心跳')) {
    stats.heartbeats += 1;
    const m = line.match(/位置=([0-9.]+)s 时长=([0-9.]+)s/);
    if (m) {
      stats.lastPosition = Number(m[1]);
      stats.lastHeartbeatAt = Date.now();
    }
    return { level: 'dim', tag: '心跳' };
  }
  if (line.includes('整集 HLS 出画') || line.includes('出画 耗时')) {
    return { level: 'good', tag: '出画' };
  }
  return null;
}

const LEVEL_COLOR = {
  error: C.red,
  warn: C.yellow,
  info: C.cyan,
  good: C.green,
  mark: C.magenta,
  dim: C.dim,
};

function render(line) {
  const hit = classify(line);
  if (!hit) {
    if (SUMMARY_ONLY) return;
    process.stdout.write(`${C.dim}${line}${C.reset}\n`);
    return;
  }
  if (SUMMARY_ONLY && hit.level === 'dim') return;
  const color = LEVEL_COLOR[hit.level] || C.reset;
  const tag = hit.tag.padEnd(6, ' ');
  process.stdout.write(`${color}[${tag}]${C.reset} ${line}\n`);
}

/** 每 10 秒打一行状态，让人能一眼看出"现在有没有在正常播"。 */
function statusLine() {
  const idle = stats.lastHeartbeatAt ? Math.round((Date.now() - stats.lastHeartbeatAt) / 1000) : null;
  const pos = stats.lastPosition === null ? '—' : `${stats.lastPosition.toFixed(1)}s`;
  const parts = [
    `${C.bold}位置${C.reset} ${pos}`,
    `距心跳 ${idle === null ? '—' : `${idle}s`}`,
    `${C.yellow}分片错${C.reset} ${stats.fragErrors}`,
    `最长连错 ${stats.worstFragStreak}`,
  ];
  const line = parts.join(' │ ');
  process.stdout.write(`\n${C.blue}── ${line} ──${C.reset}\n`);
}

function printSummary() {
  const mins = ((Date.now() - stats.startedAt) / 60000).toFixed(1);
  const rows = [
    ['运行时长', `${mins} 分钟`],
    ['分片错误 fragLoadError', String(stats.fragErrors)],
    ['  其中最长连续', String(stats.worstFragStreak)],
    ['清单错误 manifestLoadError', String(stats.manifestErrors)],
    ['HTTP 503（在等，正常）', String(stats.http503)],
    ['HTTP 410（判死）', String(stats.http410)],
    ['HTTP 403（令牌）', String(stats.http403)],
    ['流式源自愈触发', String(stats.recoveries)],
    ['恢复预算耗尽（不该出现）', String(stats.budgetExhausted)],
    ['终态错误', String(stats.finalErrors)],
    ['迟到事件丢弃', String(stats.staleDrops)],
    ['心跳次数', String(stats.heartbeats)],
  ];
  process.stdout.write(`\n${C.bold}════ 本次监测汇总 ════${C.reset}\n`);
  for (const [k, v] of rows) {
    const bad = (k.includes('不该出现') && v !== '0') || (k.includes('判死') && v !== '0');
    process.stdout.write(`  ${bad ? C.red : C.reset}${k.padEnd(28, ' ')} ${v}${C.reset}\n`);
  }
  // 判读提示：把数字翻译成结论，省掉人工比对
  process.stdout.write(`\n${C.bold}判读${C.reset}\n`);
  if (stats.budgetExhausted > 0) {
    process.stdout.write(`  ${C.red}✗ 出现了恢复预算耗尽 —— 说明重试仍在上界处被截断，需检查预算值${C.reset}\n`);
  } else if (stats.http410 > 0) {
    process.stdout.write(`  ${C.yellow}! 出现过 410 判死 —— 确认是否都发生在"产物已完整"或"产物不存在"之后${C.reset}\n`);
  } else if (stats.worstFragStreak > 24) {
    process.stdout.write(`  ${C.yellow}! 单次连续分片失败超过重试预算（24）—— 检查是否该返 503 的分支返了别的码${C.reset}\n`);
  } else if (stats.fragErrors === 0) {
    process.stdout.write(`  ${C.green}✓ 全程无分片错误 —— 阶段 A 的状态语义修复生效${C.reset}\n`);
  } else {
    process.stdout.write(`  ${C.green}✓ 分片错误 ${stats.fragErrors} 次但最长连续 ${stats.worstFragStreak} 条，都在重试预算内并被消化${C.reset}\n`);
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────
if (!fs.existsSync(LOG_PATH)) {
  process.stdout.write(`${C.red}找不到日志：${LOG_PATH}${C.reset}\n`);
  process.stdout.write(`先启动应用（npm run tauri dev 或 start-dev-safe.bat），播放一集后再运行本脚本。\n`);
  process.exit(1);
}

process.stdout.write(`${C.bold}监测 ${LOG_PATH}${C.reset}\n`);
process.stdout.write(`${C.dim}只显示关键行；--summary 只看非常规事件；Ctrl+C 退出并汇总${C.reset}\n\n`);

// 先回放尾部若干行，让人立刻看到"当前处在什么状态"
const all = fs.readFileSync(LOG_PATH, 'utf8').split(/\r?\n/);
const startIndex = FROM_TAIL > 0 ? Math.max(0, all.length - FROM_TAIL) : 0;
for (let i = startIndex; i < all.length; i += 1) {
  if (all[i]) render(all[i]);
}

// 从文件末尾开始跟随
let position = fs.statSync(LOG_PATH).size;
let buffer = '';
let ticker = setInterval(statusLine, 10_000);

fs.watchFile(LOG_PATH, { interval: 400 }, (curr) => {
  if (curr.size < position) {
    // 日志被截断（应用重启）—— 从头读
    position = 0;
    buffer = '';
  }
  if (curr.size === position) return;
  const stream = fs.createReadStream(LOG_PATH, { start: position, end: curr.size - 1, encoding: 'utf8' });
  position = curr.size;
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) render(line);
    }
  });
});

function shutdown() {
  clearInterval(ticker);
  fs.unwatchFile(LOG_PATH);
  printSummary();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

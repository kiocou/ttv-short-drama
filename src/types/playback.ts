export type PlaybackUiState =
  | { kind: 'idle' }
  | { kind: 'opening'; sessionId: number; episodeId: string }
  | { kind: 'buffering'; sessionId: number; bufferedSeconds?: number }
  | { kind: 'playing'; sessionId: number; position: number; duration?: number }
  | { kind: 'recovering'; sessionId: number; attempt: number; reason: string }
  | { kind: 'ended'; sessionId: number; nextEpisodeId?: string }
  | { kind: 'error'; sessionId: number; code: string; recoverable: boolean };

export interface PlaybackSession {
  sessionId: number;
  seriesId: string;
  episodeId: string;
  position: number;
  quality: string;
  url: string;
  backupUrl?: string;
  /**
   * 源流形态（只有动漫链路下发）。
   *
   * 为什么必须由后端给：动漫的所有地址都会经本地代理重写成 `/stream?u=…`，
   * 前端无法从外观区分 m3u8 与整段 MP4；而 WebView2 的
   * `canPlayType('application/vnd.apple.mpegurl')` 又谎报 `"maybe"`，
   * 导致 m3u8 被直接喂给原生 `<video>`（15 秒后 `videoWidth=0`，只有声音）。
   */
  streamKind?: 'hls' | 'file';
}

export interface PlaybackSnapshot {
  sessionId: number;
  state: PlaybackUiState;
  position: number;
  duration: number;
  buffered: number;
  volume: number;
  muted: boolean;
  playbackRate: number;
}

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

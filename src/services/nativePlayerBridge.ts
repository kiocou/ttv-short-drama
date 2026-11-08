export interface NativePlayerState {
  playing: boolean;
  position: number;
  duration: number;
  volume: number;
  speed: number;
  frameInterpolation: boolean;
  frameMultiplier: number;
  fullscreen: boolean;
  title: string;
  episode: number;
}

export type NativePlayerCommand =
  | { action: 'pause' | 'play' | 'prev' | 'next' | 'fullscreen' | 'quit' }
  | { action: 'seek'; pos: number }
  | { action: 'volume'; v: number }
  | { action: 'speed'; rate: number }
  | { action: 'fg'; on: boolean; mult: number };

export function readNativePlayerPort(search: string): number | null {
  const value = Number(new URLSearchParams(search).get('controlPort'));
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
}

export function normalizeNativePlayerState(value: unknown): NativePlayerState | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Record<string, unknown>;
  const finite = (key: string): number | null =>
    typeof state[key] === 'number' && Number.isFinite(state[key]) ? state[key] as number : null;
  const position = finite('pos');
  const duration = finite('dur');
  const volume = finite('volume');
  const speed = finite('speed');
  const episode = finite('ep');
  const multiplier = finite('mult');
  if (typeof state.playing !== 'boolean' || typeof state.fg !== 'boolean'
      || typeof state.fullscreen !== 'boolean' || typeof state.title !== 'string'
      || position === null || duration === null || duration <= 0
      || volume === null || volume < 0 || volume > 100
      || speed === null || speed <= 0
      || episode === null || !Number.isInteger(episode)
      || multiplier === null || ![2, 3, 4, 5].includes(multiplier)) return null;
  return {
    playing: state.playing,
    position: Math.max(0, position),
    duration,
    volume,
    speed,
    frameInterpolation: state.fg,
    frameMultiplier: multiplier,
    fullscreen: state.fullscreen,
    title: state.title,
    episode,
  };
}

export async function fetchNativePlayerState(port: number, signal?: AbortSignal): Promise<NativePlayerState> {
  const response = await fetch(`http://127.0.0.1:${port}/state`, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`播放器状态读取失败（HTTP ${response.status}）`);
  const state = normalizeNativePlayerState(await response.json());
  if (!state) throw new Error('播放器返回的状态格式无效。');
  return state;
}

export async function sendNativePlayerCommand(port: number, command: NativePlayerCommand): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/cmd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error(`播放器控制命令失败（HTTP ${response.status}）`);
}

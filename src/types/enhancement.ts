export type EnhancementEngine = 'xiaohuangya' | 'rife' | 'compatible' | 'off';

export type EnhancementUiState =
  | { kind: 'off' }
  | { kind: 'probing' }
  | { kind: 'warming'; engine: string }
  | { kind: 'running'; engine: string; outputFps?: number }
  | { kind: 'degraded'; engine: string; reason: string }
  | { kind: 'faulted'; reason: string };

export interface EnhancementCapabilities {
  supportedEngines: {
    id: EnhancementEngine;
    name: string;
    description: string;
    targetFps: number;
    recommended: boolean;
  }[];
  gpuName: string;
  driverVersion: string;
  vramMb: number;
}

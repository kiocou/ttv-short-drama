import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { EnhancementEngine, EnhancementUiState, EnhancementCapabilities } from '../types/enhancement';
import { ipcService } from '../services/ipc';

interface EnhancementContextType {
  engine: EnhancementEngine;
  uiState: EnhancementUiState;
  targetFps: number;
  currentFps: number;
  decodeFps: number;
  droppedFrames: number;
  latencyMs: number;
  capabilities: EnhancementCapabilities | null;
  setEngine: (engine: EnhancementEngine) => Promise<void>;
  simulateDegrade: () => void;
  resetDegrade: () => void;
}

const EnhancementContext = createContext<EnhancementContextType | null>(null);

export const EnhancementProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [engine, setEngineState] = useState<EnhancementEngine>('off');
  const [uiState, setUiState] = useState<EnhancementUiState>({ kind: 'probing' });
  const [targetFps, setTargetFps] = useState<number>(60);
  const [currentFps, setCurrentFps] = useState<number>(0);
  const [decodeFps] = useState<number>(0);
  const [droppedFrames, setDroppedFrames] = useState<number>(0);
  const [latencyMs, setLatencyMs] = useState<number>(0);
  const [capabilities, setCapabilities] = useState<EnhancementCapabilities | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([ipcService.enhancement.getCapabilities(), ipcService.enhancement.getStatus()])
      .then(([capabilities, status]) => {
        if (!active) return;
        setCapabilities(capabilities);
        if (!status || !status.enabled) {
          setEngineState('off');
          setUiState({ kind: 'off' });
          setCurrentFps(status?.actualFps || 0);
          setLatencyMs(0);
          return;
        }
        const activeEngine: EnhancementEngine = status.mode.toLowerCase().includes('rife') ? 'rife' : 'compatible';
        setEngineState(activeEngine);
        setTargetFps(status.displayFps || 60);
        setCurrentFps(status.actualFps || 0);
        setLatencyMs(0);
        setUiState(status.fallbackActive
          ? { kind: 'degraded', engine: activeEngine, reason: status.reason || '后端已降级增强链路。' }
          : { kind: 'running', engine: activeEngine, outputFps: status.actualFps || undefined });
      })
      .catch(error => {
        if (active) setUiState({ kind: 'faulted', reason: (error as Error).message || '增强状态读取失败。' });
      });
    return () => { active = false; };
  }, []);

  const setEngine = async (newEngine: EnhancementEngine) => {
    if (!capabilities?.supportedEngines.some(item => item.id === newEngine)) {
      throw new Error('该增强引擎未由当前项目后端提供。');
    }
    if (newEngine === 'off') {
      await ipcService.enhancement.setPreference(newEngine, 60);
      setEngineState(newEngine);
      setUiState({ kind: 'off' });
      setTargetFps(60);
      setCurrentFps(0);
      setLatencyMs(0);
      return;
    }

    setUiState({ kind: 'warming', engine: newEngine });
    await ipcService.enhancement.setPreference(newEngine, 60);
    const status = await ipcService.enhancement.getStatus();
    setEngineState(newEngine);
    setTargetFps(status?.displayFps || 60);
    setCurrentFps(status?.actualFps || 0);
    setLatencyMs(0);
    setUiState(status?.fallbackActive
      ? { kind: 'degraded', engine: newEngine, reason: status.reason || '后端已降级增强链路。' }
      : { kind: 'running', engine: newEngine, outputFps: status?.actualFps || undefined });
  };

  const simulateDegrade = () => {
    setUiState({
      kind: 'degraded',
      engine: engine,
      reason: 'GPU 渲染超时，自动降级为原生帧率保护播放',
    });
  };

  const resetDegrade = () => {
    setEngine(engine);
  };

  return (
    <EnhancementContext.Provider
      value={{
        engine,
        uiState,
        targetFps,
        currentFps,
        decodeFps,
        droppedFrames,
        latencyMs,
        capabilities,
        setEngine,
        simulateDegrade,
        resetDegrade,
      }}
    >
      {children}
    </EnhancementContext.Provider>
  );
};

export function useEnhancementStore() {
  const ctx = useContext(EnhancementContext);
  if (!ctx) throw new Error('useEnhancementStore must be used within EnhancementProvider');
  return ctx;
}

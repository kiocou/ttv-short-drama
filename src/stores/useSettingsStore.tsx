import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { UserSettings } from '../types/settings';
import { ipcService, DEFAULT_SETTINGS } from '../services/ipc';

interface SettingsContextType {
  settings: UserSettings;
  updateSettings: (partial: Partial<UserSettings>) => void;
  clearCache: () => Promise<number>;
  /** 真实缓存占用（字节）与文件数，来自后端实际扫描，而非设置里的估算值。 */
  cacheUsage: { files: number; bytes: number };
  refreshCacheUsage: () => Promise<void>;
}

const SettingsContext = createContext<SettingsContextType | null>(null);

export const SettingsProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [cacheUsage, setCacheUsage] = useState<{ files: number; bytes: number }>({ files: 0, bytes: 0 });

  useEffect(() => {
    let active = true;
    ipcService.settings.get()
      .then(saved => {
        if (active) setSettings(saved);
      })
      .catch(error => console.warn('Settings load failed:', error));
    return () => { active = false; };
  }, []);

  // 真实占用：此前界面显示的是 settings.catalogCacheMb + playbackCacheMb，
  // 而这两个字段被后端强制归零（"不做字节级统计，报 0 而不是编造数字"），
  // 于是设置页永远显示 0.0 MB，与实际占用完全脱节。现在改为直接向后端查询
  // 真实扫描结果。
  const refreshCacheUsage = async (): Promise<void> => {
    try {
      setCacheUsage(await ipcService.settings.cacheUsage());
    } catch {
      // 查询失败不影响设置页其他功能。
    }
  };

  const updateSettings = (partial: Partial<UserSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...partial };
      void ipcService.settings.save(next).catch(error => console.warn('Settings save failed:', error));
      return next;
    });
  };

  const clearCache = async (): Promise<number> => {
    const res = await ipcService.settings.clearCache();
    await refreshCacheUsage();
    return res.freedMb;
  };

  return (
    <SettingsContext.Provider
      value={{
        settings,
        updateSettings,
        clearCache,
        cacheUsage,
        refreshCacheUsage,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
};

export function useSettingsStore() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettingsStore must be used within SettingsProvider');
  return ctx;
}

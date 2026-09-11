import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { UserSettings } from '../types/settings';
import { ipcService, DEFAULT_SETTINGS } from '../services/ipc';

interface SettingsContextType {
  settings: UserSettings;
  updateSettings: (partial: Partial<UserSettings>) => void;
  clearCache: () => Promise<number>;
}

const SettingsContext = createContext<SettingsContextType | null>(null);

export const SettingsProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    let active = true;
    ipcService.settings.get()
      .then(saved => {
        if (active) setSettings(saved);
      })
      .catch(error => console.warn('Settings load failed:', error));
    return () => { active = false; };
  }, []);

  const updateSettings = (partial: Partial<UserSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...partial };
      void ipcService.settings.save(next).catch(error => console.warn('Settings save failed:', error));
      return next;
    });
  };

  const clearCache = async (): Promise<number> => {
    const res = await ipcService.settings.clearCache();
    updateSettings({
      catalogCacheMb: 0,
      playbackCacheMb: 0,
    });
    return res.freedMb;
  };

  return (
    <SettingsContext.Provider
      value={{
        settings,
        updateSettings,
        clearCache,
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

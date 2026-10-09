import { localStorageColorSchemeManager } from '@mantine/core';
import type { MantineColorScheme } from '@mantine/core';

type Appearance = { language?: 'en' | 'zh'; colorScheme?: MantineColorScheme };
declare global {
  interface Window {
    mossentryAppearance?: {
      get: () => Appearance;
      set: (key: keyof Appearance, value: string) => Promise<void>;
    };
  }
}
const bridge = typeof window === 'undefined' ? undefined : window.mossentryAppearance;
const saved: Appearance = bridge?.get() ?? {};

export function savedLanguage() { return bridge ? saved.language : undefined; }
export function persistPreference<K extends keyof Appearance>(key: K, value: NonNullable<Appearance[K]>) {
  saved[key] = value;
  if (bridge) void bridge.set(key, value).catch(error => console.warn('Could not save appearance preference', error));
}

const browserManager = localStorageColorSchemeManager({ key: 'mossentry-color-scheme' });
export const colorSchemeManager = {
  ...browserManager,
  get: (defaultValue: MantineColorScheme) => (bridge ? saved.colorScheme : undefined) ?? browserManager.get(defaultValue),
  set(value: MantineColorScheme) {
    browserManager.set(value);
    persistPreference('colorScheme', value);
  },
  clear() {
    browserManager.clear();
    persistPreference('colorScheme', 'light');
  },
};

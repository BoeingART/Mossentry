import { useSyncExternalStore } from 'react';
import { persistPreference, savedLanguage } from './preferences.ts';
import { zh } from './translations.ts';

export type Language = 'en' | 'zh';
const storageKey = 'mossentry-language';
function readLanguage(): Language {
  const nativeLanguage = savedLanguage();
  if (nativeLanguage) return nativeLanguage;
  try { return localStorage.getItem(storageKey) === 'zh' ? 'zh' : 'en'; }
  catch { return 'en'; }
}
let language = readLanguage();
const listeners = new Set<() => void>();

function updateDocument() {
  if (typeof document !== 'undefined') document.documentElement.lang = locale();
}
function publish(next: Language) {
  language = next;
  updateDocument();
  listeners.forEach(listener => listener());
}
export function setLanguage(next: Language) {
  persistPreference('language', next);
  try { localStorage.setItem(storageKey, next); } catch { /* Still switch in memory if storage is unavailable. */ }
  publish(next);
}
export function locale() { return language === 'zh' ? 'zh-CN' : 'en-US'; }
export function t(source: string, values: Record<string, unknown> = {}): string {
  const text = language === 'zh' ? (zh[source] ?? source) : source;
  return text.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key] ?? '') : match);
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function useLanguage() {
  return useSyncExternalStore(subscribe, () => language, () => 'en' as Language);
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key === storageKey || event.key === null) publish(readLanguage());
  });
  updateDocument();
}

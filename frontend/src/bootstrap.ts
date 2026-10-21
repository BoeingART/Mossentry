import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

async function boot() {
  if (isTauri()) {
    document.documentElement.classList.add(navigator.platform.startsWith('Mac') ? 'desktop-mac' : 'desktop-other');
    const preferences = await invoke<{ language?: 'en' | 'zh'; colorScheme?: 'light' | 'dark' | 'auto' }>('get_appearance');
    window.mossentryAppearance = {
      get: () => preferences,
      set: (key, value) => invoke('set_appearance', { key, value }),
    };
  }
  // Appearance and language must be restored before i18n and Mantine initialize.
  await import('./main');
  if (isTauri()) await getCurrentWindow().show();
}
void boot().catch(async error => {
  console.error('Mossentry startup failed', error);
  const root = document.getElementById('root');
  if (root) root.textContent = 'Mossentry could not start. Please reopen the app.';
  if (isTauri()) await getCurrentWindow().show();
});

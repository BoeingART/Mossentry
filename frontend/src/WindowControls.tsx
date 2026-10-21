import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { IconMinus, IconSquare, IconX } from '@tabler/icons-react';
import { t } from './i18n';

export default function WindowControls() {
  if (!isTauri() || navigator.platform.startsWith('Mac')) return null;
  const window = getCurrentWindow();
  return <div className="window-controls">
    <button aria-label={t('Minimize window')} onClick={() => void window.minimize()}><IconMinus size={15} /></button>
    <button aria-label={t('Maximize or restore window')} onClick={() => void window.toggleMaximize()}><IconSquare size={13} /></button>
    <button aria-label={t('Close window')} onClick={() => void window.close()}><IconX size={16} /></button>
  </div>;
}

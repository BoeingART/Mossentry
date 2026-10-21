import { useEffect, useSyncExternalStore } from 'react';
import { Button, Tooltip } from '@mantine/core';
import { IconArrowUp, IconRefresh } from '@tabler/icons-react';
import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { t, useLanguage } from './i18n';
import { UpdateController, type DownloadProgress } from './updateController';

const updater = new UpdateController({
  check: () => invoke<string | null>('check_update'),
  download: progress => {
    const channel = new Channel<DownloadProgress>();
    channel.onmessage = progress;
    return invoke('download_update', { progress: channel });
  },
  install: () => invoke('install_update'),
});

export default function UpdateButton() {
  useLanguage();
  const state = useSyncExternalStore(updater.subscribe, updater.snapshot);
  useEffect(() => {
    if (!isTauri() || import.meta.env.DEV) return;
    void updater.poll();
    const timer = window.setInterval(() => { void updater.poll(); }, 10 * 60 * 1000);
    const online = () => { void updater.poll(); };
    window.addEventListener('online', online);
    return () => { window.clearInterval(timer); window.removeEventListener('online', online); };
  }, []);
  if (state.phase === 'hidden') return null;

  const downloading = state.phase === 'downloading';
  const installing = state.phase === 'installing';
  const failed = state.phase === 'error';
  const percent = state.progress?.total
    ? Math.min(100, Math.floor(state.progress.received / state.progress.total * 100)) : null;
  const label = downloading ? (percent === null ? t('Update · downloading') : t('Update · {0}%', { 0: percent }))
    : installing ? t('Updating…') : failed ? t('Retry update') : t('Update');
  const hint = downloading ? t('Downloading Mossentry {0} in the background', { 0: state.version })
    : installing ? t('Installing the update and restarting Mossentry…')
    : failed ? `${t(state.error || '')} ${t('Click to retry.')}`
    : t('Mossentry {0} is ready. Click to install and restart.', { 0: state.version });

  return <Tooltip label={hint} multiline maw={320} withArrow events={{ hover: true, focus: true, touch: true }}>
    <span className="update-control" role="status" aria-live="polite">
      <Button className="update-button" size="compact-sm" variant="light" color={failed ? 'orange' : 'teal'}
        leftSection={failed ? <IconRefresh size={15} /> : <IconArrowUp size={15} />}
        loading={downloading || installing} disabled={downloading || installing} aria-label={hint}
        onClick={() => { void (state.retry === 'download' ? updater.retryDownload() : updater.install()); }}>
        {label}
      </Button>
    </span>
  </Tooltip>;
}

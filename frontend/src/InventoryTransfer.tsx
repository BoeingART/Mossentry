import { invoke } from '@tauri-apps/api/core';
import { useState } from 'react';
import { Alert, Button, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { api } from './api';
import { t } from './i18n';

export async function saveJson(value: unknown, name: string) {
  try { return await invoke<boolean>('save_json', { filename: name, value }); }
  catch (cause) { throw new Error(t((cause as { detail?: string })?.detail || 'Could not save export')); }
}

export default function InventoryTransfer({ saved }: { saved: () => Promise<void> }) {
  const [opened, setOpened] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ count: number; names: string[]; conflicts: string[] } | null>(null);
  async function exportFile() {
    setBusy(true); setError('');
    try { await saveJson(await api('/api/inventory/export'), 'mossentry-inventory.json'); }
    catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); setOpened(true); }
    finally { setBusy(false); }
  }
  async function importFile(apply: boolean) {
    setBusy(true); setError('');
    try {
      if (text.length > 2_000_000) throw new Error(t('Inventory file is too large'));
      const value = JSON.parse(text);
      if (!apply) setPreview(await api('/api/inventory/import', 'POST', { ...value, preview: true }));
      else { await api('/api/inventory/import', 'POST', { ...value, preview: false }); await saved(); setOpened(false); setText(''); setPreview(null); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('Invalid inventory file')); }
    finally { setBusy(false); }
  }
  return <>
    <Button variant="default" disabled={busy} onClick={() => void exportFile()}>{t('Export inventory')}</Button>
    <Button variant="default" onClick={() => { setOpened(true); setError(''); }}>{t('Import inventory')}</Button>
    <Modal opened={opened} onClose={() => !busy && setOpened(false)} title={t('Import inventory')} size="lg" centered>
      <Stack>
        <Text size="sm">{t('Import adds new servers only. All imported servers start paused. Passwords and private keys are never included. Check key paths before enabling management.')}</Text>
        <input aria-label={t('Choose inventory file')} type="file" accept=".json,application/json" disabled={busy} onChange={async e => {
          const file = e.currentTarget.files?.[0];
          if (!file) return;
          setPreview(null); setError('');
          if (file.size > 2_000_000) { setError(t('Inventory file is too large')); return; }
          try { setText(await file.text()); } catch { setError(t('Invalid inventory file')); }
        }} />
        <Textarea label={t('Inventory JSON')} autosize minRows={7} maxRows={14} value={text} disabled={busy} onChange={e => { setText(e.currentTarget.value); setPreview(null); }} />
        {error && <Alert color="red">{t(error)}</Alert>}
        {preview && <Alert color={preview.conflicts.length ? 'orange' : 'blue'}>
          <Text>{t('{0} servers will be added, paused', { 0: preview.count })}</Text>
          <Text size="sm" style={{ overflowWrap: 'anywhere' }}>{preview.names.join(', ')}</Text>
          {!!preview.conflicts.length && <Text>{t('Existing names must be renamed: {0}', { 0: preview.conflicts.join(', ') })}</Text>}
        </Alert>}
        <Group justify="end"><Button variant="default" disabled={busy || !text.trim()} onClick={() => void importFile(false)}>{t('Preview import')}</Button><Button loading={busy} disabled={!preview || !!preview.conflicts.length} onClick={() => void importFile(true)}>{t('Import paused servers')}</Button></Group>
      </Stack>
    </Modal>
  </>;
}

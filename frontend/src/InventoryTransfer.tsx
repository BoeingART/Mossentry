import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Group, Modal, ScrollArea, Stack, Table, Text, TextInput } from '@mantine/core';
import { api } from './api';
import { t } from './i18n';
import type { Server } from './types';

export async function saveJson(value: unknown, name: string) {
  try { return await invoke<boolean>('save_json', { filename: name, value }); }
  catch (cause) { throw new Error(t((cause as { detail?: string })?.detail || 'Could not save export')); }
}

type Preview = { servers: Server[]; conflicts: string[]; warnings: string[]; revision: string };
export default function InventoryTransfer({ saved }: { saved: () => Promise<void> }) {
  const [opened, setOpened] = useState(false);
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingHosts, setLoadingHosts] = useState(false);
  const [reload, setReload] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const changePath = (value: string) => { setPath(value); setPreview(null); setSelected([]); setError(''); };
  useEffect(() => {
    if (!opened || !path.trim()) { setLoadingHosts(false); return; }
    const controller = new AbortController();
    setLoadingHosts(true);
    const timeout = setTimeout(() => {
      void api<Preview>('/api/inventory/import', 'POST', { path, preview: true }, controller.signal)
        .then(result => { setPreview(result); setSelected([]); })
        .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('Invalid SSH config import')); })
        .finally(() => { if (!controller.signal.aborted) setLoadingHosts(false); });
    }, 250);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [opened, path, reload]);
  async function open() {
    changePath(''); setOpened(true); setBusy(true);
    try { const config = await api<{ path: string }>('/api/ssh-config'); changePath(config.path); }
    catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); }
    finally { setBusy(false); }
  }
  async function browse() {
    setBusy(true); setError('');
    try { const value = await invoke<string | null>('choose_ssh_config'); if (value) { changePath(value); setReload(current => current + 1); } }
    catch (cause) { setError(t((cause as { detail?: string })?.detail || 'Could not choose SSH config file')); }
    finally { setBusy(false); }
  }
  async function importFile() {
    if (!preview || !selected.length || busy || loadingHosts) return;
    setBusy(true); setError('');
    try {
      await api('/api/inventory/import', 'POST', { path, preview: false, revision: preview.revision, names: selected });
      await saved(); setOpened(false); setPreview(null); setSelected([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Invalid SSH config import'));
      if ((cause as { status?: number })?.status === 409) { setPreview(null); setSelected([]); setReload(current => current + 1); }
    }
    finally { setBusy(false); }
  }
  return <>
    <Button variant="default" onClick={() => void open()}>{t('Import SSH config')}</Button>
    <Modal opened={opened} onClose={() => !busy && setOpened(false)} title={t('Import SSH config')} size="xl" centered closeOnClickOutside={!busy} closeOnEscape={!busy}>
      <Stack>
        <Text size="sm">{t('Choose hosts from your SSH config. Imported servers start enabled. Existing servers are kept.')}</Text>
        <Group align="end" wrap="nowrap"><TextInput style={{ flex: 1 }} label={t('SSH config file')} value={path} disabled={busy} onChange={e => changePath(e.currentTarget.value)} /><Button variant="default" disabled={busy} onClick={() => void browse()}>{t('Browse')}</Button></Group>
        {loadingHosts && <Text size="sm" c="dimmed" role="status">{t('Loading')}</Text>}
        {preview && <>
          <Group justify="space-between"><Text size="sm">{t('{0} hosts selected', { 0: selected.length })}</Text><Button variant="light" disabled={busy || loadingHosts || !preview.servers.some(server => !preview.conflicts.includes(server.name))} onClick={() => setSelected(preview.servers.filter(server => !preview.conflicts.includes(server.name)).map(server => server.name))}>{t('Select all servers')}</Button></Group>
          {!preview.servers.length && <Text size="sm" c="dimmed">{t('No hosts found in this SSH config.')}</Text>}
          <ScrollArea.Autosize mah={300}><Table><Table.Thead><Table.Tr><Table.Th>{t('Import')}</Table.Th><Table.Th>{t('Server name')}</Table.Th><Table.Th>{t('SSH Host alias')}</Table.Th><Table.Th>{t('Hostname or IP address')}</Table.Th><Table.Th>{t('SSH login account')}</Table.Th><Table.Th>{t('SSH port')}</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{preview.servers.map(server => <Table.Tr key={server.name}><Table.Td><Checkbox aria-label={t('Import {0}', { 0: server.name })} checked={selected.includes(server.name)} disabled={busy || preview.conflicts.includes(server.name)} onChange={e => { const checked = e.currentTarget.checked; setSelected(current => checked ? [...current, server.name] : current.filter(name => name !== server.name)); }} /></Table.Td><Table.Td>{server.name}{preview.conflicts.includes(server.name) && <Text size="xs" c="dimmed">{t('Already exists')}</Text>}</Table.Td><Table.Td>{server.ssh_alias || server.name}</Table.Td><Table.Td>{server.hostname}</Table.Td><Table.Td>{server.ssh_user}</Table.Td><Table.Td>{server.port}</Table.Td></Table.Tr>)}</Table.Tbody></Table></ScrollArea.Autosize>
          {preview.warnings.length > 0 && <Alert color="yellow">{preview.warnings.map(warning => <Text size="sm" key={warning}>{warning.startsWith('Unsupported SSH option: ') ? t('Skipped SSH option: {0}', { 0: warning.slice('Unsupported SSH option: '.length) }) : t(warning)}</Text>)}</Alert>}
        </>}
        {error && <Alert color="red" role="alert">{t(error)}</Alert>}
        <Group justify="end"><Button loading={busy} disabled={loadingHosts || !preview || !selected.length} onClick={() => void importFile()}>{t('Import servers')}</Button></Group>
      </Stack>
    </Modal>
  </>;
}

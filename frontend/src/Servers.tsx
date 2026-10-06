import { useState } from 'react';
import type { FormEvent } from 'react';
import { ActionIcon, Alert, Button, Card, Checkbox, Group, Menu, Modal, NumberInput, Paper, Progress, Select, SimpleGrid, Stack, Text, TextInput, ThemeIcon, Title, Tooltip } from '@mantine/core';
import { IconCheck, IconDots, IconEdit, IconPlus, IconSearch, IconServer, IconTrash, IconX } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { api } from './api';
import type { Dashboard, Server, ServerMetrics } from './types';

const date = (value: string | null) => value ? new Date(value).toLocaleString() : 'Not yet synced';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Please retry the operation';
const notify = (message: string, error = false) => notifications.show({ title: error ? 'Could not complete' : 'Done', message, color: error ? 'red' : 'teal' });
type Draft = { name: string; hostname: string; port: number | string; ssh_user: string; key_path: string; enabled: boolean };

function ServerForm({ server, close, saved }: { server: Server | null; close: () => void; saved: () => Promise<void> }) {
  const [draft, setDraft] = useState<Draft>({ name: server?.name || '', hostname: server?.hostname || '', port: server?.port || 22, ssh_user: server?.ssh_user || 'srvmgr', key_path: server?.key_path || '~/.ssh/id_rsa', enabled: server ? !!server.enabled : true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const field = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(current => ({ ...current, [key]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api(server ? `/api/servers/${server.id}` : '/api/servers', server ? 'PUT' : 'POST', {
        ...draft, port: Number(draft.port),
      });
      notify(server ? 'Server settings saved' : draft.enabled ? 'Server added. Sync accounts to check its connection.' : 'Server added with management paused.');
      await saved(); close();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }
  return <Modal opened onClose={() => !busy && close()} closeOnClickOutside={!busy} closeOnEscape={!busy} title={server ? 'Edit server' : 'Add server'} centered radius="lg">
    <form onSubmit={submit}><Stack gap="md">
      <TextInput label="Server name" description="A short, unique name using lowercase letters, numbers, hyphens or underscores." placeholder="e.g. gpu5" value={draft.name} onChange={e => field('name', e.currentTarget.value)} pattern="[a-z][a-z0-9_-]{0,31}" required autoFocus />
      <Group grow align="start"><TextInput label="Hostname or IP address" placeholder="e.g. 192.168.1.10" value={draft.hostname} onChange={e => field('hostname', e.currentTarget.value)} required /><NumberInput label="SSH port" min={1} max={65535} allowDecimal={false} value={draft.port} onChange={value => field('port', value)} required /></Group>
      <TextInput label="SSH login account" value={draft.ssh_user} onChange={e => field('ssh_user', e.currentTarget.value)} pattern="[a-z_][a-z0-9_-]{0,31}" required />
      <TextInput label="SSH private key path" description="Path on this computer. The login account needs sudo permission to manage users." placeholder="~/.ssh/id_rsa" value={draft.key_path} onChange={e => field('key_path', e.currentTarget.value)} required />
      <Checkbox label="Enable management" description="Paused servers are excluded from connections and account changes." checked={draft.enabled} onChange={e => field('enabled', e.currentTarget.checked)} />
      {error && <Alert color="red" role="alert">{error}</Alert>}
      <Group justify="end"><Button variant="default" disabled={busy} onClick={close}>Cancel</Button><Button type="submit" loading={busy}>Save server</Button></Group>
    </Stack></form>
  </Modal>;
}

export default function Servers({ data, saved, monitor }: { data: Dashboard; saved: () => Promise<void>; monitor: (server: Server) => void }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<string | null>('all');
  const [editor, setEditor] = useState<{ server: Server | null } | null>(null);
  const [remove, setRemove] = useState<Server | null>(null);
  const [removeName, setRemoveName] = useState('');
  const [busy, setBusy] = useState('');
  const [connections, setConnections] = useState<Record<number, { source: string; ok: boolean; detail: string }>>({});
  const [metrics, setMetrics] = useState<{ server: Server; result: ServerMetrics } | null>(null);
  const servers = data.servers.filter(server => [server.name, server.hostname, server.ssh_user].some(value => value.toLowerCase().includes(search.toLowerCase())) && (filter === 'all' || (filter === 'enabled' ? !!server.enabled : !server.enabled)));
  // A saved scan is the initial result; newer checks apply only to the same connection settings.
  const connectionSource = (server: Server) => JSON.stringify([
    server.name, server.hostname, server.port, server.ssh_user, server.key_path,
    server.enabled, server.last_scan_at, server.last_scan_status, server.last_scan_error,
  ]);
  function recordConnection(server: Server, ok: boolean, detail: string) {
    setConnections(current => ({ ...current, [server.id]: { source: connectionSource(server), ok, detail } }));
  }
  async function operate(server: Server, action: 'scan' | 'status') {
    setBusy(`${server.id}:${action}`);
    try {
      if (action === 'status') {
        const result = await api<ServerMetrics>(`/api/servers/${server.id}/status`, 'POST');
        recordConnection(server, true, 'Last connection succeeded.');
        setMetrics({ server, result });
      } else {
        const result = await api<{ ok: boolean; users: number; errors: Record<string, string> }>(`/api/servers/${server.id}/scan`, 'POST');
        recordConnection(server, result.ok, result.ok ? 'Last connection succeeded.'
          : Object.values(result.errors).join(' ') || 'Sync failed. Check the connection and retry.');
        if (result.ok) notify(`${server.name}: synced ${result.users} accounts`);
      }
    } catch (cause) {
      // Local service, authorization and busy errors do not establish an SSH failure.
      if ((cause as { status?: number }).status === 502) recordConnection(server, false, errorMessage(cause));
      notify(errorMessage(cause), true);
    } finally { await saved(); setBusy(''); }
  }
  async function toggle(server: Server) {
    setBusy(`${server.id}:edit`);
    try { await api(`/api/servers/${server.id}`, 'PUT', { ...server, enabled: !server.enabled }); notify(server.enabled ? 'Server paused' : 'Server enabled'); await saved(); }
    catch (cause) { notify(errorMessage(cause), true); } finally { setBusy(''); }
  }
  async function removeServer() {
    if (!remove) return;
    setBusy(`${remove.id}:delete`);
    try { await api(`/api/servers/${remove.id}`, 'DELETE'); notify('Server removed from this manager'); setRemove(null); await saved(); }
    catch (cause) { notify(errorMessage(cause), true); } finally { setBusy(''); }
  }
  return <>
    <Group className="page-heading" justify="space-between" align="center" mb="lg"><div><Title order={2}>Servers</Title><Text c="dimmed" size="sm" mt={4}>Manage SSH connections, accounts and server status.</Text></div><Button leftSection={<IconPlus size={16} />} onClick={() => setEditor({ server: null })} disabled={!!busy}>Add server</Button></Group>
    <Group className="filter-toolbar" mb="lg"><TextInput leftSection={<IconSearch size={16} />} placeholder="Find a server" value={search} onChange={e => setSearch(e.currentTarget.value)} w={300} /><Select aria-label="Filter servers" value={filter} onChange={setFilter} allowDeselect={false} data={[{ value: 'all', label: 'All servers' }, { value: 'enabled', label: 'Enabled' }, { value: 'paused', label: 'Paused' }]} w={160} /><Text size="sm" c="dimmed">{data.servers.filter(s => s.enabled).length} enabled · {data.servers.length} total</Text></Group>
    {servers.length ? <div className="host-grid">{servers.map(server => {
      const latest = connections[server.id];
      const current = latest?.source === connectionSource(server) ? latest : undefined;
      const connected = !!server.enabled && (current?.ok ?? server.last_scan_status === 'ok');
      const failed = !!server.enabled && (current ? !current.ok : ['failed', 'error'].includes(server.last_scan_status || ''));
      const detail = !server.enabled ? 'Management paused.' : current?.detail
        || (connected ? 'Last connection succeeded.' : failed ? server.last_scan_error || 'Sync failed. Check the connection and retry.'
          : 'Connection not checked. Sync or open Status to check.');
      const count = data.users.filter(user => user.server === server.name).length;
      return <Card key={server.id} withBorder radius="md" p="md" className="host-card">
        <Group className="host-heading" gap="sm" wrap="nowrap">
          <ThemeIcon size={34} radius="xl" variant="light" style={{ flexShrink: 0 }}><IconServer size={18} /></ThemeIcon>
          <Title order={3} size="sm" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{server.name}</Title>
          <Group gap={6} wrap="nowrap">
            <Tooltip label={detail} multiline w={280} withArrow events={{ hover: true, focus: true, touch: true }}>
              <span className={`server-connection ${connected ? 'connected' : failed ? 'failed' : 'unknown'}`}
                tabIndex={0} role="img" aria-label={`${server.name}: ${detail}`}>
                {connected ? <IconCheck size={17} aria-hidden="true" /> : <IconX size={17} aria-hidden="true" />}
              </span>
            </Tooltip>
            <Menu position="bottom-end">
              <Menu.Target><ActionIcon variant="subtle" color="gray" aria-label={`Manage ${server.name}`} disabled={!!busy}><IconDots size={18} /></ActionIcon></Menu.Target>
              <Menu.Dropdown>
                <Menu.Item leftSection={<IconEdit size={14} />} onClick={() => setEditor({ server })}>Edit server</Menu.Item>
                <Menu.Item onClick={() => void toggle(server)}>{server.enabled ? 'Pause management' : 'Enable management'}</Menu.Item>
                <Menu.Divider />
                <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => { setRemove(server); setRemoveName(''); }}>Remove server</Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
        <Group className="host-accounts" gap={6}><Text size="sm" c="dimmed">Accounts:</Text><Text size="sm" fw={500}>{server.last_scan_at ? count : '—'}</Text></Group>
        <Group className="server-actions" gap={8}>
          <Button size="xs" variant="default" disabled={!server.enabled || !!busy} loading={busy === `${server.id}:scan`} onClick={() => void operate(server, 'scan')}>Sync</Button>
          <Button size="xs" variant="default" disabled={!server.enabled || !!busy} loading={busy === `${server.id}:status`} onClick={() => void operate(server, 'status')}>Status</Button>
          <Button size="xs" variant="default" disabled={!server.enabled} onClick={() => monitor(server)}>Monitor</Button>
        </Group>
      </Card>;
    })}</div> : <Paper withBorder radius="lg" p="xl"><Stack align="center"><IconServer size={34} color="#8795a9" /><Title order={3}>{data.servers.length ? 'No matching servers' : 'Add your first server'}</Title><Text size="sm" c="dimmed">{data.servers.length ? 'Try another search or filter.' : 'Enter its SSH address, login account and private key path to begin.'}</Text>{!data.servers.length && <Button onClick={() => setEditor({ server: null })}>Add server</Button>}</Stack></Paper>}
    {editor && <ServerForm server={editor.server} close={() => setEditor(null)} saved={saved} />}
    <Modal opened={!!remove} onClose={() => !busy && setRemove(null)} title="Remove server?" centered closeOnClickOutside={!busy} closeOnEscape={!busy}><Stack><Text size="sm">Remove {remove?.name} and its saved account list from this manager. The remote server, its users and files stay unchanged. Operation history is kept.</Text><TextInput label={`Type ${remove?.name || 'the server name'} to confirm`} value={removeName} onChange={e => setRemoveName(e.currentTarget.value)} /><Group justify="end"><Button variant="default" disabled={!!busy} onClick={() => setRemove(null)}>Cancel</Button><Button color="red" disabled={removeName !== remove?.name} loading={!!busy} onClick={() => void removeServer()}>Remove server</Button></Group></Stack></Modal>
    <Modal opened={!!metrics} onClose={() => setMetrics(null)} title={`${metrics?.server.name || ''} · Server status`} centered size="lg"><Stack>{metrics && <>
      <Text size="xs" c="dimmed">Checked {date(metrics.result.checked_at)} · Read-only snapshot</Text><SimpleGrid cols={2}><Paper withBorder p="md"><Text size="sm" c="dimmed">Uptime</Text><Text fw={700}>{Math.floor(metrics.result.uptime_seconds / 86400)} days {Math.floor(metrics.result.uptime_seconds % 86400 / 3600)} hours</Text></Paper><Paper withBorder p="md"><Text size="sm" c="dimmed">System load · 1 / 5 / 15 min</Text><Text fw={700}>{metrics.result.load.join(' / ')}</Text></Paper></SimpleGrid>
      <div><Text size="sm" fw={600}>Memory · {metrics.result.memory_used_mb} / {metrics.result.memory_total_mb} MB</Text><Progress mt="xs" value={metrics.result.memory_total_mb ? metrics.result.memory_used_mb / metrics.result.memory_total_mb * 100 : 0} /></div><div><Text size="sm" fw={600}>System disk (/) · {metrics.result.disk_used_gb} / {metrics.result.disk_total_gb} GB</Text><Progress mt="xs" color={metrics.result.disk_percent > 90 ? 'red' : 'blue'} value={metrics.result.disk_percent} /></div><Group justify="end"><Button variant="default" onClick={() => setMetrics(null)}>Close</Button><Button loading={!!busy} onClick={() => void operate(metrics.server, 'status')}>Refresh status</Button></Group>
    </>}</Stack></Modal>
  </>;
}

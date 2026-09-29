import { useState } from 'react';
import type { FormEvent } from 'react';
import { ActionIcon, Alert, Badge, Button, Card, Checkbox, Collapse, Divider, Group, Menu, Modal, NumberInput, Paper, Progress, Select, SimpleGrid, Stack, Text, TextInput, ThemeIcon, Title } from '@mantine/core';
import { IconDots, IconEdit, IconPlus, IconSearch, IconServer, IconTrash } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { api } from './api';
import type { Dashboard, Server, ServerMetrics } from './types';

const date = (value: string | null) => value ? new Date(value).toLocaleString() : 'Not yet synced';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Please retry the operation';
const notify = (message: string, error = false) => notifications.show({ title: error ? 'Could not complete' : 'Done', message, color: error ? 'red' : 'teal' });
type Draft = { name: string; hostname: string; port: number | string; ssh_user: string; key_path: string; enabled: boolean; public_port_start: number | string; public_port_end: number | string };

function ServerForm({ server, close, saved }: { server: Server | null; close: () => void; saved: () => Promise<void> }) {
  const [draft, setDraft] = useState<Draft>({ name: server?.name || '', hostname: server?.hostname || '', port: server?.port || 22, ssh_user: server?.ssh_user || 'srvmgr', key_path: server?.key_path || '', enabled: server ? !!server.enabled : true, public_port_start: server?.public_port_start || '', public_port_end: server?.public_port_end || '' });
  const [advanced, setAdvanced] = useState(!!server?.public_port_start);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const field = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(current => ({ ...current, [key]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api(server ? `/api/servers/${server.id}` : '/api/servers', server ? 'PUT' : 'POST', {
        ...draft, port: Number(draft.port), public_port_start: draft.public_port_start === '' ? null : Number(draft.public_port_start), public_port_end: draft.public_port_end === '' ? null : Number(draft.public_port_end),
      });
      notify(server ? 'Server settings saved' : draft.enabled ? 'Server added. Test its connection, then sync accounts.' : 'Server added with management paused.');
      await saved(); close();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }
  return <Modal opened onClose={() => !busy && close()} closeOnClickOutside={!busy} closeOnEscape={!busy} title={server ? 'Edit server' : 'Add server'} centered radius="lg">
    <form onSubmit={submit}><Stack gap="md">
      <TextInput label="Server name" description="A short, unique name using lowercase letters, numbers, hyphens or underscores." placeholder="e.g. gpu5" value={draft.name} onChange={e => field('name', e.currentTarget.value)} pattern="[a-z][a-z0-9_-]{0,31}" required autoFocus />
      <Group grow align="start"><TextInput label="Hostname or IP address" placeholder="e.g. 192.168.1.10" value={draft.hostname} onChange={e => field('hostname', e.currentTarget.value)} required /><NumberInput label="SSH port" min={1} max={65535} allowDecimal={false} value={draft.port} onChange={value => field('port', value)} required /></Group>
      <TextInput label="SSH login account" value={draft.ssh_user} onChange={e => field('ssh_user', e.currentTarget.value)} pattern="[a-z_][a-z0-9_-]{0,31}" required />
      <TextInput label="SSH private key path" description="Path on this computer. The login account needs sudo permission to manage users." placeholder="~/.ssh/id_ed25519" value={draft.key_path} onChange={e => field('key_path', e.currentTarget.value)} required />
      <Checkbox label="Enable management" description="Paused servers are excluded from connections and account changes." checked={draft.enabled} onChange={e => field('enabled', e.currentTarget.checked)} />
      <Button variant="subtle" size="xs" onClick={() => setAdvanced(value => !value)} aria-expanded={advanced}>Optional public port range</Button>
      <Collapse expanded={advanced}><Group grow><NumberInput label="Start port" min={1} max={65535} allowDecimal={false} value={draft.public_port_start} onChange={value => field('public_port_start', value)} /><NumberInput label="End port" min={1} max={65535} allowDecimal={false} value={draft.public_port_end} onChange={value => field('public_port_end', value)} /></Group><Text size="xs" c="dimmed" mt="xs">For reference only. Saving this range does not change the server firewall.</Text></Collapse>
      {error && <Alert color="red" role="alert">{error}</Alert>}
      <Group justify="end"><Button variant="default" disabled={busy} onClick={close}>Cancel</Button><Button type="submit" loading={busy}>Save server</Button></Group>
    </Stack></form>
  </Modal>;
}

export default function Servers({ data, saved }: { data: Dashboard; saved: () => Promise<void> }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<string | null>('all');
  const [editor, setEditor] = useState<{ server: Server | null } | null>(null);
  const [remove, setRemove] = useState<Server | null>(null);
  const [removeName, setRemoveName] = useState('');
  const [busy, setBusy] = useState('');
  const [metrics, setMetrics] = useState<{ server: Server; result: ServerMetrics } | null>(null);
  const servers = data.servers.filter(server => [server.name, server.hostname, server.ssh_user].some(value => value.toLowerCase().includes(search.toLowerCase())) && (filter === 'all' || (filter === 'enabled' ? !!server.enabled : !server.enabled)));
  async function operate(server: Server, action: 'test' | 'scan' | 'status') {
    setBusy(`${server.id}:${action}`);
    try {
      if (action === 'status') setMetrics({ server, result: await api<ServerMetrics>(`/api/servers/${server.id}/status`, 'POST') });
      else if (action === 'test') {
        const result = await api<{ ok: boolean; message: string }>(`/api/servers/${server.id}/test`, 'POST');
        notify(`${server.name}: ${result.message}`, !result.ok);
      } else {
        const result = await api<{ ok: boolean; users: number; errors: Record<string, string> }>(`/api/servers/${server.id}/scan`, 'POST');
        notify(result.ok ? `${server.name}: synced ${result.users} accounts` : Object.values(result.errors).join(' '), !result.ok);
      }
    } catch (cause) { notify(errorMessage(cause), true); }
    finally { await saved(); setBusy(''); }
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
    <Group justify="space-between" align="start" mb="lg"><div><Title order={2}>Servers</Title><Text c="dimmed" size="sm" mt={4}>Manage SSH connections, accounts and server status.</Text></div><Button leftSection={<IconPlus size={16} />} onClick={() => setEditor({ server: null })} disabled={!!busy}>Add server</Button></Group>
    <Group mb="lg"><TextInput leftSection={<IconSearch size={16} />} placeholder="Find a server" value={search} onChange={e => setSearch(e.currentTarget.value)} w={300} /><Select aria-label="Filter servers" value={filter} onChange={setFilter} allowDeselect={false} data={[{ value: 'all', label: 'All servers' }, { value: 'enabled', label: 'Enabled' }, { value: 'paused', label: 'Paused' }]} w={160} /><Text size="sm" c="dimmed">{data.servers.filter(s => s.enabled).length} enabled · {data.servers.length} total</Text></Group>
    {servers.length ? <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }} spacing="md">{servers.map(server => {
      const failed = ['failed', 'error'].includes(server.last_scan_status || '');
      const count = data.users.filter(user => user.server === server.name).length;
      return <Card key={server.id} withBorder radius="lg" p="lg" className="host-card">
        <Group justify="space-between"><ThemeIcon size={40} radius="md" color={server.enabled ? 'blue' : 'gray'} variant="light"><IconServer size={22} /></ThemeIcon><Group gap="xs"><Badge color={!server.enabled ? 'gray' : failed ? 'red' : server.last_scan_status === 'ok' ? 'teal' : 'gray'} variant="light">{!server.enabled ? 'Paused' : failed ? 'Sync failed' : server.last_scan_status === 'ok' ? 'Synced' : 'Not synced'}</Badge><Menu position="bottom-end"><Menu.Target><ActionIcon variant="subtle" color="gray" aria-label={`Manage ${server.name}`} disabled={!!busy}><IconDots size={18} /></ActionIcon></Menu.Target><Menu.Dropdown><Menu.Item leftSection={<IconEdit size={14} />} onClick={() => setEditor({ server })}>Edit server</Menu.Item><Menu.Item onClick={() => void toggle(server)}>{server.enabled ? 'Pause management' : 'Enable management'}</Menu.Item><Menu.Divider /><Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => { setRemove(server); setRemoveName(''); }}>Remove server</Menu.Item></Menu.Dropdown></Menu></Group></Group>
        <Title order={3} size="h4" mt="md">{server.name}</Title><Text size="sm" c="dimmed" style={{ overflowWrap: 'anywhere' }}>{server.ssh_user}@{server.hostname}:{server.port}</Text><Divider my="md" />
        <Group justify="space-between"><Text size="sm" c="dimmed">{failed || !server.enabled ? 'Saved accounts' : 'Accounts'}</Text><Text fw={700}>{server.last_scan_at ? count : '—'}</Text></Group>
        <Text size="xs" c="dimmed" mt="xs">Last sync attempt: {date(server.last_scan_at)}</Text>
        {!!server.enabled && failed && <Alert color="red" mt="sm" p="sm"><Text size="xs">{server.last_scan_error || 'Sync failed. Check the connection and retry.'} Displayed accounts may be out of date.</Text></Alert>}
        <Group gap="xs" mt="auto" pt="lg"><Button size="compact-xs" variant="light" disabled={!server.enabled || !!busy} loading={busy === `${server.id}:test`} onClick={() => void operate(server, 'test')}>Test connection</Button><Button size="compact-xs" variant="light" disabled={!server.enabled || !!busy} loading={busy === `${server.id}:scan`} onClick={() => void operate(server, 'scan')}>Sync users</Button><Button size="compact-xs" variant="default" disabled={!server.enabled || !!busy} loading={busy === `${server.id}:status`} onClick={() => void operate(server, 'status')}>Server status</Button></Group>
      </Card>;
    })}</SimpleGrid> : <Paper withBorder radius="lg" p="xl"><Stack align="center"><IconServer size={34} color="#8795a9" /><Title order={3}>{data.servers.length ? 'No matching servers' : 'Add your first server'}</Title><Text size="sm" c="dimmed">{data.servers.length ? 'Try another search or filter.' : 'Enter its SSH address, login account and private key path to begin.'}</Text>{!data.servers.length && <Button onClick={() => setEditor({ server: null })}>Add server</Button>}</Stack></Paper>}
    {editor && <ServerForm server={editor.server} close={() => setEditor(null)} saved={saved} />}
    <Modal opened={!!remove} onClose={() => !busy && setRemove(null)} title="Remove server?" centered closeOnClickOutside={!busy} closeOnEscape={!busy}><Stack><Text size="sm">Remove {remove?.name} and its saved account list from this manager. The remote server, its users and files stay unchanged. Operation history is kept.</Text><TextInput label={`Type ${remove?.name || 'the server name'} to confirm`} value={removeName} onChange={e => setRemoveName(e.currentTarget.value)} /><Group justify="end"><Button variant="default" disabled={!!busy} onClick={() => setRemove(null)}>Cancel</Button><Button color="red" disabled={removeName !== remove?.name} loading={!!busy} onClick={() => void removeServer()}>Remove server</Button></Group></Stack></Modal>
    <Modal opened={!!metrics} onClose={() => setMetrics(null)} title={`${metrics?.server.name || ''} · Server status`} centered size="lg"><Stack>{metrics && <>
      <Text size="xs" c="dimmed">Checked {date(metrics.result.checked_at)} · Read-only snapshot</Text><SimpleGrid cols={2}><Paper withBorder p="md"><Text size="sm" c="dimmed">Uptime</Text><Text fw={700}>{Math.floor(metrics.result.uptime_seconds / 86400)} days {Math.floor(metrics.result.uptime_seconds % 86400 / 3600)} hours</Text></Paper><Paper withBorder p="md"><Text size="sm" c="dimmed">System load · 1 / 5 / 15 min</Text><Text fw={700}>{metrics.result.load.join(' / ')}</Text></Paper></SimpleGrid>
      <div><Text size="sm" fw={600}>Memory · {metrics.result.memory_used_mb} / {metrics.result.memory_total_mb} MB</Text><Progress mt="xs" value={metrics.result.memory_total_mb ? metrics.result.memory_used_mb / metrics.result.memory_total_mb * 100 : 0} /></div><div><Text size="sm" fw={600}>System disk (/) · {metrics.result.disk_used_gb} / {metrics.result.disk_total_gb} GB</Text><Progress mt="xs" color={metrics.result.disk_percent > 90 ? 'red' : 'blue'} value={metrics.result.disk_percent} /></div><Group justify="end"><Button variant="default" onClick={() => setMetrics(null)}>Close</Button><Button loading={!!busy} onClick={() => void operate(metrics.server, 'status')}>Refresh status</Button></Group>
    </>}</Stack></Modal>
  </>;
}

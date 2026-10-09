import { t, locale } from './i18n';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { ActionIcon, Alert, Button, Card, Checkbox, Group, Menu, Modal, NumberInput, Paper, Progress, Select, SimpleGrid, Stack, Text, TextInput, ThemeIcon, Title, Tooltip } from '@mantine/core';
import { IconCheck, IconDots, IconEdit, IconPlus, IconSearch, IconServer, IconTrash, IconX } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { api } from './api';
import type { Dashboard, Server, ServerMetrics } from './types';

const date = (value: string | null) => value ? new Date(value).toLocaleString(locale()) : t("Not yet synced");
const errorMessage = (error: unknown) => error instanceof Error ? error.message : t("Please retry the operation");
const notify = (message: string, error = false) => notifications.show({ title: error ? t("Could not complete") : t("Done"), message: t(message), color: error ? 'red' : 'teal' });
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
      notify(server ? t("Server settings saved") : draft.enabled ? t("Server added. Sync accounts to check its connection.") : t("Server added with management paused."));
      await saved(); close();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }
  return <Modal opened onClose={() => !busy && close()} closeOnClickOutside={!busy} closeOnEscape={!busy} title={server ? t("Edit server") : t("Add server")} centered radius="lg">
    <form onSubmit={submit}><Stack gap="md">
      <TextInput label={t("Server name")} description={t("A short, unique name using lowercase letters, numbers, hyphens or underscores.")} placeholder={t("e.g. gpu5")} value={draft.name} onChange={e => field('name', e.currentTarget.value)} pattern="[a-z][a-z0-9_-]{0,31}" required autoFocus />
      <Group grow align="start"><TextInput label={t("Hostname or IP address")} placeholder={t("e.g. 192.168.1.10")} value={draft.hostname} onChange={e => field('hostname', e.currentTarget.value)} required /><NumberInput label={t("SSH port")} min={1} max={65535} allowDecimal={false} value={draft.port} onChange={value => field('port', value)} required /></Group>
      <TextInput label={t("SSH login account")} value={draft.ssh_user} onChange={e => field('ssh_user', e.currentTarget.value)} pattern="[a-z_][a-z0-9_-]{0,31}" required />
      <TextInput label={t("SSH private key path")} description={t("Path on this computer. The login account needs sudo permission to manage users.")} placeholder="~/.ssh/id_rsa" value={draft.key_path} onChange={e => field('key_path', e.currentTarget.value)} required />
      <Checkbox label={t("Enable management")} description={t("Paused servers are excluded from connections and account changes.")} checked={draft.enabled} onChange={e => field('enabled', e.currentTarget.checked)} />
      {error && <Alert color="red" role="alert">{t(error)}</Alert>}
      <Group justify="end"><Button variant="default" disabled={busy} onClick={close}>{t("Cancel")}</Button><Button type="submit" loading={busy}>{t("Save server")}</Button></Group>
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
        recordConnection(server, true, t("Last connection succeeded."));
        setMetrics({ server, result });
      } else {
        const result = await api<{ ok: boolean; users: number; errors: Record<string, string> }>(`/api/servers/${server.id}/scan`, 'POST');
        recordConnection(server, result.ok, result.ok ? t("Last connection succeeded.")
          : Object.values(result.errors).join(' ') || t("Sync failed. Check the connection and retry."));
        if (result.ok) notify(t("{0}: synced {1} accounts", { 0: server.name, 1: result.users }));
      }
    } catch (cause) {
      // Local service, authorization and busy errors do not establish an SSH failure.
      if ((cause as { status?: number }).status === 502) recordConnection(server, false, errorMessage(cause));
      notify(errorMessage(cause), true);
    } finally { await saved(); setBusy(''); }
  }
  async function toggle(server: Server) {
    setBusy(`${server.id}:edit`);
    try { await api(`/api/servers/${server.id}`, 'PUT', { ...server, enabled: !server.enabled }); notify(server.enabled ? t("Server paused") : t("Server enabled")); await saved(); }
    catch (cause) { notify(errorMessage(cause), true); } finally { setBusy(''); }
  }
  async function removeServer() {
    if (!remove) return;
    setBusy(`${remove.id}:delete`);
    try { await api(`/api/servers/${remove.id}`, 'DELETE'); notify(t("Server removed from Mossentry")); setRemove(null); await saved(); }
    catch (cause) { notify(errorMessage(cause), true); } finally { setBusy(''); }
  }
  return <>
    <Group className="page-heading" justify="space-between" align="center" mb="lg"><div><Title order={2}>{t("Servers")}</Title><Text c="dimmed" size="sm" mt={4}>{t("Manage SSH connections, accounts and server status.")}</Text></div><Button leftSection={<IconPlus size={16} />} onClick={() => setEditor({ server: null })} disabled={!!busy}>{t("Add server")}</Button></Group>
    <Group className="filter-toolbar" mb="lg"><TextInput leftSection={<IconSearch size={16} />} placeholder={t("Find a server")} value={search} onChange={e => setSearch(e.currentTarget.value)} w={300} /><Select aria-label={t("Filter servers")} value={filter} onChange={setFilter} allowDeselect={false} data={[{ value: 'all', label: t("All servers") }, { value: 'enabled', label: t("Enabled") }, { value: 'paused', label: t("Paused") }]} w={160} /><Text size="sm" c="dimmed">{data.servers.filter(s => s.enabled).length} {t("enabled ·")} {data.servers.length} {t("total")}</Text></Group>
    {servers.length ? <div className="host-grid">{servers.map(server => {
      const latest = connections[server.id];
      const current = latest?.source === connectionSource(server) ? latest : undefined;
      const connected = !!server.enabled && (current?.ok ?? server.last_scan_status === 'ok');
      const failed = !!server.enabled && (current ? !current.ok : ['failed', 'error'].includes(server.last_scan_status || ''));
      const detail = !server.enabled ? t("Management paused.") : current?.detail
        || (connected ? t("Last connection succeeded.") : failed ? server.last_scan_error || t("Sync failed. Check the connection and retry.")
          : t("Connection not checked. Sync or open Status to check."));
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
              <Menu.Target><ActionIcon variant="subtle" color="gray" aria-label={t("Manage {0}", { 0: server.name })} disabled={!!busy}><IconDots size={18} /></ActionIcon></Menu.Target>
              <Menu.Dropdown>
                <Menu.Item leftSection={<IconEdit size={14} />} onClick={() => setEditor({ server })}>{t("Edit server")}</Menu.Item>
                <Menu.Item onClick={() => void toggle(server)}>{server.enabled ? t("Pause management") : t("Enable management")}</Menu.Item>
                <Menu.Divider />
                <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => { setRemove(server); setRemoveName(''); }}>{t("Remove server")}</Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
        <Group className="host-accounts" gap={6}><Text size="sm" c="dimmed">{t("Accounts:")}</Text><Text size="sm" fw={600}>{server.last_scan_at ? count : '—'}</Text></Group>
        <Group className="server-actions" gap={8}>
          <Button size="xs" variant="default" disabled={!server.enabled || !!busy} loading={busy === `${server.id}:scan`} onClick={() => void operate(server, 'scan')}>{t("Sync")}</Button>
          <Button size="xs" variant="default" disabled={!server.enabled || !!busy} loading={busy === `${server.id}:status`} onClick={() => void operate(server, 'status')}>{t("Status")}</Button>
          <Button size="xs" variant="default" disabled={!server.enabled} onClick={() => monitor(server)}>{t("Monitor")}</Button>
        </Group>
      </Card>;
    })}</div> : <Paper withBorder radius="lg" p="xl"><Stack align="center"><IconServer size={34} color="#8795a9" /><Title order={3}>{data.servers.length ? t("No matching servers") : t("Add your first server")}</Title><Text size="sm" c="dimmed">{data.servers.length ? t("Try another search or filter.") : t("Enter its SSH address, login account and private key path to begin.")}</Text>{!data.servers.length && <Button onClick={() => setEditor({ server: null })}>{t("Add server")}</Button>}</Stack></Paper>}
    {editor && <ServerForm server={editor.server} close={() => setEditor(null)} saved={saved} />}
    <Modal opened={!!remove} onClose={() => !busy && setRemove(null)} title={t("Remove server?")} centered closeOnClickOutside={!busy} closeOnEscape={!busy}><Stack><Text size="sm">{t("Remove")} {remove?.name} {t("and its saved account list from Mossentry. The remote server, its users and files stay unchanged. Operation history is kept.")}</Text><TextInput label={t("Type {0} to confirm", { 0: remove?.name || t("the server name") })} value={removeName} onChange={e => setRemoveName(e.currentTarget.value)} /><Group justify="end"><Button variant="default" disabled={!!busy} onClick={() => setRemove(null)}>{t("Cancel")}</Button><Button color="red" disabled={removeName !== remove?.name} loading={!!busy} onClick={() => void removeServer()}>{t("Remove server")}</Button></Group></Stack></Modal>
    <Modal opened={!!metrics} onClose={() => setMetrics(null)} title={t("{0} · Server status", { 0: metrics?.server.name || '' })} centered size="lg"><Stack>{metrics && <>
      <Text size="xs" c="dimmed">{t("Checked")} {date(metrics.result.checked_at)} {t("· Read-only snapshot")}</Text><SimpleGrid cols={2}><Paper withBorder p="md"><Text size="sm" c="dimmed">{t("Uptime")}</Text><Text fw={700}>{Math.floor(metrics.result.uptime_seconds / 86400)} {t("days")} {Math.floor(metrics.result.uptime_seconds % 86400 / 3600)} {t("hours")}</Text></Paper><Paper withBorder p="md"><Text size="sm" c="dimmed">{t("System load · 1 / 5 / 15 min")}</Text><Text fw={700}>{metrics.result.load.join(' / ')}</Text></Paper></SimpleGrid>
      <div><Text size="sm" fw={700}>{t("Memory ·")} {metrics.result.memory_used_mb} / {metrics.result.memory_total_mb} MB</Text><Progress mt="xs" value={metrics.result.memory_total_mb ? metrics.result.memory_used_mb / metrics.result.memory_total_mb * 100 : 0} /></div><div><Text size="sm" fw={700}>{t("System disk (/) ·")} {metrics.result.disk_used_gb} / {metrics.result.disk_total_gb} GB</Text><Progress mt="xs" color={metrics.result.disk_percent > 90 ? 'red' : 'blue'} value={metrics.result.disk_percent} /></div><Group justify="end"><Button variant="default" onClick={() => setMetrics(null)}>{t("Close")}</Button><Button loading={!!busy} onClick={() => void operate(metrics.server, 'status')}>{t("Refresh status")}</Button></Group>
    </>}</Stack></Modal>
  </>;
}

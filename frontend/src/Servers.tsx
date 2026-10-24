import { numericDate } from './dateFormat';
import { t } from './i18n';
import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Accordion, ActionIcon, Alert, Button, Card, Checkbox, Group, Menu, Modal, NumberInput, Paper, PasswordInput, Progress, ScrollArea, Select, SimpleGrid, Stack, Text, TextInput, ThemeIcon, Title, Tooltip, Textarea, Badge } from '@mantine/core';
import { IconCheck, IconDots, IconEdit, IconPlus, IconRefresh, IconSearch, IconServer, IconTrash, IconX } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { api } from './api';
import InventoryTransfer from './InventoryTransfer';
import { sshOption, setSshOption } from './sshOptions';
import { serverNameError } from './serverName';
import type { Dashboard, Server, ServerMetrics } from './types';

const date = (value: string | null) => value ? numericDate(value, { includeTime: true }) : t("Not yet synced");
const errorMessage = (error: unknown) => error instanceof Error ? error.message : t("Please retry the operation");
const notify = (message: string, error = false) => notifications.show({ title: error ? t("Could not complete") : t("Done"), message: t(message), color: error ? 'red' : 'teal' });
type Draft = { name: string; hostname: string; port: number | string; ssh_user: string; key_path: string; enabled: boolean; group_name: string; notes: string; ssh_backend: 'native' | 'openssh'; ssh_alias: string; ssh_options: string; ssh_jump_config: string };
type ScanResult = { ok: boolean; users: number; errors: Record<string, string> };

function ServerForm({ server, close, saved }: { server: Server | null; close: () => void; saved: () => Promise<void> }) {
  const formId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<Draft>({ name: server?.name || '', hostname: server?.hostname || '', port: server?.port || 22, ssh_user: server?.ssh_user || '', key_path: server?.key_path ?? '~/.ssh/id_rsa', enabled: server ? !!server.enabled : true, group_name: server?.group_name || '', notes: server?.notes || '', ssh_backend: server?.ssh_backend || 'native', ssh_alias: server?.ssh_alias || '', ssh_options: server?.ssh_options || '', ssh_jump_config: server?.ssh_jump_config || '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [sudoPassword, setSudoPassword] = useState('');
  const [clearSudoPassword, setClearSudoPassword] = useState(false);
  const identityChanged = !!server && (draft.hostname !== server.hostname || Number(draft.port) !== server.port || draft.ssh_user !== server.ssh_user || draft.ssh_backend !== server.ssh_backend || draft.ssh_alias !== server.ssh_alias || draft.ssh_options !== server.ssh_options || draft.ssh_jump_config !== server.ssh_jump_config);
  const field = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(current => ({ ...current, [key]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const invalidName = serverNameError(draft.name);
    setNameError(invalidName);
    if (invalidName) { nameInput.current?.focus(); return; }
    setBusy(true); setError('');
    try {
      await api(server ? `/api/servers/${server.id}` : '/api/servers', server ? 'PUT' : 'POST', {
        ...draft, port: Number(draft.port), sudo_password: sudoPassword, clear_sudo_password: clearSudoPassword,
      });
      notify(server ? t("Server settings saved") : draft.enabled ? t("Server added. Sync accounts to check its connection.") : t("Server added with management paused."));
      await saved(); close();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }
  return <Modal.Root opened onClose={() => !busy && close()} closeOnClickOutside={!busy} closeOnEscape={!busy} centered radius="lg" size="lg" scrollAreaComponent={ScrollArea.Autosize}>
    <Modal.Overlay backgroundOpacity={0.2} blur={3} />
    <Modal.Content>
      <Modal.Header className="server-editor-header">
        <Modal.Title>{server ? t("Edit server") : t("Add server")}</Modal.Title>
        <Group gap="xs" wrap="nowrap">
          <Button type="submit" form={formId} loading={busy}>{t("Save server")}</Button>
          <Modal.CloseButton disabled={busy} aria-label={t("Close")} />
        </Group>
      </Modal.Header>
      <Modal.Body><form id={formId} onSubmit={submit}><Stack gap="md">
      {error && <Alert color="red" role="alert">{t(error)}</Alert>}
      <TextInput ref={nameInput} label={t("Server name")} placeholder={t("e.g. gpu5")} description={t("Up to 80 characters. Chinese, letters, numbers, spaces and symbols are supported.")} value={draft.name} onChange={e => { field('name', e.currentTarget.value); setNameError(null); }} error={nameError ? t(nameError) : undefined} required autoFocus />
      <Group grow align="start"><TextInput label={t("Hostname or IP address")} placeholder={t("e.g. 192.168.1.10")} value={draft.hostname} onChange={e => field('hostname', e.currentTarget.value)} required /><NumberInput label={t("SSH port")} min={1} max={65535} allowDecimal={false} value={draft.port} onChange={value => field('port', value)} required /></Group>
      <TextInput label={t("SSH login account")} value={draft.ssh_user} onChange={e => field('ssh_user', e.currentTarget.value)} maxLength={128} required />
      <TextInput label={t("SSH private key path")} placeholder="~/.ssh/id_rsa" value={draft.key_path} onChange={e => field('key_path', e.currentTarget.value)} required={draft.ssh_backend === 'native'} description={draft.ssh_backend === 'openssh' ? t("Leave blank to use SSH agent or default identity files.") : undefined} />
      <Select label={t('SSH transport')} value={draft.ssh_backend} allowDeselect={false} onChange={value => {
        if (value === 'native' && (draft.ssh_options.trim() || draft.ssh_jump_config.trim())) return;
        field('ssh_backend', value === 'openssh' ? 'openssh' : 'native');
      }} data={[{ value: 'native', label: t('Built-in SSH'), disabled: !!(draft.ssh_options.trim() || draft.ssh_jump_config.trim()) }, { value: 'openssh', label: t('System OpenSSH (jump hosts and SSH agent)') }]} />
      {draft.ssh_backend === 'openssh' && <>
        <TextInput label={t('SSH Host alias')} description={t('Original SSH config alias, used for tokens such as %n.')} value={draft.ssh_alias} onChange={e => field('ssh_alias', e.currentTarget.value)} />
        <TextInput label={t('Jump hosts (ProxyJump)')} placeholder="user@bastion:22,second-hop" description={t('Use user@hostname:port or imported jump host aliases. Separate multiple hops with commas.')} value={sshOption(draft.ssh_options, 'ProxyJump')} onChange={e => field('ssh_options', setSshOption(draft.ssh_options, 'ProxyJump', e.currentTarget.value))} />
        <Accordion variant="separated"><Accordion.Item value="ssh-login"><Accordion.Control>{t('More SSH login settings')}</Accordion.Control><Accordion.Panel><Stack gap="sm">
          <Text size="xs" c="dimmed">{t('OpenSSH uses noninteractive keys or SSH agent. Quote paths containing spaces. Password prompts and interactive MFA are unavailable.')}</Text>
          {[
            ['ProxyCommand', 'Proxy command (ProxyCommand)', 'Runs a local connection command. Use this or ProxyJump.'],
            ['IdentityAgent', 'SSH agent (IdentityAgent)', 'Agent socket path, SSH_AUTH_SOCK or none.'],
            ['IdentitiesOnly', 'Use configured identities only (IdentitiesOnly)', 'yes or no'],
            ['CertificateFile', 'SSH certificate (CertificateFile)', '~/.ssh/id_ed25519-cert.pub'],
            ['UserKnownHostsFile', 'Known hosts files (UserKnownHostsFile)', '~/.ssh/known_hosts'],
            ['HostKeyAlias', 'Host key alias (HostKeyAlias)', ''],
            ['ConnectTimeout', 'Connection timeout (ConnectTimeout)', '10'],
            ['ServerAliveInterval', 'Keepalive interval (ServerAliveInterval)', '5'],
            ['ServerAliveCountMax', 'Keepalive attempts (ServerAliveCountMax)', '3'],
            ['ForwardAgent', 'Forward SSH agent (ForwardAgent)', 'yes or no'],
            ['Compression', 'Compression (Compression)', 'yes or no'],
          ].map(([keyword, label, hint]) => <TextInput key={keyword} label={t(label)} placeholder={t(hint)} value={sshOption(draft.ssh_options, keyword)} onChange={e => field('ssh_options', setSshOption(draft.ssh_options, keyword, e.currentTarget.value))} />)}
          <Textarea label={t('SSH login options')} description={t('OpenSSH syntax. Also supports multiple IdentityFile/CertificateFile entries, authentication preferences, algorithms, address family and bind address.')} autosize minRows={4} maxRows={12} value={draft.ssh_options} onChange={e => field('ssh_options', e.currentTarget.value)} />
          <Textarea label={t('Jump host definitions')} description={t('Imported jump host Host blocks are saved here, including their login accounts and identity files.')} autosize minRows={3} maxRows={12} value={draft.ssh_jump_config} onChange={e => field('ssh_jump_config', e.currentTarget.value)} />
        </Stack></Accordion.Panel></Accordion.Item></Accordion>
      </>}
      <PasswordInput label={t("Sudo password (optional)")} autoComplete="new-password" value={sudoPassword} onChange={e => setSudoPassword(e.currentTarget.value)} disabled={clearSudoPassword} maxLength={4096}
        description={t(identityChanged && server?.has_sudo_password ? "The saved password will be cleared because the server address or login account changed." : server?.has_sudo_password ? "A password is saved. Leave blank to keep it, or enter a replacement." : "Enter the SSH login account's sudo password if required. Otherwise, leave blank.")} />
      {!!server?.has_sudo_password && <Checkbox label={t("Clear saved sudo password")} checked={clearSudoPassword} onChange={e => setClearSudoPassword(e.currentTarget.checked)} />}
      <TextInput label={t('Server group')} maxLength={80} value={draft.group_name} onChange={e => field('group_name', e.currentTarget.value)} />
      <Textarea label={t('Notes')} maxLength={2000} autosize minRows={2} value={draft.notes} onChange={e => field('notes', e.currentTarget.value)} />
      <Checkbox label={t("Enable management")} checked={draft.enabled} onChange={e => field('enabled', e.currentTarget.checked)} />
    </Stack></form></Modal.Body>
    </Modal.Content>
  </Modal.Root>;
}

export default function Servers({ data, saved, monitor }: { data: Dashboard; saved: () => Promise<void>; monitor: (server: Server) => void }) {
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>('all');
  const [editor, setEditor] = useState<{ server: Server | null } | null>(null);
  const [remove, setRemove] = useState<Server | null>(null);
  const [busy, setBusy] = useState('');
  const [syncErrors, setSyncErrors] = useState<Record<string, string>>({});
  const [connections, setConnections] = useState<Record<number, { source: string; ok: boolean; detail: string }>>({});
  const [metrics, setMetrics] = useState<{ server: Server; result: ServerMetrics } | null>(null);
  const servers = data.servers.filter(server => [server.name, server.hostname, server.ssh_user, server.group_name || '', server.notes || ''].some(value => value.toLowerCase().includes(search.toLowerCase())) && (!group || server.group_name === group) && (filter === 'all' || (filter === 'enabled' ? !!server.enabled : !server.enabled)));
  // A saved scan is the initial result; newer checks apply only to the same connection settings.
  const connectionSource = (server: Server) => JSON.stringify([
    server.name, server.hostname, server.port, server.ssh_user, server.key_path,
    server.ssh_backend, server.ssh_alias, server.ssh_options, server.ssh_jump_config,
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
        const result = await api<ScanResult>(`/api/servers/${server.id}/scan`, 'POST');
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
  async function syncAll() {
    setBusy('scan-all'); setSyncErrors({});
    try {
      const result = await api<ScanResult>('/api/scan', 'POST');
      setSyncErrors(result.errors);
      for (const server of data.servers.filter(server => server.enabled)) {
        recordConnection(server, !result.errors[server.name], result.errors[server.name] || t('Last connection succeeded.'));
      }
      notify(result.ok ? t('Synced {0} accounts across all enabled servers.', { 0: result.users })
        : t('Synced {0} accounts. {1} servers failed to sync.', { 0: result.users, 1: Object.keys(result.errors).length }), !result.ok);
    } catch (cause) { notify(errorMessage(cause), true); }
    finally { try { await saved(); } finally { setBusy(''); } }
  }
  async function toggle(server: Server) {
    setBusy(`${server.id}:edit`);
    try { await api(`/api/servers/${server.id}`, 'PUT', { name: server.name, hostname: server.hostname, port: server.port, ssh_user: server.ssh_user, key_path: server.key_path, group_name: server.group_name, notes: server.notes, ssh_backend: server.ssh_backend, ssh_alias: server.ssh_alias, ssh_options: server.ssh_options, ssh_jump_config: server.ssh_jump_config, enabled: !server.enabled }); notify(server.enabled ? t("Server paused") : t("Server enabled")); await saved(); }
    catch (cause) { notify(errorMessage(cause), true); } finally { setBusy(''); }
  }
  async function removeServer() {
    if (!remove) return;
    setBusy(`${remove.id}:delete`);
    try { await api(`/api/servers/${remove.id}`, 'DELETE'); notify(t("Server removed from Mossentry")); setRemove(null); await saved(); }
    catch (cause) { notify(errorMessage(cause), true); } finally { setBusy(''); }
  }
  return <>
    <Group className="page-heading" justify="space-between" align="center" mb="lg"><div><Title order={2}>{t("Servers")}</Title></div><Group gap="xs"><InventoryTransfer saved={saved} /><Button leftSection={<IconPlus size={16} />} onClick={() => setEditor({ server: null })} disabled={!!busy}>{t("Add server")}</Button><Button variant="light" leftSection={<IconRefresh size={16} />} disabled={!!busy || !data.servers.some(server => server.enabled)} loading={busy === 'scan-all'} onClick={() => void syncAll()}>{t('Sync all servers')}</Button></Group></Group>
    {Object.keys(syncErrors).length > 0 && <Alert color="orange" mb="md" title={t('Some servers could not sync')} withCloseButton onClose={() => setSyncErrors({})}><Stack gap={4}>{Object.entries(syncErrors).map(([name, error]) => <Text key={name} size="sm">{name}: {t(error)}</Text>)}</Stack></Alert>}
    <Group className="filter-toolbar" mb="lg"><TextInput leftSection={<IconSearch size={16} />} placeholder={t("Find a server")} value={search} onChange={e => setSearch(e.currentTarget.value)} w={300} /><Select aria-label={t("Filter servers")} value={filter} onChange={setFilter} allowDeselect={false} data={[{ value: 'all', label: t("All servers") }, { value: 'enabled', label: t("Enabled") }, { value: 'paused', label: t("Paused") }]} w={160} /><Select clearable searchable placeholder={t("All groups")} aria-label={t("Server group")} value={group} onChange={setGroup} data={[...new Set(data.servers.map(s => s.group_name).filter(Boolean))].sort()} /><Text size="sm" c="dimmed">{t("Enabled / Total: {0}/{1}", { 0: data.servers.filter(s => s.enabled).length, 1: data.servers.length })}</Text></Group>
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
          <Title className="host-name" order={3} size="sm"><span className="host-text-scroll host-name-scroll" tabIndex={0} title={server.name}>{server.name}</span></Title>
          <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
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
                <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => setRemove(server)}>{t("Remove server")}</Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
        <Group className="host-accounts" gap="md" wrap="nowrap" align="start">
          <Text className="host-administrator" component="div" size="sm" c="dimmed"><span>{t("Administrator:")}</span><Text className="host-text-scroll host-username-scroll" span inherit c="var(--ink)" fw={600} tabIndex={0} title={server.ssh_user}>{server.ssh_user}</Text></Text>
          <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}><Text size="sm" c="dimmed">{t("Accounts:")}</Text><Text size="sm" fw={600}>{server.last_scan_at ? count : '—'}</Text></Group>
        </Group>
        {server.group_name && <Badge variant="light" mb="xs">{server.group_name}</Badge>}
        {server.notes && <Text size="xs" c="dimmed" mb="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{server.notes}</Text>}
        <Group className="server-actions" gap={8}>
          <Button size="xs" variant="default" disabled={!server.enabled || !!busy} loading={busy === `${server.id}:scan`} onClick={() => void operate(server, 'scan')}>{t("Sync")}</Button>
          <Button size="xs" variant="default" disabled={!server.enabled || !!busy} loading={busy === `${server.id}:status`} onClick={() => void operate(server, 'status')}>{t("Status")}</Button>
          <Button size="xs" variant="default" disabled={!server.enabled} onClick={() => monitor(server)}>{t("Monitor")}</Button>
        </Group>
      </Card>;
    })}</div> : <Paper withBorder radius="lg" p="xl"><Stack align="center"><IconServer size={34} color="#8795a9" /><Title order={3}>{data.servers.length ? t("No matching servers") : t("Add your first server")}</Title>{!data.servers.length && <Button onClick={() => setEditor({ server: null })}>{t("Add server")}</Button>}</Stack></Paper>}
    {editor && <ServerForm server={editor.server} close={() => setEditor(null)} saved={saved} />}
    <Modal opened={!!remove} onClose={() => !busy && setRemove(null)} title={t("Remove server?")} centered closeOnClickOutside={!busy} closeOnEscape={!busy}><Stack><Text size="sm">{t("Remove")} {remove?.name} {t("and its saved account list from Mossentry. The remote server, its users and files stay unchanged. Operation history is kept.")}</Text><Group justify="end"><Button variant="default" disabled={!!busy} onClick={() => setRemove(null)}>{t("Cancel")}</Button><Button color="red" disabled={!!busy} loading={!!busy} onClick={() => void removeServer()}>{t("Remove server")}</Button></Group></Stack></Modal>
    <Modal opened={!!metrics} onClose={() => setMetrics(null)} title={t("{0} · Server status", { 0: metrics?.server.name || '' })} centered size="lg"><Stack>{metrics && <>
      <Text size="xs" c="dimmed">{t("Checked")} {date(metrics.result.checked_at)}</Text><SimpleGrid cols={2}><Paper withBorder p="md"><Text size="sm" c="dimmed">{t("Uptime")}</Text><Text fw={700}>{Math.floor(metrics.result.uptime_seconds / 86400)} {t("days")} {Math.floor(metrics.result.uptime_seconds % 86400 / 3600)} {t("hours")}</Text></Paper><Paper withBorder p="md"><Text size="sm" c="dimmed">{t("System load · 1 / 5 / 15 min")}</Text><Text fw={700}>{metrics.result.load.join(' / ')}</Text></Paper></SimpleGrid>
      <div><Text size="sm" fw={700}>{t("Memory ·")} {metrics.result.memory_used_mb} / {metrics.result.memory_total_mb} MB</Text><Progress mt="xs" value={metrics.result.memory_total_mb ? metrics.result.memory_used_mb / metrics.result.memory_total_mb * 100 : 0} /></div><div><Text size="sm" fw={700}>{t("System disk (/) ·")} {metrics.result.disk_used_gb} / {metrics.result.disk_total_gb} GB</Text><Progress mt="xs" color={metrics.result.disk_percent > 90 ? 'red' : 'blue'} value={metrics.result.disk_percent} /></div><Group justify="end"><Button variant="default" onClick={() => setMetrics(null)}>{t("Close")}</Button><Button loading={!!busy} onClick={() => void operate(metrics.server, 'status')}>{t("Refresh status")}</Button></Group>
    </>}</Stack></Modal>
  </>;
}

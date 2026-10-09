import { t, locale, useLanguage } from './i18n';
import brandIcon from '../../icon.svg';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type * as React from 'react';
import {
  ActionIcon, Alert, AppShell, Avatar, Badge, Box, Burger, Button, Card, Center, Checkbox,
  Group, Loader, Modal, Pagination, Paper, ScrollArea,
  SegmentedControl, Select, SimpleGrid, Stack, Switch, Table, Text, TextInput,
  ThemeIcon, Title, Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconActivity, IconBell, IconArrowUpRight, IconCheck, IconChevronRight, IconDownload, IconLayoutDashboard,
  IconEdit, IconHistory, IconKey, IconPlus, IconSearch, IconServer,
  IconShieldCheck, IconUser, IconUsers,
} from '@tabler/icons-react';
import { api, downloadCredentials, fetchDashboard, setCsrf } from './api';
import type { Action, Dashboard, Server, User } from './types';
import Servers from './Servers';
import ResourceMonitor from './ResourceMonitor';
import DashboardPage from './DashboardPage';
import AppearanceControls from './AppearanceControls';

type View = 'dashboard' | 'overview' | 'monitor' | 'users' | 'approvals' | 'audit';
type UserAction = 'disable_user' | 'enable_user' | 'set_sudo' | 'delete_user';
type RequestDraft = { mode: 'create_user' | UserAction; username: string; server?: string; sudo: boolean };
type ConfirmDraft = { reject?: boolean; title: string; message: string; run: () => Promise<void> };

const actionLabels: Record<Action['action_type'], string> = {
  delete_user: 'Delete user', create_user: 'Create user', disable_user: 'Disable sign-in',
  enable_user: 'Enable sign-in', set_sudo: 'Change sudo access',
};
const eventLabels: Record<string, string> = {
  server_created: 'Server added', server_updated: 'Server updated', server_removed: 'Server removed',
  connection_tested: 'Connection successful', connection_failed: 'Connection failed', status_checked: 'Server status checked', status_failed: 'Server status unavailable',
  login_success: 'Administrator sign-in', login_failed: 'Sign-in failed', logout: 'Sign-out',
  scan_started: 'Scan started', scan_completed: 'Scan completed', scan_failed: 'Scan failed',
  action_requested: 'Request submitted', action_approved: 'Action approved',
  action_rejected: 'Action rejected', action_executed: 'Action completed',
  action_failed: 'Action failed', private_key_downloaded: 'Credentials downloaded',
  user_profile_updated: 'User profile updated', password_changed: 'Password changed',
};
const statusLabels: Record<Action['status'], string> = {
  pending: 'Pending', approved: 'Running', executed: 'Completed', failed: 'Failed', rejected: 'Rejected',
};
const statusColors: Record<Action['status'], string> = {
  pending: 'orange', approved: 'blue', executed: 'green', failed: 'red', rejected: 'gray',
};
const pageSize = 12;

function formatDate(value: string | null | undefined) {
  if (!value) return t("Never");
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale(), {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function message(error: unknown) { return error instanceof Error ? error.message : t("Operation failed"); }
function notify(text: string, error = false) {
  notifications.show({ title: error ? t("Could not complete") : t("Done"), message: t(text), color: error ? 'red' : 'teal' });
}

function Empty({ text }: { text: string }) {
  return <Center py="xl"><Text c="dimmed" size="sm">{text}</Text></Center>;
}

function SectionHeading({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return <Group className="page-heading" justify="space-between" align="center" mb="lg" gap="md">
    <div><Title order={2}>{title}</Title><Text c="dimmed" size="sm" mt={4}>{description}</Text></div>{action}
  </Group>;
}

function Users({ data, openRequest, openProfile }: { data: Dashboard; openRequest: (draft: RequestDraft) => void; openProfile: (username: string, fullName: string) => void }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('enabled');
  const [host, setHost] = useState<string | null>('all');
  const [page, setPage] = useState(1);
  const groups = useMemo(() => {
    const grouped = new Map<string, User[]>();
    for (const user of data.users.filter(user => host === 'all' || user.server === host)) grouped.set(user.username, [...(grouped.get(user.username) || []), user]);
    return [...grouped].map(([username, accounts]) => ({
      username, accounts: accounts.sort((a, b) => a.server.localeCompare(b.server, undefined, { numeric: true })),
      fullName: accounts.find(a => a.full_name)?.full_name || '',
    })).filter(group => {
      const match = [group.username, group.fullName, ...group.accounts.map(a => a.server)].some(value => value.toLowerCase().includes(search.toLowerCase()));
      const selected = filter === 'all' || group.accounts.some(a => filter === 'sudo' ? !!a.is_sudo : filter === 'disabled' ? !!a.is_disabled : !a.is_disabled);
      return match && selected;
    }).sort((a, b) => a.username.localeCompare(b.username, undefined, { numeric: true }));
  }, [data.users, search, filter, host]);
  const pages = Math.max(1, Math.ceil(groups.length / pageSize));
  const shown = groups.slice((Math.min(page, pages) - 1) * pageSize, Math.min(page, pages) * pageSize);
  return <>
    <SectionHeading title={t("Users & access")} description={t("Accounts grouped by Linux username")} action={<Button leftSection={<IconPlus size={16} />} disabled={!data.servers.some(s => s.enabled)} onClick={() => openRequest({ mode: 'create_user', username: '', sudo: false })}>{t("New user")}</Button>} />
    {data.servers.some(s => s.enabled && ['error', 'failed'].includes(s.last_scan_status || '')) && <Alert color="orange" mb="md">{t("Some servers could not sync. Their displayed accounts may be out of date. Sync those servers before making further changes.")}</Alert>}
    <Group className="filter-toolbar" mb="lg" justify="space-between" gap="sm">
      <TextInput leftSection={<IconSearch size={16} />} placeholder={t("Search a user or host")} value={search} onChange={e => { setSearch(e.currentTarget.value); setPage(1); }} w={{ base: '100%', sm: 290 }} />
      <Select aria-label={t("Filter by server")} value={host} allowDeselect={false} onChange={value => { setHost(value); setPage(1); }} data={[{ value: 'all', label: t("All servers") }, ...data.servers.map(s => ({ value: s.name, label: s.name }))]} /><SegmentedControl value={filter} onChange={value => { setFilter(value); setPage(1); }} data={[t("Enabled"), t("Sudo"), t("Disabled"), t("All")].map(label => ({ label, value: label.toLowerCase() }))} />
    </Group>
    <Card withBorder radius="lg" p={0}>
      <Box p="lg"><Title order={3} size="h4">{t("Server users")}</Title><Text size="sm" c="dimmed">{t("Expand a user to review accounts and permissions on each host.")}</Text></Box>
      {shown.length ? shown.map(group => <details className="user-group" key={group.username}>
        <summary><Group justify="space-between" wrap="nowrap" p="md" gap="sm">
          <Group wrap="nowrap" gap="sm"><Avatar color="blue" radius="xl">{(group.fullName || group.username).charAt(0).toUpperCase()}</Avatar><div><Text fw={600} size="sm">{group.fullName || group.username} {group.fullName && <Text span c="dimmed" fw={500}>({group.username})</Text>}</Text><Text size="xs" c="dimmed">{group.accounts.length} {t("host accounts")}</Text></div></Group>
          <Group gap="xs" wrap="nowrap" className="user-summary-end">
            {group.accounts.some(a => a.is_sudo) && <Badge color="orange" variant="light">{t("Sudo")}</Badge>}
            {group.accounts.some(a => a.is_disabled) && <Badge color="red" variant="light">{t("Disabled")}</Badge>}
            <Tooltip label={t("Edit name or note")}><ActionIcon variant="subtle" color="gray" aria-label={t("Edit {0} profile", { 0: group.username })} onClick={e => { e.preventDefault(); openProfile(group.username, group.fullName); }}><IconEdit size={18} /></ActionIcon></Tooltip>
            <IconChevronRight className="details-chevron" size={17} />
          </Group>
        </Group></summary>
        <ScrollArea><Table striped highlightOnHover miw={650} verticalSpacing="sm" horizontalSpacing="lg"><Table.Thead><Table.Tr><Table.Th>{t("Host")}</Table.Th><Table.Th>{t("Access")}</Table.Th><Table.Th>{t("Sign-in")}</Table.Th><Table.Th>{t("Actions")}</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
          {group.accounts.map(account => {
            const server = data.servers.find(s => s.name === account.server);
            const protectedAccount = account.uid < 1000 || ['root', 'srvmgr', 'nobody', server?.ssh_user].includes(account.username);
            return <Table.Tr key={`${account.server}:${account.username}`}>
            <Table.Td><Badge variant="light" color="blue">{account.server}</Badge></Table.Td><Table.Td><Badge variant="light" color={account.is_sudo ? 'orange' : 'gray'}>{account.is_sudo ? t("Sudo") : t("Standard")}</Badge></Table.Td><Table.Td><Badge variant="light" color={account.is_disabled ? 'red' : 'teal'}>{account.is_disabled ? t("Disabled") : t("Enabled")}</Badge></Table.Td>
            <Table.Td>{protectedAccount ? <Text size="xs" c="dimmed">{t("Protected account")}</Text> : !server?.enabled ? <Text size="xs" c="dimmed">{t("Server paused")}</Text> : <Group className="account-actions" gap="xs" wrap="nowrap"><Button size="compact-xs" variant="light" color={account.is_disabled ? 'teal' : 'orange'} onClick={() => openRequest({ mode: account.is_disabled ? 'enable_user' : 'disable_user', username: account.username, server: account.server, sudo: false })}>{account.is_disabled ? t("Enable") : t("Disable")}</Button><Button size="compact-xs" variant="light" onClick={() => openRequest({ mode: 'set_sudo', username: account.username, server: account.server, sudo: !account.is_sudo })}>{account.is_sudo ? t("Revoke sudo") : t("Grant sudo")}</Button><Button size="compact-xs" color="red" variant="light" onClick={() => openRequest({ mode: 'delete_user', username: account.username, server: account.server, sudo: false })}>{t("Delete")}</Button></Group>}</Table.Td>
          </Table.Tr>; })}
        </Table.Tbody></Table></ScrollArea>
      </details>) : <Empty text={t("No users match your search")} />}
      {groups.length > pageSize && <Group justify="space-between" p="md" className="pagination-row"><Text size="sm" c="dimmed">{groups.length} {t("users")}</Text><Pagination value={Math.min(page, pages)} onChange={setPage} total={pages} size="sm" /></Group>}
    </Card>
  </>;
}

function Approvals({ data, run, busy, approveAll, download }: { data: Dashboard; run: (action: Action, kind: 'approve' | 'reject') => void; busy: boolean; approveAll: () => void; download: (action: Action) => void }) {
  const [page, setPage] = useState(1);
  const pending = data.actions.filter(a => a.status === 'pending').length;
  const pages = Math.max(1, Math.ceil(data.actions.length / 10));
  return <>
    <SectionHeading title={t("Approvals")} description={t("Requests run on a server only after administrator approval.")} action={<Button leftSection={<IconCheck size={16} />} disabled={!pending || busy} onClick={approveAll}>{t("Approve all")} {pending ? `(${pending})` : ''}</Button>} />
    <Stack gap="sm">
      {data.actions.slice((Math.min(page, pages) - 1) * 10, Math.min(page, pages) * 10).map(action => <Card key={action.id} withBorder radius="lg" p="lg" className="approval-row">
        <Group justify="space-between" align="start" gap="md">
          <Group align="start" gap="md"><ThemeIcon variant="light" color={action.action_type === 'create_user' ? 'blue' : 'cyan'} size={40} radius="md">{action.action_type === 'create_user' ? <IconUser size={20} /> : <IconKey size={20} />}</ThemeIcon><div>
            <Group gap="xs"><Text className="approval-title" fw={700}>#{action.id} {t(actionLabels[action.action_type])} · {action.target_user}</Text><Badge color={statusColors[action.status]} variant="light">{t(statusLabels[action.status])}</Badge></Group>
            <Text size="sm" c="dimmed" mt={3}>{t("Target:")} {action.target_server}{action.action_type === 'set_sudo' ? ` · ${action.payload.sudo ? t("Grant sudo") : t("Revoke sudo")}` : ''}{action.action_type === 'create_user' ? ` · ${action.payload.sudo ? t("Sudo user") : t("Standard user")}` : ''}</Text>
            <Text size="xs" c="dimmed" mt={4}>{t("Requested by")} {action.requested_by_name} · {formatDate(action.requested_at)}</Text>
          </div></Group>
          <Group gap="xs" className="approval-controls">
            {action.status === 'pending' && <><Button variant="light" color="gray" size="xs" disabled={busy} onClick={() => run(action, 'reject')}>{t("Reject")}</Button><Button size="xs" disabled={busy} onClick={() => run(action, 'approve')}>{t("Approve and run")}</Button></>}
            {action.private_key_ready && <Button size="xs" leftSection={<IconDownload size={15} />} onClick={() => download(action)}>{t("Download credentials once")}</Button>}
            {action.key_downloaded_at && <Badge color="teal" variant="light">{t("Credentials downloaded")}</Badge>}
          </Group>
        </Group>
        {action.error && <Alert color="red" mt="md" title={t("Execution failed")}><Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{t(action.error)}</Text></Alert>}
      </Card>)}
      {!data.actions.length && <Paper withBorder radius="lg"><Empty text={t("No requests yet")} /></Paper>}
      {data.actions.length > 10 && <Group justify="space-between" mt="md"><Text size="sm" c="dimmed">{data.actions.length} {t("records")}</Text><Pagination value={Math.min(page, pages)} onChange={setPage} total={pages} size="sm" /></Group>}
    </Stack>
  </>;
}

function AuditLog({ data }: { data: Dashboard }) {
  return <><SectionHeading title={t("Activity log")} description={t("Scans, approvals, executions, and credential downloads")} />
    <Card withBorder radius="lg" p={0}><Box p="lg"><Title order={3} size="h4">{t("Audit trail")}</Title><Text size="sm" c="dimmed">{t("Most recent events in Mossentry")}</Text></Box>
      <ScrollArea><Table striped highlightOnHover miw={700} verticalSpacing="md" horizontalSpacing="lg"><Table.Thead><Table.Tr><Table.Th>{t("Time")}</Table.Th><Table.Th>{t("Administrator")}</Table.Th><Table.Th>{t("Event")}</Table.Th><Table.Th>{t("Target")}</Table.Th>{!data.admin.desktop_mode && <Table.Th>{t("Source")}</Table.Th>}</Table.Tr></Table.Thead><Table.Tbody>
        {data.audit.map(item => <Table.Tr key={item.id}><Table.Td>{formatDate(item.created_at)}</Table.Td><Table.Td>{item.actor || t("System")}</Table.Td><Table.Td><Text fw={700} size="sm">{t(eventLabels[item.event] || 'Other activity')}</Text></Table.Td><Table.Td>{item.target === 'all_servers' ? t("All servers") : item.target?.startsWith('action:') ? t("Request #{0}", { 0: item.target.slice(7) }) : item.target || '—'}</Table.Td>{!data.admin.desktop_mode && <Table.Td>{item.ip_address || '—'}</Table.Td>}</Table.Tr>)}
      </Table.Tbody></Table></ScrollArea>{!data.audit.length && <Empty text={t("No activity yet")} />}</Card>
  </>;
}

function RequestModal({ draft, servers, close, saved }: { draft: RequestDraft | null; servers: Server[]; close: () => void; saved: () => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [sudo, setSudo] = useState(false);
  const [deleteName, setDeleteName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (draft) { setUsername(draft.username); setFullName(''); setSelected(draft.server ? [draft.server] : []); setSudo(draft.sudo); setDeleteName(''); setError(''); } }, [draft]);
  if (!draft) return null;
  const create = draft.mode === 'create_user';
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError('');
    if (!selected.length) { setError(t("Select at least one host")); return; }
    if (draft?.mode === 'delete_user' && deleteName !== username) { setError(t("Type the username to confirm deletion")); return; }
    setBusy(true);
    try {
      if (create) await api('/api/actions/create-user', 'POST', { username, full_name: fullName, servers: selected, sudo });
      else await api('/api/actions/user', 'POST', { username, servers: selected, action: draft!.mode, ...(draft!.mode === 'set_sudo' ? { sudo } : {}) });
      close(); notify(t("Request submitted for approval")); await saved();
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  return <Modal opened onClose={() => !busy && close()} closeOnClickOutside={!busy} closeOnEscape={!busy} title={create ? t("New user") : t(actionLabels[draft.mode])} centered radius="lg">
    <form onSubmit={submit}><Stack gap="md">
      {create ? <><TextInput label={t("Linux username")} placeholder={t("e.g. alex")} value={username} onChange={e => setUsername(e.currentTarget.value)} pattern="[a-z_][a-z0-9_-]{0,31}" required /><TextInput label={t("Name or note (optional)")} placeholder={t("e.g. Alex Morgan · Research")} value={fullName} onChange={e => setFullName(e.currentTarget.value)} maxLength={100} />
        <Checkbox.Group label={t("Allowed hosts")} description={t("An account will be created on each selected host.")} value={selected} onChange={setSelected}><SimpleGrid cols={2} mt="sm">{servers.filter(s => s.enabled).map(server => <Checkbox key={server.id} value={server.name} label={server.name.toUpperCase()} />)}</SimpleGrid></Checkbox.Group>
        <Switch label={t("Grant sudo access")} description={t("Allow this user to run administrative commands")} checked={sudo} onChange={e => setSudo(e.currentTarget.checked)} />
        <Alert color="blue" variant="light" icon={<IconKey size={17} />}>{t("Approval generates an Ed25519 key. Credentials can be downloaded once; share them through a secure channel.")}</Alert>
      </> : <><Paper withBorder p="sm"><Text size="xs" c="dimmed">{t("Linux user")}</Text><Text fw={700}>{username}</Text></Paper><Paper withBorder p="sm"><Text size="xs" c="dimmed">{t("Target host")}</Text><Text fw={700}>{draft.server?.toUpperCase()}</Text></Paper>{draft.mode === 'set_sudo' && <Text size="sm">{t("This request will")} {sudo ? t('grant') : t('revoke')} {t("sudo access.")}</Text>}</>}
      {draft.mode === 'delete_user' && <><Alert color="red">{t("This removes the account from")} {draft.server}{t(". Its home directory and files will be kept. End running sessions first. Deletion runs after approval.")}</Alert><TextInput label={t("Type {0} to confirm", { 0: username })} value={deleteName} onChange={e => setDeleteName(e.currentTarget.value)} required /></>}
      {error && <Alert color="red" role="alert">{t(error)}</Alert>}
      <Group justify="end"><Button variant="default" disabled={busy} onClick={close}>{t("Cancel")}</Button><Button type="submit" color={draft.mode === 'delete_user' ? 'red' : 'blue'} disabled={!selected.length || (draft.mode === 'delete_user' && deleteName !== username)} loading={busy}>{create ? t("Submit for approval") : t("Submit request")}</Button></Group>
    </Stack></form>
  </Modal>;
}

function ProfileModal({ profile, close, saved }: { profile: { username: string; fullName: string } | null; close: () => void; saved: () => Promise<void> }) {
  const [fullName, setFullName] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { setFullName(profile?.fullName || ''); setError(''); }, [profile]);
  if (!profile) return null;
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await api(`/api/users/${encodeURIComponent(profile!.username)}/profile`, 'PUT', { full_name: fullName }); close(); notify(t("Name or note updated")); await saved(); }
    catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }
  return <Modal opened onClose={close} title={t("Edit name or note")} centered radius="lg"><form onSubmit={submit}><Stack>
    <Paper withBorder p="sm"><Text size="xs" c="dimmed">{t("Linux user")}</Text><Text fw={700}>{profile.username}</Text></Paper>
    <TextInput label={t("Name or note (optional)")} value={fullName} onChange={e => setFullName(e.currentTarget.value)} maxLength={100} autoFocus />
    <Text size="xs" c="dimmed">{t("This profile is shared across the user's accounts on all hosts. Save an empty field to clear it.")}</Text>
    {error && <Alert color="red">{t(error)}</Alert>}
    <Group justify="end"><Button variant="default" onClick={close}>{t("Cancel")}</Button><Button type="submit" loading={busy}>{t("Save")}</Button></Group>
  </Stack></form></Modal>;
}

export default function App() {
  const language = useLanguage();
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState('');
  const [view, setView] = useState<View>('dashboard');
  const [mobileOpened, setMobileOpened] = useState(false);
  const [monitorServerId, setMonitorServerId] = useState<number | null>(null);
  const [request, setRequest] = useState<RequestDraft | null>(null);
  const [profile, setProfile] = useState<{ username: string; fullName: string } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try { const next = await fetchDashboard(); setData(next); setFatal(''); }
    catch (cause) {
      if ([401, 403].includes((cause as { status?: number }).status ?? 0)) {
        setData(null); setCsrf('');
        setFatal(t("Cannot access the local service. Retry or reopen the desktop app."));
      } else { setFatal(message(cause)); }
    }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!data?.actions.some(a => a.status === 'approved')) return;
    const timer = setInterval(() => { void refresh(); }, 2000);
    return () => clearInterval(timer);
  }, [data?.actions, refresh]);

  function actionConfirm(action: Action, kind: 'approve' | 'reject') {
    setConfirm({ reject: kind === 'reject', title: kind === 'approve' ? t("Approve and run request?") : t("Reject request?"),
      message: kind === 'approve' ? t("{0} for {1} on {2}.{3}", { 0: t(actionLabels[action.action_type]), 1: action.target_user, 2: action.target_server, 3: action.action_type === 'delete_user' ? t(" The account will be deleted; its home directory and files will be kept.") : t(" This connects to the target host.") }) : t("Reject request #{0} for {1}?", { 0: action.id, 1: action.target_user }),
      run: async () => { const result = await api<{ warning?: string }>(`/api/actions/${action.id}/${kind}`, 'POST'); notify(result.warning || (kind === 'approve' ? t("Action completed") : t("Request rejected")), !!result.warning); await refresh(); },
    });
  }
  function approveAll() {
    const pending = data?.actions.filter(a => a.status === 'pending') || [];
    if (!pending.length) return;
    setConfirm({ title: t("Approve all {0} requests?", { 0: pending.length }), message: t("Each request will connect to its target host and run in order.{0}", { 0: pending.some(a => a.action_type === 'delete_user') ? t(" Includes account deletion. Home directories and files will be kept.") : '' }),
      run: async () => {
        let succeeded = 0; const failed: number[] = [];
        for (const action of pending) {
          try { const result = await api<{ warning?: string }>(`/api/actions/${action.id}/approve`, 'POST'); if (result.warning) notify(result.warning, true); succeeded++; }
          catch { failed.push(action.id); }
          await refresh();
        }
        notify(failed.length ? t("{0} completed; requests {1} failed", { 0: succeeded, 1: failed.join(', ') }) : t("Approved and ran {0} requests", { 0: succeeded }), failed.length > 0);
      },
    });
  }
  async function runConfirm() {
    if (!confirm) return;
    setBusy(true);
    try { await confirm.run(); setConfirm(null); }
    catch (cause) { notify(message(cause), true); await refresh(); setConfirm(null); }
    finally { setBusy(false); }
  }
  async function download(action: Action) {
    try { await downloadCredentials(action.id, action.target_user); notify(t("Credentials downloaded. This copy cannot be downloaded again.")); await refresh(); }
    catch (cause) { notify(message(cause), true); await refresh(); }
  }
  if (loading) return <Center h="100vh"><Loader /></Center>;
  if (!data) return <Center h="100vh"><Stack align="center"><Alert color="red">{fatal || t("Could not load the dashboard")}</Alert><Button onClick={() => void refresh()}>{t("Retry")}</Button></Stack></Center>;
  const pending = data.actions.filter(a => a.status === 'pending').length;
  const nav: { id: View; label: string; icon: React.ReactNode }[] = [
    { id: 'dashboard', label: t("Dashboard"), icon: <IconLayoutDashboard size={19} /> },
    { id: 'overview', label: t("Servers"), icon: <IconServer size={19} /> },
    { id: 'monitor', label: t("Monitor"), icon: <IconActivity size={19} /> },
    { id: 'users', label: t("Users & access"), icon: <IconUsers size={19} /> },
    { id: 'approvals', label: t("Approvals"), icon: <IconShieldCheck size={19} /> },
    { id: 'audit', label: t("Activity log"), icon: <IconHistory size={19} /> },
  ];
  function navigate(next: View) {
    setView(next);
    if (next === 'monitor') setMonitorServerId(null);
    setMobileOpened(false);
  }
  const nativeDesktop = navigator.userAgent.includes('Electron');
  return <AppShell data-language={language} navbar={{ width: 232, breakpoint: 'sm', collapsed: { mobile: !mobileOpened } }} header={{ height: nativeDesktop ? 100 : 76 }} padding={0}>
    <AppShell.Header className="topbar">
      <div className="topbar-brand"><img className="brand-mark" src={brandIcon} width={42} height={42} alt="" /><span className="brand-name"><span className="brand-accent">Moss</span>entry</span></div>
      <div className="topbar-content">
        <Burger className="navigation-toggle" opened={mobileOpened} onClick={() => setMobileOpened(value => !value)} hiddenFrom="sm" size="sm" aria-label={t("Toggle navigation")} />
        <span className="workspace-chip"><IconServer size={17} stroke={1.6} /> {t("Workspace")}</span>
        <Select className="global-search" aria-label={t("Jump to a page")} placeholder={t("Find a page…")} leftSection={<IconSearch size={16} />} searchable clearable
          value={null} onChange={value => { if (value) navigate(value as View); }} data={nav.map(item => ({ value: item.id, label: item.label }))} nothingFoundMessage={t("No matching pages")} />
        <div className="topbar-actions">
          <Tooltip label={pending ? t("{0} requests awaiting approval", { 0: pending }) : t("View approvals")}><ActionIcon className="approval-bell" variant="subtle" color="gray" size="lg" aria-label={t("View pending approvals")} onClick={() => navigate('approvals')}><IconBell size={20} stroke={1.5} />{pending > 0 && <span className="notification-dot" />}</ActionIcon></Tooltip>
          <AppearanceControls />
        </div>
      </div>
    </AppShell.Header>
    <AppShell.Navbar className="sidebar" p="md">
      <ScrollArea className="sidebar-scroll" viewportProps={{ tabIndex: 0, 'aria-label': t("Navigation") }}>
        <span className="nav-section-label">{t("Workspace")}</span>
        <Stack component="nav" aria-label={t("Main navigation")} gap={7}>{nav.map((item, index) => <div key={item.id}>
          {index === 3 && <span className="nav-section-label nav-section-divider">{t("Administration")}</span>}
          <button type="button" aria-current={view === item.id ? 'page' : undefined} className={`nav-button ${view === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)}><span>{item.icon}</span><span>{item.label}</span>{item.id === 'approvals' && pending > 0 && <Badge size="sm" color={view === 'approvals' ? 'gray' : 'teal'} variant="light" circle ml="auto">{pending}</Badge>}</button>
        </div>)}</Stack>
      </ScrollArea>
      <div className="sidebar-footer">
        <div className="workspace-card"><span className="workspace-card-icon"><IconActivity size={22} stroke={1.5} /></span><strong>{t("Your infrastructure,")}<br />{t("at a glance.")}</strong><p>{t("Follow resource usage across your managed servers.")}</p><Button fullWidth variant="light" rightSection={<IconArrowUpRight size={15} />} onClick={() => navigate('monitor')}>{t("Open monitor")}</Button></div>
        <div className={`service-status ${fatal ? 'has-error' : ''}`}><i /><span>{fatal ? t("Service needs attention") : t("Mossentry connected")}</span><span className="service-status-count">{data.servers.length} {t("hosts")}</span></div>
      </div>
    </AppShell.Navbar>
    <AppShell.Main className="main-area"><ScrollArea key={view} className="page-scroll" h="calc(100dvh - var(--app-shell-header-offset, 0px))" viewportProps={{ tabIndex: 0, 'aria-label': t("Page content") }}><main className="content">
      {fatal && <Alert color="red" mb="md" withCloseButton onClose={() => setFatal('')}>{t(fatal)}</Alert>}
      {view === 'dashboard' && <DashboardPage data={data} refresh={refresh} openServers={() => navigate('overview')} openApprovals={() => navigate('approvals')} />}
      {view === 'overview' && <Servers data={data} saved={refresh} monitor={server => { setMonitorServerId(server.id); setView('monitor'); }} />}
      {view === 'monitor' && <ResourceMonitor data={data} serverId={monitorServerId} selectServer={setMonitorServerId} />}
      {view === 'users' && <Users data={data} openRequest={setRequest} openProfile={(username, fullName) => setProfile({ username, fullName })} />}
      {view === 'approvals' && <Approvals data={data} run={actionConfirm} busy={busy} approveAll={approveAll} download={action => void download(action)} />}
      {view === 'audit' && <AuditLog data={data} />}
    </main></ScrollArea></AppShell.Main>
    <RequestModal draft={request} servers={data.servers} close={() => setRequest(null)} saved={refresh} />
    <ProfileModal profile={profile} close={() => setProfile(null)} saved={refresh} />
    <Modal opened={!!confirm} onClose={() => !busy && setConfirm(null)} title={confirm?.title} centered radius="lg" closeOnClickOutside={!busy} closeOnEscape={!busy}>
      <Stack><Text size="sm">{confirm?.message}</Text><Group justify="end"><Button variant="default" disabled={busy} onClick={() => setConfirm(null)}>{t("Cancel")}</Button><Button color="blue" loading={busy} onClick={() => void runConfirm()}>{confirm?.reject ? t("Reject") : t("Confirm and run")}</Button></Group></Stack>
    </Modal>
  </AppShell>;
}

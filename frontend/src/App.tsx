import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import WindowControls from './WindowControls';
import { numericDate } from './dateFormat';
import { t, useLanguage } from './i18n';
import brandIcon from '../../icon.svg';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import {
  ActionIcon, Alert, AppShell, Avatar, Badge, Box, Burger, Button, Card, Center, Checkbox,
  Group, Loader, Modal, Pagination, Paper, PasswordInput, ScrollArea,
  SegmentedControl, Select, SimpleGrid, Stack, Switch, Table, Text, TextInput,
  ThemeIcon, Title, Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMediaQuery, useReducedMotion } from '@mantine/hooks';
import {
  IconCheck, IconChevronRight, IconDownload, IconLayoutDashboard,
  IconEdit, IconHistory, IconKey, IconPlus, IconSearch, IconServer,
  IconShieldCheck, IconUser, IconUsers, IconLayoutSidebarLeftCollapse,
} from '@tabler/icons-react';
import { api, downloadCredentials, fetchDashboard, setCsrf } from './api';
import { filteredAccounts, type UserFilter } from './userData';
import type { Action, Dashboard, Server, User } from './types';
import Servers from './Servers';
import Operations from './Operations';
import OperationsNav from './OperationsNav';
import FirewallPage from './FirewallPage';
import { approvalLists, type ApprovalList } from './approvalData';
import { flyToApprovals } from './approvalMotion';
import ResourceMonitor from './ResourceMonitor';
import DashboardPage from './DashboardPage';
import AppearanceControls from './AppearanceControls';
import UpdateButton from './UpdateButton';

type View = 'firewall' | 'operations' | 'dashboard' | 'overview' | 'monitor' | 'users' | 'approvals' | 'audit';
type UserAction = 'disable_user' | 'enable_user' | 'set_sudo' | 'delete_user';
type RequestDraft = { mode: 'create_user' | UserAction; username: string; server?: string; sudo: boolean };
type ConfirmDraft = { reject?: boolean; title: string; message: string; run: () => Promise<void> };

const actionLabels: Record<Action['action_type'], string> = {
  delete_user: 'Delete user', create_user: 'Create user', disable_user: 'Disable sign-in',
  enable_user: 'Enable sign-in', set_sudo: 'Change sudo access',
};
const eventLabels: Record<string, string> = {
  server_created: 'Server added', server_updated: 'Server updated', server_removed: 'Server removed',
  firewall_checked: 'Firewall checked', firewall_changed: 'Firewall changed', firewall_failed: 'Firewall operation failed', ping_tested: 'Ping tested',
  connection_tested: 'Connection successful', connection_failed: 'Connection failed', status_checked: 'Server status checked', status_failed: 'Server status unavailable',
  login_success: 'Administrator sign-in', login_failed: 'Sign-in failed', logout: 'Sign-out',
  scan_started: 'Scan started', scan_completed: 'Scan completed', scan_failed: 'Scan failed',
  action_requested: 'Request submitted', action_approved: 'Action approved',
  action_rejected: 'Action rejected', action_executed: 'Action completed',
  action_failed: 'Action failed', private_key_downloaded: 'Credentials downloaded',
  approval_batch_approved: 'Approval list approved', approval_batch_rejected: 'Approval list rejected', approval_batch_finished: 'Approval list completed', approval_batch_failed: 'Approval list failed',
  operation_started: 'Server task started', operation_host_finished: 'Server task finished', operation_deleted: 'Saved task deleted', inventory_imported: 'Inventory imported',
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
  return numericDate(value, { includeTime: true });
}

function message(error: unknown) { return error instanceof Error ? error.message : t("Operation failed"); }
function notify(text: string, error = false) {
  notifications.show({ title: error ? t("Could not complete") : t("Done"), message: t(text), color: error ? 'red' : 'teal' });
}

function Empty({ text }: { text: string }) {
  return <Center py="xl"><Text c="dimmed" size="sm">{text}</Text></Center>;
}

function SectionHeading({ title, action }: { title: string; action?: React.ReactNode }) {
  return <Group className="page-heading" justify="space-between" align="center" mb="lg" gap="md">
    <Title order={2}>{title}</Title>{action}
  </Group>;
}

function Users({ data, openRequest, openProfile }: { data: Dashboard; openRequest: (draft: RequestDraft, source?: HTMLElement) => void; openProfile: (username: string, fullName: string) => void }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<UserFilter>('enabled');
  const [host, setHost] = useState<string | null>('all');
  const [page, setPage] = useState(1);
  const groups = useMemo(() => {
    const grouped = new Map<string, User[]>();
    for (const user of filteredAccounts(data.users, filter, host)) grouped.set(user.username, [...(grouped.get(user.username) || []), user]);
    return [...grouped].map(([username, accounts]) => ({
      username, accounts: accounts.sort((a, b) => a.server.localeCompare(b.server, undefined, { numeric: true })),
      fullName: accounts.find(a => a.full_name)?.full_name || '',
    })).filter(group => {
      const match = [group.username, group.fullName, ...group.accounts.map(a => a.server)].some(value => value.toLowerCase().includes(search.toLowerCase()));
      return match;
    }).sort((a, b) => a.username.localeCompare(b.username, undefined, { numeric: true }));
  }, [data.users, search, filter, host]);
  const pages = Math.max(1, Math.ceil(groups.length / pageSize));
  const shown = groups.slice((Math.min(page, pages) - 1) * pageSize, Math.min(page, pages) * pageSize);
  return <>
    <SectionHeading title={t("Users & access")} action={<Button leftSection={<IconPlus size={16} />} disabled={!data.servers.some(s => s.enabled)} onClick={() => openRequest({ mode: 'create_user', username: '', sudo: false })}>{t("New user")}</Button>} />
    {data.servers.some(s => s.enabled && ['error', 'failed'].includes(s.last_scan_status || '')) && <Alert color="orange" mb="md">{t("Some servers could not sync. Their displayed accounts may be out of date. Sync those servers before making further changes.")}</Alert>}
    <Group className="filter-toolbar" mb="lg" justify="space-between" gap="sm">
      <TextInput leftSection={<IconSearch size={16} />} placeholder={t("Search a user or host")} value={search} onChange={e => { setSearch(e.currentTarget.value); setPage(1); }} w={{ base: '100%', sm: 290 }} />
      <Select aria-label={t("Filter by server")} value={host} allowDeselect={false} onChange={value => { setHost(value); setPage(1); }} data={[{ value: 'all', label: t("All servers") }, ...data.servers.map(s => ({ value: s.name, label: s.name }))]} /><SegmentedControl value={filter} onChange={value => { setFilter(value as UserFilter); setPage(1); }} data={[{ value: 'enabled', label: t("Enabled") }, { value: 'sudo', label: t("Sudo") }, { value: 'disabled', label: t("Disabled") }, { value: 'all', label: t("All") }]} />
    </Group>
    <Card withBorder radius="lg" p={0}>
      <Box p="lg"><Title order={3}>{t("Server users")}</Title></Box>
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
            const pending = (type: UserAction) => data.actions.some(action => action.status === 'pending' && action.action_type === type && action.target_user === account.username && action.payload.servers?.includes(account.server));
            const accessAction = account.is_disabled ? 'enable_user' : 'disable_user';
            const protectedAccount = !['srvmgr', 'sync'].includes(account.username) && (account.uid < 1000 || ['root', 'nobody', server?.ssh_user].includes(account.username));
            return <Table.Tr key={`${account.server}:${account.username}`}>
            <Table.Td><Badge variant="light" color="blue">{account.server}</Badge></Table.Td><Table.Td><Badge variant="light" color={account.is_sudo ? 'orange' : 'gray'}>{account.is_sudo ? t("Sudo") : t("Standard")}</Badge></Table.Td><Table.Td><Badge variant="light" color={account.is_disabled ? 'red' : 'teal'}>{account.is_disabled ? t("Disabled") : t("Enabled")}</Badge></Table.Td>
            <Table.Td>{protectedAccount ? <Text size="xs" c="dimmed">{t("Protected account")}</Text> : !server?.enabled ? <Text size="xs" c="dimmed">{t("Server paused")}</Text> : <Group className="account-actions" gap="xs" wrap="nowrap"><Button size="compact-xs" disabled={pending(accessAction)} variant="light" color={account.is_disabled ? 'teal' : 'orange'} onClick={e => openRequest({ mode: account.is_disabled ? 'enable_user' : 'disable_user', username: account.username, server: account.server, sudo: false }, e.currentTarget)}>{pending(accessAction) ? t("In approval list") : account.is_disabled ? t("Enable") : t("Disable")}</Button><Button size="compact-xs" disabled={pending('set_sudo')} variant="light" onClick={e => openRequest({ mode: 'set_sudo', username: account.username, server: account.server, sudo: !account.is_sudo }, e.currentTarget)}>{pending('set_sudo') ? t("In approval list") : account.is_sudo ? t("Revoke sudo") : t("Grant sudo")}</Button><Button size="compact-xs" disabled={pending('delete_user')} color="red" variant="light" onClick={e => openRequest({ mode: 'delete_user', username: account.username, server: account.server, sudo: false }, e.currentTarget)}>{pending('delete_user') ? t("In approval list") : t("Delete")}</Button></Group>}</Table.Td>
          </Table.Tr>; })}
        </Table.Tbody></Table></ScrollArea>
      </details>) : <Empty text={t("No users match your search")} />}
      {groups.length > pageSize && <Group justify="space-between" p="md" className="pagination-row"><Text size="sm" c="dimmed">{groups.length} {t("users")}</Text><Pagination value={Math.min(page, pages)} onChange={setPage} total={pages} size="sm" /></Group>}
    </Card>
  </>;
}

function Approvals({ data, run, busy, download, saved }: { data: Dashboard; run: (list: ApprovalList, kind: 'approve' | 'reject') => void; busy: boolean; download: (action: Action) => void; saved: () => Promise<void> }) {
  const [page, setPage] = useState(1);
  const lists = approvalLists(data);
  const pages = Math.max(1, Math.ceil(lists.length / 10));
  async function removeItem(list: ApprovalList, action: Action) {
    try { await api(`/api/approval-batches/${list.id}/items/${action.id}`, 'DELETE'); await saved(); }
    catch (cause) { notify(message(cause), true); }
  }
  return <>
    <SectionHeading title={t("Approvals")} />
    <Stack gap="sm">
      {lists.slice((Math.min(page, pages) - 1) * 10, Math.min(page, pages) * 10).map(list => <Card key={`${list.legacy ? 'legacy' : 'batch'}-${list.id}`} withBorder radius="lg" p="lg" className="approval-row">
        <Group justify="space-between" align="start" gap="md">
          <div><Group gap="xs"><Text fw={600}>{t("Approval list #{0}", { 0: list.id })}</Text><Badge color={statusColors[list.status]} variant="light">{t(statusLabels[list.status])}</Badge><Text size="sm" c="dimmed">{t("{0} operations", { 0: list.items.filter(item => item.status !== 'rejected').length })}</Text></Group><Text size="xs" c="dimmed" mt={4}>{formatDate(list.created_at)}</Text></div>
          {list.status === 'pending' && <Group gap="xs"><Button variant="light" color="gray" size="xs" disabled={busy} onClick={() => run(list, 'reject')}>{t("Reject list")}</Button><Button size="xs" disabled={busy} onClick={() => run(list, 'approve')}>{t("Approve list and run")}</Button></Group>}
        </Group>
        <Stack mt="md" gap="xs">{list.items.map(action => <Paper key={action.id} withBorder p="sm" radius="md">
          <Group justify="space-between" gap="sm"><div><Text size="sm" fw={500}>{t(actionLabels[action.action_type])} · {action.target_user}{action.action_type === 'set_sudo' ? ` · ${t(action.payload.sudo ? 'Grant sudo' : 'Revoke sudo')}` : ''}</Text><Text size="xs" c="dimmed">{action.target_server}</Text></div>
            <Group gap="xs"><Badge size="sm" color={statusColors[action.status]} variant="light">{t(statusLabels[action.status])}</Badge>
              {!list.legacy && list.status === 'pending' && action.status === 'pending' && <Button size="compact-xs" variant="subtle" color="gray" disabled={busy} onClick={() => void removeItem(list, action)}>{t("Remove from list")}</Button>}
              {action.private_key_ready && <Button size="xs" leftSection={<IconDownload size={15} />} onClick={() => download(action)}>{t("Download credentials once")}</Button>}
              {action.key_downloaded_at && <Badge color="teal" variant="light">{t("Credentials downloaded")}</Badge>}
            </Group>
          </Group>
          {action.error && <Text size="sm" c="red" mt="xs" style={{ whiteSpace: 'pre-wrap' }}>{t(action.error)}</Text>}
        </Paper>)}</Stack>
      </Card>)}
      {!lists.length && <Paper withBorder radius="lg"><Empty text={t("No requests yet")} /></Paper>}
      {lists.length > 10 && <Pagination value={Math.min(page, pages)} onChange={setPage} total={pages} size="sm" />}
    </Stack>
  </>;
}

function AuditLog({ data }: { data: Dashboard }) {
  return <><SectionHeading title={t("Activity log")} />
    <Card withBorder radius="lg" p={0}><Box p="lg"><Title order={3}>{t("Audit trail")}</Title></Box>
      <ScrollArea><Table striped highlightOnHover miw={700} verticalSpacing="md" horizontalSpacing="lg"><Table.Thead><Table.Tr><Table.Th>{t("Time")}</Table.Th><Table.Th>{t("Administrator")}</Table.Th><Table.Th>{t("Event")}</Table.Th><Table.Th>{t("Target")}</Table.Th>{!data.admin.desktop_mode && <Table.Th>{t("Source")}</Table.Th>}</Table.Tr></Table.Thead><Table.Tbody>
        {data.audit.map(item => <Table.Tr key={item.id}><Table.Td>{formatDate(item.created_at)}</Table.Td><Table.Td>{item.actor || t("System")}</Table.Td><Table.Td><Text fw={700} size="sm">{t(eventLabels[item.event] || 'Other activity')}</Text></Table.Td><Table.Td>{item.target === 'all_servers' ? t("All servers") : item.target?.startsWith('action:') ? t("Request #{0}", { 0: item.target.slice(7) }) : item.target || '—'}</Table.Td>{!data.admin.desktop_mode && <Table.Td>{item.ip_address || '—'}</Table.Td>}</Table.Tr>)}
      </Table.Tbody></Table></ScrollArea>{!data.audit.length && <Empty text={t("No activity yet")} />}</Card>
  </>;
}

function RequestModal({ draft, servers, close, saved }: { draft: RequestDraft | null; servers: Server[]; close: () => void; saved: () => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [sudo, setSudo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setPassword(''); if (draft) { setUsername(''); setFullName(''); setSelected([]); setSudo(false); setError(''); } }, [draft]);
  if (!draft) return null;
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    if (!selected.length) { setError(t("Select at least one host")); return; }
    const button = event.currentTarget.querySelector<HTMLElement>('button[type="submit"]');
    setBusy(true);
    try {
      await api('/api/actions/create-user', 'POST', { username, full_name: fullName, password, servers: selected, sudo });
      if (button) flyToApprovals(button);
      close(); await saved();
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  return <Modal opened onClose={() => !busy && close()} closeOnClickOutside={!busy} closeOnEscape={!busy} title={t("New user")} centered radius="lg">
    <form onSubmit={submit}><Stack gap="md">
      <TextInput label={t("Linux username")} placeholder={t("e.g. alex")} value={username} onChange={e => setUsername(e.currentTarget.value)} pattern="[a-z_][a-z0-9_-]{0,31}" required />
      <TextInput label={t("Name or note (optional)")} value={fullName} onChange={e => setFullName(e.currentTarget.value)} maxLength={100} />
      <PasswordInput label={t("Password (optional)")} description={t("Leave blank to generate a password automatically.")} value={password} onChange={e => setPassword(e.currentTarget.value)} autoComplete="new-password" maxLength={511} />
      <Checkbox.Group label={t("Allowed hosts")} value={selected} onChange={setSelected}><SimpleGrid cols={2} mt="sm">{servers.filter(server => server.enabled).map(server => <Checkbox key={server.id} value={server.name} label={server.name.toUpperCase()} />)}</SimpleGrid></Checkbox.Group>
      <Switch label={t("Grant sudo access")} checked={sudo} onChange={e => setSudo(e.currentTarget.checked)} />
      {error && <Alert color="red" role="alert">{t(error)}</Alert>}
      <Group justify="end"><Button variant="default" disabled={busy} onClick={close}>{t("Cancel")}</Button><Button type="submit" disabled={!selected.length} loading={busy}>{t("Add to approval list")}</Button></Group>
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const desktopLayout = useMediaQuery('(min-width: 48em)');
  const reducedMotion = useReducedMotion();
  const compactSidebar = desktopLayout && sidebarCollapsed;
  const [monitorServerId, setMonitorServerId] = useState<number | null>(null);
  const [request, setRequest] = useState<RequestDraft | null>(null);
  const queueChain = useRef(Promise.resolve());
  const adding = useRef(new Set<string>());
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

  function userRequest(draft: RequestDraft, source?: HTMLElement) {
    if (draft.mode === 'create_user') { setRequest(draft); return; }
    const key = JSON.stringify([draft.mode, draft.username, draft.server, draft.sudo]);
    if (adding.current.has(key)) return;
    adding.current.add(key);
    // Rapid clicks enter one serial queue so the local operation lock cannot
    // discard a second click while the first item is being persisted.
    queueChain.current = queueChain.current.catch(() => {}).then(async () => {
      try {
        await api('/api/actions/user', 'POST', { username: draft.username, servers: [draft.server], action: draft.mode, ...(draft.mode === 'set_sudo' ? { sudo: draft.sudo } : {}) });
        if (source) flyToApprovals(source);
        await refresh();
      } catch (cause) { notify(message(cause), true); }
      finally { adding.current.delete(key); }
    });
  }
  function approvalConfirm(list: ApprovalList, kind: 'approve' | 'reject') {
    const count = list.items.filter(item => item.status === 'pending').length;
    setConfirm({ reject: kind === 'reject', title: t(kind === 'approve' ? "Approve this list?" : "Reject this list?"),
      message: t(kind === 'approve' ? "Approve and execute all {0} operations in this list?" : "Reject all {0} operations in this list?", { 0: count }),
      run: async () => {
        const path = list.legacy ? `/api/actions/${list.id}/${kind}` : `/api/approval-batches/${list.id}/${kind}`;
        const result = await api<{ warning?: string }>(path, 'POST');
        notify(result.warning || (kind === 'approve' ? t("Approval list completed") : t("Approval list rejected")), !!result.warning);
        await refresh();
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
    try { if (!await downloadCredentials(action.id, action.target_user)) return; notify(t("Credentials downloaded. This copy cannot be downloaded again.")); await refresh(); }
    catch (cause) { notify(message(cause), true); await refresh(); }
  }
  if (loading) return <Center h="100vh"><Loader /></Center>;
  if (!data) return <Center h="100vh"><Stack align="center"><Alert color="red">{fatal || t("Could not load the dashboard")}</Alert><Button onClick={() => void refresh()}>{t("Retry")}</Button></Stack></Center>;
  const pending = approvalLists(data).filter(list => list.status === 'pending').length;
  const nav: { id: View; label: string; icon: React.ReactNode }[] = [
    { id: 'dashboard', label: t("Dashboard"), icon: <IconLayoutDashboard size={19} /> },
    { id: 'overview', label: t("Servers"), icon: <IconServer size={19} /> },
    { id: 'operations', label: t('Operations'), icon: <IconServer size={19} /> },
    { id: 'users', label: t("Users & access"), icon: <IconUsers size={19} /> },
    { id: 'approvals', label: t("Approvals"), icon: <IconShieldCheck size={19} /> },
    { id: 'audit', label: t("Activity log"), icon: <IconHistory size={19} /> },
  ];
  function navigate(next: View) {
    setView(next);
    if (next === 'monitor') setMonitorServerId(null);
    setMobileOpened(false);
  }
  const nativeDesktop = isTauri();
  return <AppShell className="app-shell" data-language={language} data-sidebar-collapsed={compactSidebar || undefined} transitionDuration={reducedMotion ? 0 : 280} transitionTimingFunction="cubic-bezier(0.22, 1, 0.36, 1)" navbar={{ width: compactSidebar ? 76 : 232, breakpoint: 'sm', collapsed: { mobile: !mobileOpened } }} header={{ height: nativeDesktop ? 'calc(76px + var(--app-titlebar-height))' : 76 }} padding={0}>
    <AppShell.Header className="topbar" onMouseDown={event => {
      if (!nativeDesktop || event.button !== 0 || (event.target as HTMLElement).closest('button,input,a,select,textarea,[role="button"]')) return;
      if (event.detail === 2) void getCurrentWindow().toggleMaximize();
      else void getCurrentWindow().startDragging();
    }}>
      <WindowControls />
      <div className="topbar-toolbar">
        <div className="topbar-brand" aria-label="Mossentry"><img className="brand-mark" src={brandIcon} width={42} height={42} alt="" /><span className="brand-name" aria-hidden={compactSidebar}><span className="brand-accent">Moss</span>entry</span></div>
        <div className="topbar-content">
          <Burger className="navigation-toggle" opened={mobileOpened} onClick={() => setMobileOpened(value => !value)} hiddenFrom="sm" size="sm" aria-label={t("Toggle navigation")} />
          <Tooltip label={compactSidebar ? t("Expand sidebar") : t("Collapse sidebar")}>
            <ActionIcon className="sidebar-toggle" variant="subtle" color="gray" size="lg" visibleFrom="sm" aria-label={compactSidebar ? t("Expand sidebar") : t("Collapse sidebar")} aria-expanded={!compactSidebar} aria-controls="main-sidebar" onClick={() => setSidebarCollapsed(value => !value)}>
              <IconLayoutSidebarLeftCollapse size={21} stroke={1.5} />
            </ActionIcon>
          </Tooltip>
          <div className="topbar-actions">
            <UpdateButton />
            <AppearanceControls />
          </div>
        </div>
      </div>
    </AppShell.Header>
    <AppShell.Navbar id="main-sidebar" className="sidebar">
      <ScrollArea className="sidebar-scroll" type="never" viewportProps={{ tabIndex: 0, 'aria-label': t("Navigation") }}>
        <span className="nav-section-label" aria-hidden={compactSidebar}>{t("Workspace")}</span>
        <Stack component="nav" aria-label={t("Main navigation")} gap={7}>{nav.map(item => <div key={item.id}>
          {item.id === 'users' && <span className="nav-section-label nav-section-divider" aria-hidden={compactSidebar}>{t("Administration")}</span>}
          {item.id === 'operations' ? <OperationsNav compact={compactSidebar} view={view} navigate={navigate} expandSidebar={() => setSidebarCollapsed(false)} /> : <Tooltip label={item.id === 'approvals' && pending > 0 ? `${item.label} · ${t("{0} requests awaiting approval", { 0: pending })}` : item.label} position="right" disabled={!compactSidebar} events={{ hover: true, focus: true, touch: false }}>
            <button type="button" data-approval-target={item.id === 'approvals' || undefined} aria-label={item.id === 'approvals' && pending > 0 ? `${item.label} · ${t("{0} requests awaiting approval", { 0: pending })}` : item.label} aria-current={view === item.id || (view === 'monitor' && item.id === 'overview') ? 'page' : undefined} className={`nav-button ${view === item.id || (view === 'monitor' && item.id === 'overview') ? 'active' : ''}`} onClick={() => navigate(item.id)}><span className="nav-icon">{item.icon}</span><span className="nav-label" aria-hidden={compactSidebar}>{item.label}</span>{item.id === 'approvals' && pending > 0 && <Badge className="nav-badge" aria-hidden size="sm" color={view === 'approvals' ? 'gray' : 'teal'} variant="light" circle ml="auto">{pending}</Badge>}</button>
          </Tooltip>}
        </div>)}</Stack>
      </ScrollArea>
      <div className="sidebar-footer">
        <Tooltip label={`${fatal ? t("Service needs attention") : t("Mossentry connected")} · ${data.servers.length} ${t("hosts")}`} position="right" disabled={!compactSidebar} events={{ hover: true, focus: true, touch: false }}>
          <div className={`service-status ${fatal ? 'has-error' : ''}`} tabIndex={compactSidebar ? 0 : undefined} aria-label={compactSidebar ? `${fatal ? t("Service needs attention") : t("Mossentry connected")} · ${data.servers.length} ${t("hosts")}` : undefined}><i /><span>{fatal ? t("Service needs attention") : t("Mossentry connected")}</span><span className="service-status-count">{data.servers.length} {t("hosts")}</span></div>
        </Tooltip>
      </div>
    </AppShell.Navbar>
    <AppShell.Main className="main-area"><ScrollArea key={view} className="page-scroll" h="calc(100dvh - var(--app-shell-header-offset, 0px))" viewportProps={{ tabIndex: 0, 'aria-label': t("Page content") }}><main className="content">
      {fatal && <Alert color="red" mb="md" withCloseButton onClose={() => setFatal('')}>{t(fatal)}</Alert>}
      {view === 'dashboard' && <DashboardPage data={data} refresh={refresh} openServers={() => navigate('overview')} openApprovals={() => navigate('approvals')} />}
      {view === 'overview' && <Servers data={data} saved={refresh} monitor={server => { setMonitorServerId(server.id); setView('monitor'); }} />}
      {view === 'monitor' && <ResourceMonitor data={data} serverId={monitorServerId} selectServer={setMonitorServerId} />}
      {view === 'firewall' && <FirewallPage servers={data.servers} saved={refresh} />}
      {view === 'operations' && <Operations servers={data.servers} />}
      {view === 'users' && <Users data={data} openRequest={userRequest} openProfile={(username, fullName) => setProfile({ username, fullName })} />}
      {view === 'approvals' && <Approvals data={data} run={approvalConfirm} busy={busy} saved={refresh} download={action => void download(action)} />}
      {view === 'audit' && <AuditLog data={data} />}
    </main></ScrollArea></AppShell.Main>
    <RequestModal draft={request} servers={data.servers} close={() => setRequest(null)} saved={refresh} />
    <ProfileModal profile={profile} close={() => setProfile(null)} saved={refresh} />
    <Modal opened={!!confirm} onClose={() => !busy && setConfirm(null)} title={confirm?.title} centered radius="lg" closeOnClickOutside={!busy} closeOnEscape={!busy}>
      <Stack><Text size="sm">{confirm?.message}</Text><Group justify="end"><Button variant="default" disabled={busy} onClick={() => setConfirm(null)}>{t("Cancel")}</Button><Button color="blue" loading={busy} onClick={() => void runConfirm()}>{confirm?.reject ? t("Reject") : t("Confirm and run")}</Button></Group></Stack>
    </Modal>
  </AppShell>;
}

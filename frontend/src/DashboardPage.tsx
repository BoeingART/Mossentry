import { useEffect, useId, useRef, useState } from 'react';
import { ActionIcon, Badge, Button, Group, ScrollArea, Select, Table, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { IconArrowUpRight, IconSearch, IconClock, IconCalendar, IconChevronRight, IconRefresh, IconServer, IconShieldCheck, IconUsers, IconUserCheck } from '@tabler/icons-react';
import type { Dashboard } from './types';
import { accessCounts, dateTime, DAY, growthWindow, smoothPath, totalAt } from './dashboardData';

const count = (value: number) => value.toLocaleString('en-US');
const shortDate = (time: number, full = false) => new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', ...(full ? { year: 'numeric' as const } : {}), timeZone: 'UTC',
}).format(time);

function UserNumber({ statistics }: { statistics: Dashboard['statistics'] }) {
  const [range, setRange] = useState('all');
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(750);
  const gradient = useId();
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(Math.max(240, entries[0].contentRect.width)));
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const { history, through } = statistics;
  const { start, end, points } = growthWindow(history, through, range);
  const left = 50, right = width - 14, top = 20, bottom = 224;
  const largest = Math.max(1, points.at(-1)!.total);
  const power = 10 ** Math.floor(Math.log10(Math.max(1, largest / 4)));
  const step = [1, 2, 5, 10].find(n => n * power >= largest / 4)! * power;
  const maximum = Math.ceil(largest / step) * step;
  const x = (time: number) => left + (time - start) / (end - start) * (right - left);
  const y = (total: number) => bottom - total / maximum * (bottom - top);
  const path = smoothPath(points.map(point => ({ x: x(point.time), y: y(point.total) })));
  const hoverTime = hover === null ? null : Math.round((start + hover * (end - start)) / DAY) * DAY;
  const hoverTotal = hoverTime === null ? 0 : totalAt(history, hoverTime);
  const added = hoverTime === null ? 0 : history.find(point => dateTime(point.date) === hoverTime)?.added ?? 0;
  const tickCount = width < 480 ? 2 : 5;
  return <section className="dashboard-panel user-number-panel" aria-labelledby="user-number-title">
    <div className="dashboard-panel-heading"><div><Title order={3} id="user-number-title">User growth</Title><Text className="dashboard-caption">Cumulative unique users</Text></div>
      <Select aria-label="User number time range" value={range} allowDeselect={false} onChange={value => { setRange(value || 'all'); setHover(null); }}
        data={[{ value: 'all', label: 'All time' }, { value: '365', label: 'Last year' }, { value: '90', label: 'Last 90 days' }, { value: '30', label: 'Last 30 days' }]} className="dashboard-range" size="xs" />
    </div>
    <div className="growth-chart" ref={ref}>
      <svg width="100%" height={268} viewBox={`0 0 ${width} 268`} role="img" tabIndex={history.length ? 0 : undefined}
        aria-label={`Cumulative unique users, ${statistics.dated_users} users with known creation dates. Use arrow keys to inspect dates.`}
        onPointerLeave={() => setHover(null)} onBlur={() => setHover(null)} onFocus={() => setHover(1)}
        onKeyDown={event => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) {
            event.preventDefault();
            setHover(value => event.key === 'Escape' ? null : event.key === 'Home' ? 0 : event.key === 'End' ? 1 :
              Math.max(0, Math.min(1, (value ?? 1) + (event.key === 'ArrowRight' ? 1 : -1) / 40)));
          }
        }}
        onPointerMove={event => {
          const box = event.currentTarget.getBoundingClientRect();
          setHover(Math.max(0, Math.min(1, ((event.clientX - box.left) * width / box.width - left) / (right - left))));
        }}>
        <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#4fc3f7" stopOpacity=".36" /><stop offset="100%" stopColor="#e1f5fe" stopOpacity=".03" /></linearGradient></defs>
        {Array.from({ length: maximum / step + 1 }, (_, i) => i * step).map(value => <g key={value}>
          <text x={left - 13} y={y(value) + 4} textAnchor="end" className="chart-axis-label">{Intl.NumberFormat('en-US', { notation: 'compact' }).format(value)}</text>
          <line x1={left} x2={right} y1={y(value)} y2={y(value)} stroke="#f5f6f8" />
        </g>)}
        {Array.from({ length: tickCount + 1 }, (_, index) => <text key={index} x={x(start + (end - start) * index / tickCount)} y={bottom + 29}
          textAnchor={index === 0 ? 'start' : index === tickCount ? 'end' : 'middle'} className="chart-axis-label">{shortDate(start + (end - start) * index / tickCount, end - start > 365 * DAY)}</text>)}
        {history.length > 0 && <>
          <path d={`${path} L ${right} ${bottom} L ${left} ${bottom} Z`} fill={`url(#${gradient})`} />
          <path d={path} fill="none" stroke="#039be5" strokeWidth={2} strokeLinecap="round" />
          {hoverTime !== null && <><line x1={x(hoverTime)} x2={x(hoverTime)} y1={top} y2={bottom} stroke="#cdd6df" strokeDasharray="4 4" />
            <circle cx={x(hoverTime)} cy={y(hoverTotal)} r={4} fill="#039be5" stroke="#fff" strokeWidth={2} /></>}
        </>}
      </svg>
      {!history.length && <div className="growth-empty"><IconUsers size={25} stroke={1.5} /><strong>No creation dates yet</strong><span>Sync your servers to build the user timeline.</span></div>}
      {!!history.length && hoverTime !== null && <div className="growth-tooltip" style={{ left: Math.max(8, Math.min(width - 224, x(hoverTime) + 14)) }} aria-live="polite">
        <strong>{shortDate(hoverTime, true)}</strong><div><span><i className="blue" />Unique users</span><b>{count(hoverTotal)}</b></div><div><span><i className="teal" />New that day</span><b>{count(added)}</b></div>
      </div>}
    </div>
    <div className="growth-footer"><span className="chart-key"><i className="blue" />Unique users</span><span>{count(statistics.dated_users)} dated{statistics.undated_users > 0 ? ` · ${count(statistics.undated_users)} without a known date` : ''}</span></div>
    <p className="dashboard-footnote">The same username on multiple servers counts as one user, from its earliest known creation date.</p>
  </section>;
}

function ServerAccounts({ data }: { data: Dashboard }) {
  const hosts = data.servers.map(server => ({ ...server, count: data.users.filter(user => user.server === server.name).length }));
  const maximum = Math.max(1, ...hosts.map(host => host.count));
  return <section className="dashboard-panel" aria-labelledby="host-accounts-title">
    <div className="dashboard-panel-heading"><div><Title order={3} id="host-accounts-title">Accounts by server</Title><Text className="dashboard-caption">All synced accounts on each host</Text></div><span className="dashboard-small-icon"><IconServer size={19} /></span></div>
    <ScrollArea.Autosize mah={225} viewportProps={{ tabIndex: 0, 'aria-label': 'Accounts by server' }}><div className="dashboard-host-bars">{hosts.map((host, index) => <div className="dashboard-host-bar" key={host.id}>
      <div><span>{host.name}</span><b>{count(host.count)}</b></div>
      <div className="dashboard-bar-track" role="img" aria-label={`${host.name}: ${host.count} accounts${['error', 'failed'].includes(host.last_scan_status || '') ? ', cached data' : ''}`}>
        <span style={{ width: `${host.count / maximum * 100}%`, background: ['#4db6ac', '#4fc3f7', '#4dd0e1'][index % 3] }} />
      </div>
    </div>)}{!hosts.length && <p className="dashboard-no-data">Add a server to see its accounts.</p>}</div></ScrollArea.Autosize>
  </section>;
}

function AccessOverview({ data }: { data: Dashboard }) {
  const { total, sudo, standard } = accessCounts(data.users);
  return <section className="dashboard-panel access-panel" aria-labelledby="access-overview-title">
    <div className="dashboard-panel-heading"><div><Title order={3} id="access-overview-title">Access overview</Title><Text className="dashboard-caption">Permissions across your workspace</Text></div><span className="dashboard-small-icon"><IconShieldCheck size={19} /></span></div>
    <div className="access-gauge">
      <svg viewBox="0 0 200 118" role="img" aria-label={`${sudo} users with sudo access, ${standard} standard users`}>
        <path d="M 13 100 A 87 87 0 0 1 187 100" stroke="#f4f7f7" strokeWidth={7} fill="none" />
        <path d="M 28 100 A 72 72 0 0 1 172 100" stroke={total ? '#80deea' : '#e5ecee'} strokeWidth={17} fill="none" />
        {total > 0 && <path d="M 28 100 A 72 72 0 0 1 172 100" pathLength={100} stroke="#009688" strokeWidth={17} fill="none" strokeDasharray={`${sudo / total * 100} 100`} />}
      </svg>
      <div className="access-gauge-total"><span>Total unique users</span><strong>{count(total)}</strong></div>
    </div>
    <div className="access-gauge-legend"><span><i className="teal" />Sudo access <b>{count(sudo)}</b></span><span><i className="cyan" />Standard <b>{count(standard)}</b></span></div>
    <p className="dashboard-footnote">Sudo on any server counts as sudo access.</p>
  </section>;
}

function RequestActivity({ data, openApprovals }: { data: Dashboard; openApprovals: () => void }) {
  const labels = { create_user: 'Create user', delete_user: 'Delete user', disable_user: 'Disable sign-in', enable_user: 'Enable sign-in', set_sudo: 'Change sudo access' };
  const states = { pending: 'Pending', approved: 'Running', executed: 'Completed', failed: 'Failed', rejected: 'Rejected' };
  return <section className="dashboard-panel" aria-labelledby="request-activity-title">
    <div className="dashboard-panel-heading"><div><Title order={3} id="request-activity-title">Recent requests</Title><Text className="dashboard-caption">User and access changes</Text></div><Tooltip label="View all requests"><ActionIcon variant="default" aria-label="View all requests" onClick={openApprovals}><IconArrowUpRight size={17} /></ActionIcon></Tooltip></div>
    <div className="request-activity-list">{data.actions.slice(0, 4).map(action => <div className="request-activity-row" key={action.id}><span className="request-activity-icon"><IconShieldCheck size={18} stroke={1.5} /></span><div className="request-activity-copy"><strong>{labels[action.action_type]}</strong><span>{action.target_user} · {action.target_server}</span></div><Badge variant="light" color={action.status === 'failed' ? 'red' : action.status === 'pending' ? 'orange' : action.status === 'rejected' ? 'gray' : 'teal'}>{states[action.status]}</Badge></div>)}</div>
    {!data.actions.length && <div className="dashboard-empty-state"><IconShieldCheck size={30} stroke={1.3} /><strong>No requests yet</strong><span>New access requests will appear here.</span></div>}
  </section>;
}

export default function DashboardPage({ data, refresh, openServers, openApprovals }: { data: Dashboard; refresh: () => Promise<void>; openServers: () => void; openApprovals: () => void }) {
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const hosts = data.servers.filter(server => `${server.name} ${server.hostname}`.toLowerCase().includes(search.toLowerCase()));
  const stale = data.servers.some(server => ['error', 'failed'].includes(server.last_scan_status || ''));
  const latest = data.servers.map(server => server.last_scan_at).filter((date): date is string => !!date).sort().at(-1);
  const metrics = [
    { id: 'users', label: 'Unique users', value: data.statistics.total_unique_users, added: data.statistics.new_users_30d, icon: IconUsers,
      description: 'Unique usernames with a known creation date in the past 30 days.' },
    { id: 'accounts', label: 'Accounts', value: data.users.length, added: data.statistics.new_accounts_30d, icon: IconUserCheck,
      description: 'Current host accounts with a known creation date in the past 30 days. Each host account counts separately.' },
    { id: 'servers', label: 'Servers', value: data.servers.length, added: data.statistics.new_servers_30d, icon: IconServer,
      description: 'Server additions recorded by this manager in the past 30 days.' },
    { id: 'approvals', label: 'Pending approvals', value: data.statistics.pending_approvals, added: data.statistics.new_pending_approvals_30d, icon: IconClock,
      description: 'Requests submitted in the past 30 days that are still awaiting approval.' },
  ];
  return <div className="dashboard-page">
    <header className="dashboard-header"><div><Title order={2}>Dashboard</Title><Text>A clear view of your servers, users, and access.</Text></div>
      <div className="dashboard-header-end"><span>{new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date())}</span><span className="dashboard-calendar"><IconCalendar size={18} /></span>
        <Tooltip label="Refresh dashboard"><ActionIcon variant="subtle" color="gray" aria-label="Refresh dashboard" loading={refreshing} onClick={async () => { setRefreshing(true); try { await refresh(); } finally { setRefreshing(false); } }}><IconRefresh size={17} /></ActionIcon></Tooltip>
      </div>
    </header>
    <div className="dashboard-summary">
      {metrics.map(metric => {
        const Tag = metric.id === 'approvals' ? 'button' : 'div';
        const Icon = metric.icon;
        return <Tag key={metric.id} className={`dashboard-stat${metric.id === 'approvals' ? ' dashboard-stat-button' : ''}`}
          onClick={metric.id === 'approvals' ? openApprovals : undefined}>
          <span className="dashboard-stat-icon"><Icon size={23} /></span>
          <div><span className="dashboard-stat-label">{metric.label}</span><div className="dashboard-stat-value"><strong>{count(metric.value)}</strong>
            {metric.added > 0 && <Tooltip label={metric.description}><span className="dashboard-trend"><IconArrowUpRight size={15} />+{count(metric.added)} in 30 days</span></Tooltip>}
          </div></div>
        </Tag>;
      })}
    </div>
    <div className="dashboard-primary-grid"><UserNumber statistics={data.statistics} /><AccessOverview data={data} /></div>
    <div className="dashboard-chart-grid"><ServerAccounts data={data} /><RequestActivity data={data} openApprovals={openApprovals} /></div>
    <section className="dashboard-server-section" aria-labelledby="server-overview-title"><Group justify="space-between"><Group gap="md"><Title order={3} id="server-overview-title">Server overview</Title><span className="dashboard-caption">{latest ? `Last sync ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(latest))}` : 'Ready to sync'}</span></Group><Button variant="subtle" color="gray" size="xs" rightSection={<IconChevronRight size={15} />} onClick={openServers}>View all</Button></Group>
      {stale && <p className="dashboard-cache-note">Some servers could not sync. Their account totals use the last saved data.</p>}
      <div className="server-table-toolbar"><TextInput aria-label="Search server overview" placeholder="Search servers…" leftSection={<IconSearch size={16} />} value={search} onChange={event => setSearch(event.currentTarget.value)} /><span className="dashboard-caption">{hosts.length} servers in your workspace</span></div>
      <ScrollArea><Table className="dashboard-server-table" miw={620} verticalSpacing="md" horizontalSpacing="md" highlightOnHover><Table.Thead><Table.Tr><Table.Th>Server name</Table.Th><Table.Th>SSH port</Table.Th><Table.Th>Management</Table.Th><Table.Th>Sync status</Table.Th><Table.Th ta="right">Accounts</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{hosts.slice(0, 5).map((server, index) => {
        const status = server.last_scan_status === 'ok' ? 'Synced' : ['error', 'failed'].includes(server.last_scan_status || '') ? 'Needs sync' : 'Not synced';
        return <Table.Tr key={server.id}><Table.Td><div className="dashboard-server-identity"><span className={`dashboard-server-avatar tone-${index % 3}`}><IconServer size={19} /></span><div className="dashboard-server-name"><strong>{server.name}</strong><span>{server.hostname}</span></div></div></Table.Td><Table.Td>{server.port}</Table.Td><Table.Td><Badge color={server.enabled ? 'teal' : 'gray'} variant="light">{server.enabled ? 'Enabled' : 'Paused'}</Badge></Table.Td><Table.Td><span className={`dashboard-server-status ${status === 'Synced' ? 'synced' : status === 'Needs sync' ? 'needs-sync' : ''}`}><i />{status}</span></Table.Td><Table.Td ta="right">{server.last_scan_at ? count(data.users.filter(user => user.server === server.name).length) : '—'}</Table.Td></Table.Tr>;
      })}</Table.Tbody></Table></ScrollArea>
      {!hosts.length && <div className="dashboard-no-data">{data.servers.length ? 'No servers match your search.' : <>No servers yet. <button onClick={openServers}>Add your first server</button></>}</div>}
      <div className="dashboard-table-footer"><span>Showing {Math.min(hosts.length, 5)} of {hosts.length} servers</span><Button variant="default" size="xs" rightSection={<IconChevronRight size={14} />} onClick={openServers}>Manage servers</Button></div>
    </section>
  </div>;
}

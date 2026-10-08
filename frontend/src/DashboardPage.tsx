import { useEffect, useId, useRef, useState } from 'react';
import { ActionIcon, Button, Group, ScrollArea, Select, Text, Title, Tooltip } from '@mantine/core';
import { IconArrowUpRight, IconCalendar, IconChevronRight, IconRefresh, IconServer, IconShieldCheck, IconUsers, IconUserCheck } from '@tabler/icons-react';
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
    <div className="dashboard-panel-heading"><div><Title order={3} id="user-number-title">User number</Title><Text className="dashboard-caption">Cumulative unique users</Text></div>
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
        <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#acd3ee" stopOpacity=".36" /><stop offset="100%" stopColor="#eaf5fb" stopOpacity=".03" /></linearGradient></defs>
        {Array.from({ length: maximum / step + 1 }, (_, i) => i * step).map(value => <g key={value}>
          <text x={left - 13} y={y(value) + 4} textAnchor="end" className="chart-axis-label">{Intl.NumberFormat('en-US', { notation: 'compact' }).format(value)}</text>
          <line x1={left} x2={right} y1={y(value)} y2={y(value)} stroke="#f5f6f8" />
        </g>)}
        {Array.from({ length: tickCount + 1 }, (_, index) => <text key={index} x={x(start + (end - start) * index / tickCount)} y={bottom + 29}
          textAnchor={index === 0 ? 'start' : index === tickCount ? 'end' : 'middle'} className="chart-axis-label">{shortDate(start + (end - start) * index / tickCount, end - start > 365 * DAY)}</text>)}
        {history.length > 0 && <>
          <path d={`${path} L ${right} ${bottom} L ${left} ${bottom} Z`} fill={`url(#${gradient})`} />
          <path d={path} fill="none" stroke="#72a9d0" strokeWidth={2} strokeLinecap="round" />
          {hoverTime !== null && <><line x1={x(hoverTime)} x2={x(hoverTime)} y1={top} y2={bottom} stroke="#cdd6df" strokeDasharray="4 4" />
            <circle cx={x(hoverTime)} cy={y(hoverTotal)} r={4} fill="#69a4cf" stroke="#fff" strokeWidth={2} /></>}
        </>}
      </svg>
      {!history.length && <div className="growth-empty"><IconUsers size={25} stroke={1.5} /><strong>No creation dates yet</strong><span>Sync your servers to build the user timeline.</span></div>}
      {!!history.length && hoverTime !== null && <div className="growth-tooltip" style={{ left: Math.max(8, Math.min(width - 224, x(hoverTime) + 14)) }} aria-live="polite">
        <strong>{shortDate(hoverTime, true)}</strong><div><span><i className="blue" />Unique users</span><b>{count(hoverTotal)}</b></div><div><span><i className="orange" />New that day</span><b>{count(added)}</b></div>
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
      <div className="dashboard-bar-track" role="img" aria-label={`${host.name}: ${host.count} accounts${host.last_scan_status === 'error' ? ', cached data' : ''}`}>
        <span style={{ width: `${host.count / maximum * 100}%`, background: ['#b2d7f3', '#f1c797', '#a0d7c5'][index % 3] }} />
      </div>
    </div>)}{!hosts.length && <p className="dashboard-no-data">Add a server to see its accounts.</p>}</div></ScrollArea.Autosize>
  </section>;
}

function AccessOverview({ data }: { data: Dashboard }) {
  const { total, sudo, standard } = accessCounts(data.users);
  const circumference = 2 * Math.PI * 66;
  return <section className="dashboard-panel" aria-labelledby="access-overview-title">
    <div className="dashboard-panel-heading"><div><Title order={3} id="access-overview-title">Access overview</Title><Text className="dashboard-caption">Current unique users</Text></div><span className="dashboard-small-icon"><IconShieldCheck size={19} /></span></div>
    <div className="access-donut-layout"><div className="access-donut">
      <svg viewBox="0 0 160 160" role="img" aria-label={`${sudo} users with sudo access, ${standard} standard users`}>
        <circle cx={80} cy={80} r={66} stroke="#f3f4f6" strokeWidth={14} fill="none" />
        {total > 0 && <g transform="rotate(-90 80 80)"><circle cx={80} cy={80} r={66} stroke="#b2d7f3" strokeWidth={14} fill="none" strokeDasharray={`${sudo / total * circumference} ${circumference}`} />
          <circle cx={80} cy={80} r={66} stroke="#f1c797" strokeWidth={14} fill="none" strokeDasharray={`${standard / total * circumference} ${circumference}`} strokeDashoffset={-sudo / total * circumference} /></g>}
      </svg><div className="access-donut-total"><strong>{count(total)}</strong><span>unique users</span></div>
    </div><div className="access-donut-legend"><div><span><i className="blue" />Sudo access</span><b>{count(sudo)}</b></div><div><span><i className="orange" />Standard</span><b>{count(standard)}</b></div>
      <p>Sudo on any server counts as sudo access.</p></div></div>
  </section>;
}

export default function DashboardPage({ data, refresh, openServers }: { data: Dashboard; refresh: () => Promise<void>; openServers: () => void }) {
  const [refreshing, setRefreshing] = useState(false);
  const enabled = data.servers.filter(server => server.enabled).length;
  const stale = data.servers.some(server => server.last_scan_status === 'error');
  const latest = data.servers.map(server => server.last_scan_at).filter((date): date is string => !!date).sort().at(-1);
  return <div className="dashboard-page">
    <header className="dashboard-header"><div><Title order={2}>Dashboard</Title><Text>Every account. Every server. One overview.</Text></div>
      <div className="dashboard-header-end"><span>{new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date())}</span><span className="dashboard-calendar"><IconCalendar size={18} /></span>
        <Tooltip label="Refresh dashboard"><ActionIcon variant="subtle" color="gray" aria-label="Refresh dashboard" loading={refreshing} onClick={async () => { setRefreshing(true); try { await refresh(); } finally { setRefreshing(false); } }}><IconRefresh size={17} /></ActionIcon></Tooltip>
      </div>
    </header>
    <div className="dashboard-summary">
      <div className="dashboard-stat"><span className="dashboard-stat-icon"><IconUsers size={23} /></span><div><span className="dashboard-stat-label">Unique users</span><div className="dashboard-stat-value"><strong>{count(data.statistics.total_unique_users)}</strong><span className="dashboard-trend"><IconArrowUpRight size={14} />{data.statistics.new_users_30d ? `+${count(data.statistics.new_users_30d)} in 30 days` : 'Unique usernames'}</span></div></div></div>
      <div className="dashboard-stat"><span className="dashboard-stat-icon"><IconServer size={23} /></span><div><span className="dashboard-stat-label">Enabled servers</span><div className="dashboard-stat-value"><strong>{count(enabled)}</strong><span>{data.servers.length} total</span></div></div></div>
      <div className="dashboard-stat"><span className="dashboard-stat-icon"><IconUserCheck size={23} /></span><div><span className="dashboard-stat-label">Account instances</span><div className="dashboard-stat-value"><strong>{count(data.users.length)}</strong><span>Across all servers</span></div></div></div>
    </div>
    <UserNumber statistics={data.statistics} />
    <div className="dashboard-chart-grid"><ServerAccounts data={data} /><AccessOverview data={data} /></div>
    <section className="dashboard-server-section" aria-labelledby="server-overview-title"><Group justify="space-between"><Group gap="md"><Title order={3} id="server-overview-title">Server overview</Title><span className="dashboard-caption">{latest ? `Last sync ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(latest))}` : 'Ready to sync'}</span></Group><Button variant="subtle" color="gray" size="xs" rightSection={<IconChevronRight size={15} />} onClick={openServers}>View all</Button></Group>
      {stale && <p className="dashboard-cache-note">Some servers could not sync. Their account totals use the last saved data.</p>}
      <div className="dashboard-server-list">{data.servers.slice(0, 4).map((server, index) => {
        const status = !server.enabled ? 'Paused' : server.last_scan_status === 'ok' ? 'Synced' : server.last_scan_status === 'error' ? 'Needs sync' : 'Not synced';
        return <div className="dashboard-server-row" key={server.id}><span className={`dashboard-server-avatar tone-${index % 3}`}><IconServer size={19} /></span><div className="dashboard-server-name"><strong>{server.name}</strong><span>{server.hostname}</span></div><span className={`dashboard-server-status ${status === 'Synced' ? 'synced' : status === 'Needs sync' ? 'needs-sync' : ''}`}><i />{status}</span><span className="dashboard-server-count">{count(data.users.filter(user => user.server === server.name).length)} accounts</span></div>;
      })}{!data.servers.length && <div className="dashboard-no-data">No servers yet. <button onClick={openServers}>Add your first server</button></div>}</div>
    </section>
  </div>;
}

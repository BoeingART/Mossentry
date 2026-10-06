import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Group, Loader, MultiSelect, Paper, SegmentedControl, Stack, ThemeIcon, Title } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconActivity, IconArrowLeft, IconArrowRight, IconPlayerPause, IconPlayerPlay, IconServer } from '@tabler/icons-react';
import { api } from './api';
import type { Dashboard, ResourceMetrics, Server } from './types';
import ResourceChart from './ResourceChart';
import NetworkChart from './NetworkChart';
import PhysicalDiskChart from './PhysicalDiskChart';
import { appendSample, cpuPercent, gpuPercent, gpuMemoryPercent, REFRESH_MS, WINDOW_MS } from './monitorData';
import type { GpuDevice, HistorySample } from './monitorData';

const gpuColors = ['#69a4d0', '#edb16f', '#77bfa9', '#9690bd', '#bd889c', '#739b9e', '#b5aa65', '#9a8d82'];

function MonitorSession({ server, knownUsers }: { server: Server; knownUsers: string[] }) {
  const [gpuMetric, setGpuMetric] = useState('utilization');
  const [sample, setSample] = useState<ResourceMetrics | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const [selectedUsers, setSelectedUsers] = useLocalStorage<string[]>({ key: 'resource-monitor-users', defaultValue: [] });
  const [clock, setClock] = useState(Date.now());
  const [history, setHistory] = useState<HistorySample[]>([]);

  useEffect(() => {
    const changed = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', changed);
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => { document.removeEventListener('visibilitychange', changed); window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (paused || !visible) { setBusy(false); return; }
    let stopped = false;
    let running = false;
    let authFailed = false;
    const controller = new AbortController();
    async function poll() {
      // Fixed start-to-start cadence; skip a tick if SSH is still sampling.
      if (stopped || running || authFailed) return;
      running = true;
      setBusy(true);
      try {
        const next = await api<ResourceMetrics>(`/api/servers/${server.id}/metrics`, 'POST', undefined, controller.signal);
        if (stopped) return;
        const receivedAt = Date.now();
        setSample(next); setError(''); setClock(receivedAt);
        setHistory(current => appendSample(current, next, receivedAt));
      } catch (cause) {
        if (stopped) return;
        authFailed = [401, 403, 404].includes((cause as { status?: number }).status ?? 0);
        setError(cause instanceof Error ? cause.message : 'Unable to read server resources.');
        setHistory(current => appendSample(current, null, Date.now()));
      } finally {
        running = false;
        if (!stopped) setBusy(false);
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), REFRESH_MS);
    return () => { stopped = true; controller.abort(); window.clearInterval(timer); };
  }, [server.id, paused, visible]);

  const options = [...new Set([...knownUsers, ...selectedUsers, ...(sample?.cpu.users.map(user => user.username) ?? []),
    ...(sample?.gpu.devices.flatMap(device => device.processes.flatMap(process => process.username === null ? [] : [process.username])) ?? [])])].sort();
  const recent = history.filter(point => point.time >= clock - WINDOW_MS);
  const lastSuccess = [...history].reverse().find(point => point.sample !== null);
  const age = lastSuccess ? Math.max(0, Math.floor((clock - lastSuccess.time) / 1000)) : 0;
  const stale = !!sample && age > 15;
  const status = paused ? 'Paused' : !visible ? 'Hidden · paused' : error ? 'Disconnected' : stale ? 'Stale' : sample ? 'Live' : 'Connecting';
  const filtered = selectedUsers.length > 0;
  const devices = new Map<string, GpuDevice>();
  // Retain lines for recently seen devices even if the latest GPU query failed.
  for (const point of recent) for (const device of point.sample?.gpu.devices ?? []) devices.set(device.uuid, device);
  for (const device of sample?.gpu.devices ?? []) devices.set(device.uuid, device);
  const gpuValue = gpuMetric === 'memory' ? gpuMemoryPercent : gpuPercent;
  const gpuSeries = [...devices.values()].sort((a, b) => a.index - b.index).map((device, index) => ({
    id: device.uuid, label: `GPU ${device.index}`, color: gpuColors[index % gpuColors.length],
    current: gpuValue(sample?.gpu.devices.find(item => item.uuid === device.uuid), selectedUsers),
    points: recent.map(point => ({ time: point.time, value: gpuValue(point.sample?.gpu.devices.find(item => item.uuid === device.uuid), selectedUsers) })),
  }));

  return <Stack gap="lg">
    <Paper className="monitor-toolbar" withBorder p="md" radius="lg"><Group justify="space-between" align="end" gap="md">
      <MultiSelect className="monitor-user-filter" label="CPU / GPU users"
        placeholder={filtered ? 'Add users' : 'All users'} searchable clearable clearButtonProps={{ 'aria-label': 'Show all users', 'aria-hidden': false, tabIndex: 0 }} hidePickedOptions
        data={options} value={selectedUsers} onChange={setSelectedUsers} nothingFoundMessage="No matching users" maxDropdownHeight={190} />
      <Group gap="sm"><Badge color={paused || !visible ? 'gray' : error || stale ? 'orange' : 'teal'} variant="light" leftSection={busy ? <Loader size={10} color="inherit" /> : undefined}>{status}</Badge>
        <Button size="xs" variant="default" leftSection={paused ? <IconPlayerPlay size={14} /> : <IconPlayerPause size={14} />} onClick={() => setPaused(value => !value)}>{paused ? 'Resume monitoring' : 'Pause monitoring'}</Button>
      </Group>
    </Group></Paper>
    {error && <Alert color="orange" title="Sample unavailable" role="alert">{error}</Alert>}
    <div className="monitor-chart-grid">
      <ResourceChart title="CPU" end={clock}
        series={[{ id: 'cpu', label: 'CPU', color: '#69a4d0', current: sample ? cpuPercent(sample, selectedUsers) : null,
          points: recent.map(point => ({ time: point.time, value: point.sample ? cpuPercent(point.sample, selectedUsers) : null })) }]}
        emptyMessage={paused ? 'Paused' : 'No data'} />
      <ResourceChart title="GPU" end={clock} series={gpuSeries}
        control={<SegmentedControl size="xs" aria-label="GPU metric" value={gpuMetric} onChange={setGpuMetric}
          data={[{ label: 'utilization', value: 'utilization' }, { label: 'memory', value: 'memory' }]} />}
        emptyMessage={sample?.gpu.status === 'unavailable' ? 'Unavailable' : paused ? 'Paused' : 'No data'} />
      <ResourceChart title="Memory" end={clock}
        series={[{ id: 'memory', label: 'Memory', color: '#77bfa9', current: sample?.memory.percent ?? null,
          points: recent.map(point => ({ time: point.time, value: point.sample?.memory.percent ?? null })) }]}
        emptyMessage={paused ? 'Paused' : 'No data'} />
      <PhysicalDiskChart disks={sample?.disks ?? []} loading={!sample} />
      <div className="monitor-network"><NetworkChart sample={sample} history={recent} end={clock} paused={paused} /></div>
    </div>
  </Stack>;
}

export default function ResourceMonitor({ data, serverId, selectServer }: { data: Dashboard; serverId: number | null; selectServer: (id: number | null) => void }) {
  if (serverId === null) return <>
    <Title className="page-heading" order={2} mb="lg">Monitor</Title>
    {data.servers.length ? <div className="monitor-host-grid">{data.servers.map(server => <Card className="monitor-host-card" key={server.id} withBorder radius="lg" p="lg">
      <Group justify="space-between" mb="md"><Group gap="sm"><ThemeIcon variant="light" size={40} radius="xl"><IconServer size={20} /></ThemeIcon><Title order={3} size="h4">{server.name}</Title></Group><Badge color={server.enabled ? 'teal' : 'gray'} variant="light">{server.enabled ? 'Enabled' : 'Paused'}</Badge></Group>
      <Button variant="default" leftSection={<IconActivity size={16} />} rightSection={<IconArrowRight size={16} />} disabled={!server.enabled} onClick={() => selectServer(server.id)} aria-label={`Monitor ${server.name}`}>Open monitor</Button>
    </Card>)}</div> : <Alert color="gray">Add a server from the Servers page to start monitoring.</Alert>}
  </>;
  const server = data.servers.find(item => item.id === serverId);
  return <>
    <Button variant="subtle" size="xs" leftSection={<IconArrowLeft size={15} />} mb="md" onClick={() => selectServer(null)}>All monitors</Button>
    <Title className="page-heading" order={2} mb="lg">{server?.name ?? 'Server unavailable'} · Monitor</Title>
    {server?.enabled ? <MonitorSession key={[server.id, server.hostname, server.port, server.ssh_user, server.key_path].join('|')} server={server} knownUsers={data.users.filter(user => user.server === server.name).map(user => user.username)} /> : <Alert color="orange">{server ? 'This server is paused. Enable management from the Servers page to monitor it.' : 'This server is no longer available. Return to the monitor list.'}</Alert>}
  </>;
}

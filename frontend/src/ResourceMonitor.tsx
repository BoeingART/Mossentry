import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Group, Loader, MultiSelect, Paper, Progress, ScrollArea, SimpleGrid, Stack, Table, Text, ThemeIcon, Title } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconActivity, IconArrowLeft, IconArrowRight, IconPlayerPause, IconPlayerPlay, IconServer } from '@tabler/icons-react';
import { api } from './api';
import type { Dashboard, ResourceMetrics, Server } from './types';
import ResourceChart from './ResourceChart';
import { appendSample, cpuPercent, gpuPercent, matchesUser, REFRESH_MS, WINDOW_MS } from './monitorData';
import type { GpuDevice, HistorySample } from './monitorData';

const percent = (value: number | null) => value === null ? 'N/A' : `${value.toFixed(1)}%`;
const memory = (value: number | null) => value === null ? 'N/A' : `${(value / 1024).toFixed(1)} GiB`;
const gpuColors = ['#7950f2', '#e64980', '#0891b2', '#f59f00', '#12b886', '#4263eb', '#ae3ec9', '#d9480f'];

function Meter({ label, value, detail, color = 'teal' }: { label: string; value: number; detail: string; color?: string }) {
  return <div><Group justify="space-between" gap="xs"><Text size="sm" fw={600}>{label}</Text><Text size="sm" fw={700}>{percent(value)}</Text></Group>
    <Progress value={Math.min(100, Math.max(0, value))} color={value >= 90 ? 'orange' : color} mt={9} size={7} aria-label={`${label}: ${percent(value)}`} />
    <Text size="xs" c="dimmed" mt={7}>{detail}</Text>
  </div>;
}

function MonitorSession({ server, knownUsers }: { server: Server; knownUsers: string[] }) {
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

  const matches = (username: string | null) => matchesUser(username, selectedUsers);
  const options = [...new Set([...knownUsers, ...selectedUsers, ...(sample?.cpu.users.map(user => user.username) ?? []),
    ...(sample?.gpu.devices.flatMap(device => device.processes.flatMap(process => process.username === null ? [] : [process.username])) ?? [])])].sort();
  const recent = history.filter(point => point.time >= clock - WINDOW_MS);
  const lastSuccess = [...history].reverse().find(point => point.sample !== null);
  const age = lastSuccess ? Math.max(0, Math.floor((clock - lastSuccess.time) / 1000)) : 0;
  const stale = !!sample && age > 15;
  const status = paused ? 'Paused' : !visible ? 'Hidden · paused' : error ? 'Disconnected' : stale ? 'Stale' : sample ? 'Live' : 'Connecting';
  const filtered = selectedUsers.length > 0;
  const cpuUsers = sample?.cpu.users.filter(user => matches(user.username)) ?? [];
  const devices = new Map<string, GpuDevice>();
  // Retain lines for recently seen devices even if the latest GPU query failed.
  for (const point of recent) for (const device of point.sample?.gpu.devices ?? []) devices.set(device.uuid, device);
  for (const device of sample?.gpu.devices ?? []) devices.set(device.uuid, device);
  const gpuSeries = [...devices.values()].sort((a, b) => a.index - b.index).map((device, index) => ({
    id: device.uuid, label: `GPU ${device.index}`, color: gpuColors[index % gpuColors.length],
    current: gpuPercent(sample?.gpu.devices.find(item => item.uuid === device.uuid), selectedUsers),
    points: recent.map(point => ({ time: point.time, value: gpuPercent(point.sample?.gpu.devices.find(item => item.uuid === device.uuid), selectedUsers) })),
  }));

  return <Stack gap="lg">
    <Paper withBorder p="md" radius="lg"><Group justify="space-between" align="end" gap="md">
      <MultiSelect className="monitor-user-filter" label="CPU / GPU users" description="Empty selection shows all users. Memory and disks show the whole server."
        placeholder={filtered ? 'Add users' : 'All users'} searchable clearable clearButtonProps={{ 'aria-label': 'Show all users', 'aria-hidden': false, tabIndex: 0 }} hidePickedOptions
        data={options} value={selectedUsers} onChange={setSelectedUsers} nothingFoundMessage="No matching users" maxDropdownHeight={190} />
      <Group gap="sm"><Badge color={paused || !visible ? 'gray' : error || stale ? 'orange' : 'teal'} variant="light" leftSection={busy ? <Loader size={10} color="inherit" /> : undefined}>{status}</Badge>
        <Button size="xs" variant="default" leftSection={paused ? <IconPlayerPlay size={14} /> : <IconPlayerPause size={14} />} onClick={() => setPaused(value => !value)}>{paused ? 'Resume monitoring' : 'Pause monitoring'}</Button>
      </Group>
    </Group></Paper>
    {error && <Alert color="orange" title="Sample unavailable" role="alert">{error}{sample && <Text size="xs" mt={4}>Last successful sample: {age}s ago. Missing samples are left blank in the charts.</Text>}</Alert>}
    <div className="monitor-chart-grid">
      <ResourceChart title="CPU utilization" description={sample ? `100% = all ${sample.cpu.cores} logical CPUs${filtered ? ' · selected users' : ' · whole server'}` : 'Whole-server CPU capacity'} end={clock}
        series={[{ id: 'cpu', label: filtered ? 'Selected users' : 'Whole server', color: '#228be6', current: sample ? cpuPercent(sample, selectedUsers) : null,
          points: recent.map(point => ({ time: point.time, value: point.sample ? cpuPercent(point.sample, selectedUsers) : null })) }]}
        emptyMessage={paused ? 'Monitoring paused' : 'Waiting for CPU samples'} />
      <ResourceChart title="GPU utilization" description={filtered ? 'Selected users · per-process SM utilization' : 'Device utilization · one line per GPU'} end={clock} series={gpuSeries}
        emptyMessage={sample?.gpu.status === 'unavailable' ? 'GPU monitoring unavailable' : sample ? 'No GPU utilization samples' : 'Waiting for GPU samples'} />
    </div>
    <Group justify="space-between" gap="xs"><Text size="xs" c="dimmed">{sample ? `Last sample received ${age}s ago${stale ? ' · Out of date' : ''}` : 'Connecting and sampling server resources…'}</Text>
      <Text size="xs" c="dimmed">History builds while this page is open · 5-minute window · 0–100%</Text></Group>
    {sample?.gpu.message && <Alert color={sample.gpu.status === 'error' ? 'orange' : 'gray'}>{sample.gpu.message}</Alert>}
    {filtered && <Text size="xs" c="dimmed">GPU process SM samples may overlap. Curves are capped at 100%; legends show the reported sum. N/A leaves a gap and does not mean idle.</Text>}
    {sample && <>
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <Paper withBorder p="lg" radius="lg"><Text fw={700} mb="md">CPU by user</Text>
          <ScrollArea.Autosize mah={240}><Table><Table.Thead><Table.Tr><Table.Th>User</Table.Th><Table.Th>CPU</Table.Th><Table.Th>Processes</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>{cpuUsers.map(user => <Table.Tr key={user.username}><Table.Td>{user.username}</Table.Td><Table.Td>{percent(user.cpu_percent)}</Table.Td><Table.Td>{user.processes}</Table.Td></Table.Tr>)}</Table.Tbody></Table></ScrollArea.Autosize>
          {!cpuUsers.length && <Text size="sm" c="dimmed" mt="sm">No visible processes for the selected users.</Text>}
        </Paper>
        <Paper withBorder p="lg" radius="lg"><Text fw={700} mb="md">Memory & disks</Text><Stack gap="lg">
          <Meter label="Memory" value={sample.memory.percent} detail={`${memory(sample.memory.used_mb)} / ${memory(sample.memory.total_mb)}`} />
          {sample.disks.map(disk => <div key={disk.mount} className="monitor-disk"><Meter label={disk.mount} value={disk.percent} detail={`${disk.used_gb} / ${disk.total_gb} GiB · ${disk.filesystem}`} color="cyan" /></div>)}
          {!sample.disks.length && <Text size="xs" c="dimmed">No filesystem usage available.</Text>}
        </Stack></Paper>
      </SimpleGrid>
      {sample.gpu.devices.length > 0 && <div><Title order={3} size="h4" mb="md">GPU processes & memory</Title><SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        {sample.gpu.devices.map(device => {
          const processes = device.processes.filter(process => matches(process.username));
          const used = filtered ? (device.process_memory_available && processes.every(process => process.memory_mb !== null) ? processes.reduce((sum, process) => sum + process.memory_mb!, 0) : null) : device.memory_used_mb;
          return <Paper key={device.uuid} withBorder p="lg" radius="lg"><Stack gap="sm">
            <Group justify="space-between"><Text fw={600} size="sm">GPU {device.index} · {device.name}</Text>{device.temperature !== null && <Badge color="gray" variant="light">{device.temperature}°C</Badge>}</Group>
            <Text size="sm">{filtered ? 'Selected compute memory' : 'Device memory'} · {memory(used)} / {memory(device.memory_total_mb)}</Text>
            <ScrollArea.Autosize mah={220}><Table><Table.Thead><Table.Tr><Table.Th>User / PID</Table.Th><Table.Th>SM</Table.Th><Table.Th>Compute memory</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>{processes.map(process => <Table.Tr key={process.pid}><Table.Td>{process.username ?? 'Unknown owner'} · {process.pid}</Table.Td><Table.Td>{percent(process.sm_percent)}</Table.Td><Table.Td>{memory(process.memory_mb)}</Table.Td></Table.Tr>)}</Table.Tbody></Table></ScrollArea.Autosize>
            {!processes.length && <Text size="xs" c="dimmed">No matching GPU processes reported.</Text>}
            {!device.process_memory_available && <Text size="xs" c="orange.8">Per-process compute memory is unavailable.</Text>}
            {!device.process_utilization_available && <Text size="xs" c="dimmed">No process SM samples available; the driver or device may not support them.</Text>}
          </Stack></Paper>;
        })}
      </SimpleGrid></div>}
      {sample.warnings.length > 0 && <details className="monitor-notes"><summary>Sampling notes ({sample.warnings.length})</summary><Stack gap={6} mt="xs">{sample.warnings.map(warning => <Text size="xs" key={warning}>{warning}</Text>)}</Stack></details>}
    </>}
    <Text size="xs" c="dimmed">Read-only SSH · Every 5 seconds while active. Slow requests do not overlap. Leaving this page pauses collection.</Text>
  </Stack>;
}

export default function ResourceMonitor({ data, serverId, selectServer }: { data: Dashboard; serverId: number | null; selectServer: (id: number | null) => void }) {
  if (serverId === null) return <>
    <Group justify="space-between" align="start" mb="lg"><div><Title order={2}>Monitor</Title><Text c="dimmed" size="sm" mt={4}>Choose a server to view CPU, GPU, memory and disk usage.</Text></div><Badge variant="light" size="lg">5s refresh · 5min history</Badge></Group>
    {data.servers.length ? <div className="host-grid">{data.servers.map(server => <Card key={server.id} withBorder radius="lg" p="lg">
      <Group justify="space-between" mb="md"><Group gap="sm"><ThemeIcon variant="light" size={36} radius="md"><IconServer size={20} /></ThemeIcon><Title order={3} size="h4">{server.name}</Title></Group><Badge color={server.enabled ? 'teal' : 'gray'} variant="light">{server.enabled ? 'Enabled' : 'Paused'}</Badge></Group>
      <Text size="sm" c="dimmed" mb="lg">CPU / GPU trends · Memory · Disks</Text>
      <Button variant="light" leftSection={<IconActivity size={16} />} rightSection={<IconArrowRight size={16} />} disabled={!server.enabled} onClick={() => selectServer(server.id)} aria-label={`Monitor ${server.name}`}>Open monitor</Button>
    </Card>)}</div> : <Alert color="gray">Add a server from the Servers page to start monitoring.</Alert>}
  </>;
  const server = data.servers.find(item => item.id === serverId);
  return <>
    <Button variant="subtle" size="xs" leftSection={<IconArrowLeft size={15} />} mb="md" onClick={() => selectServer(null)}>All monitors</Button>
    <Group justify="space-between" align="start" mb="lg"><div><Title order={2}>{server?.name ?? 'Server unavailable'} · Monitor</Title><Text size="sm" c="dimmed" mt={4}>Live resource usage · rolling 5-minute charts</Text></div><Badge variant="light" size="lg">Every 5 seconds</Badge></Group>
    {server?.enabled ? <MonitorSession key={[server.id, server.hostname, server.port, server.ssh_user, server.key_path].join('|')} server={server} knownUsers={data.users.filter(user => user.server === server.name).map(user => user.username)} /> : <Alert color="orange">{server ? 'This server is paused. Enable management from the Servers page to monitor it.' : 'This server is no longer available. Return to the monitor list.'}</Alert>}
  </>;
}

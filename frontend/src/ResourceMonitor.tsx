import { useEffect, useState } from 'react';
import { ActionIcon, Alert, Badge, Button, Divider, Group, Loader, MultiSelect, Paper, Progress, ScrollArea, Select, Stack, Text, Tooltip } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconActivity, IconPlayerPause, IconPlayerPlay, IconRefresh, IconX } from '@tabler/icons-react';
import { api } from './api';
import type { Dashboard, ResourceMetrics, Server } from './types';

const percent = (value: number | null) => value === null ? 'N/A' : `${value.toFixed(1)}%`;
const memory = (value: number | null) => value === null ? 'N/A' : `${(value / 1024).toFixed(1)} GiB`;

function Meter({ label, value, detail, color = 'blue' }: { label: string; value: number | null; detail?: string; color?: string }) {
  return <div><Group justify="space-between" gap="xs"><Text size="sm" fw={600}>{label}</Text><Text size="sm" fw={700} ff="monospace">{percent(value)}</Text></Group>
    <Progress value={Math.min(100, Math.max(0, value ?? 0))} color={value !== null && value >= 90 ? 'orange' : color} mt={7} size={6} aria-label={`${label}: ${percent(value)}`} />
    {detail && <Text size="xs" c="dimmed" mt={5}>{detail}</Text>}
  </div>;
}

function MonitorSession({ server, knownUsers }: { server: Server; knownUsers: string[] }) {
  const [sample, setSample] = useState<ResourceMetrics | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const [interval, setIntervalValue] = useLocalStorage<string>({ key: 'resource-monitor-interval', defaultValue: '5' });
  const [selectedUsers, setSelectedUsers] = useLocalStorage<string[]>({ key: 'resource-monitor-users', defaultValue: [] });
  const [refresh, setRefresh] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const [history, setHistory] = useState<ResourceMetrics[]>([]);
  const delay = ['5', '10', '30'].includes(interval) ? Number(interval) * 1000 : 5000;

  useEffect(() => {
    const changed = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', changed);
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => { document.removeEventListener('visibilitychange', changed); window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (paused || !visible) { setBusy(false); return; }
    let stopped = false;
    let timer: number | undefined;
    let failures = 0;
    const controller = new AbortController();
    async function poll() {
      setBusy(true);
      let authFailed = false;
      try {
        const next = await api<ResourceMetrics>(`/api/servers/${server.id}/metrics`, 'POST', undefined, controller.signal);
        if (stopped) return;
        setSample(next); setError(''); setClock(Date.now()); failures = 0;
        setHistory(current => current.at(-1)?.checked_at === next.checked_at ? current : [...current.slice(-29), next]);
      } catch (cause) {
        if (stopped) return;
        failures += 1;
        authFailed = [401, 403, 404].includes((cause as { status?: number }).status ?? 0);
        setError(cause instanceof Error ? cause.message : 'Unable to read server resources.');
      } finally {
        if (!stopped) {
          setBusy(false);
          if (!authFailed) timer = window.setTimeout(() => void poll(), Math.min(60_000, delay * 2 ** Math.min(failures, 4)));
        }
      }
    }
    void poll();
    return () => { stopped = true; controller.abort(); window.clearTimeout(timer); };
  }, [server.id, delay, paused, visible, refresh]);

  const matches = (username: string | null) => selectedUsers.length === 0 || (username !== null && selectedUsers.includes(username));
  const options = [...new Set([...knownUsers, ...selectedUsers, ...(sample?.cpu.users.map(user => user.username) ?? []),
    ...(sample?.gpu.devices.flatMap(device => device.processes.flatMap(process => process.username === null ? [] : [process.username])) ?? [])])].sort();
  const cpuValue = (item: ResourceMetrics) => selectedUsers.length ? item.cpu.users.filter(user => matches(user.username)).reduce((total, user) => total + user.cpu_percent, 0) : item.cpu.percent;
  const cpuUsers = sample?.cpu.users.filter(user => matches(user.username)) ?? [];
  const age = sample ? Math.max(0, Math.floor((clock - new Date(sample.checked_at).getTime()) / 1000)) : 0;
  const stale = !!sample && age > Math.max(15, delay / 1000 * 3);
  const status = paused ? 'Paused' : !visible ? 'Hidden · paused' : error ? 'Disconnected' : stale ? 'Stale' : sample ? 'Live' : 'Connecting';

  return <Stack gap="md">
    <Group justify="space-between" wrap="nowrap"><Badge color={paused || !visible ? 'gray' : error || stale ? 'orange' : 'teal'} variant="light" leftSection={busy ? <Loader size={10} color="inherit" /> : undefined}>{status}</Badge>
      <Group gap={5} wrap="nowrap"><Select aria-label="Refresh interval" size="xs" w={88} value={String(delay / 1000)} onChange={value => setIntervalValue(value || '5')} allowDeselect={false} data={['5', '10', '30'].map(value => ({ value, label: `${value} sec` }))} />
        <Tooltip label={paused ? 'Resume monitoring' : 'Pause monitoring'}><ActionIcon variant="default" aria-label={paused ? 'Resume monitoring' : 'Pause monitoring'} onClick={() => setPaused(value => !value)}>{paused ? <IconPlayerPlay size={15} /> : <IconPlayerPause size={15} />}</ActionIcon></Tooltip>
        <Tooltip label="Refresh now"><ActionIcon variant="default" aria-label="Refresh resources now" disabled={busy || paused} onClick={() => setRefresh(value => value + 1)}><IconRefresh size={15} /></ActionIcon></Tooltip>
      </Group>
    </Group>
    <MultiSelect label="CPU / GPU users" description="Empty selection shows all users. Memory and disks always show the whole server." placeholder={selectedUsers.length ? "Add users" : "All users"} searchable clearable clearButtonProps={{ "aria-label": "Show all users" }} hidePickedOptions data={options} value={selectedUsers} onChange={setSelectedUsers} nothingFoundMessage="No matching users" maxDropdownHeight={190} />
    {error && <Alert color="orange" title="Sample unavailable" role="alert">{error}{sample && <Text size="xs" mt={4}>Showing the last successful sample.</Text>}</Alert>}
    {!sample && !error && <Text c="dimmed" size="sm" py="md">{paused ? 'Resume to collect a sample.' : 'Connecting and sampling server resources…'}</Text>}
    {sample && <>
      <Text size="xs" c="dimmed">Updated {new Date(sample.checked_at).toLocaleTimeString()} · {age}s ago{stale ? ' · Out of date' : ''}</Text>
      <Paper withBorder p="sm" radius="md"><Stack gap="sm">
        <Meter label={selectedUsers.length ? 'CPU · selected users' : 'CPU · whole server'} value={cpuValue(sample)} detail={`100% = all ${sample.cpu.cores} logical CPUs · 1 second sample`} />
        {history.length > 1 && <svg viewBox="0 0 300 40" width="100%" height="40" role="img" aria-label={`CPU trend, last ${history.length} samples`}><path d="M0 39 H300" stroke="#e9eef5" /><polyline fill="none" stroke="#228be6" strokeWidth="2" strokeLinejoin="round" points={history.map((item, index) => `${index / (history.length - 1) * 300},${39 - Math.min(100, cpuValue(item)) / 100 * 37}`).join(' ')} /></svg>}
        <Divider />
        <ScrollArea.Autosize mah={160} type="auto"><Stack gap={7}>{cpuUsers.map(user => <Group key={user.username} justify="space-between" gap="xs" wrap="nowrap"><Text size="xs" truncate title={user.username}>{user.username}</Text><Text size="xs" ff="monospace" style={{ whiteSpace: 'nowrap' }}>{percent(user.cpu_percent)} · {user.processes} proc</Text></Group>)}
          {!cpuUsers.length && <Text size="xs" c="dimmed">No visible processes for the selected users.</Text>}
        </Stack></ScrollArea.Autosize>
      </Stack></Paper>
      <div><Text size="xs" fw={700} c="dimmed" mb="xs">GPU</Text>
        {sample.gpu.message && <Alert color={sample.gpu.status === 'error' ? 'orange' : 'gray'}>{sample.gpu.message}</Alert>}
        <Stack gap="xs">{sample.gpu.devices.map(device => {
          const processes = device.processes.filter(process => matches(process.username));
          const filtered = selectedUsers.length > 0;
          const gpuPercent = filtered ? (processes.length && processes.every(p => p.sm_percent !== null) ? processes.reduce((sum, p) => sum + p.sm_percent!, 0) : null) : device.percent;
          const gpuMemory = filtered ? (device.process_memory_available && processes.every(p => p.memory_mb !== null) ? processes.reduce((sum, p) => sum + p.memory_mb!, 0) : null) : device.memory_used_mb;
          return <Paper key={device.uuid} withBorder radius="md" p="sm"><Stack gap="sm">
            <Group justify="space-between" gap="xs"><Text fw={600} size="xs">GPU {device.index} · {device.name}</Text>{device.temperature !== null && <Text c="dimmed" size="xs">{device.temperature}°C</Text>}</Group>
            <Meter label={filtered ? 'Selected process SM · sum' : 'Device utilization'} value={gpuPercent} color="violet" />
            <Text size="xs">{filtered ? 'Selected compute memory' : 'Device memory'} · {memory(gpuMemory)} / {memory(device.memory_total_mb)}</Text>
            {filtered && <Text size="xs" c="dimmed">Process SM samples are approximate and may overlap. N/A means unavailable, not idle.</Text>}
            <ScrollArea.Autosize mah={170} type="auto"><Stack gap={6}>{processes.map(process => <div key={process.pid}><Group justify="space-between" gap="xs"><Text size="xs">{process.username ?? 'Unknown owner'} · {process.pid}</Text><Text size="xs">SM {percent(process.sm_percent)}</Text></Group><Text size="xs" c="dimmed">Compute memory {memory(process.memory_mb)}</Text></div>)}
              {!processes.length && <Text size="xs" c="dimmed">No matching GPU processes reported.</Text>}
            </Stack></ScrollArea.Autosize>
            {!device.process_memory_available && <Text size="xs" c="orange.8">Per-process compute memory is unavailable.</Text>}
            {!device.process_utilization_available && <Text size="xs" c="dimmed">No process SM samples available; the driver or device may not support them.</Text>}
          </Stack></Paper>;
        })}</Stack>
      </div>
      <Paper withBorder p="sm" radius="md"><Meter label="Memory · whole server" value={sample.memory.percent} detail={`${memory(sample.memory.used_mb)} / ${memory(sample.memory.total_mb)}`} color="teal" /></Paper>
      <div><Text size="xs" fw={700} c="dimmed" mb="xs">DISKS · WHOLE SERVER</Text><Stack gap="xs">{sample.disks.map(disk => <Paper key={disk.mount} withBorder p="sm" radius="md" className="monitor-disk"><Meter label={disk.mount} value={disk.percent} detail={`${disk.used_gb} / ${disk.total_gb} GiB · ${disk.filesystem}`} color="cyan" /></Paper>)}
        {!sample.disks.length && <Text size="xs" c="dimmed">No filesystem usage available.</Text>}
      </Stack></div>
      {sample.warnings.length > 0 && <details className="monitor-notes"><summary>Sampling notes ({sample.warnings.length})</summary><Stack gap={6} mt="xs">{sample.warnings.map(warning => <Text size="xs" key={warning}>{warning}</Text>)}</Stack></details>}
    </>}
    <Text size="xs" c="dimmed">Read-only SSH · Refreshes {delay / 1000}s after each sample. Closing this panel pauses monitoring.</Text>
  </Stack>;
}

export default function ResourceMonitor({ data, serverId, selectServer, close }: { data: Dashboard; serverId: number | null; selectServer: (id: number | null) => void; close: () => void }) {
  const enabled = data.servers.filter(server => server.enabled);
  const server = enabled.find(item => item.id === serverId) ?? enabled[0];
  return <>
    <Group justify="space-between" p="md" className="monitor-heading"><Group gap="xs"><IconActivity size={18} /><Text fw={700} size="sm">Live resources</Text></Group><ActionIcon variant="subtle" color="gray" onClick={close} aria-label="Close resource monitor"><IconX size={18} /></ActionIcon></Group>
    <ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto"><Stack p="md" gap="md">
      <Select label="Server" placeholder="No enabled servers" value={server ? String(server.id) : null} onChange={value => selectServer(value ? Number(value) : null)} data={enabled.map(item => ({ value: String(item.id), label: item.name }))} searchable allowDeselect={false} disabled={!enabled.length} />
      {server ? <MonitorSession key={[server.id, server.hostname, server.port, server.ssh_user, server.key_path].join('|')} server={server} knownUsers={data.users.filter(user => user.server === server.name).map(user => user.username)} /> : <Alert color="gray">Add or enable a server to start monitoring.</Alert>}
      <Button variant="subtle" size="xs" onClick={close}>Close monitor</Button>
    </Stack></ScrollArea>
  </>;
}

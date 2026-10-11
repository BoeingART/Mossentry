import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Checkbox, Group, Loader, Modal, MultiSelect, NumberInput, Pagination, ScrollArea, Select, SimpleGrid, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { api } from './api';
import { t } from './i18n';
import { numericDate } from './dateFormat';
import { saveJson } from './InventoryTransfer';
import type { Server } from './types';

type Kind = 'inspect' | 'services' | 'logs' | 'start' | 'stop' | 'restart' | 'enable' | 'disable';
type Summary = { id: number; operation: Kind; status: string; created_at: string; finished_at: string | null };
type Service = { unit: string; enabled: string; active: string; sub: string; description: string; protected: boolean };
type ProbeResult = {
  checked_at: string; available?: boolean; warnings?: string[]; services?: Service[];
  hostname?: string; os?: string; kernel?: string; architecture?: string; cores?: number;
  uptime_seconds?: number | null; load?: number[]; memory_percent?: number | null; swap_percent?: number | null;
  filesystems?: { mount: string; type: string; percent: number | null; inode_percent: number | null; available_gb: number }[];
  failed_services?: string[] | null;
  alerts?: { kind: string; target: string; value: number | null }[];
  entries?: { timestamp: string; unit: string; priority: string; message: string }[];
  scope?: string; limit?: number; unit?: string; operation?: string; state?: Record<string, string>;
};
type Job = Summary & { payload: { unit: string }; results: { server_name: string; status: string; error: string | null; result: ProbeResult | null }[] };
const labels: Record<Kind, string> = { inspect: 'Health inspection', services: 'List services', logs: 'Query logs', start: 'Start service', stop: 'Stop service', restart: 'Restart service', enable: 'Enable at boot', disable: 'Disable at boot' };
const changes = new Set<Kind>(['start', 'stop', 'restart', 'enable', 'disable']);
const statusLabels: Record<string, string> = { running: 'Running', queued: 'Queued', completed: 'Completed', failed: 'Failed', partial: 'Partially completed', interrupted: 'Interrupted' };
const color = (status: string) => status === 'completed' ? 'teal' : status === 'failed' || status === 'interrupted' ? 'red' : 'blue';
const date = (value: string) => numericDate(value, { includeTime: true });
const percent = (value: number | null | undefined) => value == null ? t('N/A') : `${value}%`;
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : t('Operation failed');

function Result({ value, select }: { value: ProbeResult; select: (unit: string, action: Kind) => void }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const serviceRows = (value.services || []).filter(s => `${s.unit} ${s.active} ${s.description}`.toLowerCase().includes(search.toLowerCase()));
  const pages = Math.max(1, Math.ceil(serviceRows.length / 15));
  return <Stack gap="sm">
    <Text size="xs" c="dimmed">{t('Checked')} {date(value.checked_at)}</Text>
    {value.available === false && <Alert color="orange">{t('This capability is unavailable on this host. No software was installed.')}</Alert>}
    {(value.warnings || []).map((warning, i) => <Alert key={i} color="orange">{t(warning)}</Alert>)}
    {value.os && <>
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <div><Text fw={600}>{value.os}</Text><Text size="sm">{value.hostname} · {value.architecture}</Text><Text size="xs" c="dimmed">{value.kernel}</Text></div>
        <div><Text size="sm">{t('Memory')}: {percent(value.memory_percent)}</Text><Text size="sm">{t('Swap')}: {percent(value.swap_percent)}</Text><Text size="sm">{t('CPU cores')}: {value.cores}</Text></div>
        <div><Text size="sm">{t('Load · 1 / 5 / 15 min')}: {value.load?.map(v => v.toFixed(2)).join(' / ')}</Text><Text size="sm">{t('Uptime')}: {value.uptime_seconds == null ? t('N/A') : `${Math.floor(value.uptime_seconds / 3600)} ${t('hours')}`}</Text></div>
      </SimpleGrid>
      {(value.alerts || []).map((alert, i) => <Alert key={i} color="orange">{t(({ memory: 'Memory usage is at least 90%', load: 'Five-minute load exceeds CPU capacity', disk: 'Filesystem usage is at least 90%', inode: 'Inode usage is at least 90%', service: 'Failed service' } as Record<string, string>)[alert.kind] || alert.kind)} · {alert.target} {alert.value == null ? '' : alert.value}</Alert>)}
      {!value.alerts?.length && <Text c="teal" size="sm">{t('No threshold alerts in the available metrics')}</Text>}
      {value.failed_services === null && <Text size="sm" c="dimmed">{t('Failed service information is unavailable.')}</Text>}
      <ScrollArea><Table miw={560}><Table.Thead><Table.Tr>{['Filesystem', 'Type', 'Disk usage', 'Inode usage', 'Available GiB'].map(label => <Table.Th key={label}>{t(label)}</Table.Th>)}</Table.Tr></Table.Thead><Table.Tbody>{value.filesystems?.map(disk => <Table.Tr key={disk.mount}><Table.Td>{disk.mount}</Table.Td><Table.Td>{disk.type}</Table.Td><Table.Td>{percent(disk.percent)}</Table.Td><Table.Td>{percent(disk.inode_percent)}</Table.Td><Table.Td>{disk.available_gb}</Table.Td></Table.Tr>)}</Table.Tbody></Table></ScrollArea>
    </>}
    {value.services && value.available !== false && <>
      <TextInput label={t('Search services')} value={search} onChange={e => { setSearch(e.currentTarget.value); setPage(1); }} />
      <ScrollArea><Table miw={750} verticalSpacing="sm"><Table.Thead><Table.Tr>{['Service', 'State', 'Boot policy', 'Actions'].map(label => <Table.Th key={label}>{t(label)}</Table.Th>)}</Table.Tr></Table.Thead><Table.Tbody>
        {serviceRows.slice((Math.min(page, pages) - 1) * 15, Math.min(page, pages) * 15).map(service => <Table.Tr key={service.unit}>
          <Table.Td><Text size="sm" fw={600}>{service.unit}</Text><Text size="xs" c="dimmed">{service.description}</Text></Table.Td>
          <Table.Td><Badge color={service.active === 'failed' ? 'red' : service.active === 'active' ? 'teal' : 'gray'}>{service.active}</Badge><Text size="xs">{service.sub}</Text></Table.Td><Table.Td>{service.enabled}</Table.Td>
          <Table.Td><Group gap="xs"><Button size="compact-xs" variant="light" onClick={() => select(service.unit, 'logs')}>{t('Logs')}</Button>{service.protected ? <Text size="xs" c="dimmed">{t('Protected service')}</Text> : <><Button size="compact-xs" variant="light" onClick={() => select(service.unit, service.active === 'active' ? 'restart' : 'start')}>{t(service.active === 'active' ? 'Restart service' : 'Start service')}</Button><Button size="compact-xs" variant="default" onClick={() => select(service.unit, 'stop')}>{t('Stop service')}</Button></>}</Group></Table.Td>
        </Table.Tr>)}
      </Table.Tbody></Table></ScrollArea>
      {!serviceRows.length && <Text size="sm" c="dimmed">{t('No matching services')}</Text>}
      {pages > 1 && <Pagination total={pages} value={Math.min(page, pages)} onChange={setPage} />}
    </>}
    {value.entries && value.available !== false && <>
      <Text size="sm" c="dimmed">{t(value.scope === 'system' ? 'System journal' : 'Only logs accessible to the SSH account are shown')}. {t('Up to {0} entries; each message is limited to 8192 characters.', { 0: value.limit })}</Text>
      <TextInput label={t('Search returned logs')} value={search} onChange={e => setSearch(e.currentTarget.value)} />
      <ScrollArea h={360}><Stack gap="xs">{value.entries.filter(entry => `${entry.message} ${entry.unit}`.toLowerCase().includes(search.toLowerCase())).map((entry, i) => <Card key={i} withBorder p="sm"><Text size="xs" c="dimmed">{Number(entry.timestamp) > 0 ? date(new Date(Number(entry.timestamp) / 1000).toISOString()) : '—'} · {entry.unit} · {t('Priority')} {entry.priority}</Text><Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{entry.message}</Text></Card>)}{!value.entries.length && <Text size="sm">{t('No accessible entries match this query')}</Text>}</Stack></ScrollArea>
    </>}
    {value.state && <Group>{Object.entries(value.state).map(([key, val]) => <Badge variant="light" key={key}>{key}: {val}</Badge>)}</Group>}
  </Stack>;
}

export default function Operations({ servers }: { servers: Server[] }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [group, setGroup] = useState<string | null>(null);
  const [operation, setOperation] = useState<Kind>('inspect');
  const [unit, setUnit] = useState('');
  const [minutes, setMinutes] = useState<number | string>(60);
  const [lines, setLines] = useState<number | string>(100);
  const [priority, setPriority] = useState<string | null>('6');
  const [elevated, setElevated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<{ jobs: Summary[]; total: number }>({ jobs: [], total: 0 });
  const [page, setPage] = useState(1);
  const [jobId, setJobId] = useState<number | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [remove, setRemove] = useState(false);
  const [revision, setRevision] = useState(0);
  const mutation = changes.has(operation);
  const running = history.jobs.some(j => j.status === 'running') || job?.status === 'running';
  const eligible = servers.filter(s => s.enabled);
  const visible = eligible.filter(s => !group || s.group_name === group);
  // Poll durable jobs independently of the form. In-flight fetches are aborted
  // on navigation, and stale responses cannot replace a newly selected job.
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let detailStatus: string | undefined;
    async function refresh() {
      try {
        const next = await api<{ jobs: Summary[]; total: number }>(`/api/operations?offset=${(page - 1) * 25}`, 'GET', undefined, abort.signal);
        if (abort.signal.aborted) return;
        setHistory(next);
        if (jobId !== null && (!detailStatus || detailStatus === 'running')) {
          const detail = await api<Job>(`/api/operations/${jobId}`, 'GET', undefined, abort.signal);
          if (!abort.signal.aborted) { setJob(detail); detailStatus = detail.status; }
        }
      } catch (cause) { if (!abort.signal.aborted) setError(errorMessage(cause)); }
      if (!abort.signal.aborted) timer = setTimeout(() => void refresh(), 3000);
    }
    void refresh();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [page, jobId, revision]);
  async function start() {
    setBusy(true); setError('');
    try {
      const result = await api<{ id: number }>('/api/operations', 'POST', { servers: selected, operation, unit: operation === 'inspect' || operation === 'services' ? '' : unit,
        minutes: Number(minutes), lines: Number(lines), priority: Number(priority), elevated: operation === 'logs' && elevated, confirmation });
      setJob(null); setJobId(result.id); setConfirm(false); setConfirmation(''); setPage(1); setRevision(v => v + 1);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function deleteJob() {
    if (!job) return;
    setBusy(true); setError('');
    try { await api(`/api/operations/${job.id}`, 'DELETE'); setJob(null); setJobId(null); setRemove(false); setPage(1); setRevision(v => v + 1); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  function choose(service: string, action: Kind, server: string) {
    setSelected([server]); setUnit(service); setOperation(action); setConfirmation('');
    document.getElementById('operation-form')?.scrollIntoView({ behavior: 'smooth' });
  }
  return <Stack gap="lg">
    <div><Title order={2}>{t('Operations')}</Title><Text size="sm" c="dimmed">{t('Inspect hosts, manage existing services and query logs over SSH. Nothing is installed on your servers.')}</Text></div>
    {error && <Alert color="red" withCloseButton onClose={() => setError('')}>{t(error)}</Alert>}
    <Card id="operation-form" withBorder radius="lg" p="lg"><Stack>
      <Group align="end"><Select label={t('Server group')} placeholder={t('All groups')} clearable searchable value={group} onChange={setGroup} data={[...new Set(eligible.map(s => s.group_name).filter(Boolean))].sort()} /><Button variant="light" onClick={() => setSelected(visible.slice(0, 50).map(s => s.name))}>{t('Select group hosts')}</Button><Text size="xs" c="dimmed">{t('Up to 50 servers per task')}</Text></Group>
      <MultiSelect label={t('Target servers')} searchable clearable value={selected} onChange={setSelected} data={eligible.map(s => ({ value: s.name, label: `${s.name}${s.group_name ? ` · ${s.group_name}` : ''}` }))} maxValues={50} />
      <Select label={t('Operation')} value={operation} allowDeselect={false} onChange={value => { setOperation(value as Kind); setConfirmation(''); }} data={Object.entries(labels).map(([value, label]) => ({ value, label: t(label) }))} />
      {(mutation || operation === 'logs') && <TextInput label={t('Service name')} description={t(operation === 'logs' ? 'Leave blank to query all accessible logs' : 'Use an exact existing .service name. SSH and critical network services are protected.')} value={unit} maxLength={200} onChange={e => setUnit(e.currentTarget.value)} placeholder="nginx.service" />}
      {operation === 'logs' && <><Group grow><NumberInput label={t('Last minutes')} min={1} max={10080} allowDecimal={false} value={minutes} onChange={setMinutes} /><NumberInput label={t('Maximum entries')} min={1} max={1000} allowDecimal={false} value={lines} onChange={setLines} /><Select label={t('Maximum priority')} value={priority} allowDeselect={false} onChange={setPriority} data={[{ value: '3', label: t('Errors and above') }, { value: '4', label: t('Warnings and above') }, { value: '6', label: t('Information and above') }, { value: '7', label: t('All priorities') }]} /></Group><Checkbox label={t('Use sudo to read the system journal')} checked={elevated} onChange={e => setElevated(e.currentTarget.checked)} /><Text size="xs" c="dimmed">{t('Log results are stored locally in task history. Delete the task to remove its saved results.')}</Text></>}
      {mutation && <Text size="sm" c="dimmed">{t(operation === 'enable' || operation === 'disable' ? 'Boot policy changes do not start or stop the service now.' : 'Service changes may interrupt workloads. Review the selected hosts before running.')}</Text>}
      <Group justify="end">{running && <Text size="sm">{t('A server task is running')}</Text>}<Button loading={busy} disabled={running || !selected.length || (mutation && !unit)} onClick={() => mutation ? (setConfirm(true), setConfirmation('')) : void start()}>{t(mutation ? 'Review operation' : 'Run task')}</Button></Group>
    </Stack></Card>
    {jobId !== null && !job && <Loader size="sm" />}
    {job && <Card withBorder radius="lg" p="lg"><Stack><Group justify="space-between"><Group><Title order={3}>#{job.id} {t(labels[job.operation])}</Title><Badge color={color(job.status)}>{t(statusLabels[job.status] || job.status)}</Badge></Group><Group><Button size="xs" variant="default" onClick={() => saveJson(job, `mossentry-task-${job.id}.json`)}>{t('Export results')}</Button><Button size="xs" variant="light" color="red" disabled={job.status === 'running' || running || busy} onClick={() => setRemove(true)}>{t('Delete saved task')}</Button></Group></Group>
      <Text size="xs" c="dimmed">{date(job.created_at)} {job.payload.unit && `· ${job.payload.unit}`}</Text>
      {changes.has(job.operation) && ['failed', 'partial', 'interrupted'].includes(job.status) && <Alert color="orange">{t('Remote changes may have taken effect even when a task fails. Inspect the service before retrying.')}</Alert>}
      {job.results.map(result => <Card key={result.server_name} withBorder radius="md"><Stack><Group justify="space-between"><Text fw={600}>{result.server_name}</Text><Badge color={color(result.status)}>{t(statusLabels[result.status] || result.status)}</Badge></Group>{result.error && <Alert color="red">{t(result.error)}</Alert>}{result.result && <Result value={result.result} select={(unit, action) => choose(unit, action, result.server_name)} />}</Stack></Card>)}
    </Stack></Card>}
    <Card withBorder radius="lg" p="lg"><Stack><Title order={3}>{t('Task history')}</Title><ScrollArea><Table miw={560} highlightOnHover><Table.Thead><Table.Tr>{['Task', 'State', 'Time', 'Actions'].map(label => <Table.Th key={label}>{t(label)}</Table.Th>)}</Table.Tr></Table.Thead><Table.Tbody>{history.jobs.map(item => <Table.Tr key={item.id}><Table.Td>#{item.id} {t(labels[item.operation])}</Table.Td><Table.Td><Badge color={color(item.status)}>{t(statusLabels[item.status] || item.status)}</Badge></Table.Td><Table.Td>{date(item.created_at)}</Table.Td><Table.Td><Button size="compact-xs" variant="light" onClick={() => { setJob(null); setJobId(item.id); setRevision(v => v + 1); }}>{t('View results')}</Button></Table.Td></Table.Tr>)}</Table.Tbody></Table></ScrollArea>{!history.jobs.length && <Text size="sm" c="dimmed">{t('No tasks yet')}</Text>}{history.total > 25 && <Pagination total={Math.ceil(history.total / 25)} value={page} onChange={setPage} />}</Stack></Card>
    <Modal opened={confirm} onClose={() => !busy && setConfirm(false)} title={t('Review operation')} centered><Stack><Text>{t(labels[operation])} · {unit}</Text><Text size="sm" style={{ overflowWrap: 'anywhere' }}>{t('Target servers')}: {selected.join(', ')}</Text><Text size="sm">{t('This changes the selected servers immediately. Failed or interrupted tasks are never retried automatically.')}</Text><TextInput label={t('Type {0} to confirm', { 0: `${operation} ${unit}` })} value={confirmation} onChange={e => setConfirmation(e.currentTarget.value)} />{error && <Alert color="red">{t(error)}</Alert>}<Button color="orange" loading={busy} disabled={confirmation !== `${operation} ${unit}`} onClick={() => void start()}>{t('Confirm and run')}</Button></Stack></Modal>
    <Modal opened={remove} onClose={() => !busy && setRemove(false)} title={t('Delete saved task')} centered><Stack><Text>{t('Remove this task and its saved results from local history? The audit trail is kept.')}</Text><Button color="red" loading={busy} onClick={() => void deleteJob()}>{t('Delete')}</Button></Stack></Modal>
  </Stack>;
}

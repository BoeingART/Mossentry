import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Checkbox, Code, Group, Loader, Modal, MultiSelect, NumberInput, Pagination, ScrollArea, Stack, Table, Text, Textarea, Title } from '@mantine/core';
import { IconAlertTriangle, IconPlayerPlay, IconTerminal2, IconTestPipe } from '@tabler/icons-react';
import { api } from './api';
import { t } from './i18n';
import { numericDate } from './dateFormat';
import { saveJson } from './InventoryTransfer';
import LegacyOperationResult, { type ProbeResult } from './LegacyOperationResult';
import type { Server } from './types';

type Summary = { id: number; operation: string; status: string; created_at: string; finished_at: string | null };
type CommandResult = ProbeResult & { syntax_ok?: boolean; dry_run?: boolean; stdout?: string; stderr?: string; exit_code?: number; timed_out?: boolean; truncated?: boolean; risk_warnings?: string[] };
type Job = Summary & { payload: { unit?: string; command?: string; elevated?: boolean; timeout?: number }; results: { server_name: string; status: string; error: string | null; result: CommandResult | null }[] };
const labels: Record<string, string> = { command: 'Run command', dry_run: 'Dry run', inspect: 'Health inspection', services: 'List services', logs: 'Query logs', start: 'Start service', stop: 'Stop service', restart: 'Restart service', enable: 'Enable at boot', disable: 'Disable at boot' };
const statusLabels: Record<string, string> = { running: 'Running', queued: 'Queued', completed: 'Completed', failed: 'Failed', partial: 'Partially completed', interrupted: 'Interrupted' };
const color = (status: string) => status === 'completed' ? 'teal' : status === 'failed' || status === 'interrupted' ? 'red' : 'blue';
const date = (value: string) => numericDate(value, { includeTime: true });
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : t('Operation failed');

function Warnings({ warnings }: { warnings: string[] }) {
  return warnings.length > 0 && <Alert color="orange" icon={<IconAlertTriangle size={18} />} title={t('Command warnings')}><Stack gap={4}>{warnings.map(warning => <Text key={warning} size="sm">{t(warning)}</Text>)}</Stack></Alert>;
}

function Output({ value }: { value: CommandResult }) {
  if (value.syntax_ok === undefined) return <LegacyOperationResult value={value} />;
  return <Stack gap="sm">
    {value.dry_run && <Text size="sm" c={value.syntax_ok ? 'teal' : 'red'}>{t(value.syntax_ok ? 'Bash syntax check passed. No commands were executed.' : 'Bash syntax check failed. No commands were executed.')}</Text>}
    {value.exit_code !== undefined && <Text size="xs" c="dimmed">{t('Exit code')}: {value.exit_code}</Text>}
    {value.timed_out && <Alert color="orange">{t('Command timed out. Changes may already have taken effect; check the server before retrying.')}</Alert>}
    {value.truncated && <Text size="xs" c="orange">{t('Output was truncated to 256 KiB per stream.')}</Text>}
    {value.stdout && <div><Text size="xs" c="dimmed">stdout</Text><Code block className="operation-output">{value.stdout}</Code></div>}
    {value.stderr && <div><Text size="xs" c="dimmed">stderr</Text><Code block className="operation-output">{value.stderr}</Code></div>}
    {!value.dry_run && !value.stdout && !value.stderr && <Text size="sm" c="dimmed">{t('No output')}</Text>}
  </Stack>;
}

export default function Operations({ servers }: { servers: Server[] }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [command, setCommand] = useState('');
  const [timeout, setTimeout] = useState<number | string>(300);
  const [elevated, setElevated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<{ jobs: Summary[]; total: number }>({ jobs: [], total: 0 });
  const [page, setPage] = useState(1);
  const [jobId, setJobId] = useState<number | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [checkId, setCheckId] = useState<number | null>(null);
  const [checked, setChecked] = useState<Job | null>(null);
  const [submittedId, setSubmittedId] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [remove, setRemove] = useState(false);
  const [revision, setRevision] = useState(0);
  const eligible = servers.filter(s => s.enabled);
  const targetKey = JSON.stringify(selected.map(name => {
    const s = servers.find(server => server.name === name);
    return [name, s?.hostname, s?.port, s?.ssh_user, s?.key_path, s?.enabled];
  }).sort());
  const running = submittedId !== null || history.jobs.some(j => j.status === 'running') || job?.status === 'running' || checked?.status === 'running';
  const warnings = [...new Set(checked?.results.flatMap(item => item.result?.risk_warnings || []) || [])];
  const passed = checked?.status === 'completed' && checked.results.length === selected.length && checked.results.every(item => item.result?.syntax_ok && item.status === 'completed');
  const valid = selected.length > 0 && selected.every(name => eligible.some(s => s.name === name)) && command.trim().length > 0 && Number(timeout) >= 10 && Number(timeout) <= 3600;

  // A check belongs to the exact form and connection settings that produced it.
  useEffect(() => {
    setCheckId(null); setChecked(null); setAcknowledged(false); setConfirm(false);
  }, [command, elevated, timeout, targetKey]);

  useEffect(() => {
    const abort = new AbortController();
    let timer: number;
    const finished = new Set<number>();
    async function refresh() {
      try {
        const next = await api<{ jobs: Summary[]; total: number }>(`/api/operations?offset=${(page - 1) * 25}`, 'GET', undefined, abort.signal);
        if (abort.signal.aborted) return;
        setHistory(next);
        for (const id of new Set([jobId, checkId, submittedId].filter((id): id is number => id !== null))) {
          if (finished.has(id)) continue;
          const detail = await api<Job>(`/api/operations/${id}`, 'GET', undefined, abort.signal);
          if (abort.signal.aborted) return;
          if (detail.status !== 'running') finished.add(id);
          if (id === jobId) setJob(detail);
          if (id === checkId) setChecked(detail);
          if (id === submittedId && detail.status !== 'running') setSubmittedId(null);
        }
      } catch (cause) { if (!abort.signal.aborted) setError(errorMessage(cause)); }
      if (!abort.signal.aborted) timer = window.setTimeout(() => void refresh(), 3000);
    }
    void refresh();
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [page, jobId, checkId, submittedId, revision]);

  async function start(operation: 'dry_run' | 'command') {
    setBusy(true); setError('');
    if (operation === 'dry_run') { setCheckId(null); setChecked(null); setAcknowledged(false); }
    try {
      const result = await api<{ id: number }>('/api/operations', 'POST', { servers: selected, operation, command, timeout: Number(timeout), elevated, dry_run_id: operation === 'command' ? checkId : null, risk_acknowledged: acknowledged });
      setSubmittedId(result.id);
      if (operation === 'dry_run') setCheckId(result.id);
      setJob(null); setJobId(result.id); setConfirm(false); setPage(1); setRevision(v => v + 1);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function deleteJob() {
    if (!job) return;
    setBusy(true); setError('');
    try {
      await api(`/api/operations/${job.id}`, 'DELETE');
      if (checkId === job.id) { setCheckId(null); setChecked(null); setAcknowledged(false); }
      setJob(null); setJobId(null); setRemove(false); setPage(1); setRevision(v => v + 1);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <Stack gap="lg">
    <div><Title order={2}>{t('Operations')}</Title><Text size="sm" c="dimmed">{t('Check and run Linux commands on selected servers over SSH.')}</Text></div>
    {error && <Alert color="red" withCloseButton onClose={() => setError('')}>{t(error)}</Alert>}
    <Card withBorder radius="lg" p="lg"><Stack gap="md">
      <Group align="end" wrap="nowrap" className="operation-targets">
        <MultiSelect label={t('Target servers')} placeholder={t('Choose servers')} searchable clearable value={selected} onChange={setSelected} data={eligible.map(s => ({ value: s.name, label: s.name }))} disabled={busy || running} style={{ flex: 1, minWidth: 0 }} />
        <Button variant="light" disabled={busy || running || !eligible.length} onClick={() => setSelected(eligible.map(s => s.name))}>{t('Select all servers')}</Button>
      </Group>
      <Text size="xs" c="dimmed">{t('{0} of {1} enabled servers selected', { 0: selected.length, 1: eligible.length })} · {t('Paused servers are excluded.')}</Text>
      <Textarea label={t('Operation')} description={t('Enter one or more Bash commands. Commands run non-interactively; use non-interactive options when needed.')} placeholder={'apt update\napt install -y htop'} autosize minRows={5} maxRows={16} value={command} onChange={e => setCommand(e.currentTarget.value)} maxLength={32768} disabled={busy || running} spellCheck={false} className="operation-command" />
      <Group justify="space-between" align="end">
        <Checkbox label={t('Run with sudo')} checked={elevated} onChange={e => setElevated(e.currentTarget.checked)} disabled={busy || running} />
        <NumberInput label={t('Timeout per server (seconds)')} min={10} max={3600} allowDecimal={false} value={timeout} onChange={setTimeout} disabled={busy || running} w={220} />
      </Group>
      <Text size="xs" c="dimmed">{t('Commands and output are saved in local task history. Do not include passwords or secrets.')}</Text>
    </Stack></Card>
    <Card withBorder radius="lg" p="lg"><Stack gap="md">
      <Group justify="space-between"><Group gap="xs"><IconTestPipe size={20} /><Title order={3}>{t('Dry run')}</Title></Group><Button variant="light" leftSection={<IconTestPipe size={16} />} loading={busy || checked?.status === 'running' || (submittedId === checkId && checkId !== null)} disabled={!valid || running} onClick={() => void start('dry_run')}>{t('Check syntax and risks')}</Button></Group>
      <Text size="sm" c="dimmed">{t('Dry run uses bash -n on each target without executing the commands. It checks shell syntax, not command options, installed programs, permissions or execution results.')}</Text>
      {!checked && <Text size="sm" c="dimmed">{t('Run Dry run before execution. Changing the command, targets or options requires a new check.')}</Text>}
      {checked && <>
        <Group><Badge color={color(checked.status)}>{t(passed ? 'Syntax check passed' : statusLabels[checked.status] || checked.status)}</Badge><Text size="xs" c="dimmed">{checked.results.filter(r => r.status === 'completed').length} / {checked.results.length} {t('servers passed')}</Text></Group>
        <Warnings warnings={warnings} />
        {passed && <Text size="sm" c="dimmed">{t('Risk detection is heuristic. A passing check does not guarantee safety.')}</Text>}
      </>}
      <Group justify="end">{running && <Text size="sm">{t('A server task is running')}</Text>}<Button leftSection={<IconPlayerPlay size={16} />} disabled={busy || running || !valid || !passed} onClick={() => { setAcknowledged(false); setConfirm(true); }}>{t('Review and run')}</Button></Group>
    </Stack></Card>
    {jobId !== null && !job && <Loader size="sm" />}
    {job && <Card withBorder radius="lg" p="lg"><Stack>
      <Group justify="space-between"><Group><IconTerminal2 size={20} /><Title order={3}>#{job.id} {t(labels[job.operation] || job.operation)}</Title><Badge color={color(job.status)}>{t(statusLabels[job.status] || job.status)}</Badge></Group><Group><Button size="xs" variant="default" onClick={() => saveJson(job, `mossentry-task-${job.id}.json`)}>{t('Export results')}</Button><Button size="xs" variant="light" color="red" disabled={running || busy} onClick={() => setRemove(true)}>{t('Delete saved task')}</Button></Group></Group>
      <Text size="xs" c="dimmed">{date(job.created_at)} {job.payload.unit && `· ${job.payload.unit}`} {job.payload.elevated && '· sudo'}</Text>
      {job.payload.command && <Code block className="operation-output">{job.payload.command}</Code>}
      {!['dry_run', 'inspect', 'services', 'logs'].includes(job.operation) && ['failed', 'partial', 'interrupted'].includes(job.status) && <Alert color="orange">{t('Remote changes may have taken effect. Check the server before retrying; tasks are never retried automatically.')}</Alert>}
      <Warnings warnings={[...new Set(job.results.flatMap(item => item.result?.risk_warnings || []))]} />
      {job.results.map(result => <Card key={result.server_name} withBorder radius="md"><Stack><Group justify="space-between"><Text fw={600}>{result.server_name}</Text><Badge color={color(result.status)}>{t(statusLabels[result.status] || result.status)}</Badge></Group>{result.error && <Alert color="red">{t(result.error)}</Alert>}{result.result && <Output value={result.result} />}</Stack></Card>)}
    </Stack></Card>}
    <Card withBorder radius="lg" p="lg"><Stack><Title order={3}>{t('Task history')}</Title><ScrollArea><Table miw={560} highlightOnHover><Table.Thead><Table.Tr>{['Task', 'State', 'Time', 'Actions'].map(label => <Table.Th key={label}>{t(label)}</Table.Th>)}</Table.Tr></Table.Thead><Table.Tbody>{history.jobs.map(item => <Table.Tr key={item.id}><Table.Td>#{item.id} {t(labels[item.operation] || item.operation)}</Table.Td><Table.Td><Badge color={color(item.status)}>{t(statusLabels[item.status] || item.status)}</Badge></Table.Td><Table.Td>{date(item.created_at)}</Table.Td><Table.Td><Button size="compact-xs" variant="light" onClick={() => { setJob(null); setJobId(item.id); setRevision(v => v + 1); }}>{t('View results')}</Button></Table.Td></Table.Tr>)}</Table.Tbody></Table></ScrollArea>{!history.jobs.length && <Text size="sm" c="dimmed">{t('No tasks yet')}</Text>}{history.total > 25 && <Pagination total={Math.ceil(history.total / 25)} value={page} onChange={setPage} />}</Stack></Card>
    <Modal opened={confirm} onClose={() => !busy && setConfirm(false)} title={t('Review and run')} centered size="lg"><Stack>
      <Code block className="operation-output">{command}</Code>
      <Text size="sm">{t('Target servers')}: {selected.join(', ')}</Text>
      <Text size="sm">{t(elevated ? 'Run with sudo' : 'Run as the SSH login account')} · {Number(timeout)} {t('seconds per server')}</Text>
      <Text size="sm">{t('This changes the selected servers immediately. Failed or interrupted tasks are never retried automatically.')}</Text>
      <Warnings warnings={warnings} />
      {warnings.length > 0 && <Checkbox label={t('I understand these risks and want to execute this command.')} checked={acknowledged} onChange={e => setAcknowledged(e.currentTarget.checked)} />}
      {error && <Alert color="red">{t(error)}</Alert>}
      <Button color={warnings.length ? 'orange' : 'teal'} loading={busy} disabled={running || !valid || !passed || (warnings.length > 0 && !acknowledged)} onClick={() => void start('command')}>{t('Confirm and run')}</Button>
    </Stack></Modal>
    <Modal opened={remove} onClose={() => !busy && setRemove(false)} title={t('Delete saved task')} centered><Stack><Text>{t('Remove this task and its saved results from local history? The audit trail is kept.')}</Text><Button color="red" loading={busy} onClick={() => void deleteJob()}>{t('Delete')}</Button></Stack></Modal>
  </Stack>;
}

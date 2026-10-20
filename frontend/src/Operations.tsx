import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Checkbox, Code, Combobox, Group, Loader, Modal, MultiSelect, NumberInput, Pagination, ScrollArea, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconChevronRight, IconClock, IconExclamationMark, IconPlayerPlay, IconTerminal2, IconTestPipe, IconX } from '@tabler/icons-react';
import { api } from './api';
import { t } from './i18n';
import { numericDate } from './dateFormat';
import { saveJson } from './InventoryTransfer';
import LegacyOperationResult, { type ProbeResult } from './LegacyOperationResult';
import BashEditor from './BashEditor';
import type { Server } from './types';

type Summary = { id: number; operation: string; status: string; created_at: string; finished_at: string | null };
type OutputDiagnostic = { code: string; summary: string; stream: 'stdout' | 'stderr'; count: number; matches: { line: number; text: string; truncated: boolean }[] };
type CommandResult = ProbeResult & { syntax_ok?: boolean; dry_run?: boolean; stdout?: string; stderr?: string; exit_code?: number; timed_out?: boolean; truncated?: boolean; risk_warnings?: string[]; output_diagnostics?: OutputDiagnostic[] };
type Job = Summary & { payload: { unit?: string; command?: string; elevated?: boolean; timeout?: number }; results: { server_name: string; status: string; error: string | null; result: CommandResult | null }[] };
const labels: Record<string, string> = { command: 'Run command', dry_run: 'Check syntax and risks', inspect: 'Health inspection', services: 'List services', logs: 'Query logs', start: 'Start service', stop: 'Stop service', restart: 'Restart service', enable: 'Enable at boot', disable: 'Disable at boot' };
const statusLabels: Record<string, string> = { running: 'Running', queued: 'Queued', completed: 'Completed', completed_with_warnings: 'Completed with warnings', failed: 'Failed', partial: 'Partially completed', interrupted: 'Interrupted' };
const color = (status: string) => status === 'completed_with_warnings' ? 'yellow' : status === 'completed' ? 'teal' : status === 'failed' || status === 'interrupted' ? 'red' : 'blue';
const date = (value: string) => numericDate(value, { includeTime: true });
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : t('Operation failed');

function Warnings({ warnings }: { warnings: string[] }) {
  return warnings.length > 0 && <Alert color="orange" icon={<IconAlertTriangle size={18} />} title={t('Command warnings')}><Stack gap={4}>{warnings.map(warning => <Text key={warning} size="sm">{t(warning)}</Text>)}</Stack></Alert>;
}

function OutputDiagnostics({ diagnostics }: { diagnostics: OutputDiagnostic[] }) {
  return diagnostics.length > 0 && <Alert color="yellow" icon={<IconAlertTriangle size={18} />} title={t('Output diagnostics')}>
    <Stack gap="sm">
      <Text size="xs">{t('Log matches are hints for review; the original exit code is unchanged.')}</Text>
      {diagnostics.map(item => <Stack key={`${item.stream}-${item.code}`} gap={4}>
        <Text size="sm" fw={500}>{t(item.summary)}</Text>
        {item.matches.map(match => <div key={match.line}>
          <Text size="xs" c="dimmed">{item.stream} · {t('Line {0}', { 0: match.line })}</Text>
          <Code block className="operation-output">{match.text}</Code>
          {match.truncated && <Text size="xs">{t('Log excerpt truncated; see the captured output below.')}</Text>}
        </div>)}
        {item.count > item.matches.length && <Text size="xs">{t('Showing {0} of {1} matching lines; see the captured output below.', { 0: item.matches.length, 1: item.count })}</Text>}
      </Stack>)}
    </Stack>
  </Alert>;
}

function Output({ value }: { value: CommandResult }) {
  if (value.syntax_ok === undefined) return <LegacyOperationResult value={value} />;
  return <Stack gap="sm">
    {value.dry_run && <Text size="sm" c={value.syntax_ok ? 'teal' : 'red'}>{t(value.syntax_ok ? 'Bash syntax check passed. No commands were executed.' : 'Bash syntax check failed. No commands were executed.')}</Text>}
    {value.timed_out && <Alert color="orange">{t('Command timed out. Changes may already have taken effect; check the server before retrying.')}</Alert>}
    {value.truncated && <Text size="xs" c="orange">{t('Output was truncated to 256 KiB per stream.')}</Text>}
    <OutputDiagnostics diagnostics={value.output_diagnostics || []} />
    {value.stdout && <div><Text size="xs" c="dimmed">stdout</Text><Code block className="operation-output">{value.stdout}</Code></div>}
    {value.stderr && <div><Text size="xs" c="dimmed">stderr</Text><Code block className="operation-output">{value.stderr}</Code></div>}
    {!value.stdout && !value.stderr && <Text size="sm" c="dimmed">{t('No output')}</Text>}
  </Stack>;
}

function ServerResult({ result }: { result: Job['results'][number] }) {
  const pending = result.status === 'running' || result.status === 'queued';
  const success = !pending && result.status === 'completed'
    && !result.result?.timed_out && (result.result?.exit_code ?? 0) === 0;
  const warning = result.status === 'completed_with_warnings'
    && !result.result?.timed_out && (result.result?.exit_code ?? 0) === 0;
  const status = t(statusLabels[result.status] || result.status);
  return <details className="operation-server-result">
    <summary>
      <IconChevronRight className="details-chevron" size={17} aria-hidden="true" />
      <Text fw={500} component="span" className="operation-server-name">{result.server_name}</Text>
      {warning && <Badge color="yellow" variant="light">{status}</Badge>}
      <Text size="xs" c="dimmed" component="span">{result.result?.exit_code === undefined ? status : `${t('Exit code')}: ${result.result.exit_code}`}</Text>
      <span className={`server-connection ${pending ? 'unknown' : warning ? 'warning' : success ? 'connected' : 'failed'}`}
        role="img" aria-label={`${result.server_name}: ${status}`}>
        {result.status === 'running' ? <Loader size={13} /> : pending ? <IconClock size={15} aria-hidden="true" /> : warning ? <IconExclamationMark size={17} aria-hidden="true" /> : success ? <IconCheck size={17} aria-hidden="true" /> : <IconX size={17} aria-hidden="true" />}
      </span>
    </summary>
    <Stack gap="sm" className="operation-server-output">
      {result.error && <Alert color="red">{t(result.error)}</Alert>}
      {result.result && <Output value={result.result} />}
      {!result.result && !result.error && <Text size="sm" c="dimmed">{pending ? status : t('No output')}</Text>}
    </Stack>
  </details>;
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
  const [review, setReview] = useState<{ key: string; warnings: string[] } | null>(null);
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
  const running = submittedId !== null || history.jobs.some(j => j.status === 'running') || job?.status === 'running';
  const formKey = JSON.stringify([command, elevated, timeout, targetKey]);
  const warnings = review?.key === formKey ? review.warnings : [];
  const valid = selected.length > 0 && selected.every(name => eligible.some(s => s.name === name)) && command.trim().length > 0 && Number(timeout) >= 10 && Number(timeout) <= 3600;

  // A risk acknowledgement only applies to the form shown in the review.
  useEffect(() => {
    setReview(null); setAcknowledged(false); setConfirm(false);
  }, [formKey]);

  useEffect(() => {
    const abort = new AbortController();
    let timer: number;
    const finished = new Set<number>();
    async function refresh() {
      try {
        const next = await api<{ jobs: Summary[]; total: number }>(`/api/operations?offset=${(page - 1) * 25}`, 'GET', undefined, abort.signal);
        if (abort.signal.aborted) return;
        setHistory(next);
        for (const id of new Set([jobId, submittedId].filter((id): id is number => id !== null))) {
          if (finished.has(id)) continue;
          const detail = await api<Job>(`/api/operations/${id}`, 'GET', undefined, abort.signal);
          if (abort.signal.aborted) return;
          if (detail.status !== 'running') finished.add(id);
          if (id === jobId) setJob(detail);
          if (id === submittedId && detail.status !== 'running') setSubmittedId(null);
        }
      } catch (cause) { if (!abort.signal.aborted) setError(errorMessage(cause)); }
      if (!abort.signal.aborted) timer = window.setTimeout(() => void refresh(), 3000);
    }
    void refresh();
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [page, jobId, submittedId, revision]);

  async function reviewCommand() {
    setBusy(true); setError(''); setAcknowledged(false);
    try {
      const result = await api<{ warnings: string[] }>('/api/operations/review', 'POST', { servers: selected, operation: 'command', command, timeout: Number(timeout), elevated });
      setReview({ key: formKey, warnings: result.warnings }); setConfirm(true);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function start(operation: 'dry_run' | 'command') {
    setBusy(true); setError('');
    try {
      const result = await api<{ id: number }>('/api/operations', 'POST', { servers: selected, operation, command, timeout: Number(timeout), elevated, risk_acknowledged: acknowledged });
      setSubmittedId(result.id);
      setJob(null); setJobId(result.id); setConfirm(false); setPage(1); setRevision(v => v + 1);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function deleteJob() {
    if (!job) return;
    setBusy(true); setError('');
    try {
      await api(`/api/operations/${job.id}`, 'DELETE');
      setJob(null); setJobId(null); setRemove(false); setPage(1); setRevision(v => v + 1);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <Stack gap="lg">
    <div><Title order={2}>{t('Operations')}</Title><Text size="sm" c="dimmed">{t('Check and run Linux commands on selected servers over SSH.')}</Text></div>
    {error && <Alert color="red" withCloseButton onClose={() => setError('')}>{t(error)}</Alert>}
    <Card withBorder radius="lg" p="lg"><Stack gap="md">
      <Group align="end" wrap="nowrap" className="operation-targets">
        <MultiSelect label={t('Target servers')} placeholder={t('Choose servers')} searchable clearable value={selected} onChange={setSelected} data={eligible.map(s => ({ value: s.name, label: s.name }))} disabled={busy || running} style={{ flex: 1, minWidth: 0 }}
          rightSectionWidth={selected.length ? 126 : 96} rightSection={<Group gap={5} wrap="nowrap" className="operation-target-count"><Combobox.Chevron /><Text size="xs" component="span" aria-label={t('{0} of {1} enabled servers selected', { 0: selected.length, 1: eligible.length })}>{selected.length} / {eligible.length}</Text></Group>} />
        <Button variant="light" disabled={busy || running || !eligible.length} onClick={() => setSelected(eligible.map(s => s.name))}>{t('Select all servers')}</Button>
      </Group>
      <BashEditor label={t('Operation')} hint={t('Enter one or more Bash commands. Commands run non-interactively; use non-interactive options when needed.')} value={command} onChange={setCommand} disabled={busy || running} />
      <Group justify="start" gap="lg" className="operation-options">
        <Group gap="xs" wrap="nowrap">
          <label htmlFor="operation-timeout" className="operation-timeout-label">{t('Server timeout (s)')}</label>
          <NumberInput id="operation-timeout" min={10} max={3600} allowDecimal={false} value={timeout} onChange={setTimeout} disabled={busy || running} w={100} />
        </Group>
        <Checkbox label={t('Run with sudo')} checked={elevated} onChange={e => setElevated(e.currentTarget.checked)} disabled={busy || running} />
      </Group>
      <Group justify="start">
        <Tooltip label={t('Check syntax using bash -n')} withArrow events={{ hover: true, focus: true, touch: true }}>
          <span className="operation-check-action"><Button variant="light" leftSection={<IconTestPipe size={16} />} disabled={busy || !valid || running} onClick={() => void start('dry_run')}>{t('Check syntax and risks')}</Button></span>
        </Tooltip>
        <Button leftSection={<IconPlayerPlay size={16} />} loading={busy} disabled={running || !valid} onClick={() => void reviewCommand()}>{t('Run command')}</Button>
        {running && <Text size="sm" c="dimmed">{t('A server task is running')}</Text>}
      </Group>
    </Stack></Card>
    {jobId !== null && !job && <Loader size="sm" />}
    {job && <Card withBorder radius="lg" p="lg"><Stack>
      <Group justify="space-between"><Group gap="sm"><IconTerminal2 size={20} /><Title order={3}>#{job.id} {t(labels[job.operation] || job.operation)}</Title><Text size="xs" c="dimmed">{date(job.created_at)}</Text><Badge color={color(job.status)}>{t(statusLabels[job.status] || job.status)}</Badge>{job.payload.elevated && <Badge variant="light">sudo</Badge>}</Group><Group><Button size="xs" variant="default" onClick={() => saveJson(job, `mossentry-task-${job.id}.json`)}>{t('Export results')}</Button><Button size="xs" variant="light" color="red" disabled={running || busy} onClick={() => setRemove(true)}>{t('Delete saved task')}</Button></Group></Group>
      {job.payload.unit && <Text size="sm">{job.payload.unit}</Text>}
      {job.payload.command && <Code block className="operation-output">{job.payload.command}</Code>}
      {!['dry_run', 'inspect', 'services', 'logs'].includes(job.operation) && ['failed', 'partial', 'interrupted'].includes(job.status) && <Alert color="orange">{t('Remote changes may have taken effect. Check the server before retrying; tasks are never retried automatically.')}</Alert>}
      <Warnings warnings={[...new Set(job.results.flatMap(item => item.result?.risk_warnings || []))]} />
      <div className="operation-server-list">{job.results.map(result => <ServerResult key={`${job.id}-${result.server_name}`} result={result} />)}</div>
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
      <Button color={warnings.length ? 'orange' : 'teal'} loading={busy} disabled={running || !valid || review?.key !== formKey || (warnings.length > 0 && !acknowledged)} onClick={() => void start('command')}>{t('Confirm and run')}</Button>
    </Stack></Modal>
    <Modal opened={remove} onClose={() => !busy && setRemove(false)} title={t('Delete saved task')} centered><Stack><Text>{t('Remove this task and its saved results from local history? The audit trail is kept.')}</Text><Button color="red" loading={busy} onClick={() => void deleteJob()}>{t('Delete')}</Button></Stack></Modal>
  </Stack>;
}

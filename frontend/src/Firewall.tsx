import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Code, Group, Modal, NumberInput, Paper, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { api } from './api';
import { t } from './i18n';
import type { FirewallStatus, Server } from './types';

const message = (error: unknown) => error instanceof Error ? error.message : t('Please retry the operation');
const sshBlocked = 'SSH access is not explicitly allowed. Add an inbound TCP allow rule for the SSH port and management IP before enabling the firewall.';
type Pending = { operation: 'enable' | 'disable' } | { operation: 'delete'; rule_id: number; revision: string; description: string };

export default function Firewall({ server, close, saved }: { server: Server; close: () => void; saved: () => Promise<void> }) {
  const [status, setStatus] = useState<FirewallStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [port, setPort] = useState<string | number>(server.port);
  const [protocol, setProtocol] = useState<string | null>('tcp');
  const [action, setAction] = useState<string | null>('allow');
  const [scope, setScope] = useState<string | null>('any');
  const [source, setSource] = useState('');
  const endpoint = `/api/servers/${server.id}/firewall`;
  const initialRequest = useRef<{ endpoint: string; promise: Promise<FirewallStatus> } | null>(null);
  useEffect(() => {
    let active = true;
    // Reuse the request during StrictMode effect replay; the server operation holds a lock.
    if (initialRequest.current?.endpoint !== endpoint) initialRequest.current = { endpoint, promise: api<FirewallStatus>(endpoint, 'POST', { operation: 'status' }) };
    initialRequest.current.promise.then(value => {
      if (active) { setStatus(value); if (value.available && value.ssh_port) setPort(value.ssh_port); }
    }).catch(cause => { if (active) setError(message(cause)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [endpoint]);
  async function operate(body: Record<string, unknown>) {
    setBusy(true); setError(''); setNotice(''); setPending(null);
    // Stale data must never leave the enable button available after a failed operation.
    setStatus(null);
    try {
      setStatus(await api<FirewallStatus>(endpoint, 'POST', body));
      if (body.operation !== 'status') setNotice(t('Firewall settings updated.'));
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); void saved().catch(() => {}); }
  }
  return <Modal opened onClose={() => !busy && close()} closeOnClickOutside={!busy} closeOnEscape={!busy} title={t('{0} · Firewall', { 0: server.name })} centered size="lg">
    <Stack>
      <Text size="sm" c="dimmed">{t('Manage inbound UFW rules. Changes take effect immediately when the firewall is enabled.')}</Text>
      {error && <Alert color="red" role="alert">{t(error)}</Alert>}
      {notice && <Alert color="teal" role="status">{notice}</Alert>}
      {status?.available === false && <Alert color="yellow">{t('UFW is not installed on this server.')}</Alert>}
      {status?.available && <>
        <Group justify="space-between"><Badge color={status.enabled ? 'teal' : 'gray'}>{status.enabled ? t('Firewall enabled') : t('Firewall disabled')}</Badge><Button color={status.enabled ? 'orange' : 'blue'} disabled={busy || (!status.enabled && !status.ssh_allowed)} onClick={() => setPending({ operation: status.enabled ? 'disable' : 'enable' })}>{status.enabled ? t('Disable firewall') : t('Enable firewall')}</Button></Group>
        <Text size="sm">{t('SSH port: {0} · Management IP: {1}', { 0: status.ssh_port ?? t('Unknown'), 1: status.management_ip ?? t('Unknown') })}</Text>
        {!status.enabled && !status.ssh_allowed && <Alert color="yellow">{t(sshBlocked)}</Alert>}
        {!status.enabled && status.ssh_allowed && <Alert color="teal">{t('A saved inbound rule allows this SSH connection. Rules will be checked again before enabling.')}</Alert>}
        <div><Title order={4} size="sm" mb="xs">{t('Saved firewall rules')}</Title><Stack gap="xs">
          {status.rules.length ? status.rules.map(rule => <Paper withBorder p="sm" key={rule.id}><Group justify="space-between" wrap="nowrap"><Code style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{rule.description}</Code><Button size="compact-xs" color="red" variant="subtle" disabled={busy} onClick={() => setPending({ operation: 'delete', rule_id: rule.id, revision: status.revision, description: rule.description })}>{t('Delete rule')}</Button></Group></Paper>) : <Text size="sm" c="dimmed">{t('No saved firewall rules.')}</Text>}
        </Stack></div>
        {pending && <Alert color="orange" title={t('Confirm firewall change')}><Stack gap="xs"><Text size="sm">{pending.operation === 'delete' ? t('Delete this saved rule? Removing an SSH allow rule may prevent reconnection.') : pending.operation === 'disable' ? t('Disable UFW on this server? Saved rules will be kept.') : t('Enable UFW using the saved rules? SSH access will be checked first.')}</Text>{pending.operation === 'delete' && <Code>{pending.description}</Code>}<Group justify="end"><Button variant="default" onClick={() => setPending(null)}>{t('Cancel')}</Button><Button color="orange" onClick={() => { const { operation } = pending; void operate(operation === 'delete' ? { operation, rule_id: pending.rule_id, revision: pending.revision } : { operation }); }}>{t('Confirm')}</Button></Group></Stack></Alert>}
        <Paper withBorder p="md"><form onSubmit={event => { event.preventDefault(); void operate({ operation: 'add', port: Number(port), protocol, action, source: scope === 'any' ? 'any' : source.trim() }); }}><Stack gap="sm">
          <Title order={4} size="sm">{t('Add firewall rule')}</Title>
          <Group grow align="start"><NumberInput label={t('Port')} value={port} onChange={setPort} min={1} max={65535} allowDecimal={false} required disabled={busy} /><Select label={t('Protocol')} value={protocol} onChange={setProtocol} allowDeselect={false} data={[{ value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' }, { value: 'any', label: t('TCP and UDP') }]} disabled={busy} /><Select label={t('Rule action')} value={action} onChange={setAction} allowDeselect={false} data={[{ value: 'allow', label: t('Allow') }, { value: 'deny', label: t('Deny') }]} disabled={busy} /></Group>
          <Select label={t('Source addresses')} value={scope} onChange={setScope} allowDeselect={false} data={[{ value: 'any', label: t('All IP addresses') }, { value: 'ip', label: t('Specific IP or network') }]} disabled={busy} />
          {scope === 'ip' && <TextInput label={t('Source IP or CIDR')} placeholder="192.0.2.10 / 192.0.2.0/24 / 2001:db8::1" value={source} onChange={event => setSource(event.currentTarget.value)} required maxLength={128} disabled={busy} />}
          <Group justify="end"><Button type="submit" disabled={busy || !!pending}>{t('Add rule')}</Button></Group>
        </Stack></form></Paper>
      </>}
      <Group justify="end"><Button variant="default" disabled={busy} onClick={close}>{t('Close')}</Button><Button variant="default" loading={busy} disabled={!!pending} onClick={() => void operate({ operation: 'status' })}>{t('Refresh')}</Button></Group>
    </Stack>
  </Modal>;
}

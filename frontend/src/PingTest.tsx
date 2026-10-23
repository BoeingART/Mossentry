import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Code, Group, Modal, Stack, Text } from '@mantine/core';
import { api } from './api';
import { t } from './i18n';
import type { PingResult, Server } from './types';

export default function PingTest({ server, close }: { server: Server; close: () => void }) {
  const [result, setResult] = useState<PingResult | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const request = useRef<{ key: string; promise: Promise<PingResult> } | null>(null);
  useEffect(() => {
    let active = true;
    setBusy(true); setError(''); setResult(null);
    const key = `${server.id}:${attempt}`;
    if (request.current?.key !== key) request.current = { key, promise: api<PingResult>(`/api/servers/${server.id}/ping`, 'POST') };
    request.current.promise.then(value => { if (active) setResult(value); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : t('Please retry the operation')); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [server.id, attempt]);
  return <Modal opened onClose={close} title={t('{0} · Ping test', { 0: server.name })} centered size="lg"><Stack>
    <Text size="sm">{t('Ping {0} from this computer using 4 ICMP requests.', { 0: server.hostname })}</Text>
    <Text size="xs" c="dimmed">{t('Ping does not test SSH or TCP rules. No reply can also mean ICMP is blocked. Jump hosts and SSH proxies are not used.')}</Text>
    {error && <Alert color="red" role="alert">{t(error)}</Alert>}
    {result && <><Alert color={result.ok ? 'teal' : 'yellow'} role="status">{result.ok ? t('Ping succeeded') : result.timed_out ? t('Ping timed out') : t('Ping received no successful response')}</Alert><Code block style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{result.output || t('No output')}</Code></>}
    <Group justify="end"><Button variant="default" onClick={close}>{t('Close')}</Button><Button loading={busy} onClick={() => setAttempt(current => current + 1)}>{t('Run ping test')}</Button></Group>
  </Stack></Modal>;
}

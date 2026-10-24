import { useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, Badge, Button, Card, Group, Loader, Text, Title, UnstyledButton } from '@mantine/core';
import { IconArrowLeft, IconChevronRight, IconRefresh, IconServer } from '@tabler/icons-react';
import { api } from './api';
import Firewall from './Firewall';
import { FirewallController, firewallSource, firewallState } from './firewallData';
import { t } from './i18n';
import type { FirewallStatus, Server } from './types';

// Keep the queue across page remounts: an SSH request cannot be cancelled by
// leaving the page, and the next page must wait for that request to drain.
const firewalls = new FirewallController((server, body) => api<FirewallStatus>(`/api/servers/${server.id}/firewall`, 'POST', body));
const states = {
  enabled: { label: 'Firewall enabled', color: 'teal' },
  disabled: { label: 'Firewall disabled', color: 'gray' },
  unavailable: { label: 'UFW not installed', color: 'yellow' },
  error: { label: 'Check failed', color: 'red' },
  checking: { label: 'Checking…', color: 'blue' },
  waiting: { label: 'Waiting to check', color: 'gray' },
  paused: { label: 'Management paused', color: 'gray' },
};

export default function FirewallPage({ servers, saved }: { servers: Server[]; saved: () => Promise<void> }) {
  const [serverId, setServerId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [revision, setRevision] = useState(0);
  const entries = useSyncExternalStore(firewalls.subscribe, firewalls.snapshot);
  const sources = JSON.stringify(servers.map(firewallSource));
  const server = servers.find(server => server.id === serverId);

  useEffect(() => {
    if (serverId !== null) return;
    let active = true;
    setChecking(true);
    void firewalls.checkAll(servers, () => active).finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [sources, serverId, revision]);

  if (serverId !== null) return <>
    <Button variant="subtle" size="xs" leftSection={<IconArrowLeft size={15} />} mb="md" disabled={!!server?.enabled && busy}
      onClick={() => { setServerId(null); setBusy(false); }}>{t('All servers')}</Button>
    <Group className="page-heading" mb="lg"><Title order={2}>{t('Firewall')}</Title></Group>
    <Card withBorder radius="lg" p="lg">
      {server?.enabled ? <Firewall key={firewallSource(server)} server={server} saved={saved} busy={busy} setBusy={setBusy} controller={firewalls} />
        : <Alert color="orange">{t(server ? 'This server is paused. Enable management from the Servers page to manage its firewall.'
          : 'This server is no longer available. Return to the server list.')}</Alert>}
    </Card>
  </>;

  return <>
    <Group className="page-heading" justify="space-between" mb="lg">
      <div><Title order={2}>{t('Firewall')}</Title><Text size="sm" c="dimmed" mt={4}>{t('View firewall status across your servers. Select a server to manage its firewall.')}</Text></div>
      <Button variant="default" leftSection={<IconRefresh size={16} />} loading={checking} disabled={!servers.some(server => server.enabled)}
        onClick={() => setRevision(value => value + 1)}>{t('Refresh')}</Button>
    </Group>
    <Card className="firewall-server-list" withBorder radius="lg" p={0}>
      {servers.length ? <>
        <div className="firewall-list-heading"><Text component="span" size="xs" fw={500}>{t('Server')}</Text><Text component="span" size="xs" fw={500}>{t('Firewall status')}</Text></div>
        <ul>{servers.map(server => {
          const entry = entries[firewallSource(server)];
          const state = firewallState(server, entry);
          const { label, color } = states[state];
          return <li key={server.id}>
            <UnstyledButton className="firewall-server-row" disabled={!server.enabled}
              aria-label={`${t('Manage firewall on {0}', { 0: server.name })} · ${t(label)}`}
              onClick={() => { setBusy(true); setServerId(server.id); }}>
              <span className="firewall-server-icon"><IconServer size={21} aria-hidden="true" /></span>
              <span className="firewall-server-identity">
                <Text component="span" fw={600} size="sm">{server.name}</Text>
                <Text component="span" size="xs" c="dimmed">{server.hostname}:{server.port}</Text>
                {entry?.phase === 'error' && !!server.enabled && <Text component="span" size="xs" c="red">{t(entry.error)}</Text>}
              </span>
              <Badge component="span" className="firewall-server-state" variant="light" color={color}
                leftSection={state === 'checking' ? <Loader size={10} color="inherit" /> : undefined}>{t(label)}</Badge>
              <IconChevronRight className="firewall-server-chevron" size={18} aria-hidden="true" />
            </UnstyledButton>
          </li>;
        })}</ul>
      </> : <Text c="dimmed" size="sm" ta="center" p="xl">{t('Add a server to view its firewall status.')}</Text>}
    </Card>
  </>;
}

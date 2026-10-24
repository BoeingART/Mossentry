import { useState } from 'react';
import { Card, Group, Select, Text, Title } from '@mantine/core';
import Firewall from './Firewall';
import { t } from './i18n';
import type { Server } from './types';

export default function FirewallPage({ servers, saved }: { servers: Server[]; saved: () => Promise<void> }) {
  const [serverId, setServerId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const server = servers.find(server => String(server.id) === serverId && server.enabled);
  return <>
    <Group className="page-heading" mb="lg"><Title order={2}>{t('Firewall')}</Title></Group>
    <Group className="filter-toolbar" mb="lg">
      <Select label={t('Server')} placeholder={t('Select a server')} searchable clearable value={serverId}
        disabled={busy} w={{ base: '100%', sm: 320 }}
        data={servers.filter(server => server.enabled).map(server => ({ value: String(server.id), label: server.name }))}
        onChange={value => { setServerId(value); setBusy(!!value); }} />
    </Group>
    <Card withBorder radius="lg" p="lg">
      {server ? <Firewall key={server.id} server={server} saved={saved} busy={busy} setBusy={setBusy} />
        : <Text c="dimmed" size="sm" ta="center" py="xl">{t(servers.some(server => server.enabled)
          ? 'Select a server to manage its firewall.' : 'Add or enable a server to manage its firewall.')}</Text>}
    </Card>
  </>;
}

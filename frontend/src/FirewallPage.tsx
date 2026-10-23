import { useState } from 'react';
import { Badge, Button, Card, Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { IconShieldLock } from '@tabler/icons-react';
import Firewall from './Firewall';
import { t } from './i18n';
import type { Server } from './types';

export default function FirewallPage({ servers, saved, openServers }: {
  servers: Server[]; saved: () => Promise<void>; openServers: () => void;
}) {
  const [selected, setSelected] = useState<Server | null>(null);
  return <Stack gap="lg">
    <div className="page-heading"><Title order={2}>{t('Firewall')}</Title>
      <Text size="sm" c="dimmed">{t('Choose a server to view and manage its UFW firewall rules.')}</Text>
    </div>
    {servers.length ? <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }}>{servers.map(server => <Card key={server.id} withBorder p="lg">
      <Stack gap="md">
        <Group justify="space-between" wrap="nowrap"><Text fw={600}>{server.name}</Text>
          <Badge color={server.enabled ? 'teal' : 'gray'} variant="light">{server.enabled ? t('Enabled') : t('Paused')}</Badge>
        </Group>
        <Text size="sm" c="dimmed">{server.hostname}:{server.port}</Text>
        {!server.enabled && <Text size="sm" c="dimmed">{t('Enable management from the Servers page to manage this firewall.')}</Text>}
        <Button variant="light" leftSection={<IconShieldLock size={17} />} disabled={!server.enabled}
          aria-label={t('Manage {0} firewall', { 0: server.name })} onClick={() => setSelected(server)}>{t('Manage firewall')}</Button>
      </Stack>
    </Card>)}</SimpleGrid> : <Card withBorder p="xl"><Stack align="center">
      <Text c="dimmed">{t('Add a server before managing firewall rules.')}</Text>
      <Button onClick={openServers}>{t('Add your first server')}</Button>
    </Stack></Card>}
    {selected && <Firewall key={selected.id} server={selected} close={() => setSelected(null)} saved={saved} />}
  </Stack>;
}

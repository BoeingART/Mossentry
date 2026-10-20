import { useState } from 'react';
import { Alert, Badge, Card, Group, Pagination, ScrollArea, SimpleGrid, Stack, Table, Text, TextInput } from '@mantine/core';
import { t } from './i18n';
import { numericDate } from './dateFormat';

type Service = { unit: string; enabled: string; active: string; sub: string; description: string; protected: boolean };
export type ProbeResult = {
  checked_at: string; available?: boolean; warnings?: string[]; services?: Service[];
  hostname?: string; os?: string; kernel?: string; architecture?: string; cores?: number;
  uptime_seconds?: number | null; load?: number[]; memory_percent?: number | null; swap_percent?: number | null;
  filesystems?: { mount: string; type: string; percent: number | null; inode_percent: number | null; available_gb: number }[];
  failed_services?: string[] | null;
  alerts?: { kind: string; target: string; value: number | null }[];
  entries?: { timestamp: string; unit: string; priority: string; message: string }[];
  scope?: string; limit?: number; unit?: string; operation?: string; state?: Record<string, string>;
};
const date = (value: string) => numericDate(value, { includeTime: true });
const percent = (value: number | null | undefined) => value == null ? t('N/A') : `${value}%`;

export default function LegacyOperationResult({ value }: { value: ProbeResult }) {
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
      <ScrollArea><Table miw={750} verticalSpacing="sm"><Table.Thead><Table.Tr>{['Service', 'State', 'Boot policy'].map(label => <Table.Th key={label}>{t(label)}</Table.Th>)}</Table.Tr></Table.Thead><Table.Tbody>
        {serviceRows.slice((Math.min(page, pages) - 1) * 15, Math.min(page, pages) * 15).map(service => <Table.Tr key={service.unit}>
          <Table.Td><Text size="sm" fw={600}>{service.unit}</Text><Text size="xs" c="dimmed">{service.description}</Text></Table.Td>
          <Table.Td><Badge color={service.active === 'failed' ? 'red' : service.active === 'active' ? 'teal' : 'gray'}>{service.active}</Badge><Text size="xs">{service.sub}</Text></Table.Td><Table.Td>{service.enabled}</Table.Td>
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


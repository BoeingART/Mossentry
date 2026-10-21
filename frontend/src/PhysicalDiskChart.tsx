import { t } from './i18n';
import { Badge, Group, Paper, ScrollArea, Stack, Text } from '@mantine/core';
import type { PhysicalDiskGroup } from './types';

const gb = (gib: number) => (gib * 1024 ** 3 / 1e9).toFixed(1);
export default function PhysicalDiskChart({ disks, loading }: { disks: PhysicalDiskGroup[]; loading: boolean }) {
  const ordered = [...disks].sort((a, b) => b.total_gb - a.total_gb || a.id.localeCompare(b.id));
  return <Paper withBorder radius="lg" p="lg" className="resource-chart">
    <Text fw={600} mb="lg">{t("Disk")}</Text>
    <ScrollArea.Autosize mah={295} type="auto"><Stack gap="lg">
      {ordered.map(disk => <div key={disk.id} className="disk-chart-row">
        <Group justify="space-between" align="start" gap="xs" mb={7}>
          <Group gap={6}><Text fw={600} size="sm">{disk.devices.map(device => device.name).join(' + ')}</Text>
            {[...new Set(disk.devices.map(device => device.storage_type).filter(Boolean))].map(kind => <Badge key={kind} size="xs" variant="light" color="gray">{kind}</Badge>)}
            {disk.raid_levels?.map(level => <Badge key={level} size="xs" variant="light">{level.replace(/^raid/i, 'RAID ')}</Badge>)}
          </Group>
          <Text size="sm" fw={600}>{disk.percent === null ? 'N/A' : `${disk.percent.toFixed(1)}%`}
            {disk.used_gb !== null && disk.filesystem_total_gb !== null && <Text span size="xs" c="dimmed" fw={400}> ({gb(disk.used_gb)}/{gb(disk.filesystem_total_gb)} GB)</Text>}
          </Text>
        </Group>
        <div className={`disk-chart-bar ${disk.percent === null ? 'disk-chart-bar-unknown' : ''}`} role={disk.percent === null ? 'img' : 'meter'}
          aria-label={t("{0} mounted usage: {1}", { 0: disk.devices.map(device => device.name).join(' + '), 1: disk.percent === null ? 'unavailable' : `${disk.percent}%` })}
          aria-valuemin={disk.percent === null ? undefined : 0} aria-valuemax={disk.percent === null ? undefined : 100} aria-valuenow={disk.percent ?? undefined}>
          {disk.percent !== null && <div className="disk-chart-fill" style={{ width: `${Math.min(100, Math.max(0, disk.percent))}%`, background: disk.percent >= 90 ? '#e69a35' : '#4fc3f7' }} />}
        </div>
        {disk.status !== 'ok' && <Text size="xs" c="dimmed" mt={7}>{t(disk.status === 'unmounted' ? "Unmounted" : "Unavailable")}</Text>}
      </div>)}
      {!disks.length && <Text size="sm" c="dimmed" py="xl" ta="center">{loading ? t("Loading") : t("No data")}</Text>}
    </Stack></ScrollArea.Autosize>
  </Paper>;
}

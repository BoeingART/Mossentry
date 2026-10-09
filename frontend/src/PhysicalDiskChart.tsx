import { t } from './i18n';
import { Group, Paper, ScrollArea, Stack, Text } from '@mantine/core';
import type { PhysicalDiskGroup } from './types';

export default function PhysicalDiskChart({ disks, loading }: { disks: PhysicalDiskGroup[]; loading: boolean }) {
  return <Paper withBorder radius="lg" p="lg" className="resource-chart">
    <Text fw={500}>{t("Disk")}</Text>
    <div className="disk-chart-axis" aria-hidden="true">{[0, 25, 50, 75, 100].map(value => <span key={value}>{value}%</span>)}</div>
    <ScrollArea.Autosize mah={295} type="auto"><Stack gap="lg">
      {disks.map(disk => <div key={disk.id} className="disk-chart-row">
        <Group justify="space-between" align="start" gap="xs" mb={7}>
          <div><Text fw={700} size="sm">{disk.devices.map(device => device.name).join(' + ')}</Text>
            <Text size="xs" c="dimmed">{disk.total_gb.toLocaleString()} GiB</Text></div>
          <Text size="sm" fw={700}>{disk.percent === null ? 'N/A' : `${disk.percent.toFixed(1)}%`}</Text>
        </Group>
        <div className={`disk-chart-bar ${disk.percent === null ? 'disk-chart-bar-unknown' : ''}`} role={disk.percent === null ? 'img' : 'meter'}
          aria-label={t("{0} mounted usage: {1}", { 0: disk.devices.map(device => device.name).join(' + '), 1: disk.percent === null ? 'unavailable' : `${disk.percent}%` })}
          aria-valuemin={disk.percent === null ? undefined : 0} aria-valuemax={disk.percent === null ? undefined : 100} aria-valuenow={disk.percent ?? undefined}>
          {disk.percent !== null && <div className="disk-chart-fill" style={{ width: `${Math.min(100, Math.max(0, disk.percent))}%`, background: disk.percent >= 90 ? '#e69a35' : '#4fc3f7' }} />}
        </div>
        <Text size="xs" c="dimmed" mt={7}>{disk.status === 'ok'
          ? `${disk.used_gb?.toLocaleString()} / ${disk.filesystem_total_gb?.toLocaleString()} GiB`
          : disk.status === 'unmounted' ? t("Unmounted") : t("Unavailable")}</Text>
        <details className="monitor-notes" style={{ marginTop: 6 }}><summary>{t("Disk details")}</summary>
          <Stack gap={4} mt={6}>{disk.devices.map(device => <Text key={device.name} size="xs">{device.name} · {device.model || t("Model unavailable")} · {device.total_gb.toLocaleString()} GiB</Text>)}
            <Text size="xs">{t("Mounts:")} {disk.mounts.join(', ') || t("None measured")}</Text>
          </Stack>
        </details>
      </div>)}
      {!disks.length && <Text size="sm" c="dimmed" py="xl" ta="center">{loading ? t("Loading") : t("No data")}</Text>}
    </Stack></ScrollArea.Autosize>
  </Paper>;
}

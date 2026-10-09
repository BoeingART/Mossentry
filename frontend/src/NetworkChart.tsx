import { t } from './i18n';
import { useEffect, useState } from 'react';
import { Select } from '@mantine/core';
import type { ResourceMetrics } from './types';
import { formatRate, rateMaximum } from './monitorData';
import type { HistorySample } from './monitorData';
import ResourceChart from './ResourceChart';

export default function NetworkChart({ sample, history, end, paused }: {
  sample: ResourceMetrics | null; history: HistorySample[]; end: number; paused: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const preferred = sample?.network?.interfaces[0]?.name ?? null;
  useEffect(() => { if (selected === null && preferred) setSelected(preferred); }, [selected, preferred]);
  const active = selected ?? preferred;
  const names = [...new Set([...(active ? [active] : []),
    ...(sample?.network?.interfaces.map(item => item.name) ?? []),
    ...history.flatMap(point => point.sample?.network?.interfaces.map(item => item.name) ?? [])])];
  const directions = [
    { id: 'rx_bytes_per_second', label: t("Download"), color: '#039be5' },
    { id: 'tx_bytes_per_second', label: t("Upload"), color: '#009688' },
  ] as const;
  const series = directions.map(direction => ({
    ...direction,
    current: sample?.network?.interfaces.find(item => item.name === active)?.[direction.id] ?? null,
    points: history.map(point => ({ time: point.time,
      value: point.sample?.network?.interfaces.find(item => item.name === active)?.[direction.id] ?? null })),
  }));
  return <ResourceChart title={t("Network")} series={series} end={end}
    maximum={rateMaximum(series.flatMap(item => [item.current, ...item.points.map(point => point.value)]))}
    formatValue={formatRate} formatTick={formatRate} axisWidth={104}
    control={<Select aria-label={t("Network interface")} placeholder={t("Interface")} size="xs" w={170}
      data={names} value={active} onChange={setSelected} allowDeselect={false} disabled={!names.length} />}
    emptyMessage={sample?.network?.status === 'unavailable' ? t("Unavailable") : paused ? t("Paused") : t("No data")} />;
}

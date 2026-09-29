import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Group, Paper, Text } from '@mantine/core';
import { chartSegments, timePosition, WINDOW_MS } from './monitorData';
import type { ChartPoint } from './monitorData';

export type ChartSeries = { id: string; label: string; color: string; points: ChartPoint[]; current: number | null };
const timeLabel = (time: number) => new Date(time).toLocaleTimeString([], { hour12: false });

export default function ResourceChart({ title, control, series, end, emptyMessage }: {
  title: string; control?: ReactNode; series: ChartSeries[]; end: number; emptyMessage: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  const [hover, setHover] = useState<number | null>(null);
  const clipId = useId();
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(Math.max(240, entries[0].contentRect.width)));
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const left = 46, right = 14, top = 20, bottom = 224, height = 262;
  const plotWidth = width - left - right;
  const x = (time: number) => left + timePosition(time, end) * plotWidth;
  const y = (value: number) => bottom - value / 100 * (bottom - top);
  const segments = series.map(item => ({ ...item, segments: chartSegments(item.points, end) }));
  const populated = segments.some(item => item.segments.length > 0);
  const tickCount = width < 460 ? 2 : 5;
  const hoverTime = hover === null ? null : end - WINDOW_MS + hover * WINDOW_MS;
  const hovered = hoverTime === null ? [] : series.map(item => {
    const point = item.points.reduce<ChartPoint | null>((nearest, point) =>
      nearest === null || Math.abs(point.time - hoverTime) < Math.abs(nearest.time - hoverTime) ? point : nearest, null);
    return { label: item.label, color: item.color, point: point && Math.abs(point.time - hoverTime) <= 5_000 ? point : null };
  });
  return <Paper withBorder radius="lg" p="lg" className="resource-chart">
    <Group justify="space-between" wrap="nowrap" gap="xs" mih={30}><Text fw={700}>{title}</Text>{control}</Group>
    <div ref={ref} className="resource-chart-plot">
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={`${title} chart`}
        onPointerLeave={() => setHover(null)} onPointerMove={event => {
          const box = event.currentTarget.getBoundingClientRect();
          setHover(Math.max(0, Math.min(1, ((event.clientX - box.left) * width / box.width - left) / plotWidth)));
        }}>
        <title>{title}</title>
        <defs><clipPath id={clipId}><rect x={left} y={top - 3} width={plotWidth} height={bottom - top + 6} /></clipPath></defs>
        {[0, 25, 50, 75, 100].map(value => <g key={value}>
          <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke="#e7edf4" strokeDasharray={value ? '4 4' : undefined} />
          <text x={left - 9} y={y(value) + 4} textAnchor="end" className="chart-axis-label">{value}%</text>
        </g>)}
        {Array.from({ length: tickCount + 1 }, (_, index) => {
          const time = end - WINDOW_MS + WINDOW_MS * index / tickCount;
          return <g key={index}><line x1={x(time)} x2={x(time)} y1={top} y2={bottom} stroke="#f0f3f7" />
            <text x={x(time)} y={bottom + 23} textAnchor={index === 0 ? 'start' : index === tickCount ? 'end' : 'middle'} className="chart-axis-label">{timeLabel(time)}</text></g>;
        })}
        <line x1={left} x2={left} y1={top} y2={bottom} stroke="#cad4e2" />
        <g clipPath={`url(#${clipId})`}>{segments.map(item => <g key={item.id}>
          {item.segments.map((segment, index) => <g key={index}>
            <polyline points={segment.map(point => `${x(point.time)},${y(point.value!)}`).join(' ')} fill="none" stroke={item.color} strokeWidth={2.3} strokeLinejoin="round" />
            {segment.map(point => <circle key={point.time} cx={x(point.time)} cy={y(point.value!)} r={2.4} fill={item.color} />)}
          </g>)}
        </g>)}</g>
        {!populated && <text x={left + plotWidth / 2} y={(top + bottom) / 2} textAnchor="middle" className="chart-empty-label">{emptyMessage}</text>}
        {hoverTime !== null && <line x1={x(hoverTime)} x2={x(hoverTime)} y1={top} y2={bottom} stroke="#94a3b8" strokeDasharray="3 3" />}
      </svg>
      {hoverTime !== null && populated && <div className="chart-tooltip" style={{ left: hover! > 0.5 ? 50 : undefined, right: hover! > 0.5 ? undefined : 14 }}>
        <Text size="xs" fw={600}>{timeLabel(hoverTime)}</Text>
        {hovered.map(item => <Text size="xs" key={item.label} c={item.color}>{item.label}: {item.point?.value == null ? 'N/A' : `${item.point.value.toFixed(1)}%`}</Text>)}
      </div>}
    </div>
    <Group gap="md">{series.map(item => <Group gap={6} key={item.id} wrap="nowrap">
      <span style={{ background: item.color, width: 9, height: 9, borderRadius: '50%', flexShrink: 0 }} />
      <Text size="xs">{item.label}</Text><Text size="xs" fw={700}>{item.current === null ? 'N/A' : `${item.current.toFixed(1)}%`}</Text>
    </Group>)}</Group>
  </Paper>;
}

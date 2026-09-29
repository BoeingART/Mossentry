import type { ResourceMetrics } from './types.ts';

export const REFRESH_MS = 5_000;
export const WINDOW_MS = 5 * 60_000;
export type HistorySample = { time: number; sample: ResourceMetrics | null };
export type ChartPoint = { time: number; value: number | null };
export type GpuDevice = ResourceMetrics['gpu']['devices'][number];

export function appendSample(history: HistorySample[], sample: ResourceMetrics | null, time: number): HistorySample[] {
  const recent = history.filter(point => point.time >= time - WINDOW_MS);
  // The service can return a cached sample after an immediate navigation.
  if (sample && recent.at(-1)?.sample?.checked_at === sample.checked_at) return recent;
  return [...recent, { time, sample }].slice(-62);
}

export function matchesUser(username: string | null, selected: string[]) {
  return selected.length === 0 || (username !== null && selected.includes(username));
}

export function cpuPercent(sample: ResourceMetrics, selected: string[]) {
  return selected.length ? sample.cpu.users.filter(user => matchesUser(user.username, selected))
    .reduce((total, user) => total + user.cpu_percent, 0) : sample.cpu.percent;
}

export function gpuPercent(device: GpuDevice | undefined, selected: string[]): number | null {
  if (!device) return null;
  if (!selected.length) return device.percent;
  const processes = device.processes.filter(process => matchesUser(process.username, selected));
  // Unavailable attribution is a chart gap, never a fabricated idle sample.
  if (!processes.length || processes.some(process => process.sm_percent === null)) return null;
  return processes.reduce((total, process) => total + process.sm_percent!, 0);
}

export function chartSegments(points: ChartPoint[], end: number): ChartPoint[][] {
  const segments: ChartPoint[][] = [];
  let current: ChartPoint[] = [];
  for (const point of points) {
    if (point.time < end - WINDOW_MS || point.time > end) continue;
    if (point.value === null || !Number.isFinite(point.value)) {
      current = [];
      continue;
    }
    if (!current.length || point.time - current[current.length - 1].time > REFRESH_MS * 2) {
      current = [];
      segments.push(current);
    }
    current.push({ ...point, value: Math.min(100, Math.max(0, point.value)) });
  }
  return segments;
}

export function timePosition(time: number, end: number) {
  return (time - (end - WINDOW_MS)) / WINDOW_MS;
}

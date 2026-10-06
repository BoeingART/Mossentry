import type { Dashboard } from './types';

export const DAY = 86_400_000;
export type HistoryPoint = Dashboard['statistics']['history'][number];
export const dateTime = (date: string) => Date.parse(`${date}T00:00:00Z`);
export function totalAt(history: HistoryPoint[], time: number): number {
  let low = 0, high = history.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (dateTime(history[middle].date) <= time) low = middle + 1;
    else high = middle;
  }
  return low ? history[low - 1].total : 0;
}

export function growthWindow(history: HistoryPoint[], through: string, range: string) {
  const end = dateTime(through);
  const first = history.length ? dateTime(history[0].date) - DAY : end - 30 * DAY;
  const start = range === 'all' ? Math.min(first, end - DAY) : end - Number(range) * DAY;
  const points = [{ time: start, total: totalAt(history, start) },
    ...history.filter(point => dateTime(point.date) > start && dateTime(point.date) <= end)
      .map(point => ({ time: dateTime(point.date), total: point.total }))];
  if (points.at(-1)!.time < end) points.push({ time: end, total: totalAt(history, end) });
  return { start, end, points };
}

// Horizontal control handles keep the curve within each pair of cumulative
// counts: no overshoot, negative counts or invented intermediate peaks.
export function smoothPath(points: { x: number; y: number }[]) {
  return points.map((point, index) => {
    if (!index) return `M ${point.x} ${point.y}`;
    const previous = points[index - 1], handle = (point.x - previous.x) * 0.45;
    return `C ${previous.x + handle} ${previous.y}, ${point.x - handle} ${point.y}, ${point.x} ${point.y}`;
  }).join(' ');
}

export function accessCounts(users: Dashboard['users']) {
  const accounts = new Map<string, boolean>();
  for (const user of users) accounts.set(user.username, !!user.is_sudo || !!accounts.get(user.username));
  const sudo = [...accounts.values()].filter(Boolean).length;
  return { total: accounts.size, sudo, standard: accounts.size - sudo };
}

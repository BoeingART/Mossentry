import type { Dashboard } from './types';

export const DAY = 86_400_000;
export type HistoryPoint = Dashboard['statistics']['history'][number];
export const dateTime = (date: string) => Date.parse(`${date}T00:00:00Z`);
export function dashboardAccounts(users: Dashboard['users']) {
  return users.filter(user => !(user.uid < 1000 && user.is_disabled));
}
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
  // Daily vertices make the inspection marker an exact point on the curve.
  // Counts remain cumulative integers, including days with no new users.
  const points = Array.from({ length: Math.round((end - start) / DAY) + 1 }, (_, index) => {
    const time = start + index * DAY;
    return { time, total: totalAt(history, time) };
  });
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
  for (const user of dashboardAccounts(users)) accounts.set(user.username, !!user.is_sudo || !!accounts.get(user.username));
  const sudo = [...accounts.values()].filter(Boolean).length;
  return { total: accounts.size, sudo, standard: accounts.size - sudo };
}

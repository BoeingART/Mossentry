type DateOptions = { includeYear?: boolean; includeTime?: boolean; utc?: boolean };

// Chart dates stay in UTC; event timestamps retain the user's local time zone.
// Use the same numeric notation in every interface language.
export function numericDate(value: string | number | Date, { includeYear = true, includeTime = false, utc = false }: DateOptions = {}) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (part: number) => String(part).padStart(2, '0');
  const year = utc ? date.getUTCFullYear() : date.getFullYear();
  const month = pad((utc ? date.getUTCMonth() : date.getMonth()) + 1);
  const day = pad(utc ? date.getUTCDate() : date.getDate());
  const calendar = `${includeYear ? `${year}-` : ''}${month}-${day}`;
  if (!includeTime) return calendar;
  const hour = pad(utc ? date.getUTCHours() : date.getHours());
  const minute = pad(utc ? date.getUTCMinutes() : date.getMinutes());
  return `${calendar} ${hour}:${minute}`;
}

// Endpoints bound every tick on this continuous axis. Historical single-year
// ranges must retain their year, just like ranges spanning multiple years.
export function dateAxisTicks(start: number, end: number, plotWidth: number, now = new Date()) {
  const currentYear = now.getFullYear();
  const includeYear = new Date(start).getUTCFullYear() !== currentYear || new Date(end).getUTCFullYear() !== currentYear;
  const intervals = Math.max(1, Math.min(5, Math.floor(plotWidth / (includeYear ? 140 : 85))));
  return Array.from({ length: intervals + 1 }, (_, index) => {
    const time = start + (end - start) * index / intervals;
    return { time, label: numericDate(time, { includeYear, utc: true }) };
  });
}

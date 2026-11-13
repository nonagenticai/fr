/** Humanize an ISO timestamp into a compact age, e.g. "just now", "5m", "1h 3m". */
export function formatAndonDuration(fromIso: string | null): string {
  if (!fromIso) return '';
  const since = new Date(fromIso).getTime();
  if (Number.isNaN(since)) return '';
  const mins = Math.max(0, Math.round((Date.now() - since) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins === 0 ? `${hours}h` : `${hours}h ${remMins}m`;
}

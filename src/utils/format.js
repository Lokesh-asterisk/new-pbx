/**
 * Format seconds into HH:MM:SS.
 */
export function formatDuration(totalSec) {
  const sec = Math.max(0, Math.floor(Number(totalSec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Format seconds as short string: "2h 15m" or "5m 30s".
 */
export function formatDurationShort(totalSec) {
  const sec = Math.max(0, Math.floor(Number(totalSec) || 0));
  if (sec === 0) return '0s';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 && h === 0) parts.push(`${s}s`);
  return parts.join(' ') || '0s';
}

/**
 * Format a number with locale separators.
 */
export function formatNumber(n) {
  return Number(n || 0).toLocaleString();
}

/**
 * Format percentage (0-1 scale to display percentage).
 */
export function formatPercent(val, decimals = 1) {
  if (val == null) return '—';
  return (Number(val) * 100).toFixed(decimals) + '%';
}

/**
 * Format AHT (seconds to MM:SS).
 */
export function formatAht(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const remainder = s % 60;
  return `${m}:${String(remainder).padStart(2, '0')}`;
}

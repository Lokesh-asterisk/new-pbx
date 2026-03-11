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
 * Format AHT (seconds to MM:SS). Returns '-' for zero/null.
 */
export function formatAht(sec) {
  if (!sec || sec <= 0) return '-';
  const s = Math.max(0, Math.floor(Number(sec)));
  const m = Math.floor(s / 60);
  const remainder = s % 60;
  return `${m}:${String(remainder).padStart(2, '0')}`;
}

/**
 * Format milliseconds into M:SS (for agent timer display).
 */
export function formatDurationMs(ms) {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Format milliseconds into verbose "Xh Xm Xs" (for SuperAdmin).
 * Returns '—' for zero/null.
 */
export function formatDurationVerbose(ms) {
  if (!ms || ms <= 0) return '—';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/**
 * Format seconds into verbose "Xh Xm Xs" (for SuperAdmin).
 * Returns '—' for null/negative.
 */
export function formatSecVerbose(sec) {
  if (sec == null || sec < 0) return '—';
  const s = Math.floor(Number(sec));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${String(m % 60).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}

/**
 * Format seconds into zero-padded HH:MM:SS (for report tables).
 */
export function formatSecPadded(s) {
  const sec = Number(s) || 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/**
 * Format seconds into abbreviated string: "5s", "3m", "2h 15m" (for chart labels).
 */
export function formatSecCompact(s) {
  const sec = Number(s) || 0;
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

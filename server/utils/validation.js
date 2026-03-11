/**
 * Shared input validation helpers.
 */
export function parsePositiveInt(val) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

export function sanitizeAgentId(raw) {
  return (raw ?? '').toString().trim().replace(/\D/g, '') || null;
}

export function requireFields(body, fields) {
  const missing = [];
  for (const f of fields) {
    if (body[f] == null || String(body[f]).trim() === '') {
      missing.push(f);
    }
  }
  return missing.length > 0 ? missing : null;
}

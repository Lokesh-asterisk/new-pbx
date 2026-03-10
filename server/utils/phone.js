/**
 * Shared phone number utilities.
 */
export function normalizePhoneForBlacklist(raw) {
  if (raw == null || typeof raw !== 'string') return '';
  return raw.replace(/\D/g, '');
}

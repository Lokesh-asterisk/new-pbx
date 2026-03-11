/**
 * Shared phone number utilities.
 */
export function normalizePhoneForBlacklist(raw) {
  if (raw == null || typeof raw !== 'string') return '';
  return raw.replace(/\D/g, '');
}

/** Match types for blacklist: exact, prefix, suffix, contains, regex */
const MATCH_TYPES = ['exact', 'prefix', 'suffix', 'contains', 'regex'];

/**
 * Check if a caller number (digits only) matches a blacklist entry.
 * @param {string} normalizedCaller - Caller number digits only
 * @param {string} pattern - Blacklist pattern (number or regex source)
 * @param {string} matchType - exact | prefix | suffix | contains | regex
 * @returns {boolean}
 */
export function blacklistMatch(normalizedCaller, pattern, matchType) {
  if (!normalizedCaller || normalizedCaller.length === 0) return false;
  const type = (matchType || 'exact').toLowerCase();
  const pat = (pattern || '').trim();
  if (!pat && type !== 'regex') return false;

  switch (type) {
    case 'exact':
      return normalizedCaller === pat.replace(/\D/g, '');
    case 'prefix':
      return normalizedCaller.startsWith(pat.replace(/\D/g, ''));
    case 'suffix':
      return normalizedCaller.endsWith(pat.replace(/\D/g, ''));
    case 'contains':
      return normalizedCaller.includes(pat.replace(/\D/g, ''));
    case 'regex':
      try {
        const re = new RegExp(pat);
        return re.test(normalizedCaller);
      } catch (_) {
        return false;
      }
    default:
      return normalizedCaller === pat.replace(/\D/g, '');
  }
}

export function getBlacklistMatchTypes() {
  return [...MATCH_TYPES];
}

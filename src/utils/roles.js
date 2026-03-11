export const ROLES = {
  1: 'superadmin',
  2: 'admin',
  3: 'user',
  4: 'campaign',
  5: 'agent',
};

export const ROLE_IDS = {
  superadmin: 1,
  admin: 2,
  user: 3,
  campaign: 4,
  agent: 5,
};

export function normalizeRole(role) {
  if (typeof role === 'string') return role.toLowerCase();
  if (typeof role === 'number') return ROLES[role] || 'user';
  return 'user';
}

export function getRoleRedirectPath(role) {
  const normalized = normalizeRole(role);
  switch (normalized) {
    case 'superadmin': return '/dashboard';
    case 'admin': return '/dashboard';
    case 'user': return '/wallboard';
    case 'campaign': return '/dashboard';
    case 'agent': return '/agent';
    default: return '/login';
  }
}

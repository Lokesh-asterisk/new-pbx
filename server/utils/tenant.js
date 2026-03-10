/**
 * Shared tenant resolution helpers.
 */
import { queryOne } from '../db.js';

export function isSuperadminRole(role) {
  return role === 'superadmin' || role === 1;
}

export function isAdminRole(role) {
  return role === 'admin' || role === 2;
}

export function getEffectiveTenantId(user) {
  if (user.parent_id != null) return parseInt(user.parent_id, 10) || null;
  if (user.tenant_id != null) return parseInt(user.tenant_id, 10) || null;
  return null;
}

export async function resolveRequestTenantId(user, queryTenantId) {
  const assigned = getEffectiveTenantId(user);
  if (isSuperadminRole(user.role)) {
    if (queryTenantId != null && queryTenantId !== '') {
      const n = parseInt(queryTenantId, 10);
      if (!Number.isNaN(n) && n >= 1) return n;
    }
    const first = await queryOne('SELECT id FROM tenants ORDER BY id LIMIT 1');
    return first ? first.id : null;
  }
  if (assigned != null) return assigned;
  if (isAdminRole(user.role)) {
    if (queryTenantId != null && queryTenantId !== '') {
      const n = parseInt(queryTenantId, 10);
      if (!Number.isNaN(n) && n >= 1) return n;
    }
    const first = await queryOne('SELECT id FROM tenants ORDER BY id LIMIT 1');
    return first ? first.id : null;
  }
  const first = await queryOne('SELECT id FROM tenants ORDER BY id LIMIT 1');
  return first ? first.id : null;
}

export async function ensureAgentInTenant(user, agentId) {
  if (isSuperadminRole(user.role)) return true;
  const agentRow = await queryOne(
    'SELECT parent_id FROM users WHERE phone_login_number = ? AND role = 5 LIMIT 1',
    [agentId]
  );
  const agentTenantId = agentRow?.parent_id ?? null;
  const adminTenantId = getEffectiveTenantId(user);
  return agentTenantId != null && adminTenantId != null && Number(agentTenantId) === Number(adminTenantId);
}

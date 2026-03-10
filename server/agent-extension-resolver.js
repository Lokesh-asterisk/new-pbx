/**
 * Resolves which agent (user) is assigned to a PJSIP extension.
 * Uses sip_extensions.agent_user_id when set, with fallback to users.phone_login_number.
 */
import { query, queryOne } from './db.js';

/**
 * Resolve extension name to agent user (by tenant).
 * Tries sip_extensions.agent_user_id first, then falls back to users.phone_login_number.
 * @param {number|null} tenantId - Optional. If provided, uses sip_extensions.agent_user_id for this tenant first.
 * @param {string} extensionName - Extension name/number (e.g. "1001")
 * @returns {Promise<{ id: number, parent_id: number }|null>} User row (id, parent_id) or null
 */
export async function resolveAgentUserByExtensionName(tenantId, extensionName) {
  const ext = String(extensionName || '').trim().replace(/\D/g, '');
  if (!ext) return null;

  if (tenantId != null && tenantId !== '' && !Number.isNaN(Number(tenantId))) {
    const byAssignment = await queryOne(
      `SELECT u.id, u.parent_id
       FROM sip_extensions e
       INNER JOIN users u ON u.id = e.agent_user_id AND u.role = 5
       WHERE e.tenant_id = ? AND e.name = ? AND e.agent_user_id IS NOT NULL
       LIMIT 1`,
      [Number(tenantId), ext]
    );
    if (byAssignment) return byAssignment;
  }

  const byPhoneLogin = await queryOne(
    'SELECT id, parent_id FROM users WHERE phone_login_number = ? AND role = 5 LIMIT 1',
    [ext]
  );
  return byPhoneLogin || null;
}

/**
 * Set or clear the persistent assignment of an extension to an agent.
 * Call after ensureSipExtensionForAgent when creating/updating an agent.
 * @param {number} tenantId - Tenant id
 * @param {string} extensionName - Extension name (e.g. "1001")
 * @param {number|null} userId - User id to assign, or null to clear
 */
export async function setExtensionAgentUserId(tenantId, extensionName, userId) {
  const tid = Number(tenantId);
  const name = String(extensionName || '').trim();
  if (!name) return;
  await query(
    'UPDATE sip_extensions SET agent_user_id = ? WHERE tenant_id = ? AND name = ?',
    [userId ?? null, tid, name]
  );
}

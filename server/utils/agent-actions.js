/**
 * Shared agent action helpers (force-logout, force-end-break).
 * Used by admin, wallboard, and superadmin routes.
 */
import { query, queryOne } from '../db.js';
import { forceLogoutAgent } from '../ari-stasis-queue.js';
import { endAgentSession, logAgentStatusChange } from '../agent-sessions.js';
import { destroySessionsForUser } from '../session-utils.js';
import { broadcastToWallboard, broadcastToAgent } from '../realtime.js';

export async function performForceEndBreak(agentId, tenantId) {
  const userRow = await queryOne(
    'SELECT id FROM users WHERE phone_login_number = ? AND role = 5 LIMIT 1',
    [agentId]
  );
  if (!userRow) return { success: false, status: 404, error: 'Agent not found' };

  if (!tenantId) {
    const tenantRow = await queryOne(
      'SELECT tenant_id FROM agent_status WHERE agent_id = ? LIMIT 1',
      [agentId]
    );
    tenantId = tenantRow?.tenant_id ?? null;
  }

  await query(
    `UPDATE agent_status SET status = 'LOGGEDIN', break_name = NULL, break_started_at = NULL, timestamp = NOW() WHERE agent_id = ?`,
    [agentId]
  );

  if (tenantId) {
    broadcastToWallboard(tenantId, {
      type: 'agent_status',
      payload: { agent_id: agentId, status: 'LOGGEDIN', break_name: null, break_started_at: null },
    });
    logAgentStatusChange(tenantId, agentId, 'READY').catch(() => {});
  }

  // Notify the agent's dashboard so it clears break state and shows "Take break" (available)
  broadcastToAgent(userRow.id, {
    type: 'agent_status',
    payload: { status: 'LOGGEDIN', breakEndedBySupervisor: true },
  });

  return { success: true, message: 'Agent set to Available' };
}

export async function performForceLogout(agentId, sessionStore) {
  const userRow = await queryOne(
    'SELECT id FROM users WHERE phone_login_number = ? AND role = 5 LIMIT 1',
    [agentId]
  );
  if (!userRow) return { success: false, status: 404, error: 'Agent not found' };

  const userId = userRow.id;
  const result = await forceLogoutAgent(agentId);
  if (!result.success) {
    return { success: false, status: 400, error: result.error || 'Force logout failed' };
  }

  await endAgentSession(agentId, 'forced');
  await query(
    `UPDATE agent_status SET status = 'LoggedOut', agent_channel_id = NULL, customer_channel_id = NULL,
     customer_number = NULL, call_id = NULL, queue_name = NULL, session_started_at = NULL,
     break_name = NULL, break_started_at = NULL, timestamp = NOW() WHERE agent_id = ?`,
    [agentId]
  );
  await query(
    'UPDATE users SET soft_phone_login_status = 0 WHERE phone_login_number = ? LIMIT 1',
    [agentId]
  ).catch(e => console.error('[force-logout] soft_phone update:', e?.message));
  await query(
    'DELETE FROM agent_extension_usage WHERE user_id = ?',
    [userId]
  ).catch(e => console.error('[force-logout] extension cleanup:', e?.message));

  if (sessionStore) {
    destroySessionsForUser(sessionStore, userId, (err) => {
      if (err) console.error('[force-logout] destroy sessions:', err);
    });
  }

  return { success: true, message: 'Agent logged out; channels and session cleared.' };
}

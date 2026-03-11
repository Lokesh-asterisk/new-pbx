/**
 * Agent session and status log for performance monitoring.
 * - agent_sessions: one row per login→logout (session_duration_sec, logout_reason).
 * - agent_status_log: one row per state (READY, RINGING, IN_CALL, WRAP_UP, PAUSED, LOGOUT) with start/end/duration.
 */
import { query, queryOne } from './db.js';

const STATUS_LOG_TABLE = 'agent_status_log';
const SESSIONS_TABLE = 'agent_sessions';

/**
 * Map agent_status.status (UI/ARI) to agent_status_log.status (canonical).
 */
export function mapToLogStatus(rawStatus, breakName) {
  const s = (rawStatus || '').toString().trim();
  if (s === 'LOGGEDIN' || s === 'LoginInitiated') return 'READY';
  if (s === 'Ringing') return 'RINGING';
  if (s === 'On Call' || s === 'Outbound' || s === 'Transferring') return 'IN_CALL';
  if (s === 'PAUSED' || (breakName != null && breakName !== '')) return 'PAUSED';
  if (s === 'After_Call_Work' || s === 'ACW' || s === 'WRAPUP') return 'WRAP_UP';
  if (s === 'LoggedOut' || s === 'LoginFailed') return 'LOGOUT';
  return 'READY';
}

/**
 * Start a new agent session (on login success). Idempotent: if an open session exists for this agent, close it first then create new.
 * @param {number} tenantId
 * @param {string} agentId - phone_login_number / extension
 * @param {number|null} [agentUserId] - users.id
 * @returns {Promise<number|null>} session id or null if table missing
 */
export async function startAgentSession(tenantId, agentId, agentUserId = null) {
  const aid = String(agentId).trim();
  if (!aid || !tenantId) return null;
  try {
    // Close any open session (stale from crash/disconnect)
    await query(
      `UPDATE ${SESSIONS_TABLE} SET logout_time = NOW(), session_duration_sec = TIMESTAMPDIFF(SECOND, login_time, NOW()), logout_reason = 'connection_lost'
       WHERE agent_id = ? AND logout_time IS NULL`,
      [aid]
    );
    // Close any open status log row for this agent
    await query(
      `UPDATE ${STATUS_LOG_TABLE} SET end_time = NOW(), duration_sec = TIMESTAMPDIFF(SECOND, start_time, NOW())
       WHERE agent_id = ? AND end_time IS NULL`,
      [aid]
    );
    await query(
      `INSERT INTO ${SESSIONS_TABLE} (tenant_id, agent_id, agent_user_id, login_time) VALUES (?, ?, ?, NOW())`,
      [tenantId, aid, agentUserId ?? null]
    );
    const row = await queryOne(`SELECT id FROM ${SESSIONS_TABLE} WHERE agent_id = ? AND logout_time IS NULL ORDER BY id DESC LIMIT 1`, [aid]);
    const sessionId = row?.id ?? null;
    if (sessionId) {
      await query(
        `INSERT INTO ${STATUS_LOG_TABLE} (session_id, tenant_id, agent_id, status, start_time) VALUES (?, ?, ?, 'READY', NOW())`,
        [sessionId, tenantId, aid]
      );
    }
    return sessionId;
  } catch (e) {
    if (e?.code === 'ER_NO_SUCH_TABLE') return null;
    console.error('agent-sessions startAgentSession:', e?.message || e);
    return null;
  }
}

/**
 * End the current agent session (on logout / force logout / login failed).
 * @param {string} agentId
 * @param {'normal'|'forced'|'connection_lost'} [logoutReason] - default 'normal'
 * @returns {Promise<boolean>} true if a session was closed
 */
export async function endAgentSession(agentId, logoutReason = 'normal') {
  const aid = String(agentId).trim();
  if (!aid) return false;
  try {
    // Close current open status log (e.g. READY or PAUSED)
    await query(
      `UPDATE ${STATUS_LOG_TABLE} SET end_time = NOW(), duration_sec = TIMESTAMPDIFF(SECOND, start_time, NOW())
       WHERE agent_id = ? AND end_time IS NULL`,
      [aid]
    );
    // Insert LOGOUT transition
    const sessionRow = await queryOne(`SELECT id, tenant_id FROM ${SESSIONS_TABLE} WHERE agent_id = ? AND logout_time IS NULL LIMIT 1`, [aid]);
    if (sessionRow) {
      await query(
        `INSERT INTO ${STATUS_LOG_TABLE} (session_id, tenant_id, agent_id, status, start_time, end_time, duration_sec) VALUES (?, ?, ?, 'LOGOUT', NOW(), NOW(), 0)`,
        [sessionRow.id, sessionRow.tenant_id, aid]
      );
    }
    const result = await query(
      `UPDATE ${SESSIONS_TABLE} SET logout_time = NOW(), session_duration_sec = TIMESTAMPDIFF(SECOND, login_time, NOW()), logout_reason = ?
       WHERE agent_id = ? AND logout_time IS NULL`,
      [logoutReason, aid]
    );
    return (result?.affectedRows ?? 0) > 0;
  } catch (e) {
    if (e?.code === 'ER_NO_SUCH_TABLE') return false;
    console.error('agent-sessions endAgentSession:', e?.message || e);
    return false;
  }
}

/**
 * Log a state change (close previous open log row, insert new one). Call after updating agent_status.
 * @param {number} tenantId
 * @param {string} agentId
 * @param {string} logStatus - READY, RINGING, IN_CALL, WRAP_UP, PAUSED, LOGOUT
 * @param {{ pauseReason?: string }} [opts]
 */
export async function logAgentStatusChange(tenantId, agentId, logStatus, opts = {}) {
  const aid = String(agentId).trim();
  if (!aid || !tenantId) return;
  const { pauseReason = null } = opts;
  try {
    // Close previous open log row
    await query(
      `UPDATE ${STATUS_LOG_TABLE} SET end_time = NOW(), duration_sec = TIMESTAMPDIFF(SECOND, start_time, NOW())
       WHERE agent_id = ? AND end_time IS NULL`,
      [aid]
    );
    const sessionRow = await queryOne(`SELECT id FROM ${SESSIONS_TABLE} WHERE agent_id = ? AND logout_time IS NULL LIMIT 1`, [aid]);
    await query(
      `INSERT INTO ${STATUS_LOG_TABLE} (session_id, tenant_id, agent_id, status, start_time, pause_reason) VALUES (?, ?, ?, ?, NOW(), ?)`,
      [sessionRow?.id ?? null, tenantId, aid, logStatus, pauseReason]
    );
  } catch (e) {
    if (e?.code === 'ER_NO_SUCH_TABLE') return;
    console.error('agent-sessions logAgentStatusChange:', e?.message || e);
  }
}

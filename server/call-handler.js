/**
 * Call state and CDR updates. Used by Asterisk HTTP callbacks and agent routes.
 * Resolves agent number (extension / phone_login_number) to user id for realtime broadcast.
 */
import { query, queryOne } from './db.js';
import { broadcastToAgent, broadcastToWallboard, EventTypes } from './realtime.js';
import { setQueueLastAgent } from './queue-strategy.js';
import { resolveAgentUserByExtensionName } from './agent-extension-resolver.js';
import { setAgentState, deleteAgentState, isRedisAvailable } from './redis-wallboard.js';
import { logAgentStatusChange, mapToLogStatus } from './agent-sessions.js';

async function resolveAgentTenantId(agentId) {
  if (!agentId) return null;
  try {
    const row = await queryOne('SELECT tenant_id FROM agent_status WHERE agent_id = ? LIMIT 1', [agentId]);
    return row?.tenant_id ?? null;
  } catch { return null; }
}

/** Show only last 4 digits; rest masked. Used only for agent incoming_call payload. Monitoring/reporting keep full number. */
function maskCallerNumberLast4(num) {
  const s = String(num ?? '').trim();
  if (!s) return '****';
  if (s.length <= 4) return '****';
  return '*'.repeat(Math.min(s.length - 4, 8)) + s.slice(-4);
}

function updateRedisAgent(tenantId, agentId, data) {
  if (!isRedisAvailable() || !tenantId) return;
  setAgentState(tenantId, agentId, { ...data, updated_at: Date.now() }).catch(() => {});
}

/**
 * @param {string} agentNumber - extension name or phone_login_number (e.g. "1001")
 * @returns {Promise<number|null>} users.id for that agent
 */
export async function getAgentUserIdByNumber(agentNumber) {
  if (!agentNumber) return null;
  const row = await resolveAgentUserByExtensionName(null, agentNumber);
  return row ? Number(row.id) : null;
}

/**
 * Create a call record (inbound or outbound). Idempotent by unique_id (ignore if exists).
 * @param {object} opts - tenantId, uniqueId, channelId, sourceNumber, destinationNumber, direction, queueName, campaignName (optional), didTfn (optional, DID/TFN for reporting), agentUserId (optional), agentExtension, agentId (phone number)
 */
export async function createCallRecord(opts) {
  const {
    tenantId,
    uniqueId,
    channelId = null,
    sourceNumber = null,
    destinationNumber = null,
    direction = 'inbound',
    queueName = null,
    campaignName = null,
    didTfn = null,
    agentUserId = null,
    agentExtension = null,
    agentId = null,
  } = opts;
  const existing = await queryOne('SELECT id FROM call_records WHERE unique_id = ? LIMIT 1', [uniqueId]);
  if (existing) return;
  await query(
    `INSERT INTO call_records (tenant_id, unique_id, channel_id, source_number, destination_number, did_tfn, direction, queue_name, campaign_name, agent_user_id, agent_extension, agent_id, start_time, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'ringing')`,
    [tenantId, uniqueId, channelId, sourceNumber, destinationNumber, didTfn || null, direction, queueName, campaignName || null, agentUserId, agentExtension, agentId]
  );
}

/**
 * Update call record when answered.
 */
export async function updateCallRecordAnswered(uniqueId) {
  await query(
    `UPDATE call_records SET answer_time = NOW(), status = 'answered' WHERE unique_id = ? LIMIT 1`,
    [uniqueId]
  );
  const row = await queryOne(
    'SELECT id, answer_time FROM call_records WHERE unique_id = ? LIMIT 1',
    [uniqueId]
  );
  return row;
}

/**
 * Set agent on a call record (e.g. when queue assigns to an agent). No-op if record does not exist.
 * @param {string} uniqueId
 * @param {object} opts - agentUserId, agentExtension, agentId
 */
export async function updateCallRecordAgent(uniqueId, opts = {}) {
  const { agentUserId = null, agentExtension = null, agentId = null } = opts;
  await query(
    `UPDATE call_records SET agent_user_id = ?, agent_extension = ?, agent_id = ? WHERE unique_id = ? LIMIT 1`,
    [agentUserId ?? null, agentExtension ?? null, agentId ?? null, uniqueId]
  );
}

/**
 * Normalize call end status from Asterisk/dialplan/queue to canonical call_records status.
 * Canonical: completed, answered, abandoned, failed, rejected, transferred, noanswer.
 * Used so Queue Performance and reporting count correctly (e.g. exitempty/timeout → abandoned).
 */
export function normalizeCallStatus(raw) {
  if (raw == null || typeof raw !== 'string') return 'completed';
  const s = String(raw).trim().toLowerCase();
  if (!s) return 'completed';
  switch (s) {
    case 'completed':
    case 'answer':
    case 'answered':
      return 'completed';
    case 'abandoned':
    case 'abondoned':
    case 'abandon':
    case 'exitempty':
    case 'timeout':
    case 'exitwithtimeout':
    case 'exitwithkey':
    case 'queue_timeout':
    case 'noanswer':
    case 'no_answer':
    case 'leaveempty':
    case 'joinempty':
    case 'full':
      return 'abandoned';
    case 'failed':
    case 'fail':
    case 'busy':
    case 'cancel':
    case 'congestion':
      return 'failed';
    case 'rejected':
    case 'reject':
      return 'rejected';
    case 'transferred':
    case 'transfer':
      return 'transferred';
    default:
      return 'completed';
  }
}

/**
 * Update call record on hangup and set duration/talk_sec/wait_time_sec.
 * Status is normalized to canonical value before storing.
 */
export async function updateCallRecordEnd(uniqueId, status = 'completed') {
  const row = await queryOne(
    'SELECT id, start_time, answer_time FROM call_records WHERE unique_id = ? LIMIT 1',
    [uniqueId]
  );
  if (!row) return null;
  let canonicalStatus = normalizeCallStatus(status);
  if (canonicalStatus === 'completed' && !row.answer_time) {
    canonicalStatus = 'abandoned';
  }
  const endTime = new Date();
  const start = row.start_time ? new Date(row.start_time).getTime() : 0;
  const answer = row.answer_time ? new Date(row.answer_time).getTime() : 0;
  const durationSec = Math.max(0, Math.floor((endTime.getTime() - start) / 1000));
  const talkSec = answer ? Math.max(0, Math.floor((endTime.getTime() - answer) / 1000)) : 0;
  const waitTimeSec = answer
    ? Math.max(0, Math.floor((answer - start) / 1000))
    : Math.max(0, Math.floor((endTime.getTime() - start) / 1000));
  await query(
    `UPDATE call_records SET end_time = ?, duration_sec = ?, talk_sec = ?, wait_time_sec = ?, status = ? WHERE unique_id = ? LIMIT 1`,
    [endTime, durationSec, talkSec, waitTimeSec, canonicalStatus, uniqueId]
  );
  return { ...row, endTime, durationSec, talkSec, waitTimeSec, status: canonicalStatus };
}

/**
 * Update call record with transfer details.
 * @param {string} uniqueId - Call unique ID
 * @param {object} opts - transferFrom, transferTo, transferType
 */
export async function updateCallRecordTransfer(uniqueId, opts = {}) {
  const { transferFrom = null, transferTo = null, transferType = null } = opts;
  await query(
    `UPDATE call_records 
     SET transfer_status = 1, 
         transfer_from = ?, 
         transfer_to = ?, 
         transfer_type = ?,
         transfer_time = NOW(),
         status = 'transferred'
     WHERE unique_id = ? LIMIT 1`,
    [transferFrom, transferTo, transferType, uniqueId]
  );
}

/**
 * Update call record with abandon reason and optional failover destination.
 * @param {string} uniqueId - Call unique ID
 * @param {string} abandonReason - One of: caller_hangup, queue_timeout, failover, no_agents, ring_timeout
 * @param {string|null} failoverDest - Failover destination (IVR, voicemail, extension, etc.)
 */
export async function updateCallRecordAbandon(uniqueId, abandonReason, failoverDest = null) {
  await query(
    `UPDATE call_records 
     SET status = 'abandoned',
         abandon_reason = ?,
         failover_destination = ?
     WHERE unique_id = ? LIMIT 1`,
    [abandonReason, failoverDest, uniqueId]
  );
}

/**
 * Set agent status to "Transferring" during an active transfer.
 */
export async function setAgentTransferring(agentId, uniqueId, transferTo) {
  const aid = String(agentId).replace(/\D/g, '');
  if (!aid) return null;
  await query(
    `UPDATE agent_status SET status = 'Transferring', timestamp = NOW() WHERE agent_id = ?`,
    [aid]
  );
  const wbTenantId = await resolveAgentTenantId(aid);
  if (wbTenantId) {
    broadcastToWallboard(wbTenantId, {
      type: 'agent_status',
      payload: { agent_id: aid, status: 'Transferring', transfer_to: transferTo },
    });
    updateRedisAgent(wbTenantId, aid, { status: 'Transferring', transfer_to: transferTo });
  }
  return aid;
}

/**
 * Set agent status to Ringing and broadcast incoming_call to the agent's dashboard.
 * DID/didTfn is for reporting only - not sent to the agent (admin/user see it in wallboard and reports).
 * @param {string} agentId - Extension number or agent_id being rung
 * @param {string|null} [tenantId] - When set, resolve user by bound extension (Option 2: one extension per agent)
 * @param {string|null} [didTfn] - DID/TFN for wallboard/reporting only; not included in agent payload
 */
export async function setAgentRinging(agentId, channelId, customerChannelId, customerNumber, uniqueId, queueName = null, campaignName = null, tenantId = null, didTfn = null) {
  const aid = String(agentId).replace(/\D/g, '');
  if (!aid) return null;

  let userRow = null;
  let aidForUpdate = aid; // agent_id of the row we update (phone_login_number)

  if (tenantId != null && tenantId !== '' && !Number.isNaN(Number(tenantId))) {
    // Bound extension: resolve by sip_extensions.agent_user_id for this tenant + extension
    userRow = await resolveAgentUserByExtensionName(Number(tenantId), aid);
    if (userRow) {
      const agentRow = await queryOne(
        'SELECT phone_login_number FROM users WHERE id = ? AND role = 5 LIMIT 1',
        [userRow.id]
      );
      if (agentRow?.phone_login_number != null) {
        aidForUpdate = String(agentRow.phone_login_number).replace(/\D/g, '');
      }
    }
  }
  if (!userRow) {
    userRow = await resolveAgentUserByExtensionName(null, aid);
  }

  const statusRow = await queryOne(
    "SELECT status FROM agent_status WHERE agent_id = ? LIMIT 1",
    [aidForUpdate]
  );
  const s = (statusRow?.status || '').toString().trim().toLowerCase();
  if (s === 'loggedout' || s === 'loginfailed') return null;
  if (['on call', 'ringing', 'transferring', 'outbound'].includes(s)) {
    console.log('[setAgentRinging] Agent', aidForUpdate, 'already busy (', statusRow.status, ') — skipping');
    return null;
  }
  if (s === 'paused' || s.includes('break')) {
    console.log('[setAgentRinging] Agent', aidForUpdate, 'on break (', statusRow.status, ') — skipping');
    return null;
  }

  await query(
    `UPDATE agent_status SET status = 'Ringing', agent_channel_id = ?, customer_channel_id = ?, customer_number = ?, call_id = ?, queue_name = ?, timestamp = NOW() WHERE agent_id = ?`,
    [channelId || null, customerChannelId || null, customerNumber || null, uniqueId || null, queueName || null, aidForUpdate]
  );
  const userId = userRow ? Number(userRow.id) : null;
  const wbTenantId = tenantId ?? await resolveAgentTenantId(aidForUpdate);
  let agentDisplayNumber = customerNumber || null;
  if (userId && wbTenantId) {
    try {
      const tenantRow = await queryOne('SELECT COALESCE(mask_caller_number_agent, 0) AS mask_caller_number_agent FROM tenants WHERE id = ?', [wbTenantId]);
      if (tenantRow && Number(tenantRow.mask_caller_number_agent) === 1 && agentDisplayNumber) {
        agentDisplayNumber = maskCallerNumberLast4(agentDisplayNumber);
      }
    } catch (_) {}
  }
  if (userId) {
    broadcastToAgent(userId, {
      type: EventTypes.INCOMING_CALL,
      payload: {
        channelId,
        customerChannelId,
        customerNumber: agentDisplayNumber,
        uniqueId,
        queueName: queueName || null,
        campaignName: campaignName || null,
      },
    });
  }
  if (wbTenantId) {
    const wbPayload = { agent_id: aidForUpdate, status: 'Ringing', customer_number: customerNumber, queue_name: queueName };
    if (didTfn != null && didTfn !== '') wbPayload.did_tfn = didTfn;
    broadcastToWallboard(wbTenantId, { type: 'agent_status', payload: wbPayload });
    updateRedisAgent(wbTenantId, aidForUpdate, { status: 'Ringing', customer_number: customerNumber, queue_name: queueName, ...(didTfn != null && didTfn !== '' ? { did_tfn: didTfn } : {}) });
    logAgentStatusChange(wbTenantId, aidForUpdate, 'RINGING');
  }
  return userId;
}

/**
 * Set agent on call (answered) and broadcast call_answered.
 * Increments calls_taken so live monitoring and wallboard show correct count.
 * @param {object} [options] - Optional. direction: 'outbound' to set status to 'Outbound' instead of 'On Call' (for live monitoring).
 */
export async function setAgentAnswered(agentId, uniqueId, options = {}) {
  const aid = String(agentId).replace(/\D/g, '');
  if (!aid) return null;
  const isOutbound = (options && options.direction) === 'outbound';
  const displayStatus = isOutbound ? 'Outbound' : 'On Call';

  await updateCallRecordAnswered(uniqueId);
  const callRow = await queryOne('SELECT queue_name, agent_extension FROM call_records WHERE unique_id = ? LIMIT 1', [uniqueId]);
  if (callRow?.queue_name && callRow?.agent_extension) {
    setQueueLastAgent(callRow.queue_name, callRow.agent_extension);
  }
  await query(
    `UPDATE agent_status SET status = ?, calls_taken = COALESCE(calls_taken, 0) + 1, timestamp = NOW() WHERE agent_id = ?`,
    [displayStatus, aid]
  );
  const userId = await getAgentUserIdByNumber(aid);
  if (userId) {
    broadcastToAgent(userId, {
      type: EventTypes.CALL_ANSWERED,
      payload: { uniqueId },
    });
  }
  const wbTenantId = await resolveAgentTenantId(aid);
  if (wbTenantId) {
    broadcastToWallboard(wbTenantId, {
      type: 'agent_status',
      payload: { agent_id: aid, status: displayStatus },
    });
    updateRedisAgent(wbTenantId, aid, { status: displayStatus });
    logAgentStatusChange(wbTenantId, aid, 'IN_CALL');
  }
  return userId;
}

/**
 * Clear agent call state and broadcast call_ended.
 * If agentId not provided, resolve from call_records.unique_id.
 * @param {object} [options] - Optional. resumeStatus: set agent_status after hangup. skipCallRecordUpdate: if true, only clear agent state (do not set call end/status); use when e.g. trying next agent in queue.
 */
export async function setAgentHangup(agentId, uniqueId, status = 'completed', options = {}) {
  let aid = agentId != null ? String(agentId).replace(/\D/g, '') : null;
  if (!aid) {
    const row = await queryOne('SELECT agent_id FROM call_records WHERE unique_id = ? LIMIT 1', [uniqueId]);
    if (row?.agent_id) aid = String(row.agent_id).replace(/\D/g, '');
  }
  let userId = null;
  if (aid) {
    const userRow = await resolveAgentUserByExtensionName(null, aid);
    userId = userRow ? Number(userRow.id) : null;
  }
  if (!options.skipCallRecordUpdate) {
    await updateCallRecordEnd(uniqueId, status);
  }
  const resumeStatus = (options && options.resumeStatus && String(options.resumeStatus).trim()) || 'LOGGEDIN';
  let newStatus = resumeStatus;
  if (aid) {
    // Only set status to LOGGEDIN (or resumeStatus) if the agent has an active session; otherwise restore LoggedOut
    // so we don't show logged-out agents as Available on live monitoring after a call they shouldn't have received
    const agentRow = await queryOne(
      'SELECT session_started_at FROM agent_status WHERE agent_id = ? LIMIT 1',
      [aid]
    );
    const hadSession = agentRow?.session_started_at != null;
    newStatus = hadSession ? resumeStatus : 'LoggedOut';
    await query(
      `UPDATE agent_status SET status = ?, agent_channel_id = NULL, customer_channel_id = NULL, customer_number = NULL, call_id = NULL, queue_name = NULL, timestamp = NOW() WHERE agent_id = ?`,
      [newStatus, aid]
    );
  }
  if (userId) {
    const payload = { uniqueId, status };
    if (newStatus !== 'LOGGEDIN') payload.nextStatus = newStatus;
    broadcastToAgent(userId, {
      type: EventTypes.CALL_ENDED,
      payload,
    });
  }
  if (aid) {
    const wbTenantId = await resolveAgentTenantId(aid);
    if (wbTenantId) {
      logAgentStatusChange(wbTenantId, aid, mapToLogStatus(newStatus));
      broadcastToWallboard(wbTenantId, {
        type: 'agent_status',
        payload: { agent_id: aid, status: newStatus, customer_number: null },
      });
      if (newStatus === 'LoggedOut') deleteAgentState(wbTenantId, aid).catch(() => {});
      else updateRedisAgent(wbTenantId, aid, { status: newStatus, customer_number: null });
    }
  }
  return userId;
}

/**
 * Notify the target agent (transferee) that a call is being transferred to them.
 * Updates agent_status to Ringing and broadcasts incoming_call with transferFrom so the dashboard shows "Transfer from X".
 * @param {string} targetExtension - Extension being rung (e.g. "7002")
 * @param {string} uniqueId - Call unique_id
 * @param {string} transferFromAgentId - Agent/extension who transferred (e.g. "7001")
 * @param {string} [customerNumber] - Caller number (from call record if not provided)
 * @param {string} [agentChannelId] - Agent2's channel id (login channel) for dashboard call controls
 * @param {string} [customerChannelId] - Customer channel id for dashboard call controls
 * @returns {Promise<number|null>} Target agent user id if notified
 */
export async function notifyTransferredCallToAgent(targetExtension, uniqueId, transferFromAgentId, customerNumber = null, agentChannelId = null, customerChannelId = null) {
  const targetExt = String(targetExtension || '').replace(/\D/g, '');
  const fromAid = String(transferFromAgentId || '').replace(/\D/g, '');
  if (!targetExt || !uniqueId) return null;

  let transferFromName = null;
  if (fromAid) {
    const fromRow = await queryOne(
      'SELECT username FROM users WHERE phone_login_number = ? AND role = 5 LIMIT 1',
      [fromAid]
    );
    if (fromRow?.username) transferFromName = String(fromRow.username).trim();
  }

  const callRow = await queryOne(
    'SELECT source_number, queue_name, campaign_name FROM call_records WHERE unique_id = ? LIMIT 1',
    [uniqueId]
  );
  const customerNum = customerNumber || callRow?.source_number || 'Unknown';
  const queueName = callRow?.queue_name || null;
  const campaignName = callRow?.campaign_name || null;

  let userRow = await resolveAgentUserByExtensionName(null, targetExt);
  let aidForUpdate = targetExt;
  if (userRow) {
    const agentRow = await queryOne(
      'SELECT phone_login_number FROM users WHERE id = ? AND role = 5 LIMIT 1',
      [userRow.id]
    );
    if (agentRow?.phone_login_number != null) {
      aidForUpdate = String(agentRow.phone_login_number).replace(/\D/g, '');
    }
  }

  const statusRow = await queryOne(
    'SELECT status FROM agent_status WHERE agent_id = ? LIMIT 1',
    [aidForUpdate]
  );
  const s = (statusRow?.status || '').toString().trim().toLowerCase();
  if (s === 'loggedout' || s === 'loginfailed') return null;
  if (['on call', 'ringing', 'transferring', 'outbound'].includes(s)) return null;

  await query(
    `UPDATE agent_status SET status = 'Ringing', agent_channel_id = ?, customer_channel_id = ?, call_id = ?, customer_number = ?, queue_name = ?, timestamp = NOW() WHERE agent_id = ?`,
    [agentChannelId || null, customerChannelId || null, uniqueId, customerNum, queueName, aidForUpdate]
  );

  const userId = userRow ? Number(userRow.id) : null;
  const wbTenantId = await resolveAgentTenantId(aidForUpdate);
  let agentDisplayNumber = customerNum;
  if (userId && wbTenantId) {
    try {
      const tenantRow = await queryOne('SELECT COALESCE(mask_caller_number_agent, 0) AS mask_caller_number_agent FROM tenants WHERE id = ?', [wbTenantId]);
      if (tenantRow && Number(tenantRow.mask_caller_number_agent) === 1 && agentDisplayNumber) {
        agentDisplayNumber = maskCallerNumberLast4(agentDisplayNumber);
      }
    } catch (_) {}
  }
  if (userId) {
    broadcastToAgent(userId, {
      type: EventTypes.INCOMING_CALL,
      payload: {
        channelId: agentChannelId || null,
        customerChannelId: customerChannelId || null,
        customerNumber: agentDisplayNumber,
        uniqueId,
        queueName: queueName || null,
        campaignName: campaignName || null,
        isTransferred: true,
        transferFrom: fromAid,
        transferFromName,
      },
    });
  }
  if (wbTenantId) {
    broadcastToWallboard(wbTenantId, {
      type: 'agent_status',
      payload: { agent_id: aidForUpdate, status: 'Ringing', customer_number: customerNum, queue_name: queueName },
    });
    updateRedisAgent(wbTenantId, aidForUpdate, { status: 'Ringing', customer_number: customerNum, queue_name: queueName });
    logAgentStatusChange(wbTenantId, aidForUpdate, 'RINGING');
  }
  return userId;
}

/**
 * Broadcast agent status to the agent's dashboard (e.g. after hold/resume).
 */
export async function broadcastAgentStatus(agentUserId, statusPayload) {
  if (agentUserId) {
    broadcastToAgent(Number(agentUserId), {
      type: EventTypes.AGENT_STATUS,
      payload: statusPayload,
    });
  }
}

/**
 * Update recording path for a call record (from Asterisk callback).
 */
export async function setCallRecording(uniqueId, recordingPath) {
  await query(
    'UPDATE call_records SET recording_path = ? WHERE unique_id = ? LIMIT 1',
    [recordingPath, uniqueId]
  );
}

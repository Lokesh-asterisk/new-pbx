/**
 * Asterisk dialplan callbacks (no auth). Called by Asterisk via curl.
 * Base path: /api/asterisk/
 * Simple paths: AgentLogin, AgentLogout, AgentLoginSuccess, InboundRoute, QueueMembers,
 *   IncomingCall, CallAnswered, CallHangup, Recording.
 */
import express from 'express';
import { query, queryOne } from '../db.js';
import { blacklistMatch } from '../utils/phone.js';
import {
  createCallRecord,
  setAgentRinging,
  setAgentAnswered,
  setAgentHangup,
  setCallRecording,
  updateCallRecordTransfer,
  updateCallRecordAbandon,
} from '../call-handler.js';
import { startAgentSession, endAgentSession } from '../agent-sessions.js';
import { broadcastToWallboard } from '../realtime.js';

const router = express.Router();

function sendResponse(res, hangupCause) {
  const response = `CONTINUE,${hangupCause}`;
  res.set('Content-Type', 'text/plain');
  res.send(response);
}

function parseAgentId(req) {
  const raw = req.query.AgentID ?? req.body?.AgentID ?? '';
  const cleaned = String(raw).replace(/\D/g, '');
  return cleaned ? parseInt(cleaned, 10) : null;
}

async function handleAgentLogin(req, res) {
  try {
    const agentId = parseAgentId(req);
    if (agentId == null) {
      return sendResponse(res, 'LoginInitiated');
    }
    const aid = String(agentId);
    const users = await query(
      'SELECT id, parent_id FROM users WHERE phone_login_number = ? AND role = 5 LIMIT 1',
      [aid]
    );
    const tenantId = users[0]?.parent_id ?? 1;
    await query(
      `INSERT INTO agent_status (agent_id, tenant_id, status, timestamp)
       VALUES (?, ?, 'LoginInitiated', NOW())
       ON DUPLICATE KEY UPDATE status = 'LoginInitiated', timestamp = NOW()`,
      [aid, tenantId]
    );
    sendResponse(res, 'LoginInitiated');
  } catch (err) {
    console.error('Asterisk AgentLogin error:', err);
    sendResponse(res, 'LoginInitiated');
  }
}

async function handleAgentLogout(req, res) {
  try {
    const agentId = parseAgentId(req);
    if (agentId != null) {
      const aid = String(agentId);
      await endAgentSession(aid, 'normal');
      await query(
        `UPDATE agent_status SET status = 'LoginFailed', timestamp = NOW() WHERE agent_id = ?`,
        [aid]
      );
    }
    sendResponse(res, 'LoginFailed');
  } catch (err) {
    console.error('Asterisk AgentLogout error:', err);
    sendResponse(res, 'LoginFailed');
  }
}

async function handleAgentLoginSuccess(req, res) {
  try {
    const agentId = parseAgentId(req);
    if (agentId == null) {
      return sendResponse(res, 'LoginSuccess');
    }
    const aid = String(agentId);
    const userRow = await queryOne('SELECT id, parent_id FROM users WHERE phone_login_number = ? AND role = 5 LIMIT 1', [aid]);
    const tenantId = userRow?.parent_id ?? (await queryOne('SELECT tenant_id FROM agent_status WHERE agent_id = ? LIMIT 1', [aid]))?.tenant_id ?? 1;
    await startAgentSession(tenantId, aid, userRow?.id ?? null);
    // Always start a fresh session on login; clear any stale break state so wallboard shows Ready not Paused
    await query(
      `UPDATE agent_status SET status = 'LOGGEDIN', break_name = NULL, break_started_at = NULL, session_started_at = NOW(), timestamp = NOW() WHERE agent_id = ?`,
      [aid]
    );
    await query(
      `UPDATE users SET soft_phone_login_status = 1 WHERE phone_login_number = ? LIMIT 1`,
      [aid]
    );
    const tenantRow = await queryOne('SELECT tenant_id FROM agent_status WHERE agent_id = ? LIMIT 1', [aid]);
    if (tenantRow?.tenant_id) broadcastToWallboard(tenantRow.tenant_id, { type: 'agent_status', payload: { agent_id: aid, status: 'LOGGEDIN', break_name: null, break_started_at: null } });
    sendResponse(res, 'LoginSuccess');
  } catch (err) {
    console.error('Asterisk AgentLoginSuccess error:', err);
    sendResponse(res, 'LoginSuccess');
  }
}

router.get('/AgentLogin', handleAgentLogin);
router.get('/US4GROUP_Agent/AgentLogin', handleAgentLogin);
router.get('/AgentLogout', handleAgentLogout);
router.get('/US4GROUP_Agent/AgentLogout', handleAgentLogout);
router.get('/AgentLoginSuccess', handleAgentLoginSuccess);
router.get('/US4GROUP_Agent/AgentLoginSuccess', handleAgentLoginSuccess);

// Normalize caller number for blacklist lookup (digits only).
function normalizeCallerNumber(raw) {
  if (raw == null || typeof raw !== 'string') return '';
  return raw.replace(/\D/g, '');
}

// ----- Inbound route lookup (for standalone dialplan) -----
// Returns: CallStatus,Destination_Action,Destination_Value,UserID,CDRID,CampaignName
// CampaignName is URL-encoded (no commas) for dialplan parsing.
// If caller number is in blacklist for this tenant, returns HANGUP so dialplan drops the call.
router.get('/InboundRoute', async (req, res) => {
  try {
    const did = (req.query.DID ?? req.query.did ?? '').toString().replace(/\D/g, '');
    const callerNumber = (req.query.CallerNumber ?? req.query.Caller ?? '').toString().trim();
    const callUniqueId = (req.query.CallUniqueID ?? req.query.UniqueID ?? '').toString().trim() || 'unknown';
    if (!did) {
      res.set('Content-Type', 'text/plain');
      return res.send('HANGUP,0,,,');
    }
    let route = null;
    try {
      route = await queryOne(
        `SELECT ir.id, ir.tenant_id, ir.destination_type, ir.destination_id, c.name AS campaign_name
         FROM inbound_routes ir
         LEFT JOIN campaigns c ON c.id = ir.campaign_id
         WHERE REPLACE(REPLACE(REPLACE(REPLACE(ir.did, ' ', ''), '-', ''), '+', ''), '.', '') = ? LIMIT 1`,
        [did]
      );
    } catch (_) {
      route = await queryOne(
        `SELECT id, tenant_id, destination_type, destination_id FROM inbound_routes
         WHERE REPLACE(REPLACE(REPLACE(REPLACE(did, ' ', ''), '-', ''), '+', ''), '.', '') = ? LIMIT 1`,
        [did]
      );
      if (route) route.campaign_name = null;
    }
    if (!route) {
      res.set('Content-Type', 'text/plain');
      return res.send(`HANGUP,0,,,${callUniqueId}`);
    }
    const tenantId = route.tenant_id;

    // Blacklist: block by exact or pattern (prefix, suffix, contains, regex); log blocked calls for reporting
    const normalizedCaller = normalizeCallerNumber(callerNumber);
    if (normalizedCaller) {
      try {
        let blacklistRows;
        try {
          blacklistRows = await query(
            'SELECT id, number, match_type FROM blacklist WHERE tenant_id = ?',
            [tenantId]
          );
        } catch (e) {
          if (e?.code === 'ER_BAD_FIELD_ERROR') {
            blacklistRows = await query('SELECT id, number FROM blacklist WHERE tenant_id = ? AND number = ?', [tenantId, normalizedCaller]);
            if (blacklistRows?.length) {
              try {
                await query(
                  'INSERT INTO blacklist_blocked_calls (tenant_id, caller_number, did, blacklist_entry_id) VALUES (?, ?, ?, ?)',
                  [tenantId, normalizedCaller, did || null, blacklistRows[0].id]
                );
              } catch (_) {}
              res.set('Content-Type', 'text/plain');
              return res.send(`HANGUP,0,,,${callUniqueId}`);
            }
          }
          blacklistRows = [];
        }
        for (const row of blacklistRows || []) {
          const matchType = (row.match_type || 'exact').toLowerCase();
          if (blacklistMatch(normalizedCaller, row.number, matchType)) {
            try {
              await query(
                'INSERT INTO blacklist_blocked_calls (tenant_id, caller_number, did, blacklist_entry_id) VALUES (?, ?, ?, ?)',
                [tenantId, normalizedCaller, did || null, row.id]
              );
            } catch (_) {}
            res.set('Content-Type', 'text/plain');
            return res.send(`HANGUP,0,,,${callUniqueId}`);
          }
        }
      } catch (_) {
        // blacklist table may not exist yet
      }
    }
    const destType = (route.destination_type || '').toLowerCase();
    const destId = route.destination_id;
    const ACTION_MAP = { hangup: '0', announcement: '1', queue: '2', ivr: '3', voicemail: '4', timecondition: '5', extension: '9', exten: '9' };
    let action = ACTION_MAP[destType] || '0';
    let value = destId || '';
    if (destType === 'queue' && destId) {
      const q = await queryOne('SELECT name FROM queues WHERE id = ? AND tenant_id = ? LIMIT 1', [destId, tenantId]);
      if (q?.name) value = q.name;
      else action = '0';
    } else if ((destType === 'extension' || destType === 'exten') && destId) {
      const ext = await queryOne('SELECT name FROM sip_extensions WHERE id = ? AND tenant_id = ? LIMIT 1', [destId, tenantId]);
      if (ext?.name) value = ext.name;
      else action = '0';
    }
    const campaignName = (route.campaign_name != null && String(route.campaign_name).trim() !== '')
      ? encodeURIComponent(String(route.campaign_name).trim())
      : '';
    res.set('Content-Type', 'text/plain');
    res.send(`OK,${action},${value},${tenantId},${callUniqueId},${campaignName}`);
  } catch (err) {
    console.error('InboundRoute error:', err);
    res.set('Content-Type', 'text/plain');
    res.send('HANGUP,0,,,');
  }
});

// Queue members list for dialplan (try agents in order). Returns comma-separated extension numbers.
// Only returns agents who are logged in, not outbound, and not currently on a call (default for all queues).
router.get('/QueueMembers', async (req, res) => {
  try {
    const queueName = (req.query.QueueName ?? req.query.QueueID ?? '').toString().trim();
    if (!queueName) {
      res.set('Content-Type', 'text/plain');
      return res.send('');
    }
    const rows = await query(
      'SELECT member_name FROM queue_members WHERE queue_name = ? AND (paused = 0 OR paused IS NULL) ORDER BY member_name',
      [queueName]
    );
    let list = (rows || []).map((r) => String(r.member_name || '').trim()).filter(Boolean);
    if (list.length > 0) {
      const allRows = await query(
        "SELECT agent_id, extension_number, status FROM agent_status"
      );
      const availableIds = new Set();
      const busyIds = new Set();
      for (const r of allRows || []) {
        const ext = String(r.extension_number || '').trim();
        const aid = String(r.agent_id || '').trim();
        const st = (r.status || '').toString().trim();
        const stLower = st.toLowerCase();
        if (stLower === 'loggedout' || stLower === 'loginfailed' || stLower === 'logininitiated' || stLower === 'sip phone ringing') continue;
        if (['On Call', 'Ringing', 'Transferring', 'Outbound'].includes(st)) {
          if (ext) busyIds.add(ext);
          if (aid) busyIds.add(aid);
        } else {
          if (ext) availableIds.add(ext);
          if (aid) availableIds.add(aid);
        }
      }
      list = list.filter((m) => availableIds.has(m) && !busyIds.has(m));
    }
    res.set('Content-Type', 'text/plain');
    res.send(list.join('&'));
  } catch (err) {
    console.error('QueueMembers error:', err);
    res.set('Content-Type', 'text/plain');
    res.send('');
  }
});

// QueueFailover - returns Destination_Action,Destination_Value for queue failover (no agents / no answer / timeout).
// Used by ARI Stasis app to redirect customer to another queue/extension/IVR/announcement/voicemail/timecondition or hangup.
router.get('/QueueFailover', async (req, res) => {
  try {
    const queueName = (req.query.QueueName ?? req.query.QueueID ?? '').toString().trim();
    if (!queueName) {
      res.set('Content-Type', 'text/plain');
      return res.send('HANGUP,0,');
    }
    const queue = await queryOne(
      'SELECT id, tenant_id, failover_destination_type, failover_destination_id FROM queues WHERE name = ? LIMIT 1',
      [queueName]
    );
    if (!queue) {
      res.set('Content-Type', 'text/plain');
      return res.send('HANGUP,0,');
    }
    const destType = (queue.failover_destination_type || 'hangup').toLowerCase();
    const destId = queue.failover_destination_id;
    const tenantId = queue.tenant_id;
    const ACTION_MAP = { hangup: '0', announcement: '1', queue: '2', ivr: '3', voicemail: '4', timecondition: '5', extension: '9', exten: '9' };
    let action = ACTION_MAP[destType] || '0';
    let value = destId != null ? String(destId) : '';
    if (destType === 'hangup' || !destId) {
      res.set('Content-Type', 'text/plain');
      return res.send(`HANGUP,0,`);
    }
    if (destType === 'queue') {
      const q = await queryOne('SELECT name FROM queues WHERE id = ? AND tenant_id = ? LIMIT 1', [destId, tenantId]);
      if (q?.name) value = q.name;
      else action = '0';
    } else if (destType === 'extension' || destType === 'exten') {
      const ext = await queryOne('SELECT name FROM sip_extensions WHERE id = ? AND tenant_id = ? LIMIT 1', [destId, tenantId]);
      if (ext?.name) value = ext.name;
      else action = '0';
    }
    res.set('Content-Type', 'text/plain');
    res.send(`OK,${action},${value}`);
  } catch (err) {
    console.error('QueueFailover error:', err);
    res.set('Content-Type', 'text/plain');
    res.send('HANGUP,0,');
  }
});

// ExtensionFailover - returns Destination_Action,Destination_Value for extension no-answer failover.
// Used by dialplan after Dial(PJSIP/ext) when DIALSTATUS is NOANSWER/BUSY/CHANUNAVAIL.
router.get('/ExtensionFailover', async (req, res) => {
  try {
    const extName = (req.query.ExtensionName ?? req.query.ExtensionID ?? req.query.name ?? '').toString().trim();
    const extId = parseInt((req.query.ExtensionId ?? req.query.id ?? ''), 10);
    let ext = null;
    if (extName) {
      ext = await queryOne(
        'SELECT id, tenant_id, failover_destination_type, failover_destination_id FROM sip_extensions WHERE name = ? LIMIT 1',
        [extName]
      );
    } else if (extId && !isNaN(extId)) {
      ext = await queryOne(
        'SELECT id, tenant_id, failover_destination_type, failover_destination_id FROM sip_extensions WHERE id = ? LIMIT 1',
        [extId]
      );
    }
    if (!ext || !ext.failover_destination_id) {
      res.set('Content-Type', 'text/plain');
      return res.send('HANGUP,0,');
    }
    const destType = (ext.failover_destination_type || 'hangup').toLowerCase();
    if (destType === 'hangup') {
      res.set('Content-Type', 'text/plain');
      return res.send('HANGUP,0,');
    }
    const destId = ext.failover_destination_id;
    const tenantId = ext.tenant_id;
    const ACTION_MAP = { hangup: '0', announcement: '1', queue: '2', ivr: '3', voicemail: '4', timecondition: '5', extension: '9', exten: '9' };
    let action = ACTION_MAP[destType] || '0';
    let value = String(destId);
    if (destType === 'queue') {
      const q = await queryOne('SELECT name FROM queues WHERE id = ? AND tenant_id = ? LIMIT 1', [destId, tenantId]);
      if (q?.name) value = q.name;
      else action = '0';
    } else if (destType === 'extension' || destType === 'exten') {
      const e = await queryOne('SELECT name FROM sip_extensions WHERE id = ? AND tenant_id = ? LIMIT 1', [destId, tenantId]);
      if (e?.name) value = e.name;
      else action = '0';
    }
    res.set('Content-Type', 'text/plain');
    res.send(`OK,${action},${value}`);
  } catch (err) {
    console.error('ExtensionFailover error:', err);
    res.set('Content-Type', 'text/plain');
    res.send('HANGUP,0,');
  }
});

// ----- Phase 3: Call events (dialplan can call these via curl) -----
function parseQuery(req, key) {
  const v = req.query[key] ?? req.body?.[key];
  return v != null ? String(v).trim() : null;
}

// IncomingCall - when a call is offered to an agent (queue or direct). Creates CDR and broadcasts incoming_call.
// Optional CampaignName (from inbound route) is shown to the agent for identification.
router.all('/IncomingCall', async (req, res) => {
  try {
    const agentId = parseQuery(req, 'AgentID') || parseQuery(req, 'agent_id');
    const uniqueId = parseQuery(req, 'UniqueID') || parseQuery(req, 'unique_id');
    const channelId = parseQuery(req, 'ChannelID') || parseQuery(req, 'channel_id');
    const customerChannelId = parseQuery(req, 'CustomerChannelID') || parseQuery(req, 'customer_channel_id');
    const customerNumber = parseQuery(req, 'CustomerNumber') || parseQuery(req, 'customer_number') || parseQuery(req, 'CallerID');
    const queueName = parseQuery(req, 'QueueName') || parseQuery(req, 'queue_name');
    let campaignName = parseQuery(req, 'CampaignName') || parseQuery(req, 'campaign_name') || parseQuery(req, 'campaignname');
    if (campaignName && campaignName.includes('%')) {
      try { campaignName = decodeURIComponent(campaignName); } catch (_) {}
    }
    const did = parseQuery(req, 'DID') || parseQuery(req, 'did') || null;
    if (!agentId || !uniqueId) {
      res.status(400).json({ ok: false, error: 'AgentID and UniqueID required' });
      return;
    }
    const aid = String(agentId).replace(/\D/g, '');
    let tenantId = null;
    if (queueName) {
      const q = await queryOne('SELECT tenant_id FROM queues WHERE name = ? LIMIT 1', [queueName]);
      tenantId = q?.tenant_id ?? null;
    }
    const userRow = (tenantId != null ? await queryOne(
      'SELECT u.id, u.parent_id FROM sip_extensions e INNER JOIN users u ON u.id = e.agent_user_id AND u.role = 5 WHERE e.tenant_id = ? AND e.name = ? AND e.agent_user_id IS NOT NULL LIMIT 1',
      [tenantId, aid]
    ) : null) || await queryOne(
      'SELECT id, parent_id FROM users WHERE phone_login_number = ? AND role = 5 LIMIT 1',
      [aid]
    );
    if (tenantId == null && userRow) tenantId = userRow.parent_id;
    const resolvedTenantId = userRow?.parent_id ?? 1;
    await createCallRecord({
      tenantId: resolvedTenantId,
      uniqueId,
      channelId,
      sourceNumber: customerNumber,
      destinationNumber: aid,
      direction: 'inbound',
      queueName,
      campaignName: campaignName || null,
      didTfn: did || null,
      agentUserId: userRow?.id ?? null,
      agentExtension: aid,
      agentId: aid,
    });
    await setAgentRinging(aid, channelId, customerChannelId, customerNumber, uniqueId, queueName, campaignName, tenantId ?? resolvedTenantId, did || null);
    res.json({ ok: true });
  } catch (err) {
    console.error('Asterisk IncomingCall error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// CallAnswered - when agent answers the call
router.all('/CallAnswered', async (req, res) => {
  try {
    const agentId = parseQuery(req, 'AgentID') || parseQuery(req, 'agent_id');
    const uniqueId = parseQuery(req, 'UniqueID') || parseQuery(req, 'unique_id');
    if (!agentId || !uniqueId) {
      res.status(400).json({ ok: false, error: 'AgentID and UniqueID required' });
      return;
    }
    await setAgentAnswered(String(agentId).replace(/\D/g, ''), uniqueId);
    res.json({ ok: true });
  } catch (err) {
    console.error('Asterisk CallAnswered error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// TransferredCallAnswered - when a transferred call is answered by the target extension (from TMain Dial M()).
// AgentID = target extension; UniqueID = call unique_id. Updates target agent to On Call and broadcasts call_answered.
router.all('/TransferredCallAnswered', async (req, res) => {
  try {
    const agentId = parseQuery(req, 'AgentID') || parseQuery(req, 'agent_id');
    const uniqueId = parseQuery(req, 'UniqueID') || parseQuery(req, 'unique_id');
    if (!agentId || !uniqueId) {
      res.status(400).json({ ok: false, error: 'AgentID and UniqueID required' });
      return;
    }
    await setAgentAnswered(String(agentId).replace(/\D/g, ''), uniqueId);
    res.json({ ok: true });
  } catch (err) {
    console.error('Asterisk TransferredCallAnswered error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// CallHangup - when call ends (dialplan or channel hangup).
// Status is normalized in call-handler: exitempty, timeout, noanswer, abandon, etc. → abandoned; completed/answer → completed; busy/failed → failed; transferred → transferred.
// Transfer params: TransferFrom, TransferTo, TransferType (agent_to_agent, agent_to_extension, agent_to_queue, agent_to_ivr, blind, attended)
// Abandon params: AbandonReason (caller_hangup, queue_timeout, failover, no_agents, ring_timeout), FailoverDest
router.all('/CallHangup', async (req, res) => {
  try {
    const agentId = parseQuery(req, 'AgentID') || parseQuery(req, 'agent_id');
    const uniqueId = parseQuery(req, 'UniqueID') || parseQuery(req, 'unique_id');
    const status = parseQuery(req, 'Status') || parseQuery(req, 'status') || 'completed';
    const transferFrom = parseQuery(req, 'TransferFrom') || parseQuery(req, 'transfer_from') || agentId;
    const transferTo = parseQuery(req, 'TransferTo') || parseQuery(req, 'transfer_to') || parseQuery(req, 'TransferAgent') || parseQuery(req, 'transfer_agent');
    const transferType = parseQuery(req, 'TransferType') || parseQuery(req, 'transfer_type');
    const abandonReason = parseQuery(req, 'AbandonReason') || parseQuery(req, 'abandon_reason');
    const failoverDest = parseQuery(req, 'FailoverDest') || parseQuery(req, 'failover_dest');
    if (!uniqueId) {
      res.status(400).json({ ok: false, error: 'UniqueID required' });
      return;
    }
    if (status === 'transferred' && transferTo) {
      await updateCallRecordTransfer(uniqueId, {
        transferFrom: transferFrom ? String(transferFrom).replace(/\D/g, '') : null,
        transferTo: String(transferTo).replace(/\D/g, ''),
        transferType: transferType || 'blind',
      }).catch(() => {});
    }
    if ((status === 'abandoned' || status === 'exitempty' || status === 'timeout' || status === 'noanswer') && abandonReason) {
      await updateCallRecordAbandon(uniqueId, abandonReason, failoverDest).catch(() => {});
      await setAgentHangup(agentId != null ? String(agentId).replace(/\D/g, '') : null, uniqueId, 'abandoned', { skipCallRecordUpdate: true });
    } else {
      await setAgentHangup(agentId != null ? String(agentId).replace(/\D/g, '') : null, uniqueId, status);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Asterisk CallHangup error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Recording - store recording path for a call (e.g. from MixMonitor or dialplan)
router.all('/Recording', async (req, res) => {
  try {
    const uniqueId = parseQuery(req, 'UniqueID') || parseQuery(req, 'unique_id');
    const path = parseQuery(req, 'Path') || parseQuery(req, 'path') || parseQuery(req, 'recording_path');
    if (!uniqueId || !path) {
      res.status(400).json({ ok: false, error: 'UniqueID and Path required' });
      return;
    }
    await setCallRecording(uniqueId, path);
    res.json({ ok: true });
  } catch (err) {
    console.error('Asterisk Recording error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==========================================================================
// Phase 2: IVR, Time Condition, Voicemail, Sound File callbacks
// ==========================================================================

// IVRDetail - returns IVR config for dialplan (type, greeting, timeouts, valid keys, destinations)
router.get('/IVRDetail', async (req, res) => {
  try {
    const ivrId = parseInt((req.query.IVRID ?? req.query.ivr_id ?? ''), 10);
    if (!ivrId || isNaN(ivrId)) {
      res.set('Content-Type', 'text/plain');
      return res.send('ERROR,IVR not found');
    }
    const menu = await queryOne('SELECT id, tenant_id, name, config_json FROM ivr_menus WHERE id = ? LIMIT 1', [ivrId]);
    if (!menu) {
      res.set('Content-Type', 'text/plain');
      return res.send('ERROR,IVR not found');
    }
    let cfg = menu.config_json;
    if (cfg && typeof cfg === 'string') {
      try { cfg = JSON.parse(cfg); } catch { cfg = {}; }
    }
    if (!cfg || typeof cfg !== 'object') cfg = {};
    const options = await query(
      'SELECT dtmf_key, destination_type, destination_id FROM ivr_menu_options WHERE ivr_menu_id = ? ORDER BY dtmf_key',
      [ivrId]
    );
    const validKeys = options.map(o => o.dtmf_key).join('');
    let greetingPath = '';
    if (cfg.welcome_sound_id) {
      const sf = await queryOne('SELECT file_path FROM sound_files WHERE id = ? LIMIT 1', [cfg.welcome_sound_id]);
      if (sf?.file_path) greetingPath = sf.file_path;
    }
    const ACTION_MAP_IVR = { hangup: '0', announcement: '1', queue: '2', ivr: '3', voicemail: '4', timecondition: '5', extension: '9' };
    async function resolveDestValue(destType, destId) {
      if (!destId) return '';
      const dt = (destType || '').toLowerCase();
      if (dt === 'queue') {
        const q = await queryOne('SELECT name FROM queues WHERE id = ? LIMIT 1', [destId]);
        return q?.name || destId;
      }
      if (dt === 'extension' || dt === 'exten') {
        const ext = await queryOne('SELECT name FROM sip_extensions WHERE id = ? LIMIT 1', [destId]);
        return ext?.name || destId;
      }
      return destId;
    }
    const defaultVal = await resolveDestValue(cfg.default_destination_type, cfg.default_destination_id);
    const noinputVal = await resolveDestValue(cfg.noinput_destination_type, cfg.noinput_destination_id);
    const invalidVal = await resolveDestValue(cfg.invalid_destination_type, cfg.invalid_destination_id);
    // Format: OK,type,greetingPath,validKeys,timeout,noinputRetries,invalidRetries,defaultDestAction,defaultDestValue,noinputDestAction,noinputDestValue,invalidDestAction,invalidDestValue
    const parts = [
      'OK',
      cfg.type || 'dtmf',
      greetingPath,
      validKeys,
      cfg.timeout || 5,
      cfg.noinput_retries || 3,
      cfg.invalid_retries || 3,
      ACTION_MAP_IVR[(cfg.default_destination_type || 'hangup').toLowerCase()] || '0',
      defaultVal,
      ACTION_MAP_IVR[(cfg.noinput_destination_type || 'hangup').toLowerCase()] || '0',
      noinputVal,
      ACTION_MAP_IVR[(cfg.invalid_destination_type || 'hangup').toLowerCase()] || '0',
      invalidVal,
    ];
    res.set('Content-Type', 'text/plain');
    res.send(parts.join(','));
  } catch (err) {
    console.error('IVRDetail error:', err);
    res.set('Content-Type', 'text/plain');
    res.send('ERROR,Internal error');
  }
});

// IVROptionRoute - returns destination for a specific DTMF key press in an IVR
router.get('/IVROptionRoute', async (req, res) => {
  try {
    const ivrId = parseInt((req.query.IVRID ?? req.query.ivr_id ?? ''), 10);
    const key = String(req.query.Key ?? req.query.key ?? '').trim();
    if (!ivrId || !key) {
      res.set('Content-Type', 'text/plain');
      return res.send('HANGUP,0,');
    }
    const opt = await queryOne(
      'SELECT destination_type, destination_id FROM ivr_menu_options WHERE ivr_menu_id = ? AND dtmf_key = ? LIMIT 1',
      [ivrId, key]
    );
    if (!opt) {
      res.set('Content-Type', 'text/plain');
      return res.send('HANGUP,0,');
    }
    const destType = (opt.destination_type || 'hangup').toLowerCase();
    const ACTION_MAP = { hangup: '0', announcement: '1', queue: '2', ivr: '3', voicemail: '4', timecondition: '5', extension: '9' };
    const action = ACTION_MAP[destType] || '0';
    let value = opt.destination_id || '';
    if (destType === 'queue' && opt.destination_id) {
      const q = await queryOne('SELECT name FROM queues WHERE id = ? LIMIT 1', [opt.destination_id]);
      if (q?.name) value = q.name;
    } else if ((destType === 'extension' || destType === 'exten') && opt.destination_id) {
      const ext = await queryOne('SELECT name FROM sip_extensions WHERE id = ? LIMIT 1', [opt.destination_id]);
      if (ext?.name) value = ext.name;
    }
    res.set('Content-Type', 'text/plain');
    res.send(`OK,${action},${value}`);
  } catch (err) {
    console.error('IVROptionRoute error:', err);
    res.set('Content-Type', 'text/plain');
    res.send('HANGUP,0,');
  }
});

// TimeCondition - evaluates current time against rules, returns match/nomatch destination
router.get('/TimeCondition', async (req, res) => {
  try {
    const tcId = parseInt((req.query.TCID ?? req.query.tc_id ?? req.query.TimeConditionID ?? ''), 10);
    if (!tcId || isNaN(tcId)) {
      res.set('Content-Type', 'text/plain');
      return res.send('HANGUP,0,');
    }
    const tc = await queryOne(
      `SELECT tc.id, tc.time_group_id, tc.match_destination_type, tc.match_destination_id,
              tc.nomatch_destination_type, tc.nomatch_destination_id
       FROM time_conditions tc WHERE tc.id = ? LIMIT 1`,
      [tcId]
    );
    if (!tc) {
      res.set('Content-Type', 'text/plain');
      return res.send('HANGUP,0,');
    }
    let matched = false;
    if (tc.time_group_id) {
      const rules = await query(
        'SELECT day_of_week, start_time, end_time FROM time_group_rules WHERE time_group_id = ?',
        [tc.time_group_id]
      );
      const now = new Date();
      const currentDay = now.getDay();
      const currentTimeStr = now.toTimeString().substring(0, 8);
      for (const rule of rules) {
        const dayMatch = rule.day_of_week == null || Number(rule.day_of_week) === currentDay;
        const startMatch = !rule.start_time || currentTimeStr >= rule.start_time;
        const endMatch = !rule.end_time || currentTimeStr <= rule.end_time;
        if (dayMatch && startMatch && endMatch) {
          matched = true;
          break;
        }
      }
    }
    const destType = matched ? tc.match_destination_type : tc.nomatch_destination_type;
    const destId = matched ? tc.match_destination_id : tc.nomatch_destination_id;
    const ACTION_MAP = { hangup: '0', announcement: '1', queue: '2', ivr: '3', voicemail: '4', timecondition: '5', extension: '9' };
    const action = ACTION_MAP[(destType || 'hangup').toLowerCase()] || '0';
    let value = destId || '';
    if ((destType || '').toLowerCase() === 'queue' && destId) {
      const q = await queryOne('SELECT name FROM queues WHERE id = ? LIMIT 1', [destId]);
      if (q?.name) value = q.name;
    } else if (((destType || '').toLowerCase() === 'extension' || (destType || '').toLowerCase() === 'exten') && destId) {
      const ext = await queryOne('SELECT name FROM sip_extensions WHERE id = ? LIMIT 1', [destId]);
      if (ext?.name) value = ext.name;
    }
    res.set('Content-Type', 'text/plain');
    res.send(`OK,${action},${value}`);
  } catch (err) {
    console.error('TimeCondition error:', err);
    res.set('Content-Type', 'text/plain');
    res.send('HANGUP,0,');
  }
});

// VoicemailDetail - returns voicemail box greeting path and max duration
router.get('/VoicemailDetail', async (req, res) => {
  try {
    const vmId = parseInt((req.query.VMID ?? req.query.vm_id ?? ''), 10);
    if (!vmId || isNaN(vmId)) {
      res.set('Content-Type', 'text/plain');
      return res.send('ERROR,Voicemail not found');
    }
    const vm = await queryOne('SELECT id, mailbox, config_json FROM voicemail_boxes WHERE id = ? LIMIT 1', [vmId]);
    if (!vm) {
      res.set('Content-Type', 'text/plain');
      return res.send('ERROR,Voicemail not found');
    }
    let cfg = vm.config_json;
    if (cfg && typeof cfg === 'string') {
      try { cfg = JSON.parse(cfg); } catch { cfg = {}; }
    }
    if (!cfg || typeof cfg !== 'object') cfg = {};
    let greetingPath = '';
    if (cfg.greeting_sound_id) {
      const sf = await queryOne('SELECT file_path FROM sound_files WHERE id = ? LIMIT 1', [cfg.greeting_sound_id]);
      if (sf?.file_path) greetingPath = sf.file_path;
    }
    const maxDuration = cfg.max_duration || 120;
    res.set('Content-Type', 'text/plain');
    res.send(`OK,${vm.mailbox},${greetingPath},${maxDuration}`);
  } catch (err) {
    console.error('VoicemailDetail error:', err);
    res.set('Content-Type', 'text/plain');
    res.send('ERROR,Internal error');
  }
});

// SoundFilePath - returns file system path for a sound file ID (used by Playback())
router.get('/SoundFilePath', async (req, res) => {
  try {
    const sfId = parseInt((req.query.SoundID ?? req.query.sound_id ?? ''), 10);
    if (!sfId || isNaN(sfId)) {
      res.set('Content-Type', 'text/plain');
      return res.send('');
    }
    const sf = await queryOne('SELECT file_path FROM sound_files WHERE id = ? LIMIT 1', [sfId]);
    res.set('Content-Type', 'text/plain');
    res.send(sf?.file_path || '');
  } catch (err) {
    console.error('SoundFilePath error:', err);
    res.set('Content-Type', 'text/plain');
    res.send('');
  }
});

export default router;

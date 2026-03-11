import express from 'express';
import { query, queryOne } from '../../db.js';
import { originateIntoStasis, originateToContext, getQueueStasisAppName, isAriConfigured } from '../../asterisk-ari.js';
import { getBridgedCallInfo, forceLogoutAgent } from '../../ari-stasis-queue.js';
import { destroySessionsForUser } from '../../session-utils.js';
import { endAgentSession } from '../../agent-sessions.js';
import { validate, monitorSchema } from '../../utils/schemas.js';
import { getEffectiveTenantId, requireSuperadmin } from './middleware.js';

const router = express.Router();

router.get('/live-agents', async (req, res) => {
  try {
    const effectiveTenantId = getEffectiveTenantId(req);
    const tenantIdParam = effectiveTenantId != null ? String(effectiveTenantId) : req.query.tenant_id;
    let tenantFilter = '';
    const params = [];

    if (tenantIdParam != null && tenantIdParam !== '' && tenantIdParam !== 'all') {
      const tid = parseInt(tenantIdParam, 10);
      if (!Number.isNaN(tid) && tid >= 1) {
        tenantFilter = 'AND u.parent_id = ?';
        params.push(tid);
      }
    }

    let agentRows;
    const selectWithBreakStarted = `SELECT u.id AS user_id, u.username, u.phone_login_name, u.phone_login_number,
              u.parent_id AS tenant_id, u.account_status, u.soft_phone_login_status,
              a.agent_id, a.status, a.break_name, a.break_started_at, a.queue_name,
              a.customer_number, a.calls_taken, a.extension_number,
              a.session_started_at, a.call_id, a.timestamp,
              t.name AS tenant_name
       FROM users u
       LEFT JOIN agent_status a ON a.agent_id = u.phone_login_number
       LEFT JOIN tenants t ON t.id = u.parent_id
       WHERE u.role = 5 ${tenantFilter}
       ORDER BY
         CASE
           WHEN a.status IS NULL OR a.status IN ('LoggedOut','LoginFailed') THEN 2
           WHEN a.status = 'On Call' THEN 0
           WHEN a.status = 'Ringing' THEN 0
           ELSE 1
         END,
         a.timestamp DESC,
         u.username ASC`;
    const selectWithoutBreakStarted = `SELECT u.id AS user_id, u.username, u.phone_login_name, u.phone_login_number,
              u.parent_id AS tenant_id, u.account_status, u.soft_phone_login_status,
              a.agent_id, a.status, a.break_name, a.queue_name,
              a.customer_number, a.calls_taken, a.extension_number,
              a.session_started_at, a.call_id, a.timestamp,
              t.name AS tenant_name
       FROM users u
       LEFT JOIN agent_status a ON a.agent_id = u.phone_login_number
       LEFT JOIN tenants t ON t.id = u.parent_id
       WHERE u.role = 5 ${tenantFilter}
       ORDER BY
         CASE
           WHEN a.status IS NULL OR a.status IN ('LoggedOut','LoginFailed') THEN 2
           WHEN a.status = 'On Call' THEN 0
           WHEN a.status = 'Ringing' THEN 0
           ELSE 1
         END,
         a.timestamp DESC,
         u.username ASC`;
    try {
      agentRows = await query(selectWithBreakStarted, params);
    } catch (e) {
      if (e?.code === 'ER_BAD_FIELD_ERROR' && e?.message?.includes('break_started_at')) {
        agentRows = await query(selectWithoutBreakStarted, params);
        agentRows.forEach((r) => { r.break_started_at = null; });
      } else {
        throw e;
      }
    }

    let breaksByAgent = [];
    try {
      const tenantIds = [...new Set(agentRows.map((r) => r.tenant_id).filter(Boolean))];
      if (tenantIds.length > 0) {
        const placeholders = tenantIds.map(() => '?').join(',');
        breaksByAgent = await query(
          `SELECT agent_id, start_time, end_time
           FROM session_agent_breaks
           WHERE tenant_id IN (${placeholders}) AND start_time >= DATE_SUB(NOW(), INTERVAL 25 HOUR)`,
          tenantIds
        );
      }
    } catch (e) {
      if (e?.code !== 'ER_NO_SUCH_TABLE') throw e;
    }

    let activeCallMap = {};
    try {
      const callRowsWhere = effectiveTenantId != null ? 'WHERE end_time IS NULL AND status IN (\'ringing\', \'answered\') AND tenant_id = ? AND DATE(start_time) = CURDATE()' : 'WHERE end_time IS NULL AND status IN (\'ringing\', \'answered\') AND DATE(start_time) = CURDATE()';
    const callRowsParams = effectiveTenantId != null ? [effectiveTenantId] : [];
    const callRows = await query(
        `SELECT agent_id, direction, source_number, destination_number, did_tfn, queue_name, start_time
         FROM call_records
         ${callRowsWhere}
         ORDER BY start_time DESC`,
        callRowsParams
      );
      for (const c of callRows) {
        if (c.agent_id && !activeCallMap[c.agent_id]) {
          activeCallMap[c.agent_id] = c;
        }
      }
    } catch {
      // call_records table may not exist
    }

    const now = new Date();
    const agents = agentRows.map((r) => {
      const agentId = r.phone_login_number || r.agent_id || String(r.user_id);
      const call = activeCallMap[agentId] || null;
      const status = r.status || (r.account_status === 0 ? 'Disabled' : 'LoggedOut');
      const sessionStart = r.session_started_at ? new Date(r.session_started_at) : null;
      let totalBreakSec = 0;
      for (const b of breaksByAgent) {
        if (b.agent_id !== r.user_id) continue;
        const start = new Date(b.start_time);
        if (sessionStart && start < sessionStart) continue;
        const end = new Date(b.end_time);
        totalBreakSec += Math.max(0, Math.floor((end - start) / 1000));
      }
      if (r.break_started_at) {
        totalBreakSec += Math.max(0, Math.floor((now - new Date(r.break_started_at)) / 1000));
      }
      return {
        agent_id: agentId,
        user_id: r.user_id,
        name: r.phone_login_name || r.username || agentId,
        extension: r.extension_number || r.phone_login_number || null,
        status,
        break_name: r.break_name || null,
        break_started_at: r.break_started_at || null,
        queue_name: r.queue_name || null,
        customer_number: r.customer_number || null,
        calls_taken: r.calls_taken || 0,
        session_started_at: r.session_started_at || null,
        total_break_session_sec: totalBreakSec,
        timestamp: r.timestamp || null,
        tenant_id: r.tenant_id,
        tenant_name: r.tenant_name || null,
        call_direction: call?.direction || null,
        call_source: call?.source_number || null,
        call_destination: call?.destination_number || null,
        call_did: call?.did_tfn || null,
        call_start_time: call?.start_time || null,
      };
    });

    const online = agents.filter(
      (a) => a.status && !['LoggedOut', 'LoginFailed', 'Disabled', 'Unknown'].includes(a.status)
    );
    const onCall = online.filter(
      (a) => a.status === 'On Call' || a.status === 'Ringing' || a.status === 'Outbound'
    );
    const onBreak = online.filter(
      (a) =>
        (a.status && a.status.includes('Break')) ||
        a.status === 'PAUSED' ||
        (a.break_name != null && a.break_name !== '')
    );
    const available = online.filter(
      (a) =>
        (a.status === 'LOGGEDIN' || a.status === 'SIP Phone Ringing' || a.status === 'LoginInitiated') &&
        !onCall.some((c) => c.agent_id === a.agent_id) &&
        !onBreak.some((c) => c.agent_id === a.agent_id)
    );
    const loggedOut = agents.filter(
      (a) => !a.status || ['LoggedOut', 'LoginFailed', 'Disabled', 'Unknown'].includes(a.status)
    );

    return res.json({
      success: true,
      agents,
      stats: {
        total: agents.length,
        online: online.length,
        available: available.length,
        onCall: onCall.length,
        onBreak: onBreak.length,
        loggedOut: loggedOut.length,
      },
    });
  } catch (err) {
    console.error('Superadmin live-agents error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load live agent data' });
  }
});

// POST /live-agents/:agentId/monitor - Barge, Whisper, or Listen on a live call
router.post('/live-agents/:agentId/monitor', requireSuperadmin, validate(monitorSchema), async (req, res) => {
  try {
    const agentId = (req.params.agentId || '').toString().trim().replace(/\D/g, '') || null;
    const { mode, supervisor_extension } = req.body || {};
    const ext = (supervisor_extension ?? '').toString().trim();
    if (!agentId) {
      return res.status(400).json({ success: false, error: 'Agent ID required' });
    }
    if (!['barge', 'whisper', 'listen'].includes(mode)) {
      return res.status(400).json({ success: false, error: 'mode must be barge, whisper, or listen' });
    }
    if (!ext) {
      return res.status(400).json({ success: false, error: 'supervisor_extension required' });
    }
    if (!isAriConfigured()) {
      return res.status(503).json({ success: false, error: 'ARI not configured' });
    }
    const callInfo = getBridgedCallInfo(agentId);
    if (!callInfo) {
      return res.status(400).json({ success: false, error: 'Agent not on a bridged call' });
    }
    const channelId = `Supervisor-${ext}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const app = getQueueStasisAppName();
    const timeout = 45;
    if (mode === 'barge' || mode === 'listen') {
      const result = await originateIntoStasis(channelId, `PJSIP/${ext}`, app, [callInfo.bridgeId, mode], timeout);
      if (result.status !== 200 && result.status !== 201) {
        const errMsg = result.body || 'Originate failed';
        return res.status(502).json({ success: false, error: errMsg });
      }
    } else {
      const result = await originateToContext(channelId, ext, 'BargeMe', 's', {
        BargeChannel: callInfo.agentChannelId,
        Mode: 'whisper',
      }, timeout);
      if (result.status !== 200 && result.status !== 201) {
        const errMsg = result.body || 'Originate failed';
        return res.status(502).json({ success: false, error: errMsg });
      }
    }
    return res.json({ success: true, message: `Ringing supervisor for ${mode}` });
  } catch (err) {
    console.error('Superadmin monitor error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Monitor request failed' });
  }
});

// POST /live-agents/:agentId/force-end-break - Set agent to Available (LOGGEDIN, clear break_name)
router.post('/live-agents/:agentId/force-end-break', async (req, res) => {
  try {
    const agentId = (req.params.agentId || '').toString().trim().replace(/\D/g, '') || null;
    if (!agentId) {
      return res.status(400).json({ success: false, error: 'Agent ID (extension) required' });
    }
    const row = await queryOne('SELECT 1 FROM users WHERE phone_login_number = ? AND role = 5 LIMIT 1', [agentId]);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }
    await query(
      `UPDATE agent_status SET status = 'LOGGEDIN', break_name = NULL, break_started_at = NULL, timestamp = NOW() WHERE agent_id = ?`,
      [agentId]
    );
    return res.json({ success: true, message: 'Agent set to Available' });
  } catch (err) {
    console.error('Superadmin force-end-break error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to end break' });
  }
});

// POST /live-agents/:agentId/force-logout - Hang up Asterisk channels, set LoggedOut, clear extension for re-login
router.post('/live-agents/:agentId/force-logout', async (req, res) => {
  try {
    const agentId = (req.params.agentId || '').toString().trim().replace(/\D/g, '') || null;
    if (!agentId) {
      return res.status(400).json({ success: false, error: 'Agent ID (extension) required' });
    }
    const userRow = await queryOne('SELECT id FROM users WHERE phone_login_number = ? AND role = 5 LIMIT 1', [agentId]);
    if (!userRow) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }
    const userId = userRow.id;
    const result = await forceLogoutAgent(agentId);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error || 'Force logout failed' });
    }
    await endAgentSession(agentId, 'forced');
    await query(
      `UPDATE agent_status SET status = 'LoggedOut', agent_channel_id = NULL, customer_channel_id = NULL,
       customer_number = NULL, call_id = NULL, queue_name = NULL, session_started_at = NULL,
       break_name = NULL, break_started_at = NULL, timestamp = NOW() WHERE agent_id = ?`,
      [agentId]
    );
    await query('UPDATE users SET soft_phone_login_status = 0 WHERE phone_login_number = ? LIMIT 1', [agentId]).catch(() => {});
    await query('DELETE FROM agent_extension_usage WHERE user_id = ?', [userId]).catch(() => {});

    const store = req.app.get('sessionStore');
    if (store) {
      destroySessionsForUser(store, userId, (err) => {
        if (err) console.error('Superadmin force-logout destroy sessions:', err);
      });
    }
    return res.json({ success: true, message: 'Agent logged out; channels and session cleared. Agent will be redirected to login.' });
  } catch (err) {
    console.error('Superadmin force-logout error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Force logout failed' });
  }
});

export default router;

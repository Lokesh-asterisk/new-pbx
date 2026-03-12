/**
 * Wallboard API for supervisors (user), admin, and superadmin.
 * Returns live agent status, queue summary, active calls, global metrics,
 * queue performance, agent detail, supervisor monitor, and historical reports.
 */

import express from 'express';
import { query, queryOne } from '../db.js';
import { getQueueWaitingCounts, getBridgedCallInfo } from '../ari-stasis-queue.js';
import { originateToContext, isAriConfigured, getChannel } from '../asterisk-ari.js';
import { subscribeWallboard } from '../realtime.js';
import { performForceEndBreak, performForceLogout } from '../utils/agent-actions.js';
import { resolveRequestTenantId, ensureAgentInTenant, isSuperadminRole, isAdminRole } from '../utils/tenant.js';
import { buildCsvResponse } from '../utils/csv.js';
import { sanitizeAgentId } from '../utils/validation.js';
import { validate, wallboardMonitorSchema } from '../utils/schemas.js';

const router = express.Router();

const SLA_THRESHOLD_SEC = parseInt(process.env.WALLBOARD_SLA_SECONDS || '20', 10);

function requireWallboardAccess(req, res, next) {
  const user = req.session?.user;
  if (!user) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }
  const r = user.role;
  const allowed = r === 'superadmin' || r === 1 || r === 'admin' || r === 2 || r === 'user' || r === 3;
  if (!allowed) {
    return res.status(403).json({ success: false, error: 'Wallboard is for supervisors, admin, and superadmin only' });
  }
  req.wallboardUser = user;
  next();
}

router.use(requireWallboardAccess);

/**
 * Resolve tenant ID for the request:
 * - superadmin: may pass query tenant_id (falls back to first tenant in DB)
 * - admin/user with assigned tenant (parent_id): always use that tenant; no tenant selection.
 * - admin without assigned tenant: may pass query tenant_id.
 * - user (supervisor): parent_id (their team/tenant)
 */
async function getTenantId(req) {
  return resolveRequestTenantId(req.wallboardUser, req.query.tenant_id);
}

function normalizeStatus(raw, breakName) {
  const s = (raw || '').toUpperCase().trim();
  if (s === 'ON CALL' || s === 'ONCALL') return 'IN_CALL';
  if (s === 'RINGING' || s === 'SIP PHONE RINGING') return 'RINGING';
  if (s === 'TRANSFERRING') return 'TRANSFERRING';
  if (s === 'LOGGEDIN' || s === 'LOGININITIATED') return 'READY';
  if (s === 'LOGGEDOUT' || s === 'LOGINFAILED') return 'LOGGED_OUT';
  if (s === 'PAUSED' || s.includes('BREAK') || (breakName != null && breakName !== '')) return 'PAUSED';
  if (s === 'AFTER_CALL_WORK' || s === 'ACW' || s === 'WRAPUP') return 'AFTER_CALL_WORK';
  if (s === 'OUTBOUND') return 'OUTBOUND';
  if (!s || s === 'OFFLINE' || s === 'DISABLED' || s === 'UNKNOWN') return 'OFFLINE';
  return 'OFFLINE';
}

/**
 * GET /api/wallboard/summary
 * Returns: stats, agents, queues, activeCalls
 */
router.get('/summary', async (req, res) => {
  try {
    const tenantId = await getTenantId(req);
    if (tenantId == null) {
      return res.json({
        success: true, tenant_id: null,
        stats: { online: 0, on_call: 0, break: 0, available: 0, queues: 0, calls_waiting: 0,
          calls_answered_today: 0, abandoned_calls_today: 0, average_wait_time: 0, service_level: 0,
          active_calls: 0, active_calls_inbound: 0, active_calls_outbound: 0, inbound_calls: 0, outbound_calls: 0 },
        agents: [], queues: [], activeCalls: [],
      });
    }

    let agentRows;
    const selectWithBreakStarted = `SELECT a.agent_id, a.status, a.break_name, a.break_started_at, a.queue_name, a.customer_number, a.extension_number,
              a.session_started_at, a.calls_taken, a.timestamp,
              u.id AS user_id, u.username, u.phone_login_name
       FROM agent_status a
       LEFT JOIN users u ON u.phone_login_number = a.agent_id AND u.role = 5
       WHERE a.tenant_id = ?
       ORDER BY a.status <> 'LoggedOut', a.timestamp DESC`;
    const selectWithoutBreakStarted = `SELECT a.agent_id, a.status, a.break_name, a.queue_name, a.customer_number, a.extension_number,
              a.session_started_at, a.calls_taken, a.timestamp,
              u.id AS user_id, u.username, u.phone_login_name
       FROM agent_status a
       LEFT JOIN users u ON u.phone_login_number = a.agent_id AND u.role = 5
       WHERE a.tenant_id = ?
       ORDER BY a.status <> 'LoggedOut', a.timestamp DESC`;
    try {
      agentRows = await query(selectWithBreakStarted, [tenantId]);
    } catch (e) {
      if (e?.code === 'ER_BAD_FIELD_ERROR' && e?.message?.includes('break_started_at')) {
        agentRows = await query(selectWithoutBreakStarted, [tenantId]);
        agentRows.forEach((r) => { r.break_started_at = null; });
      } else {
        throw e;
      }
    }

    const queueRows = await query(
      'SELECT id, name, display_name FROM queues WHERE tenant_id = ? ORDER BY name',
      [tenantId]
    );

    // Only count as "active" calls that started today and are not yet closed (avoids stale rows from missed hangup callbacks)
    let activeCallRows = [];
    try {
      activeCallRows = await query(
        `SELECT id, unique_id, source_number, destination_number, did_tfn, agent_extension, agent_id,
                direction, queue_name, start_time, answer_time, status
         FROM call_records
         WHERE tenant_id = ? AND end_time IS NULL AND status IN ('ringing', 'answered')
           AND DATE(start_time) = CURDATE()
         ORDER BY start_time DESC`,
        [tenantId]
      );
    } catch (e) {
      // call_records may not exist if Phase 3 migration not run
    }

    // --- Today's global call metrics ---
    let callsAnsweredToday = 0;
    let abandonedCallsToday = 0;
    let transferredCallsToday = 0;
    let failedCallsToday = 0;
    let queueFailoversToday = 0;
    let averageWaitTime = 0;
    let serviceLevel = 0;
    let queueCallMetrics = {};
    try {
      const todayRow = await queryOne(
        `SELECT
           SUM(CASE WHEN LOWER(TRIM(status)) IN ('answered','completed') AND answer_time IS NOT NULL THEN 1 ELSE 0 END) AS answered,
           SUM(CASE WHEN LOWER(TRIM(status)) IN ('abandoned','abondoned') OR (answer_time IS NULL AND LOWER(TRIM(status)) = 'completed') THEN 1 ELSE 0 END) AS abandoned,
           SUM(CASE WHEN transfer_status = 1 THEN 1 ELSE 0 END) AS transferred,
           SUM(CASE WHEN LOWER(TRIM(status)) = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN failover_destination IS NOT NULL AND failover_destination != '' THEN 1 ELSE 0 END) AS failovers,
           AVG(CASE WHEN LOWER(TRIM(status)) IN ('answered','completed') AND answer_time IS NOT NULL
               THEN TIMESTAMPDIFF(SECOND, start_time, answer_time) ELSE NULL END) AS avg_wait,
           SUM(CASE WHEN LOWER(TRIM(status)) IN ('answered','completed') AND answer_time IS NOT NULL
               AND TIMESTAMPDIFF(SECOND, start_time, answer_time) <= ? THEN 1 ELSE 0 END) AS within_sla,
           SUM(CASE WHEN LOWER(TRIM(status)) IN ('answered','completed') AND answer_time IS NOT NULL THEN 1 ELSE 0 END) AS sla_total
         FROM call_records
         WHERE tenant_id = ? AND DATE(start_time) = CURDATE()`,
        [SLA_THRESHOLD_SEC, tenantId]
      );
      callsAnsweredToday = Number(todayRow?.answered) || 0;
      abandonedCallsToday = Number(todayRow?.abandoned) || 0;
      transferredCallsToday = Number(todayRow?.transferred) || 0;
      failedCallsToday = Number(todayRow?.failed) || 0;
      queueFailoversToday = Number(todayRow?.failovers) || 0;
      averageWaitTime = Math.round(Number(todayRow?.avg_wait) || 0);
      const slaTotal = Number(todayRow?.sla_total) || 0;
      const withinSla = Number(todayRow?.within_sla) || 0;
      serviceLevel = slaTotal > 0 ? Math.round((withinSla / slaTotal) * 100) : 0;

      const queueMetricRows = await query(
        `SELECT queue_name,
           SUM(CASE WHEN LOWER(TRIM(status)) IN ('answered','completed') AND answer_time IS NOT NULL THEN 1 ELSE 0 END) AS answered,
           SUM(CASE WHEN LOWER(TRIM(status)) IN ('abandoned','abondoned') OR (answer_time IS NULL AND LOWER(TRIM(status)) = 'completed') THEN 1 ELSE 0 END) AS abandoned,
           SUM(CASE WHEN transfer_status = 1 THEN 1 ELSE 0 END) AS transferred,
           SUM(CASE WHEN failover_destination IS NOT NULL AND failover_destination != '' THEN 1 ELSE 0 END) AS failovers,
           AVG(CASE WHEN LOWER(TRIM(status)) IN ('answered','completed') AND answer_time IS NOT NULL
               THEN TIMESTAMPDIFF(SECOND, start_time, answer_time) ELSE NULL END) AS avg_wait,
           MAX(CASE WHEN LOWER(TRIM(status)) IN ('answered','completed') AND answer_time IS NOT NULL
               THEN TIMESTAMPDIFF(SECOND, start_time, answer_time) ELSE NULL END) AS longest_wait,
           SUM(CASE WHEN LOWER(TRIM(status)) IN ('answered','completed') AND answer_time IS NOT NULL
               AND TIMESTAMPDIFF(SECOND, start_time, answer_time) <= ? THEN 1 ELSE 0 END) AS within_sla,
           SUM(CASE WHEN LOWER(TRIM(status)) IN ('answered','completed') AND answer_time IS NOT NULL THEN 1 ELSE 0 END) AS sla_total
         FROM call_records
         WHERE tenant_id = ? AND DATE(start_time) = CURDATE() AND queue_name IS NOT NULL AND queue_name != ''
         GROUP BY queue_name`,
        [SLA_THRESHOLD_SEC, tenantId]
      );
      for (const r of queueMetricRows) {
        const qTotal = Number(r.sla_total) || 0;
        const qWithin = Number(r.within_sla) || 0;
        queueCallMetrics[r.queue_name] = {
          calls_answered_today: Number(r.answered) || 0,
          calls_abandoned_today: Number(r.abandoned) || 0,
          calls_transferred_today: Number(r.transferred) || 0,
          calls_failover_today: Number(r.failovers) || 0,
          average_wait_time: Math.round(Number(r.avg_wait) || 0),
          longest_wait_today_sec: Math.round(Number(r.longest_wait) || 0),
          service_level: qTotal > 0 ? Math.round((qWithin / qTotal) * 100) : 0,
        };
      }
    } catch (e) {
      if (e?.code !== 'ER_NO_SUCH_TABLE') console.error('Wallboard call metrics error:', e);
    }

    // --- Calls waiting (from in-memory ARI state) ---
    const waitingCounts = getQueueWaitingCounts();
    const tenantQueueNames = new Set(queueRows.map((q) => q.name));
    let callsWaiting = 0;
    for (const [qName, info] of Object.entries(waitingCounts.byQueue)) {
      if (tenantQueueNames.has(qName)) callsWaiting += info.count;
    }

    // --- Per-agent break/call stats ---
    let breakMap = {};
    let callStatsMap = {};
    const activeCallByAgent = {};
    for (const c of activeCallRows) {
      const key = c.agent_id || c.agent_extension;
      if (key && !activeCallByAgent[key]) activeCallByAgent[key] = c;
    }

    try {
      const onlineUserIds = agentRows
        .filter((r) => r.user_id && r.status && !['LoggedOut', 'LoginFailed'].includes(r.status) && r.session_started_at)
        .map((r) => ({ userId: r.user_id, sessionStart: r.session_started_at }));

      if (onlineUserIds.length > 0) {
        for (const { userId, sessionStart } of onlineUserIds) {
          try {
            const breakRow = await queryOne(
              `SELECT COALESCE(SUM(TIMESTAMPDIFF(SECOND, start_time, COALESCE(end_time, NOW()))), 0) AS total_break_sec
               FROM session_agent_breaks
               WHERE agent_id = ? AND tenant_id = ? AND start_time >= ?`,
              [userId, tenantId, sessionStart]
            );
            breakMap[userId] = breakRow?.total_break_sec || 0;
          } catch (e) {
            if (e?.code !== 'ER_NO_SUCH_TABLE') console.error('Break query error:', e);
          }
        }
      }
    } catch (_) {}

    try {
      const onlineAgentIds = agentRows
        .filter((r) => r.user_id && r.status && !['LoggedOut', 'LoginFailed'].includes(r.status) && r.session_started_at)
        .map((r) => ({ userId: r.user_id, sessionStart: r.session_started_at }));

      if (onlineAgentIds.length > 0) {
        for (const { userId, sessionStart } of onlineAgentIds) {
          try {
            const row = await queryOne(
              `SELECT
                 COALESCE(SUM(talk_sec), 0) AS total_talk_sec,
                 COALESCE(SUM(duration_sec), 0) AS total_duration_sec,
                 SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) AS inbound_calls,
                 SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) AS outbound_calls,
                 COUNT(*) AS total_calls
               FROM call_records
               WHERE agent_user_id = ? AND tenant_id = ? AND start_time >= ? AND status NOT IN ('failed','abandoned')`,
              [userId, tenantId, sessionStart]
            );
            const totalCalls = Number(row?.total_calls) || 0;
            const totalDuration = Number(row?.total_duration_sec) || 0;
            callStatsMap[userId] = {
              talk_sec: Number(row?.total_talk_sec) || 0,
              inbound_calls: Number(row?.inbound_calls) || 0,
              outbound_calls: Number(row?.outbound_calls) || 0,
              calls_handled: totalCalls,
              aht: totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0,
            };
          } catch (e) {
            if (e?.code !== 'ER_NO_SUCH_TABLE') console.error('Call stats query error:', e);
          }
        }
      }
    } catch (_) {}

    const now = Date.now();
    const agents = agentRows.map((r) => {
      const isOnline = r.status && !['LoggedOut', 'LoginFailed'].includes(r.status);
      const sessionStartMs = r.session_started_at ? new Date(r.session_started_at).getTime() : null;
      const loginDurationSec = isOnline && sessionStartMs ? Math.max(0, Math.floor((now - sessionStartMs) / 1000)) : 0;
      const breakDurationSec = (r.user_id && breakMap[r.user_id]) || 0;
      const currentBreakSec = r.break_started_at ? Math.max(0, Math.floor((now - new Date(r.break_started_at).getTime()) / 1000)) : 0;
      const totalBreakSessionSec = breakDurationSec + currentBreakSec;
      const cs = (r.user_id && callStatsMap[r.user_id]) || {};
      const activeCall = activeCallByAgent[r.agent_id] || activeCallByAgent[r.extension_number] || null;

      const talkSec = cs.talk_sec || 0;
      const occupancy = loginDurationSec > 0 ? Math.min(1, talkSec / loginDurationSec) : 0;
      return {
        agent_id: r.agent_id,
        user_id: r.user_id,
        name: r.phone_login_name || r.username || r.agent_id,
        extension: r.extension_number,
        status: r.status,
        normalized_status: normalizeStatus(r.status, r.break_name),
        break_name: r.break_name,
        break_started_at: r.break_started_at || null,
        queue_name: r.queue_name,
        customer_number: r.customer_number,
        session_started_at: r.session_started_at,
        calls_taken: r.calls_taken || 0,
        timestamp: r.timestamp,
        login_duration_sec: loginDurationSec,
        break_duration_sec: breakDurationSec,
        total_break_session_sec: totalBreakSessionSec,
        talk_duration_sec: talkSec,
        occupancy,
        inbound_calls: cs.inbound_calls || 0,
        outbound_calls: cs.outbound_calls || 0,
        calls_handled: cs.calls_handled || 0,
        aht: cs.aht || 0,
        call_start_time: activeCall?.start_time || null,
        call_answer_time: activeCall?.answer_time || null,
        current_call_unique_id: activeCall?.unique_id || null,
        did_tfn: activeCall?.did_tfn || null,
      };
    });

    const onlineAgents = agents.filter(
      (a) => a.status && !['LoggedOut', 'LoginFailed'].includes(a.status)
    );
    const onCall = onlineAgents.filter(
      (a) => a.status === 'On Call' || a.status === 'Ringing' || a.status === 'Outbound'
    );
    const onBreak = onlineAgents.filter(
      (a) =>
        (a.status && (a.status.includes('Break') || a.status === 'PAUSED')) ||
        (a.break_name != null && a.break_name !== '')
    );
    const available = onlineAgents.filter(
      (a) =>
        a.status === 'LOGGEDIN' &&
        !onCall.some((c) => c.agent_id === a.agent_id) &&
        !onBreak.some((c) => c.agent_id === a.agent_id)
    );

    const totalInbound = onlineAgents.reduce((s, a) => s + a.inbound_calls, 0);
    const totalOutbound = onlineAgents.reduce((s, a) => s + a.outbound_calls, 0);
    const agentsWithLogin = onlineAgents.filter((a) => (a.login_duration_sec || 0) > 0);
    const averageAht = agentsWithLogin.length > 0
      ? Math.round(agentsWithLogin.reduce((s, a) => s + (a.aht || 0), 0) / agentsWithLogin.length)
      : 0;
    const averageOccupancy = agentsWithLogin.length > 0
      ? agentsWithLogin.reduce((s, a) => s + (a.occupancy ?? 0), 0) / agentsWithLogin.length
      : 0;

    // Calculate longest waiting call across all queues
    let longestWaitingSec = 0;
    for (const [, info] of Object.entries(waitingCounts.byQueue)) {
      const waitSec = Math.round(info.longestWaitMs / 1000);
      if (waitSec > longestWaitingSec) longestWaitingSec = waitSec;
    }

    const activeInbound = activeCallRows.filter((r) => (r.direction || '').toLowerCase() === 'inbound').length;
    const activeOutbound = activeCallRows.filter((r) => (r.direction || '').toLowerCase() === 'outbound').length;

    const stats = {
      online: onlineAgents.length,
      on_call: onCall.length,
      break: onBreak.length,
      available: available.length,
      queues: queueRows.length,
      inbound_calls: totalInbound,
      outbound_calls: totalOutbound,
      calls_waiting: callsWaiting,
      calls_answered_today: callsAnsweredToday,
      abandoned_calls_today: abandonedCallsToday,
      transferred_calls_today: transferredCallsToday,
      failed_calls_today: failedCallsToday,
      queue_failovers_today: queueFailoversToday,
      longest_waiting_sec: longestWaitingSec,
      average_wait_time: averageWaitTime,
      service_level: serviceLevel,
      active_calls: activeCallRows.length,
      active_calls_inbound: activeInbound,
      active_calls_outbound: activeOutbound,
      average_aht: averageAht,
      average_occupancy: averageOccupancy,
    };

    // --- Queue performance metrics ---
    const agentsByQueue = {};
    for (const a of onlineAgents) {
      const q = a.queue_name;
      if (!q) continue;
      if (!agentsByQueue[q]) agentsByQueue[q] = { logged_in: 0, busy: 0 };
      agentsByQueue[q].logged_in++;
      if (a.normalized_status === 'IN_CALL' || a.normalized_status === 'RINGING') {
        agentsByQueue[q].busy++;
      }
    }

    const queues = queueRows.map((q) => {
      const wInfo = waitingCounts.byQueue[q.name] || { count: 0, longestWaitMs: 0 };
      const cm = queueCallMetrics[q.name] || {};
      const aq = agentsByQueue[q.name] || { logged_in: 0, busy: 0 };
      return {
        id: q.id,
        name: q.name,
        display_name: q.display_name || q.name,
        waiting: wInfo.count,
        longest_wait_sec: Math.round(wInfo.longestWaitMs / 1000),
        longest_wait_today_sec: cm.longest_wait_today_sec ?? 0,
        calls_answered_today: cm.calls_answered_today ?? 0,
        calls_abandoned_today: cm.calls_abandoned_today ?? 0,
        calls_transferred_today: cm.calls_transferred_today ?? 0,
        calls_failover_today: cm.calls_failover_today ?? 0,
        average_wait_time: cm.average_wait_time ?? 0,
        service_level: cm.service_level ?? 0,
        agents_logged_in: aq.logged_in ?? 0,
        agents_busy: aq.busy ?? 0,
      };
    });

    const activeCalls = activeCallRows.map((r) => ({
      id: r.id,
      unique_id: r.unique_id,
      source_number: r.source_number,
      destination_number: r.destination_number,
      did_tfn: r.did_tfn || null,
      agent_extension: r.agent_extension,
      agent_id: r.agent_id,
      direction: r.direction,
      queue_name: r.queue_name,
      start_time: r.start_time,
      answer_time: r.answer_time,
      status: r.status,
    }));

    const leaderboard = agents
      .filter((a) => (a.calls_handled || 0) > 0)
      .sort((a, b) => (b.calls_handled || 0) - (a.calls_handled || 0))
      .slice(0, 10)
      .map((a) => ({
        agent_id: a.agent_id,
        name: a.name,
        extension: a.extension,
        calls_handled: a.calls_handled || 0,
        aht: a.aht || 0,
        talk_duration_sec: a.talk_duration_sec || 0,
      }));

    return res.json({
      success: true,
      tenant_id: tenantId,
      stats,
      agents,
      queues,
      activeCalls,
      leaderboard,
    });
  } catch (err) {
    console.error('Wallboard summary error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load wallboard data' });
  }
});

/**
 * GET /api/wallboard/events
 * SSE stream for real-time wallboard updates by tenant.
 */
router.get('/events', async (req, res) => {
  const tenantId = await getTenantId(req);
  if (tenantId == null) {
    return res.status(400).json({ success: false, error: 'No tenant' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  subscribeWallboard(tenantId, res);
});

/**
 * GET /api/wallboard/tenants
 * Superadmin and admin (without assigned tenant): list tenants for dropdown on wallboard.
 * Admin/user with assigned tenant get empty list so frontend does not show tenant selector.
 */
router.get('/tenants', async (req, res) => {
  const u = req.wallboardUser;
  if (!isSuperadminRole(u.role) && !isAdminRole(u.role)) {
    return res.json({ success: true, tenants: [] });
  }
  if (u.parent_id != null || u.tenant_id != null) {
    return res.json({ success: true, tenants: [] });
  }
  try {
    const rows = await query('SELECT id, name FROM tenants ORDER BY id');
    return res.json({ success: true, tenants: rows });
  } catch (err) {
    console.error('Wallboard tenants error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load tenants' });
  }
});

/**
 * POST /api/wallboard/monitor
 * Supervisor (user), admin, superadmin: Listen / Whisper / Barge on an agent call.
 */
router.post('/monitor', validate(wallboardMonitorSchema), async (req, res) => {
  try {
    const user = req.wallboardUser;
    const { agent_id: rawAgentId, mode, supervisor_extension } = req.body || {};
    const agentId = (rawAgentId ?? '').toString().trim().replace(/\D/g, '') || null;
    const ext = (supervisor_extension ?? '').toString().trim();

    if (!agentId) return res.status(400).json({ success: false, error: 'agent_id required' });
    if (!['barge', 'whisper', 'listen'].includes(mode)) {
      return res.status(400).json({ success: false, error: 'mode must be barge, whisper, or listen' });
    }
    if (!ext) return res.status(400).json({ success: false, error: 'supervisor_extension required' });
    if (!isAriConfigured()) return res.status(503).json({ success: false, error: 'ARI not configured' });

    if (user.role !== 'superadmin' && user.role !== 1) {
      const agentRow = await queryOne(
        'SELECT parent_id FROM users WHERE phone_login_number = ? AND role = 5 LIMIT 1',
        [agentId]
      );
      const agentTenantId = agentRow?.parent_id ?? null;
      const userTenantId = user.parent_id ?? user.tenant_id ?? null;
      if (agentTenantId == null || userTenantId == null || Number(agentTenantId) !== Number(userTenantId)) {
        return res.status(403).json({ success: false, error: 'Agent not in your tenant' });
      }
    }

    const callInfo = getBridgedCallInfo(agentId);
    if (!callInfo) {
      return res.status(400).json({ success: false, error: 'Agent not on a bridged call' });
    }

    const channelId = `Supervisor-${ext}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timeout = 45;
    const spyParam = mode === 'listen' ? 'bq' : mode === 'whisper' ? 'qw' : 'Bq';
    let bargeChannelName = callInfo.agentChannelId;
    try {
      const agentChan = await getChannel(callInfo.agentChannelId);
      if (agentChan?.name) bargeChannelName = agentChan.name;
    } catch (_) {}
    const result = await originateToContext(channelId, ext, 'BargeMe', 's', {
      BargeChannel: bargeChannelName,
      SpyParameter: spyParam,
    }, timeout);
    if (result.status !== 200 && result.status !== 201) {
      return res.status(502).json({ success: false, error: result.body || 'Originate failed' });
    }

    return res.json({ success: true, message: `Ringing supervisor for ${mode}` });
  } catch (err) {
    console.error('Wallboard monitor error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Monitor request failed' });
  }
});

/** Ensure wallboard user (admin/superadmin only) can act on this agent. Admin: agent must be in same tenant. */
async function ensureAgentAllowedForWallboardAction(req, agentId) {
  const user = req.wallboardUser;
  if (!isSuperadminRole(user.role) && !isAdminRole(user.role)) return false;
  return ensureAgentInTenant(user, agentId);
}

/**
 * POST /api/wallboard/agents/:agentId/force-end-break
 * Admin/superadmin only. Set agent to Available (LOGGEDIN, clear break_name).
 */
router.post('/agents/:agentId/force-end-break', async (req, res) => {
  try {
    const user = req.wallboardUser;
    if (!isSuperadminRole(user.role) && !isAdminRole(user.role)) {
      return res.status(403).json({ success: false, error: 'Admin or superadmin only' });
    }
    const agentId = sanitizeAgentId(req.params.agentId);
    if (!agentId) return res.status(400).json({ success: false, error: 'Agent ID required' });
    if (!(await ensureAgentAllowedForWallboardAction(req, agentId))) {
      return res.status(403).json({ success: false, error: 'Agent not in your tenant' });
    }
    const result = await performForceEndBreak(agentId);
    if (!result.success) return res.status(result.status || 400).json({ success: false, error: result.error });
    return res.json({ success: true, message: result.message });
  } catch (err) {
    console.error('Wallboard force-end-break error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to end break' });
  }
});

/**
 * POST /api/wallboard/agents/:agentId/force-logout
 * Admin/superadmin only. Hang up channels, set LoggedOut, clear extension and session.
 */
router.post('/agents/:agentId/force-logout', async (req, res) => {
  try {
    const user = req.wallboardUser;
    if (!isSuperadminRole(user.role) && !isAdminRole(user.role)) {
      return res.status(403).json({ success: false, error: 'Admin or superadmin only' });
    }
    const agentId = sanitizeAgentId(req.params.agentId);
    if (!agentId) return res.status(400).json({ success: false, error: 'Agent ID required' });
    if (!(await ensureAgentAllowedForWallboardAction(req, agentId))) {
      return res.status(403).json({ success: false, error: 'Agent not in your tenant' });
    }
    const store = req.app.get('sessionStore');
    const result = await performForceLogout(agentId, store);
    if (!result.success) return res.status(result.status || 400).json({ success: false, error: result.error });
    return res.json({ success: true, message: result.message });
  } catch (err) {
    console.error('Wallboard force-logout error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Force logout failed' });
  }
});

/**
 * GET /api/wallboard/agents/:agentId/detail
 * Agent detail panel: today's calls, pause history, login history, averages.
 */
router.get('/agents/:agentId/detail', async (req, res) => {
  try {
    const tenantId = await getTenantId(req);
    const agentId = (req.params.agentId || '').toString().trim().replace(/\D/g, '') || null;
    if (!agentId) return res.status(400).json({ success: false, error: 'Agent ID required' });
    if (tenantId == null) return res.status(400).json({ success: false, error: 'No tenant' });

    const agentRow = await queryOne(
      `SELECT a.agent_id, a.status, a.session_started_at, a.break_name, a.queue_name,
              u.id AS user_id, u.username, u.phone_login_name
       FROM agent_status a
       LEFT JOIN users u ON u.phone_login_number = a.agent_id AND u.role = 5
       WHERE a.agent_id = ? AND a.tenant_id = ? LIMIT 1`,
      [agentId, tenantId]
    );
    if (!agentRow) return res.status(404).json({ success: false, error: 'Agent not found' });

    const userId = agentRow.user_id;
    const sessionStart = agentRow.session_started_at;

    let todaysCalls = [];
    let avgTalkTime = 0;
    let totalTalkTime = 0;
    let callsHandled = 0;
    let callsMissed = 0;
    let totalWrapTime = 0;
    let aht = 0;
    try {
      todaysCalls = await query(
        `SELECT unique_id, source_number, destination_number, did_tfn, direction, queue_name,
                start_time, answer_time, end_time, duration_sec, talk_sec, status
         FROM call_records
         WHERE tenant_id = ? AND (agent_id = ? OR agent_user_id = ?) AND DATE(start_time) = CURDATE()
         ORDER BY start_time DESC`,
        [tenantId, agentId, userId || 0]
      );

      const answered = todaysCalls.filter((c) => c.answer_time && c.status !== 'failed' && c.status !== 'abandoned');
      callsHandled = answered.length;
      callsMissed = todaysCalls.filter((c) => c.status === 'abandoned' || (!c.answer_time && c.status !== 'failed')).length;
      totalTalkTime = answered.reduce((s, c) => s + (Number(c.talk_sec) || 0), 0);
      avgTalkTime = callsHandled > 0 ? Math.round(totalTalkTime / callsHandled) : 0;
      const totalDuration = answered.reduce((s, c) => s + (Number(c.duration_sec) || 0), 0);
      totalWrapTime = Math.max(0, totalDuration - totalTalkTime);
      aht = callsHandled > 0 ? Math.round(totalDuration / callsHandled) : 0;
    } catch (e) {
      if (e?.code !== 'ER_NO_SUCH_TABLE') console.error('Agent detail calls error:', e);
    }

    let totalPauseTime = 0;
    let pauseHistory = [];
    try {
      const breakRows = await query(
        `SELECT start_time, end_time, break_name,
                TIMESTAMPDIFF(SECOND, start_time, COALESCE(end_time, NOW())) AS duration_sec
         FROM session_agent_breaks
         WHERE agent_id = ? AND tenant_id = ? AND DATE(start_time) = CURDATE()
         ORDER BY start_time DESC`,
        [userId || 0, tenantId]
      );
      pauseHistory = breakRows.map((b) => ({
        start_time: b.start_time,
        end_time: b.end_time,
        break_name: b.break_name,
        duration_sec: Number(b.duration_sec) || 0,
      }));
      totalPauseTime = pauseHistory.reduce((s, b) => s + b.duration_sec, 0);
    } catch (e) {
      if (e?.code !== 'ER_NO_SUCH_TABLE') console.error('Agent detail breaks error:', e);
    }

    const loginDurationSec = sessionStart
      ? Math.max(0, Math.floor((Date.now() - new Date(sessionStart).getTime()) / 1000))
      : 0;
    const occupancy = loginDurationSec > 0 ? Math.min(1, totalTalkTime / loginDurationSec) : 0;

    return res.json({
      success: true,
      agent: {
        agent_id: agentRow.agent_id,
        name: agentRow.phone_login_name || agentRow.username || agentRow.agent_id,
        status: agentRow.status,
        session_started_at: sessionStart,
      },
      todaysCalls: todaysCalls.slice(0, 100),
      callsHandled,
      callsMissed,
      avgTalkTime,
      totalTalkTime,
      totalWrapTime,
      totalPauseTime,
      aht,
      occupancy,
      pauseHistory,
      loginHistory: sessionStart ? [{ login: sessionStart, logout: null }] : [],
    });
  } catch (err) {
    console.error('Wallboard agent detail error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load agent detail' });
  }
});

/**
 * Aggregate agent daily stats for a tenant+date and upsert into agent_daily_stats (if table exists).
 * TODO: Unify with report-aggregator.js aggregateDailyStats to remove duplication.
 */
async function aggregateAgentDailyStats(tenantId, date) {
  try {
    const agentRows = await query(
      `SELECT u.id AS user_id, u.phone_login_number AS agent_id
       FROM users u WHERE u.parent_id = ? AND u.role = 5`,
      [tenantId]
    );
    for (const u of agentRows) {
      const agentId = String(u.agent_id || '').trim();
      const userId = u.user_id;
      if (!agentId) continue;
      let callsAnswered = 0;
      let totalTalk = 0;
      let totalDuration = 0;
      try {
        const cr = await queryOne(
          `SELECT COUNT(*) AS n, COALESCE(SUM(talk_sec), 0) AS talk, COALESCE(SUM(duration_sec), 0) AS dur
           FROM call_records WHERE tenant_id = ? AND (agent_id = ? OR agent_user_id = ?) AND DATE(start_time) = ?
             AND status NOT IN ('failed','abandoned')`,
          [tenantId, agentId, userId, date]
        );
        callsAnswered = Number(cr?.n) || 0;
        totalTalk = Number(cr?.talk) || 0;
        totalDuration = Number(cr?.dur) || 0;
      } catch (_) {}
      let pauseSec = 0;
      try {
        const br = await queryOne(
          `SELECT COALESCE(SUM(TIMESTAMPDIFF(SECOND, start_time, COALESCE(end_time, NOW()))), 0) AS s
           FROM session_agent_breaks WHERE tenant_id = ? AND agent_id = ? AND DATE(start_time) = ?`,
          [tenantId, userId, date]
        );
        pauseSec = Number(br?.s) || 0;
      } catch (_) {}
      let loginSec = 0;
      try {
        const sess = await queryOne(
          `SELECT COALESCE(SUM(session_duration_sec), 0) AS s
           FROM agent_sessions WHERE tenant_id = ? AND agent_id = ? AND DATE(login_time) = ? AND logout_time IS NOT NULL`,
          [tenantId, agentId, date]
        );
        loginSec = Number(sess?.s) || 0;
      } catch (_) {}
      const wrapSec = Math.max(0, totalDuration - totalTalk);
      const occupancy = loginSec > 0 ? Math.min(1, (totalTalk + wrapSec) / loginSec) : null;
      const aht = callsAnswered > 0 ? Math.round(totalDuration / callsAnswered) : null;
      await query(
        `INSERT INTO agent_daily_stats (tenant_id, agent_id, agent_user_id, stat_date, calls_answered, calls_missed, talk_time_sec, wrap_time_sec, pause_time_sec, login_time_sec, occupancy, avg_handle_time_sec)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           calls_answered = VALUES(calls_answered), talk_time_sec = VALUES(talk_time_sec), wrap_time_sec = VALUES(wrap_time_sec),
           pause_time_sec = VALUES(pause_time_sec), login_time_sec = VALUES(login_time_sec), occupancy = VALUES(occupancy),
           avg_handle_time_sec = VALUES(avg_handle_time_sec), updated_at = NOW()`,
        [tenantId, agentId, userId, date, callsAnswered, totalTalk, wrapSec, pauseSec, loginSec, occupancy, aht]
      );
    }
  } catch (e) {
    if (e?.code !== 'ER_NO_SUCH_TABLE') console.error('aggregateAgentDailyStats error:', e?.message || e);
  }
}

/**
 * GET /api/wallboard/report
 * Historical daily report for agents: login time, talk time, pause time, calls handled, AHT.
 * For past dates, uses agent_daily_stats when available; otherwise computes and backfills.
 */
router.get('/report', async (req, res) => {
  try {
    const tenantId = await getTenantId(req);
    if (tenantId == null) return res.json({ success: true, agents: [] });

    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const useCache = date < today;

    let agents = [];
    if (useCache) {
      try {
        const cached = await query(
          `SELECT d.agent_id, d.calls_answered AS calls_handled, d.calls_missed,
                  d.talk_time_sec AS total_talk_time, d.wrap_time_sec AS total_wrap_time,
                  d.pause_time_sec AS total_pause_time, d.login_time_sec AS login_time,
                  d.avg_handle_time_sec AS aht, d.occupancy,
                  COALESCE(u.phone_login_name, u.username) AS name
           FROM agent_daily_stats d
           LEFT JOIN users u ON u.phone_login_number = d.agent_id AND u.role = 5
           WHERE d.tenant_id = ? AND d.stat_date = ?
           ORDER BY COALESCE(u.phone_login_name, u.username), d.agent_id`,
          [tenantId, date]
        );
        if (cached && cached.length > 0) {
          agents = cached.map((a) => {
            const loginTime = Number(a.login_time) || 0;
            const pauseTime = Number(a.total_pause_time) || 0;
            const wrapTime = Number(a.total_wrap_time) || 0;
            const talkTime = Number(a.total_talk_time) || 0;
            return {
              agent_id: a.agent_id,
              name: a.name || a.agent_id,
              total_talk_time: talkTime,
              total_wrap_time: wrapTime,
              total_pause_time: pauseTime,
              login_time: loginTime,
              productive_time: Math.max(0, loginTime - pauseTime),
              calls_handled: Number(a.calls_handled) || 0,
              calls_missed: Number(a.calls_missed) || 0,
              aht: Number(a.aht) || 0,
              occupancy: a.occupancy != null ? Number(a.occupancy) : null,
            };
          });
        }
      } catch (e) {
        if (e?.code !== 'ER_NO_SUCH_TABLE') { /* ignore */ }
      }
    }

    if (agents.length === 0) {
      let agentReport = [];
      try {
        agentReport = await query(
          `SELECT
             u.id AS user_id,
             u.phone_login_number AS agent_id,
             COALESCE(u.phone_login_name, u.username) AS name,
             COALESCE(SUM(cr.talk_sec), 0) AS total_talk_time,
             COALESCE(SUM(cr.duration_sec), 0) AS total_duration,
             COUNT(cr.id) AS calls_handled,
             CASE WHEN COUNT(cr.id) > 0 THEN ROUND(SUM(cr.duration_sec) / COUNT(cr.id)) ELSE 0 END AS aht
           FROM users u
           LEFT JOIN call_records cr ON cr.agent_user_id = u.id AND cr.tenant_id = ? AND DATE(cr.start_time) = ?
             AND cr.status NOT IN ('failed','abandoned')
           WHERE u.parent_id = ? AND u.role = 5
           GROUP BY u.id
           ORDER BY u.phone_login_name`,
          [tenantId, date, tenantId]
        );
      } catch (e) {
        if (e?.code !== 'ER_NO_SUCH_TABLE') console.error('Report calls error:', e);
      }

      let breakReport = {};
      try {
        const breakRows = await query(
          `SELECT agent_id,
                  COALESCE(SUM(TIMESTAMPDIFF(SECOND, start_time, COALESCE(end_time, start_time))), 0) AS total_pause
           FROM session_agent_breaks
           WHERE tenant_id = ? AND DATE(start_time) = ?
           GROUP BY agent_id`,
          [tenantId, date]
        );
        for (const b of breakRows) breakReport[b.agent_id] = Number(b.total_pause) || 0;
      } catch (e) {
        if (e?.code !== 'ER_NO_SUCH_TABLE') console.error('Report breaks error:', e);
      }

      let loginReport = {};
      try {
        const aprRows = await query(
          `SELECT agent_id, total_login_time
           FROM session_agent_apr
           WHERE tenant_id = ? AND DATE(start_time) = ?`,
          [tenantId, date]
        );
        for (const a of aprRows) {
          const existing = loginReport[a.agent_id] || 0;
          let secs = 0;
          if (a.total_login_time) {
            const parts = String(a.total_login_time).split(':').map(Number);
            secs = (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
          }
          loginReport[a.agent_id] = existing + secs;
        }
      } catch (e) {
        if (e?.code !== 'ER_NO_SUCH_TABLE') console.error('Report APR error:', e);
      }
      try {
        const sessRows = await query(
          `SELECT agent_id, COALESCE(SUM(session_duration_sec), 0) AS login_sec
           FROM agent_sessions WHERE tenant_id = ? AND DATE(login_time) = ? AND logout_time IS NOT NULL GROUP BY agent_id`,
          [tenantId, date]
        );
        for (const s of sessRows) loginReport[s.agent_id] = (loginReport[s.agent_id] || 0) + Number(s.login_sec || 0);
      } catch (_) {}

      agents = agentReport.map((a) => {
        const userId = a.user_id;
        const pauseTime = breakReport[userId] || breakReport[a.agent_id] || 0;
        const loginTime = loginReport[a.agent_id] || loginReport[userId] || 0;
        const talkTime = Number(a.total_talk_time) || 0;
        const totalDuration = Number(a.total_duration) || 0;
        const wrapTime = Math.max(0, totalDuration - talkTime);
        const occupancy = loginTime > 0 ? Math.min(1, (talkTime + wrapTime) / loginTime) : null;
        return {
          agent_id: a.agent_id,
          name: a.name,
          total_talk_time: talkTime,
          total_wrap_time: wrapTime,
          total_pause_time: pauseTime,
          login_time: loginTime,
          productive_time: Math.max(0, loginTime - pauseTime),
          calls_handled: Number(a.calls_handled) || 0,
          calls_missed: 0,
          aht: Number(a.aht) || 0,
          occupancy,
        };
      });
      if (useCache && agents.length > 0) aggregateAgentDailyStats(tenantId, date).catch(() => {});
    }

    const totalCalls = agents.reduce((s, a) => s + (a.calls_handled || 0), 0);
    const totalLogin = agents.reduce((s, a) => s + (a.login_time || 0), 0);
    const totalTalk = agents.reduce((s, a) => s + (a.total_talk_time || 0), 0);
    const totalWrap = agents.reduce((s, a) => s + (a.total_wrap_time || 0), 0);
    const totalPause = agents.reduce((s, a) => s + (a.total_pause_time || 0), 0);
    const totalMissed = agents.reduce((s, a) => s + (a.calls_missed || 0), 0);
    const agentsWithCalls = agents.filter((a) => (a.calls_handled || 0) > 0);
    const agentsWithLogin = agents.filter((a) => (a.login_time || 0) > 0);
    const avgAht = agentsWithCalls.length > 0
      ? Math.round(agentsWithCalls.reduce((s, a) => s + (a.aht || 0), 0) / agentsWithCalls.length)
      : null;
    const avgOccupancy = agentsWithLogin.length > 0
      ? agentsWithLogin.reduce((s, a) => s + (a.occupancy != null ? a.occupancy : 0), 0) / agentsWithLogin.length
      : null;
    const summary = {
      total_calls: totalCalls,
      total_calls_missed: totalMissed,
      total_login_sec: totalLogin,
      total_talk_sec: totalTalk,
      total_wrap_sec: totalWrap,
      total_pause_sec: totalPause,
      avg_aht_sec: avgAht,
      avg_occupancy: avgOccupancy != null ? Math.round(avgOccupancy * 10000) / 10000 : null,
      agent_count: agents.length,
    };

    const formatCsv = (req.query.format || '').toString().toLowerCase() === 'csv';
    if (formatCsv) {
      const headers = ['Agent ID', 'Name', 'Login Time (sec)', 'Productive Time (sec)', 'Talk Time (sec)', 'Wrap Time (sec)', 'Pause Time (sec)', 'Calls Handled', 'Calls Missed', 'AHT (sec)', 'Occupancy'];
      const rows = agents.map((a) => [
        a.agent_id,
        a.name,
        a.login_time,
        a.productive_time ?? Math.max(0, (a.login_time || 0) - (a.total_pause_time || 0)),
        a.total_talk_time,
        a.total_wrap_time ?? 0,
        a.total_pause_time,
        a.calls_handled,
        a.calls_missed ?? 0,
        a.aht,
        a.occupancy != null ? (Math.round(a.occupancy * 10000) / 100) + '%' : '',
      ]);
      return buildCsvResponse(res, `wallboard-daily-${date}.csv`, headers, rows);
    }

    return res.json({ success: true, date, agents, summary });
  } catch (err) {
    console.error('Wallboard report error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load report' });
  }
});

/**
 * GET /api/wallboard/report/hourly
 * Agent hourly report: calls per agent per hour for a given date.
 */
router.get('/report/hourly', async (req, res) => {
  try {
    const tenantId = await getTenantId(req);
    if (tenantId == null) return res.json({ success: true, rows: [] });
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const agentId = (req.query.agent_id || '').toString().trim() || null;
    let rows = [];
    try {
      let sql = `SELECT u.phone_login_number AS agent_id, COALESCE(u.phone_login_name, u.username) AS name,
                 HOUR(cr.start_time) AS hour, COUNT(cr.id) AS calls
                 FROM users u
                 LEFT JOIN call_records cr ON cr.agent_user_id = u.id AND cr.tenant_id = ? AND DATE(cr.start_time) = ?
                   AND cr.status NOT IN ('failed','abandoned')
                 WHERE u.parent_id = ? AND u.role = 5`;
      const params = [tenantId, date, tenantId];
      if (agentId) {
        sql += ' AND u.phone_login_number = ?';
        params.push(agentId);
      }
      sql += ' GROUP BY u.id, u.phone_login_number, u.phone_login_name, u.username, HOUR(cr.start_time) ORDER BY agent_id, hour';
      rows = await query(sql, params);
    } catch (e) {
      if (e?.code !== 'ER_NO_SUCH_TABLE') console.error('Hourly report error:', e);
    }
    return res.json({ success: true, date, rows });
  } catch (err) {
    console.error('Wallboard hourly report error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load hourly report' });
  }
});

/**
 * GET /api/wallboard/report/pause-analysis
 * Pause analysis: total break time per agent per break type (break_name) for a given date.
 */
router.get('/report/pause-analysis', async (req, res) => {
  try {
    const tenantId = await getTenantId(req);
    if (tenantId == null) return res.json({ success: true, rows: [] });
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    let rows = [];
    try {
      rows = await query(
        `SELECT b.agent_id, u.phone_login_number AS agent_number, COALESCE(u.phone_login_name, u.username) AS name,
                b.break_name, COALESCE(SUM(TIMESTAMPDIFF(SECOND, b.start_time, COALESCE(b.end_time, b.start_time))), 0) AS total_sec
         FROM session_agent_breaks b
         LEFT JOIN users u ON u.id = b.agent_id AND u.role = 5
         WHERE b.tenant_id = ? AND DATE(b.start_time) = ?
         GROUP BY b.agent_id, u.phone_login_number, u.phone_login_name, u.username, b.break_name
         ORDER BY name, break_name`,
        [tenantId, date]
      );
    } catch (e) {
      if (e?.code !== 'ER_NO_SUCH_TABLE') console.error('Pause analysis error:', e);
    }
    return res.json({ success: true, date, rows });
  } catch (err) {
    console.error('Wallboard pause analysis error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load pause analysis' });
  }
});

export default router;

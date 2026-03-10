/**
 * Admin reports and monitoring API.
 * Admin and superadmin can access: tenants, stats, live-agents, CDR, recordings.
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { query, queryOne } from '../db.js';
import { originateIntoStasis, originateToContext, getQueueStasisAppName, isAriConfigured } from '../asterisk-ari.js';
import { getBridgedCallInfo, forceLogoutAgent } from '../ari-stasis-queue.js';
import { destroySessionsForUser } from '../session-utils.js';
import { endAgentSession } from '../agent-sessions.js';

const router = express.Router();

function requireAdminOrSuperadmin(req, res, next) {
  const user = req.session?.user;
  if (!user) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }
  // Accept both string role (from buildSessionUser) and numeric role_id
  const role = user.role;
  const isAdmin = role === 'admin' || role === 2;
  const isSuperadmin = role === 'superadmin' || role === 1;
  if (!isAdmin && !isSuperadmin) {
    return res.status(403).json({ success: false, error: 'Admin or superadmin only' });
  }
  next();
}

router.use(requireAdminOrSuperadmin);

// --- Tenants (for report filters) ---

router.get('/tenants', async (req, res) => {
  try {
    const rows = await query('SELECT id, name, created_at FROM tenants ORDER BY id');
    return res.json({ success: true, tenants: rows });
  } catch (err) {
    console.error('Admin list tenants error:', err);
    return res.status(500).json({ success: false, error: 'Failed to list tenants' });
  }
});

// --- Blacklist (block prank/robocall numbers per tenant) ---

function normalizePhoneForBlacklist(raw) {
  if (raw == null || typeof raw !== 'string') return '';
  return raw.replace(/\D/g, '');
}

router.get('/blacklist', async (req, res) => {
  try {
    const user = req.session?.user;
    const isSuperadmin = user?.role === 'superadmin' || user?.role === 1;
    let tenantId = req.query.tenant_id != null && req.query.tenant_id !== '' ? parseInt(req.query.tenant_id, 10) : null;
    if (!isSuperadmin && (user?.parent_id != null || user?.tenant_id != null)) {
      const adminTenant = user.parent_id ?? user.tenant_id;
      if (tenantId != null && tenantId !== adminTenant) {
        return res.status(403).json({ success: false, error: 'Access limited to your tenant' });
      }
      tenantId = adminTenant;
    }
    let sql = 'SELECT id, tenant_id, number, created_at FROM blacklist';
    const params = [];
    if (tenantId != null && !Number.isNaN(tenantId) && tenantId >= 1) {
      sql += ' WHERE tenant_id = ?';
      params.push(tenantId);
    }
    sql += ' ORDER BY tenant_id, number';
    const rows = await query(sql, params);
    return res.json({ success: true, list: rows });
  } catch (err) {
    if (err?.code === 'ER_NO_SUCH_TABLE') {
      return res.json({ success: true, list: [] });
    }
    console.error('Admin blacklist list error:', err);
    return res.status(500).json({ success: false, error: 'Failed to list blacklist' });
  }
});

router.post('/blacklist', async (req, res) => {
  try {
    const user = req.session?.user;
    const isSuperadmin = user?.role === 'superadmin' || user?.role === 1;
    let { tenant_id: tenantIdParam, number } = req.body || {};
    const tenantId = parseInt(tenantIdParam, 10);
    if (!Number.isFinite(tenantId) || tenantId < 1) {
      return res.status(400).json({ success: false, error: 'Valid tenant_id required' });
    }
    if (!isSuperadmin && (user?.parent_id != null || user?.tenant_id != null)) {
      const adminTenant = user.parent_id ?? user.tenant_id;
      if (tenantId !== adminTenant) {
        return res.status(403).json({ success: false, error: 'Can only add blacklist for your tenant' });
      }
    }
    const normalized = normalizePhoneForBlacklist(number);
    if (!normalized) {
      return res.status(400).json({ success: false, error: 'Valid phone number required' });
    }
    await query(
      'INSERT INTO blacklist (tenant_id, number) VALUES (?, ?)',
      [tenantId, normalized]
    );
    const row = await queryOne('SELECT id, tenant_id, number, created_at FROM blacklist WHERE tenant_id = ? AND number = ? ORDER BY id DESC LIMIT 1', [tenantId, normalized]);
    return res.json({ success: true, entry: row });
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062) {
      return res.status(400).json({ success: false, error: 'Number already blacklisted' });
    }
    if (err?.code === 'ER_NO_SUCH_TABLE') {
      return res.status(500).json({ success: false, error: 'Blacklist table not found. Run migration 011_blacklist.sql.' });
    }
    console.error('Admin blacklist create error:', err);
    return res.status(500).json({ success: false, error: 'Failed to add to blacklist' });
  }
});

router.delete('/blacklist/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id < 1) {
      return res.status(400).json({ success: false, error: 'Invalid id' });
    }
    const user = req.session?.user;
    const isSuperadmin = user?.role === 'superadmin' || user?.role === 1;
    const existing = await queryOne('SELECT id, tenant_id FROM blacklist WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }
    if (!isSuperadmin && (user?.parent_id != null || user?.tenant_id != null)) {
      const adminTenant = user.parent_id ?? user.tenant_id;
      if (existing.tenant_id !== adminTenant) {
        return res.status(403).json({ success: false, error: 'Can only delete blacklist entries for your tenant' });
      }
    }
    await query('DELETE FROM blacklist WHERE id = ?', [id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('Admin blacklist delete error:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete' });
  }
});

// --- Stats (overview) ---

router.get('/stats', async (req, res) => {
  try {
    const user = req.session?.user;
    const isSuperadmin = user?.role === 'superadmin' || user?.role === 1;
    const adminTenantId = !isSuperadmin && (user?.parent_id != null || user?.parent_id === 0) ? parseInt(user.parent_id, 10) : null;

    const safeCount = async (sql, params = []) => {
      try {
        const row = await queryOne(sql, params);
        return row?.n ?? 0;
      } catch {
        return 0;
      }
    };
    let active_agents, total_users, extensions, trunks, queues, inbound_routes;
    if (adminTenantId != null && !Number.isNaN(adminTenantId)) {
      [active_agents, total_users, extensions, trunks, queues, inbound_routes] = await Promise.all([
        queryOne("SELECT COUNT(*) AS n FROM agent_status a JOIN users u ON u.phone_login_number = a.agent_id AND u.role = 5 WHERE a.status NOT IN ('LoggedOut', 'LoginFailed') AND u.parent_id = ?", [adminTenantId]).then(r => r?.n ?? 0).catch(() => 0),
        safeCount('SELECT COUNT(*) AS n FROM users WHERE parent_id = ?', [adminTenantId]),
        safeCount('SELECT COUNT(*) AS n FROM sip_extensions WHERE tenant_id = ?', [adminTenantId]),
        safeCount('SELECT COUNT(*) AS n FROM sip_trunks WHERE tenant_id = ?', [adminTenantId]),
        safeCount('SELECT COUNT(*) AS n FROM queues WHERE tenant_id = ?', [adminTenantId]),
        safeCount('SELECT COUNT(*) AS n FROM inbound_routes WHERE tenant_id = ?', [adminTenantId]),
      ]);
    } else {
      [active_agents, total_users, extensions, trunks, queues, inbound_routes] = await Promise.all([
        safeCount("SELECT COUNT(*) AS n FROM agent_status WHERE status NOT IN ('LoggedOut', 'LoginFailed')"),
        safeCount('SELECT COUNT(*) AS n FROM users'),
        safeCount('SELECT COUNT(*) AS n FROM sip_extensions'),
        safeCount('SELECT COUNT(*) AS n FROM sip_trunks'),
        safeCount('SELECT COUNT(*) AS n FROM queues'),
        safeCount('SELECT COUNT(*) AS n FROM inbound_routes'),
      ]);
    }
    return res.json({
      success: true,
      stats: {
        active_agents,
        total_users,
        extensions,
        trunks,
        queues,
        inbound_routes,
      },
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    const message = err?.message || 'Failed to load stats';
    return res.status(500).json({ success: false, error: message });
  }
});

// --- Live agents ---

router.get('/live-agents', async (req, res) => {
  try {
    const user = req.session?.user;
    const isSuperadmin = user?.role === 'superadmin' || user?.role === 1;
    const effectiveTenantId = !isSuperadmin && (user?.parent_id != null || user?.parent_id === 0) ? parseInt(user.parent_id, 10) : null;
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
      const callRows = await query(
        `SELECT agent_id, direction, source_number, destination_number, did_tfn, queue_name, start_time
         FROM call_records
         WHERE end_time IS NULL AND status IN ('ringing', 'answered') AND DATE(start_time) = CURDATE()
         ORDER BY start_time DESC`
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
    console.error('Admin live-agents error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load live agent data' });
  }
});

// POST /live-agents/:agentId/monitor - Barge, Whisper, or Listen (admin: agent must be in admin's tenant)
router.post('/live-agents/:agentId/monitor', async (req, res) => {
  try {
    const agentId = (req.params.agentId || '').toString().trim().replace(/\D/g, '') || null;
    const { mode, supervisor_extension } = req.body || {};
    const ext = (supervisor_extension ?? '').toString().trim();
    const user = req.session?.user;
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
    // Admin can only monitor agents in their tenant
    if (user?.role !== 'superadmin' && user?.role !== 1) {
      const agentRow = await queryOne(
        'SELECT parent_id FROM users WHERE phone_login_number = ? AND role = 5 LIMIT 1',
        [agentId]
      );
      const agentTenantId = agentRow?.parent_id ?? null;
      const adminTenantId = user?.parent_id ?? user?.tenant_id ?? null;
      if (agentTenantId == null || adminTenantId == null || Number(agentTenantId) !== Number(adminTenantId)) {
        return res.status(403).json({ success: false, error: 'Agent not in your tenant' });
      }
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
    console.error('Admin monitor error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Monitor request failed' });
  }
});

async function ensureAgentInAdminTenant(req, agentId) {
  const user = req.session?.user;
  if (user?.role === 'superadmin' || user?.role === 1) return true;
  const agentRow = await queryOne(
    'SELECT parent_id FROM users WHERE phone_login_number = ? AND role = 5 LIMIT 1',
    [agentId]
  );
  const agentTenantId = agentRow?.parent_id ?? null;
  const adminTenantId = user?.parent_id ?? user?.tenant_id ?? null;
  return agentTenantId != null && adminTenantId != null && Number(agentTenantId) === Number(adminTenantId);
}

// POST /live-agents/:agentId/force-end-break - Set agent to Available
router.post('/live-agents/:agentId/force-end-break', async (req, res) => {
  try {
    const agentId = (req.params.agentId || '').toString().trim().replace(/\D/g, '') || null;
    if (!agentId) return res.status(400).json({ success: false, error: 'Agent ID required' });
    if (!(await ensureAgentInAdminTenant(req, agentId))) {
      return res.status(403).json({ success: false, error: 'Agent not in your tenant' });
    }
    const row = await queryOne('SELECT 1 FROM users WHERE phone_login_number = ? AND role = 5 LIMIT 1', [agentId]);
    if (!row) return res.status(404).json({ success: false, error: 'Agent not found' });
    await query(
      `UPDATE agent_status SET status = 'LOGGEDIN', break_name = NULL, break_started_at = NULL, timestamp = NOW() WHERE agent_id = ?`,
      [agentId]
    );
    return res.json({ success: true, message: 'Agent set to Available' });
  } catch (err) {
    console.error('Admin force-end-break error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to end break' });
  }
});

// POST /live-agents/:agentId/force-logout - Hang up channels, set LoggedOut, clear extension
router.post('/live-agents/:agentId/force-logout', async (req, res) => {
  try {
    const agentId = (req.params.agentId || '').toString().trim().replace(/\D/g, '') || null;
    if (!agentId) return res.status(400).json({ success: false, error: 'Agent ID required' });
    if (!(await ensureAgentInAdminTenant(req, agentId))) {
      return res.status(403).json({ success: false, error: 'Agent not in your tenant' });
    }
    const userRow = await queryOne('SELECT id FROM users WHERE phone_login_number = ? AND role = 5 LIMIT 1', [agentId]);
    if (!userRow) return res.status(404).json({ success: false, error: 'Agent not found' });
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
        if (err) console.error('Admin force-logout destroy sessions:', err);
      });
    }
    return res.json({ success: true, message: 'Agent logged out; channels and session cleared. Agent will be redirected to login.' });
  } catch (err) {
    console.error('Admin force-logout error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Force logout failed' });
  }
});

// --- CDR (Call Detail Records) ---

function csvEscape(s) {
  if (s == null) return '';
  const str = String(s);
  if (/[,"\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

router.get('/cdr', async (req, res) => {
  try {
    const user = req.session?.user;
    const isSuperadmin = user?.role === 'superadmin' || user?.role === 1;
    const adminTenantId = !isSuperadmin && (user?.parent_id != null || user?.parent_id === 0) ? parseInt(user.parent_id, 10) : null;

    const from = (req.query.from || '').toString().trim();
    const to = (req.query.to || '').toString().trim();
    const agent = (req.query.agent || '').toString().trim();
    const queue = (req.query.queue || '').toString().trim();
    const direction = (req.query.direction || '').toString().trim();
    const formatCsv = (req.query.format || '').toString().toLowerCase() === 'csv';

    let where = [];
    const params = [];
    if (adminTenantId != null && !Number.isNaN(adminTenantId)) {
      where.push('cr.tenant_id = ?');
      params.push(adminTenantId);
    }
    if (from) {
      where.push('cr.start_time >= ?');
      params.push(from);
    }
    if (to) {
      where.push('cr.start_time <= ?');
      params.push(to.includes(' ') ? to : `${to} 23:59:59`);
    }
    if (agent) {
      where.push('(cr.agent_extension = ? OR cr.agent_id = ? OR u.username LIKE ? OR u.phone_login_name LIKE ?)');
      const like = `%${agent}%`;
      params.push(agent.replace(/\D/g, ''), agent.replace(/\D/g, ''), like, like);
    }
    if (queue) {
      where.push('cr.queue_name LIKE ?');
      params.push(`%${queue}%`);
    }
    if (direction && ['inbound', 'outbound'].includes(direction.toLowerCase())) {
      where.push('cr.direction = ?');
      params.push(direction.toLowerCase());
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    let countRow;
    let rows;
    try {
      if (!formatCsv) {
        countRow = await queryOne(
          `SELECT COUNT(*) AS total FROM call_records cr
           LEFT JOIN users u ON u.id = cr.agent_user_id
           ${whereClause}`,
          params
        );
      }
      const limitInt = formatCsv ? Math.min(10000, Math.max(1, parseInt(req.query.limit, 10) || 10000)) : Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
      const offsetInt = formatCsv ? 0 : Math.max(0, (Math.max(1, parseInt(req.query.page, 10) || 1) - 1) * limitInt);
      rows = await query(
        `SELECT cr.id, cr.unique_id, cr.source_number, cr.destination_number, cr.did_tfn, cr.agent_extension, cr.agent_id,
                cr.direction, cr.queue_name, cr.start_time, cr.answer_time, cr.end_time,
                cr.duration_sec, cr.talk_sec, cr.status, cr.recording_path, cr.tenant_id,
                u.username AS agent_username, u.phone_login_name AS agent_name
         FROM call_records cr
         LEFT JOIN users u ON u.id = cr.agent_user_id
         ${whereClause}
         ORDER BY cr.start_time DESC
         LIMIT ${limitInt} OFFSET ${offsetInt}`,
        params
      );
    } catch (dbErr) {
      const noTable = dbErr?.code === 'ER_NO_SUCH_TABLE' || (dbErr?.message && String(dbErr.message).includes("doesn't exist"));
      if (noTable) {
        if (formatCsv) {
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', 'attachment; filename="cdr.csv"');
          return res.send('\uFEFFStart Time,Caller,Destination,DID/TFN,Agent,Queue,Direction,Duration (sec),Talk (sec),Status,Recording\n');
        }
        return res.json({
          success: true,
          list: [],
          total: 0,
          page: 1,
          limit: 50,
          total_pages: 1,
          table_missing: true,
        });
      }
      throw dbErr;
    }

    if (formatCsv) {
      const headers = ['Start Time', 'Caller', 'Destination', 'DID/TFN', 'Agent', 'Queue', 'Direction', 'Duration (sec)', 'Talk (sec)', 'Status', 'Recording'];
      const lines = [headers.map(csvEscape).join(',')];
      for (const r of rows || []) {
        const dest = r.queue_name ? r.queue_name : (r.destination_number || '');
        const agentName = r.agent_name || r.agent_username || r.agent_extension || r.agent_id || '';
        lines.push([
          r.start_time,
          r.source_number,
          dest,
          r.did_tfn || '',
          agentName,
          r.queue_name,
          r.direction,
          r.duration_sec,
          r.talk_sec,
          r.status,
          r.recording_path ? 'Yes' : '',
        ].map(csvEscape).join(','));
      }
      const csv = lines.join('\n');
      const filename = `cdr-${new Date().toISOString().slice(0, 10)}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send('\uFEFF' + csv);
    }

    const total = Number(countRow?.total ?? 0);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const list = (rows || []).map((r) => ({
      id: r.id,
      unique_id: r.unique_id,
      source_number: r.source_number,
      destination_number: r.destination_number,
      did_tfn: r.did_tfn || null,
      agent_extension: r.agent_extension,
      agent_id: r.agent_id,
      agent_name: r.agent_name || r.agent_username || r.agent_extension || r.agent_id || '—',
      direction: r.direction,
      queue_name: r.queue_name,
      start_time: r.start_time,
      answer_time: r.answer_time,
      end_time: r.end_time,
      duration_sec: r.duration_sec,
      talk_sec: r.talk_sec,
      status: r.status,
      recording_path: r.recording_path,
      has_recording: !!r.recording_path,
    }));

    const totalPages = Math.ceil(total / limit) || 1;
    return res.json({
      success: true,
      list,
      total,
      page,
      limit,
      total_pages: totalPages,
      table_missing: false,
    });
  } catch (err) {
    console.error('Admin CDR list error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to load CDR' });
  }
});

// --- Reports: Calls per DID/TFN (inbound route summary) ---

router.get('/reports/did-tfn', async (req, res) => {
  try {
    const user = req.session?.user;
    const isSuperadmin = user?.role === 'superadmin' || user?.role === 1;
    const adminTenantId = !isSuperadmin && (user?.parent_id != null || user?.parent_id === 0) ? parseInt(user.parent_id, 10) : null;
    let tenantId = req.query.tenant_id != null && req.query.tenant_id !== '' ? parseInt(req.query.tenant_id, 10) : adminTenantId;
    if (!isSuperadmin && (tenantId != null && tenantId !== adminTenantId)) {
      return res.status(403).json({ success: false, error: 'Access limited to your tenant' });
    }
    const today = new Date().toISOString().slice(0, 10);
    const dateFrom = (req.query.date_from || req.query.from || today).toString().trim().slice(0, 10);
    const dateTo = (req.query.date_to || req.query.to || today).toString().trim().slice(0, 10);
    const formatCsv = (req.query.format || '').toString().toLowerCase() === 'csv';

    let where = ["cr.direction = 'inbound'", 'cr.start_time >= ?', 'cr.start_time <= ?'];
    const params = [dateFrom, dateTo.includes(' ') ? dateTo : `${dateTo} 23:59:59`];
    if (tenantId != null && !Number.isNaN(tenantId) && tenantId >= 1) {
      where.push('cr.tenant_id = ?');
      params.push(tenantId);
    }
    const whereClause = where.join(' AND ');

    let rows = [];
    try {
      rows = await query(
        `SELECT cr.did_tfn,
                COUNT(*) AS total_calls,
                SUM(CASE WHEN cr.answer_time IS NOT NULL AND LOWER(TRIM(cr.status)) IN ('answered','completed') THEN 1 ELSE 0 END) AS answered,
                SUM(CASE WHEN LOWER(TRIM(cr.status)) IN ('abandoned','abondoned') OR (cr.answer_time IS NULL AND LOWER(TRIM(cr.status)) = 'completed') THEN 1 ELSE 0 END) AS abandoned
         FROM call_records cr
         WHERE ${whereClause}
         GROUP BY cr.did_tfn
         ORDER BY total_calls DESC`,
        params
      );
    } catch (dbErr) {
      const noTable = dbErr?.code === 'ER_NO_SUCH_TABLE' || (dbErr?.message && String(dbErr.message).includes("doesn't exist"));
      if (noTable) {
        if (formatCsv) {
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="did-tfn-report-${dateFrom}.csv"`);
          return res.send('\uFEFFDID/TFN,Total Calls,Answered,Abandoned\n');
        }
        return res.json({ success: true, report: [] });
      }
      throw dbErr;
    }

    const report = (rows || []).map((r) => ({
      did_tfn: r.did_tfn || '—',
      total_calls: Number(r.total_calls) || 0,
      answered: Number(r.answered) || 0,
      abandoned: Number(r.abandoned) || 0,
    }));

    if (formatCsv) {
      const headers = ['DID/TFN', 'Total Calls', 'Answered', 'Abandoned'];
      const lines = [headers.map(csvEscape).join(',')];
      for (const r of report) {
        lines.push([r.did_tfn, r.total_calls, r.answered, r.abandoned].map(csvEscape).join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="did-tfn-report-${dateFrom}.csv"`);
      return res.send('\uFEFF' + lines.join('\n'));
    }

    return res.json({ success: true, report });
  } catch (err) {
    console.error('Admin DID/TFN report error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to load report' });
  }
});

// --- CDR recording stream ---

router.get('/cdr/recording/:uniqueId', async (req, res) => {
  try {
    const uniqueId = (req.params.uniqueId || '').toString().trim();
    if (!uniqueId) {
      return res.status(400).json({ success: false, error: 'UniqueID required' });
    }
    const row = await queryOne(
      'SELECT recording_path FROM call_records WHERE unique_id = ? LIMIT 1',
      [uniqueId]
    );
    if (!row || !row.recording_path) {
      return res.status(404).json({ success: false, error: 'No recording for this call' });
    }
    const basePath = (process.env.RECORDINGS_BASE_PATH || process.env.ASTERISK_RECORDING_PATH || '').trim();
    let filePath = row.recording_path;
    if (basePath) {
      filePath = path.isAbsolute(row.recording_path)
        ? row.recording_path
        : path.join(basePath, row.recording_path);
    } else if (!path.isAbsolute(filePath)) {
      return res.status(500).json({
        success: false,
        error: 'RECORDINGS_BASE_PATH not set; cannot resolve relative recording path',
      });
    }
    const resolvedPath = path.resolve(filePath);
    if (basePath) {
      const safeBase = path.resolve(basePath);
      if (!resolvedPath.startsWith(safeBase)) {
        return res.status(403).json({ success: false, error: 'Access denied' });
      }
    }
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ success: false, error: 'Recording file not found on server' });
    }
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      return res.status(404).json({ success: false, error: 'Not a file' });
    }
    const ext = path.extname(resolvedPath).toLowerCase();
    const contentType = ext === '.mp3' ? 'audio/mpeg' : ext === '.ogg' ? 'audio/ogg' : 'audio/wav';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Accept-Ranges', 'bytes');
    const stream = fs.createReadStream(resolvedPath);
    stream.pipe(res);
    stream.on('error', (err) => {
      console.error('Admin CDR recording stream error:', err);
      if (!res.headersSent) res.status(500).json({ success: false, error: 'Stream error' });
    });
  } catch (err) {
    console.error('Admin CDR recording error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: err.message || 'Failed to stream recording' });
    }
  }
});

export default router;

import express from 'express';
import { query, queryOne } from '../db.js';
import {
  originateAgentLogin,
  isAriConfigured,
  hangupChannel,
  answerChannel,
  holdChannel,
  unholdChannel,
  redirectChannel,
  originateIntoStasis,
  stopMohOnChannel,
} from '../asterisk-ari.js';
import { getPendingCustomerChannel, tryNextQueueAgent, hangupBridgedQueueCall, answerQueueCallWithLoginChannel, getAgentLoginChannel, transferBridgedCallToExtension } from '../ari-stasis-queue.js';
import { subscribe, broadcastToWallboard } from '../realtime.js';
import {
  setAgentAnswered,
  setAgentHangup,
  broadcastAgentStatus,
  createCallRecord,
} from '../call-handler.js';
import { setExtensionAgentUserId } from '../agent-extension-resolver.js';
import { endAgentSession, logAgentStatusChange } from '../agent-sessions.js';

const router = express.Router();

function requireAgent(req, res, next) {
  const user = req.session?.user;
  if (!user) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }
  if (user.role !== 'agent') {
    return res.status(403).json({ success: false, error: 'Agent access required' });
  }
  req.agentUser = user;
  next();
}

router.use(requireAgent);

/**
 * SSE stream for real-time events (incoming call, call answered, call ended, agent status).
 * Client uses EventSource with credentials.
 */
router.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  subscribe(req.agentUser.id, res);
});

router.get('/extensions', async (req, res) => {
  try {
    const tenantId = req.agentUser.parent_id;
    const userId = req.agentUser.id;
    if (tenantId == null) {
      return res.json({ success: true, extensions: [] });
    }
    // Option 2 (bound): agent only sees their assigned extension (sip_extensions.agent_user_id = this user)
    let rows;
    try {
      rows = await query(
        `SELECT e.id, e.name,
          (u.user_id IS NOT NULL) AS in_use,
          (u.user_id = ?) AS in_use_by_me
         FROM sip_extensions e
         LEFT JOIN agent_extension_usage u ON u.extension_id = e.id
         WHERE e.tenant_id = ? AND e.agent_user_id = ?
         ORDER BY e.name`,
        [userId, tenantId, userId]
      );
    } catch (joinErr) {
      const msg = String(joinErr?.message || joinErr || '');
      if (msg.includes('agent_extension_usage') || msg.includes("doesn't exist") || joinErr?.code === 'ER_NO_SUCH_TABLE') {
        rows = await query(
          'SELECT id, name FROM sip_extensions WHERE tenant_id = ? AND agent_user_id = ? ORDER BY name',
          [tenantId, userId]
        );
        rows = rows.map((r) => ({ ...r, in_use: 0, in_use_by_me: 0 }));
      } else {
        throw joinErr;
      }
    }
    // If agent has phone_login_number set but no bound extension, try to bind the matching unbound extension (self-heal)
    if (rows.length === 0) {
      const userRow = await queryOne(
        'SELECT phone_login_number FROM users WHERE id = ? AND role = 5 LIMIT 1',
        [userId]
      );
      const phoneNum = userRow?.phone_login_number != null ? String(userRow.phone_login_number).trim() : null;
      if (phoneNum) {
        const unbound = await queryOne(
          'SELECT id, name FROM sip_extensions WHERE tenant_id = ? AND name = ? AND (agent_user_id IS NULL OR agent_user_id = ?) LIMIT 1',
          [tenantId, phoneNum, userId]
        );
        if (unbound) {
          await setExtensionAgentUserId(tenantId, unbound.name, userId).catch((e) => console.error('Agent extensions auto-bind:', e?.message || e));
          rows = await query(
            'SELECT id, name FROM sip_extensions WHERE tenant_id = ? AND agent_user_id = ? ORDER BY name',
            [tenantId, userId]
          ).catch(() => []);
          rows = rows.map((r) => ({ ...r, in_use: 0, in_use_by_me: 0 }));
        }
      }
    }
    const extensions = rows.map((r) => ({
      id: r.id,
      name: r.name,
      in_use: !!(r.in_use ?? 0),
      in_use_by_me: !!(r.in_use_by_me ?? 0),
    }));
    return res.json({ success: true, extensions });
  } catch (err) {
    console.error('Agent extensions error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load extensions' });
  }
});

router.get('/status', async (req, res) => {
  try {
    let extension = req.session?.agentExtension;
    let agentStatus = null;
    const userId = req.agentUser?.id;
    const tenantId = req.agentUser?.parent_id;
    const user = await queryOne(
      'SELECT phone_login_number, soft_phone_login_status FROM users WHERE id = ? AND role = 5 LIMIT 1',
      [userId]
    );
    const phoneNum = user?.phone_login_number != null ? String(user.phone_login_number) : null;
    const softPhoneLoggedIn = user?.soft_phone_login_status === 1 || user?.soft_phone_login_status === true;
    let breakName = null;
    let breakStartedAt = null;
    let extensionNumberFromStatus = null;
    if (phoneNum) {
      const row = await queryOne(
        'SELECT status, break_name, break_started_at, extension_number FROM agent_status WHERE agent_id = ? LIMIT 1',
        [phoneNum]
      );
      const raw = row?.status;
      agentStatus = raw != null ? String(raw).trim() : null;
      if (row?.break_name != null && String(row.break_name).trim()) breakName = String(row.break_name).trim();
      if (row?.break_started_at) breakStartedAt = new Date(row.break_started_at).toISOString();
      if (row?.extension_number != null && String(row.extension_number).trim()) extensionNumberFromStatus = String(row.extension_number).trim();
    }
    if (extension && !softPhoneLoggedIn) {
      delete req.session.agentExtension;
    }
    // If agent is soft-phone logged in but session lost extension (e.g. page refresh), restore from DB so they stay on dashboard
    if (!extension && softPhoneLoggedIn && userId != null) {
      let usageRow = null;
      try {
        usageRow = await queryOne(
          'SELECT extension_id FROM agent_extension_usage WHERE user_id = ? LIMIT 1',
          [userId]
        );
      } catch (_) {}
      if (usageRow?.extension_id) {
        const extRow = await queryOne(
          'SELECT id, name FROM sip_extensions WHERE id = ? LIMIT 1',
          [usageRow.extension_id]
        );
        if (extRow) {
          extension = { id: extRow.id, name: extRow.name };
          req.session.agentExtension = extension;
        }
      }
      if (!extension && phoneNum && tenantId != null && extensionNumberFromStatus) {
        const extName = extensionNumberFromStatus;
        if (extName) {
          const extRow = await queryOne(
            'SELECT id, name FROM sip_extensions WHERE tenant_id = ? AND (name = ? OR agent_user_id = ?) ORDER BY (agent_user_id = ?) DESC LIMIT 1',
            [tenantId, extName, userId, userId]
          );
          if (extRow) {
            extension = { id: extRow.id, name: extRow.name };
            req.session.agentExtension = extension;
          }
        }
      }
    }
    const payload = {
      success: true,
      extensionSelected: !!extension && softPhoneLoggedIn,
      extension: extension && softPhoneLoggedIn ? extension : null,
      agentStatus: agentStatus || null,
      ...(agentStatus && (String(agentStatus).toUpperCase() === 'PAUSED' || String(agentStatus).toUpperCase().includes('BREAK'))
        ? { breakName: breakName || null, breakStartedAt: breakStartedAt || null }
        : {}),
    };
    if (process.env.NODE_ENV !== 'production' && (agentStatus === 'LOGGEDIN' || agentStatus === 'SIP Phone Ringing' || agentStatus === 'LoginInitiated')) {
      console.log('[agent status]', { userId, phoneNum, agentStatus });
    }
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res.json(payload);
  } catch (err) {
    console.error('Agent status error:', err);
    return res.json({
      success: true,
      extensionSelected: false,
      extension: null,
      agentStatus: null,
    });
  }
});

/**
 * Get current session start and breaks for login duration (total time excluding breaks).
 * sessionStart is ms since epoch; breaks are { start, end, reason } in ms.
 */
router.get('/session', async (req, res) => {
  try {
    const userId = req.agentUser.id;
    const tenantId = req.agentUser.parent_id;
    const user = await queryOne(
      'SELECT phone_login_number FROM users WHERE id = ? AND role = 5 LIMIT 1',
      [userId]
    );
    const phoneNum = user?.phone_login_number != null ? String(user.phone_login_number) : null;
    let sessionStart = null;
    if (phoneNum) {
      try {
        const row = await queryOne(
          'SELECT session_started_at FROM agent_status WHERE agent_id = ? LIMIT 1',
          [phoneNum]
        );
        if (row?.session_started_at) {
          const startedAt = new Date(row.session_started_at).getTime();
          const now = Date.now();
          const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
          if (now - startedAt > MAX_SESSION_AGE_MS) {
            await query(
              'UPDATE agent_status SET session_started_at = NOW() WHERE agent_id = ?',
              [phoneNum]
            );
            sessionStart = now;
          } else {
            sessionStart = startedAt;
          }
        }
      } catch (colErr) {
        if (colErr?.code !== 'ER_BAD_FIELD_ERROR') throw colErr;
      }
    }
    let breaks = [];
    if (sessionStart != null) {
      try {
        const sessionStartDate = new Date(sessionStart);
        const breakRows = await query(
          `SELECT start_time, end_time, break_name FROM session_agent_breaks
           WHERE agent_id = ? AND tenant_id = ? AND start_time >= ?
           ORDER BY start_time`,
          [userId, tenantId, sessionStartDate]
        );
        breaks = (breakRows || [])
          .filter((b) => b.start_time && b.end_time)
          .map((b) => ({
            start: new Date(b.start_time).getTime(),
            end: new Date(b.end_time).getTime(),
            reason: b.break_name || 'break',
          }));
      } catch (e) {
        if (e?.code !== 'ER_NO_SUCH_TABLE') throw e;
      }
    }
    return res.json({ success: true, sessionStart, breaks });
  } catch (err) {
    console.error('Agent session error:', err);
    return res.status(500).json({ success: false, error: 'Failed to get session' });
  }
});

/**
 * Start a break. Body: { reason: string }.
 * Updates agent_status so the wallboard sees the agent as on break.
 */
router.post('/break/start', async (req, res) => {
  try {
    const userId = req.agentUser.id;
    const { reason } = req.body || {};
    const breakName = reason != null ? String(reason).trim() || 'other' : 'other';
    const user = await queryOne(
      'SELECT phone_login_number FROM users WHERE id = ? AND role = 5 LIMIT 1',
      [userId]
    );
    const phoneNum = user?.phone_login_number != null ? String(user.phone_login_number) : null;
    if (phoneNum) {
      await query(
        `UPDATE agent_status SET status = 'PAUSED', break_name = ?, break_started_at = NOW(), timestamp = NOW() WHERE agent_id = ?`,
        [breakName, phoneNum]
      );
      const tenantRow = await queryOne('SELECT tenant_id FROM agent_status WHERE agent_id = ? LIMIT 1', [phoneNum]);
      if (tenantRow?.tenant_id) {
        const breakStartedAt = new Date().toISOString();
        broadcastToWallboard(tenantRow.tenant_id, { type: 'agent_status', payload: { agent_id: phoneNum, status: 'PAUSED', break_name: breakName, break_started_at: breakStartedAt } });
        logAgentStatusChange(tenantRow.tenant_id, phoneNum, 'PAUSED', { pauseReason: breakName });
      }
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('Agent break/start error:', err);
    return res.status(500).json({ success: false, error: 'Failed to start break' });
  }
});

/**
 * Switch to outbound mode: agent can make outbound calls; no inbound queue calls will be offered.
 */
router.post('/outbound/start', async (req, res) => {
  try {
    const user = await queryOne(
      'SELECT phone_login_number FROM users WHERE id = ? AND role = 5 LIMIT 1',
      [req.agentUser.id]
    );
    const phoneNum = user?.phone_login_number != null ? String(user.phone_login_number) : null;
    if (!phoneNum) {
      return res.status(400).json({ success: false, error: 'Agent phone not set' });
    }
    const tenantId = req.agentUser.parent_id;
    await query(
      `UPDATE agent_status SET status = 'Outbound', break_name = NULL, break_started_at = NULL, timestamp = NOW() WHERE agent_id = ?`,
      [phoneNum]
    );
    if (tenantId) logAgentStatusChange(tenantId, phoneNum, 'IN_CALL');
    return res.json({ success: true });
  } catch (err) {
    console.error('Agent outbound/start error:', err);
    return res.status(500).json({ success: false, error: 'Failed to start outbound mode' });
  }
});

/**
 * Resume inbound: agent is available for queue calls again.
 */
router.post('/outbound/end', async (req, res) => {
  try {
    const user = await queryOne(
      'SELECT phone_login_number FROM users WHERE id = ? AND role = 5 LIMIT 1',
      [req.agentUser.id]
    );
    const phoneNum = user?.phone_login_number != null ? String(user.phone_login_number) : null;
    if (phoneNum) {
      const tenantId = req.agentUser.parent_id;
      await query(
        `UPDATE agent_status SET status = 'LOGGEDIN', break_name = NULL, break_started_at = NULL, timestamp = NOW() WHERE agent_id = ?`,
        [phoneNum]
      );
      if (tenantId) logAgentStatusChange(tenantId, phoneNum, 'READY');
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('Agent outbound/end error:', err);
    return res.status(500).json({ success: false, error: 'Failed to resume inbound' });
  }
});

/**
 * Record end of a break. Body: { startTime: number (ms), reason: string }.
 * Updates agent_status first (so live monitoring/wallboard show Available), then persists to session_agent_breaks.
 */
router.post('/break/end', async (req, res) => {
  try {
    const userId = req.agentUser.id;
    const tenantId = req.agentUser.parent_id;
    const { startTime, reason } = req.body || {};
    const startMs = startTime != null ? Number(startTime) : NaN;
    if (!Number.isFinite(startMs) || startMs <= 0) {
      return res.status(400).json({ success: false, error: 'startTime (ms) required' });
    }
    const endTime = new Date();
    const startDate = new Date(startMs);
    if (startDate > endTime) {
      return res.status(400).json({ success: false, error: 'startTime must be in the past' });
    }
    const breakName = reason != null ? String(reason).trim() || 'other' : 'other';

    // Update agent_status first so live monitoring and wallboard show Available immediately
    const user = await queryOne(
      'SELECT phone_login_number FROM users WHERE id = ? AND role = 5 LIMIT 1',
      [userId]
    );
    const phoneNum = user?.phone_login_number != null ? String(user.phone_login_number) : null;
    if (phoneNum) {
      await query(
        `UPDATE agent_status SET status = 'LOGGEDIN', break_name = NULL, break_started_at = NULL, timestamp = NOW() WHERE agent_id = ?`,
        [phoneNum]
      );
      if (tenantId) {
        broadcastToWallboard(tenantId, { type: 'agent_status', payload: { agent_id: phoneNum, status: 'LOGGEDIN', break_name: null, break_started_at: null } });
        logAgentStatusChange(tenantId, phoneNum, 'READY');
      }
    }

    try {
      await query(
        `INSERT INTO session_agent_breaks (tenant_id, agent_id, start_time, end_time, break_name)
         VALUES (?, ?, ?, ?, ?)`,
        [tenantId, userId, startDate, endTime, breakName]
      );
    } catch (insertErr) {
      console.error('Agent break/end session_agent_breaks insert:', insertErr.message || insertErr);
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('Agent break/end error:', err);
    return res.status(500).json({ success: false, error: 'Failed to record break' });
  }
});

/**
 * CRM lookup by customer_id (e.g. external ID). Returns customer name, phone, email, notes.
 */
router.get('/crm', async (req, res) => {
  try {
    const customerId = (req.query.customer_id || '').toString().trim();
    if (!customerId) {
      return res.status(400).json({ success: false, error: 'customer_id required' });
    }
    const tenantId = req.agentUser.parent_id;
    if (tenantId == null) {
      return res.json({ success: false, error: 'No tenant assigned' });
    }
    let customer;
    try {
      customer = await queryOne(
        'SELECT customer_id, name, phone, email, notes FROM crm_customers WHERE tenant_id = ? AND customer_id = ? LIMIT 1',
        [tenantId, customerId]
      );
    } catch (e) {
      if (e?.code === 'ER_NO_SUCH_TABLE') {
        return res.json({ success: true, customer: null });
      }
      throw e;
    }
    if (!customer) {
      return res.json({ success: true, customer: null, error: 'Not found' });
    }
    return res.json({
      success: true,
      customer: {
        name: customer.name ?? null,
        phone: customer.phone ?? null,
        email: customer.email ?? null,
        notes: customer.notes ?? null,
      },
    });
  } catch (err) {
    console.error('Agent CRM error:', err);
    return res.status(500).json({ success: false, error: 'Search failed' });
  }
});

router.post('/select-extension', async (req, res) => {
  try {
    const { extension_id, extension_name } = req.body || {};
    const tenantId = req.agentUser.parent_id;
    const userId = req.agentUser.id;
    if (tenantId == null) {
      return res.status(400).json({ success: false, error: 'No tenant assigned' });
    }
    let extension;
    if (extension_id) {
      const rows = await query(
        'SELECT id, name FROM sip_extensions WHERE id = ? AND tenant_id = ? AND agent_user_id = ?',
        [extension_id, tenantId, userId]
      );
      extension = rows[0];
    } else if (extension_name) {
      const rows = await query(
        'SELECT id, name FROM sip_extensions WHERE name = ? AND tenant_id = ? AND agent_user_id = ?',
        [String(extension_name).trim(), tenantId, userId]
      );
      extension = rows[0];
    }
    if (!extension) {
      return res.status(400).json({ success: false, error: 'Invalid extension or extension not assigned to you.' });
    }
    try {
      const existing = await query(
        'SELECT user_id FROM agent_extension_usage WHERE extension_id = ?',
        [extension.id]
      );
      if (existing.length > 0) {
        const existingUserId = existing[0].user_id;
        if (Number(existingUserId) !== Number(userId)) {
          return res.status(400).json({
            success: false,
            error: 'This extension is already in use by another agent. Please choose a different extension.',
          });
        }
        req.session.agentExtension = { id: extension.id, name: extension.name };
        return res.json({ success: true, extension: req.session.agentExtension });
      }
      await query(
        'INSERT INTO agent_extension_usage (extension_id, user_id) VALUES (?, ?)',
        [extension.id, userId]
      );
    } catch (usageErr) {
      const msg = String(usageErr?.message || usageErr || '');
      if (!msg.includes('agent_extension_usage') && !msg.includes("doesn't exist") && usageErr?.code !== 'ER_NO_SUCH_TABLE') {
        throw usageErr;
      }
    }
    req.session.agentExtension = { id: extension.id, name: extension.name };
    return res.json({ success: true, extension: req.session.agentExtension });
  } catch (err) {
    console.error('Select extension error:', err);
    return res.status(500).json({ success: false, error: 'Failed to set extension' });
  }
});

router.post('/clear-extension', async (req, res) => {
  const userId = req.agentUser.id;
  await query('DELETE FROM agent_extension_usage WHERE user_id = ?', [userId]).catch(() => {});
  delete req.session.agentExtension;
  return res.json({ success: true });
});

/**
 * Block a number (e.g. prank caller). Adds to tenant blacklist so future calls from this number are dropped at InboundRoute.
 */
function normalizePhoneForBlacklist(raw) {
  if (raw == null || typeof raw !== 'string') return '';
  return raw.replace(/\D/g, '');
}

router.post('/block-number', async (req, res) => {
  try {
    const tenantId = req.agentUser.parent_id;
    if (tenantId == null) {
      return res.status(400).json({ success: false, error: 'No tenant assigned' });
    }
    const { number } = req.body || {};
    const normalized = normalizePhoneForBlacklist(number);
    if (!normalized) {
      return res.status(400).json({ success: false, error: 'Phone number required' });
    }
    await query(
      'INSERT INTO blacklist (tenant_id, number) VALUES (?, ?)',
      [tenantId, normalized]
    );
    const row = await queryOne(
      'SELECT id, tenant_id, number, created_at FROM blacklist WHERE tenant_id = ? AND number = ? ORDER BY id DESC LIMIT 1',
      [tenantId, normalized]
    );
    return res.json({ success: true, entry: row });
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062) {
      return res.json({ success: true, message: 'Number already blacklisted', entry: null });
    }
    if (err?.code === 'ER_NO_SUCH_TABLE') {
      return res.status(500).json({ success: false, error: 'Blacklist not available. Ask admin to run migration.' });
    }
    console.error('Agent block-number error:', err);
    return res.status(500).json({ success: false, error: 'Failed to block number' });
  }
});

/**
 * Agent logout from dashboard: hang up Asterisk channel (softphone call), clear agent_status and soft_phone_login_status.
 */
router.post('/logout', async (req, res) => {
  try {
    const userId = req.agentUser?.id;
    const user = await queryOne(
      'SELECT phone_login_number FROM users WHERE id = ? AND role = 5 LIMIT 1',
      [userId]
    );
    const phoneNum = user?.phone_login_number != null ? String(user.phone_login_number) : null;
    if (phoneNum) {
      const loginCh = getAgentLoginChannel(phoneNum);
      const row = await queryOne(
        'SELECT agent_channel_id FROM agent_status WHERE agent_id = ? LIMIT 1',
        [phoneNum]
      );
      const channelId = row?.agent_channel_id;
      const toHangup = loginCh || (channelId && typeof channelId === 'string' && channelId.trim()) || null;
      if (toHangup) {
        const ari = await hangupChannel(toHangup);
        if (ari.status !== 0 && ari.status !== 200 && ari.status !== 204 && ari.status !== 404) {
          console.warn('[agent logout] ARI hangup returned', ari.status, ari.body);
        }
      }
      const tenantRow = await queryOne('SELECT tenant_id FROM agent_status WHERE agent_id = ? LIMIT 1', [phoneNum]);
      await endAgentSession(phoneNum, 'normal');
      await query(
        `UPDATE agent_status SET status = 'LoggedOut', agent_channel_id = NULL, session_started_at = NULL, break_started_at = NULL, timestamp = NOW() WHERE agent_id = ?`,
        [phoneNum]
      );
      await query(
        'UPDATE users SET soft_phone_login_status = 0 WHERE phone_login_number = ? LIMIT 1',
        [phoneNum]
      );
      if (tenantRow?.tenant_id) broadcastToWallboard(tenantRow.tenant_id, { type: 'agent_status', payload: { agent_id: phoneNum, status: 'LoggedOut', break_started_at: null } });
    }
    delete req.session.agentExtension;
    await query('DELETE FROM agent_extension_usage WHERE user_id = ?', [userId]).catch(() => {});
    return res.json({ success: true });
  } catch (err) {
    console.error('Agent logout error:', err);
    return res.status(500).json({ success: false, error: 'Logout failed' });
  }
});

/**
 * Start SIP login: originate a call to the given extension. Asterisk will ring the phone,
 * answer, then prompt for numeric password (phone_login_password). On success, AgentLoginSuccess
 * sets agent_status to LOGGEDIN and soft_phone_login_status = 1. Frontend should poll GET /status
 * until agentStatus === 'LOGGEDIN' then redirect to dashboard.
 */
router.post('/call-extension', async (req, res) => {
  try {
    if (!isAriConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'Asterisk ARI not configured. Set ASTERISK_ARI_URL, ASTERISK_ARI_USER, ASTERISK_ARI_PASSWORD in .env',
      });
    }
    const { extension_id, extension_name } = req.body || {};
    const tenantId = req.agentUser.parent_id;
    const userId = req.agentUser.id;
    if (tenantId == null) {
      return res.status(400).json({ success: false, error: 'No tenant assigned' });
    }
    let extension;
    if (extension_id) {
      extension = await queryOne(
        'SELECT id, name FROM sip_extensions WHERE id = ? AND tenant_id = ? AND agent_user_id = ?',
        [extension_id, tenantId, userId]
      );
    } else if (extension_name) {
      extension = await queryOne(
        'SELECT id, name FROM sip_extensions WHERE name = ? AND tenant_id = ? AND agent_user_id = ?',
        [String(extension_name).trim(), tenantId, userId]
      );
    }
    if (!extension) {
      return res.status(400).json({ success: false, error: 'Invalid extension or extension not assigned to you. Use only your assigned extension.' });
    }
    const userRow = await queryOne(
      'SELECT phone_login_number, phone_login_password FROM users WHERE id = ? AND role = 5 LIMIT 1',
      [userId]
    );
    const agentNumber = userRow?.phone_login_number?.toString().replace(/\D/g, '') || '';
    const agentPassword = userRow?.phone_login_password?.toString().replace(/\D/g, '') || '';
    if (!agentNumber || !agentPassword) {
      return res.status(400).json({
        success: false,
        error: 'Agent phone number or phone password not set. Ask admin to set phone_login_number and phone_login_password for your account.',
      });
    }
    const channelId = `Agent-${extension.name}-${Date.now().toString(36)}`;
    let ari;
    try {
      ari = await originateAgentLogin(
        channelId,
        extension.name,
        'AgentLogin',
        { AgentNumber: agentNumber, AgentPassword: agentPassword },
        45
      );
    } catch (ariErr) {
      console.error('ARI originate error:', ariErr.message);
      return res.status(502).json({
        success: false,
        error: ariErr.message || 'Could not reach Asterisk. Check ARI URL and network.',
      });
    }
    if (ari.status !== 200) {
      console.error('ARI non-200:', ari.status, ari.body);
      const hint =
        ari.status === 401
          ? 'Check ASTERISK_ARI_USER and ASTERISK_ARI_PASSWORD in .env'
          : ari.status === 404
            ? 'Check Asterisk ARI is enabled and endpoint PJSIP/' + extension.name + ' exists and is registered'
            : `Asterisk ARI returned ${ari.status}`;
      return res.status(502).json({
        success: false,
        error: `Could not ring extension: ${hint}`,
      });
    }
    await query(
      `INSERT INTO agent_status (agent_id, tenant_id, status, agent_channel_id, extension_number, timestamp)
       VALUES (?, ?, 'SIP Phone Ringing', ?, ?, NOW())
       ON DUPLICATE KEY UPDATE status = 'SIP Phone Ringing', agent_channel_id = ?, extension_number = ?, timestamp = NOW()`,
      [agentNumber, tenantId, channelId, extension.name, channelId, extension.name]
    );
    req.session.agentExtension = { id: extension.id, name: extension.name };
    return res.json({ success: true, message: 'Ringing. Answer the phone and enter your PIN.' });
  } catch (err) {
    console.error('Call extension error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to originate call' });
  }
});

// ----- Phase 3: Call control (answer, reject, hangup, hold, unhold, transfer, dial) -----

async function getAgentPhoneAndStatus(req) {
  const user = await queryOne(
    'SELECT phone_login_number FROM users WHERE id = ? AND role = 5 LIMIT 1',
    [req.agentUser.id]
  );
  const phoneNum = user?.phone_login_number != null ? String(user.phone_login_number).replace(/\D/g, '') : null;
  if (!phoneNum) return { phoneNum: null, status: null };
  const status = await queryOne(
    'SELECT agent_channel_id, customer_channel_id, call_id, extension_number FROM agent_status WHERE agent_id = ? LIMIT 1',
    [phoneNum]
  );
  return { phoneNum, status };
}

router.post('/calls/answer', async (req, res) => {
  try {
    if (!isAriConfigured()) {
      return res.status(503).json({ success: false, error: 'ARI not configured' });
    }
    const { channel_id } = req.body || {};
    const channelId = channel_id || req.body?.channelId;
    const { phoneNum, status } = await getAgentPhoneAndStatus(req);
    if (!phoneNum) {
      return res.status(400).json({ success: false, error: 'Agent phone not set' });
    }
    const customerChannelId = channelId || status?.customer_channel_id;
    const uniqueId = status?.call_id;

    const pendingCustCh = getPendingCustomerChannel(phoneNum);
    const isQueueDashboardCall = !!pendingCustCh;
    if (isQueueDashboardCall) {
      const result = await answerQueueCallWithLoginChannel(pendingCustCh, phoneNum, uniqueId);
      if (!result.success) {
        return res.status(502).json({ success: false, error: result.error });
      }
      if (uniqueId) await setAgentAnswered(phoneNum, uniqueId);
      return res.json({ success: true });
    }

    const toAnswer = channelId || status?.customer_channel_id || status?.agent_channel_id;
    if (toAnswer) {
      const ari = await answerChannel(toAnswer);
      if (ari.status !== 0 && ari.status !== 200 && ari.status !== 204) {
        return res.status(502).json({ success: false, error: 'Failed to answer', detail: ari.body });
      }
    }
    if (uniqueId) await setAgentAnswered(phoneNum, uniqueId);
    return res.json({ success: true });
  } catch (err) {
    console.error('Calls answer error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Answer failed' });
  }
});

router.post('/calls/reject', async (req, res) => {
  try {
    if (!isAriConfigured()) {
      return res.status(503).json({ success: false, error: 'ARI not configured' });
    }
    const { channel_id } = req.body || {};
    const channelId = channel_id || req.body?.channelId;
    const { phoneNum, status } = await getAgentPhoneAndStatus(req);
    const toHangup = channelId || status?.customer_channel_id || status?.agent_channel_id;
    if (!toHangup) {
      return res.status(400).json({ success: false, error: 'No channel to reject' });
    }
    const pendingCustomerCh = getPendingCustomerChannel(phoneNum);
    if (pendingCustomerCh === toHangup) {
      await tryNextQueueAgent(toHangup);
      return res.json({ success: true });
    }
    const ari = await hangupChannel(toHangup);
    if (ari.status !== 0 && ari.status !== 404 && (ari.status < 200 || ari.status >= 300)) {
      return res.status(502).json({ success: false, error: 'Reject failed', detail: ari.body });
    }
    const uniqueId = status?.call_id;
    if (uniqueId) {
      await setAgentHangup(phoneNum, uniqueId, 'rejected');
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('Calls reject error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Reject failed' });
  }
});

router.post('/calls/hangup', async (req, res) => {
  try {
    if (!isAriConfigured()) {
      return res.status(503).json({ success: false, error: 'ARI not configured' });
    }
    const { channel_id } = req.body || {};
    const { phoneNum, status } = await getAgentPhoneAndStatus(req);
    const toHangup = channel_id || req.body?.channelId || status?.customer_channel_id || status?.agent_channel_id;
    if (!toHangup) {
      return res.status(400).json({ success: false, error: 'No active call' });
    }
    const bridgedHandled = await hangupBridgedQueueCall(toHangup, phoneNum);
    if (bridgedHandled) {
      return res.json({ success: true });
    }
    const ari = await hangupChannel(toHangup);
    if (ari.status !== 0 && ari.status !== 404 && (ari.status < 200 || ari.status >= 300)) {
      return res.status(502).json({ success: false, error: 'Hangup failed', detail: ari.body });
    }
    const uniqueId = status?.call_id;
    if (uniqueId && phoneNum) {
      await setAgentHangup(phoneNum, uniqueId, 'completed');
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('Calls hangup error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Hangup failed' });
  }
});

router.post('/calls/hold', async (req, res) => {
  try {
    if (!isAriConfigured()) {
      return res.status(503).json({ success: false, error: 'ARI not configured' });
    }
    const { channel_id } = req.body || {};
    const { status } = await getAgentPhoneAndStatus(req);
    const toHold = channel_id || req.body?.channelId || status?.customer_channel_id || status?.agent_channel_id;
    if (!toHold) {
      return res.status(400).json({ success: false, error: 'No active call' });
    }
    const ari = await holdChannel(toHold);
    if (ari.status !== 0 && ari.status !== 200 && ari.status !== 204) {
      return res.status(502).json({ success: false, error: 'Hold failed', detail: ari.body });
    }
    broadcastAgentStatus(req.agentUser.id, { callState: 'on_hold' });
    return res.json({ success: true });
  } catch (err) {
    console.error('Calls hold error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Hold failed' });
  }
});

router.post('/calls/unhold', async (req, res) => {
  try {
    if (!isAriConfigured()) {
      return res.status(503).json({ success: false, error: 'ARI not configured' });
    }
    const { channel_id } = req.body || {};
    const { status } = await getAgentPhoneAndStatus(req);
    const toUnhold = channel_id || req.body?.channelId || status?.customer_channel_id || status?.agent_channel_id;
    if (!toUnhold) {
      return res.status(400).json({ success: false, error: 'No active call' });
    }
    const ari = await unholdChannel(toUnhold);
    if (ari.status !== 0 && ari.status !== 200 && ari.status !== 204) {
      return res.status(502).json({ success: false, error: 'Unhold failed', detail: ari.body });
    }
    broadcastAgentStatus(req.agentUser.id, { callState: 'connected' });
    return res.json({ success: true });
  } catch (err) {
    console.error('Calls unhold error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Unhold failed' });
  }
});

router.post('/calls/transfer', async (req, res) => {
  try {
    if (!isAriConfigured()) {
      return res.status(503).json({ success: false, error: 'ARI not configured' });
    }
    const { target, type } = req.body || {};
    const targetStr = (target || req.body?.extension || '').toString().trim().replace(/\D/g, '') || (target || '').toString().trim();
    if (!targetStr) {
      return res.status(400).json({ success: false, error: 'Transfer target (number or extension) required' });
    }
    const { phoneNum, status } = await getAgentPhoneAndStatus(req);
    if (!phoneNum) {
      return res.status(400).json({ success: false, error: 'Agent phone not set' });
    }
    const endpoint = `PJSIP/${targetStr}`;
    const transferType = (type || 'blind').toLowerCase() === 'attended' ? 'attended' : 'blind';

    const result = await transferBridgedCallToExtension(phoneNum, endpoint, transferType);
    if (result.success) {
      return res.json({ success: true });
    }
    if (result.error === 'Agent and target extension required') {
      return res.status(400).json({ success: false, error: result.error });
    }
    const customerChannelId = status?.customer_channel_id;
    if (customerChannelId && result.error === 'No active call to transfer') {
      const ari = await redirectChannel(customerChannelId, endpoint);
      if (ari.status === 200 || ari.status === 204) {
        const uniqueId = status?.call_id;
        if (uniqueId) await setAgentHangup(phoneNum, uniqueId, 'transferred');
        return res.json({ success: true });
      }
    }
    if (result.error === 'No active call to transfer') {
      return res.status(400).json({ success: false, error: result.error });
    }
    return res.status(502).json({ success: false, error: result.error || 'Transfer failed' });
  } catch (err) {
    console.error('Calls transfer error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Transfer failed' });
  }
});

router.post('/calls/dial', async (req, res) => {
  try {
    if (!isAriConfigured()) {
      return res.status(503).json({ success: false, error: 'ARI not configured' });
    }
    const { number } = req.body || {};
    const num = (number || req.body?.destination || '').toString().replace(/\D/g, '');
    if (!num) {
      return res.status(400).json({ success: false, error: 'Number required' });
    }
    const tenantId = req.agentUser.parent_id;
    const { phoneNum, status } = await getAgentPhoneAndStatus(req);
    if (!phoneNum) {
      return res.status(400).json({ success: false, error: 'Agent phone not set' });
    }
    if (status?.call_id) {
      return res.status(409).json({ success: false, error: 'Already on a call' });
    }
    const agentStatusRow = await queryOne(
      'SELECT status FROM agent_status WHERE agent_id = ? LIMIT 1',
      [phoneNum]
    );
    const statusStr = (agentStatusRow?.status || '').toString().toUpperCase();
    if (statusStr !== 'OUTBOUND') {
      return res.status(400).json({
        success: false,
        error: 'Switch to outbound mode first (click "Make outbound call") to dial.',
      });
    }
    const extensionName = req.session?.agentExtension?.name || status?.extension_number || phoneNum;
    const route = await queryOne(
      'SELECT trunk_name FROM outbound_routes WHERE tenant_id = ? LIMIT 1',
      [tenantId]
    );
    const trunkName = route?.trunk_name || 'default';
    const endpoint = `PJSIP/${num}@${trunkName}`;
    const channelId = `Outbound-${phoneNum}-${Date.now().toString(36)}`;
    const uniqueId = channelId;
    await createCallRecord({
      tenantId,
      uniqueId,
      channelId,
      sourceNumber: extensionName,
      destinationNumber: num,
      direction: 'outbound',
      agentUserId: req.agentUser.id,
      agentExtension: extensionName,
      agentId: phoneNum,
    });
    // Stop MOH on agent's channel so it does not play during outbound
    if (status?.agent_channel_id) {
      await stopMohOnChannel(status.agent_channel_id).catch(() => {});
    }
    // Originate outbound into Stasis so we can bridge to agent when far end answers (no demo dialplan)
    const appArgs = ['outbound', status?.agent_channel_id || '', uniqueId];
    const ari = await originateIntoStasis(channelId, endpoint, 'queue-dashboard', appArgs, 60);
    if (ari.status !== 200 && ari.status !== 201) {
      await setAgentHangup(phoneNum, uniqueId, 'failed');
      return res.status(502).json({
        success: false,
        error: 'Outbound originate failed. Check trunk and Stasis app.',
        detail: ari.body,
      });
    }
    return res.json({ success: true, channelId, uniqueId });
  } catch (err) {
    console.error('Calls dial error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Dial failed' });
  }
});

export default router;

import express from 'express';
import { query, queryOne } from '../db.js';
import { originateAgentLogin, isAriConfigured } from '../asterisk-ari.js';

const router = express.Router();

function requireAgent(req, res, next) {
  const user = req.session?.user;
  if (!user || user.role !== 'agent') {
    return res.status(403).json({ success: false, error: 'Agent access required' });
  }
  req.agentUser = user;
  next();
}

router.use(requireAgent);

router.get('/extensions', async (req, res) => {
  try {
    const tenantId = req.agentUser.parent_id;
    const userId = req.agentUser.id;
    if (tenantId == null) {
      return res.json({ success: true, extensions: [] });
    }
    let rows;
    try {
      rows = await query(
        `SELECT e.id, e.name,
          (u.user_id IS NOT NULL) AS in_use,
          (u.user_id = ?) AS in_use_by_me
         FROM sip_extensions e
         LEFT JOIN agent_extension_usage u ON u.extension_id = e.id
         WHERE e.tenant_id = ?
         ORDER BY e.name`,
        [userId, tenantId]
      );
    } catch (joinErr) {
      const msg = String(joinErr?.message || joinErr || '');
      if (msg.includes('agent_extension_usage') || msg.includes("doesn't exist") || joinErr?.code === 'ER_NO_SUCH_TABLE') {
        rows = await query(
          'SELECT id, name FROM sip_extensions WHERE tenant_id = ? ORDER BY name',
          [tenantId]
        );
        rows = rows.map((r) => ({ ...r, in_use: 0, in_use_by_me: 0 }));
      } else {
        throw joinErr;
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
    const extension = req.session?.agentExtension;
    let agentStatus = null;
    const userId = req.agentUser?.id;
    const user = await queryOne(
      'SELECT phone_login_number FROM users WHERE id = ? AND role = 5 LIMIT 1',
      [userId]
    );
    const phoneNum = user?.phone_login_number != null ? String(user.phone_login_number) : null;
    if (phoneNum) {
      const row = await queryOne(
        'SELECT status FROM agent_status WHERE agent_id = ? LIMIT 1',
        [phoneNum]
      );
      const raw = row?.status;
      agentStatus = raw != null ? String(raw).trim() : null;
    }
    const payload = {
      success: true,
      extensionSelected: !!extension,
      extension: extension || null,
      agentStatus: agentStatus || null,
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
      extensionSelected: !!req.session?.agentExtension,
      extension: req.session?.agentExtension || null,
      agentStatus: null,
    });
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
        'SELECT id, name FROM sip_extensions WHERE id = ? AND tenant_id = ?',
        [extension_id, tenantId]
      );
      extension = rows[0];
    } else if (extension_name) {
      const rows = await query(
        'SELECT id, name FROM sip_extensions WHERE name = ? AND tenant_id = ?',
        [String(extension_name).trim(), tenantId]
      );
      extension = rows[0];
    }
    if (!extension) {
      return res.status(400).json({ success: false, error: 'Invalid extension' });
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
        'SELECT id, name FROM sip_extensions WHERE id = ? AND tenant_id = ?',
        [extension_id, tenantId]
      );
    } else if (extension_name) {
      extension = await queryOne(
        'SELECT id, name FROM sip_extensions WHERE name = ? AND tenant_id = ?',
        [String(extension_name).trim(), tenantId]
      );
    }
    if (!extension) {
      return res.status(400).json({ success: false, error: 'Invalid extension' });
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

export default router;

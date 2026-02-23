/**
 * Asterisk dialplan callbacks (no auth). Called by Asterisk VM via curl.
 * Base path: /api/asterisk/ so APIURL = http://<app-host>:3001/api/asterisk/
 * Endpoints: US4GROUP_Agent/AgentLogin?, US4GROUP_Agent/AgentLogout?, US4GROUP_Agent/AgentLoginSuccess?
 */
import express from 'express';
import { query } from '../db.js';

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

// AgentLogin - dialplan calls when call is answered and before Authenticate()
router.get('/US4GROUP_Agent/AgentLogin', async (req, res) => {
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
});

// AgentLogout - dialplan calls on hangup when password was wrong or user hung up
router.get('/US4GROUP_Agent/AgentLogout', async (req, res) => {
  try {
    const agentId = parseAgentId(req);
    if (agentId != null) {
      await query(
        `UPDATE agent_status SET status = 'LoginFailed', timestamp = NOW() WHERE agent_id = ?`,
        [String(agentId)]
      );
    }
    sendResponse(res, 'LoginFailed');
  } catch (err) {
    console.error('Asterisk AgentLogout error:', err);
    sendResponse(res, 'LoginFailed');
  }
});

// AgentLoginSuccess - dialplan calls after successful AgentLogin() so dashboard shows agent as logged in
router.get('/US4GROUP_Agent/AgentLoginSuccess', async (req, res) => {
  try {
    const agentId = parseAgentId(req);
    if (agentId == null) {
      return sendResponse(res, 'LoginSuccess');
    }
    const aid = String(agentId);
    await query(
      `UPDATE agent_status SET status = 'LOGGEDIN', timestamp = NOW() WHERE agent_id = ?`,
      [aid]
    );
    await query(
      `UPDATE users SET soft_phone_login_status = 1 WHERE phone_login_number = ? LIMIT 1`,
      [aid]
    );
    sendResponse(res, 'LoginSuccess');
  } catch (err) {
    console.error('Asterisk AgentLoginSuccess error:', err);
    sendResponse(res, 'LoginSuccess');
  }
});

export default router;

import express from 'express';
import bcrypt from 'bcrypt';
import {
  findUserByUsername,
  findUsersByUsername,
  updateLastLogin,
  updatePassword,
  getEnabledModules,
  buildSessionUser,
  verifyCurrentPassword,
} from '../auth.js';
import { query, queryOne } from '../db.js';
import { endAgentSession } from '../agent-sessions.js';
import { hangupChannel } from '../asterisk-ari.js';
import { getAgentLoginChannel } from '../ari-stasis-queue.js';
import { broadcastToWallboard } from '../realtime.js';
import { validate, loginSchema, changePasswordSchema } from '../utils/schemas.js';

const router = express.Router();

/** When a new user logs in in the same browser, mark the previous session's agent as LoggedOut so live monitoring does not show them as Available. */
async function clearPreviousAgentStatusOnLogin(req) {
  const prev = req.session?.user;
  if (!prev || prev.role !== 'agent' || !prev.id) return;
  const row = await queryOne(
    'SELECT phone_login_number FROM users WHERE id = ? AND role = 5 LIMIT 1',
    [prev.id]
  );
  const phoneNum = row?.phone_login_number != null ? String(row.phone_login_number) : null;
  if (!phoneNum) return;
  await endAgentSession(phoneNum, 'normal');
  await query(
    `UPDATE agent_status SET status = 'LoggedOut', agent_channel_id = NULL, session_started_at = NULL, timestamp = NOW() WHERE agent_id = ?`,
    [phoneNum]
  );
  await query('UPDATE users SET soft_phone_login_status = 0 WHERE phone_login_number = ? LIMIT 1', [phoneNum]).catch(() => {});
}

router.post('/login', validate(loginSchema), async (req, res) => {
  try {
    const { username, password } = req.body;
    const trimmedUsername = String(username).trim();
    const candidates = await findUsersByUsername(trimmedUsername);
    if (!candidates || candidates.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid credentials or account disabled' });
    }
    // With per-tenant usernames, multiple users can share a username; try password against each enabled account
    let user = null;
    for (const u of candidates) {
      if (u.account_status !== 1) continue;
      const ok = await bcrypt.compare(password, u.password_hash);
      if (ok) {
        user = u;
        break;
      }
    }
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials or account disabled' });
    }
    await clearPreviousAgentStatusOnLogin(req);
    await updateLastLogin(user.id);
    const modules = await getEnabledModules(user.role);
    const sessionUser = buildSessionUser(user, modules);
    req.session = req.session || {};
    req.session.user = sessionUser;
    if (sessionUser.role === 'agent') {
      delete req.session.agentExtension;
    }
    return res.json({ success: true, user: sessionUser });
  } catch (err) {
    console.error('Login error:', err);
    if (err.code === 'ER_ACCESS_DENIED_ERROR' || (err.message && err.message.includes('using password: NO'))) {
      return res.status(503).json({
        success: false,
        error: 'Database not configured. Set DB_PASSWORD in .env to your MySQL root password and restart the server.',
      });
    }
    if (err.code === 'ECONNREFUSED') {
      return res.status(503).json({ success: false, error: 'Database not reachable. Start MySQL service.' });
    }
    return res.status(500).json({ success: false, error: 'Login failed' });
  }
});

router.post('/logout', async (req, res) => {
  const userId = req.session?.user?.id;
  const session = req.session;
  const wasAgent = req.session?.user?.role === 'agent';

  if (wasAgent && userId) {
    try {
      const row = await queryOne(
        'SELECT phone_login_number FROM users WHERE id = ? AND role = 5 LIMIT 1',
        [userId]
      );
      const phoneNum = row?.phone_login_number != null ? String(row.phone_login_number) : null;
      if (phoneNum) {
        const loginCh = getAgentLoginChannel(phoneNum);
        const statusRow = await queryOne(
          'SELECT agent_channel_id, tenant_id FROM agent_status WHERE agent_id = ? LIMIT 1',
          [phoneNum]
        );
        const channelId = statusRow?.agent_channel_id;
        const toHangup = loginCh || (channelId && typeof channelId === 'string' && channelId.trim()) || null;
        if (toHangup) {
          await hangupChannel(toHangup).catch((e) =>
            console.warn('[auth logout] ARI hangup:', e?.message || e)
          );
        }
        await endAgentSession(phoneNum, 'normal');
        await query(
          `UPDATE agent_status SET status = 'LoggedOut', agent_channel_id = NULL, session_started_at = NULL, break_started_at = NULL, timestamp = NOW() WHERE agent_id = ?`,
          [phoneNum]
        );
        await query('UPDATE users SET soft_phone_login_status = 0 WHERE phone_login_number = ? LIMIT 1', [phoneNum]).catch(() => {});
        if (statusRow?.tenant_id) {
          broadcastToWallboard(statusRow.tenant_id, { type: 'agent_status', payload: { agent_id: phoneNum, status: 'LoggedOut', break_started_at: null } });
        }
      }
    } catch (e) {
      console.warn('[auth logout] agent cleanup:', e?.message || e);
    }
  }

  if (userId) {
    query('DELETE FROM agent_extension_usage WHERE user_id = ?', [userId]).catch(() => {});
  }
  delete session?.agentExtension;
  const sendResponse = () => {
    res.clearCookie('pbx.sid');
    res.json({ success: true });
  };
  if (session && typeof session.destroy === 'function') {
    session.destroy((err) => {
      if (err) console.error('Logout session destroy error:', err);
      sendResponse();
    });
  } else {
    sendResponse();
  }
});

router.post('/change-password', validate(changePasswordSchema), async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    const { current_password, new_password } = req.body || {};
    if (!new_password || new_password.length < 6) {
      return res.status(400).json({ success: false, error: 'New password must be at least 6 characters' });
    }
    const ok = await verifyCurrentPassword(userId, current_password || '');
    if (!ok) {
      return res.status(400).json({ success: false, error: 'Current password is incorrect' });
    }
    await updatePassword(userId, new_password);
    return res.json({ success: true });
  } catch (err) {
    console.error('Change password error:', err);
    return res.status(500).json({ success: false, error: 'Change password failed' });
  }
});

router.get('/me', (req, res) => {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ success: false, error: 'Not authenticated' });
  return res.json({ success: true, user });
});

export default router;

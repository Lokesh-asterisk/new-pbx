import express from 'express';
import {
  verifyLogin,
  updateLastLogin,
  updatePassword,
  getPermissions,
  buildSessionUser,
  verifyCurrentPassword,
} from '../auth.js';
import { query } from '../db.js';

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }
    const user = await verifyLogin(String(username).trim(), password);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials or account disabled' });
    }
    await updateLastLogin(user.id);
    const permissions = await getPermissions(user.permission_group_id);
    const sessionUser = buildSessionUser(user, permissions);
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

router.post('/logout', (req, res) => {
  const userId = req.session?.user?.id;
  const session = req.session;
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

router.post('/change-password', async (req, res) => {
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

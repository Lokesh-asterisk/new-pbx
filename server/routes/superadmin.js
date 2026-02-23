import express from 'express';
import bcrypt from 'bcrypt';
import { query, queryOne } from '../db.js';
import { roleName } from '../auth.js';
import { syncAgentsToAsterisk, syncExtensionsToAsterisk } from '../asterisk-config-sync.js';

const ROLE_IDS = { superadmin: 1, admin: 2, user: 3, campaign: 4, agent: 5 };

const router = express.Router();

function requireSuperadmin(req, res, next) {
  const user = req.session?.user;
  if (!user) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }
  if (user.role !== 'superadmin') {
    return res.status(403).json({ success: false, error: 'Superadmin only' });
  }
  next();
}

router.use(requireSuperadmin);

// --- Users ---

router.get('/users', async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, username, email, role, parent_id, account_status, created_at,
              phone_login_number,
              (phone_login_password IS NOT NULL AND phone_login_password != '') AS phone_login_set
       FROM users ORDER BY id`
    );
    const users = rows.map((r) => ({
      id: r.id,
      username: r.username,
      email: r.email || '',
      role: roleName(r.role),
      role_id: r.role,
      parent_id: r.parent_id,
      account_status: r.account_status,
      created_at: r.created_at,
      phone_login_number: r.phone_login_number || '',
      phone_login_set: !!r.phone_login_set,
    }));
    return res.json({ success: true, users });
  } catch (err) {
    console.error('Superadmin list users error:', err);
    return res.status(500).json({ success: false, error: 'Failed to list users' });
  }
});

router.post('/users', async (req, res) => {
  try {
    const {
      username,
      password,
      role: roleNameParam,
      email,
      parent_id,
      phone_login_number,
      phone_login_password,
    } = req.body || {};
    const roleId = ROLE_IDS[String(roleNameParam || '').toLowerCase()];
    if (!roleId) {
      return res.status(400).json({ success: false, error: 'Role must be: superadmin, admin, user, or agent' });
    }
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }
    const parentId = roleId === 5 && parent_id != null && parent_id !== '' ? parseInt(parent_id, 10) : null;
    const phoneNum = phone_login_number != null && String(phone_login_number).trim() !== '' ? String(phone_login_number).trim() : null;
    const phonePass = phone_login_password != null && String(phone_login_password).trim() !== '' ? String(phone_login_password).trim() : null;
    if (roleId === 5 && (!phoneNum || !phonePass)) {
      return res.status(400).json({
        success: false,
        error: 'Agents require phone login number (extension) and phone login password (PIN)',
      });
    }
    const hash = await bcrypt.hash(password, 10);
    const emailVal = email && String(email).trim() ? String(email).trim() : `${username}@localhost`;
    await query(
      `INSERT INTO users (username, password_hash, email, role, parent_id, account_status, change_password_required, phone_login_number, phone_login_password)
       VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`,
      [String(username).trim(), hash, emailVal, roleId, parentId, roleId === 5 ? phoneNum : null, roleId === 5 ? phonePass : null]
    );
    const [row] = await query('SELECT id, username, email, role, parent_id, created_at FROM users WHERE username = ?', [
      String(username).trim(),
    ]);
    const user = row
      ? {
          id: row.id,
          username: row.username,
          email: row.email || '',
          role: roleName(row.role),
          parent_id: row.parent_id,
          created_at: row.created_at,
        }
      : null;
    if (roleId === 5) syncAgentsToAsterisk().catch((e) => console.error('Asterisk agents sync:', e.message));
    return res.json({ success: true, user });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, error: 'Username already exists' });
    }
    console.error('Superadmin create user error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create user' });
  }
});

router.patch('/users/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid user ID' });
    }
    const { phone_login_number, phone_login_password } = req.body || {};
    const phoneNum = phone_login_number != null && String(phone_login_number).trim() !== '' ? String(phone_login_number).trim() : null;
    const phonePass = phone_login_password != null && String(phone_login_password).trim() !== '' ? String(phone_login_password).trim() : null;
    const [existing] = await query('SELECT id, role FROM users WHERE id = ?', [id]);
    if (!existing.length) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    if (existing[0].role !== 5) {
      return res.status(400).json({ success: false, error: 'Only agent users have phone login fields' });
    }
    await query(
      'UPDATE users SET phone_login_number = ?, phone_login_password = ? WHERE id = ?',
      [phoneNum, phonePass, id]
    );
    syncAgentsToAsterisk().catch((e) => console.error('Asterisk agents sync:', e.message));
    return res.json({ success: true });
  } catch (err) {
    console.error('Superadmin update user phone error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update user' });
  }
});

router.delete('/users/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid user ID' });
    }
    const [existing] = await query('SELECT id, role, phone_login_number FROM users WHERE id = ?', [id]);
    if (!existing.length) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    const wasAgent = existing[0].role === 5;
    const agentId = wasAgent ? String(existing[0].phone_login_number || '').trim() : null;
    await query('DELETE FROM users WHERE id = ?', [id]);
    if (agentId) {
      await query('DELETE FROM agent_status WHERE agent_id = ?', [agentId]).catch(() => {});
      syncAgentsToAsterisk().catch((e) => console.error('Asterisk agents sync:', e.message));
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('Superadmin delete user error:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete user' });
  }
});

// --- SIP extensions ---

router.get('/sip-extensions', async (req, res) => {
  try {
    const tenantId = req.query.tenant_id;
    let sql =
      'SELECT id, tenant_id, name, secret, context, host, type, dtmfmode, created_at FROM sip_extensions';
    const params = [];
    if (tenantId != null && tenantId !== '') {
      sql += ' WHERE tenant_id = ?';
      params.push(parseInt(tenantId, 10));
    }
    sql += ' ORDER BY tenant_id, name';
    const extensions = await query(sql, params);
    return res.json({ success: true, extensions });
  } catch (err) {
    console.error('Superadmin list sip-extensions error:', err);
    return res.status(500).json({ success: false, error: 'Failed to list SIP extensions' });
  }
});

router.post('/sip-extensions', async (req, res) => {
  try {
    const { tenant_id, name, secret, context, host, type } = req.body || {};
    const tenantId = parseInt(tenant_id, 10);
    if (!tenant_id || isNaN(tenantId) || tenantId < 1) {
      return res.status(400).json({ success: false, error: 'Valid tenant_id required' });
    }
    const extName = String(name || '').trim();
    if (!extName) {
      return res.status(400).json({ success: false, error: 'Extension name required' });
    }
    await query(
      `INSERT INTO sip_extensions (tenant_id, name, secret, context, host, type)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        tenantId,
        extName,
        secret && String(secret).trim() ? String(secret).trim() : null,
        context && String(context).trim() ? String(context).trim() : null,
        host && String(host).trim() ? String(host).trim() : null,
        type && String(type).trim() ? String(type).trim() : 'friend',
      ]
    );
    const row = await queryOne(
      'SELECT id, tenant_id, name, secret, context, host, type, created_at FROM sip_extensions WHERE tenant_id = ? AND name = ?',
      [tenantId, extName]
    );
    syncExtensionsToAsterisk().catch((e) => console.error('Asterisk extensions sync:', e.message));
    return res.json({ success: true, extension: row });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, error: 'Extension name already exists for this tenant' });
    }
    console.error('Superadmin create sip-extension error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create SIP extension' });
  }
});

router.patch('/sip-extensions/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid extension ID' });
    }
    const { tenant_id, name, secret, context, host, type } = req.body || {};
    const [existing] = await query('SELECT id, tenant_id, name, secret, context, host, type FROM sip_extensions WHERE id = ?', [id]);
    if (!existing.length) {
      return res.status(404).json({ success: false, error: 'SIP extension not found' });
    }
    const row = existing[0];
    const tenantId = tenant_id != null && tenant_id !== '' ? parseInt(tenant_id, 10) : row.tenant_id;
    const extName = name != null && String(name).trim() !== '' ? String(name).trim() : row.name;
    if (!extName) {
      return res.status(400).json({ success: false, error: 'Extension name required' });
    }
    const secretVal = secret !== undefined
      ? (String(secret).trim() !== '' ? String(secret).trim() : null)
      : row.secret;
    const contextVal = context !== undefined ? (String(context).trim() !== '' ? String(context).trim() : null) : row.context;
    const hostVal = host !== undefined ? (String(host).trim() !== '' ? String(host).trim() : null) : row.host;
    const typeVal = type != null && String(type).trim() !== '' ? String(type).trim() : 'friend';
    await query(
      `UPDATE sip_extensions SET tenant_id = ?, name = ?, secret = ?, context = ?, host = ?, type = ?
       WHERE id = ?`,
      [tenantId, extName, secretVal, contextVal, hostVal, typeVal, id]
    );
    syncExtensionsToAsterisk().catch((e) => console.error('Asterisk extensions sync:', e.message));
    return res.json({ success: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, error: 'Extension name already exists for this tenant' });
    }
    console.error('Superadmin update sip-extension error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update SIP extension' });
  }
});

router.delete('/sip-extensions/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid extension ID' });
    }
    const [existing] = await query('SELECT id FROM sip_extensions WHERE id = ?', [id]);
    if (!existing.length) {
      return res.status(404).json({ success: false, error: 'SIP extension not found' });
    }
    await query('DELETE FROM sip_extensions WHERE id = ?', [id]);
    syncExtensionsToAsterisk().catch((e) => console.error('Asterisk extensions sync:', e.message));
    return res.json({ success: true });
  } catch (err) {
    console.error('Superadmin delete sip-extension error:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete SIP extension' });
  }
});

export default router;

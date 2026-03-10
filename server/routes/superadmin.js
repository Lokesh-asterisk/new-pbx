import express from 'express';
import bcrypt from 'bcrypt';
import fs from 'fs';
import path from 'path';
import { query, queryOne } from '../db.js';
import { roleName } from '../auth.js';
import ALL_MODULES from '../modules.js';
import { syncAgentsToAsterisk, syncExtensionsToAsterisk, syncTrunksToAsterisk, syncDialplanToAsterisk, syncAllToAsterisk } from '../asterisk-config-sync.js';
import { getPjsipEndpointStates, getPjsipEndpointsRaw, originateIntoStasis, originateToContext, getQueueStasisAppName, isAriConfigured } from '../asterisk-ari.js';
import { getBridgedCallInfo, forceLogoutAgent } from '../ari-stasis-queue.js';
import { destroySessionsForUser } from '../session-utils.js';
import { endAgentSession } from '../agent-sessions.js';
import { setExtensionAgentUserId } from '../agent-extension-resolver.js';

async function ensureSipExtensionForAgent(tenantId, extensionName, secret) {
  const tid = (tenantId != null && tenantId !== '' && !Number.isNaN(Number(tenantId)))
    ? Number(tenantId)
    : 1;
  const name = String(extensionName).trim();
  if (!name) return;
  const ext = await queryOne(
    'SELECT id FROM sip_extensions WHERE tenant_id = ? AND name = ? LIMIT 1',
    [tid, name]
  );
  if (!ext) {
    await query(
      `INSERT INTO sip_extensions (tenant_id, name, secret, context, host, type)
       VALUES (?, ?, ?, 'from-internal', NULL, 'friend')`,
      [tid, name, secret || name]
    );
  }
}

const ROLE_IDS = { superadmin: 1, admin: 2, user: 3, campaign: 4, agent: 5 };

const PATH_MODULE_MAP = {
  'users': 'users',
  'tenants': 'tenants',
  'sip-extensions': 'extensions',
  'debug-ari-endpoints': 'extensions',
  'sip-trunks': 'trunks',
  'stats': 'dashboard',
  'inbound-routes': 'inbound',
  'outbound-routes': 'outbound',
  'queues': 'queues',
  'ivr-menus': 'ivr',
  'time-conditions': 'timeconditions',
  'time-groups': 'timeconditions',
  'sound-files': 'sounds',
  'voicemail-boxes': 'voicemail',
  'live-agents': 'wallboard',
  'cdr': 'cdr',
  'asterisk-logs': '_system',
};

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

function requireModuleAccess(req, res, next) {
  const user = req.session?.user;
  if (!user) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }
  if (user.role === 'superadmin') return next();

  const firstSegment = req.path.split('/').filter(Boolean)[0] || '';
  const requiredModule = PATH_MODULE_MAP[firstSegment];

  if (!requiredModule) {
    return res.status(403).json({ success: false, error: 'Superadmin only' });
  }
  if (Array.isArray(user.modules) && user.modules.includes(requiredModule)) {
    return next();
  }
  return res.status(403).json({ success: false, error: 'Module not enabled for your role' });
}

router.use(requireModuleAccess);

/** For admin/user, return their tenant id (parent_id). For superadmin, return null (no restriction). */
function getEffectiveTenantId(req) {
  const user = req.session?.user;
  if (!user || user.role === 'superadmin') return null;
  const pid = user.parent_id;
  if (pid == null || pid === '') return null;
  const n = parseInt(pid, 10);
  return Number.isNaN(n) || n < 1 ? null : n;
}

// --- Users ---

router.get('/users', async (req, res) => {
  try {
    const effectiveTenantId = getEffectiveTenantId(req);
    let sql = `SELECT id, username, email, role, parent_id, account_status, created_at,
              phone_login_number,
              (phone_login_password IS NOT NULL AND phone_login_password != '') AS phone_login_set
       FROM users`;
    const params = [];
    if (effectiveTenantId != null) {
      sql += ' WHERE parent_id = ?';
      params.push(effectiveTenantId);
    }
    sql += ' ORDER BY id';
    const rows = await query(sql, params);
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
    const effectiveTenantId = getEffectiveTenantId(req);
    let parentId = roleId === 5 && parent_id != null && parent_id !== '' ? parseInt(parent_id, 10) : null;
    if (roleId === 2 || roleId === 3) parentId = parent_id != null && parent_id !== '' ? parseInt(parent_id, 10) : null;
    if (effectiveTenantId != null && (roleId === 2 || roleId === 3 || roleId === 5)) parentId = effectiveTenantId;
    const phoneNum = phone_login_number != null && String(phone_login_number).trim() !== '' ? String(phone_login_number).trim() : null;
    const phonePass = phone_login_password != null && String(phone_login_password).trim() !== '' ? String(phone_login_password).trim() : null;
    if (roleId === 5 && (!phoneNum || !phonePass)) {
      return res.status(400).json({
        success: false,
        error: 'Agents require phone login number (extension) and phone login password (PIN)',
      });
    }
    if (roleId === 5 && phoneNum) {
      const existingAgent = await queryOne(
        'SELECT id, username FROM users WHERE role = 5 AND phone_login_number IS NOT NULL AND TRIM(phone_login_number) = ? LIMIT 1',
        [phoneNum]
      );
      if (existingAgent) {
        return res.status(400).json({
          success: false,
          error: `Extension ${phoneNum} is already assigned to agent "${existingAgent.username}". Choose a different extension or remove it from that agent first.`,
        });
      }
      try {
        await ensureSipExtensionForAgent(parentId, phoneNum, phonePass);
      } catch (err) {
        console.error('Superadmin ensure PJSIP extension for agent error:', err);
        return res.status(500).json({
          success: false,
          error: 'Failed to create PJSIP extension for agent. Ensure sip_extensions table exists. ' + (err.message || String(err)),
        });
      }
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
    if (roleId === 5 && phoneNum && row?.id && parentId != null) {
      await setExtensionAgentUserId(parentId, phoneNum, row.id).catch((e) => console.error('Set extension agent_user_id:', e.message));
    }
    if (roleId === 5 && phoneNum) {
      await syncAgentsToAsterisk().catch((e) => console.error('Asterisk agents sync:', e.message));
      await syncExtensionsToAsterisk().catch((e) => console.error('Asterisk extensions sync:', e.message));
    } else if (roleId === 5) {
      syncAgentsToAsterisk().catch((e) => console.error('Asterisk agents sync:', e.message));
    }
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
    const {
      username: usernameBody,
      email: emailBody,
      role: roleBody,
      parent_id: parentIdBody,
      account_status: accountStatusBody,
      phone_login_number,
      phone_login_password,
      password,
    } = req.body || {};
    const existing = await queryOne('SELECT id, username, role, parent_id, phone_login_number FROM users WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    const effectiveTenantId = getEffectiveTenantId(req);
    const isSuperadmin = effectiveTenantId == null;
    if (effectiveTenantId != null && Number(existing.parent_id) !== Number(effectiveTenantId)) {
      return res.status(403).json({ success: false, error: 'You can only update users in your tenant' });
    }

    // Optional: update username, email, role, parent_id, account_status (role/parent_id only for superadmin)
    if (usernameBody !== undefined && String(usernameBody).trim() !== '') {
      const newUsername = String(usernameBody).trim();
      const dup = await queryOne('SELECT id FROM users WHERE username = ? AND id != ? LIMIT 1', [newUsername, id]);
      if (dup) {
        return res.status(400).json({ success: false, error: 'Username already taken' });
      }
      await query('UPDATE users SET username = ? WHERE id = ?', [newUsername, id]);
    }
    if (emailBody !== undefined) {
      await query('UPDATE users SET email = ? WHERE id = ?', [emailBody != null ? String(emailBody).trim() : null, id]);
    }
    if (accountStatusBody !== undefined && accountStatusBody !== null && String(accountStatusBody) !== '') {
      const status = accountStatusBody === 1 || accountStatusBody === '1' ? 1 : 0;
      await query('UPDATE users SET account_status = ? WHERE id = ?', [status, id]);
    }
    if (isSuperadmin) {
      if (roleBody !== undefined && roleBody !== null && String(roleBody).trim() !== '') {
        const roleId = ROLE_IDS[String(roleBody).toLowerCase()];
        if (roleId) await query('UPDATE users SET role = ? WHERE id = ?', [roleId, id]);
      }
      if (parentIdBody !== undefined) {
        const pid = parentIdBody === null || parentIdBody === '' ? null : parseInt(parentIdBody, 10);
        const newParentId = pid != null && !Number.isNaN(pid) && pid >= 1 ? pid : null;
        await query('UPDATE users SET parent_id = ? WHERE id = ?', [newParentId, id]);
      }
    }

    // Agent-only: phone extension and PIN (and optional web password)
    const phoneNum = phone_login_number != null && String(phone_login_number).trim() !== '' ? String(phone_login_number).trim() : null;
    const phonePass = phone_login_password != null && String(phone_login_password).trim() !== '' ? String(phone_login_password).trim() : null;
    const current = await queryOne('SELECT id, role, parent_id, phone_login_number FROM users WHERE id = ?', [id]);
    if (current.role === 5 && (phoneNum != null || phonePass != null || password != null)) {
      if (phoneNum) {
        const otherAgent = await queryOne(
          'SELECT id, username FROM users WHERE role = 5 AND id != ? AND phone_login_number IS NOT NULL AND TRIM(phone_login_number) = ? LIMIT 1',
          [id, phoneNum]
        );
        if (otherAgent) {
          return res.status(400).json({
            success: false,
            error: `Extension ${phoneNum} is already assigned to agent "${otherAgent.username}". Choose a different extension or remove it from that agent first.`,
          });
        }
      }
      const newPassword = password != null && String(password).trim() !== '' ? String(password).trim() : null;
      if (newPassword !== null && newPassword.length < 6) {
        return res.status(400).json({ success: false, error: 'Web login password must be at least 6 characters' });
      }
      if (newPassword !== null) {
        const hash = await bcrypt.hash(newPassword, 10);
        await query(
          'UPDATE users SET phone_login_number = ?, phone_login_password = ?, password_hash = ? WHERE id = ?',
          [phoneNum, phonePass, hash, id]
        );
      } else {
        await query(
          'UPDATE users SET phone_login_number = ?, phone_login_password = ? WHERE id = ?',
          [phoneNum, phonePass, id]
        );
      }
      if (current.parent_id != null) {
        const oldExt = current.phone_login_number != null ? String(current.phone_login_number).trim() : '';
        if (oldExt && oldExt !== (phoneNum || '')) {
          await setExtensionAgentUserId(current.parent_id, oldExt, null).catch(() => {});
        }
      }
      if (phoneNum) {
        try {
          await ensureSipExtensionForAgent(current.parent_id, phoneNum, phonePass);
        } catch (err) {
          console.error('Superadmin ensure PJSIP extension for agent error:', err);
          return res.status(500).json({
            success: false,
            error: 'Failed to create PJSIP extension for agent. ' + (err.message || String(err)),
          });
        }
        await syncExtensionsToAsterisk().catch((e) => console.error('Asterisk extensions sync:', e.message));
        await setExtensionAgentUserId(current.parent_id, phoneNum, id).catch((e) => console.error('Set extension agent_user_id:', e.message));
      }
      syncAgentsToAsterisk().catch((e) => console.error('Asterisk agents sync:', e.message));
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('Superadmin update user error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update user' });
  }
});

router.delete('/users/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid user ID' });
    }
    const existing = await queryOne('SELECT id, role, parent_id, phone_login_number FROM users WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    const effectiveTenantId = getEffectiveTenantId(req);
    if (effectiveTenantId != null && Number(existing.parent_id) !== Number(effectiveTenantId)) {
      return res.status(403).json({ success: false, error: 'You can only delete users in your tenant' });
    }
    const wasAgent = existing.role === 5;
    const agentId = wasAgent ? String(existing.phone_login_number || '').trim() : null;
    if (wasAgent) {
      await query('UPDATE sip_extensions SET agent_user_id = NULL WHERE agent_user_id = ?', [id]).catch(() => {});
    }
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

// --- Tenants ---

function normalizeTenantHas(row) {
  if (!row) return row;
  return {
    ...row,
    has_users: row.has_users ? 1 : 0,
    has_extensions: row.has_extensions ? 1 : 0,
    has_trunks: row.has_trunks ? 1 : 0,
    has_queues: row.has_queues ? 1 : 0,
    has_inbound_routes: row.has_inbound_routes ? 1 : 0,
    has_outbound_routes: row.has_outbound_routes ? 1 : 0,
    has_campaigns: row.has_campaigns ? 1 : 0,
  };
}

router.get('/tenants', async (req, res) => {
  try {
    const effectiveTenantId = getEffectiveTenantId(req);
    let rows;
    if (effectiveTenantId != null) {
      const row = await queryOne(
        `SELECT id, name, created_at, COALESCE(mask_caller_number_agent, 0) AS mask_caller_number_agent,
         (SELECT 1 FROM users u WHERE u.parent_id = tenants.id LIMIT 1) AS has_users,
         (SELECT 1 FROM sip_extensions e WHERE e.tenant_id = tenants.id LIMIT 1) AS has_extensions,
         (SELECT 1 FROM sip_trunks st WHERE st.tenant_id = tenants.id LIMIT 1) AS has_trunks,
         (SELECT 1 FROM queues q WHERE q.tenant_id = tenants.id LIMIT 1) AS has_queues,
         (SELECT 1 FROM inbound_routes ir WHERE ir.tenant_id = tenants.id LIMIT 1) AS has_inbound_routes,
         (SELECT 1 FROM outbound_routes o WHERE o.tenant_id = tenants.id LIMIT 1) AS has_outbound_routes,
         (SELECT 1 FROM campaigns c WHERE c.tenant_id = tenants.id LIMIT 1) AS has_campaigns
         FROM tenants WHERE id = ?`,
        [effectiveTenantId]
      );
      rows = row ? [normalizeTenantHas(row)] : [];
    } else {
      try {
        rows = await query(
          `SELECT t.id, t.name, t.created_at, COALESCE(t.mask_caller_number_agent, 0) AS mask_caller_number_agent,
           (SELECT 1 FROM users u WHERE u.parent_id = t.id LIMIT 1) AS has_users,
           (SELECT 1 FROM sip_extensions e WHERE e.tenant_id = t.id LIMIT 1) AS has_extensions,
           (SELECT 1 FROM sip_trunks st WHERE st.tenant_id = t.id LIMIT 1) AS has_trunks,
           (SELECT 1 FROM queues q WHERE q.tenant_id = t.id LIMIT 1) AS has_queues,
           (SELECT 1 FROM inbound_routes ir WHERE ir.tenant_id = t.id LIMIT 1) AS has_inbound_routes,
           (SELECT 1 FROM outbound_routes o WHERE o.tenant_id = t.id LIMIT 1) AS has_outbound_routes,
           (SELECT 1 FROM campaigns c WHERE c.tenant_id = t.id LIMIT 1) AS has_campaigns
           FROM tenants t ORDER BY t.id`
        );
        rows = (rows || []).map(normalizeTenantHas);
      } catch (subErr) {
        if (subErr?.code === 'ER_NO_SUCH_TABLE' || subErr?.errno === 1146) {
          rows = await query('SELECT id, name, created_at, COALESCE(mask_caller_number_agent, 0) AS mask_caller_number_agent FROM tenants ORDER BY id');
          rows = (rows || []).map((r) => ({ ...r, has_users: 0, has_extensions: 0, has_trunks: 0, has_queues: 0, has_inbound_routes: 0, has_outbound_routes: 0, has_campaigns: 0 }));
        } else {
          throw subErr;
        }
      }
    }
    return res.json({ success: true, tenants: rows });
  } catch (err) {
    console.error('Superadmin list tenants error:', err);
    return res.status(500).json({ success: false, error: 'Failed to list tenants' });
  }
});

router.post('/tenants', async (req, res) => {
  try {
    if (getEffectiveTenantId(req) != null) {
      return res.status(403).json({ success: false, error: 'Only superadmin can create tenants' });
    }
    const { name } = req.body || {};
    const tenantName = name != null ? String(name).trim() : '';
    if (!tenantName) {
      return res.status(400).json({ success: false, error: 'Tenant name required' });
    }
    await query('INSERT INTO tenants (name) VALUES (?)', [tenantName]);
    const row = await queryOne('SELECT id, name, created_at FROM tenants WHERE name = ?', [tenantName]);
    return res.json({ success: true, tenant: row });
  } catch (err) {
    console.error('Superadmin create tenant error:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to create tenant',
    });
  }
});

router.patch('/tenants/:id', async (req, res) => {
  try {
    if (getEffectiveTenantId(req) != null) {
      return res.status(403).json({ success: false, error: 'Only superadmin can update tenants' });
    }
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid tenant ID' });
    }
    const { name, mask_caller_number_agent } = req.body || {};
    const tenantName = name != null ? String(name).trim() : '';
    if (!tenantName) {
      return res.status(400).json({ success: false, error: 'Tenant name required' });
    }
    const existing = await queryOne('SELECT id FROM tenants WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Tenant not found' });
    }
    const maskAgent = mask_caller_number_agent === 1 || mask_caller_number_agent === true ? 1 : 0;
    await query('UPDATE tenants SET name = ?, mask_caller_number_agent = ? WHERE id = ?', [tenantName, maskAgent, id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('Superadmin update tenant error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update tenant' });
  }
});

router.delete('/tenants/:id', async (req, res) => {
  try {
    if (getEffectiveTenantId(req) != null) {
      return res.status(403).json({ success: false, error: 'Only superadmin can delete tenants' });
    }
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid tenant ID' });
    }
    const existing = await queryOne('SELECT id FROM tenants WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Tenant not found' });
    }
    const [ext] = await query('SELECT 1 FROM sip_extensions WHERE tenant_id = ? LIMIT 1', [id]);
    const [trunk] = await query('SELECT 1 FROM sip_trunks WHERE tenant_id = ? LIMIT 1', [id]);
    const [route] = await query('SELECT 1 FROM inbound_routes WHERE tenant_id = ? LIMIT 1', [id]);
    const [queue] = await query('SELECT 1 FROM queues WHERE tenant_id = ? LIMIT 1', [id]);
    const [outbound] = await query('SELECT 1 FROM outbound_routes WHERE tenant_id = ? LIMIT 1', [id]);
    if (ext || trunk || route || queue || outbound) {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete tenant: it has extensions, trunks, routes, queues, or outbound config. Remove or reassign those first.',
      });
    }
    await query('DELETE FROM tenants WHERE id = ?', [id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('Superadmin delete tenant error:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete tenant' });
  }
});

// --- SIP extensions ---

router.get('/sip-extensions', async (req, res) => {
  try {
    const effectiveTenantId = getEffectiveTenantId(req);
    const tenantId = effectiveTenantId != null ? effectiveTenantId : req.query.tenant_id;
    let sql =
      'SELECT id, tenant_id, name, secret, context, host, type, dtmfmode, failover_destination_type, failover_destination_id, created_at FROM sip_extensions';
    const params = [];
    if (tenantId != null && tenantId !== '') {
      sql += ' WHERE tenant_id = ?';
      params.push(parseInt(tenantId, 10));
    }
    sql += ' ORDER BY tenant_id, name';
    const rows = await query(sql, params);
    let endpointStates = {};
    try {
      endpointStates = await getPjsipEndpointStates();
    } catch (_) {
      // ARI not configured or unreachable
    }
    const extensions = rows.map((r) => {
      const state = endpointStates[r.name];
      const registered = state === 'online' || state === 'Online';
      return {
        ...r,
        asterisk_state: state || null,
        registered: !!registered,
      };
    });
    return res.json({ success: true, extensions });
  } catch (err) {
    console.error('Superadmin list sip-extensions error:', err);
    return res.status(500).json({ success: false, error: 'Failed to list SIP extensions' });
  }
});

/** Debug: raw ARI endpoints response (for diagnosing Registered column). */
router.get('/debug-ari-endpoints', async (req, res) => {
  try {
    const raw = await getPjsipEndpointsRaw();
    const states = await getPjsipEndpointStates();
    return res.json({
      success: true,
      configured: raw.configured,
      statesMap: states,
      raw: { pjsipStatus: raw.pjsip.status, pjsipBody: raw.pjsip.body, allStatus: raw.all.status, allBody: raw.all.body },
    });
  } catch (err) {
    console.error('Debug ARI endpoints error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/sip-extensions', async (req, res) => {
  try {
    const effectiveTenantId = getEffectiveTenantId(req);
    const { tenant_id, name, secret, context, host, type, failover_destination_type, failover_destination_id } = req.body || {};
    const tenantId = effectiveTenantId != null ? effectiveTenantId : parseInt(tenant_id, 10);
    if (!tenantId || isNaN(tenantId) || tenantId < 1) {
      return res.status(400).json({ success: false, error: 'Valid tenant_id required' });
    }
    const extName = String(name || '').trim();
    if (!extName) {
      return res.status(400).json({ success: false, error: 'Extension name required' });
    }
    const failoverType = (failover_destination_type && String(failover_destination_type).trim()) || 'hangup';
    const failoverId = failover_destination_id != null && failover_destination_id !== '' ? parseInt(failover_destination_id, 10) : null;
    await query(
      `INSERT INTO sip_extensions (tenant_id, name, secret, context, host, type, failover_destination_type, failover_destination_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantId,
        extName,
        secret && String(secret).trim() ? String(secret).trim() : null,
        context && String(context).trim() ? String(context).trim() : null,
        host && String(host).trim() ? String(host).trim() : null,
        type && String(type).trim() ? String(type).trim() : 'friend',
        failoverType,
        failoverId,
      ]
    );
    const row = await queryOne(
      'SELECT id, tenant_id, name, secret, context, host, type, failover_destination_type, failover_destination_id, created_at FROM sip_extensions WHERE tenant_id = ? AND name = ?',
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
    const { tenant_id, name, secret, context, host, type, failover_destination_type, failover_destination_id } = req.body || {};
    const existing = await queryOne('SELECT id, tenant_id, name, secret, context, host, type, failover_destination_type, failover_destination_id FROM sip_extensions WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'SIP extension not found' });
    }
    const effectiveTenantId = getEffectiveTenantId(req);
    if (effectiveTenantId != null && Number(existing.tenant_id) !== Number(effectiveTenantId)) {
      return res.status(403).json({ success: false, error: 'You can only update extensions in your tenant' });
    }
    const row = existing;
    const tenantId = effectiveTenantId != null ? effectiveTenantId : (tenant_id != null && tenant_id !== '' ? parseInt(tenant_id, 10) : row.tenant_id);
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
    const failoverType = failover_destination_type !== undefined ? (String(failover_destination_type).trim() || 'hangup') : (row.failover_destination_type || 'hangup');
    const failoverId = failover_destination_id !== undefined
      ? (failover_destination_id != null && failover_destination_id !== '' ? parseInt(failover_destination_id, 10) : null)
      : row.failover_destination_id;
    await query(
      `UPDATE sip_extensions SET tenant_id = ?, name = ?, secret = ?, context = ?, host = ?, type = ?, failover_destination_type = ?, failover_destination_id = ? WHERE id = ?`,
      [tenantId, extName, secretVal, contextVal, hostVal, typeVal, failoverType, failoverId, id]
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
    const existing = await queryOne('SELECT id, tenant_id FROM sip_extensions WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'SIP extension not found' });
    }
    const effectiveTenantId = getEffectiveTenantId(req);
    if (effectiveTenantId != null && Number(existing.tenant_id) !== Number(effectiveTenantId)) {
      return res.status(403).json({ success: false, error: 'You can only delete extensions in your tenant' });
    }
    await query('DELETE FROM sip_extensions WHERE id = ?', [id]);
    syncExtensionsToAsterisk().catch((e) => console.error('Asterisk extensions sync:', e.message));
    return res.json({ success: true });
  } catch (err) {
    console.error('Superadmin delete sip-extension error:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete SIP extension' });
  }
});

// --- SIP trunks ---

router.get('/sip-trunks', async (req, res) => {
  try {
    const effectiveTenantId = getEffectiveTenantId(req);
    const tenantId = effectiveTenantId != null ? effectiveTenantId : req.query.tenant_id;
    let sql = 'SELECT id, tenant_id, trunk_name, config_json, created_at, updated_at FROM sip_trunks';
    const params = [];
    if (tenantId != null && tenantId !== '') {
      sql += ' WHERE tenant_id = ?';
      params.push(parseInt(tenantId, 10));
    }
    sql += ' ORDER BY tenant_id, trunk_name';
    const rows = await query(sql, params);
    const trunks = rows.map((r) => {
      let cfg = r.config_json;
      if (cfg != null && typeof cfg === 'string') {
        try {
          const parsed = JSON.parse(cfg);
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) cfg = parsed;
        } catch {
          /* keep as plain text string */
        }
      }
      return {
        id: r.id,
        tenant_id: r.tenant_id,
        trunk_name: r.trunk_name,
        config_json: cfg,
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    });
    return res.json({ success: true, trunks });
  } catch (err) {
    console.error('Superadmin list sip-trunks error:', err);
    return res.status(500).json({ success: false, error: 'Failed to list SIP trunks' });
  }
});

router.post('/sip-trunks', async (req, res) => {
  try {
    const { tenant_id, trunk_name, config_json } = req.body || {};
    const tenantId = parseInt(tenant_id, 10);
    if (!tenant_id || isNaN(tenantId) || tenantId < 1) {
      return res.status(400).json({ success: false, error: 'Valid tenant_id required' });
    }
    const name = String(trunk_name || '').trim();
    if (!name) {
      return res.status(400).json({ success: false, error: 'Trunk name required' });
    }
    const config = config_json != null
      ? (typeof config_json === 'string' ? JSON.stringify(config_json) : JSON.stringify(config_json))
      : null;
    await query(
      'INSERT INTO sip_trunks (tenant_id, trunk_name, config_json) VALUES (?, ?, ?)',
      [tenantId, name, config]
    );
    const row = await queryOne(
      'SELECT id, tenant_id, trunk_name, config_json, created_at FROM sip_trunks WHERE tenant_id = ? AND trunk_name = ?',
      [tenantId, name]
    );
    syncTrunksToAsterisk().catch((e) => console.error('Asterisk trunks sync:', e.message));
    return res.json({
      success: true,
      trunk: {
        ...row,
        config_json: row.config_json
          ? (typeof row.config_json === 'string' ? (() => { try { return JSON.parse(row.config_json); } catch { return null; } })() : row.config_json)
          : null,
      },
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, error: 'Trunk name already exists for this tenant' });
    }
    console.error('Superadmin create sip-trunk error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create SIP trunk' });
  }
});

router.patch('/sip-trunks/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid trunk ID' });
    }
    const { tenant_id, trunk_name, config_json } = req.body || {};
    const existing = await queryOne('SELECT id, tenant_id, trunk_name, config_json FROM sip_trunks WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'SIP trunk not found' });
    }
    const row = existing;
    const tenantId = tenant_id != null && tenant_id !== '' ? parseInt(tenant_id, 10) : row.tenant_id;
    const name = trunk_name != null && String(trunk_name).trim() !== '' ? String(trunk_name).trim() : row.trunk_name;
    if (!name) {
      return res.status(400).json({ success: false, error: 'Trunk name required' });
    }
    const config = config_json !== undefined
      ? (typeof config_json === 'string' ? JSON.stringify(config_json) : JSON.stringify(config_json))
      : (typeof row.config_json === 'string' ? JSON.stringify(row.config_json) : JSON.stringify(row.config_json));
    await query(
      'UPDATE sip_trunks SET tenant_id = ?, trunk_name = ?, config_json = ? WHERE id = ?',
      [tenantId, name, config, id]
    );
    syncTrunksToAsterisk().catch((e) => console.error('Asterisk trunks sync:', e.message));
    return res.json({ success: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, error: 'Trunk name already exists for this tenant' });
    }
    console.error('Superadmin update sip-trunk error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update SIP trunk' });
  }
});

router.delete('/sip-trunks/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid trunk ID' });
    }
    const existing = await queryOne('SELECT id FROM sip_trunks WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'SIP trunk not found' });
    }
    await query('DELETE FROM sip_trunks WHERE id = ?', [id]);
    syncTrunksToAsterisk().catch((e) => console.error('Asterisk trunks sync:', e.message));
    return res.json({ success: true });
  } catch (err) {
    console.error('Superadmin delete sip-trunk error:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete SIP trunk' });
  }
});

// --- Manual sync to Asterisk ---

router.post('/sync-asterisk', async (req, res) => {
  try {
    const result = await syncAllToAsterisk();
    return res.json({ success: result.success, skipped: result.skipped, message: result.message, errors: result.errors });
  } catch (err) {
    console.error('Superadmin sync-asterisk error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Sync failed' });
  }
});

// --- Stats (for overview) ---

router.get('/stats', async (req, res) => {
  try {
    const effectiveTenantId = getEffectiveTenantId(req);
    const safeCount = async (sql, params = []) => {
      try {
        const row = await queryOne(sql, params);
        return row?.n ?? 0;
      } catch {
        return 0;
      }
    };
    let active_agents, total_users, extensions, trunks, queues, inbound_routes;
    if (effectiveTenantId != null) {
      [active_agents, total_users, extensions, trunks, queues, inbound_routes] = await Promise.all([
        queryOne("SELECT COUNT(*) AS n FROM agent_status a JOIN users u ON u.phone_login_number = a.agent_id AND u.role = 5 WHERE a.status NOT IN ('LoggedOut', 'LoginFailed') AND u.parent_id = ?", [effectiveTenantId]).then(r => r?.n ?? 0).catch(() => 0),
        safeCount('SELECT COUNT(*) AS n FROM users WHERE parent_id = ?', [effectiveTenantId]),
        safeCount('SELECT COUNT(*) AS n FROM sip_extensions WHERE tenant_id = ?', [effectiveTenantId]),
        safeCount('SELECT COUNT(*) AS n FROM sip_trunks WHERE tenant_id = ?', [effectiveTenantId]),
        safeCount('SELECT COUNT(*) AS n FROM queues WHERE tenant_id = ?', [effectiveTenantId]),
        safeCount('SELECT COUNT(*) AS n FROM inbound_routes WHERE tenant_id = ?', [effectiveTenantId]),
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
    console.error('Superadmin stats error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load stats' });
  }
});

// --- Campaigns (required for inbound route assignment) ---

router.get('/campaigns', async (req, res) => {
  try {
    const effectiveTenantId = getEffectiveTenantId(req);
    const tenantId = effectiveTenantId != null ? effectiveTenantId : req.query.tenant_id;
    let sql = 'SELECT id, tenant_id, name, description, created_at FROM campaigns';
    const params = [];
    if (tenantId != null && tenantId !== '') {
      sql += ' WHERE tenant_id = ?';
      params.push(parseInt(tenantId, 10));
    }
    sql += ' ORDER BY tenant_id, name';
    const campaigns = await query(sql, params);
    return res.json({ success: true, campaigns });
  } catch (err) {
    console.error('Superadmin list campaigns error:', err);
    return res.status(500).json({ success: false, error: 'Failed to list campaigns' });
  }
});

router.post('/campaigns', async (req, res) => {
  try {
    const { tenant_id, name, description } = req.body || {};
    const tenantId = parseInt(tenant_id, 10);
    if (!tenant_id || isNaN(tenantId) || tenantId < 1) {
      return res.status(400).json({ success: false, error: 'Valid tenant_id required' });
    }
    const campaignName = String(name || '').trim();
    if (!campaignName) {
      return res.status(400).json({ success: false, error: 'Campaign name required' });
    }
    await query(
      'INSERT INTO campaigns (tenant_id, name, description) VALUES (?, ?, ?)',
      [tenantId, campaignName, String(description || '').trim() || null]
    );
    const row = await queryOne(
      'SELECT id, tenant_id, name, description, created_at FROM campaigns WHERE tenant_id = ? AND name = ?',
      [tenantId, campaignName]
    );
    return res.json({ success: true, campaign: row });
  } catch (err) {
    console.error('Superadmin create campaign error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create campaign' });
  }
});

router.patch('/campaigns/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid campaign ID' });
    }
    const { name, description } = req.body || {};
    const existing = await queryOne('SELECT id, tenant_id, name, description FROM campaigns WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }
    const campaignName = name != null && String(name).trim() !== '' ? String(name).trim() : existing.name;
    const desc = description !== undefined ? (String(description).trim() || null) : existing.description;
    await query('UPDATE campaigns SET name = ?, description = ? WHERE id = ?', [campaignName, desc, id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('Superadmin update campaign error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update campaign' });
  }
});

router.delete('/campaigns/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid campaign ID' });
    }
    const existing = await queryOne('SELECT id FROM campaigns WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }
    const inUse = await queryOne('SELECT 1 FROM inbound_routes WHERE campaign_id = ? LIMIT 1', [id]);
    if (inUse) {
      return res.status(400).json({ success: false, error: 'Campaign is assigned to inbound route(s). Remove or reassign them first.' });
    }
    await query('DELETE FROM campaigns WHERE id = ?', [id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('Superadmin delete campaign error:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete campaign' });
  }
});

// --- Inbound routes (DID/TFN) ---

router.get('/inbound-routes', async (req, res) => {
  try {
    const effectiveTenantId = getEffectiveTenantId(req);
    const tenantId = effectiveTenantId != null ? effectiveTenantId : req.query.tenant_id;
    let routes;
    try {
      let sql = `SELECT ir.id, ir.tenant_id, ir.name, ir.did, ir.destination_type, ir.destination_id, ir.campaign_id, c.name AS campaign_name, ir.created_at
        FROM inbound_routes ir
        LEFT JOIN campaigns c ON c.id = ir.campaign_id`;
      const params = [];
      if (tenantId != null && tenantId !== '') {
        sql += ' WHERE ir.tenant_id = ?';
        params.push(parseInt(tenantId, 10));
      }
      sql += ' ORDER BY ir.tenant_id, ir.did';
      routes = await query(sql, params);
    } catch (_) {
      let sql = 'SELECT id, tenant_id, name, did, destination_type, destination_id, created_at FROM inbound_routes';
      const params = [];
      if (tenantId != null && tenantId !== '') {
        sql += ' WHERE tenant_id = ?';
        params.push(parseInt(tenantId, 10));
      }
      sql += ' ORDER BY tenant_id, did';
      routes = (await query(sql, params)).map((r) => ({ ...r, campaign_id: null, campaign_name: null }));
    }
    return res.json({ success: true, routes });
  } catch (err) {
    console.error('Superadmin list inbound-routes error:', err);
    return res.status(500).json({ success: false, error: 'Failed to list inbound routes' });
  }
});

router.post('/inbound-routes', async (req, res) => {
  try {
    const effectiveTenantId = getEffectiveTenantId(req);
    const { tenant_id, name, did, destination_type, destination_id, campaign_id } = req.body || {};
    const tenantId = effectiveTenantId != null ? effectiveTenantId : parseInt(tenant_id, 10);
    if (!tenantId || isNaN(tenantId) || tenantId < 1) {
      return res.status(400).json({ success: false, error: 'Valid tenant_id required' });
    }
    const routeName = String(name || '').trim() || `DID ${did}`;
    const didVal = String(did || '').trim();
    if (!didVal) {
      return res.status(400).json({ success: false, error: 'DID/TFN number required' });
    }
    const campaignId = campaign_id != null && campaign_id !== '' ? parseInt(campaign_id, 10) : null;
    if (!campaignId) {
      return res.status(400).json({ success: false, error: 'Campaign required. Create a campaign and assign it to this inbound number.' });
    }
    const destType = String(destination_type || 'hangup').toLowerCase();
    const destId = destination_id != null && destination_id !== '' ? parseInt(destination_id, 10) : null;
    await query(
      'INSERT INTO inbound_routes (tenant_id, name, did, destination_type, destination_id, campaign_id) VALUES (?, ?, ?, ?, ?, ?)',
      [tenantId, routeName, didVal, destType, destId, campaignId]
    );
    const row = await queryOne(
      `SELECT ir.id, ir.tenant_id, ir.name, ir.did, ir.destination_type, ir.destination_id, ir.campaign_id, c.name AS campaign_name, ir.created_at
       FROM inbound_routes ir LEFT JOIN campaigns c ON c.id = ir.campaign_id WHERE ir.tenant_id = ? AND ir.did = ?`,
      [tenantId, didVal]
    );
    return res.json({ success: true, route: row });
  } catch (err) {
    console.error('Superadmin create inbound-route error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create inbound route' });
  }
});

router.patch('/inbound-routes/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid route ID' });
    }
    const { tenant_id, name, did, destination_type, destination_id, campaign_id } = req.body || {};
    const existing = await queryOne('SELECT id, tenant_id, name, did, destination_type, destination_id, campaign_id FROM inbound_routes WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Inbound route not found' });
    }
    const row = existing;
    const tenantId = tenant_id != null && tenant_id !== '' ? parseInt(tenant_id, 10) : row.tenant_id;
    const routeName = name != null && String(name).trim() !== '' ? String(name).trim() : row.name;
    const didVal = did != null && String(did).trim() !== '' ? String(did).trim() : row.did;
    const destType = destination_type != null && String(destination_type).trim() !== '' ? String(destination_type).toLowerCase() : (row.destination_type || 'hangup');
    const destId = destination_id !== undefined && destination_id !== null && destination_id !== ''
      ? parseInt(destination_id, 10) : row.destination_id;
    const campaignId = campaign_id !== undefined && campaign_id !== null && campaign_id !== ''
      ? parseInt(campaign_id, 10) : row.campaign_id;
    if (!campaignId) {
      return res.status(400).json({ success: false, error: 'Campaign required' });
    }
    await query(
      'UPDATE inbound_routes SET tenant_id = ?, name = ?, did = ?, destination_type = ?, destination_id = ?, campaign_id = ? WHERE id = ?',
      [tenantId, routeName, didVal, destType, destId, campaignId, id]
    );
    return res.json({ success: true });
  } catch (err) {
    console.error('Superadmin update inbound-route error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update inbound route' });
  }
});

router.delete('/inbound-routes/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid route ID' });
    }
    const existing = await queryOne('SELECT id FROM inbound_routes WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Inbound route not found' });
    }
    await query('DELETE FROM inbound_routes WHERE id = ?', [id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('Superadmin delete inbound-route error:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete inbound route' });
  }
});

// --- Outbound (default trunk per tenant) ---

router.get('/outbound-routes', async (req, res) => {
  try {
    const effectiveTenantId = getEffectiveTenantId(req);
    let sql = 'SELECT id, tenant_id, trunk_id, trunk_name, created_at FROM outbound_routes';
    const params = [];
    if (effectiveTenantId != null) {
      sql += ' WHERE tenant_id = ?';
      params.push(effectiveTenantId);
    }
    sql += ' ORDER BY tenant_id';
    const routes = await query(sql, params);
    return res.json({ success: true, routes });
  } catch (err) {
    console.error('Superadmin list outbound-routes error:', err);
    return res.status(500).json({ success: false, error: 'Failed to list outbound routes' });
  }
});

router.put('/outbound-routes', async (req, res) => {
  try {
    const { tenant_id, trunk_id } = req.body || {};
    const tenantId = parseInt(tenant_id, 10);
    if (!tenant_id || isNaN(tenantId) || tenantId < 1) {
      return res.status(400).json({ success: false, error: 'Valid tenant_id required' });
    }
    const trunkId = trunk_id != null && trunk_id !== '' ? parseInt(trunk_id, 10) : null;
    if (!trunkId) {
      return res.status(400).json({ success: false, error: 'Trunk required' });
    }
    const trunkRow = await queryOne('SELECT id, trunk_name FROM sip_trunks WHERE id = ?', [trunkId]);
    if (!trunkRow) {
      return res.status(404).json({ success: false, error: 'Trunk not found' });
    }
    const trunkName = trunkRow.trunk_name;
    const existing = await queryOne('SELECT id FROM outbound_routes WHERE tenant_id = ?', [tenantId]);
    if (existing) {
      await query('UPDATE outbound_routes SET trunk_id = ?, trunk_name = ? WHERE tenant_id = ?', [trunkId, trunkName, tenantId]);
    } else {
      await query('INSERT INTO outbound_routes (tenant_id, trunk_id, trunk_name) VALUES (?, ?, ?)', [tenantId, trunkId, trunkName]);
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('Superadmin set outbound-route error:', err);
    return res.status(500).json({ success: false, error: 'Failed to set outbound route' });
  }
});

// --- Queues ---

router.get('/queues', async (req, res) => {
  try {
    const effectiveTenantId = getEffectiveTenantId(req);
    const tenantId = effectiveTenantId != null ? effectiveTenantId : req.query.tenant_id;
    let sql = 'SELECT id, tenant_id, name, display_name, strategy, timeout, failover_destination_type, failover_destination_id, created_at FROM queues';
    const params = [];
    if (tenantId != null && tenantId !== '') {
      sql += ' WHERE tenant_id = ?';
      params.push(parseInt(tenantId, 10));
    }
    sql += ' ORDER BY tenant_id, name';
    const queues = await query(sql, params);
    return res.json({ success: true, queues });
  } catch (err) {
    console.error('Superadmin list queues error:', err);
    return res.status(500).json({ success: false, error: 'Failed to list queues' });
  }
});

router.post('/queues', async (req, res) => {
  try {
    const effectiveTenantId = getEffectiveTenantId(req);
    const { tenant_id, name, display_name, strategy, timeout, failover_destination_type, failover_destination_id } = req.body || {};
    const tenantId = effectiveTenantId != null ? effectiveTenantId : parseInt(tenant_id, 10);
    if (!tenantId || isNaN(tenantId) || tenantId < 1) {
      return res.status(400).json({ success: false, error: 'Valid tenant_id required' });
    }
    const qName = String(name || '').trim();
    if (!qName) {
      return res.status(400).json({ success: false, error: 'Queue name required' });
    }
    const displayName = display_name != null ? String(display_name).trim() : null;
    const strat = (strategy && String(strategy).trim()) || 'ringall';
    const to = timeout != null && timeout !== '' ? parseInt(timeout, 10) : 60;
    const failoverType = (failover_destination_type && String(failover_destination_type).trim()) || 'hangup';
    const failoverId = failover_destination_id != null && failover_destination_id !== '' ? parseInt(failover_destination_id, 10) : null;
    await query(
      'INSERT INTO queues (tenant_id, name, display_name, strategy, timeout, failover_destination_type, failover_destination_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [tenantId, qName, displayName || null, strat, to, failoverType, failoverId]
    );
    const row = await queryOne(
      'SELECT id, tenant_id, name, display_name, strategy, timeout, failover_destination_type, failover_destination_id, created_at FROM queues WHERE tenant_id = ? AND name = ?',
      [tenantId, qName]
    );
    return res.json({ success: true, queue: row });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, error: 'Queue name already exists for this tenant' });
    }
    console.error('Superadmin create queue error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create queue' });
  }
});

router.patch('/queues/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid queue ID' });
    }
    const { tenant_id, name, display_name, strategy, timeout, failover_destination_type, failover_destination_id } = req.body || {};
    const existing = await queryOne('SELECT id, tenant_id, name, display_name, strategy, timeout, failover_destination_type, failover_destination_id FROM queues WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Queue not found' });
    }
    const effectiveTenantId = getEffectiveTenantId(req);
    if (effectiveTenantId != null && Number(existing.tenant_id) !== Number(effectiveTenantId)) {
      return res.status(403).json({ success: false, error: 'You can only update queues in your tenant' });
    }
    const row = existing;
    const tenantId = effectiveTenantId != null ? effectiveTenantId : (tenant_id != null && tenant_id !== '' ? parseInt(tenant_id, 10) : row.tenant_id);
    const qName = name != null && String(name).trim() !== '' ? String(name).trim() : row.name;
    const displayName = display_name !== undefined ? (String(display_name).trim() || null) : row.display_name;
    const strat = strategy != null && String(strategy).trim() !== '' ? String(strategy).trim() : row.strategy;
    const to = timeout !== undefined && timeout !== '' ? parseInt(timeout, 10) : row.timeout;
    const failoverType = failover_destination_type !== undefined ? (String(failover_destination_type).trim() || 'hangup') : row.failover_destination_type;
    const failoverId = failover_destination_id !== undefined
      ? (failover_destination_id != null && failover_destination_id !== '' ? parseInt(failover_destination_id, 10) : null)
      : row.failover_destination_id;
    await query(
      'UPDATE queues SET tenant_id = ?, name = ?, display_name = ?, strategy = ?, timeout = ?, failover_destination_type = ?, failover_destination_id = ? WHERE id = ?',
      [tenantId, qName, displayName, strat, to, failoverType, failoverId, id]
    );
    return res.json({ success: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, error: 'Queue name already exists for this tenant' });
    }
    console.error('Superadmin update queue error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update queue' });
  }
});

router.delete('/queues/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid queue ID' });
    }
    const existing = await queryOne('SELECT id, tenant_id, name FROM queues WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Queue not found' });
    }
    const effectiveTenantId = getEffectiveTenantId(req);
    if (effectiveTenantId != null && Number(existing.tenant_id) !== Number(effectiveTenantId)) {
      return res.status(403).json({ success: false, error: 'You can only delete queues in your tenant' });
    }
    const queueName = existing.name;
    await query('DELETE FROM queue_members WHERE queue_name = ?', [queueName]);
    await query('DELETE FROM queues WHERE id = ?', [id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('Superadmin delete queue error:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete queue' });
  }
});

router.get('/queues/:id/members', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid queue ID' });
    }
    const q = await queryOne('SELECT id, name FROM queues WHERE id = ?', [id]);
    if (!q) {
      return res.status(404).json({ success: false, error: 'Queue not found' });
    }
    const members = await query(
      `SELECT qm.member_name, qm.paused, qm.updated_at,
              u.username AS agent_name, u.phone_login_number AS agent_id
       FROM queue_members qm
       LEFT JOIN users u ON u.phone_login_number = qm.member_name AND u.role = 5
       WHERE qm.queue_name = ?
       ORDER BY qm.member_name`,
      [q.name]
    );
    return res.json({ success: true, queue_name: q.name, members });
  } catch (err) {
    console.error('Superadmin list queue members error:', err);
    return res.status(500).json({ success: false, error: 'Failed to list queue members' });
  }
});

router.post('/queues/:id/members', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { member_name } = req.body || {};
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid queue ID' });
    }
    const memberName = (member_name && String(member_name).trim()) || '';
    if (!memberName) {
      return res.status(400).json({ success: false, error: 'Member name (extension) required' });
    }
    const q = await queryOne('SELECT id, name FROM queues WHERE id = ?', [id]);
    if (!q) {
      return res.status(404).json({ success: false, error: 'Queue not found' });
    }
    await query(
      'INSERT INTO queue_members (queue_name, member_name, paused) VALUES (?, ?, 0) ON DUPLICATE KEY UPDATE paused = 0',
      [q.name, memberName]
    );
    return res.json({ success: true });
  } catch (err) {
    console.error('Superadmin add queue member error:', err);
    return res.status(500).json({ success: false, error: 'Failed to add queue member' });
  }
});

router.delete('/queues/:id/members/:member_name', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const memberName = decodeURIComponent(req.params.member_name || '');
    if (!id || isNaN(id) || !memberName) {
      return res.status(400).json({ success: false, error: 'Invalid queue or member' });
    }
    const q = await queryOne('SELECT id, name FROM queues WHERE id = ?', [id]);
    if (!q) {
      return res.status(404).json({ success: false, error: 'Queue not found' });
    }
    await query('DELETE FROM queue_members WHERE queue_name = ? AND member_name = ?', [q.name, memberName]);
    return res.json({ success: true });
  } catch (err) {
    console.error('Superadmin remove queue member error:', err);
    return res.status(500).json({ success: false, error: 'Failed to remove queue member' });
  }
});

// ==========================================================================
// IVR Menus
// ==========================================================================

router.get('/ivr-menus', async (req, res) => {
  try {
    const effectiveTenantId = getEffectiveTenantId(req);
    const tenantId = effectiveTenantId != null ? effectiveTenantId : req.query.tenant_id;
    let sql = 'SELECT id, tenant_id, name, config_json, created_at FROM ivr_menus';
    const params = [];
    if (tenantId != null && tenantId !== '') {
      sql += ' WHERE tenant_id = ?';
      params.push(parseInt(tenantId, 10));
    }
    sql += ' ORDER BY tenant_id, name';
    const menus = await query(sql, params);
    for (const m of menus) {
      if (m.config_json && typeof m.config_json === 'string') {
        try { m.config_json = JSON.parse(m.config_json); } catch { /* keep string */ }
      }
      m.options = await query(
        'SELECT id, dtmf_key, destination_type, destination_id FROM ivr_menu_options WHERE ivr_menu_id = ? ORDER BY dtmf_key',
        [m.id]
      );
    }
    return res.json({ success: true, menus });
  } catch (err) {
    console.error('Superadmin list ivr-menus error:', err);
    return res.status(500).json({ success: false, error: 'Failed to list IVR menus' });
  }
});

router.post('/ivr-menus', async (req, res) => {
  try {
    const { tenant_id, name, config, options } = req.body || {};
    const tenantId = parseInt(tenant_id, 10);
    if (!tenant_id || isNaN(tenantId) || tenantId < 1) {
      return res.status(400).json({ success: false, error: 'Valid tenant_id required' });
    }
    const ivrName = String(name || '').trim();
    if (!ivrName) {
      return res.status(400).json({ success: false, error: 'IVR name required' });
    }
    const configJson = config != null ? JSON.stringify(config) : null;
    const result = await query(
      'INSERT INTO ivr_menus (tenant_id, name, config_json) VALUES (?, ?, ?)',
      [tenantId, ivrName, configJson]
    );
    const menuId = result.insertId;
    if (Array.isArray(options)) {
      for (const opt of options) {
        const key = String(opt.dtmf_key || '').trim();
        if (!key) continue;
        await query(
          'INSERT INTO ivr_menu_options (ivr_menu_id, dtmf_key, destination_type, destination_id) VALUES (?, ?, ?, ?)',
          [menuId, key, opt.destination_type || 'hangup', opt.destination_id || null]
        );
      }
    }
    syncDialplanToAsterisk().catch((e) => console.error('Dialplan sync:', e.message));
    return res.json({ success: true, id: menuId });
  } catch (err) {
    console.error('Superadmin create ivr-menu error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create IVR menu' });
  }
});

router.patch('/ivr-menus/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid IVR ID' });
    const existing = await queryOne('SELECT id FROM ivr_menus WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ success: false, error: 'IVR menu not found' });
    const { name, config, options } = req.body || {};
    if (name !== undefined) {
      const ivrName = String(name).trim();
      if (ivrName) await query('UPDATE ivr_menus SET name = ? WHERE id = ?', [ivrName, id]);
    }
    if (config !== undefined) {
      await query('UPDATE ivr_menus SET config_json = ? WHERE id = ?', [JSON.stringify(config), id]);
    }
    if (Array.isArray(options)) {
      await query('DELETE FROM ivr_menu_options WHERE ivr_menu_id = ?', [id]);
      for (const opt of options) {
        const key = String(opt.dtmf_key || '').trim();
        if (!key) continue;
        await query(
          'INSERT INTO ivr_menu_options (ivr_menu_id, dtmf_key, destination_type, destination_id) VALUES (?, ?, ?, ?)',
          [id, key, opt.destination_type || 'hangup', opt.destination_id || null]
        );
      }
    }
    syncDialplanToAsterisk().catch((e) => console.error('Dialplan sync:', e.message));
    return res.json({ success: true });
  } catch (err) {
    console.error('Superadmin update ivr-menu error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update IVR menu' });
  }
});

router.delete('/ivr-menus/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid IVR ID' });
    const existing = await queryOne('SELECT id FROM ivr_menus WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ success: false, error: 'IVR menu not found' });
    await query('DELETE FROM ivr_menu_options WHERE ivr_menu_id = ?', [id]);
    await query('DELETE FROM ivr_menus WHERE id = ?', [id]);
    syncDialplanToAsterisk().catch((e) => console.error('Dialplan sync:', e.message));
    return res.json({ success: true });
  } catch (err) {
    console.error('Superadmin delete ivr-menu error:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete IVR menu' });
  }
});

// ==========================================================================
// Time Conditions
// ==========================================================================

router.get('/time-conditions', async (req, res) => {
  try {
    const effectiveTenantId = getEffectiveTenantId(req);
    const tenantId = effectiveTenantId != null ? effectiveTenantId : req.query.tenant_id;
    let sql = `SELECT tc.id, tc.tenant_id, tc.name, tc.time_group_id,
                      tc.match_destination_type, tc.match_destination_id,
                      tc.nomatch_destination_type, tc.nomatch_destination_id,
                      tc.created_at,
                      tg.name AS time_group_name
               FROM time_conditions tc
               LEFT JOIN time_groups tg ON tg.id = tc.time_group_id`;
    const params = [];
    if (tenantId != null && tenantId !== '') {
      sql += ' WHERE tc.tenant_id = ?';
      params.push(parseInt(tenantId, 10));
    }
    sql += ' ORDER BY tc.tenant_id, tc.name';
    const conditions = await query(sql, params);
    return res.json({ success: true, conditions });
  } catch (err) {
    console.error('Superadmin list time-conditions error:', err);
    return res.status(500).json({ success: false, error: 'Failed to list time conditions' });
  }
});

router.get('/time-groups', async (req, res) => {
  try {
    const effectiveTenantId = getEffectiveTenantId(req);
    const tenantId = effectiveTenantId != null ? effectiveTenantId : req.query.tenant_id;
    let sql = 'SELECT id, tenant_id, name, description, created_at FROM time_groups';
    const params = [];
    if (tenantId != null && tenantId !== '') {
      sql += ' WHERE tenant_id = ?';
      params.push(parseInt(tenantId, 10));
    }
    sql += ' ORDER BY tenant_id, name';
    const groups = await query(sql, params);
    for (const g of groups) {
      g.rules = await query(
        'SELECT id, day_of_week, start_time, end_time FROM time_group_rules WHERE time_group_id = ? ORDER BY day_of_week, start_time',
        [g.id]
      );
    }
    return res.json({ success: true, groups });
  } catch (err) {
    console.error('Superadmin list time-groups error:', err);
    return res.status(500).json({ success: false, error: 'Failed to list time groups' });
  }
});

router.post('/time-groups', async (req, res) => {
  try {
    const { tenant_id, name, description, rules } = req.body || {};
    const tenantId = parseInt(tenant_id, 10);
    if (!tenant_id || isNaN(tenantId) || tenantId < 1) {
      return res.status(400).json({ success: false, error: 'Valid tenant_id required' });
    }
    const groupName = String(name || '').trim();
    if (!groupName) return res.status(400).json({ success: false, error: 'Time group name required' });
    const result = await query(
      'INSERT INTO time_groups (tenant_id, name, description) VALUES (?, ?, ?)',
      [tenantId, groupName, description ? String(description).trim() : null]
    );
    const groupId = result.insertId;
    if (Array.isArray(rules)) {
      for (const r of rules) {
        await query(
          'INSERT INTO time_group_rules (time_group_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?)',
          [groupId, r.day_of_week ?? null, r.start_time || null, r.end_time || null]
        );
      }
    }
    return res.json({ success: true, id: groupId });
  } catch (err) {
    console.error('Superadmin create time-group error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create time group' });
  }
});

router.patch('/time-groups/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid time group ID' });
    const existing = await queryOne('SELECT id FROM time_groups WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Time group not found' });
    const { name, description, rules } = req.body || {};
    if (name !== undefined) {
      const n = String(name).trim();
      if (n) await query('UPDATE time_groups SET name = ? WHERE id = ?', [n, id]);
    }
    if (description !== undefined) {
      await query('UPDATE time_groups SET description = ? WHERE id = ?', [description ? String(description).trim() : null, id]);
    }
    if (Array.isArray(rules)) {
      await query('DELETE FROM time_group_rules WHERE time_group_id = ?', [id]);
      for (const r of rules) {
        await query(
          'INSERT INTO time_group_rules (time_group_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?)',
          [id, r.day_of_week ?? null, r.start_time || null, r.end_time || null]
        );
      }
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('Superadmin update time-group error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update time group' });
  }
});

router.delete('/time-groups/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid time group ID' });
    const existing = await queryOne('SELECT id FROM time_groups WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Time group not found' });
    await query('DELETE FROM time_group_rules WHERE time_group_id = ?', [id]);
    await query('DELETE FROM time_groups WHERE id = ?', [id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('Superadmin delete time-group error:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete time group' });
  }
});

router.post('/time-conditions', async (req, res) => {
  try {
    const { tenant_id, name, time_group_id, match_destination_type, match_destination_id, nomatch_destination_type, nomatch_destination_id } = req.body || {};
    const tenantId = parseInt(tenant_id, 10);
    if (!tenant_id || isNaN(tenantId) || tenantId < 1) {
      return res.status(400).json({ success: false, error: 'Valid tenant_id required' });
    }
    const tcName = String(name || '').trim();
    if (!tcName) return res.status(400).json({ success: false, error: 'Time condition name required' });
    const result = await query(
      `INSERT INTO time_conditions (tenant_id, name, time_group_id, match_destination_type, match_destination_id, nomatch_destination_type, nomatch_destination_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, tcName, time_group_id || null, match_destination_type || 'hangup', match_destination_id || null, nomatch_destination_type || 'hangup', nomatch_destination_id || null]
    );
    syncDialplanToAsterisk().catch((e) => console.error('Dialplan sync:', e.message));
    return res.json({ success: true, id: result.insertId });
  } catch (err) {
    console.error('Superadmin create time-condition error:', err);
    const message = err.message || 'Failed to create time condition';
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.status(500).json({ success: false, error: 'Time conditions table missing. Run migration docs/migrations/007_time_conditions_tables.sql then try again.' });
    }
    if (err.code === 'ER_BAD_FIELD_ERROR' && (err.message || '').includes('match_destination_type')) {
      return res.status(500).json({ success: false, error: 'Time conditions table is missing destination columns. Run migration docs/migrations/008_time_conditions_destination_columns.sql then try again.' });
    }
    return res.status(500).json({ success: false, error: message });
  }
});

router.patch('/time-conditions/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid time condition ID' });
    const existing = await queryOne('SELECT id FROM time_conditions WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Time condition not found' });
    const { name, time_group_id, match_destination_type, match_destination_id, nomatch_destination_type, nomatch_destination_id } = req.body || {};
    const sets = [];
    const params = [];
    if (name !== undefined) { sets.push('name = ?'); params.push(String(name).trim()); }
    if (time_group_id !== undefined) { sets.push('time_group_id = ?'); params.push(time_group_id || null); }
    if (match_destination_type !== undefined) { sets.push('match_destination_type = ?'); params.push(match_destination_type || 'hangup'); }
    if (match_destination_id !== undefined) { sets.push('match_destination_id = ?'); params.push(match_destination_id || null); }
    if (nomatch_destination_type !== undefined) { sets.push('nomatch_destination_type = ?'); params.push(nomatch_destination_type || 'hangup'); }
    if (nomatch_destination_id !== undefined) { sets.push('nomatch_destination_id = ?'); params.push(nomatch_destination_id || null); }
    if (sets.length > 0) {
      params.push(id);
      await query(`UPDATE time_conditions SET ${sets.join(', ')} WHERE id = ?`, params);
    }
    syncDialplanToAsterisk().catch((e) => console.error('Dialplan sync:', e.message));
    return res.json({ success: true });
  } catch (err) {
    console.error('Superadmin update time-condition error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update time condition' });
  }
});

router.delete('/time-conditions/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid time condition ID' });
    const existing = await queryOne('SELECT id FROM time_conditions WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Time condition not found' });
    await query('DELETE FROM time_conditions WHERE id = ?', [id]);
    syncDialplanToAsterisk().catch((e) => console.error('Dialplan sync:', e.message));
    return res.json({ success: true });
  } catch (err) {
    console.error('Superadmin delete time-condition error:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete time condition' });
  }
});

// ==========================================================================
// Sound Files
// ==========================================================================

router.get('/sound-files', async (req, res) => {
  try {
    const effectiveTenantId = getEffectiveTenantId(req);
    const tenantId = effectiveTenantId != null ? effectiveTenantId : req.query.tenant_id;
    let sql = 'SELECT id, tenant_id, name, file_path, created_at FROM sound_files';
    const params = [];
    if (tenantId != null && tenantId !== '') {
      sql += ' WHERE tenant_id = ?';
      params.push(parseInt(tenantId, 10));
    }
    sql += ' ORDER BY tenant_id, name';
    const files = await query(sql, params);
    return res.json({ success: true, files });
  } catch (err) {
    console.error('Superadmin list sound-files error:', err);
    return res.status(500).json({ success: false, error: 'Failed to list sound files' });
  }
});

router.post('/sound-files', async (req, res) => {
  try {
    const { tenant_id, name, file_path } = req.body || {};
    const tenantId = parseInt(tenant_id, 10);
    if (!tenant_id || isNaN(tenantId) || tenantId < 1) {
      return res.status(400).json({ success: false, error: 'Valid tenant_id required' });
    }
    const sfName = String(name || '').trim();
    if (!sfName) return res.status(400).json({ success: false, error: 'Sound file name required' });
    const sfPath = String(file_path || '').trim();
    if (!sfPath) return res.status(400).json({ success: false, error: 'File path required' });
    const result = await query(
      'INSERT INTO sound_files (tenant_id, name, file_path) VALUES (?, ?, ?)',
      [tenantId, sfName, sfPath]
    );
    return res.json({ success: true, id: result.insertId });
  } catch (err) {
    console.error('Superadmin create sound-file error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create sound file' });
  }
});

router.delete('/sound-files/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid sound file ID' });
    const existing = await queryOne('SELECT id FROM sound_files WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Sound file not found' });
    await query('DELETE FROM sound_files WHERE id = ?', [id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('Superadmin delete sound-file error:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete sound file' });
  }
});

// ==========================================================================
// Voicemail Boxes
// ==========================================================================

router.get('/voicemail-boxes', async (req, res) => {
  try {
    const effectiveTenantId = getEffectiveTenantId(req);
    const tenantId = effectiveTenantId != null ? effectiveTenantId : req.query.tenant_id;
    let sql = 'SELECT id, tenant_id, mailbox, password, email, config_json, created_at FROM voicemail_boxes';
    const params = [];
    if (tenantId != null && tenantId !== '') {
      sql += ' WHERE tenant_id = ?';
      params.push(parseInt(tenantId, 10));
    }
    sql += ' ORDER BY tenant_id, mailbox';
    const boxes = await query(sql, params);
    for (const b of boxes) {
      if (b.config_json && typeof b.config_json === 'string') {
        try { b.config_json = JSON.parse(b.config_json); } catch { /* keep string */ }
      }
    }
    return res.json({ success: true, boxes });
  } catch (err) {
    console.error('Superadmin list voicemail-boxes error:', err);
    return res.status(500).json({ success: false, error: 'Failed to list voicemail boxes' });
  }
});

router.post('/voicemail-boxes', async (req, res) => {
  try {
    const { tenant_id, mailbox, password, email, config } = req.body || {};
    const tenantId = parseInt(tenant_id, 10);
    if (!tenant_id || isNaN(tenantId) || tenantId < 1) {
      return res.status(400).json({ success: false, error: 'Valid tenant_id required' });
    }
    const mb = String(mailbox || '').trim();
    if (!mb) return res.status(400).json({ success: false, error: 'Mailbox number required' });
    const result = await query(
      'INSERT INTO voicemail_boxes (tenant_id, mailbox, password, email, config_json) VALUES (?, ?, ?, ?, ?)',
      [tenantId, mb, password ? String(password).trim() : null, email ? String(email).trim() : null, config ? JSON.stringify(config) : null]
    );
    return res.json({ success: true, id: result.insertId });
  } catch (err) {
    console.error('Superadmin create voicemail-box error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create voicemail box' });
  }
});

router.patch('/voicemail-boxes/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid voicemail box ID' });
    const existing = await queryOne('SELECT id FROM voicemail_boxes WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Voicemail box not found' });
    const { mailbox, password, email, config } = req.body || {};
    const sets = [];
    const params = [];
    if (mailbox !== undefined) { sets.push('mailbox = ?'); params.push(String(mailbox).trim()); }
    if (password !== undefined) { sets.push('password = ?'); params.push(password ? String(password).trim() : null); }
    if (email !== undefined) { sets.push('email = ?'); params.push(email ? String(email).trim() : null); }
    if (config !== undefined) { sets.push('config_json = ?'); params.push(config ? JSON.stringify(config) : null); }
    if (sets.length > 0) {
      params.push(id);
      await query(`UPDATE voicemail_boxes SET ${sets.join(', ')} WHERE id = ?`, params);
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('Superadmin update voicemail-box error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update voicemail box' });
  }
});

router.delete('/voicemail-boxes/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid voicemail box ID' });
    const existing = await queryOne('SELECT id FROM voicemail_boxes WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Voicemail box not found' });
    await query('DELETE FROM voicemail_boxes WHERE id = ?', [id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('Superadmin delete voicemail-box error:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete voicemail box' });
  }
});

// ==========================================================================
// Agent Live Monitoring
// ==========================================================================

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
router.post('/live-agents/:agentId/monitor', requireSuperadmin, async (req, res) => {
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

// =============================================================================
// CDR (Call Detail Records) and recording playback
// =============================================================================

function csvEscape(s) {
  if (s == null) return '';
  const str = String(s);
  if (/[,"\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

router.get('/cdr', async (req, res) => {
  try {
    const effectiveTenantId = getEffectiveTenantId(req);
    const from = (req.query.from || '').toString().trim();
    const to = (req.query.to || '').toString().trim();
    const agent = (req.query.agent || '').toString().trim();
    const queue = (req.query.queue || '').toString().trim();
    const direction = (req.query.direction || '').toString().trim();
    const statusFilter = (req.query.status || '').toString().trim().toLowerCase();
    const formatCsv = (req.query.format || '').toString().toLowerCase() === 'csv';

    let where = [];
    const params = [];
    if (effectiveTenantId != null) {
      where.push('cr.tenant_id = ?');
      params.push(effectiveTenantId);
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
    if (statusFilter) {
      if (statusFilter === 'answered') {
        where.push("LOWER(TRIM(cr.status)) IN ('answered','completed') AND cr.answer_time IS NOT NULL");
      } else if (statusFilter === 'abandoned') {
        where.push("(LOWER(TRIM(cr.status)) IN ('abandoned','abondoned') OR (cr.answer_time IS NULL AND LOWER(TRIM(cr.status)) = 'completed'))");
      } else if (statusFilter === 'transferred') {
        where.push('cr.transfer_status = 1');
      } else if (statusFilter === 'failed') {
        where.push("LOWER(TRIM(cr.status)) = 'failed'");
      }
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
                cr.duration_sec, cr.talk_sec, cr.wait_time_sec, cr.status, cr.recording_path, cr.tenant_id,
                cr.transfer_status, cr.transfer_from, cr.transfer_to, cr.transfer_type, cr.transfer_time,
                cr.abandon_reason, cr.failover_destination,
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
      const headers = ['Start Time', 'Caller', 'Destination', 'DID/TFN', 'Agent', 'Queue', 'Direction', 'Duration (sec)', 'Talk (sec)', 'Wait (sec)', 'Status', 'Transfer From', 'Transfer To', 'Transfer Type', 'Abandon Reason', 'Failover Dest', 'Recording'];
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
          r.wait_time_sec || '',
          r.status,
          r.transfer_from || '',
          r.transfer_to || '',
          r.transfer_type || '',
          r.abandon_reason || '',
          r.failover_destination || '',
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
      wait_time_sec: r.wait_time_sec || null,
      status: r.status,
      transfer_status: r.transfer_status || 0,
      transfer_from: r.transfer_from || null,
      transfer_to: r.transfer_to || null,
      transfer_type: r.transfer_type || null,
      transfer_time: r.transfer_time || null,
      abandon_reason: r.abandon_reason || null,
      failover_destination: r.failover_destination || null,
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
    console.error('Superadmin CDR list error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to load CDR' });
  }
});

// --- Reports: Calls per DID/TFN (inbound route summary) ---
router.get('/reports/did-tfn', async (req, res) => {
  try {
    const effectiveTenantId = getEffectiveTenantId(req);
    const tenantIdParam = req.query.tenant_id != null && req.query.tenant_id !== '' ? parseInt(req.query.tenant_id, 10) : null;
    const tenantId = tenantIdParam != null && !Number.isNaN(tenantIdParam) ? tenantIdParam : effectiveTenantId;
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
    console.error('Superadmin DID/TFN report error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to load report' });
  }
});

// Stream recording file for a call (by unique_id). Requires RECORDINGS_BASE_PATH or recording_path to be server-accessible.
router.get('/cdr/recording/:uniqueId', async (req, res) => {
  try {
    const uniqueId = (req.params.uniqueId || '').toString().trim();
    if (!uniqueId) {
      return res.status(400).json({ success: false, error: 'UniqueID required' });
    }
    const row = await queryOne(
      'SELECT recording_path, tenant_id FROM call_records WHERE unique_id = ? LIMIT 1',
      [uniqueId]
    );
    if (!row || !row.recording_path) {
      return res.status(404).json({ success: false, error: 'No recording for this call' });
    }
    const effectiveTenantId = getEffectiveTenantId(req);
    if (effectiveTenantId != null && Number(row.tenant_id) !== Number(effectiveTenantId)) {
      return res.status(403).json({ success: false, error: 'You can only access recordings for your tenant' });
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
      console.error('CDR recording stream error:', err);
      if (!res.headersSent) res.status(500).json({ success: false, error: 'Stream error' });
    });
  } catch (err) {
    console.error('Superadmin CDR recording error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: err.message || 'Failed to stream recording' });
    }
  }
});

// --- Role Modules (dynamic module access control) ---

router.get('/role-modules', async (req, res) => {
  try {
    const rows = await query('SELECT role, module_key, enabled FROM role_modules');
    const roleModules = {};
    for (const roleId of [2, 3, 5]) {
      roleModules[roleId] = {};
      for (const mod of ALL_MODULES) {
        const row = rows.find(r => r.role === roleId && r.module_key === mod.key);
        roleModules[roleId][mod.key] = row ? !!row.enabled : false;
      }
    }
    return res.json({ success: true, role_modules: roleModules, modules: ALL_MODULES });
  } catch (err) {
    console.error('Get role-modules error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load role modules' });
  }
});

router.put('/role-modules', async (req, res) => {
  try {
    const { role, module_key, enabled } = req.body || {};
    if (![2, 3, 5].includes(Number(role))) {
      return res.status(400).json({ success: false, error: 'Invalid role. Use 2 (admin), 3 (user), or 5 (agent).' });
    }
    if (!ALL_MODULES.some(m => m.key === module_key)) {
      return res.status(400).json({ success: false, error: 'Invalid module key' });
    }
    await query(
      `INSERT INTO role_modules (role, module_key, enabled)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), updated_at = NOW()`,
      [Number(role), module_key, enabled ? 1 : 0]
    );
    return res.json({ success: true });
  } catch (err) {
    console.error('Update role-module error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update role module' });
  }
});

// --- Asterisk logs (same server: ASTERISK_LOG_DIR; remote: ASTERISK_CONFIG_API_URL + config-receiver) ---

const ASTERISK_LOG_DIR = process.env.ASTERISK_LOG_DIR?.trim().replace(/\/$/, '') || '';
const ASTERISK_CONFIG_API_URL = process.env.ASTERISK_CONFIG_API_URL?.trim().replace(/\/$/, '') || '';
const ASTERISK_CONFIG_API_KEY = process.env.ASTERISK_CONFIG_API_KEY?.trim() || '';
const ALLOWED_LOG_FILES = new Set(['full', 'messages', 'queue_log']);

function getLogFilePath(file) {
  if (!file || !ALLOWED_LOG_FILES.has(file) || !ASTERISK_LOG_DIR) return null;
  const resolved = path.join(ASTERISK_LOG_DIR, file);
  if (!resolved.startsWith(path.resolve(ASTERISK_LOG_DIR))) return null;
  return resolved;
}

router.get('/asterisk-logs', requireSuperadmin, async (req, res) => {
  try {
    const file = (req.query.file || 'full').toLowerCase();
    const tail = Math.min(Math.max(parseInt(req.query.tail, 10) || 2000, 1), 50000);
    if (!ALLOWED_LOG_FILES.has(file)) {
      return res.status(400).json({ success: false, error: 'Invalid file. Use: full, messages, queue_log' });
    }

    if (ASTERISK_LOG_DIR) {
      const filePath = getLogFilePath(file);
      if (!filePath) return res.status(400).json({ success: false, error: 'Invalid log file' });
      try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        const lines = content.split(/\n/).filter(Boolean);
        const last = lines.slice(-tail);
        return res.json({ success: true, lines: last, source: 'local' });
      } catch (err) {
        if (err.code === 'ENOENT') return res.status(404).json({ success: false, error: 'Log file not found' });
        console.error('Asterisk logs read error:', err);
        return res.status(500).json({ success: false, error: err.message || 'Read failed' });
      }
    }

    if (ASTERISK_CONFIG_API_URL) {
      const url = `${ASTERISK_CONFIG_API_URL}/logs/${file}?tail=${tail}`;
      const headers = { Accept: 'application/json' };
      if (ASTERISK_CONFIG_API_KEY) headers['X-Config-API-Key'] = ASTERISK_CONFIG_API_KEY;
      const resp = await fetch(url, { headers });
      if (!resp.ok) {
        const body = await resp.text();
        return res.status(resp.status).json({ success: false, error: body || resp.statusText });
      }
      const data = await resp.json();
      return res.json({ success: true, lines: data.lines || [], source: 'remote' });
    }

    return res.status(503).json({
      success: false,
      error: 'Asterisk logs not configured. Set ASTERISK_LOG_DIR (same server) or ASTERISK_CONFIG_API_URL (remote).',
    });
  } catch (err) {
    console.error('Asterisk logs error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to load logs' });
  }
});

router.get('/asterisk-logs/stream', requireSuperadmin, async (req, res) => {
  try {
    const file = (req.query.file || 'full').toLowerCase();
    if (!ALLOWED_LOG_FILES.has(file)) {
      return res.status(400).json({ success: false, error: 'Invalid file. Use: full, messages, queue_log' });
    }

    if (ASTERISK_LOG_DIR) {
      const filePath = getLogFilePath(file);
      if (!filePath) return res.status(400).json({ success: false, error: 'Invalid log file' });
      try {
        await fs.promises.access(filePath);
      } catch {
        return res.status(404).json({ success: false, error: 'Log file not found' });
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.flushHeaders?.();
      const { spawn } = await import('child_process');
      const tail = spawn('tail', ['-f', '-n', '0', filePath], { stdio: ['ignore', 'pipe', 'ignore'] });
      tail.stdout.setEncoding('utf8');
      tail.stdout.on('data', (chunk) => {
        const lines = String(chunk).split(/\n/).filter(Boolean);
        for (const line of lines) {
          res.write(`data: ${line.replace(/\n/g, ' ')}\n\n`);
        }
        res.flush?.();
      });
      tail.on('error', (err) => {
        res.write(`data: [error] ${err.message}\n\n`);
      });
      req.on('close', () => tail.kill('SIGTERM'));
      return;
    }

    if (ASTERISK_CONFIG_API_URL) {
      const url = `${ASTERISK_CONFIG_API_URL}/logs/${file}/stream`;
      const headers = {};
      if (ASTERISK_CONFIG_API_KEY) headers['X-Config-API-Key'] = ASTERISK_CONFIG_API_KEY;
      const resp = await fetch(url, { headers });
      if (!resp.ok) {
        const body = await resp.text();
        return res.status(resp.status).json({ success: false, error: body || resp.statusText });
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.flushHeaders?.();
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length) res.write(decoder.decode(value, { stream: true }));
            res.flush?.();
          }
        } catch (e) {
          console.error('Asterisk logs stream proxy error:', e.message);
        } finally {
          res.end();
        }
      })();
      req.on('close', () => reader.cancel?.());
      return;
    }

    return res.status(503).json({
      success: false,
      error: 'Asterisk logs not configured. Set ASTERISK_LOG_DIR (same server) or ASTERISK_CONFIG_API_URL (remote).',
    });
  } catch (err) {
    console.error('Asterisk logs stream error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to stream logs' });
  }
});

/** GET /asterisk-logs/config - returns how logs are configured (for UI). */
router.get('/asterisk-logs/config', requireSuperadmin, (req, res) => {
  const hasLocal = Boolean(ASTERISK_LOG_DIR);
  const hasRemote = Boolean(ASTERISK_CONFIG_API_URL);
  res.json({
    success: true,
    configured: hasLocal || hasRemote,
    source: hasLocal ? 'local' : (hasRemote ? 'remote' : null),
    message: hasLocal
      ? 'Reading from local Asterisk log directory (production-style).'
      : hasRemote
        ? 'Fetching from Asterisk server via config-receiver.'
        : 'Set ASTERISK_LOG_DIR (same server) or ASTERISK_CONFIG_API_URL (remote).',
  });
});

export default router;

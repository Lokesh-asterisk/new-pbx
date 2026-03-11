import express from 'express';
import bcrypt from 'bcrypt';
import { query, queryOne } from '../../db.js';
import { roleName } from '../../auth.js';
import { destroySessionsForUser } from '../../session-utils.js';
import { endAgentSession } from '../../agent-sessions.js';
import { setExtensionAgentUserId } from '../../agent-extension-resolver.js';
import { syncAgentsToAsterisk, syncExtensionsToAsterisk } from '../../asterisk-config-sync.js';
import { validate, createUserSchema, createTenantSchema } from '../../utils/schemas.js';
import { getEffectiveTenantId, ROLE_IDS, ensureSipExtensionForAgent } from './middleware.js';

const router = express.Router();

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

router.post('/users', validate(createUserSchema), async (req, res) => {
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

const BRANDING_COLS = 'product_name, logo_url, tagline, primary_color, favicon_url';

router.get('/tenants', async (req, res) => {
  try {
    const effectiveTenantId = getEffectiveTenantId(req);
    let rows;
    if (effectiveTenantId != null) {
      const row = await queryOne(
        `SELECT id, name, created_at, COALESCE(mask_caller_number_agent, 0) AS mask_caller_number_agent,
         ${BRANDING_COLS},
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
           t.product_name, t.logo_url, t.tagline, t.primary_color, t.favicon_url,
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

router.post('/tenants', validate(createTenantSchema), async (req, res) => {
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

const VALID_HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
function sanitizeUrl(val, maxLen = 512) {
  if (val == null) return null;
  const s = String(val).trim();
  if (!s) return null;
  if (s.length > maxLen) return null;
  if (/^javascript:/i.test(s) || /^data:/i.test(s)) return null;
  return s;
}

router.patch('/tenants/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid tenant ID' });
    const existing = await queryOne('SELECT id FROM tenants WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Tenant not found' });
    const effectiveTenantId = getEffectiveTenantId(req);
    if (effectiveTenantId != null && Number(effectiveTenantId) !== id) {
      return res.status(403).json({ success: false, error: 'You can only edit your own tenant' });
    }

    const b = req.body || {};
    const sets = [];
    const params = [];

    if (b.name != null) {
      const name = String(b.name).trim();
      if (!name) return res.status(400).json({ success: false, error: 'Tenant name required' });
      sets.push('name = ?'); params.push(name);
    }
    if (b.mask_caller_number_agent != null) {
      sets.push('mask_caller_number_agent = ?'); params.push(Number(b.mask_caller_number_agent) ? 1 : 0);
    }
    if (b.product_name !== undefined) {
      const v = b.product_name ? String(b.product_name).trim().slice(0, 128) : null;
      sets.push('product_name = ?'); params.push(v || null);
    }
    if (b.logo_url !== undefined) {
      sets.push('logo_url = ?'); params.push(sanitizeUrl(b.logo_url));
    }
    if (b.tagline !== undefined) {
      const v = b.tagline ? String(b.tagline).trim().slice(0, 255) : null;
      sets.push('tagline = ?'); params.push(v || null);
    }
    if (b.primary_color !== undefined) {
      let c = b.primary_color ? String(b.primary_color).trim() : null;
      if (c && !VALID_HEX_COLOR.test(c)) c = null;
      sets.push('primary_color = ?'); params.push(c);
    }
    if (b.favicon_url !== undefined) {
      sets.push('favicon_url = ?'); params.push(sanitizeUrl(b.favicon_url));
    }

    if (!sets.length) return res.status(400).json({ success: false, error: 'Nothing to update' });
    params.push(id);
    await query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`, params);
    const updated = await queryOne(
      `SELECT id, name, created_at, COALESCE(mask_caller_number_agent, 0) AS mask_caller_number_agent,
       ${BRANDING_COLS} FROM tenants WHERE id = ?`,
      [id]
    );
    return res.json({ success: true, tenant: updated });
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

export default router;

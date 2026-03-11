import express from 'express';
import { query, queryOne } from '../../db.js';
import { syncExtensionsToAsterisk, syncTrunksToAsterisk, syncAllToAsterisk } from '../../asterisk-config-sync.js';
import { getPjsipEndpointStates, getPjsipEndpointsRaw } from '../../asterisk-ari.js';
import { validate, createSipExtensionSchema, createSipTrunkSchema } from '../../utils/schemas.js';
import { getEffectiveTenantId } from './middleware.js';

const router = express.Router();

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

router.post('/sip-extensions', validate(createSipExtensionSchema), async (req, res) => {
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

router.post('/sip-trunks', validate(createSipTrunkSchema), async (req, res) => {
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

export default router;

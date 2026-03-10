import express from 'express';
import { query, queryOne } from '../../db.js';
import { syncDialplanToAsterisk } from '../../asterisk-config-sync.js';
import {
  validate, createCampaignSchema, createInboundRouteSchema,
  outboundRouteSchema, createQueueSchema, addQueueMemberSchema,
} from '../../utils/schemas.js';
import { getEffectiveTenantId } from './middleware.js';

const router = express.Router();

// --- Campaigns ---

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

router.post('/campaigns', validate(createCampaignSchema), async (req, res) => {
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

router.post('/inbound-routes', validate(createInboundRouteSchema), async (req, res) => {
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

router.put('/outbound-routes', validate(outboundRouteSchema), async (req, res) => {
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

router.post('/queues', validate(createQueueSchema), async (req, res) => {
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

router.post('/queues/:id/members', validate(addQueueMemberSchema), async (req, res) => {
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

export default router;

import express from 'express';
import { query, queryOne } from '../../db.js';
import {
  validate, createIvrMenuSchema, createTimeGroupSchema, createTimeConditionSchema,
  createSoundFileSchema, createVoicemailBoxSchema,
} from '../../utils/schemas.js';
import { syncDialplanToAsterisk } from '../../asterisk-config-sync.js';
import { getEffectiveTenantId } from './middleware.js';

const router = express.Router();

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

router.post('/ivr-menus', validate(createIvrMenuSchema), async (req, res) => {
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
    const existing = await queryOne('SELECT id, tenant_id FROM ivr_menus WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ success: false, error: 'IVR menu not found' });
    const { name, config, options } = req.body || {};
    const ivrName = String(name ?? '').trim();
    if (!ivrName) return res.status(400).json({ success: false, error: 'IVR name required' });
    const configJson = config != null ? JSON.stringify(config) : null;
    await query('UPDATE ivr_menus SET name = ?, config_json = ? WHERE id = ?', [ivrName, configJson, id]);
    await query('DELETE FROM ivr_menu_options WHERE ivr_menu_id = ?', [id]);
    if (Array.isArray(options)) {
      for (const opt of options) {
        const key = String(opt.dtmf_key || '').trim();
        if (!key) continue;
        await query(
          'INSERT INTO ivr_menu_options (ivr_menu_id, dtmf_key, destination_type, destination_id) VALUES (?, ?, ?, ?)',
          [id, key, opt.destination_type || 'hangup', opt.destination_id ?? null]
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

router.post('/time-groups', validate(createTimeGroupSchema), async (req, res) => {
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

router.post('/time-conditions', validate(createTimeConditionSchema), async (req, res) => {
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

router.post('/sound-files', validate(createSoundFileSchema), async (req, res) => {
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

router.post('/voicemail-boxes', validate(createVoicemailBoxSchema), async (req, res) => {
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

export default router;

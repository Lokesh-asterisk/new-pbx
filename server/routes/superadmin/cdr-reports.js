import express from 'express';
import fs from 'fs';
import path from 'path';
import { query, queryOne } from '../../db.js';
import { csvEscape } from '../../utils/csv.js';
import { getEffectiveTenantId } from './middleware.js';

const router = express.Router();

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

export default router;

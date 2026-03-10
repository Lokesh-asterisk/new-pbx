/**
 * Historical Agent Performance Reporting API.
 * Provides daily/weekly/monthly/custom-range reports, agent comparison,
 * break analysis, leaderboard, trend analysis, and queue-based analytics.
 */
import express from 'express';
import { query, queryOne } from '../db.js';

const router = express.Router();

const BREAK_LIMITS = {
  Lunch: 30 * 60,
  'Short Break': 15 * 60,
  Meeting: 60 * 60,
  Training: 120 * 60,
  'System Issue': 30 * 60,
  'Personal Break': 15 * 60,
  default: 90 * 60,
};

function requireReportAccess(req, res, next) {
  const user = req.session?.user;
  if (!user) return res.status(401).json({ success: false, error: 'Not authenticated' });
  const r = user.role;
  if (!(r === 'superadmin' || r === 1 || r === 'admin' || r === 2 || r === 'user' || r === 3)) {
    return res.status(403).json({ success: false, error: 'Reports access denied' });
  }
  req.reportUser = user;
  next();
}

router.use(requireReportAccess);

function isSuperadmin(u) { return u.role === 'superadmin' || u.role === 1; }
function isAdmin(u) { return u.role === 'admin' || u.role === 2; }

async function getTenantId(req) {
  const u = req.reportUser;
  const assigned = u.parent_id != null || u.tenant_id != null
    ? (parseInt(u.parent_id ?? u.tenant_id, 10) || null)
    : null;
  if (isSuperadmin(u) || (isAdmin(u) && !assigned)) {
    const q = req.query.tenant_id;
    if (q != null && q !== '') {
      const n = parseInt(q, 10);
      if (!Number.isNaN(n) && n >= 1) return n;
    }
    const first = await queryOne('SELECT id FROM tenants ORDER BY id LIMIT 1');
    return first ? first.id : null;
  }
  if (assigned) return assigned;
  const first = await queryOne('SELECT id FROM tenants ORDER BY id LIMIT 1');
  return first ? first.id : null;
}

function parseDateRange(req) {
  const { period, start_date, end_date, date } = req.query;
  const today = new Date().toISOString().slice(0, 10);

  if (period === 'weekly') {
    const d = new Date();
    d.setDate(d.getDate() - d.getDay());
    return { startDate: d.toISOString().slice(0, 10), endDate: today };
  }
  if (period === 'monthly') {
    const d = new Date();
    return { startDate: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`, endDate: today };
  }
  if (start_date && end_date) {
    return { startDate: start_date, endDate: end_date };
  }
  return { startDate: date || today, endDate: date || today };
}

function fmtSec(s) {
  const sec = Number(s) || 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function csvEscape(s) {
  if (s == null) return '';
  const str = String(s);
  if (/[,"\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

// ──────────────────────────────────────────────────────────────
// GET /api/reports/performance
// Agent performance summary for date range
// ──────────────────────────────────────────────────────────────
router.get('/performance', async (req, res) => {
  try {
    const tenantId = await getTenantId(req);
    if (!tenantId) return res.json({ success: true, agents: [] });
    const { startDate, endDate } = parseDateRange(req);
    const agentFilter = req.query.agent_id || null;
    const queueFilter = req.query.queue || null;

    let agents = [];
    try {
      let sql = `
        SELECT d.agent_id,
               COALESCE(u.phone_login_name, u.username) AS name,
               SUM(d.calls_answered) AS calls_answered,
               SUM(d.calls_missed) AS calls_missed,
               SUM(d.talk_time_sec) AS talk_time_sec,
               SUM(d.wrap_time_sec) AS wrap_time_sec,
               SUM(d.pause_time_sec) AS pause_time_sec,
               SUM(d.login_time_sec) AS login_time_sec,
               CASE WHEN SUM(d.login_time_sec) > 0
                 THEN LEAST(1, (SUM(d.talk_time_sec) + SUM(d.wrap_time_sec)) / SUM(d.login_time_sec))
                 ELSE NULL END AS occupancy,
               CASE WHEN SUM(d.calls_answered) > 0
                 THEN ROUND((SUM(d.talk_time_sec) + SUM(d.wrap_time_sec)) / SUM(d.calls_answered))
                 ELSE NULL END AS aht
        FROM agent_daily_stats d
        LEFT JOIN users u ON u.phone_login_number = d.agent_id AND u.role = 5
        WHERE d.tenant_id = ? AND d.stat_date BETWEEN ? AND ?`;
      const params = [tenantId, startDate, endDate];

      if (agentFilter) {
        sql += ' AND d.agent_id = ?';
        params.push(agentFilter);
      }
      sql += ' GROUP BY d.agent_id, u.phone_login_name, u.username ORDER BY name';
      agents = await query(sql, params);
    } catch (e) {
      if (e?.code !== 'ER_NO_SUCH_TABLE') console.error('Report performance error:', e);
    }

    // If queue filter, narrow to agents who handled calls in that queue
    if (queueFilter && agents.length > 0) {
      try {
        const qAgents = await query(
          `SELECT DISTINCT agent_id FROM call_records
           WHERE tenant_id = ? AND queue_name = ? AND DATE(start_time) BETWEEN ? AND ?`,
          [tenantId, queueFilter, startDate, endDate]
        );
        const qSet = new Set(qAgents.map(r => r.agent_id));
        agents = agents.filter(a => qSet.has(a.agent_id));
      } catch (_) {}
    }

    const result = agents.map(a => {
      const callsAnswered = Number(a.calls_answered) || 0;
      const loginSec = Number(a.login_time_sec) || 0;
      const talkSec = Number(a.talk_time_sec) || 0;
      const wrapSec = Number(a.wrap_time_sec) || 0;
      const pauseSec = Number(a.pause_time_sec) || 0;
      const occ = a.occupancy != null ? Number(a.occupancy) : null;

      const maxCalls = 80 * Math.max(1, Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1);
      const callScore = Math.min(100, (callsAnswered / maxCalls) * 100);
      const occScore = occ != null ? occ * 100 : 0;
      const score = Math.round((callScore * 0.4) + (occScore * 0.2)) || 0;

      return {
        agent_id: a.agent_id,
        name: a.name || a.agent_id,
        calls_answered: callsAnswered,
        calls_missed: Number(a.calls_missed) || 0,
        talk_time_sec: talkSec,
        talk_time: fmtSec(talkSec),
        wrap_time_sec: wrapSec,
        wrap_time: fmtSec(wrapSec),
        pause_time_sec: pauseSec,
        pause_time: fmtSec(pauseSec),
        login_time_sec: loginSec,
        login_time: fmtSec(loginSec),
        ready_time_sec: Math.max(0, loginSec - talkSec - wrapSec - pauseSec),
        occupancy: occ,
        occupancy_pct: occ != null ? Math.round(occ * 100) : 0,
        aht: Number(a.aht) || 0,
        aht_formatted: fmtSec(Number(a.aht) || 0),
        performance_score: score,
      };
    });

    if (req.query.format === 'csv') {
      const headers = ['Agent ID', 'Name', 'Calls Answered', 'Calls Missed', 'Talk Time', 'Wrap Time',
        'Pause Time', 'Login Time', 'Occupancy %', 'AHT', 'Score'];
      const lines = [headers.map(csvEscape).join(',')];
      for (const a of result) {
        lines.push([a.agent_id, a.name, a.calls_answered, a.calls_missed, a.talk_time, a.wrap_time,
          a.pause_time, a.login_time, a.occupancy_pct, a.aht_formatted, a.performance_score
        ].map(csvEscape).join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="performance-${startDate}-${endDate}.csv"`);
      return res.send('\uFEFF' + lines.join('\n'));
    }

    return res.json({ success: true, startDate, endDate, agents: result });
  } catch (err) {
    console.error('Report performance error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load performance report' });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/reports/leaderboard
// Ranked agent list with performance scores
// ──────────────────────────────────────────────────────────────
router.get('/leaderboard', async (req, res) => {
  try {
    const tenantId = await getTenantId(req);
    if (!tenantId) return res.json({ success: true, agents: [] });
    const { startDate, endDate } = parseDateRange(req);

    const agents = await query(
      `SELECT d.agent_id,
              COALESCE(u.phone_login_name, u.username) AS name,
              SUM(d.calls_answered) AS calls_answered,
              SUM(d.calls_missed) AS calls_missed,
              SUM(d.talk_time_sec) AS talk_time_sec,
              SUM(d.login_time_sec) AS login_time_sec,
              SUM(d.wrap_time_sec) AS wrap_time_sec,
              CASE WHEN SUM(d.login_time_sec) > 0
                THEN LEAST(1, (SUM(d.talk_time_sec) + SUM(d.wrap_time_sec)) / SUM(d.login_time_sec))
                ELSE NULL END AS occupancy,
              CASE WHEN SUM(d.calls_answered) > 0
                THEN ROUND((SUM(d.talk_time_sec) + SUM(d.wrap_time_sec)) / SUM(d.calls_answered))
                ELSE NULL END AS aht
       FROM agent_daily_stats d
       LEFT JOIN users u ON u.phone_login_number = d.agent_id AND u.role = 5
       WHERE d.tenant_id = ? AND d.stat_date BETWEEN ? AND ?
       GROUP BY d.agent_id, u.phone_login_name, u.username
       HAVING SUM(d.calls_answered) > 0
       ORDER BY SUM(d.calls_answered) DESC`,
      [tenantId, startDate, endDate]
    ).catch(() => []);

    const days = Math.max(1, Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1);
    const maxCalls = 80 * days;

    const ranked = agents.map((a, i) => {
      const calls = Number(a.calls_answered) || 0;
      const occ = a.occupancy != null ? Number(a.occupancy) : 0;
      const callScore = Math.min(100, (calls / maxCalls) * 100);
      const occScore = occ * 100;
      const score = Math.round((callScore * 0.4) + (occScore * 0.2)) || 0;

      return {
        rank: i + 1,
        agent_id: a.agent_id,
        name: a.name || a.agent_id,
        calls_answered: calls,
        calls_missed: Number(a.calls_missed) || 0,
        talk_time: fmtSec(Number(a.talk_time_sec) || 0),
        occupancy_pct: Math.round(occ * 100),
        aht: fmtSec(Number(a.aht) || 0),
        performance_score: score,
      };
    });

    ranked.sort((a, b) => b.performance_score - a.performance_score);
    ranked.forEach((a, i) => { a.rank = i + 1; });

    return res.json({ success: true, startDate, endDate, agents: ranked });
  } catch (err) {
    console.error('Report leaderboard error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load leaderboard' });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/reports/breaks
// Break analysis with discipline indicators
// ──────────────────────────────────────────────────────────────
router.get('/breaks', async (req, res) => {
  try {
    const tenantId = await getTenantId(req);
    if (!tenantId) return res.json({ success: true, agents: [] });
    const { startDate, endDate } = parseDateRange(req);
    const agentFilter = req.query.agent_id || null;

    let breakData = [];
    try {
      let sql = `
        SELECT b.agent_id,
               COALESCE(u.phone_login_name, u.username) AS name,
               b.break_type,
               SUM(b.break_count) AS break_count,
               SUM(b.total_duration_sec) AS total_sec,
               MAX(b.max_duration_sec) AS max_sec,
               ROUND(AVG(b.avg_duration_sec)) AS avg_sec
        FROM agent_break_stats b
        LEFT JOIN users u ON u.phone_login_number = b.agent_id AND u.role = 5
        WHERE b.tenant_id = ? AND b.stat_date BETWEEN ? AND ?`;
      const params = [tenantId, startDate, endDate];
      if (agentFilter) { sql += ' AND b.agent_id = ?'; params.push(agentFilter); }
      sql += ' GROUP BY b.agent_id, u.phone_login_name, u.username, b.break_type ORDER BY name, b.break_type';
      breakData = await query(sql, params);
    } catch (e) {
      if (e?.code !== 'ER_NO_SUCH_TABLE') {
        // Fallback: query from session_agent_breaks or agent_status_log
        try {
          let sql = `
            SELECT u.phone_login_number AS agent_id,
                   COALESCE(u.phone_login_name, u.username) AS name,
                   COALESCE(sl.pause_reason, 'Unknown') AS break_type,
                   COUNT(*) AS break_count,
                   COALESCE(SUM(sl.duration_sec), 0) AS total_sec,
                   COALESCE(MAX(sl.duration_sec), 0) AS max_sec,
                   ROUND(COALESCE(AVG(sl.duration_sec), 0)) AS avg_sec
            FROM agent_status_log sl
            LEFT JOIN users u ON u.phone_login_number = sl.agent_id AND u.role = 5
            WHERE sl.tenant_id = ? AND sl.status = 'PAUSED' AND DATE(sl.start_time) BETWEEN ? AND ? AND sl.end_time IS NOT NULL`;
          const params = [tenantId, startDate, endDate];
          if (agentFilter) { sql += ' AND sl.agent_id = ?'; params.push(agentFilter); }
          sql += ' GROUP BY u.phone_login_number, u.phone_login_name, u.username, COALESCE(sl.pause_reason, \'Unknown\') ORDER BY name';
          breakData = await query(sql, params);
        } catch (_) {}
      }
    }

    // Group by agent
    const agentMap = {};
    for (const r of breakData) {
      const aid = r.agent_id;
      if (!agentMap[aid]) {
        agentMap[aid] = { agent_id: aid, name: r.name || aid, breaks: [], total_break_sec: 0, alerts: [] };
      }
      const totalSec = Number(r.total_sec) || 0;
      agentMap[aid].breaks.push({
        break_type: r.break_type,
        count: Number(r.break_count) || 0,
        total_duration_sec: totalSec,
        total_duration: fmtSec(totalSec),
        avg_duration_sec: Number(r.avg_sec) || 0,
        avg_duration: fmtSec(Number(r.avg_sec) || 0),
        max_duration_sec: Number(r.max_sec) || 0,
      });
      agentMap[aid].total_break_sec += totalSec;
    }

    // Discipline alerts
    const agents = Object.values(agentMap);
    const totalDaysLimit = BREAK_LIMITS.default *
      Math.max(1, Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1);

    for (const a of agents) {
      a.total_break_time = fmtSec(a.total_break_sec);
      if (a.total_break_sec > totalDaysLimit) {
        a.alerts.push({
          type: 'excessive_total',
          message: `Total break time (${fmtSec(a.total_break_sec)}) exceeds limit`,
        });
      }
      for (const b of a.breaks) {
        const limit = BREAK_LIMITS[b.break_type] || BREAK_LIMITS.default;
        const days = Math.max(1, Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1);
        if (b.total_duration_sec > limit * days) {
          a.alerts.push({
            type: 'break_exceeded',
            message: `${b.break_type} time (${b.total_duration}) exceeds limit`,
          });
        }
      }
    }

    return res.json({ success: true, startDate, endDate, agents });
  } catch (err) {
    console.error('Report breaks error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load break report' });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/reports/comparison
// Compare two or more agents side-by-side
// ──────────────────────────────────────────────────────────────
router.get('/comparison', async (req, res) => {
  try {
    const tenantId = await getTenantId(req);
    if (!tenantId) return res.json({ success: true, agents: [] });
    const { startDate, endDate } = parseDateRange(req);
    const agentIds = (req.query.agents || '').split(',').map(s => s.trim()).filter(Boolean);

    if (agentIds.length < 2) {
      return res.status(400).json({ success: false, error: 'Provide at least 2 agent IDs (agents=1001,1002)' });
    }

    const placeholders = agentIds.map(() => '?').join(',');
    const agents = await query(
      `SELECT d.agent_id,
              COALESCE(u.phone_login_name, u.username) AS name,
              SUM(d.calls_answered) AS calls_answered,
              SUM(d.calls_missed) AS calls_missed,
              SUM(d.talk_time_sec) AS talk_time_sec,
              SUM(d.wrap_time_sec) AS wrap_time_sec,
              SUM(d.pause_time_sec) AS pause_time_sec,
              SUM(d.login_time_sec) AS login_time_sec,
              CASE WHEN SUM(d.login_time_sec) > 0
                THEN LEAST(1, (SUM(d.talk_time_sec) + SUM(d.wrap_time_sec)) / SUM(d.login_time_sec))
                ELSE NULL END AS occupancy,
              CASE WHEN SUM(d.calls_answered) > 0
                THEN ROUND((SUM(d.talk_time_sec) + SUM(d.wrap_time_sec)) / SUM(d.calls_answered))
                ELSE NULL END AS aht
       FROM agent_daily_stats d
       LEFT JOIN users u ON u.phone_login_number = d.agent_id AND u.role = 5
       WHERE d.tenant_id = ? AND d.stat_date BETWEEN ? AND ?
         AND d.agent_id IN (${placeholders})
       GROUP BY d.agent_id, u.phone_login_name, u.username`,
      [tenantId, startDate, endDate, ...agentIds]
    ).catch(() => []);

    const result = agents.map(a => ({
      agent_id: a.agent_id,
      name: a.name || a.agent_id,
      calls_answered: Number(a.calls_answered) || 0,
      calls_missed: Number(a.calls_missed) || 0,
      talk_time: fmtSec(Number(a.talk_time_sec) || 0),
      talk_time_sec: Number(a.talk_time_sec) || 0,
      wrap_time: fmtSec(Number(a.wrap_time_sec) || 0),
      pause_time: fmtSec(Number(a.pause_time_sec) || 0),
      pause_time_sec: Number(a.pause_time_sec) || 0,
      login_time: fmtSec(Number(a.login_time_sec) || 0),
      occupancy_pct: a.occupancy != null ? Math.round(Number(a.occupancy) * 100) : 0,
      aht: fmtSec(Number(a.aht) || 0),
      aht_sec: Number(a.aht) || 0,
    }));

    return res.json({ success: true, startDate, endDate, agents: result });
  } catch (err) {
    console.error('Report comparison error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load comparison' });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/reports/trends
// Daily trend data for a date range (calls, talk time, occupancy, AHT)
// ──────────────────────────────────────────────────────────────
router.get('/trends', async (req, res) => {
  try {
    const tenantId = await getTenantId(req);
    if (!tenantId) return res.json({ success: true, data: [] });
    const { startDate, endDate } = parseDateRange(req);
    const agentFilter = req.query.agent_id || null;

    let sql = `
      SELECT d.stat_date AS date,
             SUM(d.calls_answered) AS calls_answered,
             SUM(d.calls_missed) AS calls_missed,
             SUM(d.talk_time_sec) AS talk_time_sec,
             SUM(d.wrap_time_sec) AS wrap_time_sec,
             SUM(d.pause_time_sec) AS pause_time_sec,
             SUM(d.login_time_sec) AS login_time_sec,
             CASE WHEN SUM(d.login_time_sec) > 0
               THEN ROUND(LEAST(1, (SUM(d.talk_time_sec) + SUM(d.wrap_time_sec)) / SUM(d.login_time_sec)) * 100)
               ELSE 0 END AS occupancy_pct,
             CASE WHEN SUM(d.calls_answered) > 0
               THEN ROUND((SUM(d.talk_time_sec) + SUM(d.wrap_time_sec)) / SUM(d.calls_answered))
               ELSE 0 END AS aht
      FROM agent_daily_stats d
      WHERE d.tenant_id = ? AND d.stat_date BETWEEN ? AND ?`;
    const params = [tenantId, startDate, endDate];
    if (agentFilter) { sql += ' AND d.agent_id = ?'; params.push(agentFilter); }
    sql += ' GROUP BY d.stat_date ORDER BY d.stat_date';

    const data = await query(sql, params).catch(() => []);

    const result = data.map(r => ({
      date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
      calls_answered: Number(r.calls_answered) || 0,
      calls_missed: Number(r.calls_missed) || 0,
      talk_time_sec: Number(r.talk_time_sec) || 0,
      occupancy_pct: Number(r.occupancy_pct) || 0,
      aht: Number(r.aht) || 0,
      pause_time_sec: Number(r.pause_time_sec) || 0,
    }));

    return res.json({ success: true, startDate, endDate, data: result });
  } catch (err) {
    console.error('Report trends error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load trends' });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/reports/hourly
// Hourly breakdown for a single day
// ──────────────────────────────────────────────────────────────
router.get('/hourly', async (req, res) => {
  try {
    const tenantId = await getTenantId(req);
    if (!tenantId) return res.json({ success: true, data: [] });
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const agentFilter = req.query.agent_id || null;

    let sql = `
      SELECT stat_hour AS hour,
             SUM(calls_answered) AS calls_answered,
             SUM(calls_missed) AS calls_missed,
             SUM(talk_time_sec) AS talk_time_sec,
             SUM(wrap_time_sec) AS wrap_time_sec,
             SUM(pause_time_sec) AS pause_time_sec,
             SUM(login_time_sec) AS login_time_sec
      FROM agent_hourly_stats
      WHERE tenant_id = ? AND stat_date = ?`;
    const params = [tenantId, date];
    if (agentFilter) { sql += ' AND agent_id = ?'; params.push(agentFilter); }
    sql += ' GROUP BY stat_hour ORDER BY stat_hour';

    const data = await query(sql, params).catch(() => []);

    const hours = [];
    for (let h = 0; h < 24; h++) {
      const row = data.find(r => Number(r.hour) === h);
      hours.push({
        hour: h,
        label: `${String(h).padStart(2, '0')}:00`,
        calls_answered: row ? Number(row.calls_answered) || 0 : 0,
        calls_missed: row ? Number(row.calls_missed) || 0 : 0,
        talk_time_sec: row ? Number(row.talk_time_sec) || 0 : 0,
        pause_time_sec: row ? Number(row.pause_time_sec) || 0 : 0,
      });
    }

    return res.json({ success: true, date, data: hours });
  } catch (err) {
    console.error('Report hourly error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load hourly report' });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/reports/queue
// Queue performance for date range
// ──────────────────────────────────────────────────────────────
router.get('/queue', async (req, res) => {
  try {
    const tenantId = await getTenantId(req);
    if (!tenantId) return res.json({ success: true, queues: [] });
    const { startDate, endDate } = parseDateRange(req);
    const queueFilter = req.query.queue || null;

    let sql = `
      SELECT q.queue_name,
             SUM(q.calls_offered) AS calls_offered,
             SUM(q.calls_answered) AS calls_answered,
             SUM(q.calls_abandoned) AS calls_abandoned,
             SUM(q.calls_transferred) AS calls_transferred,
             SUM(q.total_talk_sec) AS total_talk_sec,
             SUM(q.total_wait_sec) AS total_wait_sec,
             ROUND(AVG(q.avg_wait_sec)) AS avg_wait_sec,
             ROUND(AVG(q.avg_talk_sec)) AS avg_talk_sec,
             MAX(q.max_wait_sec) AS max_wait_sec,
             ROUND(AVG(q.service_level)) AS service_level
      FROM queue_daily_stats q
      WHERE q.tenant_id = ? AND q.stat_date BETWEEN ? AND ?`;
    const params = [tenantId, startDate, endDate];
    if (queueFilter) { sql += ' AND q.queue_name = ?'; params.push(queueFilter); }
    sql += ' GROUP BY q.queue_name ORDER BY q.queue_name';

    const queues = await query(sql, params).catch(() => []);

    const result = queues.map(q => ({
      queue_name: q.queue_name,
      calls_offered: Number(q.calls_offered) || 0,
      calls_answered: Number(q.calls_answered) || 0,
      calls_abandoned: Number(q.calls_abandoned) || 0,
      calls_transferred: Number(q.calls_transferred) || 0,
      total_talk_time: fmtSec(Number(q.total_talk_sec) || 0),
      avg_wait_time: fmtSec(Number(q.avg_wait_sec) || 0),
      avg_talk_time: fmtSec(Number(q.avg_talk_sec) || 0),
      max_wait_time: fmtSec(Number(q.max_wait_sec) || 0),
      service_level: Number(q.service_level) || 0,
      answer_rate: (Number(q.calls_offered) || 0) > 0
        ? Math.round((Number(q.calls_answered) / Number(q.calls_offered)) * 100) : 0,
    }));

    return res.json({ success: true, startDate, endDate, queues: result });
  } catch (err) {
    console.error('Report queue error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load queue report' });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/reports/time-distribution
// How agents spend their time (talk, ready, wrap, pause)
// ──────────────────────────────────────────────────────────────
router.get('/time-distribution', async (req, res) => {
  try {
    const tenantId = await getTenantId(req);
    if (!tenantId) return res.json({ success: true, agents: [] });
    const { startDate, endDate } = parseDateRange(req);
    const agentFilter = req.query.agent_id || null;

    let sql = `
      SELECT d.agent_id,
             COALESCE(u.phone_login_name, u.username) AS name,
             SUM(d.talk_time_sec) AS talk_sec,
             SUM(d.wrap_time_sec) AS wrap_sec,
             SUM(d.pause_time_sec) AS pause_sec,
             SUM(d.login_time_sec) AS login_sec
      FROM agent_daily_stats d
      LEFT JOIN users u ON u.phone_login_number = d.agent_id AND u.role = 5
      WHERE d.tenant_id = ? AND d.stat_date BETWEEN ? AND ?`;
    const params = [tenantId, startDate, endDate];
    if (agentFilter) { sql += ' AND d.agent_id = ?'; params.push(agentFilter); }
    sql += ' GROUP BY d.agent_id, u.phone_login_name, u.username ORDER BY name';

    const agents = await query(sql, params).catch(() => []);

    const result = agents.map(a => {
      const talk = Number(a.talk_sec) || 0;
      const wrap = Number(a.wrap_sec) || 0;
      const pause = Number(a.pause_sec) || 0;
      const login = Number(a.login_sec) || 0;
      const ready = Math.max(0, login - talk - wrap - pause);

      return {
        agent_id: a.agent_id,
        name: a.name || a.agent_id,
        talk_time: fmtSec(talk),
        talk_sec: talk,
        ready_time: fmtSec(ready),
        ready_sec: ready,
        wrap_time: fmtSec(wrap),
        wrap_sec: wrap,
        pause_time: fmtSec(pause),
        pause_sec: pause,
        login_time: fmtSec(login),
        login_sec: login,
        talk_pct: login > 0 ? Math.round((talk / login) * 100) : 0,
        ready_pct: login > 0 ? Math.round((ready / login) * 100) : 0,
        wrap_pct: login > 0 ? Math.round((wrap / login) * 100) : 0,
        pause_pct: login > 0 ? Math.round((pause / login) * 100) : 0,
      };
    });

    return res.json({ success: true, startDate, endDate, agents: result });
  } catch (err) {
    console.error('Report time-distribution error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load time distribution' });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/reports/alerts
// Supervisor alerts for break discipline and low performance
// ──────────────────────────────────────────────────────────────
router.get('/alerts', async (req, res) => {
  try {
    const tenantId = await getTenantId(req);
    if (!tenantId) return res.json({ success: true, alerts: [] });
    const date = req.query.date || new Date().toISOString().slice(0, 10);

    const alerts = [];

    // Break time alerts
    try {
      const breakAlerts = await query(
        `SELECT d.agent_id, COALESCE(u.phone_login_name, u.username) AS name,
                d.pause_time_sec, d.login_time_sec, d.calls_answered
         FROM agent_daily_stats d
         LEFT JOIN users u ON u.phone_login_number = d.agent_id AND u.role = 5
         WHERE d.tenant_id = ? AND d.stat_date = ?`,
        [tenantId, date]
      );

      for (const a of breakAlerts) {
        const pauseSec = Number(a.pause_time_sec) || 0;
        const loginSec = Number(a.login_time_sec) || 0;
        const calls = Number(a.calls_answered) || 0;

        if (pauseSec > BREAK_LIMITS.default) {
          alerts.push({
            type: 'break_exceeded',
            severity: 'warning',
            agent_id: a.agent_id,
            agent_name: a.name || a.agent_id,
            message: `Break time ${fmtSec(pauseSec)} exceeds ${fmtSec(BREAK_LIMITS.default)} limit`,
            value: pauseSec,
          });
        }

        // Low occupancy alert (below 30%)
        if (loginSec > 3600) {
          const occ = (Number(a.login_time_sec) - pauseSec) > 0 ? calls > 0 ? 0.3 : 0 : 0;
          const actualOcc = loginSec > 0 ? ((Number(a.pause_time_sec) || 0) < loginSec ? 1 - (pauseSec / loginSec) : 0) : 0;
          if (actualOcc < 0.3 && loginSec > 7200) {
            alerts.push({
              type: 'low_occupancy',
              severity: 'info',
              agent_id: a.agent_id,
              agent_name: a.name || a.agent_id,
              message: `Occupancy is ${Math.round(actualOcc * 100)}% (below 30% target)`,
              value: Math.round(actualOcc * 100),
            });
          }
        }
      }
    } catch (_) {}

    return res.json({ success: true, date, alerts });
  } catch (err) {
    console.error('Report alerts error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load alerts' });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/reports/agents
// List agents for filter dropdowns
// ──────────────────────────────────────────────────────────────
router.get('/agents', async (req, res) => {
  try {
    const tenantId = await getTenantId(req);
    if (!tenantId) return res.json({ success: true, agents: [] });
    const agents = await query(
      `SELECT phone_login_number AS agent_id, COALESCE(phone_login_name, username) AS name
       FROM users WHERE parent_id = ? AND role = 5 ORDER BY name`,
      [tenantId]
    ).catch(() => []);
    return res.json({ success: true, agents });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed' });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/reports/queues
// List queues for filter dropdowns
// ──────────────────────────────────────────────────────────────
router.get('/queues', async (req, res) => {
  try {
    const tenantId = await getTenantId(req);
    if (!tenantId) return res.json({ success: true, queues: [] });
    const queues = await query(
      'SELECT name, COALESCE(display_name, name) AS display_name FROM queues WHERE tenant_id = ? ORDER BY name',
      [tenantId]
    ).catch(() => []);
    return res.json({ success: true, queues });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed' });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/reports/tenants
// List tenants for filter (superadmin/admin)
// ──────────────────────────────────────────────────────────────
router.get('/tenants', async (req, res) => {
  const u = req.reportUser;
  if (!isSuperadmin(u) && !isAdmin(u)) return res.json({ success: true, tenants: [] });
  if (u.parent_id != null || u.tenant_id != null) return res.json({ success: true, tenants: [] });
  try {
    const rows = await query('SELECT id, name FROM tenants ORDER BY id');
    return res.json({ success: true, tenants: rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed' });
  }
});

export default router;

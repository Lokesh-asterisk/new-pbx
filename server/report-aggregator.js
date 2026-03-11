/**
 * Background worker that periodically aggregates agent and queue stats
 * into reporting tables for fast historical queries.
 */
import { query, queryOne } from './db.js';

const INTERVAL_MS = parseInt(process.env.REPORT_AGGREGATE_INTERVAL_MS || '300000', 10); // 5 min
const SLA_THRESHOLD_SEC = parseInt(process.env.WALLBOARD_SLA_SECONDS || '20', 10);

let timer = null;

export function startReportAggregator() {
  runAggregation().catch((e) => console.error('Initial aggregation error:', e?.message || e));
  timer = setInterval(() => {
    runAggregation().catch((e) => console.error('Aggregation cycle error:', e?.message || e));
  }, INTERVAL_MS);
  console.log(`Report aggregator started (every ${INTERVAL_MS / 1000}s)`);
}

export function stopReportAggregator() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function runAggregation() {
  try {
    const tenants = await query('SELECT id FROM tenants ORDER BY id').catch(() => []);
    const today = new Date().toISOString().slice(0, 10);
    for (const t of tenants) {
      await aggregateHourlyStats(t.id, today).catch(() => {});
      await aggregateBreakStats(t.id, today).catch(() => {});
      await aggregateQueueDailyStats(t.id, today).catch(() => {});
      await aggregateDailyStats(t.id, today).catch(() => {});
    }
  } catch (e) {
    if (e?.code !== 'ER_NO_SUCH_TABLE') console.error('runAggregation:', e?.message || e);
  }
}

async function aggregateHourlyStats(tenantId, date) {
  try {
    const agents = await query(
      'SELECT id AS user_id, phone_login_number AS agent_id FROM users WHERE parent_id = ? AND role = 5',
      [tenantId]
    );
    const currentHour = new Date().getHours();

    for (const u of agents) {
      const agentId = String(u.agent_id || '').trim();
      if (!agentId) continue;

      for (let h = 0; h <= (date === new Date().toISOString().slice(0, 10) ? currentHour : 23); h++) {
        const hourStart = `${date} ${String(h).padStart(2, '0')}:00:00`;
        const hourEnd = `${date} ${String(h).padStart(2, '0')}:59:59`;

        let callsAnswered = 0, callsMissed = 0, talkSec = 0, totalDuration = 0;
        try {
          const cr = await queryOne(
            `SELECT
               SUM(CASE WHEN status NOT IN ('failed','abandoned') AND answer_time IS NOT NULL THEN 1 ELSE 0 END) AS answered,
               SUM(CASE WHEN status IN ('abandoned') OR (answer_time IS NULL AND status NOT IN ('failed')) THEN 1 ELSE 0 END) AS missed,
               COALESCE(SUM(CASE WHEN status NOT IN ('failed','abandoned') THEN talk_sec ELSE 0 END), 0) AS talk,
               COALESCE(SUM(CASE WHEN status NOT IN ('failed','abandoned') THEN duration_sec ELSE 0 END), 0) AS dur
             FROM call_records
             WHERE tenant_id = ? AND (agent_id = ? OR agent_user_id = ?)
               AND start_time BETWEEN ? AND ?`,
            [tenantId, agentId, u.user_id, hourStart, hourEnd]
          );
          callsAnswered = Number(cr?.answered) || 0;
          callsMissed = Number(cr?.missed) || 0;
          talkSec = Number(cr?.talk) || 0;
          totalDuration = Number(cr?.dur) || 0;
        } catch (_) {}

        let pauseSec = 0;
        try {
          const br = await queryOne(
            `SELECT COALESCE(SUM(LEAST(
                TIMESTAMPDIFF(SECOND, GREATEST(start_time, ?), LEAST(COALESCE(end_time, NOW()), ?)),
                TIMESTAMPDIFF(SECOND, start_time, COALESCE(end_time, NOW()))
              )), 0) AS s
             FROM agent_status_log
             WHERE tenant_id = ? AND agent_id = ? AND status = 'PAUSED'
               AND start_time <= ? AND (end_time >= ? OR end_time IS NULL)`,
            [hourStart, hourEnd, tenantId, agentId, hourEnd, hourStart]
          );
          pauseSec = Math.max(0, Number(br?.s) || 0);
        } catch (_) {}

        let readySec = 0;
        try {
          const rr = await queryOne(
            `SELECT COALESCE(SUM(LEAST(
                TIMESTAMPDIFF(SECOND, GREATEST(start_time, ?), LEAST(COALESCE(end_time, NOW()), ?)),
                TIMESTAMPDIFF(SECOND, start_time, COALESCE(end_time, NOW()))
              )), 0) AS s
             FROM agent_status_log
             WHERE tenant_id = ? AND agent_id = ? AND status = 'READY'
               AND start_time <= ? AND (end_time >= ? OR end_time IS NULL)`,
            [hourStart, hourEnd, tenantId, agentId, hourEnd, hourStart]
          );
          readySec = Math.max(0, Number(rr?.s) || 0);
        } catch (_) {}

        let loginSec = 0;
        try {
          const sess = await queryOne(
            `SELECT COALESCE(SUM(LEAST(
                TIMESTAMPDIFF(SECOND, GREATEST(login_time, ?), LEAST(COALESCE(logout_time, NOW()), ?)),
                TIMESTAMPDIFF(SECOND, login_time, COALESCE(logout_time, NOW()))
              )), 0) AS s
             FROM agent_sessions
             WHERE tenant_id = ? AND agent_id = ?
               AND login_time <= ? AND (logout_time >= ? OR logout_time IS NULL)`,
            [hourStart, hourEnd, tenantId, agentId, hourEnd, hourStart]
          );
          loginSec = Math.max(0, Number(sess?.s) || 0);
        } catch (_) {}

        const wrapSec = Math.max(0, totalDuration - talkSec);
        const occupancy = loginSec > 0 ? Math.min(1, (talkSec + wrapSec) / loginSec) : null;
        const aht = callsAnswered > 0 ? Math.round(totalDuration / callsAnswered) : null;

        if (callsAnswered || callsMissed || talkSec || pauseSec || loginSec) {
          await query(
            `INSERT INTO agent_hourly_stats
               (tenant_id, agent_id, agent_user_id, stat_date, stat_hour,
                calls_answered, calls_missed, talk_time_sec, wrap_time_sec, pause_time_sec,
                ready_time_sec, login_time_sec, occupancy, avg_handle_time_sec)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               calls_answered = VALUES(calls_answered), calls_missed = VALUES(calls_missed),
               talk_time_sec = VALUES(talk_time_sec), wrap_time_sec = VALUES(wrap_time_sec),
               pause_time_sec = VALUES(pause_time_sec), ready_time_sec = VALUES(ready_time_sec),
               login_time_sec = VALUES(login_time_sec), occupancy = VALUES(occupancy),
               avg_handle_time_sec = VALUES(avg_handle_time_sec), updated_at = NOW()`,
            [tenantId, agentId, u.user_id, date, h,
             callsAnswered, callsMissed, talkSec, wrapSec, pauseSec,
             readySec, loginSec, occupancy, aht]
          );
        }
      }
    }
  } catch (e) {
    if (e?.code !== 'ER_NO_SUCH_TABLE') console.error('aggregateHourlyStats:', e?.message || e);
  }
}

async function aggregateBreakStats(tenantId, date) {
  try {
    const rows = await query(
      `SELECT
         sl.agent_id,
         u.id AS user_id,
         COALESCE(sl.pause_reason, 'Unknown') AS break_type,
         COUNT(*) AS break_count,
         COALESCE(SUM(sl.duration_sec), 0) AS total_sec,
         COALESCE(AVG(sl.duration_sec), 0) AS avg_sec,
         COALESCE(MAX(sl.duration_sec), 0) AS max_sec
       FROM agent_status_log sl
       LEFT JOIN users u ON u.phone_login_number = sl.agent_id AND u.role = 5
       WHERE sl.tenant_id = ? AND sl.status = 'PAUSED' AND DATE(sl.start_time) = ? AND sl.end_time IS NOT NULL
       GROUP BY sl.agent_id, u.id, COALESCE(sl.pause_reason, 'Unknown')`,
      [tenantId, date]
    );

    for (const r of rows) {
      await query(
        `INSERT INTO agent_break_stats
           (tenant_id, agent_id, agent_user_id, stat_date, break_type,
            break_count, total_duration_sec, avg_duration_sec, max_duration_sec)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           break_count = VALUES(break_count), total_duration_sec = VALUES(total_duration_sec),
           avg_duration_sec = VALUES(avg_duration_sec), max_duration_sec = VALUES(max_duration_sec),
           updated_at = NOW()`,
        [tenantId, r.agent_id, r.user_id, date, r.break_type,
         Number(r.break_count), Number(r.total_sec), Math.round(Number(r.avg_sec)), Number(r.max_sec)]
      );
    }

    // Also aggregate from session_agent_breaks as fallback
    try {
      const sbRows = await query(
        `SELECT
           u.phone_login_number AS agent_id,
           b.agent_id AS user_id,
           COALESCE(b.break_name, 'Unknown') AS break_type,
           COUNT(*) AS break_count,
           COALESCE(SUM(TIMESTAMPDIFF(SECOND, b.start_time, COALESCE(b.end_time, NOW()))), 0) AS total_sec,
           COALESCE(AVG(TIMESTAMPDIFF(SECOND, b.start_time, COALESCE(b.end_time, NOW()))), 0) AS avg_sec,
           COALESCE(MAX(TIMESTAMPDIFF(SECOND, b.start_time, COALESCE(b.end_time, NOW()))), 0) AS max_sec
         FROM session_agent_breaks b
         LEFT JOIN users u ON u.id = b.agent_id AND u.role = 5
         WHERE b.tenant_id = ? AND DATE(b.start_time) = ?
         GROUP BY u.phone_login_number, b.agent_id, COALESCE(b.break_name, 'Unknown')`,
        [tenantId, date]
      );

      for (const r of sbRows) {
        if (!r.agent_id) continue;
        await query(
          `INSERT INTO agent_break_stats
             (tenant_id, agent_id, agent_user_id, stat_date, break_type,
              break_count, total_duration_sec, avg_duration_sec, max_duration_sec)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             break_count = GREATEST(VALUES(break_count), break_count),
             total_duration_sec = GREATEST(VALUES(total_duration_sec), total_duration_sec),
             avg_duration_sec = VALUES(avg_duration_sec),
             max_duration_sec = GREATEST(VALUES(max_duration_sec), max_duration_sec),
             updated_at = NOW()`,
          [tenantId, r.agent_id, r.user_id, date, r.break_type,
           Number(r.break_count), Number(r.total_sec), Math.round(Number(r.avg_sec)), Number(r.max_sec)]
        );
      }
    } catch (_) {}
  } catch (e) {
    if (e?.code !== 'ER_NO_SUCH_TABLE') console.error('aggregateBreakStats:', e?.message || e);
  }
}

async function aggregateQueueDailyStats(tenantId, date) {
  try {
    const rows = await query(
      `SELECT
         queue_name,
         COUNT(*) AS offered,
         SUM(CASE WHEN LOWER(TRIM(status)) IN ('answered','completed') AND answer_time IS NOT NULL THEN 1 ELSE 0 END) AS answered,
         SUM(CASE WHEN LOWER(TRIM(status)) IN ('abandoned','abondoned') OR (answer_time IS NULL AND LOWER(TRIM(status)) = 'completed') THEN 1 ELSE 0 END) AS abandoned,
         SUM(CASE WHEN transfer_status = 1 THEN 1 ELSE 0 END) AS transferred,
         COALESCE(SUM(CASE WHEN answer_time IS NOT NULL THEN talk_sec ELSE 0 END), 0) AS total_talk,
         COALESCE(SUM(CASE WHEN answer_time IS NOT NULL THEN TIMESTAMPDIFF(SECOND, start_time, answer_time) ELSE 0 END), 0) AS total_wait,
         COALESCE(AVG(CASE WHEN answer_time IS NOT NULL THEN TIMESTAMPDIFF(SECOND, start_time, answer_time) END), 0) AS avg_wait,
         COALESCE(AVG(CASE WHEN answer_time IS NOT NULL THEN talk_sec END), 0) AS avg_talk,
         COALESCE(MAX(CASE WHEN answer_time IS NOT NULL THEN TIMESTAMPDIFF(SECOND, start_time, answer_time) END), 0) AS max_wait,
         SUM(CASE WHEN answer_time IS NOT NULL AND TIMESTAMPDIFF(SECOND, start_time, answer_time) <= ? THEN 1 ELSE 0 END) AS within_sla,
         SUM(CASE WHEN answer_time IS NOT NULL THEN 1 ELSE 0 END) AS sla_total
       FROM call_records
       WHERE tenant_id = ? AND DATE(start_time) = ? AND queue_name IS NOT NULL AND queue_name != ''
       GROUP BY queue_name`,
      [SLA_THRESHOLD_SEC, tenantId, date]
    );

    for (const r of rows) {
      const slaTotal = Number(r.sla_total) || 0;
      const withinSla = Number(r.within_sla) || 0;
      const serviceLevel = slaTotal > 0 ? Math.round((withinSla / slaTotal) * 100) : null;

      await query(
        `INSERT INTO queue_daily_stats
           (tenant_id, queue_name, stat_date, calls_offered, calls_answered, calls_abandoned,
            calls_transferred, total_talk_sec, total_wait_sec, avg_wait_sec, avg_talk_sec,
            max_wait_sec, service_level)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           calls_offered = VALUES(calls_offered), calls_answered = VALUES(calls_answered),
           calls_abandoned = VALUES(calls_abandoned), calls_transferred = VALUES(calls_transferred),
           total_talk_sec = VALUES(total_talk_sec), total_wait_sec = VALUES(total_wait_sec),
           avg_wait_sec = VALUES(avg_wait_sec), avg_talk_sec = VALUES(avg_talk_sec),
           max_wait_sec = VALUES(max_wait_sec), service_level = VALUES(service_level),
           updated_at = NOW()`,
        [tenantId, r.queue_name, date,
         Number(r.offered), Number(r.answered), Number(r.abandoned), Number(r.transferred),
         Number(r.total_talk), Number(r.total_wait),
         Math.round(Number(r.avg_wait)), Math.round(Number(r.avg_talk)),
         Number(r.max_wait), serviceLevel]
      );
    }
  } catch (e) {
    if (e?.code !== 'ER_NO_SUCH_TABLE') console.error('aggregateQueueDailyStats:', e?.message || e);
  }
}

async function aggregateDailyStats(tenantId, date) {
  try {
    const agents = await query(
      'SELECT id AS user_id, phone_login_number AS agent_id FROM users WHERE parent_id = ? AND role = 5',
      [tenantId]
    );

    let callStatsByAgent = {};
    try {
      const crRows = await query(
        `SELECT
           COALESCE(agent_id, '') AS agent_id,
           agent_user_id,
           COUNT(*) AS offered,
           SUM(CASE WHEN status NOT IN ('failed','abandoned') AND answer_time IS NOT NULL THEN 1 ELSE 0 END) AS answered,
           SUM(CASE WHEN status IN ('abandoned') OR (answer_time IS NULL AND status NOT IN ('failed')) THEN 1 ELSE 0 END) AS missed,
           SUM(CASE WHEN transfer_status = 1 THEN 1 ELSE 0 END) AS transferred,
           COALESCE(SUM(CASE WHEN status NOT IN ('failed','abandoned') THEN talk_sec ELSE 0 END), 0) AS talk,
           COALESCE(SUM(CASE WHEN status NOT IN ('failed','abandoned') THEN duration_sec ELSE 0 END), 0) AS dur
         FROM call_records
         WHERE tenant_id = ? AND DATE(start_time) = ?
         GROUP BY agent_id, agent_user_id`,
        [tenantId, date]
      );
      for (const r of crRows) {
        const key = String(r.agent_id || '').trim() || String(r.agent_user_id || '');
        callStatsByAgent[key] = r;
      }
    } catch (_) {}

    let pauseByAgent = {};
    try {
      const pauseRows = await query(
        `SELECT agent_id, COALESCE(SUM(duration_sec), 0) AS s FROM agent_status_log
         WHERE tenant_id = ? AND status = 'PAUSED' AND DATE(start_time) = ? AND end_time IS NOT NULL
         GROUP BY agent_id`,
        [tenantId, date]
      );
      for (const r of pauseRows) pauseByAgent[r.agent_id] = Number(r.s) || 0;
    } catch (_) {}

    let pauseByUserId = {};
    try {
      const sbRows = await query(
        `SELECT agent_id, COALESCE(SUM(TIMESTAMPDIFF(SECOND, start_time, COALESCE(end_time, NOW()))), 0) AS s
         FROM session_agent_breaks WHERE tenant_id = ? AND DATE(start_time) = ?
         GROUP BY agent_id`,
        [tenantId, date]
      );
      for (const r of sbRows) pauseByUserId[r.agent_id] = Number(r.s) || 0;
    } catch (_) {}

    let loginByAgent = {};
    try {
      const sessRows = await query(
        `SELECT agent_id, COALESCE(SUM(session_duration_sec), 0) AS s
         FROM agent_sessions WHERE tenant_id = ? AND DATE(login_time) = ? AND logout_time IS NOT NULL
         GROUP BY agent_id`,
        [tenantId, date]
      );
      for (const r of sessRows) loginByAgent[r.agent_id] = Number(r.s) || 0;
    } catch (_) {}

    let readyByAgent = {};
    try {
      const readyRows = await query(
        `SELECT agent_id, COALESCE(SUM(duration_sec), 0) AS s FROM agent_status_log
         WHERE tenant_id = ? AND status = 'READY' AND DATE(start_time) = ? AND end_time IS NOT NULL
         GROUP BY agent_id`,
        [tenantId, date]
      );
      for (const r of readyRows) readyByAgent[r.agent_id] = Number(r.s) || 0;
    } catch (_) {}

    for (const u of agents) {
      const agentId = String(u.agent_id || '').trim();
      if (!agentId) continue;

      const cr = callStatsByAgent[agentId] || callStatsByAgent[String(u.user_id)] || {};
      const callsOffered = Number(cr.offered) || 0;
      const callsAnswered = Number(cr.answered) || 0;
      const callsMissed = Number(cr.missed) || 0;
      const callsTransferred = Number(cr.transferred) || 0;
      const totalTalk = Number(cr.talk) || 0;
      const totalDuration = Number(cr.dur) || 0;

      const pauseSec = pauseByAgent[agentId] || pauseByUserId[u.user_id] || 0;

      const readySec = readyByAgent[agentId] || 0;

      const loginSec = loginByAgent[agentId] || 0;

      const wrapSec = Math.max(0, totalDuration - totalTalk);
      const occupancy = loginSec > 0 ? Math.min(1, (totalTalk + wrapSec) / loginSec) : null;
      const aht = callsAnswered > 0 ? Math.round(totalDuration / callsAnswered) : null;

      // Performance score: 40% calls handled + 40% conversion + 20% occupancy
      const maxCalls = 80;
      const callScore = Math.min(100, (callsAnswered / maxCalls) * 100);
      const conversionRate = callsAnswered > 0 ? 0 : 0; // sales_count not tracked via call_records directly
      const occScore = occupancy != null ? occupancy * 100 : 0;
      const perfScore = (callScore * 0.4) + (conversionRate * 0.4) + (occScore * 0.2);

      await query(
        `INSERT INTO agent_daily_stats
           (tenant_id, agent_id, agent_user_id, stat_date, calls_answered, calls_missed,
            talk_time_sec, wrap_time_sec, pause_time_sec, login_time_sec, occupancy,
            avg_handle_time_sec)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           calls_answered = VALUES(calls_answered), calls_missed = VALUES(calls_missed),
           talk_time_sec = VALUES(talk_time_sec), wrap_time_sec = VALUES(wrap_time_sec),
           pause_time_sec = VALUES(pause_time_sec), login_time_sec = VALUES(login_time_sec),
           occupancy = VALUES(occupancy), avg_handle_time_sec = VALUES(avg_handle_time_sec),
           updated_at = NOW()`,
        [tenantId, agentId, u.user_id, date, callsAnswered, callsMissed,
         totalTalk, wrapSec, pauseSec, loginSec, occupancy, aht]
      );

      // Update extended columns if they exist
      try {
        await query(
          `UPDATE agent_daily_stats SET
             calls_offered = ?, calls_transferred = ?, ready_time_sec = ?, performance_score = ?
           WHERE tenant_id = ? AND agent_id = ? AND stat_date = ?`,
          [callsOffered, callsTransferred, readySec, Math.round(perfScore * 100) / 100,
           tenantId, agentId, date]
        );
      } catch (_) {}
    }
  } catch (e) {
    if (e?.code !== 'ER_NO_SUCH_TABLE') console.error('aggregateDailyStats:', e?.message || e);
  }
}

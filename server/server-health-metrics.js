/**
 * Server health metrics for the admin/supervisor dashboard.
 * Collects CPU, RAM, disk, load, DB, Asterisk, Redis, recordings, and service status.
 */

import os from 'os';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, queryOne, pool } from './db.js';
import { listChannels, listEndpoints, isAriConfigured } from './asterisk-ari.js';
import { isRedisAvailable } from './redis-wallboard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Network rate: keep last sample to compute bytes/sec
let lastNetworkSample = null;

// Thresholds for alerts (same as spec)
const CPU_ALERT_PCT = 80;
const RAM_ALERT_PCT = 85;
const DISK_ALERT_PCT = 90;
const DISK_FREE_ALERT_PCT = 10; // alert when free < 10%

let lastCpuSample = null;

function getCpuUsage() {
  const cpus = os.cpus();
  if (!cpus || cpus.length === 0) return null;
  let totalIdle = 0;
  let totalTick = 0;
  for (const cpu of cpus) {
    for (const t of ['user', 'nice', 'sys', 'irq', 'idle']) {
      totalTick += cpu.times[t] ?? 0;
    }
    totalIdle += cpu.times.idle ?? 0;
  }
  const now = { totalIdle, totalTick, time: Date.now() };
  if (lastCpuSample) {
    const idleDelta = now.totalIdle - lastCpuSample.totalIdle;
    const totalDelta = now.totalTick - lastCpuSample.totalTick;
    lastCpuSample = now;
    if (totalDelta > 0) {
      const pct = Math.min(100, Math.round(100 * (1 - idleDelta / totalDelta)));
      return Number.isFinite(pct) ? pct : null;
    }
  }
  lastCpuSample = now;
  return null;
}

function getMemory() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const pct = total > 0 ? Math.round((100 * used) / total) : 0;
  return {
    usedBytes: used,
    totalBytes: total,
    usedGb: Math.round((used / (1024 ** 3)) * 10) / 10,
    totalGb: Math.round((total / (1024 ** 3)) * 10) / 10,
    usagePct: pct,
  };
}

function getLoadAvg() {
  try {
    const load = os.loadavg();
    return { load1: load[0], load5: load[1], load15: load[2] };
  } catch {
    return { load1: null, load5: null, load15: null };
  }
}

function getCpuCores() {
  return os.cpus().length;
}

function getDiskUsage() {
  const root = process.platform === 'win32' ? process.cwd().split(path.sep)[0] + path.sep : '/';
  try {
    if (process.platform === 'win32') {
      const drive = root.replace(/\\$/, '');
      try {
        // Use PowerShell (wmic is deprecated/removed on newer Windows)
        const filter = "DeviceID='" + drive + "'";
        const ps = `$d=Get-CimInstance Win32_LogicalDisk -Filter '${filter.replace(/'/g, "''")}'|Select-Object Size,FreeSpace;$d.Size;$d.FreeSpace`;
        const out = execSync('powershell -NoProfile -Command "' + ps.replace(/"/g, '\\"') + '"', { encoding: 'utf8', timeout: 8000 });
        const lines = out.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        const nums = lines.map((s) => parseInt(s, 10)).filter(Number.isFinite);
        if (nums.length >= 2) {
          const size = nums[0];
          const freeSpace = nums[1];
          if (size > 0) {
            const used = size - freeSpace;
            const pct = Math.round((100 * used) / size);
            return {
              usedBytes: used,
              totalBytes: size,
              usedGb: Math.round((used / (1024 ** 3)) * 10) / 10,
              totalGb: Math.round((size / (1024 ** 3)) * 10) / 10,
              usagePct: pct,
            };
          }
        }
      } catch (_) {
        // PowerShell / CIM failed
      }
    } else {
      const out = execSync('df -k ' + root.replace(/\s/g, '\\ '), { encoding: 'utf8', timeout: 5000 });
      const lines = out.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].trim().split(/\s+/);
        const totalK = parseInt(parts[1], 10);
        const usedK = parseInt(parts[2], 10);
        if (Number.isFinite(totalK) && totalK > 0) {
          const total = totalK * 1024;
          const used = usedK * 1024;
          const pct = Math.round((100 * used) / total);
          return {
            usedBytes: used,
            totalBytes: total,
            usedGb: Math.round((used / (1024 ** 3)) * 10) / 10,
            totalGb: Math.round((total / (1024 ** 3)) * 10) / 10,
            usagePct: pct,
          };
        }
      }
    }
  } catch (e) {
    // df/wmic not available or failed
  }
  return null;
}

async function getDbMetrics() {
  let connections = null;
  let slowQueries = null;
  let queryTimeMs = null;
  try {
    const poolInternal = pool.pool || pool;
    if (poolInternal && typeof poolInternal._allConnections !== 'undefined') {
      connections = (poolInternal._allConnections || []).length;
    }
  } catch {}
  try {
    const rows = await query('SHOW STATUS WHERE Variable_name IN ("Threads_connected", "Slow_queries")');
    for (const r of rows || []) {
      if (r.Variable_name === 'Threads_connected') connections = parseInt(r.Value, 10);
      if (r.Variable_name === 'Slow_queries') slowQueries = parseInt(r.Value, 10);
    }
  } catch {}
  try {
    const start = Date.now();
    await queryOne('SELECT 1');
    queryTimeMs = Date.now() - start;
  } catch {}
  return {
    activeConnections: Number.isFinite(connections) ? connections : null,
    slowQueries: Number.isFinite(slowQueries) ? slowQueries : null,
    queryTimeMs: Number.isFinite(queryTimeMs) ? queryTimeMs : null,
  };
}

async function getAsteriskMetrics() {
  if (!isAriConfigured()) {
    return {
      channels: 0,
      activeCalls: 0,
      registeredAgents: 0,
      available: false,
    };
  }
  let channels = [];
  let endpoints = [];
  try {
    channels = await listChannels();
  } catch (e) {
    console.error('[server-health] ARI channels:', e?.message);
  }
  try {
    endpoints = await listEndpoints();
  } catch (e) {
    console.error('[server-health] ARI endpoints:', e?.message);
  }
  const registered = endpoints.filter((e) => e.state === 'online' || e.state === 'Ringing').length;
  // Active "calls" = bridged legs; approximate as channels/2 for 2-legged calls
  const activeCalls = Math.floor(channels.length / 2);
  return {
    channels: channels.length,
    activeCalls,
    registeredAgents: registered,
    available: true,
  };
}

async function getCallStats() {
  let callsPerMinute = null;
  let failedLastHour = null;
  try {
    const oneMinAgo = new Date(Date.now() - 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const [r1, r2] = await Promise.all([
      queryOne('SELECT COUNT(*) AS n FROM call_records WHERE start_time >= ?', [oneMinAgo]),
      queryOne(
        "SELECT COUNT(*) AS n FROM call_records WHERE start_time >= ? AND LOWER(TRIM(status)) IN ('failed','abandoned','abondoned')",
        [oneHourAgo]
      ),
    ]);
    callsPerMinute = r1?.n ?? 0;
    failedLastHour = r2?.n ?? 0;
  } catch (e) {
    if (e?.code !== 'ER_NO_SUCH_TABLE') console.error('[server-health] call stats:', e?.message);
  }
  return { callsPerMinute, failedLastHour };
}

function getNetworkStats() {
  if (process.platform !== 'linux') return { inboundBps: null, outboundBps: null };
  try {
    const dev = fs.readFileSync('/proc/net/dev', 'utf8');
    const lines = dev.split('\n').slice(2);
    let rx = 0;
    let tx = 0;
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 10 && !parts[0].startsWith('lo:')) {
        rx += parseInt(parts[1], 10) || 0;
        tx += parseInt(parts[9], 10) || 0;
      }
    }
    const now = Date.now();
    let inboundBps = null;
    let outboundBps = null;
    if (lastNetworkSample) {
      const elapsed = (now - lastNetworkSample.time) / 1000;
      if (elapsed >= 0.5) {
        inboundBps = Math.max(0, Math.round((rx - lastNetworkSample.rx) / elapsed));
        outboundBps = Math.max(0, Math.round((tx - lastNetworkSample.tx) / elapsed));
      }
    }
    lastNetworkSample = { rx, tx, time: now };
    return { inboundBps, outboundBps };
  } catch {
    return { inboundBps: null, outboundBps: null };
  }
}

async function getServiceStatus() {
  const asterisk = isAriConfigured();
  let asteriskOk = false;
  if (asterisk) {
    try {
      const ch = await listChannels();
      asteriskOk = Array.isArray(ch);
    } catch {
      asteriskOk = false;
    }
  } else {
    asteriskOk = null; // not configured
  }

  let databaseOk = false;
  try {
    await queryOne('SELECT 1');
    databaseOk = true;
  } catch {
    databaseOk = false;
  }

  const redisOk = isRedisAvailable();

  return {
    asterisk: asterisk === false ? null : asteriskOk,
    database: databaseOk,
    redis: redisOk,
    apiServer: true,
  };
}

async function getRecordingStats() {
  let count = null;
  let diskUsedBytes = null;
  const basePath = (process.env.RECORDINGS_BASE_PATH || process.env.ASTERISK_RECORDING_PATH || '').trim();
  try {
    const r = await queryOne('SELECT COUNT(*) AS n FROM call_records WHERE recording_path IS NOT NULL AND recording_path != ""');
    count = r?.n ?? 0;
  } catch (e) {
    if (e?.code !== 'ER_NO_SUCH_TABLE') console.error('[server-health] recording count:', e?.message);
  }
  if (basePath) {
    try {
      const resolved = path.resolve(basePath);
      if (fs.existsSync(resolved)) {
        let total = 0;
        const walk = (dir) => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else total += fs.statSync(full).size;
          }
        };
        walk(resolved);
        diskUsedBytes = total;
      }
    } catch (e) {
      console.error('[server-health] recording disk:', e?.message);
    }
  }
  return {
    recordingCount: count,
    recordingDiskBytes: diskUsedBytes,
    recordingDiskGb: diskUsedBytes != null ? Math.round((diskUsedBytes / (1024 ** 3)) * 10) / 10 : null,
  };
}

function buildAlerts(metrics) {
  const alerts = [];
  if (metrics.cpu != null && metrics.cpu >= CPU_ALERT_PCT) {
    alerts.push({ id: 'cpu', message: `CPU usage exceeded ${metrics.cpu}%`, severity: 'warning' });
  }
  if (metrics.memory && metrics.memory.usagePct >= RAM_ALERT_PCT) {
    alerts.push({ id: 'ram', message: `RAM usage exceeded ${metrics.memory.usagePct}%`, severity: 'warning' });
  }
  if (metrics.disk && metrics.disk.usagePct >= DISK_ALERT_PCT) {
    alerts.push({ id: 'disk', message: `Disk usage at ${metrics.disk.usagePct}%`, severity: 'warning' });
  }
  if (metrics.disk && (100 - metrics.disk.usagePct) < DISK_FREE_ALERT_PCT) {
    alerts.push({ id: 'disk-low', message: 'Disk space below 10% free', severity: 'warning' });
  }
  const cores = metrics.cpuCores ?? 0;
  const load1 = metrics.load?.load1;
  if (cores > 0 && load1 != null && load1 > cores) {
    alerts.push({ id: 'load', message: `Load average (1m) ${load1.toFixed(2)} exceeds ${cores} cores`, severity: 'warning' });
  }
  return alerts;
}

/**
 * Collect all server health metrics. Call from GET /api/admin/server-health.
 * Uses Promise.allSettled so partial data is returned even if some collectors fail.
 */
export async function collectServerHealthMetrics() {
  let cpuPct = null;
  let memory = null;
  let load = null;
  let cpuCores = 0;
  let disk = null;
  try {
    cpuPct = getCpuUsage();
    memory = getMemory();
    load = getLoadAvg();
    cpuCores = getCpuCores();
    disk = getDiskUsage();
  } catch (e) {
    console.error('[server-health] system metrics:', e?.message);
  }

  const settled = await Promise.allSettled([
    getDbMetrics(),
    getAsteriskMetrics(),
    getCallStats(),
    getServiceStatus(),
    getRecordingStats(),
  ]);
  const dbMetrics = settled[0].status === 'fulfilled' ? settled[0].value : {};
  const asteriskMetrics = settled[1].status === 'fulfilled' ? settled[1].value : { channels: 0, activeCalls: 0, registeredAgents: 0, available: false };
  const callStats = settled[2].status === 'fulfilled' ? settled[2].value : {};
  const serviceStatus = settled[3].status === 'fulfilled' ? settled[3].value : {};
  const recordingStats = settled[4].status === 'fulfilled' ? settled[4].value : {};

  let network = { inboundBps: null, outboundBps: null };
  try {
    network = getNetworkStats();
  } catch (e) {
    console.error('[server-health] network:', e?.message);
  }

  const metrics = {
    cpu: cpuPct,
    memory,
    disk,
    load,
    cpuCores,
    db: dbMetrics,
    asterisk: asteriskMetrics,
    callStats,
    services: serviceStatus,
    recordings: recordingStats,
    network,
    activeConnections: (dbMetrics.activeConnections ?? 0) + (asteriskMetrics.channels ?? 0),
  };

  try {
    metrics.alerts = buildAlerts(metrics);
  } catch {
    metrics.alerts = [];
  }
  return metrics;
}

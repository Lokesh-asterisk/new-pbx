import { useState, useEffect, useCallback } from 'react';
import { apiGet } from '../../utils/api';
import './ServerHealthView.css';

const REFRESH_MS = 8000;  // 5–10 sec

function ProgressBar({ value, max = 100, label, unit, alertAbove }) {
  const pct =
    label !== undefined
      ? (typeof value === 'number' && typeof max === 'number' && max > 0 ? Math.min(100, (value / max) * 100) : 0)
      : (value != null && Number.isFinite(Number(value)) ? Math.min(100, Number(value)) : 0);
  const isAlert = alertAbove != null && pct >= alertAbove;
  const displayText =
    label !== undefined && label !== ''
      ? label
      : value != null && value !== ''
        ? `${value}${unit || ''}${max > 0 && unit !== '%' ? ` / ${max}${unit || ''}` : ''}`
        : '—';
  return (
    <div className="server-health-progress-wrap">
      <div className="server-health-progress-bar">
        <div
          className={`server-health-progress-fill ${isAlert ? 'alert' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="server-health-progress-label">{displayText}</span>
    </div>
  );
}

function ServiceStatus({ name, status }) {
  // status: true = running, false = down, null = not configured
  const className =
    status === true ? 'running' : status === false ? 'down' : 'n/a';
  const text = status === true ? 'Running' : status === false ? 'Down' : 'N/A';
  return (
    <div className={`server-health-service ${className}`}>
      <span className="server-health-service-dot" />
      <span>{name}: {text}</span>
    </div>
  );
}

function formatBytesPerSec(bps) {
  if (bps == null || !Number.isFinite(bps)) return '—';
  const mb = bps / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  const kb = bps / 1024;
  return `${kb.toFixed(1)} KB/s`;
}

export default function ServerHealthView() {
  const [metrics, setMetrics] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const fetchHealth = useCallback(async () => {
    try {
      setError('');
      const data = await apiGet('/api/admin/server-health');
      if (data.success && data.metrics) setMetrics(data.metrics);
      else setMetrics(null);
    } catch (e) {
      setError(e?.message || 'Failed to load server health');
      setMetrics(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    const t = setInterval(fetchHealth, REFRESH_MS);
    return () => clearInterval(t);
  }, [fetchHealth]);

  if (loading && !metrics) {
    return (
      <section className="dashboard-section server-health-section">
        <h2 className="superadmin-section-title">Server Health</h2>
        <p className="dashboard-loading">Loading metrics…</p>
      </section>
    );
  }

  if (error && !metrics) {
    return (
      <section className="dashboard-section server-health-section">
        <h2 className="superadmin-section-title">Server Health</h2>
        <p className="dashboard-error">{error}</p>
      </section>
    );
  }

  const m = metrics || {};
  const cpu = m.cpu;
  const mem = m.memory;
  const disk = m.disk;
  const load = m.load;
  const cpuCores = m.cpuCores ?? 0;
  const db = m.db || {};
  const asterisk = m.asterisk || {};
  const callStats = m.callStats || {};
  const services = m.services || {};
  const recordings = m.recordings || {};
  const alerts = m.alerts || [];
  const network = m.network || {};

  return (
    <section className="dashboard-section server-health-section">
      <h2 className="superadmin-section-title">Server Health</h2>
      {alerts.length > 0 && (
        <div className="server-health-alerts">
          {alerts.map((a) => (
            <div key={a.id} className="server-health-alert">
              ⚠ {a.message}
            </div>
          ))}
        </div>
      )}

      <div className="server-health-grid">
        <div className="server-health-card">
          <h3>CPU &amp; Memory</h3>
          <div className="server-health-metric">
            <span className="server-health-metric-label">CPU Usage</span>
            <ProgressBar value={cpu} max={100} unit="%" alertAbove={80} />
          </div>
          <div className="server-health-metric">
            <span className="server-health-metric-label">RAM</span>
            {mem ? (
              <ProgressBar
                value={mem.usagePct}
                max={100}
                label={`${mem.usedGb} GB / ${mem.totalGb} GB (${mem.usagePct}%)`}
                alertAbove={85}
              />
            ) : (
              <span>—</span>
            )}
          </div>
        </div>

        <div className="server-health-card">
          <h3>Disk &amp; Load</h3>
          <div className="server-health-metric">
            <span className="server-health-metric-label">Disk Usage</span>
            {disk ? (
              <ProgressBar
                value={disk.usagePct}
                max={100}
                label={`${disk.usedGb} GB / ${disk.totalGb} GB (${disk.usagePct}%)`}
                alertAbove={90}
              />
            ) : (
              <span>—</span>
            )}
          </div>
          <div className="server-health-metric">
            <span className="server-health-metric-label">Load Average</span>
            <div className="server-health-load">
              <span>1 min: {load?.load1 != null ? load.load1.toFixed(2) : '—'}</span>
              <span>5 min: {load?.load5 != null ? load.load5.toFixed(2) : '—'}</span>
              <span>15 min: {load?.load15 != null ? load.load15.toFixed(2) : '—'}</span>
              {cpuCores > 0 && (
                <span className="server-health-load-cores">(CPUs: {cpuCores})</span>
              )}
            </div>
          </div>
          <div className="server-health-metric">
            <span className="server-health-metric-label">Active Connections</span>
            <span className="server-health-value">{m.activeConnections ?? '—'}</span>
          </div>
        </div>
      </div>

      <div className="server-health-grid">
        <div className="server-health-card">
          <h3>Asterisk Status</h3>
          <div className="server-health-stats-row">
            <div className="server-health-stat">
              <span className="server-health-stat-value">{asterisk.activeCalls ?? '—'}</span>
              <span className="server-health-stat-label">Active Calls</span>
            </div>
            <div className="server-health-stat">
              <span className="server-health-stat-value">{asterisk.channels ?? '—'}</span>
              <span className="server-health-stat-label">Channels</span>
            </div>
            <div className="server-health-stat">
              <span className="server-health-stat-value">{asterisk.registeredAgents ?? '—'}</span>
              <span className="server-health-stat-label">Registered Agents</span>
            </div>
            <div className="server-health-stat">
              <span className="server-health-stat-value">{callStats.callsPerMinute ?? '—'}</span>
              <span className="server-health-stat-label">Calls/Min</span>
            </div>
            <div className="server-health-stat">
              <span className="server-health-stat-value">{callStats.failedLastHour ?? '—'}</span>
              <span className="server-health-stat-label">Failed (1h)</span>
            </div>
          </div>
          {!asterisk.available && (
            <p className="server-health-muted">ARI not configured</p>
          )}
        </div>

        <div className="server-health-card">
          <h3>Database</h3>
          <div className="server-health-metric">
            <span className="server-health-metric-label">Active DB Connections</span>
            <span className="server-health-value">{db.activeConnections ?? '—'}</span>
          </div>
          <div className="server-health-metric">
            <span className="server-health-metric-label">Slow Queries</span>
            <span className="server-health-value">{db.slowQueries ?? '—'}</span>
          </div>
          <div className="server-health-metric">
            <span className="server-health-metric-label">Query Time</span>
            <span className="server-health-value">
              {db.queryTimeMs != null ? `${db.queryTimeMs} ms` : '—'}
            </span>
          </div>
        </div>
      </div>

      <div className="server-health-grid">
        <div className="server-health-card">
          <h3>System Services</h3>
          <div className="server-health-services">
            <ServiceStatus name="Asterisk" status={services.asterisk} />
            <ServiceStatus name="Database" status={services.database} />
            <ServiceStatus name="Redis" status={services.redis} />
            <ServiceStatus name="API Server" status={services.apiServer} />
          </div>
        </div>

        <div className="server-health-card">
          <h3>Network</h3>
          <div className="server-health-metric">
            <span className="server-health-metric-label">Inbound</span>
            <span className="server-health-value">
              {formatBytesPerSec(network.inboundBps)}
            </span>
          </div>
          <div className="server-health-metric">
            <span className="server-health-metric-label">Outbound</span>
            <span className="server-health-value">
              {formatBytesPerSec(network.outboundBps)}
            </span>
          </div>
          <p className="server-health-muted">Linux only; other platforms show —</p>
        </div>

        <div className="server-health-card">
          <h3>Call Recordings</h3>
          <div className="server-health-metric">
            <span className="server-health-metric-label">Recording Count</span>
            <span className="server-health-value">{recordings.recordingCount ?? '—'}</span>
          </div>
          <div className="server-health-metric">
            <span className="server-health-metric-label">Disk Used</span>
            <span className="server-health-value">
              {recordings.recordingDiskGb != null ? `${recordings.recordingDiskGb} GB` : '—'}
            </span>
          </div>
        </div>
      </div>

      <p className="server-health-footer">Updates every {REFRESH_MS / 1000} seconds</p>
    </section>
  );
}

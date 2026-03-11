import { useState, useEffect, useRef, useMemo, memo } from 'react';
import { apiFetch } from '../../utils/api';
import { formatDurationVerbose } from '../../utils/format';

function getAgentStatusDisplay(status, breakName) {
  const s = (status || '').toUpperCase();
  if (s === 'RINGING') return { label: 'Ringing', cls: 'la-status-ringing' };
  if (s === 'ON CALL' || s === 'ONCALL') return { label: 'On Call', cls: 'la-status-oncall' };
  if (s === 'OUTBOUND') return { label: 'Outbound', cls: 'la-status-oncall' };
  if (s.includes('BREAK') || s === 'PAUSED' || (breakName != null && breakName !== ''))
    return { label: breakName ? `Break (${breakName})` : 'Break', cls: 'la-status-break' };
  if (s === 'LOGGEDIN' || s === 'SIP PHONE RINGING' || s === 'LOGININITIATED')
    return { label: 'Available', cls: 'la-status-available' };
  if (s === 'LOGGEDOUT' || s === 'LOGINFAILED')
    return { label: 'Logged Out', cls: 'la-status-loggedout' };
  if (s === 'DISABLED')
    return { label: 'Disabled', cls: 'la-status-loggedout' };
  return { label: status || 'Unknown', cls: 'la-status-unknown' };
}


const LiveAgentDuration = memo(function LiveAgentDuration({ sessionStartedAt }) {
  const [elapsed, setElapsed] = useState(() =>
    sessionStartedAt ? Date.now() - new Date(sessionStartedAt).getTime() : 0
  );
  const ref = useRef(null);
  useEffect(() => {
    if (!sessionStartedAt) { setElapsed(0); return; }
    const tick = () => setElapsed(Date.now() - new Date(sessionStartedAt).getTime());
    tick();
    ref.current = setInterval(tick, 1000);
    return () => clearInterval(ref.current);
  }, [sessionStartedAt]);
  return <span>{formatDurationVerbose(elapsed)}</span>;
});

const LiveBreakDuration = memo(function LiveBreakDuration({ breakStartedAt }) {
  const [elapsed, setElapsed] = useState(() =>
    breakStartedAt ? Date.now() - new Date(breakStartedAt).getTime() : 0
  );
  const ref = useRef(null);
  useEffect(() => {
    if (!breakStartedAt) { setElapsed(0); return; }
    const tick = () => setElapsed(Date.now() - new Date(breakStartedAt).getTime());
    tick();
    ref.current = setInterval(tick, 1000);
    return () => clearInterval(ref.current);
  }, [breakStartedAt]);
  return <span>{formatDurationVerbose(elapsed)}</span>;
});


const LiveAgentsView = memo(function LiveAgentsView({
  agents, stats, tenants, tenantId, onTenantChange,
  search, onSearchChange, statusFilter, onStatusFilterChange,
  supervisorExtension, onSupervisorExtensionChange, onMonitor,
  apiBase = '/api/superadmin',
  onRefresh,
}) {
  const [monitorLoading, setMonitorLoading] = useState(null);
  const [monitorError, setMonitorError] = useState('');
  const [forceLoading, setForceLoading] = useState(null);
  const [forceError, setForceError] = useState('');

  const filtered = useMemo(() => {
    let list = agents || [];
    if (statusFilter && statusFilter !== 'all') {
      list = list.filter((a) => {
        const s = (a.status || '').toUpperCase();
        switch (statusFilter) {
          case 'available':
            return s === 'LOGGEDIN' || s === 'SIP PHONE RINGING' || s === 'LOGININITIATED';
          case 'oncall':
            return s === 'ON CALL' || s === 'ONCALL' || s === 'RINGING' || s === 'OUTBOUND';
          case 'break':
            return s.includes('BREAK') || s === 'PAUSED' || (a.break_name != null && a.break_name !== '');
          case 'loggedout':
            return s === 'LOGGEDOUT' || s === 'LOGINFAILED' || s === 'DISABLED' || !s;
          default:
            return true;
        }
      });
    }
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (a) =>
          (a.name || '').toLowerCase().includes(q) ||
          (a.agent_id || '').toLowerCase().includes(q) ||
          (a.extension || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [agents, statusFilter, search]);

  const isOnCall = (a) => {
    const s = (a.status || '').toUpperCase();
    return s === 'ON CALL' || s === 'ONCALL' || s === 'RINGING' || s === 'OUTBOUND';
  };

  const isOnBreak = (a) => {
    const s = (a.status || '').toUpperCase();
    return s === 'PAUSED' || (s && s.includes('BREAK')) || (a.break_name != null && a.break_name !== '');
  };

  const isOnline = (a) => {
    const s = (a.status || '').toUpperCase();
    return s && !['LOGGEDOUT', 'LOGINFAILED', 'DISABLED', 'UNKNOWN'].includes(s);
  };

  const handleForceEndBreak = async (agentId) => {
    setForceError('');
    setForceLoading(agentId);
    try {
      const res = await apiFetch(`${apiBase}/live-agents/${encodeURIComponent(agentId)}/force-end-break`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed');
      if (onRefresh) onRefresh();
    } catch (e) {
      setForceError(e.message || 'Failed to end break');
    } finally {
      setForceLoading(null);
    }
  };

  const handleForceLogout = async (agentId) => {
    setForceError('');
    setForceLoading(agentId);
    try {
      const res = await apiFetch(`${apiBase}/live-agents/${encodeURIComponent(agentId)}/force-logout`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed');
      if (onRefresh) onRefresh();
    } catch (e) {
      setForceError(e.message || 'Force logout failed');
    } finally {
      setForceLoading(null);
    }
  };

  const handleMonitor = async (agentId, mode) => {
    if (!onMonitor) return;
    if (!(supervisorExtension || '').trim()) {
      setMonitorError('Supervisor extension required');
      return;
    }
    setMonitorError('');
    setMonitorLoading(agentId);
    try {
      await onMonitor(agentId, mode);
    } catch (e) {
      setMonitorError(e.message || 'Request failed');
    } finally {
      setMonitorLoading(null);
    }
  };

  return (
    <>
      <div className="la-header">
        <h2 className="superadmin-section-title">Agent Live Monitoring</h2>
        <span className="la-live-badge">
          <span className="la-live-dot" />
          Live
        </span>
      </div>

      <div className="la-filters">
        {tenants.length > 0 && (
          <label className="la-filter-label">
            Tenant
            <select
              className="superadmin-select la-select"
              value={tenantId}
              onChange={(e) => onTenantChange(e.target.value)}
            >
              <option value="all">All tenants</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>{t.name} ({t.id})</option>
              ))}
            </select>
          </label>
        )}
        <label className="la-filter-label">
          Status
          <select
            className="superadmin-select la-select"
            value={statusFilter}
            onChange={(e) => onStatusFilterChange(e.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="available">Available</option>
            <option value="oncall">On Call / Ringing</option>
            <option value="break">Break</option>
            <option value="loggedout">Logged Out</option>
          </select>
        </label>
        <label className="la-filter-label">
          Search
          <input
            type="text"
            className="la-search-input"
            placeholder="Agent name, ID or extension…"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </label>
        <label className="la-filter-label">
          Supervisor ext.
          <input
            type="text"
            className="la-search-input la-supervisor-ext"
            placeholder="e.g. 7002"
            value={supervisorExtension || ''}
            onChange={(e) => onSupervisorExtensionChange(e.target.value)}
            title="Your extension for Listen / Whisper / Barge"
          />
        </label>
      </div>
      {(monitorError || forceError) && (
        <div className="la-monitor-error">{monitorError || forceError}</div>
      )}

      {stats && (
        <div className="la-stats-grid">
          <div className="la-stat-card">
            <div className="la-stat-value">{stats.total}</div>
            <div className="la-stat-label">Total</div>
          </div>
          <div className="la-stat-card la-stat-online">
            <div className="la-stat-value">{stats.online}</div>
            <div className="la-stat-label">Online</div>
          </div>
          <div className="la-stat-card la-stat-available">
            <div className="la-stat-value">{stats.available}</div>
            <div className="la-stat-label">Available</div>
          </div>
          <div className="la-stat-card la-stat-oncall">
            <div className="la-stat-value">{stats.onCall}</div>
            <div className="la-stat-label">On Call</div>
          </div>
          <div className="la-stat-card la-stat-break">
            <div className="la-stat-value">{stats.onBreak}</div>
            <div className="la-stat-label">On Break</div>
          </div>
          <div className="la-stat-card la-stat-loggedout">
            <div className="la-stat-value">{stats.loggedOut}</div>
            <div className="la-stat-label">Logged Out</div>
          </div>
        </div>
      )}

      <div className="la-table-wrap">
        <table className="superadmin-table la-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Extension</th>
              <th>Status</th>
              <th>Queue</th>
              <th>Customer</th>
              <th>DID/TFN</th>
              <th>Calls</th>
              <th>Login Duration</th>
              <th>On break for</th>
              <th>Tenant</th>
              <th>Last Updated</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={12} className="la-empty">No agents found.</td>
              </tr>
            ) : (
              filtered.map((a) => {
                const disp = getAgentStatusDisplay(a.status, a.break_name);
                const onCall = isOnCall(a);
                const loading = monitorLoading === a.agent_id;
                return (
                  <tr key={a.agent_id} className={disp.cls.includes('loggedout') ? 'la-row-dimmed' : ''}>
                    <td>
                      <span className="la-agent-name">{a.name}</span>
                      <span className="la-agent-ext">{a.extension || a.agent_id || '—'}</span>
                    </td>
                    <td>{a.extension || '—'}</td>
                    <td>
                      <span className={`la-status-badge ${disp.cls}`}>
                        <span className="la-status-dot" />
                        {disp.label}
                      </span>
                    </td>
                    <td>{a.queue_name || '—'}</td>
                    <td>{a.customer_number || '—'}</td>
                    <td>{onCall ? (a.call_did || '—') : '—'}</td>
                    <td>{a.calls_taken}</td>
                    <td>
                      {a.session_started_at ? (
                        <LiveAgentDuration sessionStartedAt={a.session_started_at} />
                      ) : '—'}
                    </td>
                    <td>
                      {a.break_started_at ? (
                        <LiveBreakDuration breakStartedAt={a.break_started_at} />
                      ) : '—'}
                    </td>
                    <td>{a.tenant_name || a.tenant_id || '—'}</td>
                    <td className="la-timestamp">
                      {a.timestamp
                        ? new Date(a.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                        : '—'}
                    </td>
                    <td className="la-actions">
                      {onCall ? (
                        <>
                          <span className="la-monitor-btns">
                            <button
                              type="button"
                              className="la-btn la-btn-listen"
                              disabled={loading}
                              onClick={() => handleMonitor(a.agent_id, 'listen')}
                              title="Listen only (you hear call, no one hears you)"
                            >
                              {loading ? '…' : 'Listen'}
                            </button>
                            <button
                              type="button"
                              className="la-btn la-btn-whisper"
                              disabled={loading}
                              onClick={() => handleMonitor(a.agent_id, 'whisper')}
                              title="Whisper to agent only"
                            >
                              {loading ? '…' : 'Whisper'}
                            </button>
                            <button
                              type="button"
                              className="la-btn la-btn-barge"
                              disabled={loading}
                              onClick={() => handleMonitor(a.agent_id, 'barge')}
                              title="Join call (everyone hears everyone)"
                            >
                              {loading ? '…' : 'Barge'}
                            </button>
                          </span>
                          {isOnline(a) && (
                            <>
                              <span className="la-actions-sep" aria-hidden="true" />
                              <span className="la-force-btns">
                                <button
                                  type="button"
                                  className="la-btn la-btn-force-logout"
                                  disabled={forceLoading === a.agent_id}
                                  onClick={() => handleForceLogout(a.agent_id)}
                                  title="Force logout: hang up channels, clear session, agent can re-login"
                                >
                                  {forceLoading === a.agent_id ? '…' : 'Force logout'}
                                </button>
                              </span>
                            </>
                          )}
                        </>
                      ) : (
                        <span className="la-force-btns">
                          {isOnBreak(a) && (
                            <button
                              type="button"
                              className="la-btn la-btn-end-break"
                              disabled={forceLoading === a.agent_id}
                              onClick={() => handleForceEndBreak(a.agent_id)}
                              title="Set agent to Available (clear break)"
                            >
                              {forceLoading === a.agent_id ? '…' : 'End break'}
                            </button>
                          )}
                          {isOnline(a) && (
                            <button
                              type="button"
                              className="la-btn la-btn-force-logout"
                              disabled={forceLoading === a.agent_id}
                              onClick={() => handleForceLogout(a.agent_id)}
                              title="Force logout: hang up Asterisk channels, clear session, ready for re-login"
                            >
                              {forceLoading === a.agent_id ? '…' : 'Force logout'}
                            </button>
                          )}
                          {!isOnline(a) && !isOnBreak(a) && '—'}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
});

export default LiveAgentsView;

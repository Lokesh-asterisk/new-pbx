import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';
import './Dashboard.css';
import './Wallboard.css';

const API_BASE = import.meta.env.DEV ? '' : (import.meta.env.VITE_API_URL || '');


function api(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
}

const STATUS_COLORS = {
  READY: '#22c55e',
  RINGING: '#f59e0b',
  IN_CALL: '#ef4444',
  OUTBOUND: '#8b5cf6',
  TRANSFERRING: '#8b5cf6',
  AFTER_CALL_WORK: '#3b82f6',
  PAUSED: '#eab308',
  OFFLINE: '#64748b',
  LOGGED_OUT: '#64748b',
};

const STATUS_LABELS = {
  READY: 'Ready',
  RINGING: 'Ringing',
  IN_CALL: 'On Call',
  OUTBOUND: 'Outbound',
  TRANSFERRING: 'Transferring',
  AFTER_CALL_WORK: 'After Call',
  PAUSED: 'Paused',
  OFFLINE: 'Offline',
  LOGGED_OUT: 'Logged Out',
};

function formatDurationSec(totalSec) {
  if (!totalSec || totalSec <= 0) return '0:00';
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatAht(sec) {
  if (!sec || sec <= 0) return '-';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function WallboardBreakDuration({ breakStartedAt }) {
  const [elapsed, setElapsed] = useState(() =>
    breakStartedAt ? Math.max(0, Math.floor((Date.now() - new Date(breakStartedAt).getTime()) / 1000)) : 0
  );
  useEffect(() => {
    if (!breakStartedAt) { setElapsed(0); return; }
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - new Date(breakStartedAt).getTime()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [breakStartedAt]);
  return <span className="wb-mono">{formatDurationSec(elapsed)}</span>;
}

export default function Wallboard() {
  const [tenantId, setTenantId] = useState(() => {
    try {
      const u = JSON.parse(sessionStorage.getItem('pbx_user') || '{}');
      const tid = u?.parent_id != null ? String(u.parent_id) : (u?.tenant_id != null ? String(u.tenant_id) : '');
      return tid || '';
    } catch { return ''; }
  });
  const [data, setData] = useState(null);
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tickOffset, setTickOffset] = useState(0);
  const [sseConnected, setSseConnected] = useState(false);
  const [supervisorExt, setSupervisorExt] = useState(() => {
    try { return localStorage.getItem('wallboard_supervisor_ext') || ''; } catch { return ''; }
  });
  const [monitorLoading, setMonitorLoading] = useState(null);
  const [monitorError, setMonitorError] = useState('');
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [agentDetail, setAgentDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reportDate, setReportDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reportData, setReportData] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('live');
  const [agentSearch, setAgentSearch] = useState('');
  const [agentStatusFilter, setAgentStatusFilter] = useState('all');
  const [forceLoading, setForceLoading] = useState(null);
  const [forceError, setForceError] = useState('');
  const { user } = useAuth();
  const role = user?.role || '';
  const assignedTenantId = (user?.parent_id != null ? String(user.parent_id) : (user?.tenant_id != null ? String(user.tenant_id) : '')) || '';
  const isAdminOrSuperadmin = role === 'admin' || role === 'superadmin' || role === 1 || role === 2;
  const sseRef = useRef(null);
  const lastFetchRef = useRef(0);
  const loadAttemptedRef = useRef(false);



  const loadTenants = useCallback(async () => {
    if (assignedTenantId) {
      setTenants([]);
      setTenantId(assignedTenantId);
      return;
    }
    try {
      const res = await api('/api/wallboard/tenants');
      const out = await res.json().catch(() => ({}));
      if (res.ok && out.success && Array.isArray(out.tenants)) {
        const list = out.tenants || [];
        setTenants(list);
        if (list.length > 0) setTenantId((prev) => prev || String(list[0].id));
      }
    } catch {
      setTenants([]);
    }
  }, [assignedTenantId]);

  const loadSummary = useCallback(async () => {
    setError('');
    const url = tenantId ? `/api/wallboard/summary?tenant_id=${tenantId}` : '/api/wallboard/summary';
    try {
      const res = await api(url);
      const out = await res.json().catch(() => ({}));
      loadAttemptedRef.current = true;
      if (!res.ok) {
        const msg = res.status === 401 ? 'Session expired. Please log in again.' : res.status === 403 ? (out.error || 'Access denied.') : (out.error || 'Failed to load wallboard');
        setError(msg);
        setData(null);
        return;
      }
      if (out.success) {
        const payload = {
          stats: out.stats || {},
          agents: out.agents || [],
          queues: out.queues || [],
          activeCalls: out.activeCalls || [],
          tenant_id: out.tenant_id,
        };
        setData(payload);
        setTickOffset(0);
        lastFetchRef.current = Date.now();
      } else {
        setData(null);
      }
    } catch (e) {
      loadAttemptedRef.current = true;
      setError(e.message || 'Failed to load wallboard. Check the server is running.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  // SSE connection for real-time updates
  useEffect(() => {
    const tid = tenantId || '';
    const url = `${API_BASE}/api/wallboard/events${tid ? `?tenant_id=${tid}` : ''}`;
    let es;
    try {
      es = new EventSource(url, { withCredentials: true });
      sseRef.current = es;
      es.onopen = () => setSseConnected(true);
      es.onmessage = (e) => {
        try {
          const evt = JSON.parse(e.data);
          if (evt.type === 'agent_status') {
            setData((prev) => {
              if (!prev) return prev;
              const p = evt.payload;
              const agents = prev.agents.map((a) => {
                if (a.agent_id !== p.agent_id) return a;
                const merged = { ...a, ...p };
                const st = (merged.status || '').toUpperCase();
                if (st === 'LOGGEDIN' || st === 'LOGININITIATED') {
                  merged.break_name = merged.break_name ?? null;
                  merged.break_started_at = merged.break_started_at ?? null;
                  merged.normalized_status = 'READY';
                } else if (st === 'PAUSED' || (st && st.includes('BREAK'))) {
                  merged.normalized_status = 'PAUSED';
                }
                return merged;
              });
              return { ...prev, agents };
            });
            // Refresh summary so total_break_session_sec and other server-derived fields stay correct
            loadSummary();
          } else if (evt.type === 'queue_activity' || evt.type === 'full_snapshot') {
            loadSummary();
          }
        } catch {}
      };
      es.onerror = () => {
        setSseConnected(false);
      };
    } catch {
      setSseConnected(false);
    }
    return () => {
      if (es) { es.close(); sseRef.current = null; setSseConnected(false); }
    };
  }, [tenantId, loadSummary]);

  useEffect(() => { loadSummary(); }, [loadSummary]);

  // 2-second poll interval for metrics refresh
  useEffect(() => {
    const t = setInterval(loadSummary, 2000);
    return () => clearInterval(t);
  }, [loadSummary]);

  useEffect(() => { loadTenants(); }, [loadTenants]);

  useEffect(() => {
    if (assignedTenantId) setTenantId(assignedTenantId);
  }, [assignedTenantId]);

  // Prevent indefinite loading: after 12s with no data, show UI with error
  useEffect(() => {
    if (!loading || data) return;
    const t = setTimeout(() => {
      setLoading((prev) => {
        if (prev) loadAttemptedRef.current = true;
        return false;
      });
      setError((e) => (e ? e : 'Loading is taking longer than expected. Check your connection.'));
    }, 12000);
    return () => clearTimeout(t);
  }, [loading, data]);

  // 1-second tick for live call duration timers
  useEffect(() => {
    const t = setInterval(() => setTickOffset((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const handleSupervisorExtChange = (val) => {
    setSupervisorExt(val);
    try { localStorage.setItem('wallboard_supervisor_ext', val); } catch {}
  };

  const handleMonitor = async (agentId, mode) => {
    if (!supervisorExt.trim()) {
      setMonitorError('Enter your supervisor extension first');
      return;
    }
    setMonitorError('');
    setMonitorLoading(`${agentId}-${mode}`);
    try {
      const res = await api('/api/wallboard/monitor', {
        method: 'POST',
        body: JSON.stringify({ agent_id: agentId, mode, supervisor_extension: supervisorExt.trim() }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || 'Request failed');
    } catch (e) {
      setMonitorError(e.message || 'Request failed');
    } finally {
      setMonitorLoading(null);
    }
  };

  const handleAgentClick = async (agent) => {
    if (selectedAgent?.agent_id === agent.agent_id) {
      setSelectedAgent(null);
      setAgentDetail(null);
      return;
    }
    setSelectedAgent(agent);
    setDetailLoading(true);
    try {
      const url = tenantId
        ? `/api/wallboard/agents/${encodeURIComponent(agent.agent_id)}/detail?tenant_id=${tenantId}`
        : `/api/wallboard/agents/${encodeURIComponent(agent.agent_id)}/detail`;
      const res = await api(url);
      const out = await res.json().catch(() => ({}));
      if (res.ok && out.success) {
        setAgentDetail(out);
      } else {
        setAgentDetail(null);
      }
    } catch {
      setAgentDetail(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const loadReport = useCallback(async () => {
    setReportLoading(true);
    try {
      const url = tenantId
        ? `/api/wallboard/report?tenant_id=${tenantId}&date=${reportDate}`
        : `/api/wallboard/report?date=${reportDate}`;
      const res = await api(url);
      const out = await res.json().catch(() => ({}));
      if (res.ok && out.success) setReportData(out);
      else setReportData(null);
    } catch { setReportData(null); }
    finally { setReportLoading(false); }
  }, [tenantId, reportDate]);

  useEffect(() => { if (activeTab === 'report') loadReport(); }, [activeTab, loadReport]);

  const handleForceEndBreak = useCallback(async (agentId) => {
    setForceError('');
    setForceLoading(agentId);
    try {
      const url = tenantId
        ? `${API_BASE}/api/wallboard/agents/${encodeURIComponent(agentId)}/force-end-break?tenant_id=${tenantId}`
        : `${API_BASE}/api/wallboard/agents/${encodeURIComponent(agentId)}/force-end-break`;
      const res = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || 'Failed');
      loadSummary();
    } catch (e) {
      setForceError(e.message || 'Failed to end break');
    } finally {
      setForceLoading(null);
    }
  }, [tenantId, loadSummary]);

  const handleForceLogout = useCallback(async (agentId) => {
    setForceError('');
    setForceLoading(agentId);
    try {
      const url = tenantId
        ? `${API_BASE}/api/wallboard/agents/${encodeURIComponent(agentId)}/force-logout?tenant_id=${tenantId}`
        : `${API_BASE}/api/wallboard/agents/${encodeURIComponent(agentId)}/force-logout`;
      const res = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || 'Failed');
      loadSummary();
    } catch (e) {
      setForceError(e.message || 'Force logout failed');
    } finally {
      setForceLoading(null);
    }
  }, [tenantId, loadSummary]);

  const canSelectTenant = (role === 'superadmin' || role === 'admin') && !assignedTenantId;

  const stats = data?.stats || {};
  const agents = data?.agents || [];
  const queues = data?.queues || [];
  const noData = data == null;
  const showLoadingOnly = loading && !data && !loadAttemptedRef.current;

  const filteredAgents = useMemo(() => {
    let list = agents;
    if (agentStatusFilter && agentStatusFilter !== 'all') {
      list = list.filter((a) => {
        const ns = a.normalized_status || 'OFFLINE';
        switch (agentStatusFilter) {
          case 'available':
            return ns === 'READY';
          case 'oncall':
            return ns === 'IN_CALL' || ns === 'RINGING';
          case 'break':
            return ns === 'PAUSED';
          case 'loggedout':
            return ns === 'LOGGED_OUT' || ns === 'OFFLINE';
          default:
            return true;
        }
      });
    }
    if (agentSearch && agentSearch.trim()) {
      const q = agentSearch.trim().toLowerCase();
      list = list.filter(
        (a) =>
          (a.name || '').toLowerCase().includes(q) ||
          (a.agent_id || '').toString().toLowerCase().includes(q) ||
          (a.extension || '').toString().toLowerCase().includes(q)
      );
    }
    return list;
  }, [agents, agentStatusFilter, agentSearch]);

  if (showLoadingOnly) {
    return (
      <Layout title="Wallboard" subtitle="Live team & queue overview">
        <div className="wallboard"><p className="wallboard-loading">Loading...</p></div>
      </Layout>
    );
  }

  const loginDurationSec = (agent) => {
    const ns = agent.normalized_status;
    if (ns === 'LOGGED_OUT' || ns === 'OFFLINE') return null;
    const t = agent.session_started_at;
    if (!t) return null;
    const startMs = new Date(t).getTime();
    return Math.max(0, Math.floor((lastFetchRef.current - startMs) / 1000) + tickOffset);
  };

  const liveCallDuration = (agent) => {
    const ns = agent.normalized_status;
    if (ns !== 'IN_CALL' && ns !== 'RINGING') return null;
    const t = agent.call_answer_time || agent.call_start_time;
    if (!t) return null;
    const startMs = new Date(t).getTime();
    const elapsed = Math.max(0, Math.floor((lastFetchRef.current - startMs) / 1000) + tickOffset);
    return elapsed;
  };

  return (
    <Layout title="Wallboard" subtitle="Live team & queue overview">
      <div className="wallboard">
        {error && <p className="wallboard-error">{error}</p>}
        {noData && !error && (
          <p className="wallboard-error">No wallboard data. Select a tenant above or ensure your account has a tenant assigned.</p>
        )}

        {/* Toolbar: tenant selector + supervisor extension */}
        <div className="wb-toolbar">
          {canSelectTenant && tenants.length > 0 && (
            <div className="wallboard-tenants">
              <label htmlFor="wb-tenant">Tenant</label>
              <select id="wb-tenant" value={tenantId} onChange={(e) => setTenantId(e.target.value)} className="wallboard-tenant-select">
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.id})</option>)}
              </select>
            </div>
          )}
          <div className="wb-supervisor-ext">
            <label htmlFor="wb-sup-ext">Your Extension</label>
            <input id="wb-sup-ext" type="text" placeholder="e.g. 7001" value={supervisorExt}
              onChange={(e) => handleSupervisorExtChange(e.target.value)} className="wb-sup-ext-input" />
          </div>
          <div className="wb-tabs">
            <button className={`wb-tab ${activeTab === 'live' ? 'wb-tab-active' : ''}`} onClick={() => setActiveTab('live')}>Live Monitoring</button>
            <button className={`wb-tab ${activeTab === 'report' ? 'wb-tab-active' : ''}`} onClick={() => setActiveTab('report')}>Daily Report</button>
            <a href="/reports" className="wb-tab" style={{ textDecoration: 'none' }}>Agent Reports</a>
          </div>
          <div className="wb-connection-indicator" title={sseConnected ? 'Real-time connected' : 'Polling mode'}>
            <span className={`wb-conn-dot ${sseConnected ? 'wb-conn-on' : 'wb-conn-off'}`} />
          </div>
        </div>

        {activeTab === 'live' && (
          <>
            {noData ? (
              <section className="wb-section">
                <p className="wb-empty">No data to display. Fix any error above, select a tenant, or refresh the page.</p>
              </section>
            ) : (
            <>
            {/* Global metrics strip */}
            <section className="wb-global-metrics">
              <div className="wb-metric wb-metric-warning">
                <span className="wb-metric-value">{stats.calls_waiting ?? 0}</span>
                <span className="wb-metric-label">Calls Waiting</span>
              </div>
              <div className="wb-metric wb-metric-success">
                <span className="wb-metric-value">{stats.calls_answered_today ?? 0}</span>
                <span className="wb-metric-label">Answered Today</span>
              </div>
              <div className="wb-metric wb-metric-danger">
                <span className="wb-metric-value">{stats.abandoned_calls_today ?? 0}</span>
                <span className="wb-metric-label">Abandoned</span>
              </div>
              <div className="wb-metric wb-metric-transfer">
                <span className="wb-metric-value">{stats.transferred_calls_today ?? 0}</span>
                <span className="wb-metric-label">Transferred</span>
              </div>
              <div className="wb-metric">
                <span className="wb-metric-value">{stats.average_wait_time ?? 0}s</span>
                <span className="wb-metric-label">Avg Wait</span>
              </div>
              <div className="wb-metric wb-metric-warning">
                <span className="wb-metric-value">{formatDurationSec(stats.longest_waiting_sec ?? 0)}</span>
                <span className="wb-metric-label">Longest Wait</span>
              </div>
              <div className="wb-metric wb-metric-info">
                <span className="wb-metric-value">{stats.service_level ?? 0}%</span>
                <span className="wb-metric-label">Service Level</span>
              </div>
              <div className="wb-metric wb-metric-info">
                <span className="wb-metric-value">{stats.active_calls ?? 0}</span>
                <span className="wb-metric-label">Active (Total)</span>
              </div>
              <div className="wb-metric wb-metric-info">
                <span className="wb-metric-value">{stats.active_calls_inbound ?? 0}</span>
                <span className="wb-metric-label">Active (Inbound)</span>
              </div>
              <div className="wb-metric wb-metric-info">
                <span className="wb-metric-value">{stats.active_calls_outbound ?? 0}</span>
                <span className="wb-metric-label">Active (Outbound)</span>
              </div>
              <div className="wb-metric wb-metric-online">
                <span className="wb-metric-value">{stats.online ?? 0}</span>
                <span className="wb-metric-label">Agents Online</span>
              </div>
              <div className="wb-metric wb-metric-success">
                <span className="wb-metric-value">{stats.available ?? 0}</span>
                <span className="wb-metric-label">Available</span>
              </div>
              <div className="wb-metric wb-metric-danger">
                <span className="wb-metric-value">{stats.on_call ?? 0}</span>
                <span className="wb-metric-label">Busy</span>
              </div>
              <div className="wb-metric wb-metric-paused">
                <span className="wb-metric-value">{stats.break ?? 0}</span>
                <span className="wb-metric-label">Paused</span>
              </div>
              <div className="wb-metric">
                <span className="wb-metric-value">{formatAht(stats.average_aht ?? 0)}</span>
                <span className="wb-metric-label">Avg AHT</span>
              </div>
              <div className="wb-metric">
                <span className="wb-metric-value">{stats.average_occupancy != null ? `${Math.round((stats.average_occupancy ?? 0) * 100)}%` : '-'}</span>
                <span className="wb-metric-label">Avg Occupancy</span>
              </div>
            </section>

            {(monitorError || forceError) && (
              <p className="wb-monitor-error">{monitorError || forceError}</p>
            )}

            {/* Agent live monitoring: filters + table */}
            <section className="wb-section">
              <h2>Agent Live Monitoring</h2>
              <div className="wb-filters">
                <label className="wb-filter-label">
                  Search
                  <input
                    type="text"
                    className="wb-filter-input"
                    placeholder="Name, ID or extension…"
                    value={agentSearch}
                    onChange={(e) => setAgentSearch(e.target.value)}
                  />
                </label>
                <label className="wb-filter-label">
                  Status
                  <select
                    className="wb-filter-select"
                    value={agentStatusFilter}
                    onChange={(e) => setAgentStatusFilter(e.target.value)}
                  >
                    <option value="all">All statuses</option>
                    <option value="available">Available</option>
                    <option value="oncall">On Call / Ringing</option>
                    <option value="break">Break</option>
                    <option value="loggedout">Logged Out</option>
                  </select>
                </label>
              </div>
              <div className="wb-agent-table-wrap">
                <table className="wb-agent-table wb-live-table">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>Queue</th>
                      <th>Status</th>
                      <th>Customer</th>
                      <th>DID/TFN</th>
                      <th>Duration</th>
                      <th>Login Duration</th>
                      <th>On break for</th>
                      <th>Last Updated</th>
                      <th>Calls</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAgents.length === 0 ? (
                      <tr><td colSpan={11} className="wb-empty">{agents.length === 0 ? 'No agents in this tenant.' : 'No agents match filters.'}</td></tr>
                    ) : filteredAgents.map((a) => {
                      const ns = a.normalized_status || 'OFFLINE';
                      const color = STATUS_COLORS[ns] || STATUS_COLORS.OFFLINE;
                      const label = ns === 'PAUSED' ? (a.break_name ? `Break (${a.break_name})` : 'Break') : (STATUS_LABELS[ns] || ns);
                      const dur = liveCallDuration(a);
                      const loginDur = loginDurationSec(a);
                      const isOnCall = ns === 'IN_CALL' || ns === 'RINGING';
                      const isOnBreak = ns === 'PAUSED';
                      const isOnline = ns !== 'LOGGED_OUT' && ns !== 'OFFLINE';
                      const isSelected = selectedAgent?.agent_id === a.agent_id;
                      const forceLoadingThis = forceLoading === a.agent_id;
                      return (
                        <tr key={a.agent_id} className={`wb-agent-row ${isSelected ? 'wb-agent-selected' : ''}`}
                          onClick={() => handleAgentClick(a)}>
                          <td className="wb-agent-name">
                            <span className="wb-agent-name-line">{a.name || '-'}</span>
                            <span className="wb-agent-ext-line">{a.extension || a.agent_id || '-'}</span>
                          </td>
                          <td>{a.queue_name || '-'}</td>
                          <td>
                            <span className="wb-status-badge" style={{ borderColor: color, color }}>
                              <span className="wb-status-dot" style={{ background: color }} />
                              {label}
                            </span>
                          </td>
                          <td>{isOnCall ? (a.customer_number || '-') : '-'}</td>
                          <td>{isOnCall ? (a.did_tfn || '-') : '-'}</td>
                          <td className="wb-mono">{dur != null ? formatDurationSec(dur) : '-'}</td>
                          <td className="wb-mono">{loginDur != null ? formatDurationSec(loginDur) : '-'}</td>
                          <td className="wb-mono">
                            {a.break_started_at ? <WallboardBreakDuration breakStartedAt={a.break_started_at} /> : '-'}
                          </td>
                          <td className="wb-mono wb-last-updated">
                            {a.timestamp ? new Date(a.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-'}
                          </td>
                          <td className="wb-mono">{a.calls_handled || 0}</td>
                          <td className="wb-actions" onClick={(e) => e.stopPropagation()}>
                            {isOnCall && (
                              <>
                                <span className="wb-monitor-btns">
                                  <button className="wb-btn wb-btn-listen" disabled={monitorLoading === `${a.agent_id}-listen`}
                                    onClick={() => handleMonitor(a.agent_id, 'listen')}>
                                    {monitorLoading === `${a.agent_id}-listen` ? '...' : 'Listen'}
                                  </button>
                                  <button className="wb-btn wb-btn-whisper" disabled={monitorLoading === `${a.agent_id}-whisper`}
                                    onClick={() => handleMonitor(a.agent_id, 'whisper')}>
                                    {monitorLoading === `${a.agent_id}-whisper` ? '...' : 'Whisper'}
                                  </button>
                                  <button className="wb-btn wb-btn-barge" disabled={monitorLoading === `${a.agent_id}-barge`}
                                    onClick={() => handleMonitor(a.agent_id, 'barge')}>
                                    {monitorLoading === `${a.agent_id}-barge` ? '...' : 'Barge'}
                                  </button>
                                </span>
                                {isAdminOrSuperadmin && isOnline && (
                                  <>
                                    <span className="wb-actions-sep" aria-hidden="true" />
                                    <span className="wb-force-btns">
                                      <button
                                        type="button"
                                        className="wb-btn wb-btn-force-logout"
                                        disabled={forceLoadingThis}
                                        onClick={() => handleForceLogout(a.agent_id)}
                                        title="Force logout agent"
                                      >
                                        {forceLoadingThis ? '...' : 'Force logout'}
                                      </button>
                                    </span>
                                  </>
                                )}
                              </>
                            )}
                            {isAdminOrSuperadmin && !isOnCall && (
                              <>
                                {isOnBreak && (
                                  <button
                                    type="button"
                                    className="wb-btn wb-btn-end-break"
                                    disabled={forceLoadingThis}
                                    onClick={() => handleForceEndBreak(a.agent_id)}
                                    title="Set agent to Available"
                                  >
                                    {forceLoadingThis ? '...' : 'End break'}
                                  </button>
                                )}
                                {isOnline && (
                                  <button
                                    type="button"
                                    className="wb-btn wb-btn-force-logout"
                                    disabled={forceLoadingThis}
                                    onClick={() => handleForceLogout(a.agent_id)}
                                    title="Force logout agent"
                                  >
                                    {forceLoadingThis ? '...' : 'Force logout'}
                                  </button>
                                )}
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Agent detail panel */}
            {selectedAgent && (
              <section className="wb-section wb-detail-panel">
                <div className="wb-detail-header">
                  <h2>Agent Detail: {selectedAgent.name} ({selectedAgent.extension || selectedAgent.agent_id})</h2>
                  <button className="wb-close-btn" onClick={() => { setSelectedAgent(null); setAgentDetail(null); }}>Close</button>
                </div>
                {detailLoading ? (
                  <p className="wb-loading-small">Loading...</p>
                ) : agentDetail ? (
                  <div className="wb-detail-content">
                    <div className="wb-detail-stats">
                      <div className="wb-detail-stat"><span className="wb-detail-stat-label">Calls Handled</span><span className="wb-detail-stat-value">{agentDetail.callsHandled}</span></div>
                      <div className="wb-detail-stat"><span className="wb-detail-stat-label">Calls Missed</span><span className="wb-detail-stat-value">{agentDetail.callsMissed}</span></div>
                      <div className="wb-detail-stat"><span className="wb-detail-stat-label">Avg Talk Time</span><span className="wb-detail-stat-value">{formatDurationSec(agentDetail.avgTalkTime)}</span></div>
                      <div className="wb-detail-stat"><span className="wb-detail-stat-label">Total Talk</span><span className="wb-detail-stat-value">{formatDurationSec(agentDetail.totalTalkTime)}</span></div>
                      <div className="wb-detail-stat"><span className="wb-detail-stat-label">Wrap Time</span><span className="wb-detail-stat-value">{formatDurationSec(agentDetail.totalWrapTime)}</span></div>
                      <div className="wb-detail-stat"><span className="wb-detail-stat-label">Total Pause</span><span className="wb-detail-stat-value">{formatDurationSec(agentDetail.totalPauseTime)}</span></div>
                      <div className="wb-detail-stat"><span className="wb-detail-stat-label">AHT</span><span className="wb-detail-stat-value">{formatAht(agentDetail.aht)}</span></div>
                      <div className="wb-detail-stat"><span className="wb-detail-stat-label">Occupancy</span><span className="wb-detail-stat-value">{agentDetail.occupancy != null ? `${Math.round((agentDetail.occupancy ?? 0) * 100)}%` : '-'}</span></div>
                    </div>

                    {agentDetail.loginHistory?.length > 0 && (
                      <div className="wb-detail-block">
                        <h3>Login History</h3>
                        {agentDetail.loginHistory.map((l, i) => (
                          <div key={i} className="wb-detail-row">
                            <span>Login: {l.login ? new Date(l.login).toLocaleTimeString() : '-'}</span>
                            <span>Logout: {l.logout ? new Date(l.logout).toLocaleTimeString() : '-'}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {agentDetail.pauseHistory?.length > 0 && (
                      <div className="wb-detail-block">
                        <h3>Pause History</h3>
                        <table className="wb-mini-table">
                          <thead><tr><th>Time</th><th>Reason</th><th>Duration</th></tr></thead>
                          <tbody>
                            {agentDetail.pauseHistory.map((p, i) => (
                              <tr key={i}>
                                <td>{p.start_time ? new Date(p.start_time).toLocaleTimeString() : '-'}</td>
                                <td>{p.break_name || 'Break'}</td>
                                <td>{formatDurationSec(p.duration_sec)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {agentDetail.todaysCalls?.length > 0 && (
                      <div className="wb-detail-block">
                        <h3>Today's Calls ({agentDetail.todaysCalls.length})</h3>
                        <table className="wb-mini-table">
                          <thead><tr><th>Time</th><th>Dir</th><th>From/To</th><th>DID/TFN</th><th>Queue</th><th>Talk</th><th>Status</th></tr></thead>
                          <tbody>
                            {agentDetail.todaysCalls.slice(0, 50).map((c, i) => (
                              <tr key={i}>
                                <td>{c.start_time ? new Date(c.start_time).toLocaleTimeString() : '-'}</td>
                                <td>{c.direction === 'inbound' ? 'IN' : 'OUT'}</td>
                                <td>{c.direction === 'inbound' ? c.source_number : c.destination_number}</td>
                                <td>{c.did_tfn || '-'}</td>
                                <td>{c.queue_name || '-'}</td>
                                <td>{formatDurationSec(c.talk_sec || 0)}</td>
                                <td>{c.status}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="wb-empty">No detail available.</p>
                )}
              </section>
            )}

            {/* Top agents leaderboard */}
            {data?.leaderboard?.length > 0 && (
              <section className="wb-section wb-leaderboard">
                <h2>Top Agents Today</h2>
                <div className="wb-leaderboard-list">
                  {data.leaderboard.map((a, i) => (
                    <div key={a.agent_id || i} className="wb-leaderboard-item">
                      <span className="wb-leaderboard-rank">{i + 1}</span>
                      <span className="wb-leaderboard-name">{a.name || a.agent_id}</span>
                      <span className="wb-leaderboard-calls">{a.calls_handled} calls</span>
                      <span className="wb-leaderboard-aht">{formatAht(a.aht)} AHT</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Queue Performance */}
            <section className="wb-section">
              <h2>Queue Performance</h2>
              <div className="wb-agent-table-wrap">
                <table className="wb-agent-table wb-queue-table">
                  <thead>
                    <tr>
                      <th>Queue</th>
                      <th>Waiting</th>
                      <th>Answered</th>
                      <th>Abandoned</th>
                      <th>Transferred</th>
                      <th>Failover</th>
                      <th>Longest Wait</th>
                      <th>Avg Wait</th>
                      <th>Service Level</th>
                      <th>Agents In</th>
                      <th>Busy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!Array.isArray(queues) || queues.length === 0 ? (
                      <tr><td colSpan={11} className="wb-empty">No queues.</td></tr>
                    ) : queues.map((q) => {
                      const longestWait = (q.longest_wait_today_sec != null && q.longest_wait_today_sec > 0)
                        ? q.longest_wait_today_sec
                        : (q.longest_wait_sec || 0);
                      return (
                        <tr key={q.id ?? q.name}>
                          <td className="wb-queue-name">{q.display_name || q.name || '—'}</td>
                          <td className="wb-mono">{q.waiting ?? 0}</td>
                          <td className="wb-mono">{q.calls_answered_today ?? 0}</td>
                          <td className="wb-mono">{q.calls_abandoned_today ?? 0}</td>
                          <td className="wb-mono">{q.calls_transferred_today ?? 0}</td>
                          <td className="wb-mono">{q.calls_failover_today ?? 0}</td>
                          <td className="wb-mono">{longestWait > 0 ? `${longestWait}s` : '—'}</td>
                          <td className="wb-mono">{(q.average_wait_time != null && q.average_wait_time > 0) ? `${q.average_wait_time}s` : '—'}</td>
                          <td className="wb-mono">{q.service_level != null ? `${q.service_level}%` : '—'}</td>
                          <td className="wb-mono">{q.agents_logged_in ?? 0}</td>
                          <td className="wb-mono">{q.agents_busy ?? 0}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </>
            )}
          </>
        )}

        {activeTab === 'report' && (
          <section className="wb-section">
            <div className="wb-report-header">
              <h2>Daily Agent Report</h2>
              <div className="wb-report-controls">
                <input type="date" value={reportDate} onChange={(e) => setReportDate(e.target.value)} className="wb-date-input" />
                <button onClick={loadReport} className="wb-btn wb-btn-primary" disabled={reportLoading}>
                  {reportLoading ? 'Loading...' : 'Refresh'}
                </button>
                <button
                  type="button"
                  className="wb-btn wb-btn-primary"
                  disabled={reportLoading || !reportData?.agents?.length}
                  onClick={async () => {
                    try {
                      const url = tenantId
                        ? `${API_BASE}/api/wallboard/report?tenant_id=${tenantId}&date=${reportDate}&format=csv`
                        : `${API_BASE}/api/wallboard/report?date=${reportDate}&format=csv`;
                      const res = await fetch(url, { credentials: 'include' });
                      if (!res.ok) return;
                      const blob = await res.blob();
                      const u = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = u;
                      a.download = `wallboard-daily-${reportDate}.csv`;
                      a.click();
                      URL.revokeObjectURL(u);
                    } catch {
                      // ignore
                    }
                  }}
                >
                  Download CSV
                </button>
              </div>
            </div>
            {reportData?.summary && (
              <div className="wb-report-summary">
                <span className="wb-report-kpi" title="Total calls answered"><strong>{reportData.summary.total_calls ?? 0}</strong> Calls</span>
                <span className="wb-report-kpi" title="Calls not answered"><strong>{reportData.summary.total_calls_missed ?? 0}</strong> Missed</span>
                <span className="wb-report-kpi" title="Average handle time"><strong>{reportData.summary.avg_aht_sec != null ? formatAht(reportData.summary.avg_aht_sec) : '-'}</strong> Avg AHT</span>
                <span className="wb-report-kpi" title="Average occupancy (talk+wrap vs login)"><strong>{reportData.summary.avg_occupancy != null ? `${Math.round(reportData.summary.avg_occupancy * 100)}%` : '-'}</strong> Avg Occupancy</span>
                <span className="wb-report-kpi" title="Total login time"><strong>{formatDurationSec(reportData.summary.total_login_sec)}</strong> Login</span>
                <span className="wb-report-kpi" title="Total talk time"><strong>{formatDurationSec(reportData.summary.total_talk_sec)}</strong> Talk</span>
                <span className="wb-report-kpi" title="Total wrap / ACW"><strong>{formatDurationSec(reportData.summary.total_wrap_sec)}</strong> Wrap</span>
                <span className="wb-report-kpi" title="Agents with activity"><strong>{reportData.summary.agent_count ?? 0}</strong> Agents</span>
              </div>
            )}
            <div className="wb-agent-table-wrap">
              <table className="wb-agent-table wb-report-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Login Time</th>
                    <th>Productive Time</th>
                    <th>Talk Time</th>
                    <th>Wrap (ACW)</th>
                    <th>Pause Time</th>
                    <th>Calls</th>
                    <th>Missed</th>
                    <th>AHT</th>
                    <th>Occupancy</th>
                  </tr>
                </thead>
                <tbody>
                  {!reportData?.agents?.length ? (
                    <tr><td colSpan={10} className="wb-empty">{reportLoading ? 'Loading...' : 'No data for this date. Select another date or run the report after agents have logged in.'}</td></tr>
                  ) : reportData.agents.map((a, i) => (
                    <tr key={a.agent_id || i}>
                      <td className="wb-agent-name">
                        <span className="wb-agent-name-line">{a.name || '-'}</span>
                        <span className="wb-agent-ext-line">{a.agent_id || '-'}</span>
                      </td>
                      <td className="wb-mono">{formatDurationSec(a.login_time)}</td>
                      <td className="wb-mono">{formatDurationSec(a.productive_time ?? Math.max(0, (a.login_time || 0) - (a.total_pause_time || 0)))}</td>
                      <td className="wb-mono">{formatDurationSec(a.total_talk_time)}</td>
                      <td className="wb-mono">{formatDurationSec(a.total_wrap_time)}</td>
                      <td className="wb-mono">{formatDurationSec(a.total_pause_time)}</td>
                      <td className="wb-mono">{a.calls_handled ?? 0}</td>
                      <td className="wb-mono">{a.calls_missed ?? 0}</td>
                      <td className="wb-mono">{formatAht(a.aht)}</td>
                      <td className="wb-mono">{a.occupancy != null ? `${Math.round(a.occupancy * 100)}%` : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </Layout>
  );
}

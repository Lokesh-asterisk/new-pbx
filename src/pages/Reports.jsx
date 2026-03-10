import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
} from 'recharts';
import './Reports.css';

const API = import.meta.env.DEV ? '' : (import.meta.env.VITE_API_URL || '');

const TABS = [
  { id: 'performance', label: 'Performance' },
  { id: 'leaderboard', label: 'Leaderboard' },
  { id: 'breaks', label: 'Break Analysis' },
  { id: 'time', label: 'Time Distribution' },
  { id: 'trends', label: 'Trends' },
  { id: 'hourly', label: 'Hourly' },
  { id: 'comparison', label: 'Comparison' },
  { id: 'queues', label: 'Queue Stats' },
  { id: 'alerts', label: 'Alerts' },
];

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899', '#84cc16'];
const PIE_COLORS = { talk: '#3b82f6', ready: '#22c55e', wrap: '#a855f7', pause: '#f59e0b' };

function fmtSec(s) {
  const sec = Number(s) || 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function fmtSecShort(s) {
  const sec = Number(s) || 0;
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

async function apiFetch(path) {
  const res = await fetch(`${API}${path}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export default function Reports() {
  const { user } = useAuth();
  const [tab, setTab] = useState('performance');
  const [period, setPeriod] = useState('daily');
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10));
  const [tenantId, setTenantId] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [queueFilter, setQueueFilter] = useState('');

  const [tenants, setTenants] = useState([]);
  const [agentList, setAgentList] = useState([]);
  const [queueList, setQueueList] = useState([]);

  const [perfData, setPerfData] = useState(null);
  const [leaderData, setLeaderData] = useState(null);
  const [breakData, setBreakData] = useState(null);
  const [timeData, setTimeData] = useState(null);
  const [trendData, setTrendData] = useState(null);
  const [hourlyData, setHourlyData] = useState(null);
  const [compData, setCompData] = useState(null);
  const [queueData, setQueueData] = useState(null);
  const [alertData, setAlertData] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Comparison agent selection
  const [compAgents, setCompAgents] = useState([]);

  const tenantParam = tenantId ? `&tenant_id=${tenantId}` : '';

  useEffect(() => {
    apiFetch('/api/reports/tenants').then(r => setTenants(r.tenants || [])).catch(() => {});
  }, []);

  useEffect(() => {
    const tp = tenantId ? `?tenant_id=${tenantId}` : '';
    apiFetch(`/api/reports/agents${tp}`).then(r => setAgentList(r.agents || [])).catch(() => {});
    apiFetch(`/api/reports/queues${tp}`).then(r => setQueueList(r.queues || [])).catch(() => {});
  }, [tenantId]);

  const dateParams = useMemo(() => {
    if (period === 'daily') return `date=${startDate}`;
    if (period === 'weekly') return 'period=weekly';
    if (period === 'monthly') return 'period=monthly';
    return `start_date=${startDate}&end_date=${endDate}`;
  }, [period, startDate, endDate]);

  const fetchTab = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const base = `/api/reports`;
      const af = agentFilter ? `&agent_id=${agentFilter}` : '';
      const qf = queueFilter ? `&queue=${queueFilter}` : '';

      if (tab === 'performance') {
        const r = await apiFetch(`${base}/performance?${dateParams}${tenantParam}${af}${qf}`);
        setPerfData(r);
      } else if (tab === 'leaderboard') {
        const r = await apiFetch(`${base}/leaderboard?${dateParams}${tenantParam}`);
        setLeaderData(r);
      } else if (tab === 'breaks') {
        const r = await apiFetch(`${base}/breaks?${dateParams}${tenantParam}${af}`);
        setBreakData(r);
      } else if (tab === 'time') {
        const r = await apiFetch(`${base}/time-distribution?${dateParams}${tenantParam}${af}`);
        setTimeData(r);
      } else if (tab === 'trends') {
        const dp = period === 'daily' ? `start_date=${startDate}&end_date=${startDate}` : dateParams;
        const r = await apiFetch(`${base}/trends?${dp}${tenantParam}${af}`);
        setTrendData(r);
      } else if (tab === 'hourly') {
        const r = await apiFetch(`${base}/hourly?date=${startDate}${tenantParam}${af}`);
        setHourlyData(r);
      } else if (tab === 'comparison') {
        if (compAgents.length >= 2) {
          const r = await apiFetch(`${base}/comparison?${dateParams}${tenantParam}&agents=${compAgents.join(',')}`);
          setCompData(r);
        }
      } else if (tab === 'queues') {
        const r = await apiFetch(`${base}/queue?${dateParams}${tenantParam}${qf}`);
        setQueueData(r);
      } else if (tab === 'alerts') {
        const r = await apiFetch(`${base}/alerts?date=${startDate}${tenantParam}`);
        setAlertData(r);
      }
    } catch (e) {
      setError(e.message || 'Failed to load report');
    } finally {
      setLoading(false);
    }
  }, [tab, dateParams, tenantParam, agentFilter, queueFilter, compAgents, startDate, period]);

  useEffect(() => { fetchTab(); }, [fetchTab]);

  function handlePeriodChange(p) {
    setPeriod(p);
    const today = new Date().toISOString().slice(0, 10);
    if (p === 'daily') {
      setStartDate(today);
      setEndDate(today);
    } else if (p === 'weekly') {
      const d = new Date(); d.setDate(d.getDate() - 6);
      setStartDate(d.toISOString().slice(0, 10));
      setEndDate(today);
    } else if (p === 'monthly') {
      const d = new Date();
      setStartDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`);
      setEndDate(today);
    }
  }

  function toggleCompAgent(aid) {
    setCompAgents(prev => prev.includes(aid) ? prev.filter(a => a !== aid) : [...prev, aid]);
  }

  function handleCsvExport() {
    const af = agentFilter ? `&agent_id=${agentFilter}` : '';
    const qf = queueFilter ? `&queue=${queueFilter}` : '';
    window.open(`${API}/api/reports/performance?${dateParams}${tenantParam}${af}${qf}&format=csv`, '_blank');
  }

  const scoreClass = (s) => s >= 70 ? 'rpt-score-high' : s >= 40 ? 'rpt-score-mid' : 'rpt-score-low';
  const rankClass = (r) => r === 1 ? 'rpt-rank-1' : r === 2 ? 'rpt-rank-2' : r === 3 ? 'rpt-rank-3' : 'rpt-rank-default';

  // Tooltip styling for recharts
  const tooltipStyle = { backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px', color: '#e2e8f0', fontSize: '0.8125rem' };

  return (
    <div className="reports">
      <div className="reports-header">
        <h1>Agent Performance Reports</h1>
        <div className="reports-header-actions">
          <a href="/wallboard" className="rpt-btn">Back to Wallboard</a>
          <a href="/dashboard" className="rpt-btn">Dashboard</a>
        </div>
      </div>

      {/* Tabs */}
      <div className="rpt-tabs">
        {TABS.map(t => (
          <button key={t.id} className={`rpt-tab${tab === t.id ? ' rpt-tab-active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="rpt-filters">
        {tenants.length > 0 && (
          <div className="rpt-filter-group">
            <label>Tenant</label>
            <select className="rpt-select" value={tenantId} onChange={e => setTenantId(e.target.value)}>
              <option value="">Auto</option>
              {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        )}

        <div className="rpt-period-btns">
          {['daily', 'weekly', 'monthly', 'custom'].map(p => (
            <button key={p} className={`rpt-period-btn${period === p ? ' active' : ''}`}
              onClick={() => handlePeriodChange(p)}>
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>

        <div className="rpt-filter-group">
          <label>From</label>
          <input type="date" className="rpt-date-input" value={startDate}
            onChange={e => { setStartDate(e.target.value); if (period !== 'custom') setPeriod('custom'); }} />
        </div>

        {(period === 'custom' || period === 'weekly' || period === 'monthly') && (
          <div className="rpt-filter-group">
            <label>To</label>
            <input type="date" className="rpt-date-input" value={endDate}
              onChange={e => { setEndDate(e.target.value); if (period !== 'custom') setPeriod('custom'); }} />
          </div>
        )}

        <div className="rpt-filter-group">
          <label>Agent</label>
          <select className="rpt-select" value={agentFilter} onChange={e => setAgentFilter(e.target.value)}>
            <option value="">All Agents</option>
            {agentList.map(a => <option key={a.agent_id} value={a.agent_id}>{a.name || a.agent_id}</option>)}
          </select>
        </div>

        <div className="rpt-filter-group">
          <label>Queue</label>
          <select className="rpt-select" value={queueFilter} onChange={e => setQueueFilter(e.target.value)}>
            <option value="">All Queues</option>
            {queueList.map(q => <option key={q.name} value={q.name}>{q.display_name || q.name}</option>)}
          </select>
        </div>

        {tab === 'performance' && (
          <button className="rpt-btn rpt-btn-sm" onClick={handleCsvExport}>Export CSV</button>
        )}
      </div>

      {error && <div className="rpt-alert rpt-alert-warning"><span className="rpt-alert-icon">!</span><span>{error}</span></div>}
      {loading && <div className="rpt-loading">Loading report data...</div>}

      {/* Tab Content */}
      {!loading && tab === 'performance' && <PerformanceTab data={perfData} scoreClass={scoreClass} />}
      {!loading && tab === 'leaderboard' && <LeaderboardTab data={leaderData} scoreClass={scoreClass} rankClass={rankClass} tooltipStyle={tooltipStyle} />}
      {!loading && tab === 'breaks' && <BreakTab data={breakData} />}
      {!loading && tab === 'time' && <TimeDistributionTab data={timeData} tooltipStyle={tooltipStyle} />}
      {!loading && tab === 'trends' && <TrendsTab data={trendData} tooltipStyle={tooltipStyle} />}
      {!loading && tab === 'hourly' && <HourlyTab data={hourlyData} tooltipStyle={tooltipStyle} />}
      {!loading && tab === 'comparison' && (
        <ComparisonTab data={compData} agentList={agentList} compAgents={compAgents}
          toggleCompAgent={toggleCompAgent} tooltipStyle={tooltipStyle} />
      )}
      {!loading && tab === 'queues' && <QueueTab data={queueData} tooltipStyle={tooltipStyle} />}
      {!loading && tab === 'alerts' && <AlertsTab data={alertData} />}
    </div>
  );
}

/* ── Performance Tab ──────────────────────────────────────── */
function PerformanceTab({ data, scoreClass }) {
  if (!data?.agents?.length) return <div className="rpt-empty">No performance data available for this period.</div>;
  const agents = data.agents;
  const totalCalls = agents.reduce((s, a) => s + a.calls_answered, 0);
  const totalMissed = agents.reduce((s, a) => s + a.calls_missed, 0);
  const avgOcc = agents.length > 0 ? Math.round(agents.reduce((s, a) => s + a.occupancy_pct, 0) / agents.length) : 0;
  const avgAht = agents.length > 0 ? Math.round(agents.reduce((s, a) => s + a.aht, 0) / agents.length) : 0;

  return (
    <>
      <div className="rpt-kpi-strip">
        <div className="rpt-kpi rpt-kpi-blue"><div className="rpt-kpi-value">{totalCalls}</div><div className="rpt-kpi-label">Calls Answered</div></div>
        <div className="rpt-kpi rpt-kpi-red"><div className="rpt-kpi-value">{totalMissed}</div><div className="rpt-kpi-label">Calls Missed</div></div>
        <div className="rpt-kpi rpt-kpi-green"><div className="rpt-kpi-value">{avgOcc}%</div><div className="rpt-kpi-label">Avg Occupancy</div></div>
        <div className="rpt-kpi rpt-kpi-amber"><div className="rpt-kpi-value">{fmtSec(avgAht)}</div><div className="rpt-kpi-label">Avg Handle Time</div></div>
        <div className="rpt-kpi rpt-kpi-purple"><div className="rpt-kpi-value">{agents.length}</div><div className="rpt-kpi-label">Active Agents</div></div>
      </div>

      <div className="rpt-section">
        <h2>Agent Performance Summary</h2>
        <div className="rpt-table-wrap">
          <table className="rpt-table">
            <thead>
              <tr>
                <th>Agent</th><th>Calls</th><th>Missed</th><th>Talk Time</th><th>Wrap Time</th>
                <th>Pause Time</th><th>Login Time</th><th>Occupancy</th><th>AHT</th><th>Score</th>
              </tr>
            </thead>
            <tbody>
              {agents.map(a => (
                <tr key={a.agent_id}>
                  <td>{a.name}</td>
                  <td>{a.calls_answered}</td>
                  <td>{a.calls_missed}</td>
                  <td className="rpt-mono">{a.talk_time}</td>
                  <td className="rpt-mono">{a.wrap_time}</td>
                  <td className="rpt-mono">{a.pause_time}</td>
                  <td className="rpt-mono">{a.login_time}</td>
                  <td>{a.occupancy_pct}%</td>
                  <td className="rpt-mono">{a.aht_formatted}</td>
                  <td><span className={`rpt-score ${scoreClass(a.performance_score)}`}>{a.performance_score}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ── Leaderboard Tab ──────────────────────────────────────── */
function LeaderboardTab({ data, scoreClass, rankClass, tooltipStyle }) {
  if (!data?.agents?.length) return <div className="rpt-empty">No leaderboard data available.</div>;
  const agents = data.agents;

  const chartData = agents.slice(0, 10).map(a => ({
    name: a.name?.length > 12 ? a.name.slice(0, 12) + '...' : a.name,
    score: a.performance_score,
    calls: a.calls_answered,
  }));

  return (
    <>
      <div className="rpt-section">
        <h2>Agent Ranking</h2>
        <div className="rpt-chart-container">
          <ResponsiveContainer>
            <BarChart data={chartData} layout="vertical" margin={{ left: 80, right: 20, top: 5, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis type="number" stroke="#64748b" />
              <YAxis type="category" dataKey="name" stroke="#94a3b8" width={80} tick={{ fontSize: 12 }} />
              <Tooltip contentStyle={tooltipStyle} />
              <Bar dataKey="score" fill="#3b82f6" radius={[0, 4, 4, 0]} name="Score" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="rpt-section">
        <h2>Detailed Rankings</h2>
        <div className="rpt-table-wrap">
          <table className="rpt-table">
            <thead>
              <tr>
                <th style={{ width: 50 }}>Rank</th><th>Agent</th><th>Calls</th><th>Missed</th>
                <th>Talk Time</th><th>Occupancy</th><th>AHT</th><th>Score</th>
              </tr>
            </thead>
            <tbody>
              {agents.map(a => (
                <tr key={a.agent_id}>
                  <td style={{ textAlign: 'center' }}><span className={`rpt-rank ${rankClass(a.rank)}`}>{a.rank}</span></td>
                  <td>{a.name}</td>
                  <td>{a.calls_answered}</td>
                  <td>{a.calls_missed}</td>
                  <td className="rpt-mono">{a.talk_time}</td>
                  <td>{a.occupancy_pct}%</td>
                  <td className="rpt-mono">{a.aht}</td>
                  <td><span className={`rpt-score ${scoreClass(a.performance_score)}`}>{a.performance_score}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ── Break Analysis Tab ───────────────────────────────────── */
function BreakTab({ data }) {
  if (!data?.agents?.length) return <div className="rpt-empty">No break data available for this period.</div>;
  const agents = data.agents;

  return (
    <>
      {agents.map(a => (
        <div key={a.agent_id} className="rpt-section">
          <h2>
            {a.name} ({a.agent_id})
            <span style={{ float: 'right', fontSize: '0.8125rem', fontWeight: 400, color: '#e2e8f0' }}>
              Total: {a.total_break_time}
            </span>
          </h2>

          {a.alerts.length > 0 && (
            <div style={{ marginBottom: '0.75rem' }}>
              {a.alerts.map((al, i) => (
                <div key={i} className="rpt-alert rpt-alert-warning">
                  <span className="rpt-alert-icon">!</span>
                  <span>{al.message}</span>
                </div>
              ))}
            </div>
          )}

          <div className="rpt-table-wrap">
            <table className="rpt-table">
              <thead>
                <tr><th>Break Type</th><th>Count</th><th>Total Duration</th><th>Avg Duration</th><th>Max Duration</th></tr>
              </thead>
              <tbody>
                {a.breaks.map((b, i) => (
                  <tr key={i}>
                    <td>{b.break_type}</td>
                    <td>{b.count}</td>
                    <td className="rpt-mono">{b.total_duration}</td>
                    <td className="rpt-mono">{b.avg_duration}</td>
                    <td className="rpt-mono">{fmtSec(b.max_duration_sec)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  );
}

/* ── Time Distribution Tab ────────────────────────────────── */
function TimeDistributionTab({ data, tooltipStyle }) {
  if (!data?.agents?.length) return <div className="rpt-empty">No time distribution data available.</div>;
  const agents = data.agents;

  const pieData = useMemo(() => {
    const totals = agents.reduce((s, a) => ({
      talk: s.talk + a.talk_sec,
      ready: s.ready + a.ready_sec,
      wrap: s.wrap + a.wrap_sec,
      pause: s.pause + a.pause_sec,
    }), { talk: 0, ready: 0, wrap: 0, pause: 0 });
    return [
      { name: 'Talk', value: totals.talk, color: PIE_COLORS.talk },
      { name: 'Ready', value: totals.ready, color: PIE_COLORS.ready },
      { name: 'Wrap-up', value: totals.wrap, color: PIE_COLORS.wrap },
      { name: 'Break', value: totals.pause, color: PIE_COLORS.pause },
    ].filter(d => d.value > 0);
  }, [agents]);

  return (
    <>
      <div className="rpt-section">
        <h2>Aggregate Time Distribution</h2>
        <div className="rpt-chart-container" style={{ height: 280 }}>
          <ResponsiveContainer>
            <PieChart>
              <Pie data={pieData} dataKey="value" cx="50%" cy="50%" outerRadius={100}
                label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                {pieData.map((d, i) => <Cell key={i} fill={d.color} />)}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => fmtSecShort(v)} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="rpt-section">
        <h2>Per-Agent Time Distribution</h2>
        <div className="rpt-bar-legend">
          <span className="rpt-bar-legend-item"><span className="rpt-bar-legend-dot" style={{ background: PIE_COLORS.talk }} />Talk</span>
          <span className="rpt-bar-legend-item"><span className="rpt-bar-legend-dot" style={{ background: PIE_COLORS.ready }} />Ready</span>
          <span className="rpt-bar-legend-item"><span className="rpt-bar-legend-dot" style={{ background: PIE_COLORS.wrap }} />Wrap-up</span>
          <span className="rpt-bar-legend-item"><span className="rpt-bar-legend-dot" style={{ background: PIE_COLORS.pause }} />Break</span>
        </div>

        <div className="rpt-table-wrap" style={{ marginTop: '0.75rem' }}>
          <table className="rpt-table">
            <thead>
              <tr><th>Agent</th><th style={{ minWidth: 250 }}>Distribution</th><th>Talk</th><th>Ready</th><th>Wrap</th><th>Break</th><th>Login</th></tr>
            </thead>
            <tbody>
              {agents.map(a => (
                <tr key={a.agent_id}>
                  <td>{a.name}</td>
                  <td>
                    <div className="rpt-bar-stack">
                      <div className="rpt-bar-segment rpt-bar-talk" style={{ width: `${a.talk_pct}%` }} title={`Talk ${a.talk_pct}%`} />
                      <div className="rpt-bar-segment rpt-bar-ready" style={{ width: `${a.ready_pct}%` }} title={`Ready ${a.ready_pct}%`} />
                      <div className="rpt-bar-segment rpt-bar-wrap" style={{ width: `${a.wrap_pct}%` }} title={`Wrap ${a.wrap_pct}%`} />
                      <div className="rpt-bar-segment rpt-bar-pause" style={{ width: `${a.pause_pct}%` }} title={`Break ${a.pause_pct}%`} />
                    </div>
                  </td>
                  <td className="rpt-mono">{a.talk_time}</td>
                  <td className="rpt-mono">{a.ready_time}</td>
                  <td className="rpt-mono">{a.wrap_time}</td>
                  <td className="rpt-mono">{a.pause_time}</td>
                  <td className="rpt-mono">{a.login_time}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ── Trends Tab ───────────────────────────────────────────── */
function TrendsTab({ data, tooltipStyle }) {
  if (!data?.data?.length) return <div className="rpt-empty">No trend data available. Select a wider date range (weekly/monthly).</div>;
  const rows = data.data;

  return (
    <>
      <div className="rpt-section">
        <h2>Calls Per Day</h2>
        <div className="rpt-chart-container rpt-chart-container-lg">
          <ResponsiveContainer>
            <BarChart data={rows} margin={{ left: 10, right: 10, top: 5, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="date" stroke="#64748b" tick={{ fontSize: 11 }} />
              <YAxis stroke="#64748b" />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend />
              <Bar dataKey="calls_answered" fill="#3b82f6" name="Answered" radius={[4, 4, 0, 0]} />
              <Bar dataKey="calls_missed" fill="#ef4444" name="Missed" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="rpt-section">
        <h2>Occupancy & AHT Trend</h2>
        <div className="rpt-chart-container rpt-chart-container-lg">
          <ResponsiveContainer>
            <LineChart data={rows} margin={{ left: 10, right: 10, top: 5, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="date" stroke="#64748b" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="left" stroke="#22c55e" />
              <YAxis yAxisId="right" orientation="right" stroke="#f59e0b" />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend />
              <Line yAxisId="left" type="monotone" dataKey="occupancy_pct" stroke="#22c55e" name="Occupancy %" strokeWidth={2} dot={{ r: 3 }} />
              <Line yAxisId="right" type="monotone" dataKey="aht" stroke="#f59e0b" name="AHT (sec)" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="rpt-section">
        <h2>Talk Time & Pause Time Trend</h2>
        <div className="rpt-chart-container">
          <ResponsiveContainer>
            <LineChart data={rows} margin={{ left: 10, right: 10, top: 5, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="date" stroke="#64748b" tick={{ fontSize: 11 }} />
              <YAxis stroke="#64748b" tickFormatter={v => fmtSecShort(v)} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => fmtSecShort(v)} />
              <Legend />
              <Line type="monotone" dataKey="talk_time_sec" stroke="#3b82f6" name="Talk Time" strokeWidth={2} dot={{ r: 3 }} />
              <Line type="monotone" dataKey="pause_time_sec" stroke="#f59e0b" name="Pause Time" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </>
  );
}

/* ── Hourly Tab ───────────────────────────────────────────── */
function HourlyTab({ data, tooltipStyle }) {
  if (!data?.data?.length) return <div className="rpt-empty">No hourly data available.</div>;
  const rows = data.data;

  return (
    <>
      <div className="rpt-section">
        <h2>Hourly Call Volume</h2>
        <div className="rpt-chart-container rpt-chart-container-lg">
          <ResponsiveContainer>
            <BarChart data={rows} margin={{ left: 10, right: 10, top: 5, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="label" stroke="#64748b" tick={{ fontSize: 11 }} />
              <YAxis stroke="#64748b" />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend />
              <Bar dataKey="calls_answered" fill="#3b82f6" name="Answered" radius={[4, 4, 0, 0]} />
              <Bar dataKey="calls_missed" fill="#ef4444" name="Missed" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="rpt-section">
        <h2>Hourly Detail</h2>
        <div className="rpt-table-wrap">
          <table className="rpt-table">
            <thead>
              <tr><th>Hour</th><th>Answered</th><th>Missed</th><th>Talk Time</th><th>Pause Time</th></tr>
            </thead>
            <tbody>
              {rows.filter(r => r.calls_answered > 0 || r.calls_missed > 0).map(r => (
                <tr key={r.hour}>
                  <td>{r.label}</td>
                  <td>{r.calls_answered}</td>
                  <td>{r.calls_missed}</td>
                  <td className="rpt-mono">{fmtSec(r.talk_time_sec)}</td>
                  <td className="rpt-mono">{fmtSec(r.pause_time_sec)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ── Comparison Tab ───────────────────────────────────────── */
function ComparisonTab({ data, agentList, compAgents, toggleCompAgent, tooltipStyle }) {
  const agents = data?.agents || [];

  const radarData = useMemo(() => {
    if (agents.length < 2) return [];
    const maxCalls = Math.max(...agents.map(a => a.calls_answered)) || 1;
    const maxTalk = Math.max(...agents.map(a => a.talk_time_sec)) || 1;
    const maxOcc = 100;
    const maxAht = Math.max(...agents.map(a => a.aht_sec)) || 1;

    const metrics = [
      { metric: 'Calls', key: 'calls_answered', max: maxCalls },
      { metric: 'Talk Time', key: 'talk_time_sec', max: maxTalk },
      { metric: 'Occupancy', key: 'occupancy_pct', max: maxOcc },
      { metric: 'AHT (inv)', key: 'aht_sec', max: maxAht, invert: true },
    ];

    return metrics.map(m => {
      const row = { metric: m.metric };
      agents.forEach(a => {
        const val = a[m.key] || 0;
        row[a.agent_id] = m.invert ? Math.round(((m.max - val) / m.max) * 100) : Math.round((val / m.max) * 100);
      });
      return row;
    });
  }, [agents]);

  return (
    <>
      <div className="rpt-section">
        <h2>Select Agents to Compare (min 2)</h2>
        <div className="rpt-agent-check">
          {agentList.map(a => (
            <label key={a.agent_id} className={`rpt-agent-check-item${compAgents.includes(a.agent_id) ? ' selected' : ''}`}>
              <input type="checkbox" checked={compAgents.includes(a.agent_id)} onChange={() => toggleCompAgent(a.agent_id)} />
              {a.name || a.agent_id}
            </label>
          ))}
        </div>
        {compAgents.length < 2 && <div className="rpt-empty">Select at least 2 agents to compare.</div>}
      </div>

      {agents.length >= 2 && (
        <>
          {radarData.length > 0 && (
            <div className="rpt-section">
              <h2>Performance Radar</h2>
              <div className="rpt-chart-container" style={{ height: 350 }}>
                <ResponsiveContainer>
                  <RadarChart data={radarData}>
                    <PolarGrid stroke="#334155" />
                    <PolarAngleAxis dataKey="metric" stroke="#94a3b8" tick={{ fontSize: 12 }} />
                    <PolarRadiusAxis stroke="#475569" tick={{ fontSize: 10 }} domain={[0, 100]} />
                    {agents.map((a, i) => (
                      <Radar key={a.agent_id} name={a.name} dataKey={a.agent_id}
                        stroke={COLORS[i % COLORS.length]} fill={COLORS[i % COLORS.length]} fillOpacity={0.15} strokeWidth={2} />
                    ))}
                    <Legend />
                    <Tooltip contentStyle={tooltipStyle} />
                  </RadarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          <div className="rpt-section">
            <h2>Side-by-Side Comparison</h2>
            <div className="rpt-table-wrap">
              <table className="rpt-table rpt-compare-table">
                <thead>
                  <tr>
                    <th>Metric</th>
                    {agents.map(a => <th key={a.agent_id}>{a.name}</th>)}
                  </tr>
                </thead>
                <tbody>
                  <tr><td>Calls Answered</td>{agents.map(a => <td key={a.agent_id}>{a.calls_answered}</td>)}</tr>
                  <tr><td>Calls Missed</td>{agents.map(a => <td key={a.agent_id}>{a.calls_missed}</td>)}</tr>
                  <tr><td>Talk Time</td>{agents.map(a => <td key={a.agent_id} className="rpt-mono">{a.talk_time}</td>)}</tr>
                  <tr><td>Pause Time</td>{agents.map(a => <td key={a.agent_id} className="rpt-mono">{a.pause_time}</td>)}</tr>
                  <tr><td>Login Time</td>{agents.map(a => <td key={a.agent_id} className="rpt-mono">{a.login_time}</td>)}</tr>
                  <tr><td>Occupancy</td>{agents.map(a => <td key={a.agent_id}>{a.occupancy_pct}%</td>)}</tr>
                  <tr><td>AHT</td>{agents.map(a => <td key={a.agent_id} className="rpt-mono">{a.aht}</td>)}</tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}

/* ── Queue Stats Tab ──────────────────────────────────────── */
function QueueTab({ data, tooltipStyle }) {
  if (!data?.queues?.length) return <div className="rpt-empty">No queue data available for this period.</div>;
  const queues = data.queues;

  const chartData = queues.map(q => ({
    name: q.queue_name,
    answered: q.calls_answered,
    abandoned: q.calls_abandoned,
    transferred: q.calls_transferred,
  }));

  return (
    <>
      <div className="rpt-section">
        <h2>Queue Call Volume</h2>
        <div className="rpt-chart-container">
          <ResponsiveContainer>
            <BarChart data={chartData} margin={{ left: 10, right: 10, top: 5, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="name" stroke="#64748b" tick={{ fontSize: 11 }} />
              <YAxis stroke="#64748b" />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend />
              <Bar dataKey="answered" fill="#3b82f6" name="Answered" radius={[4, 4, 0, 0]} />
              <Bar dataKey="abandoned" fill="#ef4444" name="Abandoned" radius={[4, 4, 0, 0]} />
              <Bar dataKey="transferred" fill="#a855f7" name="Transferred" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="rpt-section">
        <h2>Queue Performance</h2>
        <div className="rpt-table-wrap">
          <table className="rpt-table">
            <thead>
              <tr>
                <th>Queue</th><th>Offered</th><th>Answered</th><th>Abandoned</th><th>Transferred</th>
                <th>Avg Wait</th><th>Avg Talk</th><th>Max Wait</th><th>SLA %</th><th>Answer %</th>
              </tr>
            </thead>
            <tbody>
              {queues.map(q => (
                <tr key={q.queue_name}>
                  <td>{q.queue_name}</td>
                  <td>{q.calls_offered}</td>
                  <td>{q.calls_answered}</td>
                  <td>{q.calls_abandoned}</td>
                  <td>{q.calls_transferred}</td>
                  <td className="rpt-mono">{q.avg_wait_time}</td>
                  <td className="rpt-mono">{q.avg_talk_time}</td>
                  <td className="rpt-mono">{q.max_wait_time}</td>
                  <td>{q.service_level}%</td>
                  <td>{q.answer_rate}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ── Alerts Tab ───────────────────────────────────────────── */
function AlertsTab({ data }) {
  if (!data?.alerts?.length) return <div className="rpt-empty">No alerts for today. All agents are within targets.</div>;
  const alerts = data.alerts;

  return (
    <div className="rpt-section">
      <h2>Supervisor Alerts</h2>
      {alerts.map((a, i) => (
        <div key={i} className={`rpt-alert rpt-alert-${a.severity === 'warning' ? 'warning' : 'info'}`}>
          <span className="rpt-alert-icon">{a.severity === 'warning' ? '!' : 'i'}</span>
          <div className="rpt-alert-content">
            <span className="rpt-alert-agent">{a.agent_name} ({a.agent_id})</span>
            <div>{a.message}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

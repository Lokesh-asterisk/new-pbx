import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import { useBranding } from '../context/BrandingContext';
import { apiFetch } from '../utils/api';
import './Dashboard.css';

export default function Admin() {
  const navigate = useNavigate();
  const { branding } = useBranding();
  const [view, setView] = useState('dashboard'); // 'dashboard' | 'reports'
  const [stats, setStats] = useState(null);
  const [statsError, setStatsError] = useState('');
  const [cdr, setCdr] = useState({ list: [], total: 0, page: 1, limit: 50, total_pages: 1 });
  const [didTfnReport, setDidTfnReport] = useState([]);
  const [didTfnDateFrom, setDidTfnDateFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [didTfnDateTo, setDidTfnDateTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [reportsLoading, setReportsLoading] = useState(false);
  const [reportsError, setReportsError] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [tenants, setTenants] = useState([]);
  const [blacklist, setBlacklist] = useState([]);
  const [blacklistLoading, setBlacklistLoading] = useState(false);
  const [blacklistError, setBlacklistError] = useState('');
  const [blacklistAddNumber, setBlacklistAddNumber] = useState('');
  const [blacklistAddLoading, setBlacklistAddLoading] = useState(false);
  const [blacklistDeleteLoading, setBlacklistDeleteLoading] = useState(null);

  const loadStats = useCallback(async () => {
    setStatsError('');
    try {
      const res = await apiFetch('/api/admin/stats');
      const out = await res.json().catch(() => ({}));
      if (res.ok && out.success) {
        setStats(out.stats || null);
        return;
      }
      const msg = out.error || (res.status === 401 ? 'Not authenticated. Try logging in again.' : res.status === 403 ? 'Access denied.' : `Failed to load stats${res.status ? ` (${res.status})` : ''}`);
      setStatsError(msg);
    } catch (e) {
      setStatsError(e?.message || 'Failed to load stats. Is the server running on the correct port?');
    }
  }, []);

  const loadTenants = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/tenants');
      const out = await res.json().catch(() => ({}));
      if (res.ok && out.success && Array.isArray(out.tenants)) {
        setTenants(out.tenants || []);
        if (out.tenants?.length && !tenantId) setTenantId(String(out.tenants[0].id));
      }
    } catch {
      setTenants([]);
    }
  }, [tenantId]);

  const loadReports = useCallback(async () => {
    setReportsLoading(true);
    setReportsError('');
    try {
      const didTfnUrl = `/api/admin/reports/did-tfn?date_from=${didTfnDateFrom}&date_to=${didTfnDateTo}${tenantId ? `&tenant_id=${tenantId}` : ''}`;
      const [cdrRes, didTfnRes] = await Promise.all([
        apiFetch(`/api/admin/cdr?page=1&limit=50`),
        apiFetch(didTfnUrl),
      ]);
      const cdrOut = await cdrRes.json().catch(() => ({}));
      const didTfnOut = await didTfnRes.json().catch(() => ({}));
      if (cdrRes.ok && cdrOut.success) {
        setCdr({
          list: cdrOut.list || [],
          total: cdrOut.total ?? 0,
          page: cdrOut.page ?? 1,
          limit: cdrOut.limit ?? 50,
          total_pages: cdrOut.total_pages ?? 1,
        });
      }
      if (didTfnRes.ok && didTfnOut.success) setDidTfnReport(didTfnOut.report || []);
      if (!cdrRes.ok) setReportsError('Failed to load some report data');
    } catch {
      setReportsError('Failed to load reports');
    } finally {
      setReportsLoading(false);
    }
  }, [tenantId, didTfnDateFrom, didTfnDateTo]);

  useEffect(() => {
    loadStats();
    loadTenants();
  }, [loadStats, loadTenants]);

  useEffect(() => {
    if (view === 'reports') loadReports();
  }, [view, loadReports]);

  const loadBlacklist = useCallback(async () => {
    setBlacklistError('');
    setBlacklistLoading(true);
    try {
      const url = tenantId ? `/api/admin/blacklist?tenant_id=${tenantId}` : '/api/admin/blacklist';
      const res = await apiFetch(url);
      const out = await res.json().catch(() => ({}));
      if (res.ok && out.success) {
        setBlacklist(out.list || []);
      } else {
        setBlacklistError(out.error || 'Failed to load blacklist');
      }
    } catch (e) {
      setBlacklistError(e?.message || 'Failed to load blacklist');
    } finally {
      setBlacklistLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    if (view === 'blacklist') loadBlacklist();
  }, [view, loadBlacklist]);

  const handleBlacklistAdd = async () => {
    const num = (blacklistAddNumber || '').trim();
    if (!num) return;
    setBlacklistAddLoading(true);
    setBlacklistError('');
    try {
      const tid = tenantId || (tenants[0]?.id);
      if (!tid) {
        setBlacklistError('Select a tenant first');
        return;
      }
      const res = await apiFetch('/api/admin/blacklist', {
        method: 'POST',
        body: JSON.stringify({ tenant_id: Number(tid), number: num }),
      });
      const out = await res.json().catch(() => ({}));
      if (res.ok && out.success) {
        setBlacklistAddNumber('');
        loadBlacklist();
      } else {
        setBlacklistError(out.error || 'Failed to add');
      }
    } catch (e) {
      setBlacklistError(e?.message || 'Failed to add');
    } finally {
      setBlacklistAddLoading(false);
    }
  };

  const handleBlacklistDelete = async (id) => {
    setBlacklistDeleteLoading(id);
    setBlacklistError('');
    try {
      const res = await apiFetch(`/api/admin/blacklist/${id}`, { method: 'DELETE' });
      const out = await res.json().catch(() => ({}));
      if (res.ok && out.success) {
        loadBlacklist();
      } else {
        setBlacklistError(out.error || 'Failed to delete');
      }
    } catch (e) {
      setBlacklistError(e?.message || 'Failed to delete');
    } finally {
      setBlacklistDeleteLoading(null);
    }
  };

  return (
    <Layout title="Admin" subtitle={`${branding.productName} — Reports & monitoring`}>
      <div className="dashboard">
        {view === 'dashboard' && (
          <>
            <section className="dashboard-section">
              <h2>Overview</h2>
              {statsError && <p className="dashboard-error">{statsError}</p>}
              <div className="card-grid">
                <div className="stat-card">
                  <span className="stat-value">{stats?.active_agents ?? '—'}</span>
                  <span className="stat-label">Online agents</span>
                </div>
                <div className="stat-card">
                  <span className="stat-value">{stats?.queues ?? '—'}</span>
                  <span className="stat-label">Queues</span>
                </div>
                <div className="stat-card">
                  <span className="stat-value">{stats?.total_users ?? '—'}</span>
                  <span className="stat-label">Total users</span>
                </div>
                <div className="stat-card">
                  <span className="stat-value">{stats?.inbound_routes ?? '—'}</span>
                  <span className="stat-label">Inbound routes</span>
                </div>
              </div>
            </section>
            <section className="dashboard-section">
              <h2>Reports & monitoring</h2>
              <div className="action-list">
                <button
                  type="button"
                  className="action-btn"
                  onClick={() => navigate('/wallboard')}
                >
                  Live wallboard
                </button>
                <button
                  type="button"
                  className="action-btn"
                  onClick={() => setView('reports')}
                >
                  Reports (CDR & DID/TFN)
                </button>
                <button
                  type="button"
                  className="action-btn"
                  onClick={() => setView('blacklist')}
                >
                  Blacklist (block numbers)
                </button>
              </div>
            </section>
          </>
        )}

        {view === 'blacklist' && (
          <>
            <section className="dashboard-section">
              <div className="action-list" style={{ marginBottom: '1rem' }}>
                <button type="button" className="action-btn" onClick={() => setView('dashboard')}>
                  ← Back to dashboard
                </button>
              </div>
              <h2>Blacklist</h2>
              <p className="dashboard-muted">Blocked numbers will not reach queues or agents. Add prank/robocall numbers here.</p>
              {tenants.length > 0 && (
                <div style={{ marginBottom: '1rem' }}>
                  <label>
                    Tenant:{' '}
                    <select
                      value={tenantId}
                      onChange={(e) => setTenantId(e.target.value)}
                      className="dashboard-select"
                    >
                      <option value="">All</option>
                      {tenants.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              <div style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  className="dashboard-select"
                  placeholder="Phone number to block"
                  value={blacklistAddNumber}
                  onChange={(e) => setBlacklistAddNumber(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleBlacklistAdd()}
                  style={{ width: '12rem' }}
                />
                <button
                  type="button"
                  className="action-btn"
                  onClick={handleBlacklistAdd}
                  disabled={blacklistAddLoading || !blacklistAddNumber.trim()}
                >
                  {blacklistAddLoading ? '…' : 'Add'}
                </button>
              </div>
              {blacklistError && <p className="dashboard-error">{blacklistError}</p>}
              {blacklistLoading && <p className="dashboard-loading">Loading…</p>}
              {!blacklistLoading && (
                <div className="dashboard-table-wrap">
                  <table className="dashboard-table">
                    <thead>
                      <tr>
                        <th>Number</th>
                        <th>Tenant ID</th>
                        <th>Added</th>
                        <th style={{ minWidth: '5.5rem', whiteSpace: 'nowrap' }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {blacklist.length === 0 && (
                        <tr><td colSpan={4}>No entries. Add a number above.</td></tr>
                      )}
                      {blacklist.map((e) => (
                        <tr key={e.id}>
                          <td>{e.number}</td>
                          <td>{e.tenant_id}</td>
                          <td>{e.created_at || '—'}</td>
                          <td style={{ minWidth: '5.5rem' }}>
                            <button
                              type="button"
                              className="action-btn"
                              style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
                              disabled={blacklistDeleteLoading === e.id}
                              onClick={() => handleBlacklistDelete(e.id)}
                              title="Remove this number from blacklist"
                            >
                              {blacklistDeleteLoading === e.id ? '…' : 'Delete'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}

        {view === 'reports' && (
          <>
            <section className="dashboard-section">
              <div className="action-list" style={{ marginBottom: '1rem' }}>
                <button
                  type="button"
                  className="action-btn"
                  onClick={() => setView('dashboard')}
                >
                  ← Back to dashboard
                </button>
              </div>
              {tenants.length > 0 && (
                <div style={{ marginBottom: '1rem' }}>
                  <label>
                    Tenant:{' '}
                    <select
                      value={tenantId}
                      onChange={(e) => setTenantId(e.target.value)}
                      className="dashboard-select"
                    >
                      <option value="">All</option>
                      {tenants.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              {reportsError && <p className="dashboard-error">{reportsError}</p>}
              {reportsLoading && <p className="dashboard-loading">Loading reports…</p>}
            </section>

            {!reportsLoading && (
              <>
                <section className="dashboard-section">
                  <p className="dashboard-muted" style={{ marginBottom: '1rem' }}>
                    For live agent monitoring, use the <button type="button" className="action-btn" onClick={() => navigate('/wallboard')}>Wallboard</button>.
                  </p>
                </section>
                <section className="dashboard-section">
                  <h2>Calls per DID/TFN</h2>
                  <p className="dashboard-muted">Inbound calls and abandoned per number (inbound route).</p>
                  <div style={{ marginBottom: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <label>
                      From:{' '}
                      <input
                        type="date"
                        value={didTfnDateFrom}
                        onChange={(e) => setDidTfnDateFrom(e.target.value)}
                        className="dashboard-select"
                      />
                    </label>
                    <label>
                      To:{' '}
                      <input
                        type="date"
                        value={didTfnDateTo}
                        onChange={(e) => setDidTfnDateTo(e.target.value)}
                        className="dashboard-select"
                      />
                    </label>
                    <button type="button" className="action-btn" onClick={loadReports} disabled={reportsLoading}>
                      Refresh
                    </button>
                    <button
                      type="button"
                      className="action-btn"
                      onClick={async () => {
                        try {
                          const res = await apiFetch(
                            `/api/admin/reports/did-tfn?format=csv&date_from=${didTfnDateFrom}&date_to=${didTfnDateTo}${tenantId ? `&tenant_id=${tenantId}` : ''}`
                          );
                          if (!res.ok) return;
                          const blob = await res.blob();
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = `did-tfn-report-${didTfnDateFrom}.csv`;
                          a.click();
                          URL.revokeObjectURL(url);
                        } catch {
                          // ignore
                        }
                      }}
                    >
                      Download CSV
                    </button>
                  </div>
                  <div className="dashboard-table-wrap">
                    <table className="dashboard-table">
                      <thead>
                        <tr>
                          <th>DID/TFN</th>
                          <th>Total calls</th>
                          <th>Answered</th>
                          <th>Abandoned</th>
                        </tr>
                      </thead>
                      <tbody>
                        {didTfnReport.length === 0 && (
                          <tr>
                            <td colSpan={4}>No data for this period.</td>
                          </tr>
                        )}
                        {didTfnReport.map((row, i) => (
                          <tr key={i}>
                            <td>{row.did_tfn || '—'}</td>
                            <td>{row.total_calls ?? 0}</td>
                            <td>{row.answered ?? 0}</td>
                            <td>{row.abandoned ?? 0}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className="dashboard-section">
                  <h2>Call detail records (CDR)</h2>
                  <p className="dashboard-muted">
                    Page {cdr.page} of {cdr.total_pages || 1} · {cdr.total} total
                  </p>
                  <div className="dashboard-table-wrap">
                    <table className="dashboard-table">
                      <thead>
                        <tr>
                          <th>Start time</th>
                          <th>Caller</th>
                          <th>Destination</th>
                          <th>DID/TFN</th>
                          <th>Agent</th>
                          <th>Direction</th>
                          <th>Duration</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cdr.list.length === 0 && (
                          <tr>
                            <td colSpan={8}>No call records</td>
                          </tr>
                        )}
                        {cdr.list.map((r) => (
                          <tr key={r.id || r.unique_id}>
                            <td>{r.start_time || '—'}</td>
                            <td>{r.source_number || '—'}</td>
                            <td>{r.destination_number || r.queue_name || '—'}</td>
                            <td>{r.did_tfn || '—'}</td>
                            <td>{r.agent_name || r.agent_extension || '—'}</td>
                            <td>{r.direction || '—'}</td>
                            <td>{r.duration_sec != null ? `${r.duration_sec}s` : '—'}</td>
                            <td>{r.status || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ marginTop: '0.5rem' }}>
                    <button
                      type="button"
                      className="action-btn"
                      onClick={async () => {
                        try {
                          const res = await apiFetch('/api/admin/cdr?format=csv&limit=10000');
                          if (!res.ok) return;
                          const blob = await res.blob();
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = `cdr-${new Date().toISOString().slice(0, 10)}.csv`;
                          a.click();
                          URL.revokeObjectURL(url);
                        } catch {
                          // ignore
                        }
                      }}
                    >
                      Export CDR (CSV)
                    </button>
                  </div>
                </section>
              </>
            )}
          </>
        )}
      </div>
    </Layout>
  );
}

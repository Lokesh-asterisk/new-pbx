import { useState, useEffect, useRef, useCallback } from 'react';
import { apiFetch, API_BASE } from '../../utils/api';

function AsteriskLogsView() {
  const [config, setConfig] = useState({ configured: false, source: null, message: '' });
  const [logFile, setLogFile] = useState('full');
  const [tailLines, setTailLines] = useState(2000);
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState(false);
  const [error, setError] = useState('');
  const logEndRef = useRef(null);
  const eventSourceRef = useRef(null);

  const loadConfig = useCallback(async () => {
    try {
      const res = await apiFetch('/api/superadmin/asterisk-logs/config');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setConfig({
          configured: data.configured,
          source: data.source,
          message: data.message || '',
        });
      }
    } catch { setConfig({ configured: false, source: null, message: '' }); }
  }, []);

  const loadLogs = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch(`/api/superadmin/asterisk-logs?file=${encodeURIComponent(logFile)}&tail=${tailLines}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setLines(data.lines || []);
      } else {
        setError(data.error || 'Failed to load logs');
      }
    } catch (e) {
      setError(e.message || 'Failed to load logs');
    } finally {
      setLoading(false);
    }
  }, [logFile, tailLines]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (!live) return;
    setError('');
    const url = `${API_BASE}/api/superadmin/asterisk-logs/stream?file=${encodeURIComponent(logFile)}`;
    const es = new EventSource(url, { withCredentials: true });
    eventSourceRef.current = es;
    es.onmessage = (ev) => {
      const line = ev.data;
      if (line) setLines((prev) => [...prev.slice(-9999), line]);
    };
    es.onerror = () => {
      es.close();
      setLive(false);
    };
    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [live, logFile]);

  useEffect(() => {
    if (live) return;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, [live]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  return (
    <section className="dashboard-section">
      <h2 className="superadmin-section-title">Asterisk Logs</h2>
      <p style={{ color: '#94a3b8', fontSize: '0.875rem', marginBottom: '1rem' }}>
        View Asterisk log files without logging into the server. Same server: set ASTERISK_LOG_DIR. Remote: set ASTERISK_CONFIG_API_URL and run config-receiver on the Asterisk server.
      </p>
      {config.message && (
        <p style={{ color: '#94a3b8', fontSize: '0.8rem', marginBottom: '1rem' }}>
          {config.message}
        </p>
      )}
      {!config.configured && (
        <p style={{ color: '#f59e0b', marginBottom: '1rem' }}>
          Logs not configured. Set ASTERISK_LOG_DIR (same server) or ASTERISK_CONFIG_API_URL (remote) in .env.
        </p>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center', marginBottom: '1rem' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ color: '#94a3b8' }}>Log file:</span>
          <select
            value={logFile}
            onChange={(e) => setLogFile(e.target.value)}
            disabled={live}
            className="superadmin-select"
            style={{ minWidth: '120px' }}
          >
            <option value="full">full</option>
            <option value="messages">messages</option>
            <option value="queue_log">queue_log</option>
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ color: '#94a3b8' }}>Lines:</span>
          <input
            type="number"
            min={100}
            max={50000}
            value={tailLines}
            onChange={(e) => setTailLines(parseInt(e.target.value, 10) || 2000)}
            disabled={live}
            className="superadmin-input"
            style={{ width: '90px' }}
          />
        </label>
        <button
          type="button"
          onClick={loadLogs}
          disabled={loading || live || !config.configured}
          className="superadmin-btn primary"
        >
          {loading ? 'Loading…' : 'Load'}
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: '0.5rem' }}>
          <input
            type="checkbox"
            checked={live}
            onChange={(e) => setLive(e.target.checked)}
            disabled={!config.configured}
          />
          <span style={{ color: '#94a3b8' }}>Live</span>
        </label>
      </div>
      {error && <p style={{ color: '#ef4444', marginBottom: '0.5rem' }}>{error}</p>}
      <div
        style={{
          background: '#0f172a',
          border: '1px solid #334155',
          borderRadius: '6px',
          padding: '0.75rem',
          maxHeight: '70vh',
          overflow: 'auto',
          fontFamily: 'ui-monospace, monospace',
          fontSize: '0.8rem',
          lineHeight: 1.4,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {lines.length === 0 && !loading && !live && config.configured && (
          <span style={{ color: '#64748b' }}>Click Load to fetch log lines.</span>
        )}
        {lines.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
        <div ref={logEndRef} />
      </div>
    </section>
  );
}

export default AsteriskLogsView;

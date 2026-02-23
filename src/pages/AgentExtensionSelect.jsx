import { useState, useEffect, useRef } from 'react';
import Layout from '../components/Layout';
import './AgentExtensionSelect.css';

const API_BASE = import.meta.env.VITE_API_URL || '';

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    cache: 'no-store',
  });
  return res;
}

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 120000; // 2 min

export default function AgentExtensionSelect({ onSelected }) {
  const [extensions, setExtensions] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [ringing, setRinging] = useState(false);
  const [error, setError] = useState('');
  const pollTimeoutRef = useRef(null);
  const pollIntervalRef = useRef(null);
  const onSelectedRef = useRef(onSelected);
  onSelectedRef.current = onSelected;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/agent/extensions');
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        const list = Array.isArray(data.extensions) ? data.extensions : [];
        if (data.success) {
          setExtensions(list);
          if (list.length > 0 && !selectedId) {
            const available = list.find((e) => !e.in_use || e.in_use_by_me);
            if (available) setSelectedId(String(available.id));
          }
          setError('');
        } else {
          setExtensions([]);
          setError(data.error || 'Failed to load extensions');
        }
      } catch (_) {
        if (!cancelled) setError('Could not load extensions. Check you are logged in as an agent.');
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!selectedId) {
      setError('Please select an extension.');
      return;
    }
    setSubmitting(true);
    try {
      const extId = Number(selectedId);
      const selectRes = await apiFetch('/api/agent/select-extension', {
        method: 'POST',
        body: JSON.stringify({ extension_id: extId }),
      });
      const selectData = await selectRes.json().catch(() => ({}));
      if (!selectData.success) {
        setError(selectData.error || 'Failed to set extension');
        setSubmitting(false);
        return;
      }

      const callRes = await apiFetch('/api/agent/call-extension', {
        method: 'POST',
        body: JSON.stringify({ extension_id: extId }),
      });
      const callData = await callRes.json().catch(() => ({}));

      if (!callData.success) {
        setError(callData.error || 'Could not ring your phone. Check Asterisk and extension.');
        setSubmitting(false);
        return;
      }

      setRinging(true);
      setSubmitting(false);

      const deadline = Date.now() + POLL_TIMEOUT_MS;

      const checkStatus = async () => {
        if (Date.now() > deadline) return;
        try {
          const statusRes = await apiFetch('/api/agent/status');
          const statusData = await statusRes.json().catch(() => ({}));
          const status = statusData.success ? String(statusData.agentStatus || '').trim() : '';
          if (status === 'LOGGEDIN') {
            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
            if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
            pollIntervalRef.current = null;
            pollTimeoutRef.current = null;
            setRinging(false);
            const callback = onSelectedRef.current;
            setTimeout(() => callback?.(), 0);
          } else if (status === 'LoginFailed') {
            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
            if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
            pollIntervalRef.current = null;
            pollTimeoutRef.current = null;
            setRinging(false);
            setError('Login failed. Wrong PIN or call ended. Try again.');
          }
        } catch (_) {}
      };

      pollTimeoutRef.current = setTimeout(() => {
        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
        setRinging(false);
        setError('Login timed out. Please try again.');
      }, POLL_TIMEOUT_MS);

      checkStatus();
      pollIntervalRef.current = setInterval(checkStatus, POLL_INTERVAL_MS);
    } catch (_) {
      setError('Could not connect. Try again.');
      setSubmitting(false);
    }
  };

  const selectedExt = extensions.find((e) => String(e.id) === selectedId);
  const canSubmit = selectedExt && !(selectedExt.in_use && !selectedExt.in_use_by_me);
  const busy = submitting || ringing;

  return (
    <Layout title="Agent" subtitle="Select your extension">
      <div className="agent-extension-select">
        <div className="extension-select-card">
          <h2>Select your extension</h2>
          <p className="extension-select-msg">
            {ringing
              ? 'Your phone is ringing. Answer and enter your PIN to log in.'
              : 'Choose the extension you will use for this session.'}
          </p>
          {loading ? (
            <p className="extension-select-loading">Loading extensions…</p>
          ) : (
            <form onSubmit={handleSubmit} className="extension-select-form">
              {error && <div className="extension-select-error">{error}</div>}
              {ringing && (
                <div className="extension-select-ringing" aria-live="polite">
                  Ringing… Answer the phone and enter your PIN.
                  <button
                    type="button"
                    className="extension-select-continue"
                    onClick={() => {
                      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
                      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
                      pollIntervalRef.current = null;
                      pollTimeoutRef.current = null;
                      setRinging(false);
                      onSelectedRef.current?.();
                    }}
                  >
                    I’ve logged in on my phone — go to dashboard
                  </button>
                </div>
              )}
              <div className="form-group">
                <label htmlFor="extension">Extension</label>
                <select
                  id="extension"
                  value={selectedId}
                  onChange={(e) => setSelectedId(e.target.value)}
                  required
                  disabled={extensions.length === 0 || busy}
                >
                  <option value="">Select extension</option>
                  {extensions.map((ext) => {
                    const inUseByOther = ext.in_use && !ext.in_use_by_me;
                    const label = ext.in_use_by_me
                      ? `${ext.name} (Your extension)`
                      : inUseByOther
                        ? `${ext.name} (In use)`
                        : ext.name;
                    return (
                      <option
                        key={ext.id}
                        value={ext.id}
                        disabled={inUseByOther}
                      >
                        {label}
                      </option>
                    );
                  })}
                </select>
              </div>
              {extensions.length === 0 && (
                <p className="extension-select-empty">No extensions found for your account. Ask your admin to add SIP extensions.</p>
              )}
              <button
                type="submit"
                className="btn-select-extension"
                disabled={extensions.length === 0 || !canSubmit || busy}
              >
                {submitting ? 'Calling…' : ringing ? 'Ringing…' : 'Select extension'}
              </button>
            </form>
          )}
        </div>
      </div>
    </Layout>
  );
}

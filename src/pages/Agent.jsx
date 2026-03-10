import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import AgentExtensionSelect from './AgentExtensionSelect';
import { useAuth } from '../context/AuthContext';
import './Agent.css';

const API_BASE = import.meta.env.DEV ? '' : (import.meta.env.VITE_API_URL || '');
async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  return res;
}

const STATUS_OPTIONS = [
  { value: 'available', label: 'Available', color: '#22c55e' },
  { value: 'ringing', label: 'Ringing', color: '#f59e0b' },
  { value: 'on-call', label: 'On call', color: '#3b82f6' },
  { value: 'outbound', label: 'Outbound', color: '#8b5cf6' },
  { value: 'break', label: 'Break', color: '#eab308' },
  { value: 'away', label: 'Away', color: '#64748b' },
];

const BREAK_REASONS = [
  { value: 'lunch', label: 'Lunch' },
  { value: 'restroom', label: 'Restroom' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'technical', label: 'Technical' },
  { value: 'other', label: 'Other' },
];

// Placeholder until backend provides real data
const PLACEHOLDER_INBOUND = {
  campaignName: '—',
  cli: '—',
  lastCall: '—',
};
const PLACEHOLDER_OUTBOUND = {
  campaignName: '—',
  cli: '—',
  lastCall: '—',
};

function formatDuration(ms) {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const AGENT_SESSION_START_KEY = 'agent_session_start';
const AGENT_SESSION_BREAKS_KEY = 'agent_session_breaks';

function getStoredBreaks() {
  try {
    const raw = localStorage.getItem(AGENT_SESSION_BREAKS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function totalBreakMs(breaks, currentBreakStart) {
  let ms = 0;
  for (const b of breaks) {
    if (b.start != null && b.end != null) ms += (b.end - b.start);
  }
  if (currentBreakStart != null) ms += (Date.now() - currentBreakStart);
  return ms;
}

export default function Agent() {
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [extensionSelected, setExtensionSelected] = useState(false);
  const [statusCheckDone, setStatusCheckDone] = useState(false);
  const [status, setStatus] = useState('available');
  const [sessionStartTime, setSessionStartTime] = useState(null);
  const [sessionBreaks, setSessionBreaks] = useState([]); // from backend when available
  const [useBackendSession, setUseBackendSession] = useState(false);
  const [loginTimeDisplay, setLoginTimeDisplay] = useState('0:00');
  const [activeCall, setActiveCall] = useState(null);
  const [breakState, setBreakState] = useState(null); // null | { reason: string, start: number }
  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [transferTarget, setTransferTarget] = useState('');
  const [transferType, setTransferType] = useState(null); // 'blind' | 'attended'
  const [showBreakMenu, setShowBreakMenu] = useState(false);
  const breakWrapRef = useRef(null);
  const [crmSearchInput, setCrmSearchInput] = useState('');
  const [crmSearching, setCrmSearching] = useState(false);
  const [crmResult, setCrmResult] = useState(null); // null | { error } | { name, phone, ... }
  const [inboundInfo, setInboundInfo] = useState(PLACEHOLDER_INBOUND);
  const [outboundInfo, setOutboundInfo] = useState(PLACEHOLDER_OUTBOUND);
  const [dialNumber, setDialNumber] = useState('');
  const [recentCalls, setRecentCalls] = useState([]);
  const [incomingCall, setIncomingCall] = useState(null); // { channelId, customerNumber, uniqueId, queueName, campaignName }
  const [callState, setCallState] = useState('idle'); // idle | ringing | connected | on_hold
  const [callError, setCallError] = useState(null);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changePasswordLoading, setChangePasswordLoading] = useState(false);
  const [changePasswordError, setChangePasswordError] = useState(null);
  const [changePasswordSuccess, setChangePasswordSuccess] = useState(false);

  const onCall = !!activeCall;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/agent/status');
        if (!cancelled && res.status === 401) {
          logout();
          setStatusCheckDone(true);
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (!cancelled && data.success && data.extensionSelected) {
          setExtensionSelected(true);
          if (data.agentStatus) {
            const s = String(data.agentStatus).toUpperCase();
            if (s === 'RINGING') setStatus('ringing');
            else if (s === 'ON CALL' || s === 'ONCALL') setStatus('on-call');
            else if (s === 'OUTBOUND') setStatus('outbound');
            else if (s === 'LOGGEDIN') setStatus('available');
            else if (s.includes('BREAK') || s === 'PAUSED') {
              setStatus('break');
              if (data.breakStartedAt) {
                const startMs = new Date(data.breakStartedAt).getTime();
                if (Number.isFinite(startMs)) {
                  setBreakState({ reason: data.breakName || 'other', start: startMs });
                } else {
                  setBreakState({ reason: data.breakName || 'other', start: Date.now() - 60000 });
                }
              } else {
                setBreakState({ reason: data.breakName || 'other', start: Date.now() - 60000 });
              }
            }
          }
          // Prefer backend session (survives refresh, same across devices)
          const sessionRes = await apiFetch('/api/agent/session').catch(() => null);
          const sessionData = sessionRes?.ok ? await sessionRes.json().catch(() => ({})) : null;
          if (!cancelled && sessionData?.success && sessionData.sessionStart != null) {
            setSessionStartTime(sessionData.sessionStart);
            setSessionBreaks(Array.isArray(sessionData.breaks) ? sessionData.breaks : []);
            setUseBackendSession(true);
          } else {
            // Use current time only when backend has no session (matches Live Monitoring: no DB value = 0:00)
            setSessionStartTime(Date.now());
            setSessionBreaks([]);
            setUseBackendSession(false);
          }
        }
      } catch (_) {}
      if (!cancelled) setStatusCheckDone(true);
    })();
    return () => { cancelled = true; };
  }, [logout]);

  // When extension is selected via UI (e.g. AgentExtensionSelect), init session start if not set
  useEffect(() => {
    if (!extensionSelected || sessionStartTime != null) return;
    setSessionStartTime(Date.now());
    setSessionBreaks([]);
  }, [extensionSelected, sessionStartTime]);

  // Login timer tick: total time since login (gross, matches Live Monitoring)
  useEffect(() => {
    if (!sessionStartTime) return;
    const tick = () => {
      const elapsed = Date.now() - sessionStartTime;
      setLoginTimeDisplay(formatDuration(elapsed));
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [sessionStartTime]);

  useEffect(() => {
    if (!showBreakMenu) return;
    const onDocClick = (e) => {
      if (breakWrapRef.current && !breakWrapRef.current.contains(e.target)) {
        setShowBreakMenu(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [showBreakMenu]);

  useEffect(() => {
    if (onCall) setShowBreakMenu(false);
  }, [onCall]);

  // Real-time events (SSE) when on agent dashboard
  useEffect(() => {
    if (!extensionSelected || !statusCheckDone) return;
    const url = `${API_BASE}/api/agent/events`;
    const es = new EventSource(url, { withCredentials: true });
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        const { type, payload } = msg;
        if (type === 'incoming_call') {
          const campaign = payload.campaignName || payload.queueName || 'Inbound';
          const cli = payload.customerNumber || '—';
          setInboundInfo({
            campaignName: campaign,
            cli,
            lastCall: 'Ringing…',
          });
          setIncomingCall({
            channelId: payload.channelId,
            customerChannelId: payload.customerChannelId,
            customerNumber: payload.customerNumber || 'Unknown',
            uniqueId: payload.uniqueId,
            queueName: payload.queueName,
            campaignName: payload.campaignName,
          });
          setStatus('ringing');
          setCallState('ringing');
        } else if (type === 'call_answered') {
          setIncomingCall(null);
          setCallState('connected');
          setStatus('on-call');
          setActiveCall((prev) => prev || { number: 'Call', direction: 'inbound', start: new Date() });
          setInboundInfo((prev) => (prev ? { ...prev, lastCall: 'In progress' } : prev));
        } else if (type === 'call_ended') {
          setIncomingCall(null);
          setActiveCall(null);
          setCallState('idle');
          setStatus(payload?.nextStatus === 'Outbound' ? 'outbound' : 'available');
          setInboundInfo((prev) => (prev ? { ...prev, lastCall: prev.lastCall === 'In progress' ? `Ended at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : prev.lastCall } : prev));
        } else if (type === 'agent_status' && payload?.callState) {
          setCallState(payload.callState === 'on_hold' ? 'on_hold' : payload.callState === 'connected' ? 'connected' : 'idle');
        }
      } catch (_) {}
    };
    es.onerror = () => {
      es.close();
    };
    return () => es.close();
  }, [extensionSelected, statusCheckDone]);

  const handleEndSession = useCallback(() => {
    localStorage.removeItem(AGENT_SESSION_START_KEY);
    localStorage.removeItem(AGENT_SESSION_BREAKS_KEY);
    logout();
    navigate('/login');
  }, [logout, navigate]);

  const handleHangup = useCallback(async () => {
    setCallError(null);
    try {
      const res = await apiFetch('/api/agent/calls/hangup', { method: 'POST', body: JSON.stringify({}) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCallError(data.error || 'Hangup failed');
        return;
      }
      setActiveCall(null);
      setCallState('idle');
      // Status is updated by call_ended event (with nextStatus for outbound) or next poll
    } catch (_) {
      setCallError('Hangup failed');
    }
  }, []);

  const handleOutboundStart = useCallback(async () => {
    setCallError(null);
    try {
      const res = await apiFetch('/api/agent/outbound/start', { method: 'POST', body: JSON.stringify({}) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCallError(data.error || 'Failed to switch to outbound');
        return;
      }
      setStatus('outbound');
      setOutboundInfo({ campaignName: 'Outbound', cli: '—', lastCall: 'Active' });
    } catch (_) {
      setCallError('Failed to switch to outbound');
    }
  }, []);

  const handleOutboundEnd = useCallback(async () => {
    setCallError(null);
    try {
      const res = await apiFetch('/api/agent/outbound/end', { method: 'POST', body: JSON.stringify({}) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCallError(data.error || 'Failed to resume inbound');
        return;
      }
      setStatus('available');
      setOutboundInfo(PLACEHOLDER_OUTBOUND);
    } catch (_) {
      setCallError('Failed to resume inbound');
    }
  }, []);

  const handleTakeBreak = useCallback(async (reason) => {
    const breakReason = reason || 'other';
    try {
      await apiFetch('/api/agent/break/start', {
        method: 'POST',
        body: JSON.stringify({ reason: breakReason }),
      });
    } catch (_) {}
    setBreakState({ reason: breakReason, start: Date.now() });
    setStatus('break');
    setShowBreakMenu(false);
  }, []);

  const handleEndBreak = useCallback(async () => {
    const start = breakState?.start;
    const reason = breakState?.reason;
    // Always call backend when ending a break so agent_status is updated (LOGGEDIN, break_name cleared).
    // Otherwise live monitoring and wallboard keep showing the agent on break.
    if (start != null) {
      try {
        await apiFetch('/api/agent/break/end', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ startTime: start, reason: reason || 'other' }),
        });
        if (useBackendSession) {
          setSessionBreaks((prev) => [...prev, { start, end: Date.now(), reason: reason || 'other' }]);
        } else {
          const breaks = getStoredBreaks();
          breaks.push({ start, end: Date.now(), reason: reason || 'other' });
          localStorage.setItem(AGENT_SESSION_BREAKS_KEY, JSON.stringify(breaks));
        }
      } catch (_) {}
    }
    setBreakState(null);
    setStatus('available');
  }, [breakState?.start, breakState?.reason, useBackendSession]);

  const handleTransferSubmit = useCallback(async () => {
    if (!transferTarget.trim() || !transferType) return;
    setCallError(null);
    try {
      const res = await apiFetch('/api/agent/calls/transfer', {
        method: 'POST',
        body: JSON.stringify({ target: transferTarget.trim(), type: transferType }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCallError(data.error || 'Transfer failed');
        return;
      }
      setTransferModalOpen(false);
      setTransferTarget('');
      setTransferType(null);
    } catch (_) {
      setCallError('Transfer failed');
    }
  }, [transferTarget, transferType]);

  const handleCrmSearch = useCallback(async () => {
    const id = crmSearchInput.trim();
    if (!id) return;
    setCrmSearching(true);
    setCrmResult(null);
    try {
      // Backend will add GET /api/agent/crm?customer_id=...
      const res = await apiFetch(`/api/agent/crm?customer_id=${encodeURIComponent(id)}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success && data.customer) {
        setCrmResult(data.customer);
      } else {
        setCrmResult({ error: data.error || 'Not found' });
      }
    } catch (_) {
      setCrmResult({ error: 'Search failed. Backend not ready.' });
    }
    setCrmSearching(false);
  }, [crmSearchInput]);

  // Auto-answer: when an incoming call arrives, immediately answer it (no manual pickup)
  const autoAnswerRef = useRef(false);
  useEffect(() => {
    if (!incomingCall || autoAnswerRef.current) return;
    autoAnswerRef.current = true;
    (async () => {
      setCallError(null);
      try {
        const res = await apiFetch('/api/agent/calls/answer', {
          method: 'POST',
          body: JSON.stringify({ channel_id: incomingCall.customerChannelId || incomingCall.channelId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setCallError(data.error || 'Auto-answer failed');
          autoAnswerRef.current = false;
          return;
        }
        setIncomingCall(null);
        setActiveCall({
          number: incomingCall.customerNumber,
          direction: 'inbound',
          start: new Date(),
        });
        setStatus('on-call');
        setCallState('connected');
      } catch (_) {
        setCallError('Auto-answer failed');
      }
      autoAnswerRef.current = false;
    })();
  }, [incomingCall]);



  const handleHold = useCallback(async () => {
    setCallError(null);
    try {
      const res = await apiFetch('/api/agent/calls/hold', { method: 'POST', body: JSON.stringify({}) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCallError(data.error || 'Hold failed');
        return;
      }
      setCallState('on_hold');
    } catch (_) {
      setCallError('Hold failed');
    }
  }, []);

  const handleUnhold = useCallback(async () => {
    setCallError(null);
    try {
      const res = await apiFetch('/api/agent/calls/unhold', { method: 'POST', body: JSON.stringify({}) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCallError(data.error || 'Resume failed');
        return;
      }
      setCallState('connected');
    } catch (_) {
      setCallError('Resume failed');
    }
  }, []);

  const handleChangePasswordSubmit = useCallback(async () => {
    setChangePasswordError(null);
    setChangePasswordSuccess(false);
    if (!currentPassword.trim()) {
      setChangePasswordError('Enter your current password');
      return;
    }
    if (newPassword.length < 6) {
      setChangePasswordError('New password must be at least 6 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      setChangePasswordError('New password and confirmation do not match');
      return;
    }
    setChangePasswordLoading(true);
    try {
      const res = await apiFetch('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setChangePasswordError(data.error || 'Failed to change password');
        setChangePasswordLoading(false);
        return;
      }
      setChangePasswordSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setChangePasswordLoading(false);
      setTimeout(() => {
        setChangePasswordOpen(false);
        setChangePasswordSuccess(false);
      }, 1500);
    } catch (_) {
      setChangePasswordError('Failed to change password');
      setChangePasswordLoading(false);
    }
  }, [currentPassword, newPassword, confirmPassword]);

  const handleCall = useCallback(async () => {
    if (!dialNumber.trim()) return;
    setCallError(null);
    try {
      const res = await apiFetch('/api/agent/calls/dial', {
        method: 'POST',
        body: JSON.stringify({ number: dialNumber.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCallError(data.error || 'Dial failed');
        return;
      }
      setActiveCall({ number: dialNumber.trim(), direction: 'outbound', start: new Date() });
      setStatus('on-call');
      setCallState('connected');
      setRecentCalls((prev) => [{ number: dialNumber, time: new Date(), direction: 'outbound' }, ...prev.slice(0, 9)]);
    } catch (_) {
      setCallError('Dial failed');
    }
  }, [dialNumber]);

  if (!statusCheckDone) {
    return (
      <Layout title="Agent" subtitle="Loading…">
        <div className="agent-dashboard"><p className="agent-loading">Loading…</p></div>
      </Layout>
    );
  }

  if (!extensionSelected) {
    return <AgentExtensionSelect onSelected={() => setExtensionSelected(true)} />;
  }

  const currentStatusOpt = STATUS_OPTIONS.find((o) => o.value === status) || STATUS_OPTIONS[0];

  return (
    <Layout title="Agent" subtitle="PBX Call Centre — Agent Dashboard">
      <div className="agent-dashboard">
        {/* Top bar: session info + main actions */}
        <header className="agent-topbar">
          <div className="agent-topbar-left">
            <span className="agent-login-timer" title="Login time (matches Live Monitoring)">
              🕐 {loginTimeDisplay}
            </span>
            <span
              className="agent-status-badge"
              style={{ borderColor: currentStatusOpt.color, color: currentStatusOpt.color }}
            >
              <span className="agent-status-badge-dot" style={{ background: currentStatusOpt.color }} />
              {currentStatusOpt.label}
            </span>
          </div>
          <div className="agent-topbar-actions">
            {onCall && (
              <button type="button" className="agent-action-btn agent-action-hangup" onClick={handleHangup}>
                Hang up
              </button>
            )}
            {!breakState ? (
              <div className="agent-break-wrap" ref={breakWrapRef}>
                <button
                  type="button"
                  className="agent-action-btn agent-action-break"
                  disabled={onCall}
                  onClick={() => !onCall && setShowBreakMenu((v) => !v)}
                  title={onCall ? 'Available when call ends' : ''}
                >
                  Take break
                </button>
                {showBreakMenu && !onCall && (
                  <div className="agent-break-menu">
                    {BREAK_REASONS.map((r) => (
                      <button
                        key={r.value}
                        type="button"
                        className="agent-break-menu-item"
                        onClick={() => handleTakeBreak(r.value)}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <button type="button" className="agent-action-btn agent-action-end-break" onClick={handleEndBreak}>
                End break
              </button>
            )}
            {!breakState && status !== 'outbound' && (
              <button
                type="button"
                className="agent-action-btn agent-action-outbound"
                disabled={onCall}
                onClick={handleOutboundStart}
                title={onCall ? 'Available when call ends' : 'Switch to outbound mode to make outbound calls; no inbound queue calls will be offered'}
              >
                Make outbound call
              </button>
            )}
            {status === 'outbound' && (
              <button
                type="button"
                className="agent-action-btn agent-action-resume-inbound"
                onClick={handleOutboundEnd}
                title="Resume taking inbound queue calls"
              >
                Resume inbound
              </button>
            )}
            <button
              type="button"
              className="agent-action-btn agent-action-transfer"
              onClick={() => setTransferModalOpen(true)}
              disabled={!onCall}
              title={!onCall ? 'Transfer available during a call' : ''}
            >
              Transfer
            </button>
            <button type="button" className="agent-action-btn agent-action-change-password" onClick={() => setChangePasswordOpen(true)}>
              Change password
            </button>
            <button type="button" className="agent-action-btn agent-action-end-session" onClick={handleEndSession}>
              End session
            </button>
          </div>
        </header>

        {/* Break reason dropdown: when "Take break" is clicked we need a small menu - simplified: clicking "Take break" sets break with default reason; we can add a dropdown later */}
        {/* For now "Take break" directly starts break. Optional: add a popover for reason. */}
        {/* I'll change Take break to open a tiny menu for reason, then start break */}
        {/* Simplified: one "Take break" that sets reason to "other" and starts break. "End break" ends it. */}

        <main className="agent-main">
          <div className="agent-grid">
            {/* Left: Call information */}
            <section className="agent-call-info-panel">
              <h2 className="agent-panel-title">Call information</h2>
              <div className="agent-call-info-cards">
                <div className="agent-call-card agent-call-inbound">
                  <h3>Inbound</h3>
                  <dl>
                    <dt>Campaign</dt>
                    <dd>{inboundInfo.campaignName}</dd>
                    <dt>CLI</dt>
                    <dd>{inboundInfo.cli}</dd>
                    <dt>Last call</dt>
                    <dd>{inboundInfo.lastCall}</dd>
                  </dl>
                </div>
                <div className="agent-call-card agent-call-outbound">
                  <h3>Outbound</h3>
                  <dl>
                    <dt>Campaign</dt>
                    <dd>{outboundInfo.campaignName}</dd>
                    <dt>CLI</dt>
                    <dd>{outboundInfo.cli}</dd>
                    <dt>Last call</dt>
                    <dd>{outboundInfo.lastCall}</dd>
                  </dl>
                </div>
              </div>
              {/* Incoming call — auto-answered, show connecting indicator */}
              {incomingCall && (
                <div className="agent-incoming-popup">
                  <h3>Incoming call</h3>
                  <p className="agent-incoming-campaign">Campaign: {incomingCall.campaignName || incomingCall.queueName || 'Inbound'}</p>
                  <p className="agent-incoming-number">{incomingCall.customerNumber}</p>
                  {incomingCall.queueName && (
                    <p className="agent-incoming-queue">Queue: {incomingCall.queueName}</p>
                  )}
                  <p className="agent-incoming-connecting">Connecting...</p>
                </div>
              )}
              {/* Active call detail */}
              {onCall && (
                <div className="agent-active-call-detail">
                  <h3>Active call</h3>
                  <div className="agent-active-call-fields">
                    <span className="agent-active-call-dir">{activeCall.direction}</span>
                    <span className="agent-active-call-number">{activeCall.number}</span>
                    <span className="agent-active-call-duration">
                      {formatDuration(Date.now() - activeCall.start)}
                    </span>
                    {callState && (
                      <span className="agent-call-state">
                        {callState === 'on_hold' ? 'On Hold' : callState === 'connected' ? 'Connected' : callState}
                      </span>
                    )}
                  </div>
                  <div className="agent-active-call-actions">
                    {callState === 'on_hold' ? (
                      <button type="button" className="btn-resume" onClick={handleUnhold}>
                        Resume
                      </button>
                    ) : (
                      <button type="button" className="btn-hold" onClick={handleHold} disabled={!activeCall}>
                        Hold
                      </button>
                    )}
                    <button type="button" className="btn-hangup-inline" onClick={handleHangup}>
                      Hang up
                    </button>
                  </div>
                </div>
              )}
              {callError && <p className="agent-call-error">{callError}</p>}
              {!onCall && !incomingCall && status === 'available' && (
                <div className="agent-ready-placeholder">
                  <p>Ready to take calls</p>
                </div>
              )}
              {!onCall && !incomingCall && status === 'outbound' && (
                <div className="agent-ready-placeholder">
                  <p>Outbound mode – use the dial pad below to make calls</p>
                  <p className="agent-outbound-hint">No inbound queue calls will be offered until you click &quot;Resume inbound&quot;</p>
                </div>
              )}
            </section>

            {/* Right: CRM / Tracker search */}
            <section className="agent-crm-panel">
              <h2 className="agent-panel-title">CRM / Tracker search</h2>
              <div className="agent-crm-search">
                <input
                  type="text"
                  className="agent-crm-input"
                  placeholder="Customer ID"
                  value={crmSearchInput}
                  onChange={(e) => setCrmSearchInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCrmSearch()}
                />
                <button
                  type="button"
                  className="agent-crm-search-btn"
                  onClick={handleCrmSearch}
                  disabled={crmSearching || !crmSearchInput.trim()}
                >
                  {crmSearching ? 'Searching…' : 'Search'}
                </button>
              </div>
              <div className="agent-crm-result">
                {crmResult === null && !crmSearching && (
                  <p className="agent-crm-empty">Enter customer ID and click Search.</p>
                )}
                {crmSearching && <p className="agent-crm-loading">Loading…</p>}
                {crmResult && crmResult.error && (
                  <p className="agent-crm-error">{crmResult.error}</p>
                )}
                {crmResult && !crmResult.error && (
                  <div className="agent-crm-data">
                    <p><strong>Name:</strong> {crmResult.name ?? '—'}</p>
                    <p><strong>Phone:</strong> {crmResult.phone ?? '—'}</p>
                    {crmResult.email != null && <p><strong>Email:</strong> {crmResult.email}</p>}
                    {crmResult.notes != null && <p><strong>Notes:</strong> {crmResult.notes}</p>}
                  </div>
                )}
              </div>
            </section>
          </div>

          {/* Dial pad – only in outbound mode */}
          {status === 'outbound' && (
            <section className="agent-dial-panel">
              <h3>Dial pad</h3>
              <input
                type="tel"
                className="dial-display dial-display-input"
                placeholder="Enter number or paste"
                value={dialNumber}
                onChange={(e) => {
                  const raw = e.target.value;
                  const filtered = raw.replace(/[^\d*#+]/g, '');
                  setDialNumber(filtered);
                }}
                aria-label="Phone number to dial"
              />
              <div className="dialpad">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((d) => (
                  <button
                    key={d}
                    type="button"
                    className="dial-key"
                    onClick={() => setDialNumber((prev) => prev + d)}
                  >
                    {d}
                  </button>
                ))}
              </div>
              <div className="dial-actions">
                <button
                  type="button"
                  className="btn-backspace"
                  onClick={() => setDialNumber((prev) => prev.slice(0, -1))}
                  title="Backspace"
                >
                  ⌫
                </button>
                <button
                  type="button"
                  className="btn-call"
                  onClick={handleCall}
                  disabled={!dialNumber.trim()}
                >
                  Call
                </button>
              </div>
            </section>
          )}
        </main>

        {/* Change password modal */}
        {changePasswordOpen && (
          <div className="agent-modal-overlay" onClick={() => !changePasswordLoading && setChangePasswordOpen(false)}>
            <div className="agent-modal agent-modal-password" onClick={(e) => e.stopPropagation()}>
              <h3>Change password</h3>
              <p className="agent-modal-hint">You can change only your own password.</p>
              <div className="agent-password-fields">
                <input
                  type="password"
                  className="agent-transfer-input"
                  placeholder="Current password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  disabled={changePasswordLoading}
                  autoComplete="current-password"
                />
                <input
                  type="password"
                  className="agent-transfer-input"
                  placeholder="New password (min 6 characters)"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  disabled={changePasswordLoading}
                  autoComplete="new-password"
                />
                <input
                  type="password"
                  className="agent-transfer-input"
                  placeholder="Confirm new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  disabled={changePasswordLoading}
                  autoComplete="new-password"
                />
              </div>
              {changePasswordError && <p className="agent-password-error">{changePasswordError}</p>}
              {changePasswordSuccess && <p className="agent-password-success">Password changed successfully.</p>}
              <div className="agent-modal-actions">
                <button type="button" className="agent-modal-cancel" onClick={() => !changePasswordLoading && setChangePasswordOpen(false)} disabled={changePasswordLoading}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="agent-modal-confirm"
                  onClick={handleChangePasswordSubmit}
                  disabled={changePasswordLoading}
                >
                  {changePasswordLoading ? 'Updating…' : 'Update password'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Transfer modal */}
        {transferModalOpen && (
          <div className="agent-modal-overlay" onClick={() => setTransferModalOpen(false)}>
            <div className="agent-modal" onClick={(e) => e.stopPropagation()}>
              <h3>Transfer call</h3>
              <input
                type="text"
                className="agent-transfer-input"
                placeholder="Number or extension"
                value={transferTarget}
                onChange={(e) => setTransferTarget(e.target.value)}
              />
              <div className="agent-transfer-types">
                <button
                  type="button"
                  className={`agent-transfer-btn ${transferType === 'blind' ? 'active' : ''}`}
                  onClick={() => setTransferType('blind')}
                >
                  Blind transfer
                </button>
                <button
                  type="button"
                  className={`agent-transfer-btn ${transferType === 'attended' ? 'active' : ''}`}
                  onClick={() => setTransferType('attended')}
                >
                  Attended transfer
                </button>
              </div>
              <div className="agent-modal-actions">
                <button type="button" className="agent-modal-cancel" onClick={() => setTransferModalOpen(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="agent-modal-confirm"
                  onClick={handleTransferSubmit}
                  disabled={!transferTarget.trim() || !transferType}
                >
                  Transfer
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Take break menu is inline in top bar */}
      </div>
    </Layout>
  );
}

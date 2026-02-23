import { useState, useEffect } from 'react';
import Layout from '../components/Layout';
import AgentExtensionSelect from './AgentExtensionSelect';
import './Agent.css';

const API_BASE = import.meta.env.VITE_API_URL || '';
async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, { ...options, credentials: 'include', headers: { 'Content-Type': 'application/json', ...options.headers } });
  return res;
}

const STATUS_OPTIONS = [
  { value: 'available', label: 'Available', color: '#22c55e' },
  { value: 'on-call', label: 'On call', color: '#3b82f6' },
  { value: 'break', label: 'Break', color: '#eab308' },
  { value: 'away', label: 'Away', color: '#64748b' },
];

const SAMPLE_CONTACTS = [
  { id: 1, name: 'John Smith', number: '+1 555 0100' },
  { id: 2, name: 'Jane Doe', number: '+1 555 0101' },
  { id: 3, name: 'Acme Corp', number: '+1 555 0102' },
];

export default function Agent() {
  const [extensionSelected, setExtensionSelected] = useState(false);
  const [statusCheckDone, setStatusCheckDone] = useState(false);
  const [status, setStatus] = useState('available');
  const [dialNumber, setDialNumber] = useState('');
  const [activeCall, setActiveCall] = useState(null);
  const [recentCalls, setRecentCalls] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/agent/status');
        const data = await res.json().catch(() => ({}));
        if (!cancelled && data.success && data.extensionSelected) {
          setExtensionSelected(true);
        }
      } catch (_) {}
      if (!cancelled) setStatusCheckDone(true);
    })();
    return () => { cancelled = true; };
  }, []);

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

  const handleDial = (digit) => {
    setDialNumber((prev) => prev + digit);
  };

  const handleBackspace = () => {
    setDialNumber((prev) => prev.slice(0, -1));
  };

  const handleCall = () => {
    if (!dialNumber.trim()) return;
    setActiveCall({ number: dialNumber, direction: 'outbound', start: new Date() });
    setRecentCalls((prev) => [{ number: dialNumber, time: new Date(), direction: 'outbound' }, ...prev.slice(0, 9)]);
  };

  const handleHangup = () => {
    setActiveCall(null);
  };

  const handleAnswer = () => {
    setActiveCall({ number: 'Incoming', direction: 'inbound', start: new Date() });
    setStatus('on-call');
  };

  const handleContactDial = (contact) => {
    setDialNumber(contact.number);
  };

  return (
    <Layout title="Agent" subtitle="PBX Call Centre — Take & make calls">
      <div className="agent-dashboard">
        <div className="agent-grid">
          <section className="agent-status-panel">
            <h3>Status</h3>
            <div className="status-buttons">
              {STATUS_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`status-btn ${status === opt.value ? 'active' : ''}`}
                  style={status === opt.value ? { borderColor: opt.color, color: opt.color } : {}}
                  onClick={() => setStatus(opt.value)}
                >
                  <span className="status-dot" style={{ background: opt.color }} />
                  {opt.label}
                </button>
              ))}
            </div>
            {activeCall && (
              <div className="active-call-card">
                <div className="call-info">
                  <span className="call-direction">{activeCall.direction}</span>
                  <span className="call-number">{activeCall.number}</span>
                  <span className="call-duration">
                    {Math.floor((new Date() - activeCall.start) / 60)}:{(Math.floor((new Date() - activeCall.start) / 1) % 60).toString().padStart(2, '0')}
                  </span>
                </div>
                <button type="button" className="btn-hangup" onClick={handleHangup}>
                  Hang up
                </button>
              </div>
            )}
            {!activeCall && status === 'available' && (
              <div className="incoming-placeholder">
                <p>Ready to take calls</p>
                <button type="button" className="btn-answer-demo" onClick={handleAnswer}>
                  Simulate incoming call
                </button>
              </div>
            )}
          </section>

          <section className="agent-dial-panel">
            <h3>Dial pad</h3>
            <div className="dial-display">{dialNumber || 'Enter number'}</div>
            <div className="dialpad">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((d) => (
                <button key={d} type="button" className="dial-key" onClick={() => handleDial(d)}>
                  {d}
                </button>
              ))}
            </div>
            <div className="dial-actions">
              <button type="button" className="btn-backspace" onClick={handleBackspace} title="Backspace">
                ⌫
              </button>
              <button type="button" className="btn-call" onClick={handleCall} disabled={!dialNumber.trim()}>
                Call
              </button>
            </div>
          </section>

          <section className="agent-contacts-panel">
            <h3>Contacts</h3>
            <ul className="contact-list">
              {SAMPLE_CONTACTS.map((c) => (
                <li key={c.id} className="contact-item">
                  <div>
                    <div className="contact-name">{c.name}</div>
                    <div className="contact-number">{c.number}</div>
                  </div>
                  <button type="button" className="btn-call-contact" onClick={() => handleContactDial(c)} title="Dial">
                    Call
                  </button>
                </li>
              ))}
            </ul>
            <h3 className="recent-title">Recent</h3>
            <ul className="recent-list">
              {recentCalls.length === 0 && <li className="recent-empty">No recent calls</li>}
              {recentCalls.map((call, i) => (
                <li key={i} className="recent-item">
                  <span className={`recent-dir ${call.direction}`}>{call.direction}</span>
                  <span className="recent-num">{call.number}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </Layout>
  );
}

import { memo, useEffect, useRef } from 'react';

const CDRView = memo(function CDRView({
  list, total, page, totalPages, loading, tableMissing, error,
  from, to, caller, didTfn, agent, queue, direction, status,
  onFromChange, onToChange, onCallerChange, onDidTfnChange, onAgentChange, onQueueChange, onDirectionChange, onStatusChange,
  onPageChange, onRefresh, onDownload,
  playingRecordingId, recordingAudioUrl, onPlayRecording, onStopRecording,
}) {
  const audioRef = useRef(null);
  useEffect(() => {
    if (recordingAudioUrl && audioRef.current) {
      audioRef.current.src = recordingAudioUrl;
      audioRef.current.play().catch(() => {});
    }
  }, [recordingAudioUrl]);

  const formatDt = (v) => (v ? new Date(v).toLocaleString() : '—');
  const formatSec = (s) => (s != null && s >= 0 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '—');

  return (
    <>
      <h2 className="superadmin-section-title">CDR & Recordings</h2>
      {tableMissing ? (
        <div className="cdr-empty-state cdr-empty-state--error">
          <p><strong>Call records table is missing.</strong></p>
          <p>Run this migration on your MySQL database: <code>docs/migrations/002_phase3_call_records_realtime.sql</code></p>
          <p>Example: <code>mysql -u root -p pbx_callcentre &lt; docs/migrations/002_phase3_call_records_realtime.sql</code></p>
        </div>
      ) : (
        <>
          <p className="superadmin-sync-message">
            Call detail records and playback. Set RECORDINGS_BASE_PATH (or ASTERISK_RECORDING_PATH) on the server so recordings can be streamed.
          </p>
          {error && (
            <div className="cdr-empty-state cdr-empty-state--error">
              <p><strong>CDR load failed:</strong> {error}</p>
            </div>
          )}
        </>
      )}

      <div className="cdr-filters">
        <label className="cdr-filter-label">
          From
          <input type="date" className="cdr-input" value={from} onChange={(e) => onFromChange(e.target.value)} />
        </label>
        <label className="cdr-filter-label">
          To
          <input type="date" className="cdr-input" value={to} onChange={(e) => onToChange(e.target.value)} />
        </label>
        <label className="cdr-filter-label">
          Caller
          <input type="text" className="cdr-input" placeholder="Caller number" value={caller} onChange={(e) => onCallerChange(e.target.value)} />
        </label>
        <label className="cdr-filter-label">
          DID/TFN
          <input type="text" className="cdr-input" placeholder="DID or TFN" value={didTfn} onChange={(e) => onDidTfnChange(e.target.value)} />
        </label>
        <label className="cdr-filter-label">
          Agent
          <input type="text" className="cdr-input" placeholder="Extension or name" value={agent} onChange={(e) => onAgentChange(e.target.value)} />
        </label>
        <label className="cdr-filter-label">
          Queue
          <input type="text" className="cdr-input" placeholder="Queue name" value={queue} onChange={(e) => onQueueChange(e.target.value)} />
        </label>
        <label className="cdr-filter-label">
          Direction
          <select className="superadmin-select cdr-select" value={direction} onChange={(e) => onDirectionChange(e.target.value)}>
            <option value="">All</option>
            <option value="inbound">Inbound</option>
            <option value="outbound">Outbound</option>
          </select>
        </label>
        <label className="cdr-filter-label">
          Status
          <select className="superadmin-select cdr-select" value={status} onChange={(e) => onStatusChange(e.target.value)}>
            <option value="">All</option>
            <option value="answered">Answered</option>
            <option value="abandoned">Abandoned</option>
            <option value="transferred">Transferred</option>
            <option value="failed">Failed</option>
          </select>
        </label>
        <button type="button" className="superadmin-add-btn cdr-refresh-btn" onClick={() => onRefresh(1)}>Search</button>
        <button type="button" className="superadmin-add-btn cdr-download-btn" onClick={onDownload}>Download CDR</button>
      </div>

      {recordingAudioUrl && (
        <div className="cdr-audio-bar">
          <audio ref={audioRef} controls onEnded={onStopRecording} />
          <button type="button" className="cdr-stop-btn" onClick={onStopRecording}>Stop</button>
        </div>
      )}

      {loading && <p className="superadmin-loading">Loading CDR…</p>}
      <div className="cdr-table-wrap">
        <table className="superadmin-table cdr-table">
          <thead>
            <tr>
              <th>Start</th>
              <th>Caller</th>
              <th>Destination</th>
              <th>DID/TFN</th>
              <th>Agent</th>
              <th>Queue</th>
              <th>Direction</th>
              <th>Duration</th>
              <th>Talk</th>
              <th>Wait</th>
              <th>Status</th>
              <th>Details</th>
              <th>Recording</th>
            </tr>
          </thead>
          <tbody>
            {!loading && list.length === 0 && !tableMissing && (
              <tr>
                <td colSpan={13} className="cdr-empty">
                  <span className="cdr-empty-title">No call records yet.</span>
                  <span className="cdr-empty-hint">Records are created when: (1) inbound/queue calls use the Stasis app or when the dialplan calls the app&apos;s IncomingCall URL, or (2) agents make outbound calls from the console.</span>
                </td>
              </tr>
            )}
            {list.map((row) => {
              const statusCls = row.status === 'abandoned' ? 'cdr-status-abandoned' :
                row.transfer_status === 1 ? 'cdr-status-transferred' :
                row.status === 'failed' ? 'cdr-status-failed' : '';
              const details = row.transfer_status === 1
                ? `Transfer: ${row.transfer_from || '?'} → ${row.transfer_to || '?'}${row.transfer_type ? ` (${row.transfer_type})` : ''}`
                : row.abandon_reason
                  ? `Abandon: ${row.abandon_reason}${row.failover_destination ? ` → ${row.failover_destination}` : ''}`
                  : '—';
              return (
                <tr key={row.unique_id || row.id} className={statusCls}>
                  <td>{formatDt(row.start_time)}</td>
                  <td>{row.source_number || '—'}</td>
                  <td>{row.destination_number || '—'}</td>
                  <td>{row.did_tfn || '—'}</td>
                  <td>{row.agent_name}</td>
                  <td>{row.queue_name || '—'}</td>
                  <td>{row.direction || '—'}</td>
                  <td>{formatSec(row.duration_sec)}</td>
                  <td>{formatSec(row.talk_sec)}</td>
                  <td>{formatSec(row.wait_time_sec)}</td>
                  <td>{row.status || '—'}</td>
                  <td className="cdr-details" title={details}>{details}</td>
                  <td>
                    {row.has_recording ? (
                      <button
                        type="button"
                        className={`cdr-play-btn ${playingRecordingId === row.unique_id ? 'cdr-playing' : ''}`}
                        onClick={() => onPlayRecording(row.unique_id)}
                      >
                        {playingRecordingId === row.unique_id ? 'Stop' : 'Play'}
                      </button>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="cdr-pagination">
        <span className="cdr-pagination-info">
          {total} call(s) · page {page} of {totalPages}
        </span>
        <div className="cdr-pagination-btns">
          <button type="button" className="superadmin-add-btn cdr-page-btn" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>Prev</button>
          <button type="button" className="superadmin-add-btn cdr-page-btn" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>Next</button>
        </div>
      </div>
    </>
  );
});

export default CDRView;

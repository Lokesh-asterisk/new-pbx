-- Migration 017: Agent sessions and agent status log for performance monitoring.
-- Run after 001 (session_started_at on agent_status). USE pbx_callcentre;
--
-- agent_sessions: one row per login→logout session (session_duration, logout_reason).
-- agent_status_log: one row per state transition (READY, RINGING, IN_CALL, WRAP_UP, PAUSED, LOGOUT) with start/end/duration.

-- ==========================================
-- agent_sessions
-- ==========================================
CREATE TABLE IF NOT EXISTS agent_sessions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  agent_id VARCHAR(32) NOT NULL COMMENT 'phone_login_number / extension identifier',
  agent_user_id INT UNSIGNED DEFAULT NULL COMMENT 'users.id when known',
  login_time DATETIME NOT NULL,
  logout_time DATETIME DEFAULT NULL,
  session_duration_sec INT UNSIGNED DEFAULT NULL COMMENT 'seconds from login to logout',
  logout_reason VARCHAR(32) DEFAULT NULL COMMENT 'normal, forced, connection_lost',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tenant_agent (tenant_id, agent_id),
  INDEX idx_tenant_login (tenant_id, login_time),
  INDEX idx_agent_login (agent_id, login_time),
  INDEX idx_logout_null (agent_id, logout_time) COMMENT 'find open session where logout_time IS NULL'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==========================================
-- agent_status_log
-- ==========================================
CREATE TABLE IF NOT EXISTS agent_status_log (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  session_id INT UNSIGNED DEFAULT NULL COMMENT 'FK to agent_sessions when session exists',
  tenant_id INT UNSIGNED NOT NULL,
  agent_id VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL COMMENT 'LOGIN, READY, RINGING, IN_CALL, WRAP_UP, PAUSED, LOGOUT',
  start_time DATETIME NOT NULL,
  end_time DATETIME DEFAULT NULL,
  duration_sec INT UNSIGNED DEFAULT NULL,
  pause_reason VARCHAR(64) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_session (session_id),
  INDEX idx_tenant_agent_time (tenant_id, agent_id, start_time),
  INDEX idx_agent_end_null (agent_id, end_time) COMMENT 'find open log row where end_time IS NULL'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

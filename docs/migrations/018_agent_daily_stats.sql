-- Migration 018: Agent daily stats for fast reporting (pre-aggregated by date + agent).
-- Run after 017 (agent_sessions, agent_status_log). USE pbx_callcentre;

CREATE TABLE IF NOT EXISTS agent_daily_stats (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  agent_id VARCHAR(32) NOT NULL COMMENT 'phone_login_number',
  agent_user_id INT UNSIGNED DEFAULT NULL,
  stat_date DATE NOT NULL,
  calls_answered INT UNSIGNED NOT NULL DEFAULT 0,
  calls_missed INT UNSIGNED NOT NULL DEFAULT 0,
  talk_time_sec INT UNSIGNED NOT NULL DEFAULT 0,
  wrap_time_sec INT UNSIGNED NOT NULL DEFAULT 0,
  pause_time_sec INT UNSIGNED NOT NULL DEFAULT 0,
  login_time_sec INT UNSIGNED NOT NULL DEFAULT 0,
  occupancy DECIMAL(5,4) DEFAULT NULL COMMENT '0-1 ratio (talk+wrap)/login',
  avg_handle_time_sec INT UNSIGNED DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_tenant_agent_date (tenant_id, agent_id, stat_date),
  INDEX idx_tenant_date (tenant_id, stat_date),
  INDEX idx_agent_date (agent_id, stat_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

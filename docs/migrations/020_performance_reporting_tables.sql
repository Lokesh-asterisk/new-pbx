-- 020_performance_reporting_tables.sql
-- Aggregated reporting tables for agent performance analytics.
-- Depends on: 017 (agent_sessions, agent_status_log), 018 (agent_daily_stats)

-- Hourly stats for granular intraday analysis and trend charts
CREATE TABLE IF NOT EXISTS agent_hourly_stats (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id       INT UNSIGNED NOT NULL,
  agent_id        VARCHAR(32) NOT NULL,
  agent_user_id   INT UNSIGNED,
  stat_date       DATE NOT NULL,
  stat_hour       TINYINT UNSIGNED NOT NULL,
  calls_answered  INT UNSIGNED NOT NULL DEFAULT 0,
  calls_missed    INT UNSIGNED NOT NULL DEFAULT 0,
  talk_time_sec   INT UNSIGNED NOT NULL DEFAULT 0,
  wrap_time_sec   INT UNSIGNED NOT NULL DEFAULT 0,
  pause_time_sec  INT UNSIGNED NOT NULL DEFAULT 0,
  ready_time_sec  INT UNSIGNED NOT NULL DEFAULT 0,
  login_time_sec  INT UNSIGNED NOT NULL DEFAULT 0,
  occupancy       DECIMAL(5,4) DEFAULT NULL,
  avg_handle_time_sec INT UNSIGNED DEFAULT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_tenant_agent_date_hour (tenant_id, agent_id, stat_date, stat_hour),
  INDEX idx_tenant_date_hour (tenant_id, stat_date, stat_hour),
  INDEX idx_agent_date (agent_id, stat_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Break-level stats for discipline monitoring
CREATE TABLE IF NOT EXISTS agent_break_stats (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id       INT UNSIGNED NOT NULL,
  agent_id        VARCHAR(32) NOT NULL,
  agent_user_id   INT UNSIGNED,
  stat_date       DATE NOT NULL,
  break_type      VARCHAR(64) NOT NULL DEFAULT 'Unknown',
  break_count     INT UNSIGNED NOT NULL DEFAULT 0,
  total_duration_sec INT UNSIGNED NOT NULL DEFAULT 0,
  avg_duration_sec INT UNSIGNED DEFAULT NULL,
  max_duration_sec INT UNSIGNED DEFAULT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_tenant_agent_date_break (tenant_id, agent_id, stat_date, break_type),
  INDEX idx_tenant_date (tenant_id, stat_date),
  INDEX idx_agent_date (agent_id, stat_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Queue daily stats for queue-based analysis
CREATE TABLE IF NOT EXISTS queue_daily_stats (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id       INT UNSIGNED NOT NULL,
  queue_name      VARCHAR(64) NOT NULL,
  stat_date       DATE NOT NULL,
  calls_offered   INT UNSIGNED NOT NULL DEFAULT 0,
  calls_answered  INT UNSIGNED NOT NULL DEFAULT 0,
  calls_abandoned INT UNSIGNED NOT NULL DEFAULT 0,
  calls_transferred INT UNSIGNED NOT NULL DEFAULT 0,
  total_talk_sec  INT UNSIGNED NOT NULL DEFAULT 0,
  total_wait_sec  INT UNSIGNED NOT NULL DEFAULT 0,
  avg_wait_sec    INT UNSIGNED DEFAULT NULL,
  avg_talk_sec    INT UNSIGNED DEFAULT NULL,
  max_wait_sec    INT UNSIGNED DEFAULT NULL,
  service_level   DECIMAL(5,2) DEFAULT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_tenant_queue_date (tenant_id, queue_name, stat_date),
  INDEX idx_tenant_date (tenant_id, stat_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Extend agent_daily_stats with additional performance columns (sales, score, ready_time).
-- MySQL < 10.0 / MariaDB < 10.0.2 does not support ADD COLUMN IF NOT EXISTS,
-- so we use a stored procedure to add columns safely.

DROP PROCEDURE IF EXISTS _add_col_if_missing;

DELIMITER $$
CREATE PROCEDURE _add_col_if_missing(
  IN tbl VARCHAR(64),
  IN col VARCHAR(64),
  IN col_def VARCHAR(255)
)
BEGIN
  SET @exists = (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col
  );
  IF @exists = 0 THEN
    SET @sql = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', col_def);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

CALL _add_col_if_missing('agent_daily_stats', 'calls_offered',     'INT UNSIGNED NOT NULL DEFAULT 0 AFTER calls_missed');
CALL _add_col_if_missing('agent_daily_stats', 'calls_transferred', 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER calls_offered');
CALL _add_col_if_missing('agent_daily_stats', 'sales_count',       'INT UNSIGNED NOT NULL DEFAULT 0 AFTER calls_transferred');
CALL _add_col_if_missing('agent_daily_stats', 'ready_time_sec',    'INT UNSIGNED NOT NULL DEFAULT 0 AFTER wrap_time_sec');
CALL _add_col_if_missing('agent_daily_stats', 'performance_score', 'DECIMAL(5,2) DEFAULT NULL AFTER avg_handle_time_sec');

DROP PROCEDURE IF EXISTS _add_col_if_missing;

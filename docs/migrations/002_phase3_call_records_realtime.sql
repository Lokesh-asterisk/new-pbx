-- Phase 3: Call records (CDR) and recording path.
-- Run after 001. USE pbx_callcentre;

-- Unified call records for inbound and outbound (CDR)
CREATE TABLE IF NOT EXISTS call_records (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  unique_id VARCHAR(64) NOT NULL,
  channel_id VARCHAR(128) DEFAULT NULL,
  source_number VARCHAR(32) DEFAULT NULL,
  destination_number VARCHAR(32) DEFAULT NULL,
  agent_user_id INT UNSIGNED DEFAULT NULL,
  agent_extension VARCHAR(32) DEFAULT NULL,
  agent_id VARCHAR(32) DEFAULT NULL,
  direction VARCHAR(16) NOT NULL DEFAULT 'inbound',
  queue_name VARCHAR(64) DEFAULT NULL,
  start_time DATETIME NOT NULL,
  answer_time DATETIME DEFAULT NULL,
  end_time DATETIME DEFAULT NULL,
  duration_sec INT UNSIGNED DEFAULT NULL,
  talk_sec INT UNSIGNED DEFAULT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'initiated',
  recording_path VARCHAR(512) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id),
  INDEX idx_agent_user (agent_user_id),
  INDEX idx_unique_id (unique_id),
  INDEX idx_start_time (start_time),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Optional: link agent_status to current call for quick lookup
-- ALTER TABLE agent_status ADD COLUMN current_call_unique_id VARCHAR(64) DEFAULT NULL;

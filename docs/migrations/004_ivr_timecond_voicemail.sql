-- Phase 1: IVR menu options table, time condition destination columns, voicemail greeting config.
-- Run after 003. USE pbx_callcentre;

-- IVR menu DTMF options (per-key routing)
CREATE TABLE IF NOT EXISTS ivr_menu_options (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ivr_menu_id INT UNSIGNED NOT NULL,
  dtmf_key VARCHAR(4) NOT NULL,
  destination_type VARCHAR(32) NOT NULL DEFAULT 'hangup',
  destination_id INT UNSIGNED DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_menu_key (ivr_menu_id, dtmf_key),
  INDEX idx_menu (ivr_menu_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add destination routing columns to time_conditions
ALTER TABLE time_conditions
  ADD COLUMN match_destination_type VARCHAR(32) DEFAULT 'hangup' AFTER time_group_id,
  ADD COLUMN match_destination_id INT UNSIGNED DEFAULT NULL AFTER match_destination_type,
  ADD COLUMN nomatch_destination_type VARCHAR(32) DEFAULT 'hangup' AFTER match_destination_id,
  ADD COLUMN nomatch_destination_id INT UNSIGNED DEFAULT NULL AFTER nomatch_destination_type;

-- Add transfer tracking columns to call_records
ALTER TABLE call_records
  ADD COLUMN transfer_status TINYINT UNSIGNED DEFAULT 0 AFTER recording_path,
  ADD COLUMN transfer_to VARCHAR(32) DEFAULT NULL AFTER transfer_status;

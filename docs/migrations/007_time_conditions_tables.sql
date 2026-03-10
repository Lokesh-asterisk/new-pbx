-- Time groups and time conditions tables (create if missing, e.g. when DB was set up from migrations only).
-- Run after 003. USE pbx_callcentre;

CREATE TABLE IF NOT EXISTS time_groups (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  name VARCHAR(64) NOT NULL,
  description VARCHAR(255) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS time_group_rules (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  time_group_id INT UNSIGNED NOT NULL,
  day_of_week TINYINT UNSIGNED DEFAULT NULL,
  start_time TIME DEFAULT NULL,
  end_time TIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_group (time_group_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS time_conditions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  name VARCHAR(64) NOT NULL,
  time_group_id INT UNSIGNED DEFAULT NULL,
  match_destination_type VARCHAR(32) DEFAULT 'hangup',
  match_destination_id INT UNSIGNED DEFAULT NULL,
  nomatch_destination_type VARCHAR(32) DEFAULT 'hangup',
  nomatch_destination_id INT UNSIGNED DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

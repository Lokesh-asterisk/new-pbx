-- Migration 005: Dynamic role-module access control
-- SuperAdmin (role=1) always has full access and is NOT stored in this table.
-- This table governs which modules are enabled for roles 2 (admin), 3 (user), 5 (agent).

CREATE TABLE IF NOT EXISTS role_modules (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  role       TINYINT UNSIGNED NOT NULL,
  module_key VARCHAR(64) NOT NULL,
  enabled    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_role_module (role, module_key),
  INDEX idx_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed defaults: admin gets dashboard + cdr + live_agents + wallboard
INSERT IGNORE INTO role_modules (role, module_key, enabled) VALUES
  (2, 'dashboard', 1),
  (2, 'live_agents', 1),
  (2, 'cdr', 1),
  (2, 'wallboard', 1),
  (2, 'tenants', 0),
  (2, 'users', 0),
  (2, 'extensions', 0),
  (2, 'trunks', 0),
  (2, 'inbound', 0),
  (2, 'outbound', 0),
  (2, 'queues', 0),
  (2, 'ivr', 0),
  (2, 'timeconditions', 0),
  (2, 'sounds', 0),
  (2, 'voicemail', 0),
  -- user role defaults
  (3, 'dashboard', 1),
  (3, 'live_agents', 0),
  (3, 'cdr', 0),
  (3, 'wallboard', 1),
  (3, 'tenants', 0),
  (3, 'users', 0),
  (3, 'extensions', 0),
  (3, 'trunks', 0),
  (3, 'inbound', 0),
  (3, 'outbound', 0),
  (3, 'queues', 0),
  (3, 'ivr', 0),
  (3, 'timeconditions', 0),
  (3, 'sounds', 0),
  (3, 'voicemail', 0),
  -- agent role defaults (agent has its own separate UI, but module flags can gate extra features)
  (5, 'dashboard', 0),
  (5, 'live_agents', 0),
  (5, 'cdr', 0),
  (5, 'wallboard', 0),
  (5, 'tenants', 0),
  (5, 'users', 0),
  (5, 'extensions', 0),
  (5, 'trunks', 0),
  (5, 'inbound', 0),
  (5, 'outbound', 0),
  (5, 'queues', 0),
  (5, 'ivr', 0),
  (5, 'timeconditions', 0),
  (5, 'sounds', 0),
  (5, 'voicemail', 0);

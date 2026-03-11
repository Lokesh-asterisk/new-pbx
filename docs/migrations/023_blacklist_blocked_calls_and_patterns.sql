-- Blacklist: blocked-call logging + advanced match patterns (prefix, suffix, contains, regex).
-- Run after 011_blacklist. USE pbx_callcentre;

-- 1) Log each blocked call for reporting (historical + live)
CREATE TABLE IF NOT EXISTS blacklist_blocked_calls (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  caller_number VARCHAR(32) NOT NULL,
  did VARCHAR(32) DEFAULT NULL,
  blacklist_entry_id INT UNSIGNED DEFAULT NULL,
  blocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tenant_blocked_at (tenant_id, blocked_at),
  INDEX idx_caller (caller_number(16)),
  INDEX idx_blocked_at (blocked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2) Add match_type and unique key via procedure (only drop/add if needed)
DELIMITER //
DROP PROCEDURE IF EXISTS migrate_blacklist_023//
CREATE PROCEDURE migrate_blacklist_023()
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'blacklist' AND index_name = 'uk_tenant_number') THEN
    ALTER TABLE blacklist DROP INDEX uk_tenant_number;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'blacklist' AND column_name = 'match_type') THEN
    ALTER TABLE blacklist ADD COLUMN match_type VARCHAR(20) NOT NULL DEFAULT 'exact' COMMENT 'exact, prefix, suffix, contains, regex';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'blacklist' AND index_name = 'uk_tenant_number_match') THEN
    ALTER TABLE blacklist ADD UNIQUE KEY uk_tenant_number_match (tenant_id, number, match_type);
  END IF;
END//
DELIMITER ;
CALL migrate_blacklist_023();
DROP PROCEDURE IF EXISTS migrate_blacklist_023;

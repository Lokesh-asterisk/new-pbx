-- Migration 026: Username unique per tenant (parent_id) instead of globally
-- Allows same username in different tenants (e.g. avinash in us4group and avinash in techclub).
-- Run after 003 (tenants). USE pbx_callcentre;

-- Drop the global UNIQUE on username (MySQL names it 'username' when defined inline)
SET @exist := (SELECT COUNT(*) FROM information_schema.STATISTICS
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'username');
SET @sql := IF(@exist > 0, 'ALTER TABLE users DROP INDEX username', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add composite UNIQUE so (parent_id, username) is unique per tenant
SET @exist := (SELECT COUNT(*) FROM information_schema.STATISTICS
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'uk_parent_username');
SET @sql := IF(@exist = 0, 'ALTER TABLE users ADD UNIQUE KEY uk_parent_username (parent_id, username)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Keep a non-unique index on username for lookups when tenant is known
SET @exist := (SELECT COUNT(*) FROM information_schema.STATISTICS
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'idx_username');
SET @sql := IF(@exist = 0, 'ALTER TABLE users ADD INDEX idx_username (username)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

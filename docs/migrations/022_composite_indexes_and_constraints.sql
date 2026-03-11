-- Migration 022: Composite indexes and constraints for performance optimization
-- Addresses: missing composite indexes, unique constraint on call_records.unique_id,
-- and missing tenant_id on queue_members.

-- 1. Make call_records.unique_id truly UNIQUE (currently only has a regular index)
-- First drop the existing regular index if it exists, then add unique
SET @exist := (SELECT COUNT(*) FROM information_schema.STATISTICS 
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'call_records' AND INDEX_NAME = 'idx_unique_id');
SET @sql := IF(@exist > 0, 'ALTER TABLE call_records DROP INDEX idx_unique_id', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @exist := (SELECT COUNT(*) FROM information_schema.STATISTICS 
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'call_records' AND INDEX_NAME = 'uk_unique_id');
SET @sql := IF(@exist = 0, 'ALTER TABLE call_records ADD UNIQUE INDEX uk_unique_id (unique_id)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. Composite index: (tenant_id, start_time) for date-range queries
SET @exist := (SELECT COUNT(*) FROM information_schema.STATISTICS 
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'call_records' AND INDEX_NAME = 'idx_cr_tenant_start');
SET @sql := IF(@exist = 0, 'ALTER TABLE call_records ADD INDEX idx_cr_tenant_start (tenant_id, start_time)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 3. Composite index: (tenant_id, agent_id, start_time) for per-agent reporting
SET @exist := (SELECT COUNT(*) FROM information_schema.STATISTICS 
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'call_records' AND INDEX_NAME = 'idx_cr_tenant_agent_start');
SET @sql := IF(@exist = 0, 'ALTER TABLE call_records ADD INDEX idx_cr_tenant_agent_start (tenant_id, agent_id, start_time)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 4. Composite index: (tenant_id, status) for filtered status queries
SET @exist := (SELECT COUNT(*) FROM information_schema.STATISTICS 
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'call_records' AND INDEX_NAME = 'idx_cr_tenant_status');
SET @sql := IF(@exist = 0, 'ALTER TABLE call_records ADD INDEX idx_cr_tenant_status (tenant_id, status)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 5. Index on users for agent phone lookup
SET @exist := (SELECT COUNT(*) FROM information_schema.STATISTICS 
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'idx_users_phone_role');
SET @sql := IF(@exist = 0, 'ALTER TABLE users ADD INDEX idx_users_phone_role (phone_login_number, role)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 6. Composite index on session_agent_breaks
SET @exist := (SELECT COUNT(*) FROM information_schema.STATISTICS 
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'session_agent_breaks' AND INDEX_NAME = 'idx_sab_tenant_agent_start');
SET @sql := IF(@exist = 0, 'ALTER TABLE session_agent_breaks ADD INDEX idx_sab_tenant_agent_start (tenant_id, agent_id, start_time)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 7. Composite index on agent_status_log for aggregation
SET @exist := (SELECT COUNT(*) FROM information_schema.STATISTICS 
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_status_log' AND INDEX_NAME = 'idx_asl_tenant_agent_status_start');
SET @sql := IF(@exist = 0, 'ALTER TABLE agent_status_log ADD INDEX idx_asl_tenant_agent_status_start (tenant_id, agent_id, status, start_time)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 8. Add tenant_id to queue_members if missing
SET @exist := (SELECT COUNT(*) FROM information_schema.COLUMNS 
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'queue_members' AND COLUMN_NAME = 'tenant_id');
SET @sql := IF(@exist = 0, 'ALTER TABLE queue_members ADD COLUMN tenant_id INT UNSIGNED NULL AFTER id', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 9. Index on call_records for active call queries
SET @exist := (SELECT COUNT(*) FROM information_schema.STATISTICS 
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'call_records' AND INDEX_NAME = 'idx_cr_endtime_status');
SET @sql := IF(@exist = 0, 'ALTER TABLE call_records ADD INDEX idx_cr_endtime_status (end_time, status, start_time)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

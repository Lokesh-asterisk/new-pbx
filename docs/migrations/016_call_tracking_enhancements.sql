-- Migration 016: Call Tracking Enhancements
-- Adds columns for detailed transfer tracking, abandon reasons, failover tracking, and wait time
-- 
-- NOTE: Run each ALTER TABLE statement separately in MySQL Workbench.
-- If a column already exists, it will show "Duplicate column name" error - that's OK, just continue.
-- Or use the stored procedure version at the bottom for automatic handling.

-- ==========================================
-- OPTION 1: Run statements one by one
-- (Skip any that show "Duplicate column name")
-- ==========================================

-- Ensure transfer_status exists (from migration 004)
ALTER TABLE call_records ADD COLUMN transfer_status TINYINT UNSIGNED DEFAULT 0 AFTER recording_path;

-- Ensure transfer_to exists (from migration 004)
ALTER TABLE call_records ADD COLUMN transfer_to VARCHAR(32) DEFAULT NULL AFTER transfer_status;

-- Add wait_time_sec
ALTER TABLE call_records ADD COLUMN wait_time_sec INT UNSIGNED DEFAULT NULL AFTER talk_sec;

-- Add transfer_from
ALTER TABLE call_records ADD COLUMN transfer_from VARCHAR(32) DEFAULT NULL AFTER transfer_to;

-- Add transfer_time
ALTER TABLE call_records ADD COLUMN transfer_time DATETIME DEFAULT NULL AFTER transfer_from;

-- Add transfer_type
ALTER TABLE call_records ADD COLUMN transfer_type ENUM('agent_to_agent','agent_to_extension','agent_to_queue','agent_to_ivr','blind','attended') DEFAULT NULL AFTER transfer_time;

-- Add abandon_reason
ALTER TABLE call_records ADD COLUMN abandon_reason ENUM('caller_hangup','queue_timeout','failover','no_agents','ring_timeout') DEFAULT NULL AFTER transfer_type;

-- Add failover_destination
ALTER TABLE call_records ADD COLUMN failover_destination VARCHAR(64) DEFAULT NULL AFTER abandon_reason;

-- Add ring_time_sec
ALTER TABLE call_records ADD COLUMN ring_time_sec INT UNSIGNED DEFAULT NULL AFTER failover_destination;

-- ==========================================
-- OPTION 2: Use stored procedure (run this entire block at once)
-- This handles "column already exists" errors automatically
-- ==========================================

DELIMITER //

DROP PROCEDURE IF EXISTS add_column_if_not_exists//

CREATE PROCEDURE add_column_if_not_exists(
    IN tbl_name VARCHAR(64),
    IN col_name VARCHAR(64),
    IN col_definition VARCHAR(500)
)
BEGIN
    DECLARE col_exists INT DEFAULT 0;
    
    SELECT COUNT(*) INTO col_exists
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl_name
      AND COLUMN_NAME = col_name;
    
    IF col_exists = 0 THEN
        SET @sql = CONCAT('ALTER TABLE ', tbl_name, ' ADD COLUMN ', col_name, ' ', col_definition);
        PREPARE stmt FROM @sql;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END//

DELIMITER ;

-- Run the procedure for each column
CALL add_column_if_not_exists('call_records', 'transfer_status', 'TINYINT UNSIGNED DEFAULT 0');
CALL add_column_if_not_exists('call_records', 'transfer_to', 'VARCHAR(32) DEFAULT NULL');
CALL add_column_if_not_exists('call_records', 'wait_time_sec', 'INT UNSIGNED DEFAULT NULL');
CALL add_column_if_not_exists('call_records', 'transfer_from', 'VARCHAR(32) DEFAULT NULL');
CALL add_column_if_not_exists('call_records', 'transfer_time', 'DATETIME DEFAULT NULL');
CALL add_column_if_not_exists('call_records', 'transfer_type', "ENUM('agent_to_agent','agent_to_extension','agent_to_queue','agent_to_ivr','blind','attended') DEFAULT NULL");
CALL add_column_if_not_exists('call_records', 'abandon_reason', "ENUM('caller_hangup','queue_timeout','failover','no_agents','ring_timeout') DEFAULT NULL");
CALL add_column_if_not_exists('call_records', 'failover_destination', 'VARCHAR(64) DEFAULT NULL');
CALL add_column_if_not_exists('call_records', 'ring_time_sec', 'INT UNSIGNED DEFAULT NULL');

-- Clean up
DROP PROCEDURE IF EXISTS add_column_if_not_exists;

-- Add indexes (these will fail if they already exist - that's OK)
-- Run each separately if needed
CREATE INDEX idx_call_records_status ON call_records(status);
CREATE INDEX idx_call_records_transfer ON call_records(transfer_status);
CREATE INDEX idx_call_records_abandon ON call_records(abandon_reason);
CREATE INDEX idx_call_records_start_status ON call_records(start_time, status);

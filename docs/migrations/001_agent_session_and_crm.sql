-- Run this if your database was created before session_started_at and crm_customers existed.
-- USE pbx_callcentre;

-- Add session start time to agent_status (persists across page refresh)
-- Run once; ignore error if column already exists.
ALTER TABLE agent_status ADD COLUMN session_started_at DATETIME DEFAULT NULL;

-- CRM customers table (skip if already exists from main schema)
CREATE TABLE IF NOT EXISTS crm_customers (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  customer_id VARCHAR(64) NOT NULL,
  name VARCHAR(128) DEFAULT NULL,
  phone VARCHAR(32) DEFAULT NULL,
  email VARCHAR(255) DEFAULT NULL,
  notes TEXT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_tenant_customer (tenant_id, customer_id),
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

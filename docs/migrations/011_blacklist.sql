-- Blacklist: block prank/robocall numbers per tenant.
-- InboundRoute checks this table and returns HANGUP for matching caller numbers.
-- Run after schema that has tenants. USE pbx_callcentre;

CREATE TABLE IF NOT EXISTS blacklist (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  number VARCHAR(32) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id),
  UNIQUE KEY uk_tenant_number (tenant_id, number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

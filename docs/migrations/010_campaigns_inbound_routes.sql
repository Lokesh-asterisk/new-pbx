-- Campaigns and campaign assignment for inbound routes (DID/TFN).
-- Run after 002. USE pbx_callcentre;

-- Campaigns (per tenant)
CREATE TABLE IF NOT EXISTS campaigns (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  name VARCHAR(128) NOT NULL,
  description VARCHAR(255) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_tenant_name (tenant_id, name),
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add campaign_id to inbound_routes
ALTER TABLE inbound_routes
  ADD COLUMN campaign_id INT UNSIGNED DEFAULT NULL AFTER destination_id,
  ADD INDEX idx_campaign (campaign_id);

-- Backfill: create default campaign per tenant and assign existing routes
INSERT IGNORE INTO campaigns (tenant_id, name, description)
  SELECT DISTINCT tenant_id, 'Default', 'Default campaign for existing inbound routes'
  FROM inbound_routes;

UPDATE inbound_routes ir
  INNER JOIN campaigns c ON c.tenant_id = ir.tenant_id AND c.name = 'Default'
  SET ir.campaign_id = c.id
  WHERE ir.campaign_id IS NULL;

ALTER TABLE inbound_routes
  MODIFY COLUMN campaign_id INT UNSIGNED NOT NULL;

-- Call records: store campaign name for reporting and agent display
ALTER TABLE call_records
  ADD COLUMN campaign_name VARCHAR(128) DEFAULT NULL AFTER queue_name,
  ADD INDEX idx_campaign_name (campaign_name);

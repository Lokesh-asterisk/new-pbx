-- PBX base tables required for SuperAdmin: Inbound Routes, PJSIP Extensions, Queues, IVR Menus.
-- Run this if you only applied incremental migrations and never ran the full database-schema.sql.
-- Safe to run: all CREATE TABLE IF NOT EXISTS. Use database: USE pbx_callcentre;

-- SIP extensions (PJSIP endpoints per tenant)
CREATE TABLE IF NOT EXISTS sip_extensions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  name VARCHAR(64) NOT NULL,
  secret VARCHAR(255) DEFAULT NULL,
  context VARCHAR(64) DEFAULT NULL,
  host VARCHAR(64) DEFAULT NULL,
  ipaddr VARCHAR(45) DEFAULT NULL,
  port INT UNSIGNED DEFAULT NULL,
  dtmfmode VARCHAR(16) DEFAULT NULL,
  type VARCHAR(16) DEFAULT 'friend',
  agent_user_id INT UNSIGNED DEFAULT NULL,
  failover_destination_type VARCHAR(32) DEFAULT 'hangup',
  failover_destination_id INT UNSIGNED DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_tenant_name (tenant_id, name),
  INDEX idx_tenant (tenant_id),
  INDEX idx_agent_user (agent_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- SIP trunks
CREATE TABLE IF NOT EXISTS sip_trunks (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  trunk_name VARCHAR(64) NOT NULL,
  config_json JSON DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Outbound routes
CREATE TABLE IF NOT EXISTS outbound_routes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  trunk_id INT UNSIGNED NOT NULL,
  trunk_name VARCHAR(64) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Queues (call queues per tenant)
CREATE TABLE IF NOT EXISTS queues (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  name VARCHAR(64) NOT NULL,
  display_name VARCHAR(128) DEFAULT NULL,
  strategy VARCHAR(32) DEFAULT 'ringall',
  timeout INT UNSIGNED DEFAULT 60,
  failover_destination_type VARCHAR(32) DEFAULT 'hangup',
  failover_destination_id INT UNSIGNED DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_tenant_name (tenant_id, name),
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Campaigns (for inbound route assignment; optional)
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

-- Inbound routes (DID/TFN)
CREATE TABLE IF NOT EXISTS inbound_routes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  name VARCHAR(64) NOT NULL,
  did VARCHAR(32) NOT NULL,
  destination_type VARCHAR(32) NOT NULL,
  destination_id INT UNSIGNED DEFAULT NULL,
  campaign_id INT UNSIGNED DEFAULT NULL,
  sound_id INT UNSIGNED DEFAULT NULL,
  api_id INT UNSIGNED DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id),
  INDEX idx_did (did),
  INDEX idx_campaign (campaign_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sound files (per tenant)
CREATE TABLE IF NOT EXISTS sound_files (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  name VARCHAR(128) NOT NULL,
  file_path VARCHAR(255) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- API endpoints (per tenant)
CREATE TABLE IF NOT EXISTS api_endpoints (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  name VARCHAR(64) NOT NULL,
  url_or_key VARCHAR(255) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- IVR menus (parent table; must exist before ivr_menu_options)
CREATE TABLE IF NOT EXISTS ivr_menus (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  name VARCHAR(64) NOT NULL,
  config_json JSON DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- IVR menu DTMF options (child of ivr_menus)
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

-- Queue members (for queue membership UI)
CREATE TABLE IF NOT EXISTS queue_members (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  queue_name VARCHAR(64) NOT NULL,
  member_name VARCHAR(64) NOT NULL,
  paused TINYINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_queue_member (queue_name, member_name),
  INDEX idx_queue (queue_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Voicemail boxes (per tenant)
CREATE TABLE IF NOT EXISTS voicemail_boxes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  mailbox VARCHAR(32) NOT NULL,
  password VARCHAR(64) DEFAULT NULL,
  email VARCHAR(255) DEFAULT NULL,
  config_json JSON DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

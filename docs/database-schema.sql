-- PBX Call Centre - New database schema
-- Do not use old MySQL schema; Asterisk integration concept remains identical (agents, queues, originate, AMI/HTTP).

CREATE DATABASE IF NOT EXISTS pbx_callcentre
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE pbx_callcentre;

-- =============================================================================
-- ROLES: 1=superadmin, 2=admin, 3=user, 4=campaign (optional), 5=agent
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  email VARCHAR(255) DEFAULT NULL,
  role TINYINT UNSIGNED NOT NULL DEFAULT 3,
  parent_id INT UNSIGNED DEFAULT NULL,
  account_status TINYINT UNSIGNED NOT NULL DEFAULT 1,
  permission_group_id INT UNSIGNED DEFAULT NULL,
  services JSON DEFAULT NULL,
  change_password_required TINYINT UNSIGNED NOT NULL DEFAULT 1,
  soft_phone_login_status TINYINT UNSIGNED NOT NULL DEFAULT 0,
  soft_phone_extension_id INT UNSIGNED DEFAULT NULL,
  phone_login_name VARCHAR(64) DEFAULT NULL,
  phone_login_number VARCHAR(32) DEFAULT NULL,
  phone_login_password VARCHAR(255) DEFAULT NULL,
  team_id INT UNSIGNED DEFAULT NULL,
  login_status TINYINT UNSIGNED DEFAULT 0,
  last_login_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_parent (parent_id),
  INDEX idx_role (role),
  INDEX idx_permission_group (permission_group_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Permission groups (replaces user_group)
CREATE TABLE IF NOT EXISTS permission_groups (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  name VARCHAR(64) NOT NULL,
  queue_cdr TINYINT UNSIGNED NOT NULL DEFAULT 0,
  manual_cdr TINYINT UNSIGNED NOT NULL DEFAULT 0,
  extension_cdr TINYINT UNSIGNED NOT NULL DEFAULT 0,
  extension_route_cdr TINYINT UNSIGNED NOT NULL DEFAULT 0,
  live_agents TINYINT UNSIGNED NOT NULL DEFAULT 0,
  agent_apr TINYINT UNSIGNED NOT NULL DEFAULT 0,
  session_wise_agent_apr TINYINT UNSIGNED NOT NULL DEFAULT 0,
  inbound_route TINYINT UNSIGNED NOT NULL DEFAULT 0,
  blacklist TINYINT UNSIGNED NOT NULL DEFAULT 0,
  number_masking TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Teams (optional grouping)
CREATE TABLE IF NOT EXISTS teams (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================================
-- AGENT STATUS & REAL-TIME (Asterisk concept: agent status, queue membership)
-- =============================================================================

CREATE TABLE IF NOT EXISTS agent_status (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  agent_id VARCHAR(32) NOT NULL,
  tenant_id INT UNSIGNED NOT NULL,
  queue_name VARCHAR(64) DEFAULT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'LOGGEDIN',
  break_name VARCHAR(64) DEFAULT NULL,
  call_id VARCHAR(64) DEFAULT NULL,
  call_type VARCHAR(32) DEFAULT NULL,
  calls_taken INT UNSIGNED NOT NULL DEFAULT 0,
  agent_channel_id VARCHAR(128) DEFAULT NULL,
  customer_channel_id VARCHAR(128) DEFAULT NULL,
  customer_number VARCHAR(32) DEFAULT NULL,
  last_customer_number VARCHAR(32) DEFAULT NULL,
  last_cli VARCHAR(32) DEFAULT NULL,
  extension_number VARCHAR(32) DEFAULT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_agent (agent_id),
  INDEX idx_tenant_status (tenant_id, status),
  INDEX idx_timestamp (timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_breaks (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  name VARCHAR(64) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Caller ID / short codes for manual dial (replaces ShortCode)
CREATE TABLE IF NOT EXISTS caller_id_short_codes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  short_code VARCHAR(32) NOT NULL,
  did VARCHAR(32) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Manual call CDR (outbound from agent console)
CREATE TABLE IF NOT EXISTS manual_calls (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  agent_user_id INT UNSIGNED NOT NULL,
  agent_number VARCHAR(32) NOT NULL,
  agent_name VARCHAR(64) NOT NULL,
  unique_id VARCHAR(64) NOT NULL,
  cli VARCHAR(32) NOT NULL,
  customer_number VARCHAR(32) NOT NULL,
  call_start_time INT UNSIGNED NOT NULL,
  break_name VARCHAR(64) DEFAULT NULL,
  transfer_status TINYINT UNSIGNED DEFAULT 0,
  transfer_agent_number VARCHAR(32) DEFAULT NULL,
  transfer_rec VARCHAR(64) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id),
  INDEX idx_agent (agent_number),
  INDEX idx_start (call_start_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Queue call status (inbound/queue CDR link)
CREATE TABLE IF NOT EXISTS call_status (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  cdr_id VARCHAR(64) DEFAULT NULL,
  transfer_status TINYINT UNSIGNED DEFAULT 0,
  transfer_agent_number VARCHAR(32) DEFAULT NULL,
  transfer_rec VARCHAR(64) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_cdr (cdr_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================================
-- PBX CONFIG (Asterisk: sip extensions, trunks, queues, dialplan concepts)
-- =============================================================================

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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_tenant_name (tenant_id, name),
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sip_trunks (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  trunk_name VARCHAR(64) NOT NULL,
  config_json JSON DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS outbound_routes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  trunk_id INT UNSIGNED NOT NULL,
  trunk_name VARCHAR(64) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS queues (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  name VARCHAR(64) NOT NULL,
  display_name VARCHAR(128) DEFAULT NULL,
  strategy VARCHAR(32) DEFAULT 'ringall',
  timeout INT UNSIGNED DEFAULT 60,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_tenant_name (tenant_id, name),
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Inbound routes / DIDs (replaces my_number_list)
CREATE TABLE IF NOT EXISTS inbound_routes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  name VARCHAR(64) NOT NULL,
  did VARCHAR(32) NOT NULL,
  destination_type VARCHAR(32) NOT NULL,
  destination_id INT UNSIGNED DEFAULT NULL,
  sound_id INT UNSIGNED DEFAULT NULL,
  api_id INT UNSIGNED DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id),
  INDEX idx_did (did)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS blacklist (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  number VARCHAR(32) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id),
  INDEX idx_number (tenant_id, number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sound_files (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  name VARCHAR(128) NOT NULL,
  file_path VARCHAR(255) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS api_endpoints (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  name VARCHAR(64) NOT NULL,
  url_or_key VARCHAR(255) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ivr_menus (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  name VARCHAR(64) NOT NULL,
  config_json JSON DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS conferences (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  name VARCHAR(64) NOT NULL,
  description VARCHAR(255) DEFAULT NULL,
  pin_required TINYINT UNSIGNED NOT NULL DEFAULT 0,
  greeting_sound_id INT UNSIGNED DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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

CREATE TABLE IF NOT EXISTS outbound_queues (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  name VARCHAR(64) NOT NULL,
  trunk_id INT UNSIGNED DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS outbound_queue_numbers (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  queue_id INT UNSIGNED NOT NULL,
  number VARCHAR(32) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_queue (queue_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================================
-- REPORTS / APR (session-wise agent performance, breaks, calls)
-- =============================================================================

CREATE TABLE IF NOT EXISTS session_agent_apr (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  agent_id INT UNSIGNED NOT NULL,
  agent_number VARCHAR(32) NOT NULL,
  agent_name VARCHAR(64) NOT NULL,
  start_time DATETIME NOT NULL,
  end_time DATETIME NOT NULL,
  total_login_time TIME DEFAULT NULL,
  total_talk_time INT UNSIGNED DEFAULT 0,
  total_calls INT UNSIGNED DEFAULT 0,
  total_answered_calls INT UNSIGNED DEFAULT 0,
  total_incoming_calls INT UNSIGNED DEFAULT 0,
  total_incoming_talk_time INT UNSIGNED DEFAULT 0,
  total_outgoing_calls INT UNSIGNED DEFAULT 0,
  total_outgoing_answered INT UNSIGNED DEFAULT 0,
  total_outgoing_talk_time INT UNSIGNED DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tenant_date (tenant_id, start_time),
  INDEX idx_agent (agent_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS session_agent_breaks (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  agent_id INT UNSIGNED NOT NULL,
  start_time DATETIME NOT NULL,
  end_time DATETIME NOT NULL,
  break_name VARCHAR(64) DEFAULT NULL,
  break_time TIME DEFAULT NULL,
  break_count INT UNSIGNED DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tenant_agent (tenant_id, agent_id),
  INDEX idx_start (start_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS session_agent_calls (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  agent_id INT UNSIGNED NOT NULL,
  start_time DATETIME NOT NULL,
  end_time DATETIME NOT NULL,
  call_type_name VARCHAR(32) DEFAULT NULL,
  total_call_count INT UNSIGNED DEFAULT 0,
  answered_count INT UNSIGNED DEFAULT 0,
  call_duration TIME DEFAULT NULL,
  call_talk_time TIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tenant_agent (tenant_id, agent_id),
  INDEX idx_start (start_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS break_agent_apr (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  agent_number VARCHAR(32) NOT NULL,
  start_time DATETIME NOT NULL,
  total_break_time TIME DEFAULT NULL,
  total_break_seconds INT UNSIGNED DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tenant_date (tenant_id, start_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================================
-- SERVER / MULTI-NODE (optional; replaces active_server)
-- =============================================================================

CREATE TABLE IF NOT EXISTS active_servers (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  server_id VARCHAR(64) NOT NULL UNIQUE,
  is_active TINYINT UNSIGNED NOT NULL DEFAULT 0,
  last_update_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================================
-- QUEUE MEMBERS (synced from Asterisk or managed by app; concept identical)
-- Asterisk queue_members: membername, paused. We mirror for UI/API.
-- =============================================================================

CREATE TABLE IF NOT EXISTS queue_members (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  queue_name VARCHAR(64) NOT NULL,
  member_name VARCHAR(64) NOT NULL,
  paused TINYINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_queue_member (queue_name, member_name),
  INDEX idx_queue (queue_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which extension is currently in use by which agent (one extension = one agent at a time)
CREATE TABLE IF NOT EXISTS agent_extension_usage (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  extension_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_extension (extension_id),
  INDEX idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

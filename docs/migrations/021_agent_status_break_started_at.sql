-- Add break_started_at so Live Monitoring can show "on break for X min".
-- USE pbx_callcentre;

ALTER TABLE agent_status ADD COLUMN break_started_at DATETIME DEFAULT NULL AFTER break_name;

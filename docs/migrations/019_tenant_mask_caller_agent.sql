-- Tenant setting: mask caller number on agent dashboard (show only last 4 digits).
-- Monitoring (wallboard) and reporting keep full number; only agent incoming_call payload is masked.
-- Run after 003 (tenants). USE pbx_callcentre;

ALTER TABLE tenants
  ADD COLUMN mask_caller_number_agent TINYINT NOT NULL DEFAULT 0
  COMMENT '1 = show only last 4 digits of caller number on agent dashboard (incoming call only)';

-- Persistent assignment: which PJSIP extension is assigned to which agent.
-- Run once; ignore error if column already exists.
-- USE pbx_callcentre;

ALTER TABLE sip_extensions
  ADD COLUMN agent_user_id INT UNSIGNED DEFAULT NULL AFTER type,
  ADD INDEX idx_agent_user (agent_user_id);

-- Optional: backfill from existing convention (phone_login_number = extension name)
-- UPDATE sip_extensions e
-- INNER JOIN users u ON u.role = 5 AND TRIM(u.phone_login_number) = e.name AND u.parent_id = e.tenant_id
-- SET e.agent_user_id = u.id
-- WHERE e.agent_user_id IS NULL;

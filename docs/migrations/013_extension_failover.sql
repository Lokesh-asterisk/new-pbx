-- Extension no-answer failover: when extension does not answer, send call to another destination.
-- Run after 012. USE pbx_callcentre;

ALTER TABLE sip_extensions
  ADD COLUMN failover_destination_type VARCHAR(32) DEFAULT 'hangup',
  ADD COLUMN failover_destination_id INT UNSIGNED DEFAULT NULL;

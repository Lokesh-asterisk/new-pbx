-- Queue failover: when no agents or no answer, send call to another destination.
-- Run after 010. USE pbx_callcentre;

ALTER TABLE queues
  ADD COLUMN failover_destination_type VARCHAR(32) DEFAULT 'hangup',
  ADD COLUMN failover_destination_id INT UNSIGNED DEFAULT NULL;

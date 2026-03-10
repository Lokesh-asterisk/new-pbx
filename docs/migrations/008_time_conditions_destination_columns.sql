-- Add match/nomatch destination columns to time_conditions (if your table was created without them).
-- Run once. If you get "Duplicate column name", the columns already exist—skip.
-- USE pbx_callcentre;

ALTER TABLE time_conditions
  ADD COLUMN match_destination_type VARCHAR(32) DEFAULT 'hangup' AFTER time_group_id,
  ADD COLUMN match_destination_id INT UNSIGNED DEFAULT NULL AFTER match_destination_type,
  ADD COLUMN nomatch_destination_type VARCHAR(32) DEFAULT 'hangup' AFTER match_destination_id,
  ADD COLUMN nomatch_destination_id INT UNSIGNED DEFAULT NULL AFTER nomatch_destination_type;

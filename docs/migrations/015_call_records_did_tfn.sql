-- Add DID/TFN (called number) to call_records for reporting and monitoring per inbound route.
-- Run after 002, 010. USE pbx_callcentre;

ALTER TABLE call_records
  ADD COLUMN did_tfn VARCHAR(32) DEFAULT NULL AFTER destination_number;

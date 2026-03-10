-- Fix call_records: mark as abandoned when call was never answered but status is completed (or typo abondoned).
-- Run once so CDR and reports show correct status for existing rows.
-- Requires call_records table (002_phase3_call_records_realtime.sql).
-- Uses primary key (id) in UPDATE so it runs in MySQL Workbench safe update mode.

USE pbx_callcentre;

UPDATE call_records c
INNER JOIN (
  SELECT id FROM call_records
  WHERE answer_time IS NULL
    AND LOWER(TRIM(status)) IN ('completed', 'abondoned')
) t ON c.id = t.id
SET c.status = 'abandoned';

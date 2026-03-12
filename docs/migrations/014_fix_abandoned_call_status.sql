-- Fix call_records: mark as abandoned when call was never answered but status is completed (or typo abondoned).
-- Run once so CDR and reports show correct status for existing rows.
-- Requires call_records table (002_phase3_call_records_realtime.sql).
-- Temporarily disables safe update mode for this UPDATE only (Workbench enforces safe mode even with WHERE id IN).

USE pbx_callcentre;

SET SESSION SQL_SAFE_UPDATES = 0;

UPDATE call_records
SET status = 'abandoned'
WHERE id IN (
  SELECT id FROM (
    SELECT id FROM call_records
    WHERE answer_time IS NULL
      AND LOWER(TRIM(status)) IN ('completed', 'abondoned')
  ) t
);

SET SESSION SQL_SAFE_UPDATES = 1;

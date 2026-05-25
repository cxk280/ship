-- Rename sprint-related document types to week terminology
-- Part of Sprint → Week rename refactor

-- Rename document_type enum values.
-- Guarded so this is idempotent / replay-safe: on a DB bootstrapped from the current
-- schema.sql the enum already has the week labels, so only rename when the old label exists.
-- Rename only when the old label still exists AND the new one doesn't, so this is a clean
-- no-op on a DB already at the current schema (avoids both "not an existing enum label" and
-- "already exists" errors). A genuinely old DB still gets renamed.
DO $$
DECLARE
  rename_pairs text[][] := ARRAY[
    ARRAY['sprint_plan', 'weekly_plan'],
    ARRAY['sprint_retro', 'weekly_retro'],
    ARRAY['sprint_review', 'weekly_review']
  ];
  pair text[];
BEGIN
  FOREACH pair SLICE 1 IN ARRAY rename_pairs LOOP
    IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
               WHERE t.typname = 'document_type' AND e.enumlabel = pair[1])
       AND NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
               WHERE t.typname = 'document_type' AND e.enumlabel = pair[2]) THEN
      EXECUTE format('ALTER TYPE document_type RENAME VALUE %L TO %L', pair[1], pair[2]);
    END IF;
  END LOOP;
END $$;

-- Note: We keep 'sprint' as a document_type because it represents the sprint document itself.
-- The terminology change is "Sprint 3" → "Week of Jan 27" in UI, but the underlying
-- document concept remains valid. The sprint document stores sprint_number and owner_id
-- for derived 7-day windows.

-- Update accountability_type values in issue properties
-- Sprint-related accountability types become week-related
UPDATE documents
SET properties = jsonb_set(properties, '{accountability_type}', '"weekly_plan"')
WHERE properties->>'accountability_type' = 'sprint_plan';

UPDATE documents
SET properties = jsonb_set(properties, '{accountability_type}', '"weekly_review"')
WHERE properties->>'accountability_type' = 'sprint_review';

UPDATE documents
SET properties = jsonb_set(properties, '{accountability_type}', '"week_start"')
WHERE properties->>'accountability_type' = 'sprint_start';

UPDATE documents
SET properties = jsonb_set(properties, '{accountability_type}', '"week_issues"')
WHERE properties->>'accountability_type' = 'sprint_issues';

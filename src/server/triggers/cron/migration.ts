/** Append through the migration owner. This module never migrates on read. */
export const CRON_OCCURRENCE_MIGRATION = `CREATE TABLE agency_schedule_cursor (
  rule_version_id TEXT PRIMARY KEY,
  timezone TEXT NOT NULL,
  last_scheduled_at_utc TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE agency_schedule_occurrence (
  rule_version_id TEXT NOT NULL,
  scheduled_at_utc TEXT NOT NULL,
  timezone TEXT NOT NULL,
  utc_offset_minutes INTEGER NOT NULL,
  misfire TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('planned', 'emitted', 'skipped')),
  inbox_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (rule_version_id, scheduled_at_utc)
);`;

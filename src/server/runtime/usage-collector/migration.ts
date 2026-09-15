/** Append through the migration owner. This module never migrates on read. */
export const USAGE_COLLECTOR_MIGRATION = `CREATE TABLE agency_usage_event (
  thread_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  provider_thread_id TEXT,
  turn_id TEXT,
  last_json TEXT NOT NULL,
  total_json TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, event_id)
);
CREATE UNIQUE INDEX agency_usage_event_thread_seq ON agency_usage_event (thread_id, seq);
`;

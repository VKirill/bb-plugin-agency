// Append-only once released. Add statements; never rewrite a shipped migration.
export const migrations = [
  `CREATE TABLE agency_inbox (
    project_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('rpc', 'cli')),
    topic TEXT NOT NULL,
    reference TEXT NOT NULL,
    received_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state = 'pending'),
    PRIMARY KEY(project_id, event_id)
  )`,
];

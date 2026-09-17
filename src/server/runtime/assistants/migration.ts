/**
 * Assistants: a fourth role type in a department, and the employee the assistant helps.
 * SQLite cannot change a CHECK constraint, so the membership table is rebuilt the same way the
 * `executor`/`reviewer` migration did it. Nothing references the table by foreign key.
 * Append through the migration owner; this module never migrates on read.
 */
export const ASSISTANT_MEMBERSHIP_MIGRATION = `CREATE TABLE agency_membership_v3 (
  department_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('lead', 'executor', 'reviewer', 'assistant')),
  helps_agent_id TEXT,
  PRIMARY KEY (department_id, agent_id),
  FOREIGN KEY (department_id) REFERENCES agency_department(id),
  FOREIGN KEY (agent_id) REFERENCES agency_agent(id)
);
INSERT INTO agency_membership_v3 (department_id, agent_id, role, helps_agent_id)
  SELECT department_id, agent_id, role, NULL FROM agency_membership;
DROP TABLE agency_membership;
ALTER TABLE agency_membership_v3 RENAME TO agency_membership;
CREATE INDEX agency_membership_agent_idx ON agency_membership(agent_id);
`;

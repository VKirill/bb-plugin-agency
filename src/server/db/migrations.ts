import { SAVED_VIEWS_MIGRATION } from "../insights/archive";
import { SANDBOX_ESCAPE_MIGRATION } from "../runtime/sandbox-escape/service";
import { NEXT_STEP_MIGRATION } from "../flow/service";
import { NIGHTLY_RECHECK_MIGRATION } from "../runtime/nightly-recheck/service";
import { OWNER_MESSAGE_MIGRATION } from "../owner-messages/service";
import { REMARK_PATTERN_MIGRATION } from "../knowledge/remark-patterns";
import { DEPARTMENT_ARCHIVE_MIGRATION } from "../organization/lifecycle";
import { KIT_RECORD_MIGRATION } from "../organization/starter-kit";
import { GOALS_MIGRATION } from "../organization/goals";
import { HIERARCHY_MIGRATION } from "../organization/hierarchy";
import { KNOWLEDGE_MIGRATION } from "../knowledge/store";
import { TELEGRAM_OUTBOX_MIGRATION } from "../triggers/telegram-outbox";
import { SOURCE_TOPICS_MIGRATION } from "../triggers/webhook-secrets";
import { RULE_SCHEDULE_MIGRATION } from "../triggers/schedules";
import { AUTO_REVIEW_MIGRATION } from "../runtime/auto-review/service";
import { LAUNCH_QUEUE_MIGRATION } from "../runtime/launch-queue/service";
import { AGENCY_RULES_MIGRATION, TEMPLATES_MIGRATION } from "../templates/store";
import { createHash } from "node:crypto";
import { COMPLETION_REMINDER_MIGRATION } from "../runtime/completion-reminder/service";
import { RUN_WATCH_MIGRATION } from "../runtime/run-watch/service";
import { REWORK_MIGRATION } from "../runtime/rework/service";
import { WORK_RULES_MIGRATION } from "../rules/work-rules";
import { DUE_REMINDER_MIGRATION } from "../runtime/due-reminder/service";
import { USAGE_COLLECTOR_MIGRATION } from "../runtime/usage-collector/migration.js";
import { CRON_OCCURRENCE_MIGRATION } from "../triggers/cron/migration.js";
import { ASSISTANT_MEMBERSHIP_MIGRATION } from "../runtime/assistants/migration.js";
import { WORK_PROFILE_MIGRATION } from "../projects/work-profiles.js";
import type { SqlDatabase } from "./sql";

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
  `CREATE TABLE agency_policy_version (
    id TEXT PRIMARY KEY,
    allowed_capabilities TEXT NOT NULL,
    cli_host_constraints TEXT NOT NULL,
    secret_refs TEXT NOT NULL
  )`,
  `CREATE TABLE agency_agent (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active', 'paused', 'archived')),
    current_version_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE agency_agent_version (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    role TEXT NOT NULL,
    instructions TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    skill_ids TEXT NOT NULL,
    mcp_ids TEXT NOT NULL,
    policy_version_id TEXT NOT NULL,
    UNIQUE(agent_id, version),
    FOREIGN KEY (agent_id) REFERENCES agency_agent(id),
    FOREIGN KEY (policy_version_id) REFERENCES agency_policy_version(id)
  )`,
  `CREATE TABLE agency_department (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    lead_agent_id TEXT NOT NULL,
    process_version_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (lead_agent_id) REFERENCES agency_agent(id)
  )`,
  `CREATE TABLE agency_process_version (
    id TEXT PRIMARY KEY,
    department_id TEXT NOT NULL,
    instructions TEXT NOT NULL,
    acceptance TEXT NOT NULL,
    review_policy TEXT NOT NULL,
    FOREIGN KEY (department_id) REFERENCES agency_department(id)
  )`,
  `CREATE TABLE agency_membership (
    department_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('member', 'lead')),
    PRIMARY KEY (department_id, agent_id),
    FOREIGN KEY (department_id) REFERENCES agency_department(id),
    FOREIGN KEY (agent_id) REFERENCES agency_agent(id)
  )`,
  `CREATE TABLE agency_project_binding (
    id TEXT PRIMARY KEY,
    bb_project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    canonical_root TEXT NOT NULL,
    policy_version_id TEXT NOT NULL,
    section_id TEXT,
    revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (policy_version_id) REFERENCES agency_policy_version(id)
  )`,
  `CREATE TABLE agency_project_department (
    binding_id TEXT NOT NULL,
    department_id TEXT NOT NULL,
    PRIMARY KEY (binding_id, department_id),
    FOREIGN KEY (binding_id) REFERENCES agency_project_binding(id),
    FOREIGN KEY (department_id) REFERENCES agency_department(id)
  )`,
  `CREATE TABLE agency_job (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    binding_id TEXT NOT NULL,
    department_id TEXT NOT NULL,
    title TEXT NOT NULL,
    brief TEXT NOT NULL,
    acceptance TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN (
      'backlog', 'queued', 'running', 'review',
      'waiting_input', 'blocked', 'done', 'canceled'
    )),
    parent_job_id TEXT,
    assigned_agent_id TEXT,
    priority TEXT NOT NULL CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
    due_at TEXT,
    revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (binding_id) REFERENCES agency_project_binding(id),
    FOREIGN KEY (department_id) REFERENCES agency_department(id),
    FOREIGN KEY (parent_job_id) REFERENCES agency_job(id),
    FOREIGN KEY (assigned_agent_id) REFERENCES agency_agent(id)
  )`,
  `CREATE TABLE agency_job_dependency (
    job_id TEXT NOT NULL,
    depends_on_job_id TEXT NOT NULL,
    PRIMARY KEY (job_id, depends_on_job_id),
    CHECK(job_id != depends_on_job_id),
    FOREIGN KEY (job_id) REFERENCES agency_job(id),
    FOREIGN KEY (depends_on_job_id) REFERENCES agency_job(id)
  )`,
  `CREATE TABLE agency_job_facts (
    job_id TEXT PRIMARY KEY,
    thread_bound INTEGER NOT NULL DEFAULT 0,
    confirmed_continuation INTEGER NOT NULL DEFAULT 0,
    open_questions INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (job_id) REFERENCES agency_job(id)
  )`,
  `CREATE TABLE agency_artifact (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES agency_job(id)
  )`,
  `CREATE TABLE agency_artifact_version (
    artifact_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    host_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    hash TEXT NOT NULL,
    author TEXT NOT NULL,
    PRIMARY KEY (artifact_id, version),
    FOREIGN KEY (artifact_id) REFERENCES agency_artifact(id),
    FOREIGN KEY (job_id) REFERENCES agency_job(id)
  )`,
  `CREATE TABLE agency_activity (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    kind TEXT NOT NULL,
    causation_id TEXT,
    timestamp TEXT NOT NULL,
    references_json TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES agency_job(id)
  )`,
  `CREATE TABLE agency_artifact_acceptance (
    artifact_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    hash TEXT NOT NULL,
    accepted_at TEXT NOT NULL,
    PRIMARY KEY (artifact_id, job_id),
    FOREIGN KEY (artifact_id) REFERENCES agency_artifact(id),
    FOREIGN KEY (job_id) REFERENCES agency_job(id)
  )`,
  `CREATE TABLE agency_request (
    request_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX agency_job_binding_idx ON agency_job(binding_id)`,
  `CREATE INDEX agency_job_department_idx ON agency_job(department_id)`,
  `CREATE INDEX agency_artifact_job_idx ON agency_artifact(job_id)`,
  `CREATE INDEX agency_activity_job_idx ON agency_activity(job_id, timestamp)`,
  `CREATE INDEX agency_membership_agent_idx ON agency_membership(agent_id)`,
  `CREATE TABLE agency_artifact_publish_intent (
    request_id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    binding_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    canonical_root TEXT NOT NULL,
    binding_revision INTEGER NOT NULL,
    relative_path TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    hash TEXT NOT NULL,
    author TEXT NOT NULL,
    version INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending', 'committed', 'failed')),
    failure_code TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(artifact_id, job_id, version),
    FOREIGN KEY (artifact_id) REFERENCES agency_artifact(id),
    FOREIGN KEY (job_id) REFERENCES agency_job(id)
  )`,
  `CREATE INDEX agency_artifact_intent_pending_idx
    ON agency_artifact_publish_intent(state, job_id)`,
  `ALTER TABLE agency_request ADD COLUMN payload_json TEXT NOT NULL DEFAULT 'null'`,
  `ALTER TABLE agency_request ADD COLUMN actor_json TEXT NOT NULL DEFAULT '{}'`,
  `ALTER TABLE agency_request ADD COLUMN scope_json TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE agency_activity ADD COLUMN comment TEXT`,
  `CREATE TABLE agency_context_snapshot (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(digest),
    FOREIGN KEY (job_id) REFERENCES agency_job(id)
  )`,
  `CREATE TABLE agency_run_attempt (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    attempt_no INTEGER NOT NULL,
    snapshot_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    thread_id TEXT,
    launch_id TEXT,
    state TEXT NOT NULL CHECK(state IN (
      'prepared', 'launching', 'running', 'waiting_input',
      'succeeded', 'failed', 'canceled', 'unknown'
    )),
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(job_id, attempt_no),
    FOREIGN KEY (job_id) REFERENCES agency_job(id),
    FOREIGN KEY (snapshot_id) REFERENCES agency_context_snapshot(id)
  )`,
  `CREATE UNIQUE INDEX agency_run_attempt_one_active_idx
    ON agency_run_attempt(job_id)
    WHERE state IN ('prepared', 'launching', 'running', 'waiting_input', 'unknown')`,
  `CREATE INDEX agency_run_attempt_job_idx ON agency_run_attempt(job_id, attempt_no)`,
  `CREATE INDEX agency_context_snapshot_job_idx ON agency_context_snapshot(job_id)`,
  // One monotonic receipt row per launch (upsert), not an event journal. Migration list stays append-only.
  `CREATE TABLE agency_launch_receipt (
    launch_id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    thread_id TEXT,
    spawn_kind TEXT NOT NULL CHECK(spawn_kind IN ('confirmed', 'rejected', 'canceled', 'unknown')),
    persist_error_code TEXT,
    persist_error_message TEXT,
    job_bind_state TEXT NOT NULL CHECK(job_bind_state IN ('pending', 'applied', 'failed', 'needs_repair')),
    needs_reconciliation INTEGER NOT NULL DEFAULT 0,
    parent_request_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (attempt_id) REFERENCES agency_run_attempt(id),
    FOREIGN KEY (job_id) REFERENCES agency_job(id)
  )`,
  `CREATE UNIQUE INDEX agency_launch_receipt_attempt_idx ON agency_launch_receipt(attempt_id)`,
  `CREATE TABLE agency_job_input_ref (
    target_job_id TEXT NOT NULL,
    source_job_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    hash TEXT NOT NULL,
    host_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    accepted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (target_job_id, artifact_id, version),
    FOREIGN KEY (target_job_id) REFERENCES agency_job(id),
    FOREIGN KEY (source_job_id) REFERENCES agency_job(id),
    FOREIGN KEY (artifact_id) REFERENCES agency_artifact(id)
  )`,
  `CREATE TABLE agency_job_handoff (
    target_job_id TEXT PRIMARY KEY,
    prior_attempt_id TEXT NOT NULL,
    from_snapshot_digest TEXT NOT NULL,
    return_reason TEXT,
    open_questions TEXT NOT NULL,
    FOREIGN KEY (target_job_id) REFERENCES agency_job(id)
  )`,
  // Append-only: awaiting_review on CHECK + one-active index. Do not rewrite the original CREATE TABLE.
  `CREATE TABLE agency_run_attempt_new (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    attempt_no INTEGER NOT NULL,
    snapshot_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    thread_id TEXT,
    launch_id TEXT,
    state TEXT NOT NULL CHECK(state IN (
      'prepared', 'launching', 'running', 'waiting_input', 'awaiting_review',
      'succeeded', 'failed', 'canceled', 'unknown'
    )),
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(job_id, attempt_no),
    FOREIGN KEY (job_id) REFERENCES agency_job(id),
    FOREIGN KEY (snapshot_id) REFERENCES agency_context_snapshot(id)
  );
INSERT INTO agency_run_attempt_new
  SELECT id, job_id, attempt_no, snapshot_id, digest, thread_id, launch_id, state, revision, created_at, updated_at
  FROM agency_run_attempt;
CREATE TABLE agency_launch_receipt_new (
    launch_id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    thread_id TEXT,
    spawn_kind TEXT NOT NULL CHECK(spawn_kind IN ('confirmed', 'rejected', 'canceled', 'unknown')),
    persist_error_code TEXT,
    persist_error_message TEXT,
    job_bind_state TEXT NOT NULL CHECK(job_bind_state IN ('pending', 'applied', 'failed', 'needs_repair')),
    needs_reconciliation INTEGER NOT NULL DEFAULT 0,
    parent_request_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (attempt_id) REFERENCES agency_run_attempt_new(id),
    FOREIGN KEY (job_id) REFERENCES agency_job(id)
  );
INSERT INTO agency_launch_receipt_new
  SELECT launch_id, attempt_id, job_id, snapshot_id, digest, thread_id, spawn_kind,
         persist_error_code, persist_error_message, job_bind_state, needs_reconciliation,
         parent_request_id, created_at, updated_at
  FROM agency_launch_receipt;
DROP TABLE agency_launch_receipt;
DROP TABLE agency_run_attempt;
ALTER TABLE agency_run_attempt_new RENAME TO agency_run_attempt;
ALTER TABLE agency_launch_receipt_new RENAME TO agency_launch_receipt;
CREATE UNIQUE INDEX agency_run_attempt_one_active_idx
    ON agency_run_attempt(job_id)
    WHERE state IN ('prepared', 'launching', 'running', 'waiting_input', 'awaiting_review', 'unknown');
CREATE INDEX agency_run_attempt_job_idx ON agency_run_attempt(job_id, attempt_no);
CREATE UNIQUE INDEX agency_launch_receipt_attempt_idx ON agency_launch_receipt(attempt_id)`,
  `CREATE TABLE agency_job_needs_input (
    job_id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL,
    launch_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    questions_json TEXT NOT NULL,
    body_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES agency_job(id),
    FOREIGN KEY (attempt_id) REFERENCES agency_run_attempt(id)
  )`,
  `CREATE TABLE agency_job_needs_input_answer (
    request_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    launch_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    answers_json TEXT NOT NULL,
    body_hash TEXT NOT NULL,
    expected_process_version_id TEXT NOT NULL,
    expected_snapshot_digest TEXT NOT NULL,
    send_state TEXT NOT NULL,
    send_code TEXT,
    send_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES agency_job(id),
    FOREIGN KEY (attempt_id) REFERENCES agency_run_attempt(id)
  )`,
  `CREATE TABLE agency_job_needs_input_amendment (
    request_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    process_version_id TEXT NOT NULL,
    snapshot_process_version_id TEXT NOT NULL,
    snapshot_digest TEXT NOT NULL,
    process_instructions TEXT NOT NULL,
    process_acceptance TEXT NOT NULL,
    process_instructions_hash TEXT NOT NULL,
    process_acceptance_hash TEXT NOT NULL,
    job_brief TEXT NOT NULL,
    job_acceptance TEXT NOT NULL,
    job_brief_hash TEXT NOT NULL,
    job_acceptance_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (request_id) REFERENCES agency_job_needs_input_answer(request_id)
  )`,
  `ALTER TABLE agency_job_needs_input_answer ADD COLUMN dispatch_claimed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agency_job_needs_input_answer ADD COLUMN pinned_job_revision INTEGER;
ALTER TABLE agency_job_needs_input_answer ADD COLUMN pinned_attempt_revision INTEGER;
CREATE UNIQUE INDEX agency_job_needs_input_answer_one_job_idx ON agency_job_needs_input_answer(job_id);
CREATE UNIQUE INDEX agency_job_needs_input_amendment_one_job_idx ON agency_job_needs_input_amendment(job_id)`,
  `CREATE TABLE agency_job_needs_input_wait (
    wait_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    launch_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    questions_json TEXT NOT NULL,
    body_hash TEXT NOT NULL,
    closed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES agency_job(id),
    FOREIGN KEY (attempt_id) REFERENCES agency_run_attempt(id)
  );
CREATE UNIQUE INDEX agency_job_needs_input_wait_one_open_idx
  ON agency_job_needs_input_wait(job_id) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX agency_job_needs_input_wait_report_idx ON agency_job_needs_input_wait(request_id);
CREATE INDEX agency_job_needs_input_wait_job_history_idx ON agency_job_needs_input_wait(job_id, created_at);
INSERT INTO agency_job_needs_input_wait (
  wait_id, job_id, attempt_id, launch_id, thread_id, request_id,
  questions_json, body_hash, closed_at, created_at, updated_at
)
SELECT request_id, job_id, attempt_id, launch_id, thread_id, request_id,
  questions_json, body_hash, NULL, created_at, updated_at
FROM agency_job_needs_input;
ALTER TABLE agency_job_needs_input_answer ADD COLUMN wait_id TEXT NOT NULL DEFAULT '';
UPDATE agency_job_needs_input_answer
SET wait_id = COALESCE((
  SELECT wait_id FROM agency_job_needs_input_wait w WHERE w.job_id = agency_job_needs_input_answer.job_id
), request_id);
ALTER TABLE agency_job_needs_input_amendment ADD COLUMN wait_id TEXT NOT NULL DEFAULT '';
UPDATE agency_job_needs_input_amendment
SET wait_id = COALESCE((
  SELECT wait_id FROM agency_job_needs_input_wait w WHERE w.job_id = agency_job_needs_input_amendment.job_id
), request_id);
UPDATE agency_job_needs_input_wait
SET closed_at = (
  SELECT a.updated_at FROM agency_job_needs_input_answer a
  WHERE a.wait_id = agency_job_needs_input_wait.wait_id AND a.send_state = 'confirmed'
)
WHERE EXISTS (
  SELECT 1 FROM agency_job_needs_input_answer a
  WHERE a.wait_id = agency_job_needs_input_wait.wait_id AND a.send_state = 'confirmed'
);
DROP INDEX agency_job_needs_input_answer_one_job_idx;
DROP INDEX agency_job_needs_input_amendment_one_job_idx;
CREATE UNIQUE INDEX agency_job_needs_input_answer_one_wait_idx ON agency_job_needs_input_answer(wait_id);
CREATE UNIQUE INDEX agency_job_needs_input_amendment_one_wait_idx ON agency_job_needs_input_amendment(wait_id)`,
  `CREATE TABLE agency_event_definition (
    topic TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    namespace TEXT NOT NULL,
    label TEXT NOT NULL,
    payload_schema_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (topic, schema_version)
  );
CREATE TABLE agency_event_source (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
CREATE TABLE agency_inbox_event (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    body_digest TEXT NOT NULL,
    body_json TEXT NOT NULL,
    reference TEXT NOT NULL,
    provenance TEXT NOT NULL,
    depth INTEGER NOT NULL,
    causation_id TEXT,
    state TEXT NOT NULL,
    received_at TEXT NOT NULL,
    FOREIGN KEY (source_id) REFERENCES agency_event_source(id),
    UNIQUE (source_id, event_id)
  );
CREATE TABLE agency_rule_version (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    project_id TEXT NOT NULL,
    source_id TEXT,
    topic TEXT NOT NULL,
    conditions_json TEXT NOT NULL,
    mode TEXT NOT NULL,
    action_json TEXT NOT NULL,
    max_depth INTEGER NOT NULL,
    max_retries INTEGER NOT NULL,
    enabled INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (rule_id, version)
  );
CREATE TABLE agency_rule_match (
    id TEXT PRIMARY KEY,
    inbox_id TEXT NOT NULL,
    rule_version_id TEXT NOT NULL,
    matched INTEGER NOT NULL,
    explanation TEXT NOT NULL,
    evaluated_at TEXT NOT NULL,
    UNIQUE (inbox_id, rule_version_id),
    FOREIGN KEY (inbox_id) REFERENCES agency_inbox_event(id),
    FOREIGN KEY (rule_version_id) REFERENCES agency_rule_version(id)
  );
CREATE TABLE agency_action_intent (
    id TEXT PRIMARY KEY,
    match_id TEXT NOT NULL,
    unique_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    attempt_count INTEGER NOT NULL,
    lease_owner TEXT,
    lease_until TEXT,
    last_error TEXT,
    job_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (match_id) REFERENCES agency_rule_match(id)
  )`,
  `ALTER TABLE agency_action_intent ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agency_action_intent ADD COLUMN fencing_token TEXT;
ALTER TABLE agency_action_intent ADD COLUMN fencing_generation INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE agency_job_needs_input_answer ADD COLUMN queued_message_id TEXT;`,
  `ALTER TABLE agency_action_intent ADD COLUMN dispatch_claimed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agency_action_intent ADD COLUMN launch_id TEXT;`,
  CRON_OCCURRENCE_MIGRATION,
  `ALTER TABLE agency_agent_version ADD COLUMN reasoning_effort TEXT
    CHECK (
      reasoning_effort IS NULL OR reasoning_effort IN (
        'none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'
      )
    );`,
  `ALTER TABLE agency_job ADD COLUMN reviewer_agent_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agency_job ADD COLUMN observer_agent_ids TEXT NOT NULL DEFAULT '[]';`,
  `CREATE TABLE agency_parent_wake (
    activity_id TEXT NOT NULL,
    causation_id TEXT NOT NULL,
    child_job_id TEXT NOT NULL,
    child_key TEXT NOT NULL,
    child_state TEXT NOT NULL,
    parent_job_id TEXT NOT NULL,
    parent_attempt_id TEXT NOT NULL,
    parent_launch_id TEXT NOT NULL,
    parent_thread_id TEXT NOT NULL,
    send_state TEXT NOT NULL CHECK(send_state IN (
      'pending', 'confirmed', 'queued', 'unknown', 'rejected', 'skipped'
    )),
    send_code TEXT,
    send_message TEXT,
    dispatch_claimed INTEGER NOT NULL DEFAULT 0,
    queued_message_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (activity_id, parent_attempt_id),
    FOREIGN KEY (activity_id) REFERENCES agency_activity(id),
    FOREIGN KEY (child_job_id) REFERENCES agency_job(id),
    FOREIGN KEY (parent_job_id) REFERENCES agency_job(id)
  );
CREATE INDEX agency_parent_wake_pending_idx ON agency_parent_wake(send_state, dispatch_claimed);`,
  USAGE_COLLECTOR_MIGRATION,
  // Board hygiene: when a job last closed. Backfilled from the transition journal.
  `ALTER TABLE agency_job ADD COLUMN closed_at TEXT;
UPDATE agency_job SET closed_at = COALESCE(
  (SELECT MAX(a.timestamp) FROM agency_activity a
    WHERE a.job_id = agency_job.id
      AND a.kind = 'job_transitioned'
      AND a.references_json LIKE '%"id":"' || agency_job.state || '"%'),
  updated_at)
WHERE state IN ('done', 'canceled');`,
  // Projects can be disconnected; departments are open to all projects unless restricted.
  `ALTER TABLE agency_project_binding ADD COLUMN archived_at TEXT;
ALTER TABLE agency_department ADD COLUMN availability TEXT NOT NULL DEFAULT 'all'
  CHECK (availability IN ('all', 'selected'));`,
  COMPLETION_REMINDER_MIGRATION,
  RUN_WATCH_MIGRATION,
  // Role types in a department: member becomes executor, reviewer is new.
  // SQLite cannot change a CHECK constraint, so the table is rebuilt; nothing references it.
  `CREATE TABLE agency_membership_next (
    department_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('lead', 'executor', 'reviewer')),
    PRIMARY KEY (department_id, agent_id),
    FOREIGN KEY (department_id) REFERENCES agency_department(id),
    FOREIGN KEY (agent_id) REFERENCES agency_agent(id)
  );
INSERT INTO agency_membership_next (department_id, agent_id, role)
  SELECT department_id, agent_id, CASE role WHEN 'member' THEN 'executor' ELSE role END FROM agency_membership;
DROP TABLE agency_membership;
ALTER TABLE agency_membership_next RENAME TO agency_membership;
CREATE INDEX agency_membership_agent_idx ON agency_membership(agent_id);`,
  REWORK_MIGRATION,
  WORK_RULES_MIGRATION,
  DUE_REMINDER_MIGRATION,
  `ALTER TABLE agency_job ADD COLUMN contract_json TEXT`,
  TEMPLATES_MIGRATION,
  AGENCY_RULES_MIGRATION,
  LAUNCH_QUEUE_MIGRATION,
  AUTO_REVIEW_MIGRATION,
  RULE_SCHEDULE_MIGRATION,
  SOURCE_TOPICS_MIGRATION,
  TELEGRAM_OUTBOX_MIGRATION,
  KNOWLEDGE_MIGRATION,
  GOALS_MIGRATION,
  HIERARCHY_MIGRATION,
  SAVED_VIEWS_MIGRATION,
  `ALTER TABLE agency_agent_version ADD COLUMN plugin_ids TEXT`,
  `ALTER TABLE agency_agent ADD COLUMN workplace_binding_id TEXT`,
  SANDBOX_ESCAPE_MIGRATION,
  NEXT_STEP_MIGRATION,
  NIGHTLY_RECHECK_MIGRATION,
  OWNER_MESSAGE_MIGRATION,
  REMARK_PATTERN_MIGRATION,
  DEPARTMENT_ARCHIVE_MIGRATION,
  KIT_RECORD_MIGRATION,
  `ALTER TABLE agency_agent_version ADD COLUMN service_tier TEXT
    CHECK (service_tier IS NULL OR service_tier IN ('default', 'fast'));`,
  `ALTER TABLE agency_launch_queue ADD COLUMN failing_since TEXT;`,
  `ALTER TABLE agency_launch_queue ADD COLUMN dropped_at TEXT;`,
  ASSISTANT_MEMBERSHIP_MIGRATION,
  WORK_PROFILE_MIGRATION,
  `ALTER TABLE agency_job ADD COLUMN work_profile_key TEXT;`,
];

function statementHash(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

/** Index of the append-only rebuild that adds `awaiting_review`. Frozen; do not recompute from length. */
export const AWAITING_REVIEW_MIGRATION_ID = 37;

/** Test/helper migrate that mirrors BB: index = id, hash lock, append-only. */
export function applyAgencyMigrations(db: SqlDatabase, options?: { throughId?: number }): void {
  const throughId = options?.throughId ?? migrations.length - 1;
  db.exec(`CREATE TABLE IF NOT EXISTS _bb_migrations (
    id INTEGER PRIMARY KEY,
    hash TEXT NOT NULL
  )`);
  const existing = db.prepare("SELECT id, hash FROM _bb_migrations").all() as Array<{
    id: number;
    hash: string;
  }>;
  const byId = new Map(existing.map((row) => [row.id, row.hash]));
  const pending: Array<{ id: number; sql: string; hash: string }> = [];
  for (let id = 0; id <= throughId && id < migrations.length; id += 1) {
    const sql = migrations[id];
    const hash = statementHash(sql);
    const stored = byId.get(id);
    if (stored) {
      if (stored !== hash) {
        throw new Error(`migration ${id} was rewritten; append a new statement instead`);
      }
      continue;
    }
    pending.push({ id, sql, hash });
  }
  if (pending.length === 0) return;
  const apply = db.transaction(() => {
    for (const item of pending) {
      db.exec(item.sql);
      db.prepare("INSERT INTO _bb_migrations (id, hash) VALUES (?, ?)").run(item.id, item.hash);
    }
  });
  apply();
}

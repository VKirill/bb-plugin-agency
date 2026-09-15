import { randomUUID } from "node:crypto";
import { DomainTxnAbort, domainAbortResult, fail, matchRevision, ok, type DomainResult } from "../../domain";
import {
  approveActionIntentCommandSchema,
  claimActionIntentCommandSchema,
  completeActionIntentCommandSchema,
  dispatchTickCommandSchema,
  ingestInboxEventCommandSchema,
  listActionIntentsCommandSchema,
  listDispatcherCatalogCommandSchema,
  saveEventDefinitionCommandSchema,
  saveEventSourceCommandSchema,
  saveRuleVersionCommandSchema,
  type ActionIntentRecord,
  type CatalogRuleRecord,
  type DispatchTickRecord,
  type EventDefinitionRecord,
  type EventSourceRecord,
  type ListedActionIntent,
  type EventCondition,
  type InboxEventRecord,
  type RuleAction,
} from "../../shared/contracts";
import { canonicalizeJson, sha256Hex } from "../runtime/context-snapshot/canonical.js";
import { newOpaqueId } from "../db/ids.js";
import type { SqlDatabase } from "../db/sql";
import { parseJson, toJson } from "../db/sql";
import { nowUtc, type ServiceContext } from "../services/context.js";
import { uuidV5 } from "../runtime/launch/operation-ids.js";
import { compilePayloadSchema, validateEventPayload } from "./payload-schema.js";
import { unavailableDispatcherLaunchPort, type DispatcherLaunchPort } from "./ports.js";

const DISPATCH_LAUNCH_NS = "7c3e2b10-4a91-5e6f-8d2a-0b19c4e7a331";
const KNOWN_ENQUEUE_FAIL = new Set(["launch_failed", "capability_unavailable"]);

export type DispatcherDeps = {
  db: SqlDatabase;
  launch?: DispatcherLaunchPort;
};

type SourceRow = { id: string; project_id: string; kind: string; enabled: number };
type InboxRow = {
  id: string;
  source_id: string;
  project_id: string;
  event_id: string;
  topic: string;
  body_digest: string;
  body_json: string;
  reference: string;
  depth: number;
  state: string;
};
type RuleRow = {
  id: string;
  rule_id: string;
  version: number;
  project_id: string;
  source_id: string | null;
  topic: string;
  conditions_json: string;
  mode: string;
  action_json: string;
  max_depth: number;
  max_retries: number;
  enabled: number;
};
type IntentRow = {
  id: string;
  match_id: string;
  unique_key: string;
  state: string;
  attempt_count: number;
  revision: number;
  fencing_token: string | null;
  fencing_generation: number;
  lease_owner: string | null;
  lease_until: string | null;
  last_error: string | null;
  job_id: string | null;
  dispatch_claimed: number;
  launch_id: string | null;
};

const FORBIDDEN_BODY_KEYS = new Set(["provider", "model", "mcp", "skill", "shell", "systemPrompt"]);
const CLAIMABLE_STATES = new Set(["queued", "claimed"]);

function bodyDigest(body: unknown): string {
  return sha256Hex(canonicalizeJson(body));
}

/** v1 stored digest stays body-only. Identity is source+eventId plus topic/reference/depth+body. */
function sameIngestEnvelope(
  existing: InboxRow,
  input: { topic: string; reference: string; depth: number; body: unknown },
): boolean {
  return (
    existing.topic === input.topic &&
    existing.reference === input.reference &&
    existing.depth === input.depth &&
    existing.body_digest === bodyDigest(input.body)
  );
}

function readField(envelope: { topic: string; reference: string; body: Record<string, unknown> }, field: string): unknown {
  if (field === "topic") return envelope.topic;
  if (field === "reference") return envelope.reference;
  if (field.startsWith("data.")) {
    const data = envelope.body.data;
    const key = field.slice(5);
    if (data === null || typeof data !== "object" || Array.isArray(data) || !Object.hasOwn(data, key)) return undefined;
    return Reflect.get(data, key);
  }
  if (field.startsWith("subject.")) {
    const subject = envelope.body.subject;
    const key = field.slice(8);
    if (subject === null || typeof subject !== "object" || Array.isArray(subject) || !Object.hasOwn(subject, key)) {
      return undefined;
    }
    return Reflect.get(subject, key);
  }
  return undefined;
}

function conditionHolds(
  envelope: { topic: string; reference: string; body: Record<string, unknown> },
  condition: EventCondition,
): boolean {
  const actual = readField(envelope, condition.field);
  if (condition.op === "exists") return actual !== undefined && actual !== null;
  if (actual === undefined) return false;
  if (condition.op === "equals") return canonicalizeJson(actual) === canonicalizeJson(condition.value);
  if (condition.op === "in") {
    return Array.isArray(condition.value) && condition.value.some((item: unknown) => canonicalizeJson(item) === canonicalizeJson(actual));
  }
  return false;
}

function explain(
  envelope: { topic: string; reference: string; body: Record<string, unknown> },
  conditions: readonly EventCondition[],
): { matched: boolean; explanation: string } {
  if (conditions.length === 0) return { matched: true, explanation: "no conditions" };
  const parts: string[] = [];
  let matched = true;
  for (const condition of conditions) {
    const okCond = conditionHolds(envelope, condition);
    matched &&= okCond;
    parts.push(`${condition.field} ${condition.op} ${okCond ? "yes" : "no"}`);
  }
  return { matched, explanation: parts.join("; ") };
}

function abort(code: string, message: string): never {
  throw new DomainTxnAbort({ code, message });
}

export function saveEventDefinition(deps: DispatcherDeps, ctx: ServiceContext, raw: unknown): DomainResult<{ topic: string; schemaVersion: number; namespace: "bb" | "agency" | "integration"; label: string }> {
  const parsed = saveEventDefinitionCommandSchema.safeParse(raw);
  if (!parsed.success) return fail("invalid_command", parsed.error.message);
  const input = parsed.data;
  const schema = compilePayloadSchema(input.payloadSchema);
  if (!schema.ok) return schema;
  const now = nowUtc(ctx);
  deps.db
    .prepare(
      `INSERT INTO agency_event_definition (topic, schema_version, namespace, label, payload_schema_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(topic, schema_version) DO UPDATE SET
         namespace = excluded.namespace,
         label = excluded.label,
         payload_schema_json = excluded.payload_schema_json`,
    )
    .run(input.topic, input.schemaVersion, input.namespace, input.label, toJson(input.payloadSchema), now);
  return ok({ topic: input.topic, schemaVersion: input.schemaVersion, namespace: input.namespace, label: input.label });
}

export function saveEventSource(deps: DispatcherDeps, ctx: ServiceContext, raw: unknown): DomainResult<{ id: string; projectId: string; kind: string; enabled: boolean }> {
  const parsed = saveEventSourceCommandSchema.safeParse(raw);
  if (!parsed.success) return fail("invalid_command", parsed.error.message);
  const input = parsed.data;
  const id = newOpaqueId("eventSource");
  deps.db
    .prepare(`INSERT INTO agency_event_source (id, project_id, kind, enabled, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, input.projectId, input.kind, input.enabled ? 1 : 0, nowUtc(ctx));
  return ok({ id, projectId: input.projectId, kind: input.kind, enabled: input.enabled });
}

export function saveRuleVersion(deps: DispatcherDeps, ctx: ServiceContext, raw: unknown): DomainResult<{ id: string; ruleId: string; version: number; projectId: string; topic: string; mode: "disabled" | "observe" | "approve" | "auto"; enabled: boolean }> {
  const parsed = saveRuleVersionCommandSchema.safeParse(raw);
  if (!parsed.success) return fail("invalid_command", parsed.error.message);
  const input = parsed.data;
  const last = deps.db
    .prepare(`SELECT MAX(version) AS version FROM agency_rule_version WHERE rule_id = ?`)
    .get(input.ruleId) as { version: number | null };
  const version = (last.version ?? 0) + 1;
  const id = newOpaqueId("ruleVersion");
  deps.db
    .prepare(
      `INSERT INTO agency_rule_version (
        id, rule_id, version, project_id, source_id, topic, conditions_json, mode, action_json,
        max_depth, max_retries, enabled, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.ruleId,
      version,
      input.projectId,
      input.sourceId ?? null,
      input.topic,
      toJson(input.conditions),
      input.mode,
      toJson(input.action),
      input.maxDepth,
      input.maxRetries,
      input.enabled ? 1 : 0,
      nowUtc(ctx),
    );
  return ok({ id, ruleId: input.ruleId, version, projectId: input.projectId, topic: input.topic, mode: input.mode, enabled: input.enabled });
}

export function ingestInboxEvent(deps: DispatcherDeps, ctx: ServiceContext, raw: unknown): DomainResult<InboxEventRecord> {
  const parsed = ingestInboxEventCommandSchema.safeParse(raw);
  if (!parsed.success) return fail("invalid_command", parsed.error.message);
  const input = parsed.data;
  for (const key of Object.keys(input.body)) {
    if (FORBIDDEN_BODY_KEYS.has(key)) {
      return fail("invalid_command", `body field ${key} is not allowed as execution control`);
    }
  }
  const source = deps.db.prepare(`SELECT * FROM agency_event_source WHERE id = ?`).get(input.sourceId) as SourceRow | undefined;
  if (!source) return fail("not_found", `event source ${input.sourceId} not found`);
  if (!source.enabled) return fail("illegal_transition", `event source ${input.sourceId} is disabled`);
  const digest = bodyDigest(input.body);
  const existing = deps.db
    .prepare(`SELECT * FROM agency_inbox_event WHERE source_id = ? AND event_id = ?`)
    .get(input.sourceId, input.eventId) as InboxRow | undefined;
  if (existing) {
    if (!sameIngestEnvelope(existing, input)) {
      return fail("request_conflict", "eventId already used with a different topic, reference, depth, or body");
    }
    return ok({
      id: existing.id,
      sourceId: existing.source_id,
      projectId: existing.project_id,
      eventId: existing.event_id,
      topic: existing.topic,
      bodyDigest: existing.body_digest,
      state: existing.state as InboxEventRecord["state"],
      duplicate: true,
      depth: existing.depth,
    });
  }
  const definition = deps.db
    .prepare(
      `SELECT topic, payload_schema_json FROM agency_event_definition
       WHERE topic = ?
       ORDER BY schema_version DESC LIMIT 1`,
    )
    .get(input.topic) as { topic: string; payload_schema_json: string } | undefined;
  if (!definition) return fail("not_found", `event definition ${input.topic} is not registered`);
  const payload = validateEventPayload(parseJson(definition.payload_schema_json), input.body);
  if (!payload.ok) return payload;
  const id = newOpaqueId("inboxEvent");
  deps.db
    .prepare(
      `INSERT INTO agency_inbox_event (
        id, source_id, project_id, event_id, topic, body_digest, body_json, reference,
        provenance, depth, causation_id, state, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?)`,
    )
    .run(
      id,
      input.sourceId,
      source.project_id,
      input.eventId,
      input.topic,
      digest,
      toJson(input.body),
      input.reference,
      "notify.typed",
      input.depth,
      input.causationId ?? null,
      nowUtc(ctx),
    );
  return ok({
    id,
    sourceId: input.sourceId,
    projectId: source.project_id,
    eventId: input.eventId,
    topic: input.topic,
    bodyDigest: digest,
    state: "accepted",
    duplicate: false,
    depth: input.depth,
  });
}

function latestRules(db: SqlDatabase): RuleRow[] {
  return db
    .prepare(
      `SELECT r.* FROM agency_rule_version r
       JOIN (
         SELECT rule_id, MAX(version) AS version FROM agency_rule_version GROUP BY rule_id
       ) latest ON latest.rule_id = r.rule_id AND latest.version = r.version`,
    )
    .all() as RuleRow[];
}

function insertIntent(db: SqlDatabase, now: string, matchId: string, uniqueKey: string, state: ActionIntentRecord["state"], subjectId: string): string {
  const existing = db.prepare(`SELECT id FROM agency_action_intent WHERE unique_key = ?`).get(uniqueKey) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = newOpaqueId("actionIntent");
  db.prepare(
    `INSERT INTO agency_action_intent (
      id, match_id, unique_key, state, subject_id, attempt_count, revision, fencing_token, fencing_generation,
      lease_owner, lease_until, last_error, job_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, 1, NULL, 0, NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(id, matchId, uniqueKey, state, subjectId, now, now);
  return id;
}

export function dispatchTick(deps: DispatcherDeps, ctx: ServiceContext, raw: unknown): DomainResult<DispatchTickRecord> {
  const parsed = dispatchTickCommandSchema.safeParse(raw);
  if (!parsed.success) return fail("invalid_command", parsed.error.message);
  const input = parsed.data;
  const pending = deps.db
    .prepare(`SELECT * FROM agency_inbox_event WHERE state = 'accepted' ORDER BY received_at LIMIT ?`)
    .all(input.limit) as InboxRow[];
  const rules = latestRules(deps.db);
  let matchedCount = 0;
  let intentCount = 0;
  const now = nowUtc(ctx);
  for (const event of pending) {
    const body = parseJson(event.body_json) as Record<string, unknown>;
    const envelope = { topic: event.topic, reference: event.reference, body };
    for (const rule of rules) {
      let explanation = "";
      let matched = false;
      if (rule.project_id !== event.project_id) {
        explanation = "foreign project scope";
      } else if (rule.source_id && rule.source_id !== event.source_id) {
        explanation = "foreign source scope";
      } else if (rule.topic !== event.topic) {
        explanation = "topic mismatch";
      } else if (!rule.enabled || rule.mode === "disabled") {
        explanation = "rule disabled";
      } else if (event.depth >= rule.max_depth) {
        explanation = `depth ${event.depth} >= ${rule.max_depth}`;
      } else {
        const judged = explain(envelope, parseJson(rule.conditions_json) as EventCondition[]);
        matched = judged.matched;
        explanation = judged.explanation;
      }
      const matchId = newOpaqueId("ruleMatch");
      deps.db
        .prepare(
          `INSERT OR IGNORE INTO agency_rule_match (id, inbox_id, rule_version_id, matched, explanation, evaluated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(matchId, event.id, rule.id, matched ? 1 : 0, explanation, now);
      const stored = deps.db
        .prepare(`SELECT id, matched FROM agency_rule_match WHERE inbox_id = ? AND rule_version_id = ?`)
        .get(event.id, rule.id) as { id: string; matched: number };
      if (!matched || !stored.matched) continue;
      matchedCount += 1;
      const action = parseJson(rule.action_json) as RuleAction;
      const uniqueKey = `${event.id}:${rule.id}:${action.kind}`;
      const state =
        rule.mode === "approve" ? "awaiting_approval" : rule.mode === "observe" || action.kind === "observe" ? "observed" : "queued";
      insertIntent(deps.db, now, stored.id, uniqueKey, state, event.event_id);
      intentCount += 1;
    }
    deps.db.prepare(`UPDATE agency_inbox_event SET state = 'evaluated' WHERE id = ?`).run(event.id);
  }
  return ok({
    evaluated: pending.length,
    matched: matchedCount,
    intents: intentCount,
    live: false,
    legacyInboxIgnored: true,
  });
}

type IntentCatalogJoin = {
  topic: string | null;
  definitionLabel: string | null;
  ruleId: string | null;
  ruleLabel: string | null;
  sourceId: string | null;
  sourceKind: string | null;
};

function readIntentCatalog(db: SqlDatabase, matchId: string): IntentCatalogJoin {
  const row = db
    .prepare(
      `SELECT r.rule_id AS rule_id,
              r.topic AS topic,
              COALESCE(r.source_id, ev.source_id) AS source_id,
              COALESCE(rs.kind, es.kind) AS source_kind,
              d.label AS definition_label
       FROM agency_rule_match m
       JOIN agency_rule_version r ON r.id = m.rule_version_id
       LEFT JOIN agency_inbox_event ev ON ev.id = m.inbox_id
       LEFT JOIN agency_event_source rs ON rs.id = r.source_id
       LEFT JOIN agency_event_source es ON es.id = ev.source_id
       LEFT JOIN agency_event_definition d
         ON d.topic = r.topic
        AND d.schema_version = (
          SELECT MAX(schema_version) FROM agency_event_definition WHERE topic = r.topic
        )
       WHERE m.id = ?`,
    )
    .get(matchId) as
    | {
        rule_id: string;
        topic: string;
        source_id: string | null;
        source_kind: string | null;
        definition_label: string | null;
      }
    | undefined;
  if (!row) {
    return { topic: null, definitionLabel: null, ruleId: null, ruleLabel: null, sourceId: null, sourceKind: null };
  }
  return {
    topic: row.topic,
    definitionLabel: row.definition_label,
    ruleId: row.rule_id,
    ruleLabel: row.rule_id,
    sourceId: row.source_id,
    sourceKind: row.source_kind,
  };
}

function publicIntent(row: IntentRow): ActionIntentRecord {
  return {
    id: row.id,
    matchId: row.match_id,
    uniqueKey: row.unique_key,
    state: row.state as ActionIntentRecord["state"],
    attemptCount: row.attempt_count,
    revision: row.revision,
    fencingToken: row.fencing_token,
    fencingGeneration: row.fencing_generation,
    liveGate: row.state === "claimed" && row.last_error !== "live_gate",
    jobId: row.job_id,
    lastError: row.last_error,
  };
}

function listedIntent(db: SqlDatabase, row: IntentRow): ListedActionIntent {
  return { ...publicIntent(row), ...readIntentCatalog(db, row.match_id) };
}

function readIntent(db: SqlDatabase, id: string): IntentRow | undefined {
  return db.prepare(`SELECT * FROM agency_action_intent WHERE id = ?`).get(id) as IntentRow | undefined;
}

export function approveActionIntent(deps: DispatcherDeps, ctx: ServiceContext, raw: unknown): DomainResult<ActionIntentRecord> {
  const parsed = approveActionIntentCommandSchema.safeParse(raw);
  if (!parsed.success) return fail("invalid_command", parsed.error.message);
  const input = parsed.data;
  const txn = deps.db.transaction(() => {
    const row = readIntent(deps.db, input.intentId);
    if (!row) abort("not_found", `intent ${input.intentId} not found`);
    const revision = matchRevision(row.revision, input);
    if (!revision.ok) abort(revision.error.code, revision.error.message);
    if (row.state !== "awaiting_approval") {
      abort("illegal_transition", `approve requires awaiting_approval, got ${row.state}`);
    }
    const now = nowUtc(ctx);
    const updated = deps.db
      .prepare(
        `UPDATE agency_action_intent
         SET state = 'queued', last_error = NULL, revision = ?, updated_at = ?
         WHERE id = ? AND state = 'awaiting_approval' AND revision = ?`,
      )
      .run(revision.value.nextRevision, now, row.id, input.expectedRevision);
    if (updated.changes !== 1) abort("request_conflict", "approve lost the revision race");
    const next = readIntent(deps.db, row.id);
    if (!next) abort("not_found", `intent ${row.id} not found`);
    return next;
  });
  try {
    return ok(publicIntent(txn.immediate()));
  } catch (error) {
    return domainAbortResult(error) ?? fail("request_conflict", error instanceof Error ? error.message : String(error));
  }
}

export function listEventDefinitions(deps: DispatcherDeps, raw: unknown): DomainResult<EventDefinitionRecord[]> {
  const parsed = listDispatcherCatalogCommandSchema.safeParse(raw);
  if (!parsed.success) return fail("invalid_command", parsed.error.message);
  const rows = deps.db
    .prepare(
      `SELECT d.topic, d.schema_version, d.namespace, d.label
       FROM agency_event_definition d
       JOIN (
         SELECT topic, MAX(schema_version) AS schema_version
         FROM agency_event_definition
         GROUP BY topic
       ) latest ON latest.topic = d.topic AND latest.schema_version = d.schema_version
       ORDER BY d.topic`,
    )
    .all() as Array<{ topic: string; schema_version: number; namespace: EventDefinitionRecord["namespace"]; label: string }>;
  return ok(
    rows.map((row) => ({
      topic: row.topic,
      schemaVersion: row.schema_version,
      namespace: row.namespace,
      label: row.label,
    })),
  );
}

export function listEventSources(deps: DispatcherDeps, raw: unknown): DomainResult<EventSourceRecord[]> {
  const parsed = listDispatcherCatalogCommandSchema.safeParse(raw);
  if (!parsed.success) return fail("invalid_command", parsed.error.message);
  const projectId = parsed.data.projectId ?? null;
  const rows = deps.db
    .prepare(
      `SELECT id, project_id, kind, enabled FROM agency_event_source
       WHERE ? IS NULL OR project_id = ?
       ORDER BY created_at`,
    )
    .all(projectId, projectId) as Array<{ id: string; project_id: string; kind: string; enabled: number }>;
  return ok(
    rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      kind: row.kind,
      enabled: row.enabled === 1,
    })),
  );
}

export function listRuleVersions(deps: DispatcherDeps, raw: unknown): DomainResult<CatalogRuleRecord[]> {
  const parsed = listDispatcherCatalogCommandSchema.safeParse(raw);
  if (!parsed.success) return fail("invalid_command", parsed.error.message);
  const projectId = parsed.data.projectId ?? null;
  const rows = deps.db
    .prepare(
      `SELECT r.id, r.rule_id, r.version, r.project_id, r.topic, r.mode, r.enabled, r.source_id
       FROM agency_rule_version r
       JOIN (
         SELECT rule_id, MAX(version) AS version FROM agency_rule_version GROUP BY rule_id
       ) latest ON latest.rule_id = r.rule_id AND latest.version = r.version
       WHERE ? IS NULL OR r.project_id = ?
       ORDER BY r.rule_id`,
    )
    .all(projectId, projectId) as Array<{
      id: string;
      rule_id: string;
      version: number;
      project_id: string;
      topic: string;
      mode: CatalogRuleRecord["mode"];
      enabled: number;
      source_id: string | null;
    }>;
  return ok(
    rows.map((row) => ({
      id: row.id,
      ruleId: row.rule_id,
      version: row.version,
      projectId: row.project_id,
      topic: row.topic,
      mode: row.mode,
      enabled: row.enabled === 1,
      label: row.rule_id,
      sourceId: row.source_id,
    })),
  );
}

export function listActionIntents(deps: DispatcherDeps, raw: unknown): DomainResult<ListedActionIntent[]> {
  const parsed = listActionIntentsCommandSchema.safeParse(raw);
  if (!parsed.success) return fail("invalid_command", parsed.error.message);
  const projectId = parsed.data.projectId ?? null;
  const state = parsed.data.state ?? null;
  const rows = deps.db
    .prepare(
      `SELECT i.* FROM agency_action_intent i
       JOIN agency_rule_match m ON m.id = i.match_id
       JOIN agency_rule_version r ON r.id = m.rule_version_id
       WHERE (? IS NULL OR r.project_id = ?)
         AND (? IS NULL OR i.state = ?)
       ORDER BY i.created_at`,
    )
    .all(projectId, projectId, state, state) as IntentRow[];
  return ok(rows.map((row) => listedIntent(deps.db, row)));
}

export function expireIntentLease(db: SqlDatabase, intentId: string): void {
  db.prepare(`UPDATE agency_action_intent SET lease_until = '1970-01-01T00:00:00.000Z' WHERE id = ?`).run(intentId);
}

export function stableDispatchLaunchId(intentId: string): string {
  return uuidV5(DISPATCH_LAUNCH_NS, `agency.dispatcher.intent:${intentId}`);
}

function canRetryKnownFail(row: IntentRow): boolean {
  return row.dispatch_claimed === 1 && row.job_id === null && Boolean(row.last_error && KNOWN_ENQUEUE_FAIL.has(row.last_error));
}

function markDispatchedUnknown(db: SqlDatabase, row: IntentRow, now: string): IntentRow {
  if (row.job_id) return row;
  db.prepare(
    `UPDATE agency_action_intent
     SET last_error = 'send_needs_reconciliation', updated_at = ?
     WHERE id = ? AND dispatch_claimed = 1 AND fencing_token IS ? AND fencing_generation = ? AND job_id IS NULL`,
  ).run(now, row.id, row.fencing_token, row.fencing_generation);
  return readIntent(db, row.id) ?? row;
}

function applyLaunchOutcome(
  db: SqlDatabase,
  ctx: ServiceContext,
  fence: { id: string; fencingToken: string; fencingGeneration: number },
  outcome: { lastError: string | null; jobId: string | null; burnAttempt: boolean; maxRetries: number },
): IntentRow | undefined {
  const now = nowUtc(ctx);
  const current = readIntent(db, fence.id);
  if (
    !current ||
    current.fencing_token !== fence.fencingToken ||
    current.fencing_generation !== fence.fencingGeneration ||
    current.state !== "claimed"
  ) {
    return current;
  }
  let attempt = current.attempt_count;
  let state = current.state;
  if (outcome.burnAttempt) {
    attempt += 1;
    if (attempt >= outcome.maxRetries && outcome.lastError) state = "failed";
  }
  db.prepare(
    `UPDATE agency_action_intent
     SET last_error = ?, job_id = COALESCE(?, job_id), attempt_count = ?, state = ?, revision = revision + 1, updated_at = ?
     WHERE id = ? AND fencing_token = ? AND fencing_generation = ? AND state = 'claimed'`,
  ).run(outcome.lastError, outcome.jobId, attempt, state, now, fence.id, fence.fencingToken, fence.fencingGeneration);
  return readIntent(db, fence.id);
}

function casClaim(
  deps: DispatcherDeps,
  ctx: ServiceContext,
  input: { intentId: string; leaseOwner: string; leaseMs: number; live: boolean },
): DomainResult<{ mode: "enqueue" | "recover"; row: IntentRow }> {
  const txn = deps.db.transaction(() => {
    const row = readIntent(deps.db, input.intentId);
    if (!row) abort("not_found", `intent ${input.intentId} not found`);
    if (row.state === "failed") return { mode: "recover" as const, row };
    if (row.state === "awaiting_approval" || row.state === "observed" || row.state === "succeeded" || row.state === "canceled") {
      abort("illegal_transition", `intent ${row.state} cannot be claimed`);
    }
    if (!CLAIMABLE_STATES.has(row.state)) {
      abort("illegal_transition", `intent ${row.state} cannot be claimed`);
    }
    const nowIso = nowUtc(ctx);
    if (row.lease_until && row.lease_until > nowIso) {
      abort("request_conflict", "intent lease is held");
    }
    if (row.dispatch_claimed === 1 && !canRetryKnownFail(row)) {
      return { mode: "recover" as const, row: markDispatchedUnknown(deps.db, row, nowIso) };
    }
    const token = randomUUID();
    const lastError = input.live ? "claimed" : "live_gate";
    const leaseUntil = new Date(new Date(nowIso).getTime() + input.leaseMs).toISOString();
    const launchId = input.live ? (row.launch_id ?? stableDispatchLaunchId(row.id)) : row.launch_id;
    const updated = deps.db
      .prepare(
        `UPDATE agency_action_intent
         SET state = 'claimed',
             lease_owner = ?,
             lease_until = ?,
             fencing_token = ?,
             fencing_generation = fencing_generation + 1,
             last_error = ?,
             dispatch_claimed = CASE WHEN ? THEN 1 ELSE dispatch_claimed END,
             launch_id = COALESCE(launch_id, ?),
             revision = revision + 1,
             updated_at = ?
         WHERE id = ?
           AND state IN ('queued', 'claimed')
           AND (lease_until IS NULL OR lease_until <= ?)
           AND (
             dispatch_claimed = 0
             OR (
               dispatch_claimed = 1
               AND job_id IS NULL
               AND last_error IN ('launch_failed', 'capability_unavailable')
             )
           )`,
      )
      .run(
        input.leaseOwner,
        leaseUntil,
        token,
        lastError,
        input.live ? 1 : 0,
        launchId,
        nowIso,
        row.id,
        nowIso,
      );
    if (updated.changes !== 1) abort("request_conflict", "intent lease is held");
    const next = readIntent(deps.db, row.id);
    if (!next) abort("not_found", `intent ${row.id} not found`);
    return { mode: "enqueue" as const, row: next };
  });
  try {
    return ok(txn.immediate());
  } catch (error) {
    return domainAbortResult(error) ?? fail("request_conflict", error instanceof Error ? error.message : String(error));
  }
}

export async function claimActionIntent(
  deps: DispatcherDeps,
  ctx: ServiceContext,
  raw: unknown,
): Promise<DomainResult<ActionIntentRecord>> {
  const parsed = claimActionIntentCommandSchema.safeParse(raw);
  if (!parsed.success) return fail("invalid_command", parsed.error.message);
  const input = parsed.data;
  const claimed = casClaim(deps, ctx, input);
  if (!claimed.ok) return claimed;
  const row = claimed.value.row;
  if (claimed.value.mode === "recover" || row.state !== "claimed" || !input.live || !row.fencing_token || !row.launch_id) {
    return ok(publicIntent(row));
  }
  const match = deps.db
    .prepare(
      `SELECT m.id, r.max_retries, r.action_json FROM agency_rule_match m
       JOIN agency_rule_version r ON r.id = m.rule_version_id WHERE m.id = ?`,
    )
    .get(row.match_id) as { id: string; max_retries: number; action_json: string } | undefined;
  if (!match) return fail("not_found", `match ${row.match_id} not found`);
  const action = parseJson(match.action_json) as RuleAction;
  if (action.kind !== "prepare_job") {
    return ok(publicIntent(row));
  }
  const launch = deps.launch ?? unavailableDispatcherLaunchPort();
  const launched = await launch.enqueueLaunch({
    intentId: row.id,
    action,
    fencingToken: row.fencing_token,
    fencingGeneration: row.fencing_generation,
    launchId: row.launch_id,
  });
  const unavailable = !launched.ok && launched.error.code === "capability_unavailable";
  const next = applyLaunchOutcome(
    deps.db,
    ctx,
    { id: row.id, fencingToken: row.fencing_token, fencingGeneration: row.fencing_generation },
    {
      lastError: launched.ok ? null : launched.error.code,
      jobId: launched.ok ? launched.value.jobId : null,
      burnAttempt: launched.ok || !unavailable,
      maxRetries: match.max_retries,
    },
  );
  return ok(publicIntent(next ?? row));
}

export function completeActionIntent(deps: DispatcherDeps, ctx: ServiceContext, raw: unknown): DomainResult<ActionIntentRecord> {
  const parsed = completeActionIntentCommandSchema.safeParse(raw);
  if (!parsed.success) return fail("invalid_command", parsed.error.message);
  const input = parsed.data;
  const txn = deps.db.transaction(() => {
    const row = readIntent(deps.db, input.intentId);
    if (!row) abort("not_found", `intent ${input.intentId} not found`);
    if (row.state !== "claimed") abort("illegal_transition", `complete requires claimed, got ${row.state}`);
    if (row.fencing_token !== input.fencingToken || row.fencing_generation !== input.fencingGeneration) {
      abort("lease_fence_mismatch", "complete fence does not match the current claim");
    }
    const now = nowUtc(ctx);
    const state = input.outcome === "succeeded" ? "succeeded" : "failed";
    const updated = deps.db
      .prepare(
        `UPDATE agency_action_intent
         SET state = ?, last_error = ?, lease_until = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND state = 'claimed' AND fencing_token = ? AND fencing_generation = ?`,
      )
      .run(
        state,
        input.outcome === "succeeded" ? null : "launch_failed",
        now,
        now,
        row.id,
        input.fencingToken,
        input.fencingGeneration,
      );
    if (updated.changes !== 1) abort("request_conflict", "complete lost the fence race");
    const next = readIntent(deps.db, row.id);
    if (!next) abort("not_found", `intent ${row.id} not found`);
    return next;
  });
  try {
    return ok(publicIntent(txn.immediate()));
  } catch (error) {
    return domainAbortResult(error) ?? fail("request_conflict", error instanceof Error ? error.message : String(error));
  }
}

export function countLegacyInbox(db: SqlDatabase): number {
  return (db.prepare(`SELECT count(*) AS n FROM agency_inbox`).get() as { n: number }).n;
}

export function countTypedInbox(db: SqlDatabase): number {
  return (db.prepare(`SELECT count(*) AS n FROM agency_inbox_event`).get() as { n: number }).n;
}

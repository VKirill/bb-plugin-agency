---
title: Operational data model
type: data-model
created: 2026-09-28
updated: 2026-09-28
status: active
confidence: high
tags: [data-model, operations, sqlite]
sources:
  - src/server/flow/service.ts
  - src/server/lead-control/observations.ts
  - src/server/lead-control/state.ts
  - src/server/ideas/store.ts
  - src/server/templates/store.ts
  - src/server/rules/work-rules.ts
  - src/server/knowledge/store.ts
  - src/server/knowledge/remark-patterns.ts
  - src/server/delegation/session-policy.ts
  - src/server/decisions/log.ts
  - src/server/decisions/settings.ts
  - src/server/owner-messages/service.ts
  - src/server/runtime/loop-break/store.ts
  - src/server/runtime/reviewer-thread/service.ts
  - src/server/runtime/worker-context/store.ts
  - src/server/runtime/rework/service.ts
  - src/server/runtime/auto-review/service.ts
  - src/server/runtime/completion-reminder/service.ts
  - src/server/runtime/sandbox-escape/service.ts
  - src/server/runtime/recovery/escalation.ts
  - src/server/runtime/recovery/permit.ts
  - src/server/runtime/nightly-recheck/service.ts
  - src/server/runtime/trace/store.ts
  - src/server/runtime/launch-queue/issues.ts
  - src/server/runtime/launch-queue/service.ts
  - src/server/runtime/host-reconnect/service.ts
  - src/server/runtime/client-bounce/service.ts
  - src/server/runtime/usage-collector/migration.ts
  - src/server/runtime/agent-fallback.ts
  - src/server/runtime/observation/health.ts
  - src/server/runtime/due-reminder/service.ts
  - src/server/runtime/run-watch/service.ts
  - src/server/insights/archive.ts
  - src/server/organization/hierarchy.ts
  - src/server/organization/starter-kit.ts
  - src/server/organization/skill-pool.ts
  - src/server/organization/goals.ts
  - src/server/projects/passport.ts
  - src/server/projects/passport-settings.ts
  - src/server/triggers/schedules.ts
  - src/server/triggers/webhook-secrets.ts
  - src/server/triggers/telegram-outbox.ts
  - src/server/projects/work-profiles.ts
  - src/server/api/dashboard-usage-rpc.ts
  - src/server/register.ts
  - src/server/db/migrations.ts
  - src/server/knowledge/lessons.ts
  - src/server/triggers/cron/migration.ts
  - src/server/runtime/assistants/migration.ts
---
# Operational data model

TL;DR: Operational tables persist project memory, routing, reviews, dispatch, reminders, telemetry, and owner-facing state beyond the core job and run records.

## Project, organization, and memory records

| Table | Meaning (fields, allowed values, units) | Lifecycle and use |
| --- | --- | --- |
| `agency_job_next_step` | `job_id` primary key; `step_json` stores next-step instructions; `created_job_id` links the created follow-up; `outcome` stores the resolution; `updated_at` is UTC update time. | Written by next-step operations and read by job flow; one row per job. (`src/server/flow/service.ts:14-20`) |
| `agency_knowledge` | `id`, `title`, `body`, `source`; `scope_kind` is agency/department/project/section; `scope_id` identifies the scope; `status` is proposal/accepted/archived; `proposed_by`, `revision`, timestamps; summary, kind, importance, pinned, write reason, read count, last read time. | Knowledge services write and read records; read counters support use-aware retention. Fields were extended in the main migration. (`src/server/knowledge/store.ts:13-24`, `src/server/db/migrations.ts:680-700`) |
| `agency_remark_pattern` | `id`, department, signature, optional knowledge ID, job ID JSON, timestamps. | Groups repeated remarks for proposal generation; not itself a worker lesson. (`src/server/knowledge/remark-patterns.ts:12-19`) |
| `agency_department_parent` | Department ID, parent department ID, update time. | One parent link per department; hierarchy reads and writes this mapping. (`src/server/organization/hierarchy.ts:12-16`) |
| `agency_escalation` | Job ID, blocked-since timestamp, destination department, created and resolved times. | Composite key identifies a blocked period; hierarchy sweeps track open escalation rows. (`src/server/organization/hierarchy.ts:17-24`) |
| `agency_department_skill` | Department, skill ID, optional actor who added it, added time. | Composite key defines the skill pool; skill pool operations list and update it. (`src/server/organization/skill-pool.ts:17-23`) |
| `agency_skill_grant` | Grant ID, department/agent/job IDs, job key, skill ID/name, decision maker, optional confidence, created time. | Append-only grant record links a permission change to a job and decision maker. (`src/server/organization/skill-pool.ts:25-36`) |
| `agency_kit_record` | Record kind (department/agent), record ID, kit key, creation time. | Composite key marks entities created from a starter kit. (`src/server/organization/starter-kit.ts:14-20`) |
| `agency_goal` | ID, title, description, status (active/done/dropped), optional due time, revision, timestamps. | Goal mutations use revision; `agency_job_goal` links one job to a goal with update time. (`src/server/organization/goals.ts:7-20`) |
| `agency_project_passport` | Passport ID, BB project ID, header, sections JSON, source digest, accepted-job count, builder (model/owner), optional model, built time, revision, timestamps. | One current passport per BB project; passport service versions edits and rebuilds. (`src/server/projects/passport.ts:18-31`) |
| `agency_project_passport_version` | Version ID, project, revision, header, sections, builder, optional model, note, built time. | `(bb_project_id, revision)` is unique; stores previous revisions for restore/history. (`src/server/projects/passport.ts:33-44`) |
| `agency_passport_settings` | Singleton ID (=1), enabled flag, model endpoint, model/key references, timeout in milliseconds, rebuild frequency, revision, update time. | Settings service reads/writes this singleton. (`src/server/projects/passport-settings.ts:11-22`) |
| `agency_work_profile` | ID, BB project, key, title, triggers, body, samples JSON, acceptance text, revision, created/updated times. | Unique per project/key; profile service saves and deletes revisions. (`src/server/projects/work-profiles.ts:16-29`) |
| `agency_idea` | ID, title/body, kind (idea/todo), status (open/parked/done/archived), binding/optional section/label, optional source thread, relative file, optional file hash, revision/timestamps; later resolution, closed time and closed thread. | `ideas/store` mutates idea state and associated file; status is separate from job state. (`src/server/ideas/store.ts:6-25`) |
| `agency_template` | Key, text, revision, update time. | One current template per key. (`src/server/templates/store.ts:19-24`) |
| `agency_rules_version` | Version ID, unique version number, text, hash, creation time. | Immutable agency rules history. (`src/server/templates/store.ts:26-32`) |
| `agency_work_rules` | Scope key, serialized rules, revision, update time. | One current row per scope; rule service validates and reads the scope rules. (`src/server/rules/work-rules.ts:19-24`) |

## Owner decisions and communication

| Table | Meaning (fields, allowed values, units) | Lifecycle and use |
| --- | --- | --- |
| `agency_lead_decision` | Job ID, decision revision, serialized decision body, activity ID. | Composite job/revision key; decision service appends a decision associated with job activity. (`src/server/lead-control/state.ts:8-11`) |
| `agency_handin_protocol` | Attempt ID primary key. | Marks the attempt using explicit hand-in protocol. (`src/server/lead-control/state.ts:12`) |
| `agency_result_submission` | Attempt ID, artifact ID, version number, hash, activity ID. | One current submission per attempt; identifies exact submitted artifact version. (`src/server/lead-control/state.ts:13-16`) |
| `agency_lesson_feedback` | Activity ID primary key, job ID, knowledge ID/revision, outcome, evidence JSON, comment. | Feedback evaluates a named lesson revision using evidence; it does not infer quality from reads. (`src/server/lead-control/observations.ts:5-8`) |
| `agency_decision_log` | ID, creation time, decision point, optional job key, outcome, detail, serialized answers, duration in milliseconds. | Append-only decision-model trace, read by decision log operations. (`src/server/decisions/log.ts:15-24`) |
| `agency_decision_settings` | Singleton ID (=1), enabled, endpoint kind/base URL/model, key source/name, timeout in milliseconds, points JSON, revision, update time. | Decision settings service reads/writes settings; key values are referenced by name. (`src/server/decisions/settings.ts:17-29`) |
| `agency_owner_message` | ID, optional unique dedupe key, text, level, optional job, source, Telegram delivery state, created time, optional read time. | Owner-message service persists unread messages and deduplicates keyed notifications. (`src/server/owner-messages/service.ts:11-20`) |
| `agency_session_policy` | Scope kind (project/binding/thread), scope ID, mode (ordinary/suggest/pm), update time. | Composite scope key chooses the current chat delegation policy. (`src/server/delegation/session-policy.ts:11-17`) |
| `agency_session_pending` | BB project ID, mode (ordinary/suggest/pm), update time. | One pending mode per project, consumed by session policy application. (`src/server/delegation/session-policy.ts:20-25`) |
| `agency_worker_context` | Scope (agent/department), scope ID, revision, policy JSON, update time. | Composite key stores worker-context policy; reads combine department and agent revision. (`src/server/runtime/worker-context/store.ts:5-9`, `src/server/runtime/worker-context/store.ts:30-37`) |
| `agency_worker_context_request` | Request ID, request payload JSON, result JSON. | Idempotency record for worker-context RPC. (`src/server/runtime/worker-context/store.ts:10`) |
| `agency_telegram_delivery` | Delivery ID, job ID, kind, state, optional error, creation time. | Outbox delivery state is maintained by Telegram delivery processing. (`src/server/triggers/telegram-outbox.ts:11-18`) |
| `agency_source_topics` | Source ID, topic list JSON, update time. | One topic allowlist per source; webhook ingress reads it before event acceptance. (`src/server/triggers/webhook-secrets.ts:17-21`, `src/server/register.ts:2631-2645`) |

## Runtime control, recovery, and telemetry

| Table | Meaning (fields, allowed values, units) | Lifecycle and use |
| --- | --- | --- |
| `agency_loop_mark` | ID, root job, attempt, fingerprint, optional relation/cause, creation time. | Records repeated-loop signals used by loop-break checks. (`src/server/runtime/loop-break/store.ts:7-16`) |
| `agency_reviewer_thread` | Reviewer agent and line job, BB thread, origin launch/attempt/job, state (live/dead), optional dead reason, last job, timestamps. | One reusable reviewer thread per reviewer and line job. (`src/server/runtime/reviewer-thread/service.ts:20-33`) |
| `agency_rework` | Request, job, attempt, thread, returned hash, comment, send state, optional resolved time, timestamps. | Persists return-for-rework delivery and resolution. (`src/server/runtime/rework/service.ts:33-44`) |
| `agency_auto_review` | Job, submitted hash, optional review job, outcome, creation time. | Composite job/hash key deduplicates automatic review for one exact result. (`src/server/runtime/auto-review/service.ts:14-21`) |
| `agency_completion_reminder` | Attempt ID, job, count, optional idle time, awaiting-turn flag, optional last-send/blocked times, update time. | One reminder cursor per attempt; completion reminder service increments/checks it. (`src/server/runtime/completion-reminder/service.ts:17-26`) |
| `agency_sandbox_escape` | Attempt, job, thread, command count, optional last event sequence, update time. | Tracks observed command events for the bound attempt. (`src/server/runtime/sandbox-escape/service.ts:9-16`) |
| `agency_observer_health` | Launch/job/thread, stage, error code, first/last failure times, failure count, optional notified time. | Composite launch/stage key; repeated fault rows update, recovered stages are deleted, and notification is recorded after the service threshold. (`src/server/runtime/observation/health.ts:4-9`, `src/server/runtime/observation/health.ts:16-28`) |
| `agency_recovery_triage` | Job ID and lead-job ID. | One triage link per job; points a recovery issue to the responsible lead job. (`src/server/runtime/recovery/escalation.ts:8-10`) |
| `agency_recovery` | Request, job, payload, actor, round count, mark ID, launch failure count, creation time, optional consumed attempt. | Durable recovery permit; consumed attempt links permit use to a run. (`src/server/runtime/recovery/permit.ts:5-9`) |
| `agency_nightly_recheck` | Department, day, binding, optional review job, version count, outcome, window start/end, creation time. | Composite department/day/binding key stores one nightly check result. (`src/server/runtime/nightly-recheck/service.ts:12-23`) |
| `agency_trace` | Auto ID, first/last times, repeat count, optional job/key/root/revision/state and request/run/thread/artifact links, step/outcome/reason, duration milliseconds, facts/signature. | Aggregates signed runtime traces for diagnosis. (`src/server/runtime/trace/store.ts:16-22`) |
| `agency_launch_queue` | Job ID, request time, optional waiting reason, update time; later failing-since, dropped time, dropped revision. | One queue record per job; launch queue service claims and sweeps it. (`src/server/runtime/launch-queue/service.ts:15-20`, `src/server/db/migrations.ts:656-657`, `src/server/db/migrations.ts:745-746`) |
| `agency_launch_issue` | Job ID, revision, code, activity ID/JSON, creation time. | One current launch issue per job; issue service resolves/replaces it. (`src/server/runtime/launch-queue/issues.ts:8-11`) |
| `agency_host_retry` | Attempt, turn request, job, error sequence, state, claim time, optional delivery result. | Composite key deduplicates host reconnect retry for a request. (`src/server/runtime/host-reconnect/service.ts:6-10`) |
| `agency_client_bounce` | Wait ID, job, origin thread, send state (pending/queued/confirmed/unknown/rejected/skipped), optional send code/message, dispatch claim, queued message ID, timestamps. | Durable owner-thread notification tied to a wait. (`src/server/runtime/client-bounce/service.ts:9-21`) |
| `agency_usage_event` | Thread/event IDs, sequence, event creation time, optional provider thread/turn, last/total usage JSON, captured time. | Composite thread/event key and unique thread/sequence; usage collector records event deltas without transcripts. (`src/server/runtime/usage-collector/migration.ts:2-14`, `src/server/api/dashboard-usage-rpc.ts:21-34`) |
| `agency_due_reminder` | Job, reminder kind (soon/overdue), due time, sent time. | Composite key suppresses duplicate reminder for a job/kind/due timestamp. (`src/server/runtime/due-reminder/service.ts:12-18`) |
| `agency_run_watch` | Attempt, job, observed thread status, status/progress times, optional active/warn times, outcome/time, update time. | One observation cursor per attempt, updated by run-watch service. (`src/server/runtime/run-watch/service.ts:33-44`) |
| `agency_agent_primary_exhausted` | Agent, provider/model pair, exhaustion time, retry-after time. | One primary model exhaustion record per agent; fallback selection uses the stored window. (`src/server/runtime/agent-fallback.ts:43-50`) |
| `agency_agent_model_exhausted` | Agent, provider/model pair, exhaustion time, retry-after time. | Composite key records exhaustion per fallback model pair. (`src/server/runtime/agent-fallback.ts:53-62`) |
| `agency_saved_view` | ID, name, filters JSON, created/updated times. | Saved job-archive filter preset, owned by archive insight service. (`src/server/insights/archive.ts:11-17`) |

## Schedules and other host-facing state

| Table | Meaning (fields, allowed values, units) | Lifecycle and use |
| --- | --- | --- |
| `agency_rule_schedule` | Rule ID, cron expression, IANA timezone, misfire mode, update time. | One schedule definition per rule; schedule service computes next occurrences. (`src/server/triggers/schedules.ts:15-21`) |
| `agency_schedule_cursor` | Rule version, timezone, last scheduled UTC occurrence, update time. | One cursor per rule version. (`src/server/triggers/cron/migration.ts:2-7`) |
| `agency_schedule_occurrence` | Rule version, scheduled UTC timestamp, timezone, UTC offset minutes, misfire mode, state (planned/emitted/skipped), optional inbox ID, creation time. | Unique rule/time key prevents duplicate occurrence materialization. (`src/server/triggers/cron/migration.ts:8-18`) |
| `agency_passport_settings` | Singleton generation configuration; see [passport data](../data-model.md#project-organization-and-memory-records). | Settings owner is passport-settings service. (`src/server/projects/passport-settings.ts:11-22`) |
| `agency_department_parent`, `agency_escalation`, `agency_department_skill`, `agency_skill_grant`, `agency_goal`, `agency_project_passport`, `agency_project_passport_version`, and `agency_work_profile` | These are described in the project and organization section above. | Their owner modules implement entity reads/writes; no generic cleanup job is declared in the table definitions cited here. (`src/server/organization/hierarchy.ts:12-24`, `src/server/organization/skill-pool.ts:17-36`, `src/server/organization/goals.ts:7-20`, `src/server/projects/passport.ts:18-44`, `src/server/projects/work-profiles.ts:16-29`) |

No general-purpose cleanup behavior is inferred from a table declaration. Retention, expiry, or trimming applies only where the owning service implements it, for example knowledge lesson expiry and department trimming. (`src/server/knowledge/lessons.ts:1-22`)

## Relations

These are the foreign keys declared by the operational table definitions. Several operational tables use IDs in application logic without declaring SQLite foreign keys; those links are not represented here.

| Referencing table and key | Referenced table and key | Evidence |
| --- | --- | --- |
| `agency_membership` (`department_id`) | `agency_department` (`id`) | `src/server/runtime/assistants/migration.ts:13-14` |
| `agency_membership` (`agent_id`) | `agency_agent` (`id`) | `src/server/runtime/assistants/migration.ts:13-14` |
| `agency_lesson_feedback` (`activity_id`) | `agency_activity` (`id`) | `src/server/lead-control/observations.ts:6-7` |
| `agency_lesson_feedback` (`job_id`) | `agency_job` (`id`) | `src/server/lead-control/observations.ts:6-7` |
| `agency_lesson_feedback` (`knowledge_id`) | `agency_knowledge` (`id`) | `src/server/lead-control/observations.ts:6-7` |
| `agency_lead_decision` (`job_id`) | `agency_job` (`id`) | `src/server/lead-control/state.ts:9-10` |
| `agency_lead_decision` (`activity_id`) | `agency_activity` (`id`) | `src/server/lead-control/state.ts:9-10` |
| `agency_handin_protocol` (`attempt_id`) | `agency_run_attempt` (`id`) | `src/server/lead-control/state.ts:12` |
| `agency_result_submission` (`attempt_id`) | `agency_run_attempt` (`id`) | `src/server/lead-control/state.ts:14-15` |
| `agency_result_submission` (`activity_id`) | `agency_activity` (`id`) | `src/server/lead-control/state.ts:14-15` |
| `agency_client_bounce` (`job_id`) | `agency_job` (`id`) | `src/server/runtime/client-bounce/service.ts:21` |
| `agency_recovery` (`job_id`) | `agency_job` (`id`) | `src/server/runtime/recovery/permit.ts:6` |
| `agency_recovery_triage` (`job_id`, `lead_job_id`) | `agency_job` (`id`) | `src/server/runtime/recovery/escalation.ts:9` |
| `agency_launch_issue` (`job_id`) | `agency_job` (`id`) | `src/server/runtime/launch-queue/issues.ts:9` |

See [Core data model](../data-model.md) for jobs, attempts, artifacts, questions, and dispatcher entities.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agency data model](../data-model.md)

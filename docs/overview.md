---
title: Agency overview
type: overview
created: 2026-09-28
updated: 2026-09-28
status: active
confidence: medium
tags: [overview, jobs, launches]
sources:
  - package.json
  - server.ts
  - src/server/register.ts
  - src/app/pages/overview.tsx
  - src/app/prototype/jobs.tsx
  - src/app/prototype/job-detail.tsx
  - src/domain/job-state.ts
  - src/server/api/domain-rpc.ts
  - app.tsx
  - src/app/prototype/shell.tsx
  - src/app/data/rpc-agency-api.ts
  - src/app/prototype/inbox.tsx
  - src/app/prototype/machines.tsx
  - src/app/prototype/org-chart.tsx
  - src/app/prototype/people.tsx
  - src/app/prototype/runs.tsx
  - src/app/prototype/usage-page.tsx
  - src/app/prototype/goals.tsx
  - src/app/prototype/jobs-workspace.tsx
  - src/server/api/launch-rpc.ts
---
# Agency overview

TL;DR: Agency stores employees, departments, project bindings, jobs, launches, and result acceptance for a BB installation.

## Product boundary

Agency is registered as a BB plugin with server, host, app, and skills entry points. Its package manifest names `./server.ts`, `./host.ts`, `./app.tsx`, and the `skills` directory. (`package.json:1-10`, `server.ts:1-6`)

The app entry mounts `AgencyPrototype` in BB's navigation panel. The separate `OverviewPage` component fetches `status`, refreshes on `inbox-changed`, and renders the returned status and inbox count; it shows an error and retry control when the status call fails. (`app.tsx:1-19`, `src/app/pages/overview.tsx:6-27`)

The prototype shell routes to the job workspace, where `JobsWorkspace` combines scoped job lists and navigation. (`src/app/prototype/shell.tsx:9-16`, `src/app/prototype/shell.tsx:136-136`, `src/app/prototype/jobs-workspace.tsx:13-35`)

Jobs move through guarded states. Queueing requires an assignee, project binding, brief, and acceptance criteria; running also requires a bound thread; completion requires acceptance of the current published version and satisfied review policy. (`src/domain/job-state.ts:4-15`, `src/domain/job-state.ts:39-78`)

## Main user areas

| Area | What it presents | Implementation |
| --- | --- | --- |
| Job board | List or kanban view with project, department, employee, and scope filters | `JobsPage` (`src/app/prototype/jobs.tsx:43-50`, `src/app/prototype/jobs.tsx:80-139`) |
| Job detail | Job context, state actions, files, team, runs, and activity | `JobDetail` (`src/app/prototype/job-detail.tsx:58-63`) |
| Inbox | Items requiring attention, read state, dispatcher information, and messages | `InboxPage` (`src/app/prototype/inbox.tsx:12-71`) |
| Team | Employee and department pages, machine availability, org chart | `AgentsPage` (`src/app/prototype/people.tsx:25-33`), `MachinesPage` (`src/app/prototype/machines.tsx:12-35`), `OrgChart` (`src/app/prototype/org-chart.tsx:12-64`) |
| Operations | Runs, usage, goals, ideas, and automations | `RunsPage` (`src/app/prototype/runs.tsx:35-94`), `UsagePage` (`src/app/prototype/usage-page.tsx:23-82`), `GoalsPage` (`src/app/prototype/goals.tsx:24-83`) |

The page-specific interactions and sources are indexed in [UI implementation map](ui-plan.md). The system boundaries and API routes are described in [Architecture](architecture.md) and [BB API](bb-api.md).

## Worker execution

The Agency API is built from domain handlers over the database, BB catalog and host-file ports. The RPC client maps server results into typed API outcomes for the app. (`src/server/api/domain-rpc.ts:131-190`, `src/app/data/rpc-agency-api.ts:65-124`)

An employee launch is a coordinated BB thread operation. The product registers its server services in `registerAgency`; a successful build or an execution-status field alone does not create a worker run. (`src/server/register.ts:98-125`, `src/server/api/launch-rpc.ts:1-24`)

## Start here

- Read [Architecture](architecture.md) for module boundaries and runtime flow.
- Read [Data model](data-model.md) for persisted records and job/run transitions.
- Read [Deployment](deployment.md) for install, build, reload, and runtime checks.
- Read [Gotchas](gotchas.md) for state and host-file constraints.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agency documentation](README.md)

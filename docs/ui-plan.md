---
title: UI implementation map
type: component
created: 2026-09-13
updated: 2026-09-28
status: active
confidence: high
tags: [ui, screens, components]
sources:
  - app.tsx
  - DESIGN.md
  - src/app/prototype/shell.tsx
  - src/app/pages/overview.tsx
  - src/app/prototype/jobs.tsx
  - src/app/prototype/jobs-workspace.tsx
  - src/app/prototype/job-detail.tsx
  - src/app/prototype/inbox.tsx
  - src/app/prototype/job-accept.tsx
  - src/app/prototype/job-needs-input.tsx
  - src/app/prototype/task-question.tsx
  - src/app/prototype/job-team.tsx
  - src/app/prototype/job-launch-panel.tsx
  - src/app/prototype/file-workspace.tsx
  - src/app/prototype/passport.tsx
  - src/app/prototype/work-profiles.tsx
  - src/app/prototype/people.tsx
  - src/app/prototype/agent-detail.tsx
  - src/app/prototype/org-chart.tsx
  - src/app/prototype/machines.tsx
  - src/app/prototype/ideas-live.tsx
  - src/app/prototype/dispatcher-automations.tsx
  - src/app/prototype/automation.tsx
  - src/app/prototype/runs.tsx
  - src/app/prototype/usage-page.tsx
  - src/app/prototype/usage-dashboard.tsx
  - src/app/prototype/goals.tsx
  - src/app/prototype/create-forms.tsx
  - src/app/prototype/handoff.tsx
  - src/app/data/rpc-agency-api.ts
---
# UI implementation map

TL;DR: Agency's app is organized around a shared job board and job detail, with team, project, inbox, launch, memory, and operations pages backed by separate live APIs or demo data.

## Entry page and shared workspace

The app entry mounts `AgencyPrototype` in the BB navigation panel. The separate `OverviewPage` fetches `status`, refreshes on `inbox-changed`, and displays status/error state. The prototype shell routes the jobs section to `JobsWorkspace`; `JobsPage` renders list and kanban modes. (`app.tsx:1-19`, `src/app/pages/overview.tsx:6-27`, `src/app/prototype/shell.tsx:136-136`, `src/app/prototype/jobs-workspace.tsx:13-35`, `src/app/prototype/jobs.tsx:43-50`, `src/app/prototype/jobs.tsx:80-139`)

`JobDetail` receives a selected job, related jobs and entities, mutation callbacks, run navigation, and an explicit demo-mode flag. Its child panels present team, launch readiness, acceptance, needs-input, handoff, file workspace, and questions. (`src/app/prototype/job-detail.tsx:58-63`, `src/app/prototype/job-team.tsx:128-187`, `src/app/prototype/job-launch-panel.tsx:52-111`, `src/app/prototype/job-accept.tsx:19-78`, `src/app/prototype/job-needs-input.tsx:21-80`, `src/app/prototype/handoff.tsx:8-14`, `src/app/prototype/file-workspace.tsx:7-66`, `src/app/prototype/task-question.tsx:8-34`)

## How it works

1. The BB app mounts `AgencyPrototype`, whose shell chooses the active section and its page. (`app.tsx:1-19`, `src/app/prototype/shell.tsx:136-136`)
2. The jobs section composes `JobsWorkspace` with the `JobsPage` board. The board branches between list and kanban rendering; selecting a job opens `JobDetail` with related records and callbacks. (`src/app/prototype/jobs-workspace.tsx:13-35`, `src/app/prototype/jobs.tsx:80-139`, `src/app/prototype/job-detail.tsx:63-122`)
3. `JobDetail` composes the decision panels for team, launch, acceptance, owner input, handoff, files, and task questions. Each panel calls its provided callback; the data adapter maps RPC failures to an unavailable/error result instead of claiming a successful save. (`src/app/prototype/job-detail.tsx:63-122`, `src/app/data/rpc-agency-api.ts:65-124`)
4. Other shell sections render their own live or demo inputs. Live data comes through page APIs and demo data is explicitly supplied to the prototype; the demo branch is not persisted job state. (`src/app/prototype/runs.tsx:35-94`, `src/app/prototype/job-detail.tsx:58-63`)

| Branch or failure | Behavior |
| --- | --- |
| List / kanban | `JobsPage` renders the selected board mode with the same job collection. (`src/app/prototype/jobs.tsx:80-139`) |
| Live / demo | Live callbacks reach the data adapter; demo props render sample records and do not imply persistence. (`src/app/data/rpc-agency-api.ts:65-90`, `src/app/prototype/job-detail.tsx:58-63`) |
| API method unavailable | Workspace loading surfaces the unavailable result; the UI does not turn it into an empty successful workspace. (`src/app/data/rpc-agency-api.ts:65-90`) |
| Save/validation error | The owning panel displays the failed result and retains its local draft state. (`src/app/prototype/passport.tsx:20-32`, `src/app/prototype/work-profiles.tsx:14-43`) |

## Screen and component map

| Area | Component responsibilities | Sources |
| --- | --- | --- |
| Job queue | `JobsPage` presents list/kanban board modes; `JobsWorkspace` adds scope navigation and counts. | `src/app/prototype/jobs.tsx:43-50`, `src/app/prototype/jobs.tsx:80-139`, `src/app/prototype/jobs-workspace.tsx:13-35` |
| Inbox and ideas | `InboxPage` composes job attention, agents, read IDs, dispatcher state, and owner messages; `IdeasLivePage` manages live idea items and their states. | `src/app/prototype/inbox.tsx:12-71`, `src/app/prototype/ideas-live.tsx:35-94` |
| Job details | `JobDetail` composes the selected record; `JobAcceptControls` handles current-result decisions; `JobNeedsInputPanel` handles owner response; `TaskQuestionBlock` renders answer controls; `JobTeamBlock` edits team membership and roles. | `src/app/prototype/job-detail.tsx:58-63`, `src/app/prototype/job-accept.tsx:19-78`, `src/app/prototype/job-needs-input.tsx:21-80`, `src/app/prototype/task-question.tsx:8-34`, `src/app/prototype/job-team.tsx:128-187` |
| Launches and files | `JobLaunchPanel` covers launch controls and readiness; `FileWorkspace` displays the job's file workspace; `RunsPage` displays run history and live run lookup. | `src/app/prototype/job-launch-panel.tsx:52-111`, `src/app/prototype/file-workspace.tsx:7-66`, `src/app/prototype/runs.tsx:35-94` |
| Team and machines | `AgentsPage` lists employees; `AgentDetail` renders one agent profile; `OrgChart` renders department/agent relationships; `MachinesPage` displays BB machine inventory. | `src/app/prototype/people.tsx:25-33`, `src/app/prototype/agent-detail.tsx:28-87`, `src/app/prototype/org-chart.tsx:12-64`, `src/app/prototype/machines.tsx:12-35` |
| Projects and work context | `PassportPanel` loads and edits project passport drafts; `WorkProfilesPanel` edits project work profiles. | `src/app/prototype/passport.tsx:50-109`, `src/app/prototype/work-profiles.tsx:70-129` |
| Operations | `DispatcherAutomationsPage` edits event sources, rules, and dispatcher settings; `AutomationsPage` lists automation records; `GoalsPage` edits goals and links jobs; `UsagePage` and `UsageDashboard` present usage summaries and detail. | `src/app/prototype/dispatcher-automations.tsx:42-101`, `src/app/prototype/automation.tsx:12-15`, `src/app/prototype/goals.tsx:24-83`, `src/app/prototype/usage-page.tsx:23-82`, `src/app/prototype/usage-dashboard.tsx:88-147` |
| Creation | `AgencyCreateDialogs` supplies create forms for projects, agents, and departments. | `src/app/prototype/create-forms.tsx:15-76` |

## Data modes and failure behavior

| Mode | Input | Result and failure path | Source |
| --- | --- | --- | --- |
| Live job data | Typed RPC API and stored records | Mutations call persistence callbacks; API errors are surfaced to the caller. | `src/app/data/rpc-agency-api.ts:65-90`, `src/app/prototype/job-detail.tsx:58-63` |
| Demo job data | Demo records and `demoMode` | Rendered in the prototype path; not evidence of a persisted job or launch. | `src/app/prototype/job-detail.tsx:58-63`, `src/app/prototype/runs.tsx:35-94` |
| Form draft | Local component draft plus current revision | A successful save replaces the draft; errors are shown through notices while inputs remain in component state. | `src/app/prototype/passport.tsx:20-32`, `src/app/prototype/work-profiles.tsx:14-43`, `src/app/prototype/create-forms.tsx:17-76` |

Validation and error outcomes depend on the owning panel callback and RPC result type; the screen must not interpret an unsuccessful save as persisted state. (`src/app/data/rpc-agency-api.ts:65-90`, `src/app/prototype/passport.tsx:50-109`)

## Shared layout rule

The task view composes queue, detail, and history within one workspace. The visual canon is [DESIGN.md](../DESIGN.md); the implementation uses the BB plugin SDK and shared app data adapter. (`DESIGN.md:1-12`, `src/app/prototype/jobs-workspace.tsx:13-35`, `src/app/prototype/job-detail.tsx:63-122`, `src/app/data/rpc-agency-api.ts:65-124`)

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agency overview](overview.md)

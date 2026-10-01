---
title: Agency gotchas
type: gotchas
created: 2026-09-28
updated: 2026-09-28
status: active
confidence: low
tags: [gotchas, jobs, rpc, files]
sources:
  - src/domain/job-state.ts
  - src/server/api/auth.ts
  - src/server/api/project-access.ts
  - src/server/api/bound-files.ts
  - src/host/file-handlers.ts
  - src/server/api/dispatcher-rpc.ts
  - src/app/data/rpc-agency-api.ts
  - src/domain/spec-gate.ts
  - src/server/flow/spec-gate.ts
  - src/server/runtime/resource-lease/index.ts
  - src/server/db/migrations.ts
  - src/app/prototype/job-detail.tsx
  - src/app/prototype/runs.tsx
---
# Agency gotchas

TL;DR: UI state, BB thread state, job state, and persisted launch state are separate contracts; use the guarded domain operation that owns the transition.

## Job and run state

- `running` requires the job to have a bound thread. An idle thread without a published current artifact does not satisfy the `review` transition. (`src/domain/job-state.ts:46-70`)
- `done` requires acceptance of the current version and a satisfied review policy. A finished worker attempt is not sufficient. (`src/domain/job-state.ts:64-78`)
- A return from `waiting_input` requires confirmed continuation and no remaining questions or blockers. A return from review to running requires a rework comment. (`src/domain/job-state.ts:49-63`)
- `evaluateSpecGate` requires an accepted, linked specification only for the configured new-program department path; bounded discovery/spike work is excluded. (`src/domain/spec-gate.ts:34-68`)

The specification gate evaluates work kind, configured departments, accepted specification jobs, exact artifact version/hash links, and explicit dependencies. The server flow gathers the job tree, calls this domain decision, and returns `spec_required` when a required gate is unsatisfied. (`src/domain/spec-gate.ts:34-68`, `src/server/flow/spec-gate.ts:115-123`, `src/server/flow/spec-gate.ts:154-163`)

## RPC identity and scope

- The SDK RPC handler receives input only. `origin` is not treated as a secret, and a missing origin is allowed by the declared auth contract. (`src/server/api/auth.ts:11-27`)
- Owner calls act as the installation's `system` actor. A thread-bound worker is resolved to its attempt; project scope checks then compare that attempt's job binding. (`src/server/api/auth.ts:43-56`, `src/server/api/project-access.ts:11-19`)
- Listing BB projects is a catalog check for creating a binding, not a grant to access all existing bindings. (`src/server/api/auth.ts:11-21`)

## Host files

- Bound file operations resolve a verified host and project root before crossing to the host. The `canonicalRoot` is a path jail and is not itself an access grant. (`src/server/api/bound-files.ts:1-23`, `src/host/file-handlers.ts:5-8`)
- `writeAtomic` requires base64 bytes; `replace` requires bytes and the expected hash. Reads return bytes plus a content hash; `stat` distinguishes missing files; remove reports the guarded filesystem result. (`src/host/file-handlers.ts:8-53`)
- The resource-lease module exports a migration constant, but the main migration list does not include it. The module therefore does not create an active database table through the registered migrations. (`src/server/runtime/resource-lease/index.ts:6-15`, `src/server/db/migrations.ts:50-52`) See [Data model](data-model.md) and [Architecture](architecture.md) for the persisted state and runtime ownership documented by this project.

## Dispatcher and UI

- Dispatcher RPC methods resolve access for mutations, while list methods call their read functions directly. The existence of a page or method does not imply a background dispatch loop is enabled. (`src/server/api/dispatcher-rpc.ts:25-59`)
- `createRpcAgencyApi` maps unknown RPC methods to an unavailable state for workspace loading; it does not return an empty successful workspace. (`src/app/data/rpc-agency-api.ts:65-90`)
- Prototype screens can receive demo data and live API data through separate props. Treat demo records as examples, never as persisted jobs. (`src/app/prototype/runs.tsx:35-94`, `src/app/prototype/job-detail.tsx:58-63`)

See [Data model](data-model.md) for persistent state and [BB API](bb-api.md) for endpoint boundaries.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agency documentation](README.md)
- [BB API and Agency routes](bb-api.md)
- [Agency data model](data-model.md)
- [Dependencies and compatibility](dependencies.md)
- [Agency overview](overview.md)

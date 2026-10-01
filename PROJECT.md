---
title: Agency project facts
updated: 2026-10-01
sources:
  - package.json
  - server.ts
  - host.ts
  - src/server/register.ts
  - src/server/api/auth.ts
  - src/server/api/domain-rpc.ts
  - src/server/api/dispatcher-rpc.ts
  - src/server/api/project-access.ts
  - src/domain/job-state.ts
  - src/server/db/migrations.ts
  - src/host/file-handlers.ts
---
# Agency project facts

## Identity

- BB plugin: `bb-plugin-agency`, package version `0.1.0-alpha.18`. (package.json:1-3)
- Product scope: employees, departments, projects, jobs, artifact versions, launches, and acceptance. ([Agency overview](docs/overview.md))
- BB entry points: server `server.ts`, host `host.ts`, app `app.tsx`, skills directory `skills/`. (package.json:5-10)

## Entry points

- `server.ts` → `registerAgency(bb)`. (server.ts:1-6, src/server/register.ts:98-125)
- `host.ts` → `hostEntryHandlers` for document and guarded file operations. (host.ts:1-8, src/host/entry-handlers.ts:1-10)
- `app.tsx` → BB navigation panel and custom owner-question interaction. (app.tsx:1-19)
- `src/server/api/domain-rpc.ts` → entity and job RPC handlers. ([API map](docs/bb-api.md))
- `src/server/api/dispatcher-rpc.ts` → event and action-intent RPC handlers. ([API map](docs/bb-api.md))
- `src/domain/` → pure state transition rules. ([Architecture](docs/architecture.md))

## Critical invariants

- SQLite state is owned by Agency; migrations are append-only. ([Data model](docs/data-model.md))
- Job `running` requires a bound thread; `done` requires acceptance of the current version and satisfied review policy. (Job state (src/domain/job-state.ts:39-78))
- Launches go through the coordinator and BB thread API; reconcile is not another spawn. ([Architecture](docs/architecture.md))
- Worker file operations use a verified binding and host/path jail. (src/host/file-handlers.ts:8-53, [Gotchas](docs/gotchas.md))
- Mutations carry `expectedRevision`; on conflict reload before retry. ([Data model](docs/data-model.md))
- Demo records and live persisted records are distinct UI modes. ([UI map](docs/ui-plan.md))

## Conventions

- Shared RPC schemas live under `src/shared/`; domain transition logic lives under `src/domain/`. ([Architecture](docs/architecture.md))
- Run status, job status, result publication, and acceptance are separate state changes. ([Data model](docs/data-model.md))
- CLI operations use `bb agency` and `--input-json`; API and CLI share domain handlers. ([CLI](docs/cli.md))
- UI uses BB SDK components and follows the root `DESIGN.md`; do not edit the design canon. ([UI map](docs/ui-plan.md), [DESIGN.md](DESIGN.md))

## Common gotchas

- A BB thread becoming idle does not accept a result or complete a job. ([Gotchas](docs/gotchas.md))
- An unknown launch outcome must be reconciled before any retry. ([Data model](docs/data-model.md))
- `POST /notify` is the signed webhook ingress; `auth.ts`, `dispatcher-rpc.ts`, `domain-rpc.ts`, and `project-access.ts` are RPC handlers/helpers, not separate `ANY /api/...` routes. BB registers the combined shared contract. (src/server/register.ts:2630-2657, src/server/register.ts:2959-2965, src/server/api/auth.ts:19-31, [BB API](docs/bb-api.md))
- The resource-lease module is not connected to the live migration or launch path. ([Gotchas](docs/gotchas.md))
- Package engine ranges do not prove compatibility for every BB, SDK, or Node version in the range. ([Dependencies](docs/dependencies.md))

## Useful commands

Package scripts provide the local checks (`package.json:61-65`); BB CLI runtime commands are in [Deployment](docs/deployment.md).

```sh
npm ci --include=dev
npm run typecheck
npm test
npm run build
bb plugin reload agency
bb agency status --json
bb agency help
```


## Where to look next

- System and request flow: [Architecture](docs/architecture.md)
- Tables, fields, and lifecycle: [Data model](docs/data-model.md)
- UI screens and route sources: [UI implementation map](docs/ui-plan.md)
- Runtime hazards: [Gotchas](docs/gotchas.md)
- Dependency declarations and checks: [Dependencies](docs/dependencies.md), [Toolchain validation](docs/toolchain-validation.md)

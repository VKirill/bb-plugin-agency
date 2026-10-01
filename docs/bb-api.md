---
title: BB API and Agency routes
type: capabilities
created: 2026-09-13
updated: 2026-10-01
status: active
confidence: high
tags: [api, rpc, routes]
sources:
  - src/server/register.ts
  - host.ts
  - src/server/api/auth.ts
  - src/server/api/domain-rpc.ts
  - src/server/api/dispatcher-rpc.ts
  - src/server/api/launch-rpc.ts
  - src/server/api/dashboard-usage-rpc.ts
  - src/server/api/bound-files.ts
  - src/server/api/project-access.ts
  - src/server/api/project-rules.ts
  - src/server/api/resolve-preview.ts
  - src/server/api/catalog.ts
  - src/server/api/bb-catalog.ts
  - src/server/api/capability-catalog.ts
  - src/server/api/caller.ts
  - src/server/api/executing-activity-rpc.ts
  - src/server/api/project-sections.ts
  - src/app/data/rpc-agency-api.ts
  - src/app/data/persist-create.ts
  - src/host/entry-handlers.ts
---
# BB API and Agency routes

TL;DR: Agency registers one typed plugin RPC contract, a CLI, a host-file contract, and a signed webhook ingress; API modules are implementation boundaries, not separate HTTP route registrations.

## Registered transports

`registerAgency` creates the domain, launch, dispatcher, and executing-activity handlers and registers the typed `rpcContract` with BB. It registers Agency CLI operations separately. (`src/server/register.ts:98-125`, `src/server/register.ts:2959-2965`)

The only direct HTTP route registered in `registerAgency` is `POST /notify`. It has BB session auth disabled because the webhook source authenticates via HMAC over timestamp and raw body. Ingress validation, rate limiting, durable event receipt, and response codes are delegated to webhook ingress ports. (`src/server/register.ts:2630-2657`)

The host contract is separate from plugin RPC. It exposes document materialization and guarded file operations to the host process. (`host.ts:1-8`, `src/host/entry-handlers.ts:1-10`)

## RPC authentication and caller scope

`SDK_RPC_AUTH` describes the BB SDK transport as `POST /api/v1/plugins/:id/rpc/:method`. The Agency does not mount `ANY /api/auth`; `auth.ts` supplies the context resolver used by RPC handlers. Handler inputs contain no caller actor, origin is not secret, and a missing origin is allowed. `resolveRpcAccess` sets the actor to `system`, includes stored Agency bindings, and associates the current BB thread with an Agency attempt when one resolves. (`src/server/api/auth.ts:11-31`, `src/server/api/auth.ts:54-65`, `src/server/register.ts:2959`)

A worker's project access is checked by `projectAccessAllowed`: owner calls and calls without a project pass; otherwise the requested BB project must match the project of the caller's job. This helper is applied in the registered handler wiring, not mounted as `ANY /api/project-access`. (`src/server/api/project-access.ts:9-19`, `src/server/register.ts:1155`)

## API modules

| Module | Role | Evidence |
| --- | --- | --- |
| `auth` | Resolves the installation-owner RPC context, binds a calling thread to its Agency attempt when possible, and verifies BB project/environment/host/root placement during binding creation. It is not an `ANY /api/auth` route. | `src/server/api/auth.ts:19-31`, `src/server/api/auth.ts:54-82` |
| `bb-catalog` | Reads BB project, host, environment and policy catalog data; validates binding placement against environment metadata. | `src/server/api/bb-catalog.ts:1-28`, `src/server/api/auth.ts:61-79` |
| `bound-files` | Resolves file operations against a verified project binding and delegates to the host file port; not exposed on plugin RPC. | `src/server/api/bound-files.ts:1-23` |
| `caller` | Tracks the SDK calling thread and resolves an Agency attempt associated with it. | `src/server/api/caller.ts:1-28` |
| `capability-catalog` | Returns skill/MCP catalog data together with explicit discovery and isolation flags. | `src/server/api/capability-catalog.ts:1-24` |
| `catalog` | Reads stored agents, departments, bindings, memberships, jobs, policies, and versions for API handlers. | `src/server/api/catalog.ts:1-28` |
| `dashboard-usage-rpc` | Reads usage events for exact Agency-bound threads and provides the usage collector ports. | `src/server/api/dashboard-usage-rpc.ts:1-34` |
| `dispatcher-rpc` | Builds shared-contract handlers for event definitions and sources, rule versions, inbox ingestion, dispatch ticks, and action intents. Mutating methods resolve RPC access; list methods read through the dispatcher engine. It is not an `ANY /api/dispatcher-rpc` route. | `src/server/api/dispatcher-rpc.ts:21-58` |
| `domain-rpc` | Builds shared-contract handlers for workspace, entity, job, artifact, question, project-rule, and acceptance operations. Mutations resolve RPC access and call `onChanged` after a successful result. It is not an `ANY /api/domain-rpc` route. | `src/server/api/domain-rpc.ts:59-110`, `src/server/api/domain-rpc.ts:168-177` |
| `executing-activity-rpc` | Counts executing jobs by looking up threads for Agency-bound candidates. | `src/server/api/executing-activity-rpc.ts:1-22` |
| `launch-rpc` | Implements readiness, prepare, reconcile, completion, and attempt-list operations for coordinated launches. | `src/server/api/launch-rpc.ts:1-24` |
| `project-access` | Checks a requested BB project against the project bound to the caller job, while allowing owner calls and requests without a project. It is a helper, not an `ANY /api/project-access` route. | `src/server/api/project-access.ts:9-19` |
| `project-rules` | Reads and saves the binding's `.bb/AGENTS.md` under the defined path and size contract. | `src/server/api/project-rules.ts:1-27` |
| `project-sections` | Reads BB project-folder sections used for binding labels. | `src/server/api/project-sections.ts:1-28` |
| `resolve-preview` | Resolves stored artifact metadata and an eligible project-bound preview path. | `src/server/api/resolve-preview.ts:1-30` |

## Project binding creation

`persistCreateBinding` resolves the policy in this order: use the selected policy ID, reuse an existing policy matching the standard binding policy for the selected host, or create that standard policy. A policy-resolution failure returns before the binding request. On success, the client sends a new request ID with the BB project, environment, host, canonical root, policy ID, and a null section ID. (`src/app/data/persist-create.ts:51-63`, `src/app/data/persist-create.ts:66-81`)

The domain RPC verifies the environment's project, host, and canonical root against BB catalog metadata before storing the binding. A mismatch returns the placement failure; successful verification proceeds to the domain store. (`src/server/api/domain-rpc.ts:387-391`, `src/server/api/auth.ts:61-82`)

The named modules `auth.ts`, `dispatcher-rpc.ts`, `domain-rpc.ts`, and `project-access.ts` are not independently mounted `ANY /api/...` HTTP routes. BB receives the combined handlers when `registerAgency` calls `bb.rpc.register(rpcContract, rpcHandlers)`; `SDK_RPC_AUTH.httpRoute` identifies the SDK's RPC transport route. (`src/server/register.ts:2959-2965`, `src/server/api/auth.ts:19-31`)

## Client adapter

`createRpcAgencyApi` calls named methods in the shared RPC contract, validates response envelopes, normalizes catalog values, and preserves unavailable/error outcomes for the app. (`src/app/data/rpc-agency-api.ts:65-124`)

See [Architecture](architecture.md) for request flow and [Gotchas](gotchas.md) for identity and file constraints.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agency documentation](README.md)
- [Agency architecture](architecture.md)
- [Agency gotchas](gotchas.md)
- [Файлы, вопросы, передача работы и подключения](interaction-and-runtime.md)
- [Собственные MCP сотрудника](mcp-import.md)
- [Agency overview](overview.md)
- [Ревью Агентства: Multica, план и интерфейс](product-review.md)

---
title: Agency documentation
type: overview
created: 2026-09-14
updated: 2026-09-28
status: active
confidence: medium
tags: [documentation, agency]
sources:
  - package.json
  - src/server/register.ts
  - src/server/api/auth.ts
  - docs/overview.md
  - docs/architecture.md
  - docs/data-model.md
  - docs/bb-api.md
  - docs/cli.md
  - docs/deployment.md
  - docs/dependencies.md
  - docs/toolchain-validation.md
---
# Agency documentation

TL;DR: This directory documents Agency's product boundaries, runtime, data, API, and operator workflows.

## Start here

- [Overview](overview.md) describes Agency's scope and entry points.
- [Architecture](architecture.md) maps server, host, app, domain, and persistence boundaries.
- [Data model](data-model.md) explains stored entities and their lifecycles.
- [BB API and Agency routes](bb-api.md) documents the registered RPC contract and API modules. The `src/server/api/` files are handler modules; BB registers the shared RPC contract through `bb.rpc.register` (`src/server/register.ts:2959`, `src/server/api/auth.ts:19-31`).
- [CLI](cli.md) documents `bb agency` operations; the command is registered from the plugin server (`src/server/register.ts:2960-2964`).
- [Deployment](deployment.md) covers local installation, build, reload, and runtime checks. The package declares the server, host, app, and skills entry points (`package.json:10-17`).

## Runtime references

- [Dependencies and compatibility](dependencies.md) owns declared package ranges and compatibility evidence.
- [Toolchain validation](toolchain-validation.md) records what CI checks and what it does not exercise.
- [Gotchas](gotchas.md) records runtime constraints that affect operation.

Product and API details live on the linked pages; this page routes readers to those owners.

---
title: Agency deployment
type: deployment
created: 2026-09-28
updated: 2026-10-01
status: active
confidence: medium
tags: [deployment, install, build]
sources:
  - package.json
  - .github/workflows/agency-check.yml
  - server.ts
  - src/server/register.ts
  - host.ts
  - src/host/entry-handlers.ts
---
# Agency deployment

TL;DR: Build and install the plugin from its package directory, then confirm registration and runtime status through BB's plugin and Agency CLIs.

## Prerequisites

The package declares Node `^22.19.0 || ^24.0.0 || ^26.0.0`, BB `>=0.43.1`, and Plugin SDK `>=0.4.87`; the SDK dev dependency is pinned to `0.4.87`. These are manifest declarations, not a tested compatibility matrix. (`package.json:5-9`, `package.json:28-30`)

## Local install

From the plugin directory:

```sh
npm ci --include=dev
npm run typecheck
npm test
npm run build
bb plugin install .
bb plugin reload agency
bb agency status --json
```

The package scripts map `typecheck` to `tsc --noEmit`, `test` to `vitest run`, and `build` to `bb plugin build`. (`package.json:49-54`)

## Runtime registration

BB loads the plugin through `server.ts`, which delegates to `registerAgency`. The host entry is configured separately and dispatches file handlers. (`server.ts:1-6`, `host.ts:1-8`, `src/host/entry-handlers.ts:1-10`)

`registerAgency` initializes the plugin database, RPC services, runtime lifetime, and integrations. A reload is required for the host to load rebuilt bundles; the build command itself does not reload BB. (`src/server/register.ts:98-155`)

## CI build

CI installs the plugin lockfile, runs typecheck and tests, validates the SDK pin, installs `bb-app@0.43.1` into a temporary toolchain prefix, and runs its `bb plugin build`. (`.github/workflows/agency-check.yml:18-47`)

CI does not perform live BB reload or exercise an interactive job launch. Those runtime checks must be made against the configured BB installation. (`.github/workflows/agency-check.yml:12-59`, `src/server/register.ts:98-125`)

For version ranges and their evidence limits, see [Dependencies and compatibility](dependencies.md) and [Toolchain validation](toolchain-validation.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agency documentation](README.md)
- [Agency overview](overview.md)
- [Toolchain validation](toolchain-validation.md)

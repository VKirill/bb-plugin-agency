---
title: Dependencies and compatibility
type: gotchas
created: 2026-09-14
updated: 2026-10-01
status: active
confidence: medium
tags: [dependencies, compatibility, runtime]
sources:
  - package.json
  - package-lock.json
  - .github/workflows/agency-check.yml
  - src/server/register.ts
  - server.ts
  - src/app/data/rpc-agency-api.ts
  - src/host/file-handlers.ts
  - src/server/triggers/cron/migration.ts
---
# Dependencies and compatibility

TL;DR: The manifest declares BB and SDK minimums; the exact SDK package remains pinned at 0.4.87, while the lockfile records the installed dependency graph.

## Declared runtime ranges

| Component | Declaration | Evidence and limit |
| --- | --- | --- |
| Node.js | `^22.19.0 || ^24.0.0 || ^26.0.0` | Package metadata; CI selects Node 22.19.0. Local verification on other Node majors is not implied. (`package.json:5-9`, `.github/workflows/agency-check.yml:12-16`) |
| BB | `>=0.43.1` | Package metadata minimum. This range is not an end-to-end compatibility matrix. (`package.json:5-9`) |
| BB Plugin SDK | `>=0.4.87` | Engine metadata minimum; the development dependency itself is exactly `0.4.87`. (`package.json:5-9`, `package.json:28-30`) |
| Agency | `0.1.0-alpha.18` | Package version. (`package.json:1-3`) |

The expanded BB and SDK engine ranges are declarations in `package.json` and the lockfile root package metadata. They do not show which newer BB or SDK versions have passed live UI, host-file, RPC, or launch checks. (`package-lock.json:5-12`, `src/server/register.ts:1-4`, `src/host/file-handlers.ts:8-53`)

## Dependency roles

Production dependencies include icons and UI primitives, `cron-parser`, and Zod. The application-facing API parses RPC envelopes and workspace responses; cron parsing is used by schedule handling. (`package.json:11-20`, `src/app/data/rpc-agency-api.ts:65-90`, `src/server/triggers/cron/migration.ts:1-18`)

The SDK and TypeScript tooling are development dependencies. React, React DOM, and portal components are supplied by the BB plugin runtime and are not declared as production dependencies. The CI workflow installs the exact SDK pin from the manifest and lockfile before typecheck and tests. (`package.json:21-48`, `.github/workflows/agency-check.yml:18-36`)

`better-sqlite3` is a development dependency for local type and test tooling. Product storage is opened through Agency's BB-backed database registration path. (`package.json:38-40`, `src/server/register.ts:139-155`)

## Compatibility boundaries

- The locked versions describe this checkout's npm dependency graph, not the copies of runtime shims supplied by BB. (`package-lock.json:1-24`, `package.json:11-20`)
- The engine fields are package-manager metadata. CI checks the plugin on Node 22.19 and builds with a separately installed `bb-app@0.43.1`; it does not test every version allowed by the ranges. (`.github/workflows/agency-check.yml:12-16`, `.github/workflows/agency-check.yml:38-47`)
- Plugin API calls depend on BB's runtime contracts, including RPC, host file operations, and thread APIs. A successful TypeScript build alone does not establish runtime compatibility. (`server.ts:1-6`, `src/server/register.ts:98-125`, `src/host/file-handlers.ts:8-53`)

## Package changes

Run `npm ci --include=dev` to install from the lockfile. Update package declarations and lockfile together; CI verifies the SDK pin and that `bb-app` is absent from the plugin dependency graph. (`.github/workflows/agency-check.yml:18-37`)

`npm run build` delegates to `bb plugin build`; it uses the BB CLI available on `PATH` unless the environment selects another CLI. (`package.json:49-54`)

See [Toolchain validation](toolchain-validation.md) for the dated validation record and [Gotchas](gotchas.md) for runtime boundaries.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agency documentation](README.md)
- [Agency deployment](deployment.md)
- [Toolchain validation](toolchain-validation.md)

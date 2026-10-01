---
title: Toolchain validation
type: deployment
created: 2026-09-14
updated: 2026-10-01
status: active
confidence: medium
tags: [toolchain, ci, validation]
sources:
  - package.json
  - package-lock.json
  - .github/workflows/agency-check.yml
  - src/server/register.ts
  - src/host/file-handlers.ts
---
# Toolchain validation

TL;DR: CI checks the plugin on Node 22.19 and builds with BB CLI 0.43.1; package engine ranges state minimum compatibility requirements but do not certify every version in those ranges.

## Declared requirements

| Field | Current value | What the evidence establishes |
| --- | --- | --- |
| `node` | `^22.19.0 || ^24.0.0 || ^26.0.0` | Manifest range; CI config selects Node 22.19. (`package.json:5-9`, `.github/workflows/agency-check.yml:12-16`) |
| `bb` | `>=0.43.1` | Manifest minimum only. (`package.json:5-9`) |
| `bbPluginSdk` | `>=0.4.87` | Manifest minimum; dev dependency pin is exactly 0.4.87. (`package.json:5-9`, `package.json:28-30`) |

The previous local validation record named Node 26.3.1 and the CI configuration then in use. It is historical evidence and does not prove that all Node versions in the manifest range were run. (`.github/workflows/agency-check.yml:1-3`, `package.json:5-9`)

## CI sequence

The workflow installs dependencies with `npm ci --include=dev`, runs `npm run typecheck` and `npm test`, checks the offline SDK pin, installs `bb-app@0.43.1` into a temporary prefix, builds the plugin, then runs production and full dependency audits. (`.github/workflows/agency-check.yml:18-59`)

The isolated `bb-app` install is outside the plugin lockfile and dependency graph. Its audit is logged as informational with `if: always()` and `|| true`; the plugin audit steps are gates. (`.github/workflows/agency-check.yml:38-59`)

## What the checks prove

- Typecheck and tests run against the dependency graph installed from the lockfile. (`.github/workflows/agency-check.yml:18-25`)
- The offline pin check requires `@get-bb/plugin-sdk` package and lock versions to equal `0.4.87`, and rejects `bb-app` in either plugin dependency graph. (`.github/workflows/agency-check.yml:26-37`)
- The build uses the isolated BB CLI package `bb-app@0.43.1`. (`.github/workflows/agency-check.yml:38-47`)
- This workflow does not reload the plugin into a live BB host or exercise native UI, host file RPC, or a real employee launch. The runtime implementation is wired through BB's plugin registration and host file handler. (`src/server/register.ts:98-125`, `src/host/file-handlers.ts:8-53`)

For package roles and declared ranges, see [Dependencies and compatibility](dependencies.md). For installation and reload steps, see [Deployment](deployment.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Agency documentation](README.md)
- [Dependencies and compatibility](dependencies.md)
- [Agency deployment](deployment.md)
- [Готовность и границы runtime](implementation-readiness.md)

---
title: Worker session context (VK)
status: implemented
updated: 2026-09-24
---

# Worker session context

Optional integration with [VK session policy](https://github.com/VKirill/bb/blob/vk/experimental/VK_FUNCTIONS.md). No core patch or SDK dependency upgrade. Feature-test the resolver; hide configuration on upstream BB.

## Settings and launch

Owner configures **employee → Skills** or **department → Skill library**. SQLite stores per-scope rules, revisions and idempotency receipts. RPC/CLI saves require requestId and expectedRevision (0 when absent). Department fields form defaults; explicit employee fields replace them. Missing fields inherit. Empty policy resets to inheritance. No recursive department-parent inheritance.

| Filter | Effect |
| --- | --- |
| assigned | Only selected profile/task skills or plugins, plus extra listed names |
| allow | Only listed names; empty means none except required Agency services |
| deny | Everything except listed names; empty means everything |

The preset selects assigned skills/plugins and disables native MCP/plugins. It does not disable project/user instructions. Mandatory core/helper skills and their owning plugins stay available; denying one is a preparation error. Assigned skill plugin owners are included automatically. Native MCP names are provider config names, not legacy Agency mcpIds.

Prepare resolves settings and catalog names once. Snapshot policy + setting revisions enter the snapshot digest. Denied method skills/plugins are excluded from the task pack. Policy affects catalog loading, not filesystem authorization or CLI command access. Explicit instructions in the Agency task pack remain part of the assignment.

Resolver metadata is a lookup hint only: compare job/attempt/launch against SQLite and project/host/root/provider against the snapshot; once bound, thread id must match. Before binding only `launching` is eligible. Ordinary threads and legacy snapshots return null. No SDK/network reads inside the 2-second resolver deadline.

An existing session keeps its original frozen policy. Reviewer reuse requires equal effective policies; changed policy uses the normal new-session path. Saving settings does not restart workers.

> [!IMPORTANT]
> Core uses the first non-null policy by plugin id, without merging. Agency overrides project-folders only for its identified worker threads with configured rules. Core failures are fail-open, so this is not a security boundary. bb-bridge is retained by core; provider support varies (see linked contract).

## Commands

`bb agency context get --input-json '{"scope":"agent","scopeId":"<real agent id>"}' --json`

`bb agency context save --input-json` accepts `{requestId, expectedRevision, scope, scopeId, policy}`. Read first; never guess entity IDs. Employee get also returns department defaults and core contribution inventory. `context get` reports API availability, not proof that a particular running provider session applied it.

Tests cover CAS/idempotency, inheritance/reset, frozen digest, mandatory services, denied pack entries, metadata spoofing, ordinary BB, reviewer reuse, live registered RPC handlers and draft preservation.

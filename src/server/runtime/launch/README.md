# Launch coordinator

Bounded worker over accepted ContextSnapshot + run-store ports. No register, RPC, UI, or live agent.

`LAUNCH_COORDINATOR_STATUS.executionAvailable` is **false** as a static product flag (no liveAgent / automatic respawn). Production spawn is native `threads.spawn` through this coordinator when readiness says `executionAvailable`.

Before spawn: live identity again, host/env/root, capability readiness. Any false/unavailable skips the spawn port.

CAS `prepared` → `launching` once. Confirmed `threadId` binds and moves the attempt to `running`. `Job.state` is a typed callback only after that bind.

Confirmed `threadId`+`launchId` stay on one `agency_launch_receipt` row (monotonic upsert: identity immutable, `confirmed` and bound thread cannot be replaced or downgraded). This is not an append-only event journal.

Persist failure after spawn returns the exact receipt (`persisted` may be false). `persisted: false` is not reopen-durable. `knownReceipt` is a **hint** only: an unverified hint thread is not written as receipt identity. Manual recovery binds `running` / Job callback only after `threadVerify.verifyConfirmedThread(receipt, storedSnapshot)` confirms launchId, attempt, provider, host/env/root/project. If lookup is unsupported or unavailable — `needs_reconciliation`, not running. Never a second spawn.

Cancel during spawn is `needs_reconciliation` (orphan), not success `canceled` with a live invisible thread. Thread cancel only through `spawn.cancelThread` when the port supports it.

Job callback fail/throw: attempt stays `running`; receipt `jobBindState=needs_repair`; repair is idempotent and does not spawn.

Internal store requestIds are UUID v5 from the parent request (`launchOpRequestId`). The request schema is not weakened.

**Durability limit:** a full SQLite outage cannot persist the receipt. The typed result still returns the exact receipt with `persisted: false`. Recovery is explicit with that receipt.

## Repeat auto-review: reuse the reviewer's thread

Optional `LaunchPorts.threadReuse` is wired only for auto-review jobs (`resolveReviewLine`). Executors and assistants get `null` and still go through `spawn`.

After the launching receipt and the pre-spawn live check:

1. `resolve` looks up `agency_reviewer_thread` for this reviewer + work line.
2. A live thread → `deliver`: `threads.get` (archived or missing → dead), then `threads.send` with `composeReviewFollowUp`. Confirmed send binds that thread via `settleSpawn` — `spawn` is not called. Receipt `spawnKind` stays `confirmed`; `jobRunning.onConfirmedBind` gets the same `threadId`.
3. Dead/archived thread or `send` rejected/unknown → `markDead`, then a normal `spawn` in the same attempt. After a confirmed new thread, `remember` writes the new id (and new `origin_*`).
4. First review of a line, or another reviewer, or another line → `resolve` is null → `spawn`, then `remember`.

`pluginMetadata` on a reused thread still belongs to the first spawn. `ConfirmedThreadClaim.expectedMetadata` carries `origin_*`; `createIsolatedThreadVerifyPort` compares those ids when set. Reconcile does not replace a bound thread (`bind_id_immutable`).

`listBoundLaunchWatches` keeps one live attempt per `thread_id` (latest `attempt_no` among `ACTIVE_RUN_ATTEMPT_STATES`). Cancel of an attempt whose thread is in the registry marks the row `dead`.

Wiring after a live isolated core probe: [INTEGRATION.md](INTEGRATION.md).

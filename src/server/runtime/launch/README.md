# Launch coordinator

Bounded worker over accepted ContextSnapshot + run-store ports. No register, RPC, UI, or live agent.

`LAUNCH_COORDINATOR_STATUS.executionAvailable` is **false**. Deployed SDK/core has no isolated spawn fields; `unsupportedSdkSpawnPort` must not call `threads.spawn`.

Before spawn: live identity again, host/env/root, capability readiness. Any false/unavailable skips the spawn port.

CAS `prepared` → `launching` once. Confirmed `threadId` binds and moves the attempt to `running`. `Job.state` is a typed callback only after that bind.

Confirmed `threadId`+`launchId` stay on one `agency_launch_receipt` row (monotonic upsert: identity immutable, `confirmed` and bound thread cannot be replaced or downgraded). This is not an append-only event journal.

Persist failure after spawn returns the exact receipt (`persisted` may be false). `persisted: false` is not reopen-durable. `knownReceipt` is a **hint** only: an unverified hint thread is not written as receipt identity. Manual recovery binds `running` / Job callback only after `threadVerify.verifyConfirmedThread(receipt, storedSnapshot)` confirms launchId, attempt, provider, host/env/root/project. If lookup is unsupported or unavailable — `needs_reconciliation`, not running. Deployed SDK **cannot** prove launchId; `unsupportedSdkThreadVerifyPort` stays unavailable. Never a second spawn.

Cancel during spawn is `needs_reconciliation` (orphan), not success `canceled` with a live invisible thread. Thread cancel only through `spawn.cancelThread` when the port supports it.

Job callback fail/throw: attempt stays `running`; receipt `jobBindState=needs_repair`; repair is idempotent and does not spawn.

Internal store requestIds are UUID v5 from the parent request (`launchOpRequestId`). The request schema is not weakened.

**Durability limit:** a full SQLite outage cannot persist the receipt. The typed result still returns the exact receipt with `persisted: false`. Recovery is explicit with that receipt.

Wiring after a live isolated core probe: [INTEGRATION.md](INTEGRATION.md).

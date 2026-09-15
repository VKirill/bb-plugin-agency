# Run store

Persistent ContextSnapshot + RunAttempt. No spawn, no RPC, no Job.state=`running`.

| Docs name | Stored state |
| --- | --- |
| preparing | `prepared` |
| starting | `launching` |
| reconciling | `unknown` |

`unknown` is not `failed`. Neither retries spawn automatically.

Caller must attest access and revisions before `reservePreparedRun`. Schema-2 digest is not authorization. Reserve compares host/root/env/project/policy, job assignee/department/content, current agentVersion/processVersion and live policy hashes. Upstream IDs need caller scope plus a live record — no implicit parent rights.

`threadId`/`launchId` become immutable after bind; explicit `null` does not clear them. Request identity keeps omitted vs null distinct.

Reads are **internal-only** (`createInternalRunStoreReads` + `ServiceContext`). Do not publish via register/RPC/CLI.

`agency_launch_receipt` is a **monotonic upsert** of one row per `launch_id` / `attempt_id`, not an append-only event journal. Identity stays immutable; `confirmed` and a bound thread cannot be replaced or downgraded. A full DB outage cannot guarantee this write — the typed receipt with `persisted: false` is not reopen-durable; recover explicitly with that receipt.

Launch adapter: [`launch-adapter-contract.ts`](launch-adapter-contract.ts). `executionAvailable` stays false.

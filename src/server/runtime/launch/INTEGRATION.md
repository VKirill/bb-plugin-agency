# Wiring live spawn

Production (BB 0.43, public `threads.spawn`): hidden plugin thread. Coordinator **does** call spawn when the assigned CLI, host and policies are ready.

1. `POST /api/v1/threads` / SDK `threads.spawn` with public fields only: `origin`, `originPluginId`, `visibility: hidden`, `pluginMetadata`, environment, provider, model, prompt. Unknown keys fail `.strict()` on 0.43.
2. `executionAvailable` is native spawn (`NATIVE_SPAWN_READINESS`); there is no core capability probe.
3. Real spawn-port: host/path/model **only** from `launchContractFromSnapshot`. Catalog skill ids stay in the snapshot and prompt, not as `skillIds` on the wire.
4. Native MCP registry is still not covered — `mcpIds` from snapshot are not substituted into a non-existent SDK filter.
5. `reconcileByLaunchId` lists hidden agency threads and matches `pluginMetadata.agencyLaunchId`. Do not invent `threads.spawn` idempotency.
6. Job.running — separate domain callback after bind `threadId`, not inside SDK.
7. **Durability:** a full SQLite outage cannot persist the receipt. Coordinator still returns the exact `{ launchId, threadId, spawnKind }` with `persisted: false`. That is not a row after reopen. Hint can upsert `agency_launch_receipt`, but manual recovery does not bind without `verifyConfirmedThread`.
8. `knownReceipt` is not authority. Lookup must compare launchId/attempt and host/env/root/project/provider with the **stored snapshot**. A made-up or foreign thread is reject. Do not invent SDK idempotency.

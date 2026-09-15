# Диспетчер

engine.ts: typed inbox → версия правила → match → outbox/claim/approve/complete.
Claim — SQL CAS + IMMEDIATE; fence = token+generation. `live=false` не enqueue.
`dispatch_claimed` ставится до `await enqueueLaunch`. Expiry ≠ мёртвый писатель:
без receipt (`job_id`) и без известного fail повторный enqueue запрещён, unknown →
`send_needs_reconciliation`, тот же `launch_id`. Unavailable readiness не жжёт
maxRetries. Approve — expectedRevision CAS.
Prepare/spawn не из этого модуля. Live adapter unsupported.
Каталог: `listEventDefinitions` / `listEventSources` / `listRuleVersions` (latest + label).
`listActionIntents` join topic/definitionLabel/ruleId/ruleLabel/source. `agency_inbox` не replay. `RESOURCE_LEASE_MIGRATION`
не append. Resource claim только вместе с attempt claim и heartbeat/stop-proof.
Expiry не takeover. thread.idle не закрывает Job. Webhook auth — AGY-12, не здесь.
Ingest identity: `(sourceId,eventId)` + topic/reference/depth + `bodyDigest(body)`.
Другой topic/reference/depth при том же body — `request_conflict`, не duplicate.
`body_digest` на существующих строках не переписывается.
`payloadSchema` — поддерживаемый subset, compile на save и match на ingest.
HMAC/source resolve — auth; `projectId` у source не является правом доступа.
`readField` — reviewer, не этот файл.

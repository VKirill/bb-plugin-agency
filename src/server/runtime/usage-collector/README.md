# Usage collector

Durable typed `thread/tokenUsage/updated` rows for bound Agency threads. Dashboard continuation, not a runtime and not Tasks.

Parser is ips `parseTokenUsageEvent` (not forked). Fold/epochs stay in `dashboard-usage/`.

Владелец миграций добавляет `USAGE_COLLECTOR_MIGRATION`. Модуль сам схему не применяет. Sidecar dataDir нет. Register glue: union port, poll, `shouldContinue` на dispose, `usage-changed` только после `inserted > 0`.

## Identity

- PK `(thread_id, event_id)`.
- Unique `(thread_id, seq)`: другой `event_id` на том же seq → `request_conflict`, без UPDATE.
- Exact replay → `duplicate`.
- Live/read failure не DELETE/UPDATE сохранённое.

Поля: `threadId`, `eventId` (`id`), `seq`, `createdAt`, `providerThreadId`, `turnId`, `last`, `total`. `totalTokens` как факт; cache не в input.

Bound только через provided set/port. Union = durable ∪ live, unique `eventId`, durable wins.

Optional `shouldContinue`: после каждого await, перед `ingest` и между тредами. `false` — выход без записи (reload / db close).

Tests: `tests/usage-collector.test.ts`.

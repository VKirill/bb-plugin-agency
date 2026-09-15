# Адаптеры триггеров

`notify.ts` пишет legacy `agency_inbox` и не запускает tick. `ingest.ts` — typed
контур EventSource. Cron/webhook persist — `durable-inbox.ts` (явный `bbProjectId`,
не auth). Наружный HTTP и secret store не здесь. Триггеры не вызывают spawn.
Live/auto — root gate.

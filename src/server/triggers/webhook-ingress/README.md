# HTTP webhook ingress (не маршрут)

AGY-12: адаптер вокруг принятого `verifyWebhook`. Наружный `bb.http.route` / `/notify` **не** регистрируется этим модулем.

## Что делает

1. Режет поток до 64 KiB **до** полной аллокации и JSON.
2. Rate limit **до** чтения body. Известный source — свой bucket по `source.id` после resolve (cap 64 + eviction). Unknown / битый заголовок — один общий bucket. Произвольный `x-agency-source-id` не становится ключом Map. 429 + `Retry-After`. Process-local.
3. Source и secret только из `WebhookSourcePort` (заголовок id, не body). HMAC — auth. `source.projectId` не право доступа.
4. HTTP-адаптер: `schemaValidation: envelope_only`. Durable persist сверяет `draft.bodyDigest` с `webhookEnvelopeDigest(envelope)` (включая `occurredAt`); подмена digest → persist fail. Ingest body несёт subject/data/occurredAt/schemaVersion.
5. Dedup/receipt: exact signed replay → 200, тот же receipt, одна строка. Другой topic/subject/data/occurredAt при том же eventId → 409, второй row/receipt нет. `body_digest` не UPDATE.
6. Throw stream/resolve/persist → 503 `webhook_unavailable` без текста ошибки и тела. Oversized `ReadableStream` — `cancel`; async iterator — `return`.
7. Не spawn, не скачивание URL, не delivery агенту.

## Не обещаем

Регистрацию HTTP. Secret store. Durable rate limit. Bearer-режим.

Tests: `tests/webhook-ingress.test.ts`, `tests/triggers-durable-inbox.test.ts`.

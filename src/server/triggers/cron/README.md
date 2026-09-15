# Cron planner + durable occurrences

AGY-12 v1: IANA-расписание и уникальные UTC-слоты в SQLite. Нет системного `background.schedule`, register, spawn и доставки.

Владелец миграций добавляет `CRON_OCCURRENCE_MIGRATION`. Модуль сам схему не применяет.

## Политика v1 (не догадка — `cron-parser` 5.10.1, диапазон ^5.5.0)

Пять полей (`минута час дом месяц доу`), секунда всегда `0`. `H` запрещён. TZ: `Intl.supportedValuesOf('timeZone')` плюс `UTC`/`GMT`/`Etc/UTC` (на этом Node `UTC` нет в supportedValuesOf). Смещения вроде `UTC+2` не принимаются.

Europe/Madrid, измерено библиотекой:

- Весенний разрыв 2026-03-29: `0 2 * * *` → `2026-03-29T01:00:00.000Z`, локально 03:00, offset +120. Пропущенного 02:00 нет.
- Осенний откат, ежедневно `0 2 * * *`: один слот `2026-10-25T00:00:00.000Z` (первый offset +120). Второй локальный 02:00 (+60) не создаётся.
- Осенний hourly `0 * * * *`: два UTC с одним локальным часом 02:00 — `00:00Z` (+120) и `01:00Z` (+60).

Смена timezone не переписывает уже записанные UTC. Следующие слоты считаются в новой зоне после `last_scheduled_at_utc` (тот же календарный день может дать новый UTC, если выражение в новой зоне ещё due).

Пропуски считаются по **полному** диапазону `(last, now]`, не по первым 64 слотам. Больше `CRON_DUE_RANGE_CAP` (10000) due → `cron_due_range_exceeded`, `last` не двигается, emit нет.

- `skip`: один своевременный due → emit; два и больше (простой) → все skipped, emit нет.
- `last`: emit только новейший слот **перед now**.
- `catch_up`: emit первые `catchUpLimit` (потолок 24), остальные этого простоя skipped; курсор сразу на последний due, без пачек на следующих tick.

Первый tick без курсора якорит `now` и прошлое не догоняет.

## Inbox

`tickCronIntoInbox` пишет typed inbox через `ingestInboxEvent`. Scope — явный `bbProjectId` (не `bnd_*`); совпадение с `EventSource.project_id` не заменяет auth. `eventId = cron:{ruleVersionId}:{scheduledAtUtc}`. Повтор — `duplicate`. Нет HTTP, spawn и таймера процесса.

## API

`previewOccurrences(rule, { fromUtc, count, offset })` — без записи. `createCronOccurrenceStore(db, inbox).tick(rules, nowUtc)` — один вызов вызывающего, не таймер процесса.

Tests: `tests/cron-occurrences.test.ts`.

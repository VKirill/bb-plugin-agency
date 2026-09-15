# Готовность и границы runtime

14 сентября 2026 · source **0.1.0-alpha.12** · Mac mini. Введение установки —
корневой README (его не дублировать здесь как релизные ноты).

## Что можно обещать из source

| Область | Сейчас | Граница |
| --- | --- | --- |
| CRUD | Agent/Department/Binding/Job/Artifact/Activity в SQLite; RPC+CLI; UI на RPC | Не raw SQL. `status.execution` не запуск |
| Файлы | Publish/open/accept по hash; preview на host binding | Published ≠ accepted |
| Контекст | `compileContextSnapshot` schema 2; precedence department/job | Сервер не сравнивает acceptance regex |
| Launch | `prepareLaunch` / receipt / reconcile; spawn только после GET spawn-contract | Proven isolation: **claude-code**. Host SDK 0.4.87 без GET 404 → spawn unavailable, CRUD жив |
| Watch | `idle` + hash текущей версии → Job `review`, attempt `awaiting_review` | `idle` без такого артефакта оставляет `running`. Не accept. `runSucceeded` всегда false |
| Вопрос | Typed `reportNeedsInput` → `waiting_input`; `answerNeedsInput` + `waitId` + amendment + official send → тот же running; новый вопрос — новый wait | Recover unknown → `needs_reconciliation` без send. `queued` ≠ turn active. Класса done без артефакта нет |
| Telegram | Opt-in notify / question_link | Не enqueue из правил, не второй getUpdates |
| Cron / event registry | Typed inbox/rule/outbox/claim; UI-формы preview | Live/auto и spawn выключены. Alpha notify не replay. Webhook/cron нет |

Production install/reload этим документом не утверждается. Isolated цикл
(AG-1604…1607) проверял Claude-only path; это не изоляция всех CLI.

## Приёмка перед автономией (ещё открыто)

- Изоляция Codex/OpenCode и обходы shell/BB CLI.
- BB `threads.interactions` для формы вопроса (сейчас Agency-owned record).
- Возврат `waiting_input → running` после подтверждённого ответа.
- EventDefinition / cron / webhook / резерв CLI.
- Согласованный backup+restore пилотной базы.

## Историческое ревью волны AGY (утро 14 сентября)

Ниже — исходный снимок до launch/watch. Не использовать как текущий статус CRUD
или «runtime отсутствует». Трекинг — BB Tasks, проект AGY.

Лидер тогда: typecheck и тесты волны 1; live upload/open на host. Автономия
не включалась. Таблица «постоянный CRUD отсутствует / isolation stub» **устарела**.

- AGY-2…AGY-8: toolchain, domain, storage, artifacts, RPC, UI на данных.
- AGY-16/0431: isolated spawn-contract, catalog pin, watch, `reportNeedsInput`.
- AGY-17: installation-owner RPC, не caller context SDK 0.4.87.

Подробности toolchain: [проверки](toolchain-validation.md).

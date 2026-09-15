# Рабочий план и закрытые этапы

Обновлён 2026-09-14. Этапы 0–1 и ручной Claude-цикл (часть 2–3) закрыты в source.
Этапы 4–6 и полная изоляция всех CLI остаются. [Границы](implementation-readiness.md).

## Закрыто в source

**0. Фундамент.** Typecheck, Vitest, CI, host.ts в проверке, Node/SDK pin.

**1. Постоянные данные и UI.** CRUD, revision/CAS, список/карточка на RPC,
артефакты на host binding, preview, published ≠ accepted. Деморежим отделён.

**2. Изоляция (частично).** Proven только `claude-code` + GET spawn-contract.
Обычный host 0.4.87 без контракта: spawn unavailable. Codex/OpenCode и обходы
shell — не закрыты.

**3. Ручной цикл (частично).** prepare → spawn (isolated) → bind → watch
(`idle`+hash → review / `awaiting_review`) или `reportNeedsInput` → `waiting_input`
→ `answerNeedsInput` (тот же thread, official send).
Accept — отдельная команда. `runSucceeded` всегда false.

Живой тест AG-1611 подтвердил два вопроса и ответа на одной попытке без
перезагрузки карточки, публикацию, автоматический review и приёмку версии.
После Job `done` и проверки принятой версии attempt становится `succeeded`.

Не закрыто в 3: BB `threads.interactions`, секретный handler,
stop/handoff как полный продукт, резерв CLI.

## 4. Отделы и событийная работа

Registry EventDefinition, envelope, rule versions, matches/outbox, dispatcher.
Цепочка исполнитель → проверяющий. Повтор события не создаёт второй Run.

## 5. Расписания, webhook и Telegram-очередь

[Автоматизации](automation-architecture.md). Cron/webhook не обходят launch gate.
Telegram сейчас opt-in notify, не enqueue из правил.

## 6. Переносимость и пилот

Первый запуск без личных путей; backup/restore; резервный CLI только после своей
изоляции. Production rollout — отдельный проход coreworker, не этот документ.

## После первой версии

Визуальный DAG, двусторонний Telegram, массовые операции, многопользовательская
модель — отдельно по результатам пилота.

Приёмка UI: контрол либо пишет заявленные поля, либо заранее недоступен.
`PROJECT.md` не заменяет Job в БД. Назначенный skill ≠ изоляция.

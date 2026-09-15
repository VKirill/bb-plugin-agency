# Рабочая документация Агентства

Сверено 2026-09-14 с исходниками **0.1.0-alpha.12**. Введение и границы установки —
в корневом README плагина (его ведёт отдельный релизный проход). Здесь — контракты
и статус runtime: что уже в коде, что остаётся за релизом.

Это не описание полной автономии. Production rollout (core/SDK pin, reload)
готовится отдельно и этим набором файлов не включается.

## Порядок чтения

1. [Готовность и границы runtime](implementation-readiness.md) — что работает,
   что доказано только на isolated Claude, что ещё нельзя обещать.
2. [Этапы](roadmap.md) — что закрыто, что осталось.
3. [Архитектура](architecture.md) — модули source.
4. [Данные и состояния](data-model.md) — ID, Job/attempt, `waiting_input`.
5. [CLI](cli.md) — allowlist, `--input-json`, launch и `reportNeedsInput`.
6. [API BB](bb-api.md) и [версии пакетов](dependencies.md).
7. [Карта экранов](ui-plan.md) и [дизайн](../DESIGN.md).

## Контракты runtime

- [Уровни инструкций](instruction-context.md): слои не отменяют друг друга;
  конфликт — typed `reportNeedsInput`, не regex.
- [Снимок запуска](session-context-contract.md) и [revise compiler](context-snapshot-revise.md):
  schema 2 реализован в `compile.ts`.
- [Документы, вопросы, машины, Telegram](interaction-and-runtime.md): durable
  `getJob.needsInput` ≠ демо AG-105 ≠ BB `threads.interactions`.
- [Навык и каталог](skills-integration.md).
- [Автоматизации](automation-architecture.md), [события](events.md) — план
  registry/cron; notify сейчас только inbox.

Исследовательские заметки ([product-review](product-review.md),
[ui-references](ui-references.md), [video-scenarios](video-scenarios.md))
не заменяют статус выше.

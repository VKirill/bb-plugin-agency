# Рабочая документация Агентства

Сверено 2026-09-20 с исходниками **0.1.0-alpha.16**, навык **0.28.5**. Введение и
границы установки — в корневом README плагина (его ведёт отдельный релизный проход).
Здесь — контракты runtime и карта студии: что уже в коде, что читает диспетчер.

Это не описание полной автономии. Production rollout (core/SDK pin, reload)
готовится отдельно и этим набором файлов не включается.

## Порядок чтения

0. [Анализ и план развития](operating-model.md) — снимок 2026-09-16; текущая карта
   отделов ниже, не в той таблице раздела 1.
1. [Работа отделов](../skills/agency/references/departments.md) — что каждый стол
   берёт, роли, пул, касание владельца.
2. [Карта поступления](../skills/agency/references/routing.md) — фраза владельца →
   отдел. Смешанный продукт — [цепочки](../skills/agency/references/chains.md).
3. [Навык диспетчера](../skills/agency/SKILL.md) и [стол ремесла](../skills/agency/references/craft-pack.md).
4. [Готовность и границы runtime](implementation-readiness.md) — что работает,
   что доказано только на isolated Claude, что ещё нельзя обещать.
5. [Этапы](roadmap.md) — что закрыто, что осталось.
6. [Архитектура](architecture.md) — модули source.
7. [Данные и состояния](data-model.md) — ID, Job/attempt, `waiting_input`.
8. [CLI](cli.md) — allowlist, `--input-json`, launch и `reportNeedsInput`.
9. [API BB](bb-api.md) и [версии пакетов](dependencies.md).
10. [Карта экранов](ui-plan.md) и [дизайн](../DESIGN.md).

## Контракты runtime

- [Уровни инструкций](instruction-context.md): слои не отменяют друг друга;
  конфликт — typed `reportNeedsInput`, не regex.
- [Снимок запуска](session-context-contract.md) и [revise compiler](context-snapshot-revise.md):
  schema 2 реализован в `compile.ts`.
- [Документы, вопросы, машины, Telegram](interaction-and-runtime.md): durable
  `getJob.needsInput` ≠ демо AG-105 ≠ BB `threads.interactions`.
- [Навык и каталог](skills-integration.md).
- [Автоматизации](automation-architecture.md), [события](events.md) — registry/cron
  и webhook через launch gate; notify сейчас inbox / очередь Telegram Projects.

Исследовательские заметки ([product-review](product-review.md),
[ui-references](ui-references.md), [video-scenarios](video-scenarios.md))
не заменяют статус выше.

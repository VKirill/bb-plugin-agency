---
title: Задача как рабочее пространство команды
type: component
created: 2026-09-13
updated: 2026-10-01
status: stale
confidence: medium
tags: [jobs, interaction, ui]
sources:
  - docs/roadmap.md
  - docs/product-review.md
  - docs/ui-plan.md
  - src/app/prototype/jobs.tsx
  - src/app/prototype/job-detail.tsx
  - src/app/prototype/job-needs-input.tsx
  - src/app/prototype/job-work-timeline.tsx
  - src/app/data/job-board.ts
  - src/app/data/job-lifecycle.ts
  - src/app/data/job-edit-draft.ts
  - src/app/data/job-placement.ts
  - src/domain/job-state.ts
  - src/server/runtime/isolated-sdk/job-running.ts
---
# Задача как рабочее пространство команды

Актуальный общий порядок — [рабочий план](roadmap.md);
границы — [проверка готовности](implementation-readiness.md). Статус: **0.1.0-alpha.16**.

## How it works

### JobsPage

1. The page receives the job collection and callbacks, initializes list/kanban view and filter state, and builds project options from placement data or the jobs when no catalog is supplied. (`src/app/prototype/jobs.tsx:80-90`)
2. It scopes jobs by task scope, project, and department. A project view then adds descendant subtasks even when they run in another project folder; `partitionBoard` separates closed jobs hidden by board policy from visible jobs. (`src/app/prototype/jobs.tsx:91-99`, `src/app/data/job-board.ts:51-75`)
3. It applies project, priority, status, and text filters, sorts by due date or family order, and derives subtask counts. List rows are grouped by state; the working kanban has queued, running, attention, review, and done columns, while backlog/canceled use the archive view. Selecting a card calls `open(id)`. (`src/app/prototype/jobs.tsx:96-99`, `src/app/prototype/jobs.tsx:43-53`, `src/app/prototype/jobs.tsx:131-134`)
4. Creation requires a nonblank title; placement is also required when `requirePlacement` is set. With a persistence callback, brief, acceptance, and an assignee are required when placement data has agents. Changing binding sanitizes the department against that binding's links. The generated job starts in `backlog`; demo mode adds it locally and opens it, while persisted mode keeps the form draft if `persist` returns `false` and clears it on success. If the promise rejects, the handler exits before clearing `creating`. (`src/app/prototype/jobs.tsx:101-129`)
5. A kanban drop is ignored for a missing job or its current state. `jobKanbanMoveRefusal` can reject the move and show a notice; otherwise the page invokes `persist` or updates local state. The callback result is not checked in this move handler, and a rejected persistence promise has no local catch. (`src/app/prototype/jobs.tsx:100`, `src/app/data/job-lifecycle.ts:111-121`)

### JOB_TRANSITIONS

1. `canTransitionJob` checks the requested edge against the per-state transition map. A missing edge returns `illegal_transition`. (`src/domain/job-state.ts:4-6`, `src/domain/job-state.ts:35-37`, `src/domain/job-state.ts:46-52`)
2. For `queued` or `running`, `assertJobTransition` requires a nonblank assignee, binding, brief, and acceptance; entering `running` also requires a confirmed bound thread. (`src/domain/job-state.ts:39-59`)
3. Returning from `waiting_input` requires confirmed continuation and no open questions or blockers. Returning from `review` to `running` requires a nonblank rework comment. Entering `review` requires a published current version; entering `done` requires acceptance of that version and a satisfied review policy. Failed guards return `missing_transition_guard`; otherwise the function returns the target state. (`src/domain/job-state.ts:61-80`)

The complete allowed-edge table is in [Data model](data-model.md#job-state-lifecycle). The launch callback marks the thread bound before transitioning a queued job to `running`; a `backlog` job is first moved to `queued`. (`src/server/runtime/isolated-sdk/job-running.ts:8-40`)

### JobDetail

1. The detail component combines the selected job with its job tree, runs, project/department/assignee choices, environment status, activity, file drafts, and launch status. These values begin as local UI state or are derived from the supplied job, jobs, agents, departments, projects, and runs. (`src/app/prototype/job-detail.tsx:63-90`, `src/app/prototype/job-detail.tsx:103-116`)
2. Opening edit rebuilds the draft from the selected job. Saving stops while pending or when the title is blank; `jobEditCommit` emits only changed fields and a single activity summary. A no-op closes the editor; a successful update closes it; `false` leaves the editor and draft open. Demo mode stores the assignee name, while live mode maps the choice to agent fields. (`src/app/prototype/job-detail.tsx:91-102`, `src/app/data/job-edit-draft.ts:26-91`)
3. Opening placement copies the current binding and a valid department into draft state. Changing the binding filters the department choice. Confirmation requires both a resolvable project/department and an allowed binding-department link; otherwise it returns without changing the job. A valid confirmation records a change event and closes the placement editor. (`src/app/prototype/job-detail.tsx:103-123`, `src/app/data/job-placement.ts:36-53`, `src/app/data/job-placement.ts:81-103`)

For edit, a `false` update leaves the draft open; a rejected update propagates and leaves `editPending` set because there is no `catch` or `finally`. Placement calls `change` without awaiting its update result, then closes the placement editor; a rejected update is not handled by this method. (`src/app/prototype/job-detail.tsx:91-101`, `src/app/prototype/job-detail.tsx:117-123`)

### Needs input and thread

When the job waits for an answer, `JobNeedsInputPanel` binds a request ID to the current `waitId`, validates answers, then sends or reconciles the request. A bound work thread appears through BB `ThreadChat`; without a thread ID, the timeline is absent. (`src/app/prototype/job-needs-input.tsx:32-49`, `src/app/prototype/job-needs-input.tsx:61-98`, `src/app/prototype/job-work-timeline.tsx:7-28`)

| Mode or state | What changes | Failure behavior |
| --- | --- | --- |
| List / kanban / archive | List groups rows by state; kanban groups work states and keeps backlog/canceled in a separate view; the archive panel overrides either board when open. | Kanban refusal shows a notice. A failed persistence result from drag/drop is not handled locally (`src/app/prototype/jobs.tsx:100`, `src/app/prototype/jobs.tsx:131-134`). |
| Demo / persisted edit | Demo mode stores an assignee name; live mode stores agent fields. Both use the draft/commit pipeline. | A `false` update leaves the edit open; a no-op closes without a write (`src/app/prototype/job-detail.tsx:91-102`, `src/app/data/job-edit-draft.ts:79-91`). |
| Job state transition | The allowed-edge map is followed by queue, thread, continuation, rework, publication, and acceptance guards. | Invalid edges return `illegal_transition`; failed preconditions return `missing_transition_guard` (`src/domain/job-state.ts:35-80`). See [Data model lifecycle](data-model.md#job-state-lifecycle). |
| Needs-input answer | The panel binds a send/reconcile action to the current `waitId` and validates the answers before calling the API. | Invalid answers or stale/refused waits stop before sending and show a notice (`src/app/prototype/job-needs-input.tsx:32-49`, `src/app/prototype/job-needs-input.tsx:61-100`). |
| Needs-input `send`, `reconcile`, `wait`, `refuse` | The panel selects an action from persisted send state and current wait identity. | Invalid answers stop before RPC; stale or refused waits show a notice and do not send (`src/app/prototype/job-needs-input.tsx:61-80`, `src/app/prototype/job-needs-input.tsx:89-100`). |

## Что берём из существующих систем

BB Tasks: компактные свойства у заголовка, вложения, подзадачи, связанные
рабочие чаты и хронология. Сверено со скриншотами владельца и установленным
bundle Tasks 0.1.2. В Агентстве интерфейс должен показывать результат понятнее,
чем технические инструкции длинным абзацем.

Linear: ответы в ветках, закрытие обсуждения, ссылки на комментарии и
превращение комментария в задачу; отдельный Inbox с подписками.
Источники: https://linear.app/docs/comment-on-issues и https://linear.app/docs/inbox .
Это подтверждённые примеры практик, не измерение их распространённости.

Kanban: ограничение одновременно выполняемой работы, чтобы видеть перегрузку.
Источник: https://www.atlassian.com/agile/kanban/wip-limits/ .
Лимит колонки/отдела и технический лимит активных CLI — разные настройки.

## Устройство карточки

1. Короткий заголовок, родитель и прогресс подзадач; компактные свойства.
2. «Сейчас»: кто выполняет, чего ждём, последнее значимое изменение.
3. «Нужен ваш ответ» или «Результат на проверку», если есть открытое действие.
4. Бриф: цель, материалы, критерии готовности. Служебная инструкция запуска
   доступна через раскрытие, не занимает основное описание.
5. Подзадачи и зависимости: статус, исполнитель, что блокирует запуск.
6. Результаты: открываемый файл, версия, автор и вердикт проверки.
7. Общение и история в одной хронологии с фильтрами; рабочие чаты по ссылке.

Карточка открывается в боковой панели поверх очереди; полный экран — отдельное
действие. Закрытие возвращает на прежнее место, сохраняя фильтры и прокрутку.
Чат каждого Run через штатный ThreadChat BB, файлы через FileLink. Не показывать
внутренние рассуждения модели; только сообщения, действия и явные результаты.

## Семантика общения

| Тип | Пользователь видит | Поведение |
|---|---|---|
| Комментарий | Автор, время, текст, вложения, ответы | Сам по себе не запускает весь процесс |
| Поручение | Адресат, вход, ожидаемый результат | Создаёт назначение с ID и подтверждением доставки |
| Вопрос | Кто спрашивает, варианты/свободный ответ, какой шаг ждёт | Ответ возобновляет только связанную попытку |
| Передача | От кого кому, причина, артефакт/версия | Получатель принимает или объясняет отказ |
| Результат | Версия файла и критерии проверки | Можно принять либо вернуть с замечанием |
| Событие | Кто и что изменил, причина, связанный Run | Компактная строка; однотипные события сворачиваются |

Composer: явный адресат «Обсуждение / Менеджер / Сотрудник» и явное действие
«Оставить комментарий / Отправить поручение / Ответить». Упоминание не даёт
дополнительных полномочий. Вопрос имеет questionId, состояние open/answered/
expired, привязку jobId/runId; повторный ответ не запускает дубль. История
сохраняет оригинальный вопрос и выбранный ответ, исправления видны отдельно.

Каждое событие имеет eventId, timestamp, actor, jobId, runId, causationId,
correlationId и ссылку на артефакт при наличии. Политика доставки проверяется
на сервере. Произвольный текст комментария не исполняется как команда.

## История и внимание

По умолчанию показывать значимые сообщения людей/агентов, передачи и решения.
Фильтры: Всё / Обсуждение / Решения / Системные события. Длинный отчёт свернуть
с кнопкой раскрытия; сводка содержит ссылки на первичные сообщения и время
обновления. Не подменять исходную историю автоматически написанной сводкой.

Inbox объединяет вопросы, ревью и ошибки, где нужен человек; технические
события не создают уведомление каждый раз. Подписки, упоминания, mute, непрочитано.
Просмотр карточки не равен ответу на вопрос или принятию результата.

## Доска и надёжность

Список и канбан используют один query/state; сохраняемые фильтры, сортировка,
группировка по статусу/отделу/исполнителю; колонки сворачиваются. Показать
blocked отдельно от ожидания ответа и от технической очереди запуска.
Статус Run (агент занят/idle/ошибка) не равен готовности Job.
Перетаскивание — запрос перехода на сервер: показать причину запрещённого
перехода, при неудаче восстановить карточку. Дублировать drag/drop меню и
клавиатурой, сохранять фокус. Touch-цели не менее 32–40 px при плотном desktop.

Лимит WIP на отдел и возраст незавершённой задачи помогают найти узкое место.
Приёмка относится к конкретной версии результата; изменение версии отменяет
старое разрешение дальнейшей публикации. Автоматический retry ограничен,
ручной повтор показывает, какой этап будет повторён и что уже выполнено.

## Порядок внедрения и приёмка

P0: карточка + ясный бриф, одно окно результата, действующий вопрос/ответ,
передача конкретному агенту, восстановление после reload и отсутствие дублей.
P1: ветки ответов, подписки, сохранённые виды, боковая панель и зависимости.
P2: сводки обсуждений, статистика WIP/времени, расширенный поиск истории.

Приёмочные сценарии: человек без терминала ставит поручение, отвечает на вопрос,
получает файл, возвращает его с замечанием и принимает новую версию. Проверить
повторное нажатие «Отправить», два ответа из разных вкладок, перезапуск BB между
ответом и запуском, отключённого сотрудника, недоступный файл и потерю соединения.
Обычный пользователь видит смысл и дальнейшее действие; технический журнал
остаётся доступен для диагностики.

## Ревью alpha.9

[Ревью продукта и критерии следующей версии](product-review.md) уточняет
ID/membership и привязки BB, сохранение/revision, работу в общей папке,
жизненный цикл назначения/ответа/повтора/остановки и сценарии первого запуска.
Реализованные UI-исправления и оставшиеся пункты разделены в таблице всех экранов.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Ревью Агентства: Multica, план и интерфейс](product-review.md)

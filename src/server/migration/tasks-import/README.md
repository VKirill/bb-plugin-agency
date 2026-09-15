# Tasks → Agency import planner

Чистое dry-run планирование переноса builtin Tasks в Job Агентства. Нет SQLite,
RPC apply, spawn, disable Tasks, acceptArtifact и register.

## Owns

| Путь | Роль |
| --- | --- |
| `src/server/migration/tasks-import/` | planner + RPC reader + mapping resolver |
| `tests/tasks-import-plan.test.ts` | фикстуры плана |
| `tests/tasks-import-reader.test.ts` | фикстуры reader |
| `tests/tasks-import-resolver.test.ts` | фикстуры resolver |

Не owns: `register.ts`, `shared/`, миграции, package, lock, UI, skills.

## Источник форм

Не выдуманы. Сверены с локальным BB 0.43.1:

- RPC: `/Users/vechkasov/.local/share/bb-source-agy-16-0431/plugins/tasks/shared/contract.ts`
- SQL: `/Users/vechkasov/.local/share/bb-source-agy-16-0431/plugins/tasks/db/schema.ts`
- Agency Job: `src/shared/contracts/job.ts` (`backlog|queued|running|review|waiting_input|blocked|done|canceled`)

Tasks id = Crockford ULID. Agency id = opaque `kind_…`. Приведение типов запрещено.

Вход = RPC `listTasks` / `listProjects` / `listComments` / `listAttachments` / `listTaskThreads`, не сырые SQLite-строки. У вложений в БД есть `blob_path`, в RPC его нет: это порт `AttachmentLocator`, а не молчаливое удаление.

## Правила

- Повтор того же снимка даёт тот же JSON плана.
- Идентичность: `builtin:tasks:task:<ulid>`. Agency `job_*` не выпускается.
- `parentTaskId` → `proposed.parentSourceIdentity` и порядок apply (родитель раньше ребёнка). Цикл, отсутствующий родитель, чужой проект, глубина больше одного уровня Tasks — blockers.
- Текст, статус, ключ, ссылки на треды/`proj_*` сохраняются в `source` / `preserved`.
- `done` Tasks ≠ Job `done` и ≠ `acceptArtifactVersion`.
- Исполнитель, binding, department, `dueAt` из даты, `queued`/`running`/`review` не выдумываются.
- `createJobReady` всегда `false` на чистом снимке Tasks: нет acceptance.
- Resolver не подбирает binding/department/исполнителя по имени и не делает auto-accept. Ready drafts только корни `backlog` с `parentJobId: null`. Все дети — deferred; verified `sourceIdentity→jobId` даёт будущий executor из import ledger, не mapping.

## Reader

`readTasksSnapshot(ports)` — injected read-only RPC: `listTasks` (все страницы, `sort: manual`, без `activeOnly`), `listProjects({})` (все проекты, не `folderId: null`), `listLabels` по проекту, `listComments` / `listAttachments` / `listTaskThreads` по задаче, вложения комментариев через `{ commentId }`.

- Пагинация: `nextCursor` до `null`; пустая страница с курсором, overflow, повтор id/cursor — ошибка, не «данные кончились».
- Сбой порта или лишние поля (`.strict()`) — отказ со стабильным `code` и sentinel `port_threw` / `schema_invalid`. В ошибку не попадают `Error.message`, `String(error)` и текст Zod (там бывают значения полей).
- `listComments` принимает display-поля `threadTitle`/`provider` и кладёт в snapshot только core comment. Presets не читаются.
- **Optimistic double-read, не атомарный снимок.** Два полных прохода (tasks + projects/labels/comments/attachments/threads) сравниваются canonical JSON. Расхождение → `source_changed` / `optimistic_double_read_mismatch`, `retryable: true`. Это не snapshot transaction и не cutover без quiescence. В Tasks 0.43.1 `tasks.updatedAt` пишет только `UPDATE tasks`; `INSERT`/`UPDATE` comments и attachments задачу не трогают. SQL `task_list_revision` нет на list* RPC: его двигают task insert/update/delete, `task_labels`, смена **имени** label, thread rows и **только prefix** проекта. Имя/цвет/folder/`linkedBbProjectId` проекта revision не двигают. Поэтому stamp `task.id+updatedAt` не доказывает consistency relations.

Лимит страницы: 1…500, по умолчанию 500 (как Tasks `TASKS_PAGE_MAX_LIMIT`).

## Resolver

`resolveTasksImport(plan, explicitMappings)` — проверка **payload**, не proof доступа. Binding/department/assignee/acceptance только из явного mapping: никаких defaults по имени проекта, пресета или автоaccept. Записи workspace передаются во входе (`bindings` / `departments` / `agents` / `memberships` / `projectDepartments`); resolver их не читает из DB. Поля `existingParentJobId` и `workspace.jobs` в mapping нет: exists+same-binding не является source parent mapping.

- Нет mapping → blocker, Agency id не выдумываются.
- Binding: exists, `revision`, `hostId`+`canonicalRoot` (иначе `foreign_binding`), optional `claimedBbProjectId`.
- Department linked к binding; agent — membership отдела. Чужой membership → `assignee_not_member`. Устаревшая revision / отсутствующая запись → `stale_*` / `*_not_found`.
- `done` остаётся unresolved (`needs_archival_policy`), не Job `done` и не accept.
- Ready `createJob` только для **корней** `backlog` без blockers, всегда `parentJobId: null`. Любая подзадача с `parentSourceIdentity` — только `deferred` шаблон + `parent_binding_pending`, `createJobReady=false`, `createJob=null`. Чужой sibling того же binding не родитель. Будущий executor выдаёт persisted `sourceIdentity→jobId` из import ledger; caller-proof boolean и job id в mapping не принимаются.
- Все `plan.items` и `plan.conflicts`/`globalBlockers` сохраняются как есть. `parent_cycle` живёт на item (как у planner), глобальный `conflicts.parent_cycle` не выдумывается. `summary.tasks` = все задачи. `applyOrder` — subset, без silent omission (цикл остаётся в items). Заблокированный родитель добавляет ребёнку `parent_blocked` даже если ребёнок уже `parent_binding_pending`.
- Дубликаты identity/source.id, расхождение `sourceIdentity`/`sourceTaskId`/`parentTaskId`, missing applyOrder refs, duplicate workspace id — отказ `inconsistent_plan` / `duplicate_workspace_id`, не last-wins.
- Pin `requestId`/`contentPin` включает `parentSourceIdentity` и `parentJobId`. Смена parent identity меняет pin.

## Порты для root

| Порт | Статус |
| --- | --- |
| `TasksSnapshotReader` | реализован: `readTasksSnapshot` + injected RPC ports |
| `ProjectBindingResolver` | live fetch не этот модуль; `resolveTasksImport` проверяет явный mapping payload |
| `DepartmentResolver` | live fetch не этот модуль; department берётся только из explicit mapping |
| `AcceptanceAuthor` | live fetch не этот модуль; acceptance только explicit, без автоaccept |
| `JobApplyExecutor` | не этот модуль |
| `AttachmentLocator` | не этот модуль; RPC без `blob_path` |

`planTasksImport` планирует уже собранный snapshot. `readTasksSnapshot` его собирает. `resolveTasksImport` проверяет **payload** явных mapping + переданных live-записей workspace (binding exists/host/root, department linked, agent membership, revision). Это не proof доступа и не SQL apply. Freeze: reader+planner+resolver, без register/apply.

Root:

```sh
cd /Users/vechkasov/Documents/BB-сервис/plugins/bb-plugin-agency
./node_modules/.bin/vitest run tests/tasks-import-resolver.test.ts tests/tasks-import-plan.test.ts tests/tasks-import-reader.test.ts
./node_modules/.bin/tsc --noEmit
```

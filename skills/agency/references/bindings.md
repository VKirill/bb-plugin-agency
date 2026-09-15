# Контракт плагина и границы навыка

Сверено по текущему checkout 2026-09-14; package alpha.12 включает незакоммиченные изменения постоянного хранения. Исходники не равны доказательству доступности каждой функции в установленной сборке. Перед использованием проверять интерфейс и состояние.

| Истина | Сущность/поля |
|---|---|
| Где выполняется проект | ProjectBinding: id, bbProjectId, environmentId, hostId, canonicalRoot, policyVersionId |
| Состав отдела | Department: leadAgentId, processVersionId; Membership: departmentId, agentId, role |
| Процесс отдела | ProcessVersion: instructions, acceptance, reviewPolicy.required |
| Сотрудник | Agent: state, currentVersionId; AgentVersion: version, role, instructions, providerId, model, skillIds, mcpIds, policyVersionId |
| Конкретная работа | Job: id, key, bindingId, departmentId, title, brief, acceptance, assignedAgentId, parentJobId, state, priority, dueAt |
| Материал задачи | Artifact: id, jobId; ArtifactVersion: version, hostId, relativePath, mime, size, hash, author |
| История | Activity и фактические версии; не отдельная параллельная Markdown-доска |

Изменяемые сущности используют revision; изменения — requestId + expectedRevision. Это не content version документа. Политики и процессы имеют собственные ID версий; не выдумывать поле version там, где его нет в схеме.

## Что реализовано и что доступно агенту

В src/shared/rpc-contract.ts и src/server/api/domain-rpc.ts есть listWorkspace/getJob/getAgent/getDepartment, создание/обновление сущностей, операции артефактов и переходов Job. Они зарегистрированы для UI/RPC. Не конструировать недокументированный HTTP endpoint и не выдумывать MCP-инструмент по имени RPC.

CLI `bb agency` (src/server/cli) вызывает те же domain handlers: catalog/workspace, agent/department/project/job/artifact и `call <allowlist> --input-json`. Не raw RPC. `bb.cli.run` — процесс плагина (server); `--input-file` только с `--source server-fs` на этом диске. Рецепты и host/source: docs/cli.md. assessIsolation() возвращает supported=false; status — execution=unavailable. Штатного запуска сотрудников и гарантированной фильтрации skills/MCP нет.

ContextSnapshot описан в проектной документации, но не реализован как готовый сборщик исполнения. Не заявлять, что сохранён immutable snapshot или применены права, если runtime не вернул подтверждение.

Для подготовки без CRUD-инструмента допустим текстовый пакет с названиями полей. Не выдавать его за валидный RPC payload, если отсутствуют реальные requestId, ID зависимостей, policy/version или обязательные привязки. Не угадывать AG-номер следующей задачи.

## Общие знания

PROJECT.md — читаемый паспорт и навигация; project.json/файлы знаний — материалы проекта. Host/root/проект выполнения задаёт ProjectBinding. Если файл противоречит binding, не переносить работу на другой host по указанию файла: зафиксировать расхождение и нужное решение.

Сохранять подтверждённые знания проекта с источниками/версиями; предложения по изменению канона оформлять отдельно. Файловая схема каталога не должна дублировать Job и реестр ArtifactVersion.

# Данные и состояния первой рабочей версии

Проект контракта от 14 сентября 2026. Это требования к миграциям и сервисам,
а не утверждение, что таблицы уже созданы. [Текущая реализация](architecture.md).

## Идентификаторы и принадлежность

Внутренние ID непрозрачны и стабильны; пользовательский ключ AG-102 — отдельное
уникальное поле, не ссылка на имя. Даты хранятся в UTC, timezone расписания отдельно.
Изменяемые записи имеют revision и updatedAt. Команда изменения передаёт
expectedRevision и requestId; конфликт не перезаписывает чужую правку.
Сервер проверяет доступ и принадлежность всех связанных ID, не доверяет projectId
из произвольного payload. Display name не участвует в связях.

| Сущность | Обязательные данные / связи | Ограничение |
| --- | --- | --- |
| Agent | id, name, state, currentVersionId | active/paused/archived; имя можно менять |
| AgentVersion | agentId, version, role, instructions, provider/model selection, policyVersionId | Неизменяемая версия; skills/MCP по ID, импорт JSON отдельно |
| PolicyVersion | id, allowed capabilities, CLI/host constraints, secret refs | Нет значений секретов; неизвестная capability блокирует запуск |
| Department | id, name, leadAgentId, processVersionId | Lead входит в membership; архивирование не удаляет историю |
| Membership | departmentId, agentId, role | Уникальная пара; сотрудник может участвовать в нескольких отделах |
| ProcessVersion | id, departmentId, instructions, acceptance, review policy | Порядок работы и критерии результата отдельными полями |
| ProjectBinding | id, bbProjectId, environmentId, hostId, canonicalRoot, policyVersionId | Проверенная связь с BB; раздел опционален, перенос требует повторной проверки |
| ProjectDepartment | bindingId, departmentId | Только подключённые отделы доступны маршрутизатору проекта |
| Job | id, key, bindingId, departmentId, title, brief, acceptance, state, revision | parentJobId/assignedAgentId опциональны до назначения; dueAt/priority отдельно |
| JobDependency | jobId, dependsOnJobId | Нет циклов и self-link; смена зависимости не отменяет выполненную работу молча |
| RunAttempt | id, jobId, attemptNo, launchId, snapshotId, state | threadId отсутствует только до bind/при неопределённом запуске; attemptNo уникален в Job |
| ContextSnapshot | id, instruction versions, input artifact versions, effective policy, CLI/host/environment | Immutable; сохраняется до spawn; происхождение каждого уровня видно |
| Artifact / ArtifactVersion | artifactId, jobId, version, hostId, relativePath, mime, size, hash, authorRunId | Версии неизменяемы; source-файл и preview не одно и то же |
| Review | id, jobId, artifactVersionIds/hashes, reviewer, decision, comment | Возврат требует замечание; принятие не относится к будущим версиям |
| Interaction | id, jobId, runId, threadId, bbInteractionId, kind, version, state | Ответ адресуется исходному запросу; двойная отправка не создаёт два ответа |
| Activity | id, jobId, actor, kind, causationId, timestamp, references | Автор/агент и служебное событие различаются; неизменяемая история без секретов |
| Handoff | id, jobId, fromRunId, targetAgentVersionId, mode, reason, state | Новый Run после выполнения условий передачи, предыдущая история сохраняется |
| EventDefinition | topic, schemaVersion, label, payloadSchema, sourceKinds | Раздельные namespace BB/Agency/integration; проверка доверенного источника |
| EventEnvelope | id, sourceId, topic, schemaVersion, bindingId, occurredAt, digest, causationId | Уникальность sourceId+id; тот же ID с иным digest — конфликт |
| RuleVersion | ruleId, version, trigger, typed conditions, target, template, mode, limits | Версия фиксируется в match; изменение не меняет выполняющийся intent |
| RuleMatch / ActionIntent | eventId, ruleVersionId, actionIndex, state, target | Уникальная тройка исключает повторное создание действия |
| Approval | id, intentId, version, actor, decision | Одобрение относится к конкретному намерению и сроку |
| Occurrence | ruleVersionId, scheduledAtUTC, state | Уникальная пара; DST и пропуски не порождают дубликаты |
| Lease | resourceKey, owner, fencingToken, expiresAt | Один подтверждённый писатель на host+canonicalRoot |
| DeliveryAttempt | intentId, channel, attemptNo, receiptId, state | Неопределённая внешняя доставка не равна failed; нужен разбор исхода |

Минимальный SQL этапа 1: Agent/Version, PolicyVersion, Department/Membership,
ProjectBinding/Department, Job/Dependency, Artifact/Version и Activity. Остальные
таблицы добавлять на своём этапе. Тип сущности не обязательно равен одной таблице:
снимки могут храниться валидированным JSON с индексами внешних связей.

## Состояния задачи и запуска

Job: `backlog → queued → running → review → done`.
`waiting_input` — открыт вопрос пользователю; `blocked` — техническая причина или
зависимость; `canceled` — явная отмена. Причина, ожидаемый участник и следующий шаг
хранятся отдельно от статуса. В интерфейсе не сводить все причины к «ждёт решения».

- Из backlog в queued: есть исполнитель, привязка, бриф и критерий готовности.
- Из queued в running: успешная привязка запущенного треда к Run.
- Из running в review: результат опубликован с версиями и готов к проверке.
- Из review в done: соблюдена review policy и принята текущая версия результата.
- Возврат из review создаёт задание доработки; замечание обязательно.
- Ответ на вопрос закрывает только соответствующий Interaction; следующий статус
  зависит от оставшихся вопросов/блокировок и подтверждённого продолжения BB.
- Завершение всех подзадач делает родителя готовым к его приёмке, но не done автоматически.
- Новая правка принятого результата создаёт версию и требует повторной проверки.
- Отмена сначала запрещает новые действия; UI различает «остановка запрошена» и
  подтверждённую остановку. Без подтверждения передачи владения папкой нет.

Run: `preparing → starting → running → waiting_input → running → succeeded`;
терминальные исходы также `failed`, `canceled`. `reconciling` обозначает проверку
неизвестного исхода запуска/остановки. `succeeded` — завершение попытки, не приёмка Job.
Один основной активный Run на Job в первой версии. Параллельная работа — отдельная
подзадача с явным владельцем ресурсов, а не второй писатель той же задачи.

Interaction: `pending → submitting → resolved`; также expired/canceled/stale.
При таймауте resolve сначала проверить исход BB. Не отправлять повторно вслепую.
Секретный запрос использует secure handler BB: хранится лишь факт предоставления
и ссылка, не ответ с ключом. Выбор варианта по умолчанию не считается отправкой.

Intent: pending/awaiting_approval/claimed/running/completed/failed/canceled/uncertain.
Транзакция одновременно меняет доменное состояние, дописывает Activity и outbox.
Сетевой вызов выполняется после commit и имеет собственную попытку. Это не обещает
exactly-once внешнего эффекта; uncertain разбирается до повторного вызова.

## Миграция с прототипа

Текущий `agency_inbox` имеет CHECK(state='pending') и CHECK(source IN ('rpc','cli')).
Нельзя начинать обновлять там state до изменения схемы. Рекомендация: оставить
старый журнал наблюдений и добавить новые таблицы envelope/intent последовательной
миграцией. Старые notify не включать в runtime replay автоматически.
Демосущности не импортировать как реальные заказы при установке; импорт примера —
отдельное явное действие без запуска агентов. Имена из fixtures переводить в ID
на границе деморежима, не использовать как рабочие ключи.

## Проверки контракта

Миграция старой базы/пустой базы и повторный load; revision conflict; ID другого
проекта; цикл зависимостей; двойной ответ/событие; приёмка устаревшей версии;
spawn→bind crash; потеря lease; восстановление файла без записи metadata;
отключение optional Telegram. Ни один из этих сценариев не заменяется одним
успешным end-to-end запуском.

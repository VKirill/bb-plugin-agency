# CLI Агентства

`bb agency` вызывает те же domain handlers и Zod-схемы, что и RPC. Отдельной бизнес-логики и прямого SQLite нет. Произвольный RPC закрыт allowlist. Spawn — только `launch prepare` после readiness; `status.execution` и notify не запуск.

## Где исполняется команда

`bb.cli.run` работает в процессе плагина на **server-host** установки BB, не на host чата и не на машине, с которой набран текст.

| Источник payload | Флаг | Что читается |
|---|---|---|
| inline | `--input-json '<object>'` | Аргумент команды. Предпочтительный рецепт. `source=inline`. |
| диск процесса плагина | `--input-file` / `--bytes-file` **и** `--source server-fs` | Локальный путь **этого** server-процесса. Без `--source server-fs` команда отказывается, чтобы не принять клиентский путь за серверный. |

`canonicalRoot` / `hostId` в payload привязки — поля контракта `createProjectBinding`. Сервер сверяет их с каталогом BB. Они **не** дают CLI право читать произвольный файл на другой машине. Publish пишет байты из JSON (`bytesBase64`) через уже проверенный binding задачи.

Штатная доставка файла с client host в CLI этого milestone нет: передайте содержимое в `--input-json` или положите файл на диск server-процесса явно.

## Allowlist

Справка: `bb agency help`, полный пример: `bb agency schema <operation>`.

`listWorkspace`, `listBbCatalog`, `listCapabilityCatalog`, `getJob`, `getAgent`, `getDepartment`, `listArtifactVersions`, `createPolicyVersion`, `provisionAgent`, `saveAgentProfile`, `provisionDepartment`, `saveDepartmentProfile`, `addMembership`, `removeMembership`, `createProjectBinding`, `linkDepartment`, `createJob`, `updateJob`, `transitionJob`, `reportNeedsInput`, `answerNeedsInput`, `createArtifact`, `publishArtifactVersion`, `attachJobInput`, `acceptArtifactVersion`, `openArtifact`, `prepareLaunch`, `getLaunch`, `reconcileLaunch`, `interpretWorkerCompletion`, `listJobAttempts`, `getIsolationReadiness`, `createJobComment`.

`getIsolationReadiness` принимает optional `jobId`. Live provider только из `assignedProvider` (`source=live_assigned_agent_version` = current AgentVersion назначенного сотрудника). Без `provenIsolationProviders` ответ невалиден. `prepareLaunch` сам отклоняет provider вне proven (`claude-code`), независимо от UI. Engines / ordinary 0.4.87 не готовность: GET 404 → spawn unavailable, CRUD жив.

Не входят: `setCliPolicy`, Telegram, машины, `createAgentVersion`/`updateAgent` в обход save, создание BB project. `getLaunch` / `listJobAttempts` идут через binding scope; сырые internal reads не публикуются.

`createJobComment` (`bb agency job comment`) — CLI-маршрут в существующую историю задачи, не новый feed и не RPC. `kind` всегда `comment`; `actor` из JSON отклоняется. Production `register.ts` wired: `run(argv, ctx)` → `readCliThreadId(ctx)` + `bindJobCommentHandler({ store, reads: runReads, resolveAccess })`. Не RPC и не `handlers[operation]`. Glue: `src/server/comments/register-glue.ts`.

## Политика

`PolicyVersion` — полный неизменяемый payload: `allowedCapabilities`, `cliHostConstraints`, `secretRefs` (имена ссылок, не значения). Label в `listBbCatalog` не есть права. Не выводите ordinary/`read.files` из подписи. Чтобы переиспользовать политику, сравните полное содержимое в `listWorkspace.policies` и возьмите существующий `id`. Новую запись не создавайте из‑за совпадения имени.

## Рецепты

Мутации требуют `requestId` (UUID). `save` / `update` / `assign` / `accept` / `transition` — ещё `expectedRevision` из последней записи. После ошибки перечитайте сущность.

```sh
bb agency status --json
bb agency catalog
bb agency schema createPolicyVersion
bb agency policy create --input-json '{"requestId":"<uuid>","allowedCapabilities":["read.files"],"cliHostConstraints":{"providerIds":["codex"],"hostIds":["host_mini"]},"secretRefs":[]}'
bb agency agent create --input-json '{...provisionAgent}'
bb agency department create --input-json '{...provisionDepartment}'
bb agency project bind --input-json '{...createProjectBinding}'   # существующий каталог
bb agency project link-department --input-json '{...}'
bb agency workspace --binding-id <bindingId>
bb agency job create --input-json '{...}'
bb agency job assign --input-json '{...updateJob, assignedAgentId}'
bb agency job get --job-id <id>
bb agency job attach-input --input-json '{...attachJobInput}'
bb agency job report-needs-input --input-json '{...reportNeedsInput}'
bb agency job answer-needs-input --input-json '{...answerNeedsInput}'
bb agency job attempts --input-json '{"jobId":"<id>"}'
bb agency job comment --input-json '{"requestId":"<uuid>","jobId":"<id>","comment":"..."}'
bb agency launch readiness --json
bb agency launch prepare --input-json '{requestId,jobId,expectedRevision}'
bb agency launch get --input-json '{launchId|attemptId}'
bb agency launch reconcile --input-json '{requestId,attemptId,launchId}'
bb agency artifact create --input-json '{"requestId":"<uuid>","jobId":"<id>"}'
bb agency artifact publish --input-json '{... bytesBase64, hash, size, mime, relativePath}'
bb agency artifact open --input-json '{"artifactId":"...","jobId":"...","version":1}'
bb agency artifact accept --input-json '{... expectedRevision задачи}'
bb agency call saveAgentProfile --input-json '{...}'
```

`skillIds` — только ID из `bb agency catalog` / `listCapabilityCatalog`, формат `skill_` + 64 hex (например agency `skill_6153a163fb7fac8c435f3befc88db8417cd0722ba8fdf5ecc37b2b5069ffc3ff`). Имя навыка и вымышленные `skl_*` не принимаются. Пока `mcpDiscovery=unavailable`, `mcpIds` — `[]`.

Перед `prepareLaunch` привяжите published input отдельной командой `job attach-input` (`attachJobInput`). Caller не передаёт `hostId` / `canonicalRoot`. `prepareLaunch` читает только сохранённые pin. Published ≠ accepted.

`job report-needs-input` — typed wait: проверенные job/attempt/thread/launch и `questions` с source refs. Не `transitionJob`. Не accept. UI читает тот же набор из `getJob.needsInput`.

`launch get` читает квитанцию, не invent attempt. `job attempts` / `launch attempts` — scoped `listJobAttempts`. `launch reconcile` сверяет thread, не делает второй spawn. `launch prepare` — текущий instance, не ярлык «clone 0431». Готовность spawn — только `launch readiness` / `getIsolationReadiness` этого процесса (GET spawn-contract + proven provider). Help не пишет «исполнение недоступно». `engines.bb` и обычный host 0.4.87 не готовность. GET 404 → spawn unavailable, CRUD остаётся. Изоляция проверена только для `claude-code`.

`bb agency project create` намеренно не поддержан.

Ответ domain: `{ ok: true, value }` или ошибка с кодом. `bytesBase64`, `logBytes` и значения секретов в stdout заменяются на `{ omitted: true }`. `secretRefs` (имена) остаются. Повторяющийся `requestId` и `revision_conflict` обрабатывает сервер: не затирайте чужую ревизию.

`status` / `notify` — прежние команды журнала, не CRUD и не запуск агента.

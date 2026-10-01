---
title: Файлы, вопросы, передача работы и подключения
type: flow
created: 2026-09-14
updated: 2026-10-01
status: stale
confidence: medium
tags: [files, needs-input, runtime]
sources:
  - docs/roadmap.md
  - docs/implementation-readiness.md
  - docs/session-context-contract.md
  - src/server/runtime/needs-input/report.ts
  - src/server/runtime/needs-input/answer.ts
  - src/host/file-handlers.ts
  - src/host/file-contract.ts
  - src/host/guarded-fs.ts
  - src/host/safe-path.ts
  - src/host/entry-handlers.ts
---
# Файлы, вопросы, передача работы и подключения

Актуальный общий порядок — [рабочий план](roadmap.md);
границы — [проверка готовности](implementation-readiness.md).
Ниже контракт взаимодействий. Статус продукта: **0.1.0-alpha.16**.

## Что работает сейчас

Рабочий путь вопроса проверяет задачу, попытку, квитанцию запуска, тред и ревизии до записи; ответы применяются отдельной службой продолжения, а операции с файлами на хосте используют защищённое чтение и запись (`src/server/runtime/needs-input/report.ts:131-175`, `src/server/runtime/needs-input/answer.ts:660-706`, `src/host/file-handlers.ts:8-42`).

- Вложение открывается только по клику через `experimental_openFilePreview`.
  Это закрываемая файловая вкладка BB, а не автоматически открываемая fixed tab.
  Задача остаётся слева, свойства скрываются на время чтения и возвращаются после
  закрытия последней вкладки крестиком. Размеры, табы и кнопка скрытия принадлежат BB.
  `.md`/`.markdown` не открываются редактором Агентства: file opener их не
  регистрирует, и BB отдаёт документ отдельному плагину «Markdown PRO»
  (`md-editor`) с его собственным рендерингом и редактированием. Агентство
  остаётся ответственно за txt/json/yaml/csv и изображения.
- Редактор Агентства (txt/json/yaml/csv) показывает исходник и позволяет
  сохранить правку; изменения создают следующую версию в примере, предыдущий
  текст сохраняется. Черновик переживает переходы внутри прототипа, но не
  перезагрузку. Переключение файла с несохранённым текстом требует выбора.
- AG-105 показывает вопросы по вкладкам «Вопрос 1», «Вопрос 2» и далее,
  с отметками заполнения, Назад/Далее и общей кнопкой Отправить.
  Поддержаны одиночный/множественный выбор и текст.
  Ответы проверяются по ID вопросов и вариантов. Реальному агенту не отправляются.
- Передача задачи выбирает сотрудника и штатный CLI/model picker, причину,
  версии приложенных материалов. Меняет назначение в примере, добавляет историю.
  Старый RUN-204 остаётся неизменённым. Реальные процессы не запускаются.
- Машины и CLI читаются из hosts.list/get, providers.list, hosts.providerCliStatus.
  Потеря связи означает «неизвестно», а не «не установлен». Проверка авторизации
  и квот в этот API не входит. Политика enabled/reserve/disabled сохраняется
  в KV Агентства отдельно для hostId/providerId. Она не меняет настройки BB.
  Резерв пока не используется, поскольку диспетчер отсутствует.

## Host file operation handler

### Trigger

The host RPC contract dispatches `fileOp` to `handleHostFileOp`. Its input schema accepts `writeAtomic`, `replace`, `read`, `stat`, or `remove`; requires a nonempty `canonicalRoot` (up to 1,024 characters) and `relativePath` (up to 512); caps `bytesBase64` at 8 MiB of string characters; and accepts an optional null or 64-character lowercase hexadecimal `expectedHash`. The root is a server-supplied path jail, not an access grant. (`src/host/entry-handlers.ts:6-10`, `src/host/file-contract.ts:4-13`, `src/host/file-contract.ts:15-27`, `src/host/file-contract.ts:30-37`)

### How it works

1. The handler branches on the operation and calls the corresponding guarded filesystem function with `canonicalRoot` and `relativePath`. Path resolution rejects lexical escapes and existing paths or symlinks that leave the root. (`src/host/file-handlers.ts:8-52`, `src/host/guarded-fs.ts:30-78`, `src/host/safe-path.ts:9-18`)
2. `writeAtomic` requires `bytesBase64`, decodes it and creates an immutable file atomically; success returns size and SHA-256 hash. An existing target returns `artifact_immutable`. (`src/host/file-handlers.ts:9-19`, `src/host/guarded-fs.ts:123-165`)
3. `replace` requires content and `expectedHash`; the guarded operation compares the current hash (or null if absent) before atomically replacing the file. A changed hash returns `file_changed`; success returns size and hash. (`src/host/file-handlers.ts:21-32`, `src/host/file-contract.ts:10-11`, `src/host/guarded-fs.ts:90-120`)
4. `read` returns byte size, SHA-256 and base64 content. `stat` returns size and hash or `{ missing: true }` when absent. `remove` unlinks the guarded path and treats an absent file as success. (`src/host/file-handlers.ts:34-52`, `src/host/guarded-fs.ts:167-211`)

### Modes

| Operation | Required branch inputs | Success | Failure |
| --- | --- | --- | --- |
| `writeAtomic` | `bytesBase64` | Size and hash | Missing content → `invalid_file_op`; guarded path or write errors preserve the error code. (`src/host/file-handlers.ts:9-19`) |
| `replace` | `bytesBase64`, `expectedHash` | Size and new hash | Missing fields → `invalid_file_op`; stale hash → `file_changed`; other guarded errors preserve their code. (`src/host/file-handlers.ts:21-32`) |
| `read` | Path | Size, hash and base64 bytes | Missing file → `artifact_file_missing`; path/read errors return their code. (`src/host/file-handlers.ts:34-42`, `src/host/guarded-fs.ts:167-180`) |
| `stat` | Path | Size/hash or `missing: true` | Path or filesystem errors return their code. (`src/host/file-handlers.ts:44-48`, `src/host/guarded-fs.ts:183-196`) |
| `remove` | Path | `{ ok: true }`, including an absent file | Path or unlink errors return their code. (`src/host/file-handlers.ts:50-52`, `src/host/guarded-fs.ts:198-211`) |

### Failures and compensation

Expected filesystem failures return typed error codes. Atomic create and replace clean up their temporary file on write/link/rename failure; replace checks the expected hash before replacing. `remove` has no restore step. `handleHostFileOp` has no catch around awaited guarded calls, so an unexpected thrown exception propagates from the host handler rather than becoming an `{ ok: false }` response. (`src/host/guarded-fs.ts:90-120`, `src/host/guarded-fs.ts:123-165`, `src/host/guarded-fs.ts:198-211`, `src/host/file-handlers.ts:8-52`)

### Related pages

The input and output types are defined in [file-contract.ts](../src/host/file-contract.ts). Host RPC registration is described in [BB API and Agency routes](bb-api.md#registered-transports); related job files and needs-input behavior remain in this page's earlier sections.

## Обязательный контракт реального вопроса

Job → Run → threadId → interactionId, плюс версия запроса и исходный провайдер.
Источник — threads.interactions.list/get, а не поиск вопросительных предложений
в тексте. user_question разрешается через threads.interactions.resolve с
resolution.kind=user_answer и answers[questionId]={selected,freeText}.
Plugin-owned форма использует threads.interactions.respond и исходный value.
Перед отправкой повторно проверять pending и принадлежность Run; при ответе из
другого окна показывать уже закрытый запрос. До подтверждения BB хранить состояние
«Отправляется», при ошибке оставлять форму. Отмена/истечение/остановка запуска
не должны возобновлять устаревший запрос. Комментарий не является ответом на форму.

Secrets: renderer secret-request передаёт values напрямую в штатный защищённый
обработчик BB. Агентство хранит только ссылку и статус запроса; значения запрещены
в Job, истории, черновиках, логах, Telegram и metadata. Сейчас UI этой ветки
отключён до привязки реального interaction. Нельзя подменять её обычным Input.

## Передача и резерв: будущий исполнитель

Режимы: следующая попытка после завершения текущей; остановить и передать после
подтверждённой остановки; новая параллельная подзадача. По умолчанию первая опция.
Одна задача не получает двух писателей в общей папке. Зафиксировать исходный Run,
адресата, модель, причину, бриф, версии артефактов и незакрытые вопросы. Новый Run
получает новый снимок правил и доступов. Память процесса CLI не переносится между
провайдерами; передаётся явный контекст. Проверять готовность хоста, доступность
CLI, разрешения, изоляцию и бюджет до claim/spawn. Резерв применяется только к
заданным причинам отказа, с лимитом попыток и записью причины переключения.

## Каталог собственных событий

Готовый notify сохраняет topic, projectId, eventId, reference с дедупликацией;
это входящий журнал, не шина исполнения. Для исполнения нужен реестр определений:
owner, topic, schemaVersion, displayName, payloadSchema, sourceKinds, capabilities.
В UI — понятное имя и системный код вторичным текстом. Группы: BB lifecycle,
бизнес-события Агентства, необязательные интеграции, пользовательские источники.

Планируемые события: job.created, job.ready_for_review, review.accepted,
review.rejected, dependencies.completed, question.created, question.answered,
artifact.updated. research.delivered — пример пользовательского домена.
Публичный notify/webhook не может сам объявить внутреннее review.accepted:
внешний источник получает своё пространство имён и проходит проверяемый переход.
thread.idle означает окончание хода, а не приёмку результата задачи.

Единый маршрут: аутентификация источника → проверка схемы → durable inbox →
правило/условия → очередь действия → Run или доставка → receipt/outbox.
Повтор eventId не повторяет действие; causalId и лимит глубины ограничивают циклы.
События lifecycle надо сверять с исходным Run после перезапуска. Cron лишь ещё
один источник, с timezone, nextRunAt и политикой пропусков в базе.

## Необязательный Telegram Projects, API v1

Готовы обнаружение через plugins.list/callRpc, сохранение opt-in и транспортный
адаптер. В Telegram Projects добавлены agencyCapabilities, agencyConfigure,
agencyEnqueue, agencyDeliveryStatus. Используется существующая очередь/бот,
новый getUpdates не запускается. agencyEnabled по умолчанию false.

Действия: telegram.notify и telegram.question_link. Получатель — уже связанная
тема BB-проекта, не произвольный chatId из уведомления. Payload строгий: deliveryId,
projectId, jobId, title, kind. Хеш содержимого обнаруживает повтор ID с иной нагрузкой.
Тема фиксируется при enqueue; при перепривязке очередь не уходит в новую тему.
Секреты/ответы форм в этот контракт не входят. Вопрос доставляется ссылкой в BB;
простой ответ в Telegram доступен только существующему мосту привязанного чата.

telegram.notification.delivered объявлен как событие адаптера, но сейчас читается
через receipt API: подписка/преобразование в inbox ещё не реализованы. Не добавлять
неподдерживаемые события входящих сообщений как якобы уже доступные.
Автоматические задания Агентства пока не вызывают enqueue. Отключение связи
Агентства запрещает новые enqueue; уже принятые записи контролирует agencyEnabled
в Telegram. Глобальное отключение Telegram останавливает его обработчик.
При неизвестном результате отправки нельзя обещать exactly-once внешнего API.
Отсутствующий, выключенный либо старый плагин не блокирует работу Агентства.

Переносимость: адаптер не содержит личных ID, но текущий Telegram Projects ещё
имеет личные OWNER_ID/BOT_ID; для другого пользователя нужен отдельный этап
онбординга Telegram-плагина. Это не исправлено изменениями Агентства.

## Приёмка перед включением автономии

Сохранение Job/Run/версий и форм; реальная изоляция MCP/skills на каждом CLI;
проверка параллельного ответа и stale interaction; идемпотентный claim/spawn;
восстановление после падения; неизменяемый контекст handoff; проверенный лимит
резерва; доставка Telegram с явно включённой связью; тест отсутствующего плагина.
Текущие прототипные события и тумблеры не заменяют эти проверки.

## Файловая вкладка — alpha.11

`prepareDocument` → host entry `materialize` → файл в plugin-owned
`experimental_paths.dataDir/document-previews/<session>/<job>/<hash>/<name>` →
`experimental_openFilePreview({target:{kind:"host",hostId,path},location:null})`.
Основная машина берётся из `sdk.system.config().primaryHostId`; пути не зашиты.
Запись происходит только после клика или сохранения, без запуска агента.
Имя — один сегмент, идентификатор файла хешируется, лимит 5 МБ; директории 0700,
файлы 0600. Это копии для предпросмотра, а не хранилище заданий или секретов.
Копии сохраняются на машине; автоматическая очистка пока не реализована.

File opener `agency-document` регистрирует только `txt/json/yaml/yml/csv` и
изображения и показывает редактор Агентства лишь для зарегистрированного в
текущей странице пути. `.md`/`.markdown` не входят в этот список — BB
маршрутизирует их отдельному плагину «Markdown PRO» (`md-editor`) по
расширению пути, не по логике Агентства. Для остальных незарегистрированных
документов opener возвращает `Original`; не меняет их чтение. После refresh BB
может восстановить ранее открытый реальный файл штатным просмотром. Черновики
и история прототипа остаются в памяти до refresh. Закрытие вкладки не удаляет
черновик. Сохранение обновляет версию в примере и копию файла на машине.

AG-102 содержит демонстрационные файлы `Оффер.md` и `Проверка.md`: клик по
ним открывает документ в Markdown PRO, а не в редакторе Агентства.

## Свойства документа — удалено

Собственный разбор и показ YAML-шапки (`parseDocumentProperties`,
`DocumentProperties`) был частью Markdown-редактора Агентства на TipTap и
удалён вместе с ним. Просмотр и редактирование YAML-шапки `.md`-документов —
зона ответственности плагина «Markdown PRO».

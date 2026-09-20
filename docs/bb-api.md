# Проверенные контракты BB

Проверка 20 сентября 2026: плагин **0.1.0-alpha.16**, BB ≥0.43.1, pin SDK `0.4.87`
(хост может быть новее — `bb plugin types` обновляет pin). Это проверка версии
SDK, не доказательство совместимости каждого CLI и всех runtime UI-пакетов.
Точные сигнатуры: `node_modules/@get-bb/plugin-sdk/bundled-types/` — файлы
`bb-plugin-sdk.d.ts`, `bb-plugin-sdk-app.d.ts`, `bb-plugin-sdk-host.d.ts`.
Использовать публичный SDK и native shims; не импортировать приватное ядро BB.

| Возможность | API / контракт | Используется в alpha.16 | Что ещё требуется |
| --- | --- | --- | --- |
| Backend | bb.server, factory(BbPluginApi), rpc.register | Да | Сервисы рабочих сущностей вместо демосостояния |
| UI | definePluginApp, slots.navPanel, native компоненты/тема | Да | RPC данные, состояния загрузки/ошибки/конфликта |
| Файлы на host | bb.host, experimental_defineHostEntry, hosts.experimental_client | Да, materialize preview | Привязка к host заказа, версии, очистка и восстановление |
| Чтение рядом | slots.fileOpener, experimental_openFilePreview | Да, закрываемая вкладка по клику | Сохраняемый registry артефактов; Original для остальных файлов |
| Форматирование | Markdown, SourceCode | Да; YAML разбирает пакет yaml | Проверки набора поддерживаемой разметки после обновления BB |
| База | storage.database(), migrate; storage.kv | Inbox + настройки | Полная модель, revision, backup и миграции |
| UI invalidation | realtime.publish | Inbox | Не очередь, после сигнала перечитать RPC |
| Машины/CLI | sdk.hosts.list/get, providerCliStatus, sdk.providers.list | Да | Авторизация/квота/модель/изоляция проверяются отдельно |
| Выбор исполнения | experimental_ProviderModelPicker, PermissionModePicker | Да, профиль в примере | Версионирование выбранного запуска и server validation |
| Треды | sdk.threads.spawn/send/wait/output/stop/archive | Нет вызовов исполнения | Запуск, binding, stop acknowledgement и reconcile |
| Вопросы | threads.interactions.list/get/resolve; plugin-owned respond | Только UI-пример | Сопоставление реального interaction/version, race/expiry; secure secret handler |
| События | bb.events.on | Каталог UI, подписки не зарегистрированы | Нормализация, inbox и восстановление пропущенных callbacks |
| Фоновая работа | background.service | Нет | AbortSignal, backoff и восстановление сохранённой очереди |
| Расписание | background.schedule | Нет; cron-parser считает preview | Собственные UTC occurrences, timezone/DST, пропуски и дедупликация |
| Webhook | http.route | Нет | Source auth, raw-body signature, schema, лимиты и durable ack |
| Связь плагинов | sdk.plugins.list/callRpc | Optional Telegram adapter | Интеграция с intent/outbox и receipt reconciliation |
| Ограничение инструментов | agents.configure | Не решает требование | Настраивает свои tools/skills плагина, не чужой каталог |

## События SDK

В `ThreadEventPayloads` проверены 14 ключей. Пользователь видит русское название,
рядом системное имя серым меньшим шрифтом. Не все события являются завершением
работы агента; payload и происхождение сохраняются.

| Название | Системный ключ |
| --- | --- |
| Чат создан | thread.created |
| Агент работает | thread.active |
| Ход агента завершён | thread.idle |
| Работа чата завершилась ошибкой | thread.failed |
| Чат архивирован | thread.archived |
| Чат восстановлен из архива | thread.unarchived |
| Чат удалён | thread.deleted |
| Требуется ответ или подтверждение | interaction.pending |
| Сообщение поставлено в очередь | message.queued |
| Сообщение передано агенту | message.dispatched |
| Сообщение отменено | message.cancelled |
| Ход завершился ошибкой | turn.failed |
| История чата обновилась | experimental_thread.events |
| Пользователь ввёл данные в терминал | experimental_terminal.input |

`message.dispatch` — отдельный hook, не ещё один ключ events.on. Terminal input
не содержит введённого текста. `workflow.completed` не подтверждён как нативный
ключ этой версии. Для цепочек использовать своё проверенное событие этапа.

Собственные `job.created`, `job.ready_for_review`, `review.accepted`,
`review.rejected`, `dependencies.completed`, `research.delivered` сейчас —
6 примеров каталога, не исполняемая событийная инфраструктура. Последний —
прикладной пользовательский пример, не универсальный lifecycle. В первой версии
registry разделит BB events, Agency lifecycle и события установленных адаптеров.
Внутренний review.accepted может возникнуть только из проверенного перехода,
а не из webhook с таким названием. Подробности — [модель данных](data-model.md).

## Главный неподтверждённый контракт: изоляция

ThreadSpawnArgs/CreateThreadRequest позволяют выбрать провайдер/модель,
reasoning, permission mode, service tier, среду/машину, visibility и metadata.
В проверенной декларации нет per-thread `mcpIds`/`skillIds` allowlist.
`executionInputSources` описывает происхождение выбора исполнения, не права.
Hidden скрывает служебный чат, но не ограничивает доступ.

Host SDK имеет экспериментальные helpers для native roots, включая
`experimental_filterResolvedNativeRoots`. Их наличие не доказывает возможность
полностью отсечь глобальные/native skills и MCP конкретного агента. До spike
нельзя обещать изоляцию посредством cwd, собственного mcp.json или промпта.

Проверка отдельно покрывает BB tools, deferred tool search, MCP gateway,
нативные настройки CLI, shell/файлы/сеть и административные команды BB.
Матрица провайдер×host получает verified/unavailable/unknown, доказательство и
версию адаптера. После обновления провайдера проверка повторяется. Если SDK
недостаточен, результат этапа — конкретный контракт изменения core/адаптера;
запуск остаётся недоступным, автономия не включается.

## Фон и восстановление

`background.service(name,{start(signal)})` запускается после factory; остановка
передаёт abort, сбои приводят к backoff. Жизнь службы ограничена жизнью BB.
`background.schedule` создаёт/обновляет durable row по pluginId/name при загрузке,
использует пять полей cron и локальное время сервера, работает только при loaded.
CAS next_run_at не является гарантией выполнения бизнес-задачи или внешнего эффекта.

Один минутный tick выбирает due occurrences собственных правил в SQLite;
cron-parser вычисляет даты в IANA timezone. Сохраняются scheduledAtUTC, правило
обработки пропусков и уникальный occurrence. Событийные действия не ждут cron;
сверка по времени лишь восстанавливает пропущенную работу.

## Optional Telegram

Проверен установленный telegram-projects 0.5.1 и контракт API v1:
`agencyCapabilities`, `agencyConfigure`, `agencyEnqueue`, `agencyDeliveryStatus`.
Действия notify/question_link, подтверждение доставки через receipt polling.
В Agency enqueue ещё не подключён к диспетчеру. Нет подтверждённой универсальной
подписки на все события Telegram и нет структурированного ответа в чате первой
версии: вопрос ведёт в форму BB. Наличие старого/отсутствующего плагина не мешает
остальным функциям. Нет нового getUpdates loop и произвольного chatId из webhook.
Личный bridge требует проверки переносимости OWNER_ID/BOT_ID перед обещанием
работы у любого владельца. [Подробный контракт](interaction-and-runtime.md).

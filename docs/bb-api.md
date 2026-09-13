# Проверенные контракты BB

Основа: Plugin Guide и SDK 0.4.87, BB 0.43.1. При обновлении повторить
`bb plugin types` и контрактные проверки. Использовать публичный SDK; не копировать
ядро BB в репозиторий и не импортировать приватные пакеты @bb/*.

| Назначение | API | Граница |
|---|---|---|
| Backend | bb.server → factory(BbPluginApi) | Только регистрация, не долгие работы при загрузке |
| Frontend | bb.app → definePluginApp, slots.navPanel | React/SDK предоставляются BB |
| Контракт | defineRpcContract, bb.rpc.register | Runtime-валидация входа и выхода |
| База | storage.database/migrate | SQLite плагина, миграции append-only |
| Сигналы UI | realtime.publish | Не сохраняются, UI перечитывает RPC |
| Работники | sdk.threads.spawn/send/wait/output/stop/archive | Hidden не является sandbox |
| События | events.on(thread.idle/failed и др.) | Не надёжная очередь; нужна сверка |
| Фон | background.service | AbortSignal на остановку, restart с backoff |
| Время | background.schedule | Сохраняемые 5-field cron, время сервера, только loaded |
| Доступ | agents.configure | Только свои static tools/skills, не общий allowlist |
| Внешний ввод | http.route | Точные пути, обязательная проверка внешнего отправителя |

В alpha.1 используются factory, UI, RPC, storage, realtime и CLI.
Службы, расписания, HTTP, host entry и spawn не зарегистрированы.

Сверены справочники skill bb-plugin-authoring: quickstart, backend-sdk,
backend-events, backend-foundation, backend-cli-agents, frontend-registration,
testing. Точные типы находятся в закреплённом пакете @get-bb/plugin-sdk.

Изоляция проверяется отдельно для BB tools, отложенного поиска, шлюзов MCP,
глобальных/native skills CLI, инструментов shell и полномочий BB CLI. Выбор
галочек должен контролировать фактическую конфигурацию процесса, включая resume
и параллельные профили. Смена cwd или запись mcp.json не считается доказательством.

## Повторная проверка SDK при ревью alpha.9

В bundled-types/bb-plugin-sdk.d.ts версии 0.4.87 сверены ThreadSpawnArgs /
createThreadRequestSchema: есть environment, providerId, model, permissionMode,
reasoningLevel, serviceTier, visibility, metadata; per-thread mcpIds/skillIds
в этом контракте нет. executionInputSources отмечает источник выбора модели/CLI,
а не доступные инструменты. Возможности адаптеров требуют отдельного spike.
background.schedule: durable row при загрузке, CAS по next_run_at, пять полей,
локальное время сервера и выполнение только пока плагин загружен. Это не
гарантирует исполнение Job/повтор внешнего эффекта; для этого нужен наш журнал.

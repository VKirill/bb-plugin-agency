---
title: Собственные MCP сотрудника
type: component
created: 2026-09-13
updated: 2026-09-28
status: stale
confidence: medium
tags: [mcp, agents, configuration]
sources:
  - docs/architecture.md
  - docs/bb-api.md
  - docs/instruction-context.md
  - src/app/prototype/mcp-config.ts
  - src/app/prototype/custom-mcp.tsx
  - src/app/prototype/agent-detail.tsx
---
# Собственные MCP сотрудника

## How it works

1. The editor receives the current MCP items, reserved names, and an `onChange` callback. The agent profile currently renders this editor disabled, so its add/edit controls are unavailable there (`src/app/prototype/agent-detail.tsx:361-392`).
2. When enabled in a caller, Add opens an empty JSON editor; Edit loads one existing server. Editing the text clears the previous preview and error (`src/app/prototype/custom-mcp.tsx:8-19`).
3. Validate parses a single `mcpServers` object and checks server shape, URL, secret-reference syntax, argument count, import size, server count, and case-insensitive name collisions (`src/app/prototype/mcp-config.ts:4-33`).
4. A valid import displays a preview. Add appends its servers; Edit replaces the one edited item while preserving its enabled flag (`src/app/prototype/custom-mcp.tsx:21-26`, `src/app/prototype/custom-mcp.tsx:40-42`).
5. The profile UI represents selected and disabled catalog MCP IDs separately from custom configuration; it currently rejects a profile that has MCPs because launch delivery is unavailable (`src/app/prototype/agent-detail.tsx:361-392`).

| Mode or state | Input and behavior | Failure or outcome |
| --- | --- | --- |
| Add | One JSON document may contain 1–20 uniquely named servers. A successful preview appends them through `onChange`. | Invalid JSON/schema, size/count limits, or name collision clear the preview and show the parse error. (`src/app/prototype/mcp-config.ts:19-33`, `src/app/prototype/custom-mcp.tsx:21-26`) |
| Edit | The editor accepts one server and replaces the matching item after validation. | A multi-server edit is rejected; failed validation leaves the current items unchanged. (`src/app/prototype/custom-mcp.tsx:21-26`, `src/app/prototype/custom-mcp.tsx:42`) |
| Enabled / disabled item | Enabled is a UI selection state; the label remains “Not connected.” | It does not test network access or start the server. (`src/app/prototype/custom-mcp.tsx:30-35`) |
| Disabled profile editor | The profile passes `disabled`; custom MCP editing is unavailable. | This editor makes no configuration change. (`src/app/prototype/agent-detail.tsx:361-392`) |

The parser reports malformed or unsupported input in the editor and does not resolve secret references or connect to a server (`src/app/prototype/mcp-config.ts:19-33`, `src/app/prototype/custom-mcp.tsx:21-27`, `src/app/prototype/custom-mcp.tsx:35-42`).

## Реализовано в alpha.8

Возможности → Собственные MCP → Добавить MCP через JSON. Штатный Dialog BB,
поле кода, примеры HTTP/stdio, проверка, предпросмотр, добавление в профиль.
Несколько подключений импортируются одним действием; редактирование — по одному.
Переключатель исключает подключение из выбранных возможностей. Можно удалить.
Счётчики профиля и раздел Исполнение учитывают включённые собственные MCP.

Контракт ввода прототипа — JSON с единственным корнем `mcpServers`, словарём
имён серверов. Это формат импорта Агентства, не обещание совместимости всех CLI.

- Локальный: `command`, необязательные `args` (массив строк), `env`, `type: stdio`.
- Удалённый: `url`, необязательные `headers`, `type: http | sse`.
- `command` и `url` взаимоисключающие; неизвестные поля отклоняются.
- В env/headers только ссылки `${SECRET_NAME}` или `Bearer ${SECRET_NAME}`.
  Реальные значения в этот макет вводить не следует; ссылки пока не разрешаются.
- URL только HTTP(S), без credentials/query/fragment. Для query-based auth
  потребуется отдельный серверный адаптер; сейчас такой формат не принимается.
- Имена: 1–80 ASCII букв/цифр/точек/дефисов/подчёркиваний, первый символ буква/цифра.
  Конфликты имён без учёта регистра отклоняются, тихой замены существующего MCP нет.
- До 20 серверов за импорт, до 64 К символов текста, до 100 аргументов команды.
- Изменение JSON сбрасывает предпросмотр; добавление доступно после проверки.

Пример:

```json
{
  "mcpServers": {
    "research-tools": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
    }
  }
}
```

Данные только в памяти UI, отдельно на каждого сотрудника, до refresh/сброса
примера. Импорт ничего не отправляет на сервер, не вызывает command и не ходит
по URL. Статус «Не подключён» отличает выбранный черновик от рабочего MCP.
Парсер не является песочницей команд или системой обнаружения всех секретов.
Не помещать секреты в args. Ошибки не выводят исходные значения конфигурации.

## Следующий этап реального подключения

1. Сервер повторно проверяет ввод, хранит версии нормализованного профиля.
   Секреты принимает отдельная форма серверного хранилища; JSON содержит ссылки.
2. Адаптер выбранного CLI проверяет поддерживаемые transports, синтаксис,
   хост и совместимость с политикой изоляции. Неподдерживаемое явно блокируется.
3. Отдельная команда «Проверить соединение» запускает ограниченный probe на
   назначенной машине, с таймаутом, политикой URL/редиректов и сетевых доступов.
   Для stdio запуск команды является отдельным действием, не эффектом вставки.
4. Результат проверки: доступность, перечень инструментов, причина ошибки,
   время проверки. Редактирование конфигурации делает проверку устаревшей.
5. Run закрепляет версию профиля и ссылки на секреты. В runtime передаются
   только разрешённые MCP; native/global конфиги CLI не расширяют allowlist.
6. Очистка процесса/соединения, отзыв доступа и смена секрета входят в lifecycle.
   Ни один этап не считается реализованным на основании работающего редактора.

Связанные границы: [архитектура](architecture.md), [API BB](bb-api.md),
[контекст инструкций](instruction-context.md).

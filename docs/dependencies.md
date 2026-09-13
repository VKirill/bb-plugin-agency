# Пакеты и совместимость

Инвентаризация 14 сентября 2026, alpha.12. `package-lock.json` — точный граф
установки; package.json — допустимые диапазоны. Сверены lock и npm ls, расхождений
прямых версий нет. Обновления в ходе документального ревью не выполнялись.

## Базовая совместимость

| Компонент | Проверено | Условие |
| --- | --- | --- |
| BB | 0.43.1 | engines.bb >=0.43.1 <0.44 |
| Plugin SDK | pin и host 0.4.87 | engines.bbPluginSdk >=0.4.87 <0.5; dev pin exact |
| Агентство | 0.1.0-alpha.12 | path установка, running |
| Telegram Projects | 0.5.1, optional API v1 | Наличие/версию проверять capabilities, не по названию |
| Node в shell проверки | 26.3.1 | Не доказательство версии процесса сервера или поддержки Node 22 |
| npm | 11.16.0 | Установка воспроизводится через npm ci с lock |
| TypeScript target/types | ES2022 / @types/node 22.20.2 | node engines и CI baseline ещё нужно определить |

## Прямые зависимости

Колонки lock/installed — версии в этом checkout, **не версии React/портальных
компонентов внутри браузера BB**. Пакеты с shim предоставляет BB runtime;
локальная dev-копия нужна для типов/разработки. Сверка SDK pin не проверяет
по отдельности все эти runtime версии.

| Пакет | manifest | lock / installed | Раздел | Назначение |
| --- | --- | --- | --- | --- |
| @hugeicons/core-free-icons | ^4.1.3 | 4.3.2 | prod | Иконки, bundled |
| @hugeicons/react | ^1.1.6 | 1.1.10 | prod | Иконки React, bundled |
| @radix-ui/react-checkbox | ^1.3.7 | 1.3.11 | prod | Компонент, bundled |
| @radix-ui/react-slot | ^1.3.0 | 1.3.3 | prod | Компонент, bundled |
| @radix-ui/react-tabs | ^1.1.21 | 1.1.21 | prod | Компонент, bundled |
| cron-parser | ^5.5.0 | 5.10.1 | prod | Вычисление cron preview и будущих occurrences |
| yaml | ^2.9.1 | 2.9.1 | prod | Frontmatter |
| zod | ^4.3.6 | 4.6.4 | prod | RPC/данные, bundled |
| @get-bb/plugin-sdk | 0.4.87 | 0.4.87 | dev | SDK и декларации, точный pin |
| @pierre/diffs | ^1.2.9 | 1.4.2 | dev | BB shim, локальная версия для разработки |
| @radix-ui/react-alert-dialog | ^1.1.19 | 1.1.23 | dev | BB shim, портальный UI |
| @radix-ui/react-context-menu | ^2.3.3 | 2.3.7 | dev | BB shim, портальный UI |
| @radix-ui/react-dialog | ^1.1.19 | 1.1.23 | dev | BB shim, портальный UI |
| @radix-ui/react-dropdown-menu | ^2.1.20 | 2.1.24 | dev | BB shim, портальный UI |
| @radix-ui/react-hover-card | ^1.1.19 | 1.1.23 | dev | BB shim, портальный UI |
| @radix-ui/react-menubar | ^1.1.20 | 1.1.24 | dev | BB shim, портальный UI |
| @radix-ui/react-navigation-menu | ^1.2.18 | 1.2.22 | dev | BB shim, портальный UI |
| @radix-ui/react-popover | ^1.1.19 | 1.1.23 | dev | BB shim, портальный UI |
| @radix-ui/react-select | ^2.3.3 | 2.3.7 | dev | BB shim, портальный UI |
| @radix-ui/react-tooltip | ^1.2.12 | 1.2.16 | dev | BB shim, портальный UI |
| @types/better-sqlite3 | ^7.6.12 | 7.6.13 | dev | Типы разработки |
| @types/node | ^22.0.0 | 22.20.2 | dev | Типы разработки |
| @types/react | ^19.0.0 | 19.3.0 | dev | Типы разработки |
| @types/react-dom | ^19.0.0 | 19.3.0 | dev | Типы разработки |
| better-sqlite3 | ^12.0.0 | 12.11.1 | dev | Локальный SDK harness; рабочая БД через BB |
| class-variance-authority | ^0.7.1 | 0.7.1 | dev | BB shim, variants |
| clsx | ^2.1.1 | 2.1.1 | dev | BB shim, CSS helpers |
| hono | ^4.11.9 | 4.13.7 | dev | Типы/инфраструктура SDK harness |
| sonner | ^1.7.4 | 1.7.4 | dev | BB shim, уведомления |
| tailwind-merge | ^3.4.0 | 3.7.0 | dev | BB shim, CSS helpers |
| typescript | ^5.7.0 | 5.9.3 | dev | Typecheck |
| vaul | ^1.1.2 | 1.1.2 | dev | BB shim, drawer |
| vitest | ^3.2.0 | 3.2.7 | dev | Тесты; см. advisory ниже |

## Политика пакетов

React/ReactDOM, портальные Radix, sonner, vaul и @pierre/diffs предоставляются
BB. Не добавлять второй React или свою копию портального окружения в bundle.
Предпочитать штатные SourceCode/Diff/Markdown. Checkbox/Slot/Tabs, Hugeicons,
cron-parser, yaml и zod используют собственную сборку плагина. Zod необходим
и на сервере, и в браузере. SQLite продукта — `bb.storage.database()`, не
отдельное соединение better-sqlite3 поверх той же базы.

Native Markdown включает нужные рендереры; Mermaid/KaTeX не добавлять отдельными
зависимостями без найденного ограничения. Аналогично нет основания сейчас
добавлять Redis, внешний scheduler или библиотеку графов для уже работающей оргсхемы.
Новые пакеты вводить по конкретному отсутствующему контракту и с проверкой BB bundle.

`bb plugin types --check` безопасен для сверки; `bb plugin types` может менять
пины/декларации, его запуск — часть отдельного контролируемого обновления.
Перед изменением minor BB/SDK повторить native UI/host/RPC/file preview проверки.
Для версии с рабочими данными lock обязателен, runtime совместимость не расширять
в engines без проверки. Проверку host.ts добавить в tsconfig на этапе 0.

## Audit и запланированное обновление

Полный `npm audit`: 2 moderate findings (vitest и @vitest/mocker, **одна** advisory),
0 high/critical. `npm audit --omit=dev`: 0 findings. Установлен Vitest 3.2.7.
[GHSA-82fw-gwwq-j7x9 от разработчиков Vitest](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9)
описывает чтение файлов через redirect mock при доступе к dev-server WebSocket.
Исправления есть в 4.1.11 и 5.0.0; 3.x не получает исправление. Текущий запуск —
node `vitest run`, публичный mocker/dev server не настроен; это не подтверждённая
уязвимость production-плагина.

План этапа 0: проверить переход на исправленную совместимую 4.1.x, либо 5.x,
с SDK harness, Node baseline, lock и всеми тестами. npm audit предлагает major
upgrade; не применять force fix автоматически. До обновления не открывать наружу
тестовый mocker server. Сохранённый audit отражает дату проверки, не вечную гарантию.

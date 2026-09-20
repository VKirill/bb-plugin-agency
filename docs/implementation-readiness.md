# Готовность и границы runtime

20 сентября 2026 · source **0.1.0-alpha.16** · Mac mini. Введение установки —
корневой README (его не дублировать здесь как релизные ноты). Исторический снимок
14 сентября оставлен внизу и не является текущим статусом.

## Что можно обещать из source

| Область | Сейчас | Граница |
| --- | --- | --- |
| CRUD | Agent/Department/Binding/Job/Artifact/Activity в SQLite; RPC+CLI; UI на RPC | Не raw SQL. `status.execution` не запуск |
| Файлы | Publish/open/accept по hash; preview на host binding | Published ≠ accepted |
| Контекст | `compileContextSnapshot` schema 2; precedence department/job | Сервер не сравнивает acceptance regex |
| Launch | `prepareLaunch` / receipt / reconcile; native `threads.spawn` | Любой CLI, подключённый в BB и разрешённый политиками проекта и сотрудника. Без CLI/политик spawn недоступен, CRUD жив |
| Watch | `idle` + hash текущей версии → Job `review`, attempt `awaiting_review` | `idle` без такого артефакта оставляет `running`. Не accept. `runSucceeded` всегда false |
| Вопрос | Typed `reportNeedsInput` → `waiting_input`; `answerNeedsInput` + `waitId` + amendment + official send → тот же running; новый вопрос — новый wait | Recover unknown → `needs_reconciliation` без send. `queued` ≠ turn active. Класса done без артефакта нет |
| Telegram | Opt-in notify / question_link; очередь решений по главным задачам в Telegram Projects | Не второй getUpdates; не enqueue минуя launch gate |
| Cron / webhook | Правило с cron (IANA, skip/last/catch_up) и `POST /http/notify` (HMAC); диспетчер 30 с ставит задачу руководителю | Не минуя launch gate. Notify не spawn |
| Студия | Кит: 14 отделов; библиотека навыков отдела, выдача ≤2 на запуск; пакеты ремесла у 7 столов | Живые ID не в git; киты Инфра / Автоматизация / Продажи / Офис без стола ремесла |

Production install/reload этим документом не утверждается. Живой запуск от задачи
до сданной версии проверен для Claude Code, Codex (с быстрым режимом), Cursor,
OpenCode и Antigravity; это доставка профиля через BB, а не файловая песочница.

## Приёмка перед автономией (ещё открыто)

- Файловая песочница и обходы shell/BB CLI для всех CLI.
- BB `threads.interactions` для формы вопроса (сейчас Agency-owned record).
- Резервный CLI после своей изоляции.

## Историческое ревью волны AGY (утро 14 сентября)

Ниже — исходный снимок до launch/watch. Не использовать как текущий статус CRUD
или «runtime отсутствует». Трекинг — BB Tasks, проект AGY.

Лидер тогда: typecheck и тесты волны 1; live upload/open на host. Автономия
не включалась. Таблица «постоянный CRUD отсутствует / isolation stub» **устарела**.

- AGY-2…AGY-8: toolchain, domain, storage, artifacts, RPC, UI на данных.
- AGY-16/0431: catalog pin, watch, `reportNeedsInput`; запуск — native `threads.spawn` (AG-28 убрал experimental spawn-contract).
- AGY-17: installation-owner RPC, не caller context SDK 0.4.87.

Подробности toolchain: [проверки](toolchain-validation.md).

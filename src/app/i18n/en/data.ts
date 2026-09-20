/** English UI texts, keyed by the exact Russian source text. Group: data. */
export const EN_DATA: Record<string, string> = {
  // Status / state labels (prototype/data.ts stateNames, dispatcher.ts INTENT_STATE_LABEL,
  // job-attention.ts REASON, launch-rpc.ts launchStateLabel, view-models.ts ACTIVITY_KIND_LABEL)
  "Бэклог": "Backlog",
  "К запуску": "Queued",
  "В работе": "Running",
  "На проверке": "In review",
  "Ждёт ответа": "Waiting for answer",
  "Ожидает решения": "Needs decision",
  "Готово": "Done",
  "Отменено": "Canceled",
  "Отменён": "Canceled",
  "Наблюдение": "Observing",
  "Ждёт согласования": "Awaiting approval",
  "В очереди": "Queued",
  "Пропущено": "Skipped",
  "Ошибка": "Error",
  "Подготовлен": "Prepared",
  "Стартует": "Starting",
  "Ждёт ввода": "Waiting for input",
  "Неизвестно — сверка": "Unknown — reconcile",
  "Ждёт уточнения вводных": "Waiting for details",
  "Ждёт вашего ответа": "Waiting for your reply",
  "Ждёт вашего решения": "Waiting for your decision",
  "На проверке: линия закроет станцию сама": "In review: the line will close the station itself",
  "Исполнитель работает": "Executor is working",
  "В очереди на запуск": "Queued to launch",
  "Не передана в работу": "Not yet handed off",
  "Результат принят": "Result accepted",
  "Задача отменена": "Job canceled",
  "Задача создана": "Job created",
  "Задача обновлена": "Job updated",
  "Добавлена зависимость": "Dependency added",
  "Изменён статус": "Status changed",
  "Опубликован файл": "File published",
  "Комментарий": "Comment",
  "Статус: {state}": "Status: {state}",

  // Relative time (job-attention.ts, job-due.ts)
  "только что": "just now",
  "{n} мин": "{n}m",
  "{n} ч": "{n}h",
  "{n} дн": "{n}d",
  "{n} нед": "{n}w",
  "{reason}. Без изменений {age}": "{reason}. No change for {age}",
  "просрочена {age}": "overdue by {age}",
  "Срок {date} прошёл {age} назад": "Due {date}, {age} ago",
  "срок через {rest}": "due in {rest}",
  "Срок {date}: осталось {rest}": "Due {date}: {rest} left",
  "до {date}": "by {date}",
  "Срок {date}": "Due {date}",

  // job-tree.ts
  "{n} готово": "{n} done",
  "1 отменена": "1 canceled",
  "{n} отменены": "{n} canceled",
  "{n} открыто": "{n} open",
  "Главная задача": "Main job",

  // job-edit-draft.ts
  "название": "title",
  "описание": "description",
  "статус: {from} → {to}": "status: {from} → {to}",
  "приоритет: {value}": "priority: {value}",
  "контракт исполнения": "execution contract",
  "срок: {value}": "due date: {value}",
  "не задан": "not set",
  "исполнитель: {value}": "executor: {value}",
  "Вы обновили задачу — {notes}": "You updated the job — {notes}",

  // Fallback labels (group-refs.ts, job-placement.ts, job-team.ts, view-models.ts)
  "Не назначен": "Not assigned",
  "Не назначены": "None assigned",
  "Не запущено": "Not launched",
  "Сотрудник": "Employee",
  "не в этом отделе": "not in this department",
  "Проект": "Project",
  "Должность уточняется в карточке": "Job title not set yet",
  "Отдел агентства": "Agency department",
  "Система": "System",
  "Вы": "You",
  "Запуск": "Launch",

  // Role labels (role-types.ts ROLE_TYPE_OPTIONS, prototype/data.ts ROLE_TYPE_LABELS,
  // job-placement.ts membershipRoleLabel)
  "Руководитель": "Lead",
  "Исполнитель": "Executor",
  "Проверяющий": "Reviewer",
  "руководитель": "lead",
  "проверяющий": "reviewer",
  "исполнитель": "executor",

  // charter.ts
  "нет раздела «## Принимаем»: агенты в чатах не поймут, какие задачи поручать отделу":
    "missing the “## Accepts” section: chat agents won't know what work to hand this department",
  "остались строки шаблона: {lines}": "template lines still in place: {lines}",

  // agent-profile-fields.ts
  "Сохранение создаёт новую версию профиля: имя, должность, инструкция, основная CLI и модель, запасные модели, уровень рассуждения, быстрый режим и навыки. Идущие запуски работают по прежней версии.":
    "Saving creates a new profile version: name, job title, instructions, primary CLI and model, reserve models, reasoning level, fast mode and skills. Runs already underway keep the previous version.",
  "Отдел задаётся в составе отдела, в версии профиля не хранится.":
    "The department is set from the department's roster; it isn't stored in the profile version.",
  "Машина в версии профиля не хранится. Запуск идёт в окружении проекта задачи.":
    "The machine isn't stored in the profile version. The run uses the job's project environment.",
  "Уровень рассуждения в версии профиля не хранится.": "Reasoning level isn't stored in the profile version.",
  "Режим разрешений в версии профиля не хранится.": "Permission mode isn't stored in the profile version.",
  "Число одновременных задач в версии профиля не хранится.": "Concurrent job count isn't stored in the profile version.",
  "Доступ к терминалу в версии профиля не хранится.": "Terminal access isn't stored in the profile version.",
  "Передача работы другим сотрудникам в версии профиля не хранится.":
    "Delegating work to other employees isn't stored in the profile version.",
  "Свои MCP в версии профиля не хранятся — только идентификаторы из каталога.":
    "Custom MCPs aren't stored in the profile version — only catalog ids are.",
  "Профиль на сервере изменился. Черновик оставлен. Сохранение сверит исходную ревизию и не перезапишет чужую версию молча.":
    "The profile changed on the server. The draft is kept. Saving checks the original revision and won't silently overwrite someone else's version.",
  "Нельзя сохранить: {fields}. Эти поля ещё не входят в версию профиля.":
    "Can't save: {fields}. These fields aren't part of the profile version yet.",
  "отдел": "department",
  "машина": "machine",
  "режим разрешений": "permission mode",
  "одновременные задачи": "concurrent jobs",
  "терминал": "terminal",
  "делегирование": "delegation",
  "свои MCP": "custom MCPs",

  // answer-needs-input.ts / needs-input.ts
  "Ответьте на каждый вопрос этой паузы. Пропущенный или лишний id не принимается.":
    "Answer every question in this pause. A missing or extra id isn't accepted.",
  "Открыт новый запрос. Старый ответ его не закрывает — заполните вопросы заново.":
    "A new request is open. The old answer doesn't close it — fill in the questions again.",
  "Ответ стоит в очереди доставки. Ход исполнителя ещё не подтверждён. Повторно не отправляем.":
    "The answer is queued for delivery. The executor's move isn't confirmed yet. We won't resend it.",
  "Состояние неизвестно. Нужна сверка той же команды, не повторная отправка и не новый запуск.":
    "State unknown. This needs reconciling the same command, not a resend or a new launch.",
  "Нельзя ответить: нет версии процесса или digest снимка запуска.":
    "Can't answer: missing the process version or the launch snapshot digest.",
  "Доставка отклонена. Тот же запрос повторно не шлём. Обновите карточку.":
    "Delivery was rejected. We won't resend the same request. Refresh the card.",
  "Нет открытого waitId. Отвечать не на что.": "No open waitId. There's nothing to answer.",
  "Критерии процесса": "Process acceptance criteria",
  "Инструкции процесса": "Process instructions",
  "Критерии задачи": "Job acceptance criteria",
  "Бриф задачи": "Job brief",
  "Комментарий пишется только в историю. Он не отвечает на вопросы исполнителя и не возвращает задачу в работу.":
    "A comment only goes into the history. It doesn't answer the executor's questions and doesn't put the job back to work.",
  "Комментарий и смена статуса это не закрывают. Нужен ответ на все вопросы текущего waitId.":
    "A comment or a status change doesn't close this. All questions of the current waitId need an answer.",

  // dispatcher.ts
  "Задачу из этого правила сейчас запустить нельзя.": "This rule's job can't be launched right now.",
  "Действие согласовано: в течение полуминуты Агентство создаст задачу и поставит её в очередь запуска.":
    "Action approved: within half a minute the Agency will create the job and queue it to launch.",
  "Действие взято в работу: задача создаётся и встаёт в очередь запуска.":
    "Action claimed: the job is being created and queued to launch.",
  "Проверили новые события. Агентство и само проверяет их каждые 30 секунд.":
    "Checked for new events. The Agency also checks every 30 seconds on its own.",
  "Показывается то, что вернул сервер.": "Shows exactly what the server returned.",
  "Старые уведомления остаются в истории и не запускают правила.":
    "Old notifications stay in history and don't trigger rules.",
  "Можно выбрать сохранённый тип, источник или правило. Новую запись по-прежнему задают полями.":
    "You can pick a saved type, source or rule. A new entry is still set with fields.",
  "Пока нечего согласовывать.": "Nothing to approve yet.",
  "Проверьте название и обязательные поля.": "Check the name and required fields.",
  "Нужен проект из рабочего пространства.": "A project from the workspace is required.",
  "У этой привязки нет кода проекта BB. Источник и правило сейчас недоступны.":
    "This binding has no BB project code. The source and rule aren't available right now.",
  "Несколько привязок смотрят на один проект BB. Источники и правила общие — это не отдельные области.":
    "Several bindings point at the same BB project. Sources and rules are shared — they aren't separate scopes.",
  "Событие → правило → задача отделу. Источник принимает события (уведомление, внешний адрес или расписание), правило решает, что с ними делать. Созданные задачи проходят обычные проверки запуска и лимиты.":
    "Event → rule → job for a department. A source accepts events (a notification, an external address or a schedule); a rule decides what to do with them. Created jobs go through the usual launch checks and limits.",
  "Событие принято.": "Event accepted.",
  "Такое событие уже есть.": "This event already exists.",
  "Чтобы принять другое событие, начните следующее.": "To accept another event, start the next one.",
  "Событие не принято. Повторите тот же черновик.": "The event wasn't accepted. Retry the same draft.",
  "Сохранённый источник сейчас недоступен. Событие нельзя принять.":
    "The saved source isn't available right now. The event can't be accepted.",
  "Уведомление": "Notification",
  "Внешний адрес": "External address",
  "По расписанию": "Scheduled",
  "Событие BB": "BB event",

  // job-lifecycle.ts
  "Исполнитель ждёт ответа на вопрос: ответьте в карточке задачи, статус изменится сам.":
    "The executor is waiting on an answer: reply in the job card and the status will change itself.",
  "Этот переход не делается перетаскиванием. Нужны проверка результата, приёмка версии или ответ на вопрос.":
    "This move isn't made by dragging. It needs a result review, a version acceptance, or an answer to a question.",
  "«Готово» ставит конвейер приёмкой текущей версии, не перетаскиванием.":
    "“Done” is set by the conveyor accepting the current version, not by dragging.",
  "Выберите версию результата, которую принимаете.": "Choose the result version you're accepting.",
  "У задачи несколько версий результата. Выберите, какую принимаете.":
    "The job has several result versions. Choose which one you're accepting.",
  "Пока вы выбирали, появилась новая версия результата. Выберите версию заново.":
    "A new result version appeared while you were choosing. Pick the version again.",
  "Пока задача ждёт ввода, проверка результата закрыта.": "While the job is waiting for input, result review is closed.",
  "Последний запуск не принят": "Last launch not accepted",
  "Сверить публикацию": "Reconcile publication",
  "«В работе», «На проверке», «Готово» и «Ждёт ответа» ставит сама работа: запуск, сдача версии, приёмка и вопрос исполнителя.":
    "“Running”, “In review”, “Done” and “Waiting for answer” are set by the work itself: a launch, publishing a version, acceptance, and the executor's question.",
  "Задача в работе: сначала остановите запуск в карточке задачи, затем решайте, что с ней делать.":
    "The job is running: stop the launch in the job card first, then decide what to do with it.",

  // job-placement.ts
  "Поручение отделу: что сделать, как проверить результат и кто отвечает. Задача создаётся в бэклоге, запуск — из её карточки.":
    "An assignment for a department: what to do, how to check the result, and who's responsible. The job is created in the backlog; launch it from its card.",
  "Для выбранного проекта нет доступных отделов. Создайте отдел или откройте доступ отдела к этому проекту.":
    "No departments are available for the selected project. Create a department or open a department's access to this project.",
  "В этом отделе нет сотрудников. Назначить можно только тех, кто входит в состав отдела.":
    "This department has no employees. You can only assign someone who's a member of the department.",

  // job-team.ts
  "Поля проверяющих и наблюдателей сервер ещё не отдаёт. Запись из названия или описания не подставляется.":
    "The server doesn't provide reviewer and watcher fields yet. Nothing is inferred from the title or description.",
  "Назначение и попытка — разные поля.": "Assignment and attempt are different fields.",

  // job-environment.ts
  "Подтверждена": "Confirmed",
  "Не подтверждена": "Not confirmed",
  "Проверяем": "Checking",
  "не определён": "not set",

  // launch-rpc.ts / persist-launch.ts
  "RPC запуска ещё не зарегистрирован в этом instance. Строки запусков не выдумываются.":
    "The launch RPC isn't registered on this instance yet. Launch rows aren't invented.",
  "Список попыток появится, когда instance отдаст listJobAttempts по jobId в scope. Сейчас доска пустая.":
    "The attempt list appears once the instance serves listJobAttempts for a scoped jobId. The board is empty for now.",
  "Запуск начнётся, когда у задачи будет исполнитель, доступный CLI и правила проекта.":
    "Launch starts once the job has an assignee, an available CLI, and project rules.",
  "Состояние попытки сервер не поддерживает. Запуск недоступен.":
    "The server doesn't support this attempt state. Launch isn't available.",
  "Ожидает проверки": "Awaiting review",
  "Успешно завершён": "Succeeded",
  "У исполнителя нет providerId. Запуск недоступен.": "The executor has no providerId. Launch isn't available.",
  "Запуск доступен из бэклога или очереди, не из текущего статуса.":
    "Launch is available from the backlog or the queue, not from the current status.",
  "Нет положительной ревизии задачи — prepareLaunch не вызываем.":
    "No positive job revision — not calling prepareLaunch.",
  "Нет серверного id задачи — запуск не вызываем.": "No server id for the job — not calling launch.",
  "Сначала сохраните проект.": "Save the project first.",
  "Сначала назначьте исполнителя.": "Assign an executor first.",

  // live-runs.ts LIVE_RUNS_COPY
  "Загружаем запуски": "Loading launches",
  "Собираем попытки по текущим задачам.": "Gathering attempts for the current jobs.",
  "Запуски": "Launches",
  "Попытки по текущим задачам. Успех по статусу thread не ставится.":
    "Attempts for the current jobs. Success isn't inferred from thread status.",
  "Запусков нет": "No launches",
  "По выбранным задачам ещё нет попыток.": "The selected jobs have no attempts yet.",
  "Запуски недоступны": "Launches unavailable",
  "Список попыток сейчас нельзя получить. Записи не показываем.":
    "The attempt list can't be fetched right now. We're not showing rows.",
  "Не удалось загрузить запуски": "Couldn't load launches",
  "Это ошибка загрузки, а не пустой список.": "This is a load error, not an empty list.",
  "Загружаем запуск": "Loading the launch",
  "Читаем квитанцию и попытку.": "Reading the receipt and the attempt.",
  "Запуск не найден": "Launch not found",
  "Откройте запуск из задачи или вернитесь к списку.": "Open the launch from the job, or go back to the list.",
  "Не удалось открыть запуск": "Couldn't open the launch",
  "Повторите открытие или вернитесь к списку.": "Try opening it again, or go back to the list.",
  "Запуск недоступен": "Launch unavailable",
  "Карточка запуска сейчас не читается.": "The launch card can't be read right now.",
  "Квитанция запуска": "Launch receipt",
  "Это квитанция, не попытка. Номер и ревизия попытки здесь не подставляются.":
    "This is a receipt, not an attempt. The attempt number and revision aren't filled in here.",

  // persist.ts (newRequestId / failureNotice / DOMAIN_NOTICE / literal messages)
  "Заполните «Что нужно сделать» и «Критерии приёмки»: без них сотрудник не поймёт задачу, а вы не сможете её принять.":
    "Fill in “What needs doing” and “Acceptance criteria”: without them the employee won't understand the job, and you won't be able to accept it.",
  "Сначала назначьте исполнителя из состава этого отдела.": "Assign an executor from this department's roster first.",
  "Исполнитель должен состоять в выбранном отделе. Выберите сотрудника из состава отдела.":
    "The executor must belong to the selected department. Choose an employee from the department's roster.",
  "У задачи есть подзадачи в этом проекте. Перенос в другой проект пока недоступен — файлы и связи не мигрируются.":
    "The job has subtasks in this project. Moving it to another project isn't available yet — files and links don't migrate.",
  "У задачи есть зависимости в этом проекте. Перенос в другой проект пока недоступен.":
    "The job has dependencies in this project. Moving it to another project isn't available yet.",
  "У задачи есть файлы в текущем корне проекта. Перенос не копирует файлы молча.":
    "The job has files in the current project root. Moving it doesn't silently copy files.",
  "Задача в работе или привязана к запуску. Сначала завершите или отмените запуск.":
    "The job is running or tied to a launch. Finish or cancel the launch first.",
  "Подзадачу нельзя перенести в другой проект отдельно от родителя. Перенос файлов не выполняется.":
    "A subtask can't be moved to another project separately from its parent. Files aren't moved.",
  "Снять отдел с проекта пока нельзя. Отдел остаётся подключённым к этой папке.":
    "A department can't be unlinked from a project yet. The department stays connected to this folder.",
  "Проект отключён от Агентства: новые задачи, отделы и запуски в нём недоступны. Верните проект в его карточке.":
    "The project is disconnected from the Agency: new jobs, departments and launches aren't available in it. Restore the project from its card.",
  "Эта папка уже подключена к Агентству. Откройте существующий проект вместо нового подключения.":
    "This folder is already connected to the Agency. Open the existing project instead of connecting a new one.",
  "У проекта есть задачи или файлы, поэтому удалить его нельзя. Отключите проект: история сохранится.":
    "The project has jobs or files, so it can't be deleted. Disconnect the project instead: history is kept.",
  "Проверяющий не может проверять работу, которую сделал сам. Назначьте другого проверяющего.":
    "A reviewer can't review work they did themselves. Assign a different reviewer.",
  "У отдела есть открытые задачи в этом проекте. Завершите или перенесите их, затем меняйте доступ.":
    "The department has open jobs in this project. Finish or move them, then change access.",
  "Отдел ограничен выбранными проектами и не подключён к этому. Подключите его в карточке проекта.":
    "The department is limited to selected projects and isn't connected to this one. Connect it from the project card.",
  "Процесс или текст задачи изменились. Обновите карточку и ответьте на текущий запрос.":
    "The process or the job text changed. Refresh the card and answer the current request.",
  "Снимок запуска устарел. Ответ с этим digest не принимается.":
    "The launch snapshot is stale. An answer with this digest isn't accepted.",
  "Этот ответ уже привязан к другому запросу или wait. Старый request новый цикл не закрывает.":
    "This answer is already tied to a different request or wait. The old request doesn't close the new cycle.",
  "Проверяющий и наблюдатель должны состоять в отделе этой задачи.":
    "The reviewer and the watcher must belong to this job's department.",
  "Сейчас это действие недоступно.": "This action isn't available right now.",
  "Нет ревизии черновика.": "No draft revision.",
  "Задача не найдена на сервере.": "Job not found on the server.",
  "Укажите проект и отдел из каталога. Первый в списке не подставляется.":
    "Pick a project and a department from the catalog. The first item on the list isn't assumed.",
  "Отдел не привязан к этому проекту.": "The department isn't linked to this project.",
  "Сотрудник не найден на сервере.": "Employee not found on the server.",
  "Нет политики для версии профиля.": "No policy for the profile version.",
  "Выберите модель сотрудника.": "Choose the employee's model.",
  "Отдел не найден на сервере.": "Department not found on the server.",
  "Привязка проекта не найдена на сервере.": "Project binding not found on the server.",
  "Хеш открытого файла не совпал с записью версии.": "The opened file's hash didn't match the version record.",
  "Руководитель отдела должен быть выбран из каталога по идентификатору.":
    "The department lead must be chosen from the catalog by id.",
  "В составе отдела есть неизвестный сотрудник. Имя не подставляется.":
    "The department's roster has an unknown employee. A name isn't assumed.",
  "К проекту подключён неизвестный отдел. Название не подставляется.":
    "An unknown department is connected to the project. A name isn't assumed.",

  // envelope.ts / rpc-agency-api.ts / use-workspace.ts (transport & workspace-load errors)
  "Пустой ответ сервера.": "Empty server response.",
  "Сервер вернул ответ без ok/value и без error — исход вызова неизвестен, не успех.":
    "The server returned a response without ok/value and without error — the call's outcome is unknown, not a success.",
  "Запись уже изменена (ревизия {actual}, ожидали {expected}). Загрузите серверную версию или повторите правку.":
    "The record already changed (revision {actual}, expected {expected}). Load the server version or redo the edit.",
  "Не удалось сохранить.": "Couldn't save.",
  "Сервер вернул снимок в неизвестном формате.": "The server returned the snapshot in an unknown format.",
  "RPC этапа 1 ещё не зарегистрирован. Каталоги пусты, пока не включён демонстрационный режим.":
    "The Stage 1 RPC isn't registered yet. Catalogs are empty until demo mode is turned on.",
  "Не удалось загрузить данные.": "Couldn't load the data.",
  "prepareLaunch вернул неизвестный формат.": "prepareLaunch returned an unknown format.",
  "getLaunch вернул неизвестный формат.": "getLaunch returned an unknown format.",
  "reconcileLaunch вернул неизвестный формат.": "reconcileLaunch returned an unknown format.",
  "interpretWorkerCompletion вернул неизвестный формат.": "interpretWorkerCompletion returned an unknown format.",
  "listJobAttempts вернул неизвестный формат.": "listJobAttempts returned an unknown format.",
  "answerNeedsInput вернул неизвестный формат.": "answerNeedsInput returned an unknown format.",
  "getIsolationReadiness вернул неизвестный формат.": "getIsolationReadiness returned an unknown format.",
  "listDashboardUsage вернул неизвестный формат.": "listDashboardUsage returned an unknown format.",
  "saveEventDefinition вернул неизвестный формат.": "saveEventDefinition returned an unknown format.",
  "saveEventSource вернул неизвестный формат.": "saveEventSource returned an unknown format.",
  "saveRuleVersion вернул неизвестный формат.": "saveRuleVersion returned an unknown format.",
  "ingestInboxEvent вернул неизвестный формат.": "ingestInboxEvent returned an unknown format.",
  "dispatchTick вернул неизвестный формат.": "dispatchTick returned an unknown format.",
  "listActionIntents вернул неизвестный формат.": "listActionIntents returned an unknown format.",
  "listEventDefinitions вернул неизвестный формат.": "listEventDefinitions returned an unknown format.",
  "listEventSources вернул неизвестный формат.": "listEventSources returned an unknown format.",
  "listRuleVersions вернул неизвестный формат.": "listRuleVersions returned an unknown format.",
  "claimActionIntent вернул неизвестный формат.": "claimActionIntent returned an unknown format.",
  "approveActionIntent вернул неизвестный формат.": "approveActionIntent returned an unknown format.",
  "Не удалось обновить снимок. Предыдущие данные оставлены.": "Couldn't refresh the snapshot. The previous data was kept.",
  "Не удалось обновить снимок.": "Couldn't refresh the snapshot.",
  "Запись недоступна: сервер не отдал рабочий снимок.": "Recording isn't available: the server hasn't returned a workspace snapshot.",
  "Укажите проект и отдел этой задачи. Первый проект или папка чата не подставляются.":
    "Pick this job's project and department. The first project or the chat's folder isn't assumed.",

  // document-restore.ts / document-save.ts / native-preview.ts
  "Цель превью не совпала с открытой версией.": "The preview target didn't match the opened version.",
  "Этот файл не является документом агентства. Откройте его из задачи.":
    "This file isn't an Agency document. Open it from the job.",
  "Не удалось восстановить документ. Откройте его снова из задачи.":
    "Couldn't restore the document. Open it again from the job.",
  "Не удалось сохранить файл.": "Couldn't save the file.",
  "Это демо-копия. Реальный файл так не открывается.": "This is a demo copy. The real file doesn't open this way.",
  "Не удалось открыть документ в панели BB.": "Couldn't open the document in the BB panel.",

  // product-reasons.ts
  "Политика прав сотрудника не разрешает выбранный CLI. Выберите политику, которая разрешает этот CLI или любой CLI.":
    "The employee's permission policy doesn't allow the chosen CLI. Pick a policy that allows this CLI or any CLI.",
  "Выбранный CLI не подключён в BB на машине проекта. Подключите его в настройках BB или выберите сотруднику другой CLI.":
    "The chosen CLI isn't connected in BB on the project's machine. Connect it in BB settings or give the employee another CLI.",
  "Сейчас запуск недоступен.": "Launch isn't available right now.",
  "Готово к запуску": "Ready to launch",
  "Запуск начат": "Launch started",
  "Запуск отклонён.": "Launch refused.",
  "Файл опубликован; результат ожидает приёмки": "File published; the result is awaiting acceptance",
  "Сотрудник приостановлен. Включите его профиль или назначьте другого исполнителя.":
    "The employee is paused. Turn their profile back on, or assign a different executor.",
  "Исполнитель не может быть проверяющим своей же задачи. Назначьте проверяющим другого сотрудника.":
    "An executor can't review their own job. Assign a different employee as reviewer.",
  "Тред сотрудника ещё работает. Сначала остановите запуск в карточке задачи.":
    "The employee's thread is still running. Stop the launch from the job card first.",
  "У сотрудника есть открытые задачи в этом отделе. Переназначьте или закройте их, затем меняйте состав.":
    "The employee has open jobs in this department. Reassign or close them before changing membership.",
  "У задачи нет треда, который ждёт проверки. Поставьте задачу в очередь и запустите заново.":
    "The job has no thread waiting for review. Queue the job and launch it again.",
  "У задачи нет опубликованной версии результата, возвращать нечего.":
    "The job has no published result version — there's nothing to send back.",
  "Не удалось отправить замечания исполнителю. Задача осталась на проверке, попробуйте ещё раз.":
    "Couldn't send the notes to the executor. The job stays in review — try again.",
  "Не удалось подтвердить, что замечания дошли. Нажмите «Вернуть на доработку» ещё раз — повтор не продублирует сообщение.":
    "Couldn't confirm the notes arrived. Click “Send back for rework” again — repeating it won't duplicate the message.",
  "Для этого шага не хватает условий: исполнитель, проект, бриф и критерии приёмки, а для проверки — опубликованная версия.":
    "This step is missing requirements: an executor, a project, a brief and acceptance criteria, and for review, a published version.",
  "Задача зависит от незавершённых задач. Сначала закройте их.": "The job depends on unfinished jobs. Close them first.",
  "Права проекта и сотрудника не пересекаются: у них нет общего разрешения. Проверьте политику сотрудника и проекта.":
    "The project's and the employee's rights don't overlap: they share no permission. Check the employee's and the project's policy.",
  "Политика проекта или сотрудника не разрешает CLI сотрудника. В карточке проекта нажмите «Разрешить любой CLI» или сохраните профиль сотрудника с этим CLI ещё раз.":
    "The project's or the employee's policy doesn't allow the employee's CLI. Press «Allow any CLI» in the project card or save the employee's profile with this CLI again.",
  "Политика сотрудника не разрешает машину этого проекта. Проверьте политику.":
    "The employee's policy doesn't allow this project's machine. Check the policy.",
  "Навык сотрудника не найден на машине проекта. Уберите его из профиля или установите навык на этой машине.":
    "The employee's skill wasn't found on the project's machine. Remove it from the profile, or install the skill on this machine.",
  "MCP из профиля сотрудника пока не передаются в запуск. Уберите MCP из профиля.":
    "MCPs from the employee's profile aren't passed to the launch yet. Remove the MCP from the profile.",
  "Машина проекта не входит в настройки навыков Агентства. Добавьте её в «Настройки плагина → Isolated catalog roles».":
    "The project's machine isn't in the Agency's skill settings. Add it under “Plugin settings → Isolated catalog roles”.",
  "Навык Агентства на сервере изменился, а закреплённый хэш старый. Обновите хэш навыка в настройках плагина.":
    "The Agency skill changed on the server, and the pinned hash is old. Update the skill hash in the plugin settings.",
  "На машине проекта не найден навык Агентства. Проверьте, что плагин установлен и навыки видны в BB.":
    "The Agency skill wasn't found on the project's machine. Check that the plugin is installed and the skills are visible in BB.",
  "В папке проекта нет файла правил .bb/AGENTS.md. Создайте его во вкладке «Правила» проекта.":
    "The project folder has no .bb/AGENTS.md rules file. Create it from the project's “Rules” tab.",
  "Проект отключён от Агентства: запуски в нём недоступны. Верните проект в его карточке.":
    "The project is disconnected from the Agency: launches aren't available in it. Restore the project from its card.",
  "Заполните «Что нужно сделать» и «Критерии приёмки».": "Fill in “What needs doing” and “Acceptance criteria”.",
  "Лимит кругов доработки исчерпан. Решите сами: принять с замечаниями, отменить или поднять лимит в правилах отдела.":
    "The rework round limit is used up. Decide yourself: accept with notes, cancel, or raise the limit in the department's rules.",
  "Эту настройку нельзя задать на этом уровне.": "This setting can't be set at this level.",
  "Задача закрыта: новые версии и файлы в неё не добавляются. Для доработки создайте новую задачу.":
    "The job is closed: new versions and files aren't added to it. Create a new job for further work.",
  "Запустить можно задачу из бэклога или очереди. Задачу из «Ожидает решения» сначала верните в очередь.":
    "Only a job from the backlog or the queue can be launched. Return a job from “Needs decision” to the queue first.",
  "Машина проекта не совпадает с окружением запуска. Проверьте подключение проекта.":
    "The project's machine doesn't match the launch environment. Check the project's connection.",
  "Политика прав изменилась после подготовки запуска. Запустите задачу ещё раз.":
    "The rights policy changed after the launch was prepared. Launch the job again.",
  "Профиль сотрудника или регламент отдела изменились. Запустите задачу ещё раз.":
    "The employee's profile or the department's charter changed. Launch the job again.",
  "Регламент отдела изменился после подготовки запуска. Запустите задачу ещё раз.":
    "The department's charter changed after the launch was prepared. Launch the job again.",
  "Правила проекта изменились во время подготовки запуска. Запустите задачу ещё раз.":
    "The project's rules changed while the launch was being prepared. Launch the job again.",
  "Политики проекта и сотрудника разрешают разные секреты. Проверьте политику.":
    "The project's and the employee's policies allow different secrets. Check the policy.",
  "Отдел с таким названием уже есть. Названия отделов должны различаться: по ним агенты выбирают, куда поручить работу.":
    "A department with this name already exists. Department names must be distinct: agents use them to choose where to route work.",
  "Сначала нужна принятая спецификация: создайте задачу в отделе спецификаций, дождитесь приёмки и приложите её (attach-input) или поставьте job depend.":
    "An accepted spec is required first: create a job in the spec department, wait until it is accepted, then attach it (attach-input) or set job depend.",
  "Вид работы new-program может снять только владелец.": "Only the owner can change workKind away from new-program.",

  // role-types.ts
  "Ведёт отдел: принимает поручения, раздаёт подзадачи, собирает итог. Сам не исполняет.":
    "Runs the department: takes on assignments, hands out subtasks, and puts together the result. Doesn't execute work themselves.",
  "Получает главные задачи отдела, оценивает их и разбивает на подзадачи.":
    "Receives the department's main jobs, sizes them up and splits them into subtasks.",
  "Назначает исполнителей и проверяющих, получает сообщения о ходе подзадач, собирает итоговый отчёт.":
    "Assigns executors and reviewers, gets updates on subtask progress, and puts together the final report.",
  "Руководителя назначают в карточке отдела. У отдела он ровно один.":
    "The lead is set from the department's card. A department has exactly one.",
  "Делает работу по поручению и сдаёт версию результата. Не своё — возвращает руководителю.":
    "Does the assigned work and submits a result version. Hands back anything outside their job to the lead.",
  "Разработчик, копирайтер, аналитик, дизайнер — любой, кто создаёт результат.":
    "A developer, copywriter, analyst, designer — anyone who produces the result.",
  "Сверяет поручение со своей инструкцией, работает в границах брифа, публикует отчёт и файлы версией.":
    "Checks the assignment against their own instructions, stays within the brief, and publishes the report and files as a version.",
  "Независимо проверяет чужие версии и выносит вердикт. Свою работу проверить не может.":
    "Independently reviews other people's versions and gives a verdict. Can't review their own work.",
  "QA, ревьюер кода, редактор, фактчекер, юрист на согласовании.":
    "QA, a code reviewer, an editor, a fact-checker, a lawyer signing off.",
  "Открывает опубликованную версию, проверяет по критериям, описывает дефекты. Результат не правит и не принимает.":
    "Opens the published version, checks it against the criteria, and describes defects. Doesn't edit or accept the result.",
  "Сервер не даст проверяющему получить на проверку собственную работу.":
    "The server won't let a reviewer receive their own work for review.",
  "Низкий": "Low",
  "Быстро и дёшево: рутина по чёткому брифу.": "Fast and cheap: routine work on a clear brief.",
  "Подходит для простых правок, форматирования, сбора данных по готовой схеме.":
    "Good for simple edits, formatting, and collecting data by an existing template.",
  "Средний": "Medium",
  "Баланс скорости и качества для большинства исполнителей.": "A balance of speed and quality for most executors.",
  "Типовые изменения в коде, черновики текстов, обычный анализ.":
    "Routine code changes, text drafts, regular analysis.",
  "Высокий": "High",
  "Для руководителей и проверяющих: оценка, план, поиск дефектов.":
    "For leads and reviewers: assessment, planning, finding defects.",
  "Модель дольше рассуждает перед ответом: дороже, но меньше ошибок в решениях.":
    "The model reasons longer before answering: costs more, but fewer mistakes in its decisions.",
  "Очень высокий": "Very high",
  "Сложные изменения в нескольких модулях, архитектура.": "Complex changes across several modules, architecture.",
  "Заметно дороже и медленнее. Включайте для задач с высоким риском.":
    "Noticeably more expensive and slower. Turn it on for high-risk jobs.",
  "Максимальный": "Maximum",
  "Самые трудные задачи, где цена ошибки высока.": "The hardest jobs, where mistakes are costly.",
  "Самый дорогой режим. Обычно не нужен постоянно.": "The most expensive mode. Usually not needed all the time.",
  "Например: Руководитель разработки": "e.g. Engineering lead",
  "Например: Разработчик TypeScript": "e.g. TypeScript developer",
  "Например: Проверяющий кода": "e.g. Code reviewer",
   "чтение файлов": "reading files",
  "запись файлов": "writing files",
  "ничего": "nothing",
  "любой CLI": "any CLI",
  "любая машина": "any machine",

  // runtime-unavailable.ts STAGE1_UNAVAILABLE
  "Список запусков пуст, пока сервер не отдаст попытки по этой задаче. Строки не выдумываются.":
    "The launch list is empty until the server returns attempts for this job. Rows aren't invented.",
  "Общего списка правил пока нет. Можно сохранить новое правило по имени.":
    "There's no shared rule list yet. You can save a new rule by name.",
  "Автоматизации на этом сервере ещё не подключены.": "Automations aren't connected on this server yet.",
  "Запуск откроется, когда среда подтвердит готовность.": "Launch will open once the environment confirms it's ready.",
  "Знания пока недоступны. Сервер материалы не хранит: запись не создаётся, после обновления список снова пустой.":
    "Knowledge isn't available yet. The server doesn't store materials: nothing is saved, and the list is empty again after a refresh.",
  "Расход недоступен, пока сервер не отдаст listDashboardUsage. Цифры не выдумываются.":
    "Usage isn't available until the server returns listDashboardUsage. Numbers aren't invented.",

  // usage-dashboard.ts
  "Неизвестно": "Unknown",
  "Нет строк расхода.": "No usage rows.",
  "Нет цены": "No price",
  "Цифры неполные по доступным данным.": "Numbers are incomplete for the available data.",
  "Счётчик треда сбрасывался, итог неполный.": "The thread counter reset, so the total is incomplete.",
  "За выбранный период данных нет.": "No data for the selected period.",
  "Только дни, которые удалось восстановить.": "Only the days that could be recovered.",
  "Кэш отдельно от входных токенов.": "Cache is separate from input tokens.",
  "В примере нет серверного расхода. Цифры не показываем.": "The example has no server usage. We don't show numbers.",
  "Всего по доступным данным": "Total from available data",
  "За выбранный период": "For the selected period",
  "Не удалось загрузить расход.": "Couldn't load usage.",
  "Оценка по ценам API без записи в кеш. На подписке это не счёт, а эквивалент.":
    "Estimated at API list prices, ignoring cache. On a subscription this is an equivalent, not a bill.",
  "Не менее {compact} млн": "At least {compact}M",
  "Не менее {total}": "At least {total}",
  "{cost}, не все модели с ценой": "{cost}, not all models are priced",
  "{known} известно · {unknown} неизвестно": "{known} known · {unknown} unknown",
  "{known} · {epoch} эпох": "{known} · {epoch} epochs",
  "{jobs} задач · {attempts} попыток · {threads} тредов": "{jobs} jobs · {attempts} attempts · {threads} threads",
  "Без треда: {count}": "Without a thread: {count}",

  // snapshot.ts
  "RPC ещё не ответил.": "The RPC hasn't answered yet.",

  // capability-catalog.ts
  "в каталоге": "in the catalog",
  "нет в каталоге": "not in the catalog",

  // intake.ts / persist-create.ts
  "размер {size}": "size {size}",
  "отключена, верните её в «Проекты»": "disconnected, restore it under “Projects”",
  "риск низкий": "low risk",
  "риск средний": "medium risk",
  "риск высокий": "high risk",
  "принято": "accepted",
  "разбить на подзадачи": "split into subtasks",
  "нужны уточнения": "needs clarification",
  "возврат": "returned",
  "Стандартные права проекта: чтение и запись файлов в этой папке, запуск только на машине этой папки.":
    "Standard project rights: read and write files in this folder, launch only on this folder's machine.",
  "Стандартные права сотрудника: чтение и запись файлов проекта, запуск через CLI из его профиля на машине проекта.":
    "Standard employee rights: read and write the project's files, launch through the CLI in their profile on the project's machine.",

  // envelope.ts
  "Сервер отклонил вызов: неизвестный вызывающий. Это ошибка доступа, не пустой каталог.":
    "The server refused the call: unknown caller. This is an access error, not an empty catalog.",

  // view-models.ts mapActivity role labels
  "Участник": "Participant",
};

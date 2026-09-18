/** English UI texts, keyed by the exact Russian source text. Group: settings. */
export const EN_SETTINGS: Record<string, string> = {
  // system.tsx — Settings page
  "Настройки": "Settings",
  "Правила работы Агентства, язык, машины, подключения и восстановление.": "The Agency's work rules, language, machines, connections and recovery.",
  "Сохранить пример": "Save example",
  "Общие настройки изменены только в макете.": "General settings only change in the mockup.",
  "Правила работы": "Work rules",
  "Общие правила": "General rules",
  "Шаблоны": "Templates",
  "Язык": "Language",
  "Машины": "Machines",
  "Подключения": "Connections",
  "Хранение": "Storage",
  "Диагностика": "Diagnostics",
  "Общие": "General",
  "Общие правила для всех отделов. Отдел может задать своё значение в своих настройках, сотрудник — свои лимиты в профиле.": "Shared rules for all departments. A department can set its own value in its settings; an employee sets their own limits in their profile.",
  "Работа агентства": "Agency operation",
  "Общий лимит параллельных задач": "Overall concurrent job limit",
  "Часовой пояс агентства": "Agency time zone",
  "Приостановить новые назначения": "Pause new assignments",
  "Приостановить назначения": "Pause assignments",
  "Пилот: этот раздел пока пример интерфейса и не работает с данными Агентства.": "Pilot: this section is still an interface example and doesn't work with Agency data yet.",
  "История и резервирование": "History and backup",
  "Срок хранения подробных журналов, дней": "Detailed log retention, days",
  "Экспорт конфигурации": "Export configuration",
  "Экспорт будет включать профили и правила без секретов. В прототипе файл не создаётся.": "The export will include profiles and rules without secrets. The prototype doesn't create a file.",
  "Импорт конфигурации": "Import configuration",
  "Импорт будет показывать изменения до применения; автоматизации выключены по умолчанию.": "The import will show changes before applying them; automations are off by default.",
  "Состояние данных": "Data status",
  "Задачи и команда": "Jobs and team",
  "RPC этапа 1, если метод зарегистрирован": "Stage 1 RPC, if the method is registered",
  "Выбор CLI и модели": "CLI and model choice",
  "Штатный каталог BB": "BB's built-in catalog",
  "Исполнение": "Execution",
  "Недоступно до AGY-16": "Unavailable until AGY-16",
  "События и cron": "Events and cron",
  "Ещё не подключены": "Not connected yet",
  "Сбросить черновики": "Reset drafts",

  // work-rules.tsx — rule groups
  "Доработка и проверка": "Rework and review",
  "Кругов доработки под одной задачей": "Rework rounds per job",
  "Сколько раз руководитель может отправить работу на доработку после проверки. Дальше сервер не даст завести новый круг: решение за владельцем.": "How many times the lead can send work back for rework after review. After that the server won't allow another round — the decision is up to the owner.",
  "Возврат с замечанием из карточки тоже считается кругом.": "Returning it with a note from the job card counts as a round too.",
  "Проверка создаётся автоматически": "Review is created automatically",
  "Включено — когда исполнитель сдаёт работу, Агентство само создаёт подзадачу проверки на свободного проверяющего отдела, прикладывает сданную версию и ставит проверку в очередь запуска.": "On — when the executor delivers work, the Agency creates a review subtask for a free reviewer in the department, attaches the delivered version and queues the review for launch.",
  "Руководитель не тратит ход на назначение проверки, но решение по заключению остаётся за ним.": "The lead doesn't spend a turn assigning the review, but the decision on its findings is still theirs.",
  "Мелкие дефекты без нового круга": "Minor defects without a new round",
  "Включено — замечания уровня «мелочь» перечисляются в итоговом отчёте, работа принимается без доработки.": "On — “minor” notes are listed in the final report and the work is accepted without rework.",
  "Выключено — любой открытый дефект уходит в доработку. Строже, но дороже: в первом прогоне круги по мелочам стоили треть задачи.": "Off — any open defect goes back for rework. Stricter but costlier: in the first run, rounds over minor issues cost a third of the job.",
  "Память отдела": "Department memory",
  "После приёмки главной задачи Агентство собирает урок из её фактов: сколько было кругов доработки, из-за чего возвращали, сколько заняло. Урок приходит строкой в каждый запуск отдела, полный текст сотрудник берёт сам.": "After a main job is accepted, the Agency collects a lesson from its facts: how many rework rounds there were, what the work was returned for, how long it took. The lesson reaches every launch of the department as one index line; the employee fetches the full text themselves.",
  "Отдел учится сам": "The department learns on its own",
  "Включено — урок принимается сразу, вы получаете сообщение и можете поправить его или убрать в «Знаниях». Так отдел копит опыт без вашего хода.": "On — the lesson is accepted right away, you get a message and can edit or remove it in “Knowledge”. This way the department builds experience without a turn from you.",
  "Выключено — урок ждёт вашего решения предложением. Строже, но каждый раз требует внимания.": "Off — the lesson waits for your decision as a proposal. Stricter, but it needs your attention every time.",
  "Принять или убрать запись отдела может и его руководитель; знания проекта и всего Агентства остаются за владельцем.": "The department lead can accept or remove a department record too; project and agency-wide knowledge stays with the owner.",
  "Записей в памяти отдела": "Records in the department's memory",
  "Сколько принятых записей отдел держит в работе. Сверх этого числа самые старые и наименее важные уходят в архив — индекс в запуске не растёт бесконечно.": "How many accepted records the department keeps in use. Beyond that, the oldest and least important ones go to the archive — the index in a launch doesn't grow forever.",
  "Закреплённая запись не вытесняется никогда.": "A pinned record is never pushed out.",
  "Срок жизни урока": "Lesson lifetime",
  "Через этот срок урок, который написало Агентство, уходит в архив: память не копит правила, которые никто не подтвердил.": "After this time a lesson written by the Agency goes to the archive: the memory doesn't hoard rules nobody confirmed.",
  "Закреплённый урок и запись, написанная вами, живут без срока.": "A pinned lesson and a record you wrote yourself live without an expiry.",
  "Наблюдение за запуском": "Launch monitoring",
  "Когда Агентство считает запуск зависшим. Признаки работы: обновление треда, расход токенов, запись в истории задачи. Задача уходит в «Ожидает решения», руководитель получает сообщение.": "When the Agency treats a launch as stalled. Signs of activity: a thread update, token spend, an entry in the job history. The job moves to “Needs decision” and the lead gets a message.",
  "Предупредить о тишине через": "Warn about silence after",
  "Тред активен, но событий нет: в задаче появится системный комментарий.": "The thread is active but there are no events: a system comment appears on the job.",
  "Считать зависшим через": "Treat as stalled after",
  "Сколько минут без событий до перевода задачи в «Ожидает решения».": "How many minutes without events before the job moves to “Needs decision”.",
  "Не запустился через": "Didn't start after",
  "Тред так и не начал работу: машина не в сети или CLI не авторизован.": "The thread never started working: the machine is offline or the CLI isn't authorized.",
  "Ошибка провайдера дольше": "Provider error longer than",
  "Сколько терпеть ошибку треда: у повторов провайдера и лимитов подписки есть время восстановиться.": "How long to tolerate a thread error: provider retries and subscription limits need time to recover.",
  "Потолок одной попытки": "Ceiling for one attempt",
  "Непрерывная работа дольше этого срока — задача останавливается на решение: возможно, сотрудник зациклился или работу надо делить.": "Continuous work past this time stops the job for a decision: the employee may be stuck in a loop, or the work needs splitting.",
  "Сдача и сроки": "Delivery and deadlines",
  "Напоминаний о несданной работе": "Reminders about undelivered work",
  "Сотрудник закончил ход без опубликованной версии — Агентство напоминает, как сдать работу. После этого числа напоминаний задача уходит руководителю.": "The employee ended a turn without a published version — the Agency reminds them how to deliver work. After this many reminders, the job goes to the lead.",
  "0 — сразу к руководителю.": "0 — straight to the lead.",
  "Напомнить о сроке за": "Remind about the deadline",
  "За сколько часов до срока задача подсвечивается и получает напоминание. 0 — не напоминать.": "How many hours before the deadline the job is highlighted and gets a reminder. 0 — don't remind.",
  "Бюджет и параллельность": "Budget and concurrency",
  "Лимиты {scope}. Они действуют вместе с лимитами других уровней: сработает самый строгий.": "Limits for {scope}. They apply together with limits from other levels — the strictest one wins.",
  "всего Агентства": "the whole Agency",
  "Бюджет в месяц": "Monthly budget",
  "Оценка расхода по ценам API за календарный месяц. Пусто — без бюджета.": "An estimate of spend at API prices for the calendar month. Empty — no budget.",
  "При достижении порога предупреждения запуск показывает предупреждение, при 100% новые запуски останавливаются.": "When the warning threshold is reached, a launch shows a warning; at 100% new launches stop.",
  "Предупреждать с": "Warn from",
  "Доля бюджета, после которой Агентство предупреждает о расходе.": "The share of the budget after which the Agency warns about spend.",
  "Одновременных запусков": "Concurrent launches",
  "Сколько попыток может работать одновременно. Пусто — без ограничения. Запуск сверх лимита откладывается с объяснением.": "How many attempts can run at the same time. Empty — no limit. A launch past the limit is deferred with an explanation.",
  "Новые сотрудники по умолчанию": "New employee defaults",
  "CLI, модель, уровень рассуждения и быстрый режим, которые подставляются в форму «Создать сотрудника» и в стартовые отделы для каждого типа роли. Подходит любой CLI, подключённый в BB. В форме всё можно поменять.": "The CLI, model, reasoning level and fast mode pre-filled in the “Create employee” form and in starter departments for each role type. Any CLI connected in BB fits. Everything can be changed in the form.",
  "быстрый режим": "fast mode",
  "Проверка работы сотрудника": "Review of this employee's work",
  "По умолчанию действует правило отдела. Выключите, если этот сотрудник собирает материал для коллеги: проверять там нечего, а проверка отдела стоит денег.": "The department rule applies by default. Switch it off when this employee collects material for a colleague: there is nothing to review, and a department review costs money.",
  "Включено — когда этот сотрудник сдаёт работу, Агентство само создаёт подзадачу проверки на свободного проверяющего отдела.": "On — when this employee hands in work, the Agency creates a review subtask for a free reviewer of the department by itself.",
  "Выключено — его работу принимает тот, кто её поручил: руководитель или владелец.": "Off — their work is accepted by whoever gave it to them: the lead or the owner.",
  "Руководитель": "Lead",
  "Руководитель планирует, раздаёт работу и принимает решения: сильная модель и высокий уровень рассуждения окупаются.": "The lead plans, hands out work and makes decisions: a strong model and a high reasoning level pay off.",
  "Исполнитель": "Executor",
  "Для типовой работы хватает более быстрой и дешёвой модели и среднего уровня рассуждения.": "Routine work is fine with a faster, cheaper model and a medium reasoning level.",
  "Проверяющий": "Reviewer",
  "Поиск дефектов требует внимательности: сильная модель и высокий уровень рассуждения.": "Finding defects takes attention to detail: a strong model and a high reasoning level.",

  // work-rules.tsx — units, source labels and editor chrome
  "мин": "min",
  "ч": "hr",
  "дн": "d",
  "не задано": "Not set",
  "да": "Yes",
  "нет": "No",
  "рассуждение": "reasoning",
  "по умолчанию": "Default",
  "общее для Агентства": "Agency-wide",
  "задано в отделе": "Set at department level",
  "задано у сотрудника": "Set on the employee",
  "Правила сохранены. Новые запуски и проверки работают по ним.": "Rules saved. New launches and reviews follow them.",
  "Загружаем правила…": "Loading rules…",
  "в этом месяце: ${amount} ({percent}%)": "this month: ${amount} ({percent}%)",
  "лимит этого уровня": "Limit set at this level",
  "без лимита на этом уровне": "No limit at this level",
  "своё значение": "Custom value",
  "Как в Агентстве ({value})": "Same as Agency ({value})",
  "Да": "Yes",
  "Нет": "No",
  "{label}: своё значение": "{label}: own value",
  "своё": "own",
  "Сбросить": "Reset",
  "Сохраняем…": "Saving…",
  "Есть несохранённые изменения.": "Unsaved changes.",

  // templates-settings.tsx
  "Регламент отдела": "Department charter",
  "Подставляется в форму «Создать отдел» и кнопку «Вставить шаблон регламента».": "Filled into the “Create department” form and the “Insert charter template” button.",
  "Раздел «## Принимаем» обязателен: по нему агенты в чатах выбирают отдел.": "The “## We accept” section is required: agents use it in chats to pick a department.",
  "Должностная инструкция руководителя": "Lead job description",
  "Стартовый текст инструкции для сотрудника с типом роли «Руководитель».": "Starting text of the job description for an employee with the “Lead” role type.",
  "Должностная инструкция исполнителя": "Executor job description",
  "Стартовый текст для «Исполнителя»: пул работ, что не входит в него, входы, результат, самопроверка.": "Starting text for the “Executor”: the pool of work, what's out of scope, inputs, result, self-check.",
  "Должностная инструкция проверяющего": "Reviewer job description",
  "Стартовый текст для «Проверяющего»: как проверять и чего не делать.": "Starting text for the “Reviewer”: how to review and what not to do.",
  "Бриф задачи": "Job brief",
  "Подсказка и кнопка «Вставить шаблон» в поле «Что нужно сделать» у новой задачи и подзадачи.": "Hint and “Insert template” button in the “What needs to be done” field of a new job and subtask.",
  "Критерии приёмки": "Acceptance criteria",
  "Подсказка и кнопка «Вставить шаблон» в поле «Критерии приёмки».": "Hint and “Insert template” button in the “Acceptance criteria” field.",
  "Загружаем шаблоны…": "Loading templates…",
  "С чего начинаются формы. Изменение шаблона не трогает уже созданные отделы, сотрудников и задачи.": "What forms start with. Changing a template doesn't touch departments, employees or jobs already created.",
  "свой текст": "Custom text",
  "стандартный": "Standard",
  "Сохранить шаблон": "Save template",
  "Вернуть стандартный": "Reset to standard",
  "Шаблон «{title}» возвращён к стандартному.": "Template “{title}” reset to the default.",
  "Шаблон «{title}» сохранён.": "Template “{title}” saved.",
  "Загружаем общие правила…": "Loading the shared rules…",
  "Общие правила Агентства": "Agency-wide rules",
  "Верхний слой промпта каждого запуска: действует для всех отделов и сотрудников, регламенты и инструкции его не отменяют.": "The top layer of every launch's prompt: it applies to all departments and employees; charters and job descriptions don't override it.",
  "Каждое сохранение — новая версия. Подготовленный, но ещё не начатый запуск по старой версии сервер отклонит — подготовьте его заново.": "Each save is a new version. The server will reject a prepared but not-yet-started launch on an old version — prepare it again.",
  "Действует версия {version} от {date}.": "Version {version} from {date} is active.",
  "Общих правил нет: сотрудники работают по регламенту отдела и своей инструкции.": "There are no shared rules: employees work by their department's charter and their own job description.",
  "Текст правил": "Rules text",
  "Например:\n- Отчёты и комментарии — по-русски, без воды.\n- Секреты и токены не печатать в комментариях и отчётах.\n- Внешние сервисы менять только по прямому разрешению владельца.": "For example:\n- Reports and comments — in Russian, no fluff.\n- Don't print secrets or tokens in comments or reports.\n- Change external services only with the owner's direct permission.",
  "Общие правила сохранены: версия {version}.": "Shared rules saved: version {version}.",
  "Общие правила выключены.": "Shared rules turned off.",
  "Сохранить новую версию": "Save new version",
  "Выключить общие правила": "Turn off shared rules",
  "История версий": "Version history",
  "Версия {version}": "Version {version}",
  "Версия {version} · действует": "Version {version} · active",
  "Пустая версия: правила выключены.": "Empty version: rules are off.",

  // agency-language.tsx
  "Язык · Language": "Language",
  "Язык Агентства": "Agency language",
  "Русский": "Russian",
  "Сотрудники пишут отчёты, комментарии и вопросы на русском.": "Employees write reports, comments and questions in Russian.",
  "Системные сообщения агентам — напоминания, предупреждения о зависании, возврат на доработку — тоже на русском.": "System messages to agents — reminders, stall warnings, rework requests — are in Russian too.",
  "Язык, на котором сотрудники пишут отчёты, комментарии и вопросы владельцу, и язык системных сообщений, которые Агентство отправляет агентам.": "The language employees use for reports, comments and questions to the owner, and the language of system messages the Agency sends to agents.",
  "Действует на следующие ходы и запуски. Интерфейс Агентства переключается сразу.": "Applies to the next turns and launches. The Agency interface switches immediately.",
  "Не удалось сохранить язык. Попробуйте ещё раз.": "Couldn't save the language. Try again.",
  "Эскалировать в вышестоящий отдел через": "Escalate to the parent department after",
  "Главная задача отдела ждёт решения дольше этого срока — она эскалируется в отдел, которому подчиняется этот: пометка на доске и комментарий в истории.": "When a main job of the department waits for a decision longer than this, it is escalated to the department this one reports to: a mark on the board and a comment in the history.",
  "Работает только у подчинённых отделов. 0 — не эскалировать.": "Applies only to departments that report to another. 0 turns escalation off.",
  // work-rules.tsx: nightly recheck
  "Перепроверять принятое за день": "Recheck what was accepted each day",
  "Включено — раз в сутки Агентство собирает версии отдела, принятые после прошлой перепроверки, и ставит проверяющему задачу перепроверить их: по одной на папку проекта, до 20 версий за ночь.":
    "On — once a day the Agency collects the department's versions accepted since the previous recheck and gives a reviewer a job to recheck them: one per project folder, up to 20 versions a night.",
  "Приёмка остаётся в силе. Найденные дефекты попадают в отчёт перепроверки, решение за владельцем. Без проверяющих в отделе задачу получает руководитель.":
    "The acceptance stays. Defects found go into the recheck report and the owner decides. A department without reviewers gives the job to its lead.",
  "Час перепроверки": "Recheck hour",
  "Час по часам машины BB, с которого запускается перепроверка этих суток. 3 — в три часа ночи.": "Hour on the BB machine's clock from which the day's recheck starts. 3 means 3 a.m.",
  // model-prices.tsx — the price table
  "Цены моделей": "Model prices",
  "USD за миллион токенов. По этой таблице дашборд переводит токены в деньги: это оценка по ценам API, а не счёт подписки.":
    "USD per million tokens. The dashboard turns tokens into money with this table: an estimate at API list prices, not a subscription bill.",
  "Прежнее значение настройки прочитать не удалось, работают встроенные цены: {error}":
    "The stored setting could not be read, built-in prices are in use: {error}",
  "Вход": "Input",
  "Ответ": "Output",
  "Токены запроса без кэша": "Request tokens without cache",
  "Чтение из кэша запроса": "Reads from the request cache",
  "Токены ответа, включая рассуждения": "Response tokens, reasoning included",
  "Строка": "Row",
  "в работе": "in use",
  "Добавить модель": "Add a model",
  "Сотрудники работают на этих моделях, а цены у них нет:": "Employees run these models and they have no price:",
  "Сохранить цены": "Save prices",
  "Вернуть как было": "Undo changes",
  "Вернуть цену": "Reset price",
  "Встроенные цены проверены {date}. Источник: {source}": "Built-in prices checked on {date}. Source: {source}",
  "Цены сохранены. Дашборд пересчитает стоимость при следующем обновлении.": "Prices saved. The dashboard recounts cost on its next refresh.",
  "Не удалось сохранить цены. Попробуйте ещё раз.": "Could not save the prices. Try again.",
  "Не удалось загрузить цены.": "Could not load the prices.",
  "Загружаем цены…": "Loading prices…",
  "Укажите название модели.": "Name the model.",
  "Модель уже есть в таблице.": "The model is already in the table.",
  "Цена должна быть числом от 0.": "A price must be a number from 0 up.",
  // agent-models.tsx — employees against the models this BB runs
  "Модели сотрудников": "Employee models",
  "Сверка профилей с тем, что подключено в этом BB. Модель, которой здесь нет, запуск не начинает: сотрудника видно тут, а причина — в готовности задачи.":
    "Profiles checked against what this BB has connected. A model that is missing here does not start a launch: the employee shows up here and the job's readiness says why.",
  "BB не отдал список моделей: сверять не с чем, запуски ничем не ограничены.": "BB returned no model list: there is nothing to check against and no launch is held back.",
  "Все сотрудники стоят на подключённых моделях.": "Every employee stands on a connected model.",
  "Замена": "Substitute",
  "Перевести на доступные модели": "Move to available models",
  "Переведено сотрудников: {count}. У каждого новая версия профиля.": "Employees moved: {count}. Each has a new profile version.",
  "Переводить некого.": "Nobody to move.",
  "Не удалось перевести сотрудников на доступные модели.": "Could not move the employees to available models.",
  "Не удалось прочитать модели сотрудников.": "Could not read the employees' models.",
  "Проверяем модели сотрудников…": "Checking the employees' models…",
  "Модель подключена": "Model connected",
  "Есть замена": "Substitute available",
  "Нет модели": "No model",
  "Без изменений": "Unchanged",
  "Переведён": "Moved",
  "Не удалось": "Failed",
  "Сейчас": "Now",
  "Должностная инструкция помощника": "Assistant job description",
  "Подставляется, когда сотрудника добавляют в отдел помощником.": "Used when an employee joins a department as an assistant.",
  "Помощник готовит материал для сотрудника: читает, ищет, собирает. Решения принимает тот, кому он помогает.":
    "An assistant prepares material for an employee: reads, searches, collects. The decisions belong to the one they help.",
  // templates-settings.tsx — base role instructions
  "Базовая инструкция руководителя": "Base lead instruction",
  "Базовая инструкция исполнителя": "Base executor instruction",
  "Базовая инструкция проверяющего": "Base reviewer instruction",
  "Базовая инструкция помощника": "Base assistant instruction",
  "Общий порядок работы: как принять поручение, оценить, разбить, назначить, проверить и собрать итог.":
    "The common order of work: how to take a job, judge it, split it, assign it, check it and assemble the result.",
  "Доходит до каждого запуска руководителя отдельным слоем — копировать его в должностные инструкции не нужно.":
    "Reaches every lead launch as its own layer — there is no need to copy it into job descriptions.",
  "Общий порядок: сверить с собой, проверить входы, найти навык, сделать, проверить себя, сдать версией.":
    "The common order: compare with yourself, check the inputs, find the skill, do the work, check yourself, hand in a version.",
  "Доходит до каждого запуска исполнителя отдельным слоем.": "Reaches every executor launch as its own layer.",
  "Общий порядок проверки: открыть версию, пройти по критериям, воспроизвести, описать дефекты, дать вердикт.":
    "The common order of a review: open the version, walk the criteria, reproduce, describe the defects, give the verdict.",
  "Общий порядок: взять только названное, не додумывать, дать ссылку на каждый факт, сдать выжимку.":
    "The common order: take only what was named, never guess, reference every fact, hand in a digest.",
  // work-profiles.tsx — how this project makes this kind of result
  "Профили работ": "Work profiles",
  "У подключения нет BB-проекта: профили работ хранятся у проекта.": "This connection has no BB project: work profiles belong to the project.",
  "Как в этом проекте делают такой вид результата: голос канала, стиль превью, одобренные эталоны.":
    "How this project makes this kind of result: the channel voice, the thumbnail style, the approved samples.",
  "Список профилей приходит в каждый запуск проекта. Руководитель ставит профиль подзадаче, и его полный текст видит исполнитель — напоминать про стиль не нужно.":
    "The list of profiles reaches every launch of the project. The lead sets a profile on a subtask and the executor sees its full text — nobody has to remind them about the style.",
  "Профилей пока нет. Первый профиль имеет смысл завести для того, что делается регулярно: пост в канал, превью, письмо клиенту.":
    "No profiles yet. The first one is worth writing for whatever is made regularly: a channel post, a thumbnail, a customer letter.",
  "Ключ": "Key",
  "Признаки": "Signs",
  "Эталоны": "Samples",
  "Добавить профиль": "Add a profile",
  "Сохранить профиль": "Save the profile",
  "Профиль сохранён. Он придёт в следующий запуск задач этого проекта.": "Profile saved. It reaches the next launch of this project's jobs.",
  "Профиль удалён.": "Profile removed.",
  "Не удалось сохранить профиль. Проверьте ключ и текст.": "Could not save the profile. Check the key and the text.",
  "Загружаем профили работ…": "Loading work profiles…",
  "Короткое имя латиницей: tg-post, zen-post, yt-thumbnail.": "A short latin name: tg-post, zen-post, yt-thumbnail.",
  "Через запятую: по этим словам руководитель узнаёт такую работу.": "Comma separated: the words by which a lead recognises this kind of work.",
  "Как это делается": "How it is made",
  "Голос, стиль, длина, что никогда. Пишите так, как объяснили бы новому человеку.":
    "Voice, style, length, what never. Write it the way you would explain it to a new person.",
  "По строке: название | ссылка | чем хорош. Например «AG-14 | job:AG-14 | 40 000 просмотров».":
    "One per line: label | reference | why it is good. For example \"AG-14 | job:AG-14 | 40,000 views\".",
  "Добавка к критерию приёмки": "Added to the acceptance criteria",
  "В задаче профиль ставится полем workProfileKey: «bb agency job update» с ключом профиля. Руководитель делает это сам, когда видит подходящую работу.":
    "A job takes a profile through workProfileKey: `bb agency job update` with the profile key. The lead does it when they see work of that kind.",
  // work-profiles.tsx — the profile editor
  "Профиль работы": "Work profile",
  "Новый профиль работы": "New work profile",
  "правка {count}": "revision {count}",
  "Латиницей: tg-post, zen-post, yt-thumbnail.": "Latin letters: tg-post, zen-post, yt-thumbnail.",
  "Пост в Telegram": "Telegram post",
  "пост в телеграм, тг, пост в канал": "telegram post, tg, channel post",
  "Работы, которые вы одобрили: исполнитель держит эту планку. Ссылкой может быть ключ задачи, адрес поста или путь к файлу.":
    "The work you approved: the executor holds that bar. A reference can be a job key, a post address or a file path.",
  "Название эталона": "Sample label",
  "Ссылка на эталон": "Sample reference",
  "Чем хорош эталон": "Why the sample is good",
  "40 000 просмотров": "40,000 views",
  "AG-14": "AG-14",
  "job:AG-14": "job:AG-14",
  "Добавить эталон": "Add a sample",
  "Что проверяющий обязан проверить сверх критерия самой задачи.": "What the reviewer must check beyond the job's own criterion.",
  "Что увидит сотрудник": "What the employee will see",
  "Убрать профиль": "Remove the profile",
  "Профиль ставится задаче полем workProfileKey — это делает руководитель, когда видит подходящую работу.":
    "A job takes a profile through workProfileKey — the lead does it when they see work of that kind.",
  "Как профиль попадает в работу": "How a profile reaches the work",
  "Список профилей проекта приходит в каждый запуск: руководитель видит ключи и признаки.":
    "The project's list of profiles reaches every launch: the lead sees the keys and the signs.",
  "Полный текст профиля получает только та задача, которой он назначен, вместе с эталонами и добавкой к приёмке.":
    "Only the job it is set on receives the full profile, with its samples and the addition to the acceptance criteria.",

  // decisions.tsx — the decision model
  "Оценщик":
    "Decision model",
  "Быстрая модель, которая отвечает не текстом, а решением: выбор из списка, оценка по шкале или да/нет — и своей уверенностью.":
    "A fast model that answers with a decision rather than text: a choice from a list, a score on a scale or yes/no — each with its own confidence.",
  "Она не заменяет сотрудника. Её спрашивают там, где Агентство и так решает по правилу, но правило грубое: например, стоит ли запоминать запись.":
    "It does not replace an employee. It is asked where the Agency already decides by a rule, but the rule is crude — for example, whether a record is worth remembering.",
  "Ответ ниже порога уверенности не применяется, а молчание и ошибка равны «не знаю»: Агентство продолжает работать по своим правилам.":
    "An answer below the confidence threshold is not applied, and silence or an error means “don't know”: the Agency keeps working by its own rules.",
  "Спрашивать оценщика":
    "Ask the decision model",
  "Модель решений, например typesafe/jev-1.13.": "A decisions model, e.g. typesafe/jev-1.13.",
  "Любая обычная модель, например openai/gpt-5-nano.": "Any ordinary model, e.g. openai/gpt-5-nano.",
  "Куда обращаться":
    "Where to call",
  "Адрес":
    "Address",
  "Совместимый с чат-форматом шлюз, например Cloudflare AI Gateway.":
    "A gateway that speaks the chat format, e.g. Cloudflare AI Gateway.",
  "Где лежит ключ":
    "Where the key lives",
  "Переменная с ключом":
    "Variable holding the key",
  "Ключ уйдёт в Env Catalog под выбранным именем и зашифруется там. Агентство хранит только имя.":
    "The key goes to the Env Catalog under the chosen name and is encrypted there. The Agency keeps only the name.",
  "Ключ на месте: {name}.":
    "The key is in place: {name}.",
  "Вставить ключ":
    "Paste the key",
  "Сохранить ключ":
    "Save the key",
  "Где спрашивать":
    "Where to ask",
  "Каждая точка включается отдельно. Выключенная точка работает по правилам Агентства, как будто оценщика нет.":
    "Each point is switched on separately. A point that is off works by the Agency's rules, as if the decision model were not there.",
  "Применяем с уверенностью от {percent}%.":
    "Applied from {percent}% confidence.",
  "Сохранить настройки":
    "Save settings",
  "Проверить связь":
    "Test the connection",
  "Что делает проверка":
    "What the test does",
  "Агентство задаёт модели один вопрос о тестовой записи и показывает ответ, уверенность и время. Расход — доли цента.":
    "The Agency asks the model one question about a sample record and shows the answer, the confidence and the time. It costs a fraction of a cent.",
  "Проверка идёт по сохранённым настройкам, поэтому сначала сохраните изменения.":
    "The test uses the saved settings, so save your changes first.",
  "Ответила за {ms} мс: {answers}":
    "Answered in {ms} ms: {answers}",
  "ключ не найден":
    "the key was not found",
  "не ответила вовремя":
    "it did not answer in time",
  "ответ не по схеме":
    "the answer did not match the schema",
  "запрос не прошёл":
    "the request failed",
  "Не получилось за {ms} мс: {reason}{detail}":
    "Did not work out in {ms} ms: {reason}{detail}",
  "Не удалось прочитать настройки оценщика.":
    "Could not read the decision model settings.",
  "Не удалось сохранить настройки оценщика.":
    "Could not save the decision model settings.",
  "Настройки оценщика сохранены.":
    "Decision model settings saved.",
  "Не удалось сохранить ключ.":
    "Could not save the key.",
  "Ключ сохранён в Env Catalog под именем {name}. Агентство запомнило только имя.":
    "The key is saved in the Env Catalog under the name {name}. The Agency remembered only the name.",
  "Спрашиваем…":
    "Asking…",
  "Проверка не прошла: метод недоступен.":
    "The test did not run: the method is unavailable.",
  "Загружаем настройки оценщика…":
    "Loading the decision model settings…",
  "Плагин Env Catalog не отвечает: выберите ключ из окружения машины или включите плагин.":
    "The Env Catalog plugin is not answering: pick a key from the machine environment or enable the plugin.",
  "Переменной с таким именем нет: выберите другую или вставьте ключ ниже.":
    "There is no variable with that name: pick another one or paste the key below.",
  "Укажите, в какой переменной лежит ключ.":
    "Say which variable holds the key.",
  "Привратник памяти":
    "Memory gatekeeper",
  "Перед записью урока в память отдела: хранить ли, какой это вид, нет ли в тексте секрета или временного статуса, не повтор ли это. Отказ и находка секрета останавливают запись, вид и важность приходят предложением.":
    "Before a lesson enters the department memory: whether to keep it, what kind it is, whether the text holds a secret or a status of the day, whether it repeats an existing record. A refusal or a found secret stops the write; kind and importance arrive as a suggestion.",
};

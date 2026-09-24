/** English UI texts, keyed by the exact Russian source text. Group: BB plugins, machines, sandbox. */
export const EN_PLUGINS: Record<string, string> = {
  "Список возможностей": "Capabilities list",
  "Список плагинов": "Plugins list",
  "Поиск плагинов": "Search plugins",
  "Найти плагин…": "Find a plugin\u2026",
  "Дополнительные настройки контекста": "Advanced context settings",
  "Отмечено: {count}. На VK-сборке этот список ограничивает плагины новой сессии. Агентство и плагины выбранных навыков добавляются автоматически. Исключения отдела и сотрудника задаются в дополнительных настройках контекста.": "Selected: {count}. On VK builds this list filters plugins in new sessions. Agency and the plugins that own selected skills are included automatically. Department and employee exceptions are configured in advanced context settings.",
  "Отмечено: {count}. На VK-сборке этот список ограничивает навыки новой сессии; добавляются служебные навыки Агентства и навыки, выданные под задачу. Исключения отдела и сотрудника задаются в дополнительных настройках контекста.": "Selected: {count}. On VK builds this list filters skills in new sessions, with Agency service skills and task grants included. Department and employee exceptions are configured in advanced context settings.",
  "Отдел задаёт основу. Сотрудник переопределяет отдельные поля. По умолчанию используются списки профиля сотрудника. Изменения получает новая сессия; уже работающие сотрудники сохраняют прежний контекст.": "The department sets defaults; employees override individual fields. Employee profile lists are used by default. Changes affect new sessions; existing workers keep their context.",
  "Основные списки находятся на вкладках «Навыки» и «Плагины» и сохраняются кнопкой «Сохранить профиль». Здесь задаются только исключения, MCP, плагины CLI и инструкции.": "Main selections are in Skills and Plugins and are saved with Save profile. Configure only exceptions, MCP, native CLI plugins and instructions here.",

  "Служебный контекст (VK)": "Service context (VK)",
  "Отдел задаёт основу. Сотрудник переопределяет отдельные поля. Без настроек действуют правила BB и раздела. Изменения получает новая сессия; уже работающие сотрудники сохраняют прежний контекст.": "The department sets defaults; employees override individual fields. Without settings, BB and folder rules apply. Changes affect new sessions; existing workers keep their context.",
  "Своя политика заменяет правила контекста project-folders для служебного треда. Агентство и его обязательные навыки остаются доступны. Это фильтр загрузки, а не ограничение прав доступа.": "A custom policy replaces project-folders context rules for the worker thread. Agency and its required skills stay available. This filters context loading, not access permissions.",
  "Только назначенное в профиле и задаче": "Only assigned in profile and task",
  "Только назначенное": "Only assigned",
  "Только перечисленные": "Only listed",
  "Все, кроме перечисленных": "All except listed",
  "Имена: по одному в строке; * в конце — префикс": "Names: one per line; trailing * matches a prefix",
  "MCP-серверы CLI": "CLI MCP servers",
  "Плагины CLI": "CLI plugins",
  "Общие инструкции BB": "BB user instructions",
  "Инструкции проекта": "Project instructions",
  "Синхронизация claude.ai": "claude.ai sync",
  "Загружать": "Load",
  "Не загружать": "Do not load",
  "Контекст сохранён для новых сессий сотрудников.": "Context saved for new worker sessions.",
  "Не удалось прочитать служебный контекст.": "Could not read service context.",
  "Не удалось сохранить контекст. Черновик сохранён на экране.": "Could not save context. Your draft remains on screen.",
  "Проверяем поддержку служебного контекста…": "Checking service context support\u2026",
  "Поиск в контексте": "Search context",
  "Найти навык или плагин…": "Find a skill or plugin\u2026",
  "инструментов": "tools",
  "навыков": "skills",
  "Сохранить контекст": "Save context",
  "Наследовать всё": "Inherit everything",
  "MCP и плагины CLI задаются именами из конфигурации провайдера. Для навыка плагина разрешите также сам плагин BB. Служебный bb-bridge остаётся подключён.": "Use names from provider configuration for native MCP and CLI plugins. A plugin skill also requires its BB plugin to be allowed. The service bb-bridge stays connected.",
  "Отмечено: {count}. Эти плагины включаются в пакет задания. Чтобы ограничить загрузку остальных плагинов в сессию, настройте служебный контекст на вкладке «Навыки».": "Selected: {count}. These plugins are included in the task pack. To filter other plugins from the session, configure service context in Skills.",

  "Настройки отделов сотрудника": "Employee department defaults",
  "Отбросить черновик и перечитать": "Discard draft and reload",
  // agent-plugins.tsx
  "Плагины": "Plugins",
  "Плагины сотрудника": "Employee plugins",
  "Отмечено: {count}. Запуск сотрудника получает навыки и инструкции отмеченных плагинов и разрешение на их инструменты; команда bb <плагин> работает всегда. Остальные плагины BB в его запуск не попадают.":
    "Selected: {count}. The employee's launch receives the skills and instructions of the selected plugins and permission for their tools; the bb <plugin> command always works. Other BB plugins stay out of it.",
  "Читаем установленные плагины…": "Reading installed plugins…",
  "инструменты: {names}": "tools: {names}",
  "без инструментов": "no tools",
  "навык": "skill",
  "Плагин выключен в BB: запуск сотрудника не пройдёт, пока он отмечен.": "The plugin is turned off in BB: the employee's launch fails while it is selected.",
  "Плагин не установлен в BB: снимите галочку, иначе запуск сотрудника не пройдёт.": "The plugin is not installed in BB: clear the checkbox, or the employee's launch fails.",
  "В BB нет плагинов с инструментами или навыками для сотрудников.": "BB has no plugins with tools or skills for employees.",
  "Сотрудник получит все ключи Env Catalog и сможет их менять и удалять. Конкретный ключ безопаснее выдать через секреты в правах сотрудника.":
    "The employee gets every Env Catalog key and can change and delete them. A specific key is safer to grant through the secrets in the employee's permissions.",

  // plugin-integrations.tsx
  "Плагины BB": "BB plugins",
  "Не удалось прочитать список плагинов BB.": "Couldn't read the list of BB plugins.",
  "Агентство проверяет установленные плагины на сервере BB, без модели и токенов. Возможность без нужного плагина не показывается.":
    "The Agency checks installed plugins on the BB server, with no model and no tokens. A feature whose plugin is missing is not shown.",
  "установлен · {version}": "installed · {version}",
  "выключен": "turned off",
  "не установлен": "not installed",
  "Инструменты и навыки остальных плагинов выдаются сотрудникам по одному: «Сотрудники → профиль → Плагины».":
    "Tools and skills of other plugins are granted per employee: “Employees → profile → Plugins”.",
  "Несколько папок одного проекта на разных машинах; подзадача может работать в другой папке проекта.":
    "Several folders of one project on different machines; a subtask can work in another folder of the project.",
  "Без него у проекта в Агентстве одна папка.": "Without it, a project has one folder in the Agency.",
  "Рабочее место сотрудника на своей машине: его подзадачи запускаются там, файлы переносятся между машинами.":
    "An employee's workplace on their own machine: their subtasks launch there, and files move between machines.",
  "Без него сотрудник всегда работает на машине папки проекта.": "Without it, an employee always works on the machine of the project folder.",

  // Workplace: agent-detail.tsx
  "Рабочее место": "Workplace",
  "Где работает сотрудник": "Where the employee works",
  "Рабочее место сотрудника": "Employee workplace",
  "Папка задачи": "The job's folder",
  "По умолчанию сотрудник запускается на машине папки задачи.": "By default, an employee launches on the machine of the job's folder.",
  "Рабочее место закрепляет его за одной папкой, например на Mac mini с браузером: подзадачи ему ставятся туда, файлы главной задачи он берёт через File Gateway.":
    "A workplace ties the employee to one folder, for example on a Mac mini with a browser: their subtasks go there, and they take the main job's files through File Gateway.",
  "Папка отключена: {id}": "Folder disconnected: {id}",
  "File Gateway не установлен: рабочее место не действует. Его можно только убрать.": "File Gateway is not installed: the workplace has no effect. It can only be removed.",
  "Правила сотрудника — лимиты и песочница — сохраняются своей кнопкой и не меняют версию профиля.":
    "The employee's rules (limits and sandbox) are saved with their own button and don't change the profile version.",
  "Сохранить правила сотрудника": "Save employee rules",
  "Как в отделе": "As in the department",

  // Project folders: create-forms.tsx, job-detail.tsx
  "У проекта уже подключена папка. Несколько папок одного проекта доступны с плагином Projects & Sections.":
    "The project already has a connected folder. Several folders of one project are available with the Projects & Sections plugin.",
  "Подзадача {id}. Работу другого отдела ставят подзадачей в тот отдел. Ключ назначит сервер.":
    "Subtask of {id}. Work for another department is set as a subtask in that department. The server assigns the key.",
  "Папка проекта": "Project folder",
  "Папка подзадачи": "Subtask folder",
  "По умолчанию — папка главной задачи. Другая папка проекта нужна, когда работа идёт на другой машине.":
    "By default, the main job's folder. Another folder of the project is needed when the work runs on another machine.",
  "Доступно с плагином Projects & Sections.": "Available with the Projects & Sections plugin.",
  "Выполнится на рабочем месте сотрудника: {folder}.": "Runs at the employee's workplace: {folder}.",

  // Sandbox: work-rules.tsx, job-launch-panel.tsx
  "Песочница": "Sandbox",
  "Запуск без песочницы": "Run without sandbox",
  "Выключено (по умолчанию) — сотрудник работает в песочнице CLI: пишет только в папку задачи, сеть ограничена.":
    "Off (default): the employee works in the CLI sandbox, writes only to the job's folder, and has limited network access.",
  "Включено — полные права без песочницы. Нужно рабочим местам с браузером и программами и машинам, где песочница не пускает команды Агентства (например, Linux-сервер).":
    "On: full permissions without the sandbox. Needed for workplaces with a browser and programs, and on machines where the sandbox blocks Agency commands (for example, a Linux server).",
  "Команды, которые сотрудник всё же выполнил вне песочницы, Агентство отмечает в карточке задачи.":
    "Commands the employee still ran outside the sandbox are marked by the Agency in the job card.",
  "Сотрудник выполнил вне песочницы команд: {count}. Проверьте, что он не выходил за папку задачи.":
    "Commands the employee ran outside the sandbox: {count}. Check that they stayed inside the job's folder.",
  "вне песочницы: {count}": "outside the sandbox: {count}",
  // Machine sandbox rule
  "Песочница на этой машине": "Sandbox on this machine",
  "Сохранить правило машины": "Save machine rule",
  "Как в правилах отдела": "As in the department rules",
  "задано для машины": "set for the machine",
  "Правило для всех запусков на машине. «Как в правилах отдела» — решает отдел; «Да» — без песочницы, например на Linux-сервере, где песочница не пускает команды Агентства; «Нет» — всегда в песочнице.":
    "A rule for every launch on the machine. “As in the department rules” lets the department decide; “Yes” runs without the sandbox, for example on a Linux server where the sandbox blocks Agency commands; “No” always runs in the sandbox.",
  "Личное правило сотрудника сильнее правила машины.": "An employee's own rule overrides the machine rule.",
  // agent-plugins.tsx: filters and tags
  "Показать плагины": "Show plugins",
  "Что дают плагины": "What plugins give",
  "{label} · {count}": "{label} · {count}",
  "Все": "All",
  "Инструкции": "Instructions",
  "Навыки": "Skills",
  "Инструменты": "Tools",
  "Все плагины, которые что-то дают запуску сотрудника.": "All plugins that give the employee's launch something.",
  "Добавляют раздел в системное сообщение сессии: правила, когда и как пользоваться плагином.": "Add a section to the session's system message: rules for when and how to use the plugin.",
  "Дают навык: подробную инструкцию, которую агент открывает, когда задача её требует.": "Give a skill: detailed guidance the agent opens when the job needs it.",
  "Дают инструменты, которые агент вызывает сам. Сейчас BB передаёт их сотруднику только командой bb <плагин>.": "Give tools the agent calls itself. For now BB gives them to employees only as the bb <plugin> command.",
  "инструкции": "instructions",
  "инструменты": "tools",
  "В BB нет плагинов с инструкциями, навыками или инструментами для сотрудников.": "BB has no plugins with instructions, skills or tools for employees.",
  "Под этот фильтр плагинов нет.": "No plugins match this filter.",
  "Не показаны плагины, которые меняют только интерфейс BB, — сотруднику они ничего не дают: {names}.": "Plugins that only change the BB interface are not shown, as they give an employee nothing: {names}.",
  "Язык, на котором сотрудники пишут отчёты, комментарии и вопросы владельцу, и язык интерфейса и комментариев Агентства. Инструкции агентам всегда на английском.": "The language employees write reports, comments and questions to the owner in, and the language of the Agency interface and comments. Instructions to agents are always in English.",
  "Сотрудники отвечают по-русски со следующего хода. Название в боковой панели BB сменится после обновления страницы.": "Employees reply in Russian from their next turn. The name in the BB sidebar changes after the page reloads.",
  "Инструкции и служебные сообщения агентам всегда на английском: так их точнее понимают модели. Одна строка в них велит отвечать на русском.": "Instructions and service messages to agents are always in English, which models follow more precisely. One line in them asks for replies in Russian.",
};

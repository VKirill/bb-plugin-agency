/** English UI texts, keyed by the exact Russian source text. Group: BB plugins, machines, sandbox. */
export const EN_PLUGINS: Record<string, string> = {
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
};

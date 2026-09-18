/** English UI texts, keyed by the exact Russian source text. Group: goals, knowledge, metrics, archive, backups. */
export const EN_INSIGHTS: Record<string, string> = {
  // Priorities used as plain option values
  "Обычный": "Normal",
  "Срочный": "Urgent",

  // agent-metrics.tsx
  "Считаем показатели…": "Calculating metrics…",
  "{hours} ч": "{hours} h",
  "Сейчас": "Now",
  "Открытые задачи": "Open jobs",
  "Назначенные сотруднику задачи, которые ещё не готовы и не отменены.": "Jobs assigned to the employee that are not done or canceled yet.",
  "Ждут решения или ответа": "Waiting for a decision or reply",
  "Из открытых: в «Ожидает решения» или «Ждёт ответа».": "Of the open ones: in “Awaiting decision” or “Waiting for reply”.",
  "Сданные версии, которые ждут проверки или приёмки.": "Handed-in versions waiting for review or acceptance.",
  "Результаты": "Results",
  "Готово за 30 дней": "Done in 30 days",
  "Задачи сотрудника, закрытые как готовые за последние 30 дней.": "The employee's jobs closed as done in the last 30 days.",
  "Без доработок": "No rework",
  "Доля готовых за 90 дней задач, которые ни разу не возвращались на доработку.": "Share of jobs done in 90 days that were never returned for rework.",
  "Медианный срок": "Median lead time",
  "Половина готовых за 90 дней задач закрыта быстрее этого срока — от создания до готовности.": "Half of the jobs done in 90 days closed faster than this, from creation to done.",
  "Возвратов на доработку": "Returns for rework",
  "Сколько раз версии сотрудника возвращали с замечаниями за 90 дней.": "How many times the employee's versions were returned with remarks in 90 days.",
  "Отменено за 30 дней": "Canceled in 30 days",
  "Задачи сотрудника, отменённые за последние 30 дней.": "The employee's jobs canceled in the last 30 days.",
  "Расход за 30 дней": "Spend in 30 days",
  "Оценка стоимости попыток за 30 дней по ценам API. Для CLI без подтверждённого расхода — прочерк.":
    "Estimated cost of attempts in 30 days at API prices. A dash for CLIs without confirmed spend.",
  "Попыток за 30 дней": "Attempts in 30 days",
  "Сколько раз задачи сотрудника запускались.": "How many times the employee's jobs were launched.",
  "Сбоев": "Failures",
  "Попытки, завершённые сбоем: ошибка CLI, машины или провайдера.": "Attempts that ended in a failure: a CLI, machine or provider error.",
  "Последняя активность": "Last activity",
  "{age} назад": "{age} ago",
  "Когда сотрудник последний раз писал в историю задач.": "When the employee last wrote to a job's history.",

  // backups.tsx
  "Копия сохранена: {name}.": "Backup saved: {name}.",
  "Восстановить копию?": "Restore the backup?",
  "Все данные Агентства — задачи, отделы, сотрудники, правила, история — заменятся копией от {date}. Текущее состояние сначала сохранится отдельной копией. Идущие запуски не останавливаются: проверьте их после восстановления.":
    "All Agency data (jobs, departments, employees, rules, history) will be replaced with the backup from {date}. The current state is saved as a separate backup first. Running launches are not stopped: check them after restoring.",
  "Восстановить": "Restore",
  "Копия восстановлена. Прежнее состояние сохранено: {name}.": "Backup restored. The previous state is saved: {name}.",
  "Копия базы Агентства: задачи, история, отделы, сотрудники, правила, знания, автоматизации. Снимок согласованный — делается на лету, без остановки работы.":
    "A copy of the Agency database: jobs, history, departments, employees, rules, knowledge, automations. The snapshot is consistent and is taken live, without stopping work.",
  "Секреты внешних адресов и закрепление навыков хранятся отдельно и в копию не входят.":
    "Webhook secrets and skill pins are stored separately and are not included in the backup.",
  "Создать копию": "Create backup",
  "Восстановление заменяет все данные Агентства данными копии. Перед этим текущее состояние сохраняется отдельной копией, так что шаг можно отменить, восстановив её.":
    "Restoring replaces all Agency data with the backup. The current state is saved as a separate backup first, so you can undo the step by restoring it.",
  "Читаем список копий…": "Reading backups…",
  "Копий пока нет.": "No backups yet.",
  "Резервные копии": "Backups",
  "Восстановление": "Restore",

  // department-parent.tsx
  "Отдел больше не подчиняется другому.": "The department no longer reports to another one.",
  "Подчинённость сохранена: долго ждущие решения задачи этого отдела будут эскалироваться выше.":
    "Reporting line saved: this department's jobs that wait long for a decision will be escalated upward.",
  "Вышестоящий отдел видит эскалации: главные задачи этого отдела, которые ждут решения дольше срока из правила «Эскалировать в вышестоящий отдел через».":
    "The parent department sees escalations: this department's main jobs that wait for a decision longer than the “Escalate to the parent department after” rule.",
  "Отдел не может подчиняться сам себе или своему подчинённому.": "A department can't report to itself or to its own subordinate.",
  "Подчиняется отделу": "Reports to department",
  "Вышестоящий отдел": "Parent department",
  "Не подчиняется": "Reports to no one",

  // goals.tsx, job-goal.tsx
  "Цель сохранена.": "Goal saved.",
  "Новая цель": "New goal",
  "Загружаем цели…": "Loading goals…",
  "готово {done} из {total} · в работе {open}": "{done} of {total} done · {open} in progress",
  "Отвязать": "Unlink",
  "Главных задач у цели пока нет.": "The goal has no main jobs yet.",
  "Привязать": "Link",
  "Изменить цель": "Edit goal",
  "Цель — результат для владельца, ради которого идут главные задачи. Сроки и статус цели задачи не меняют.":
    "A goal is the owner's outcome that main jobs work toward. The goal's due date and status don't change the jobs.",
  "Сохранить цель": "Save goal",
  "Цели": "Goals",
  "Зачем идут главные задачи и насколько продвинулись. Подзадачи учитываются через свою главную задачу.":
    "Why main jobs are running and how far they've got. Subtasks count through their main job.",
  "Целей пока нет": "No goals yet",
  "Создайте цель и привяжите к ней главные задачи: здесь будет виден прогресс.": "Create a goal and link main jobs to it: progress shows up here.",
  "Привязать главную задачу": "Link a main job",
  "Главная задача для цели": "Main job for the goal",
  "Название цели": "Goal name",
  "Что считается достигнутым": "What counts as achieved",
  "Статус цели": "Goal status",
  "Активна": "Active",
  "Достигнута": "Achieved",
  "Отменена": "Dropped",
  "Без цели": "No goal",
  "Цель, ради которой идёт главная задача. Прогресс целей — в разделе «Цели».": "The goal this main job works toward. Goal progress is in the “Goals” section.",
  "Цель": "Goal",
  "Цель задачи": "Job goal",
  "не задана": "not set",
  "целей нет": "no goals",
  "Цели работают на данных Агентства: выключите пример.": "Goals work on Agency data: turn off the example.",

  // job-detail.tsx, jobs.tsx escalation
  "в отдел «{name}»": "to the “{name}” department",
  "Задача ждёт решения дольше срока правила отдела и эскалирована в вышестоящий отдел. Эскалация закрывается, когда задача выходит из «Ожидает решения».":
    "The job has waited for a decision longer than the department rule allows and was escalated to the parent department. The escalation closes when the job leaves “Awaiting decision”.",
  "Эскалация": "Escalation",
  "Эскалировано в вышестоящий отдел": "Escalated to the parent department",
  "эскалация": "escalated",

  // jobs-archive.tsx, jobs.tsx, shell.tsx
  "Ещё найдено": "More results",
  "Ещё найдено: описания, комментарии, архив": "More results: descriptions, comments, archive",
  "архив": "archive",
  "номер": "key",
  "комментарий": "comment",
  "Загружаем архив…": "Loading the archive…",
  "В архиве пока пусто. Сюда уходят полностью закрытые задачи со всеми подзадачами после срока из настроек плагина.":
    "The archive is empty. Fully closed jobs with all their subtasks move here after the period set in the plugin settings.",
  "Архив задач": "Job archive",
  "Показать ещё · осталось {count}": "Show more · {count} left",
  "Удалить вид": "Delete view",
  "Сохранить вид": "Save view",
  "Вид запоминает фильтры, поиск, сортировку и режим доски. Вид с тем же названием будет перезаписан.":
    "A view remembers the filters, search, sorting and board mode. A view with the same name is overwritten.",
  "Сохранённый вид": "Saved view",
  "Название вида": "View name",
  "Виды": "Views",
  "Архив · {count}": "Archive · {count}",
  "Архив": "Archive",
  "Задача в архиве: изменения недоступны.": "The job is archived: changes are unavailable.",

  // knowledge-live.tsx
  "Отдел «{name}»": "Department “{name}”",
  "Проект «{name}»": "Project “{name}”",
  "Материал сохранён и принят: он придёт в запуски своей области.": "Material saved and accepted: it will reach launches in its scope.",
  "Материал принят: он придёт в запуски своей области.": "Material accepted: it will reach launches in its scope.",
  "Материал убран в архив и больше не приходит в запуски.": "Material archived; it no longer reaches launches.",
  "Материал возвращён в предложения.": "Material moved back to proposals.",
  "Предложений от сотрудников: {count}. Примите нужные — только принятые материалы доходят до запусков.":
    "Proposals from employees: {count}. Accept the ones you need: only accepted materials reach launches.",
  "Загружаем знания…": "Loading knowledge…",
  "Предложил сотрудник": "Proposed by an employee",
  "В архив": "Archive",
  "Предложение": "Proposal",
  "В архиве": "Archived",
  "Все области": "All scopes",
  "Действующие и предложения": "Active and proposals",
  "Принятый материал добавляется в промпт каждого запуска своей области: знания Агентства — всем, отдела — задачам отдела, проекта — задачам в этой папке. До 8 000 символов на слой; что не поместилось, сотрудник найдёт через bb agency knowledge list.":
    "Accepted material is added to the prompt of every launch in its scope: Agency knowledge to all, department knowledge to the department's jobs, project knowledge to jobs in that folder. Up to 8,000 characters per layer; the employee finds the rest with bb agency knowledge list.",
  "Это справка, не приказ: при противоречии с регламентом или поручением сотрудник задаёт вопрос.":
    "This is reference, not an order: if it contradicts the regulations or the assignment, the employee asks a question.",
  "Укажите область и источник. Материал, сохранённый владельцем, принят сразу; правка из треда сотрудника становится предложением.":
    "Set the scope and source. Material saved by the owner is accepted at once; an edit from an employee's thread becomes a proposal.",
  "Принятые материалы приходят в каждый запуск своей области: всего Агентства, отдела или проекта.":
    "Accepted materials reach every launch in their scope: the whole Agency, a department or a project.",
  "Как материал доходит до запуска": "How material reaches a launch",

  // Labels translated inside components and helpers
  "Показатели": "Metrics",
  "Сохранить лимиты": "Save limits",
  "Сохранить правила": "Save rules",
  "отдела": "the department",
  "сотрудника": "the employee",
  "Выберите": "Select",

  // dispatcher-automations.tsx: starting values of a new rule form
  "Исследование доставлено": "Research delivered",
  "Разобрать поставку": "Review the delivery",
  "Проверьте поставленный материал.": "Check the delivered material.",
  "Есть вывод и ссылка на источник.": "There is a conclusion and a link to the source.",
  "Предложило Агентство: замечание повторилось в нескольких задачах": "Proposed by the Agency: the remark repeated in several jobs",
  "Предложило Агентство: черновик урока после приёмки задачи": "Proposed by the Agency: a lesson drafted after the job was accepted",
  "Сотрудники открывали {count} раз — запись работает.": "Employees opened it {count} times — the record is doing its job.",
  "Сотрудники ни разу не открывали: при нехватке места в памяти отдела такая запись уходит в архив первой.": "Employees never opened it: when the department memory runs out of room, a record like this goes to the archive first.",
  "Отдел записал сам после приёмки задачи — принято автоматически. Поправьте или уберите, если запись лишняя.": "The department wrote this itself after the job was accepted — accepted automatically. Edit it or remove it if the record is not needed.",
  "Принятый материал попадает в промпт каждого запуска своей области строкой индекса: вид, название и сводка. Полный текст сотрудник берёт сам через bb agency knowledge get; целиком сразу приходят только закреплённые и важные записи.":
    "An accepted material reaches every launch of its scope as one index line: kind, title and summary. The employee reads the full text with bb agency knowledge get; only pinned and important entries arrive whole.",
};

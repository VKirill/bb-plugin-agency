# Цикл задачи

## Подготовь

1. Прочитай Job и ProjectBinding, Department/ProcessVersion, назначенного Agent/AgentVersion, соответствующие политики и входные материалы.
2. Раздели Job.brief (что сделать и по каким исходникам) и Job.acceptance (точный path и маркер этой задачи). ProcessVersion.acceptance — класс результата (схема, validate, публикация), не другой Job. Слой job не отменяет department. Если оба acceptance нельзя выполнить сразу — назови processVersion id и job id, остановись как needs clarification; не auto-pick, не success, не accept.
3. При отсутствии исходника сформулируй «чего нет → зачем → подходящая замена → кто отвечает». Свободное описание допустимо для первого брифа; статистику и запись встречи не придумывать.
4. При составной работе предложи связанные Job и зависимости. parentJobId означает иерархию, JobDependency — зависимость: одно не заменяет другое. Не создавать цикл.
5. Межотдельная передача: получатель работает по процессу своего отдела; передать результат/версию, критерии и исходные ссылки, сохранив проект и ограничения. Не копировать всю историю и полномочия отправителя.

## Состояния

При создании Job передавай только поля createJob: title обязателен, state в payload создания отсутствует. Изменение состояния — отдельная операция перехода, а не произвольное поле create/update.

Job имеет backlog, queued, running, review, waiting_input, blocked, done, canceled. Не использовать draft/approved документа как состояние Job.

Правила переходов определяются сервером; таблица ниже — условия подготовки, не разрешение изменить БД:

| Переход | Условие |
|---|---|
| В queued | Назначены сотрудник и binding, заполнены brief и acceptance |
| В running | Дополнительно привязан реальный thread и runtime разрешает исполнение; сейчас execution=unavailable |
| running → waiting_input | Только typed `reportNeedsInput` текущего запуска: вопросы + source refs, проверенные job/attempt/thread/launch. Не regex по тексту треда. Не общий `transitionJob`. Watcher это **не** ставит |
| waiting_input → running | Только typed `answerNeedsInput` с `waitId` открытого цикла: ответы, verified amendment, official send на тот же thread. Recover unknown не шлёт. Не `transitionJob`, не комментарий, не prepare/spawn |
| running → review | Watcher: thread `idle` **и** hash-проверенная текущая ArtifactVersion. Один `idle` без такого артефакта оставляет Job `running` |
| review → running | Есть комментарий доработки и доступное исполнение |
| review → done | Принята текущая версия и выполнена политика ревью |

Сверяй полную допустимость с src/domain/job-state.ts и фактическим ответом сервера. queued/running на интерфейсе не доказывает созданного Run. Навык не обходит unavailable через прямой bb thread spawn.

## Проверь и передай

Сопоставить результат с Job.acceptance и ProcessVersion.acceptance. Противоречие: процитировать оба источника (id процесса и id задачи), вердикт needs clarification / blocked в тексте ответа. Не success и не accept. Watcher не переводит Job в `waiting_input`: без опубликованного hash-проверенного артефакта после idle задача остаётся `running`; с таким артефактом — `review`, это не приёмка. Конфликт acceptance: `bb agency job report-needs-input` / `call reportNeedsInput` с durable questions; не accept, не publish, не respawn. Закрытие вопросов: `bb agency job answer-needs-input` / `call answerNeedsInput` на тот же attempt/thread и `waitId` текущего цикла; amendment передаёт текущий процесс, даже если snapshot запуска старый. Новый вопрос после resume — новый `reportNeedsInput` / новый `waitId`; replay старого `requestId` не закрывает новый wait. Recover unknown → needs_reconciliation без send. `blocked` на Job — только явный переход. Для дефекта: критерий → место/версия → исправление → получатель.

После успешного `reportNeedsInput` заверши текущий provider turn коротким финальным сообщением с `waitId`. Это ожидание отдельного official send, а не ожидание внутри открытого хода. Не вызывай `AskUserQuestion` или второй native interaction для того же вопроса, не используй sleep/poll для ожидания владельца. После продолжения новый вопрос записывается новым `reportNeedsInput`, затем ход снова завершается. Это инструкция поведения, не ограничение доступных инструментов провайдера.

При разрешённом ручном исполнении в текущем чате подготовить результат, явно отделив его от запуска сотрудника плагином. Сохранение в плагин и смену состояния подтверждать чтением реальной записи через доступный интерфейс.

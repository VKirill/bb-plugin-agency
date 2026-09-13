# Диспетчер

ports.ts задаёт границу запусков и сверки. Реализация engine не зарегистрирована,
пока runtime/isolation сообщает supported=false. Будущий service: inbox → правило
→ outbox → claim → проверка профиля → spawn → bind → reconcile. Состояние в БД,
не в живом чате руководителя. thread.idle не закрывает Job.

# Агентство — обзор для установки

Постоянные сотрудники, отделы, задачи и версии файлов в BB. CLI `bb agency`,
страница `/plugins/agency/overview`. Деморежим — отдельная кнопка, не рабочие данные.

**Runtime:** CRUD всегда. Spawn — только если GET spawn-contract отвечает и
назначенный provider в proven (`claude-code`). Иначе `execution` unavailable.
Обычный SDK 0.4.87 без контракта не ломает каталог. Production rollout отдельно.

**Не обещать:** cron, webhook-автозапуск, изоляцию всех CLI, accept по тексту
«готово», `waiting_input` из прозы треда.

Введение и границы пакета — корневой README. Контракты: [docs/README.md](docs/README.md).

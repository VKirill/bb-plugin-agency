# Wiring после live core probe

Сейчас (BB 0.43.1, SDK 0.4.87, production Mini): `isolatedSkillDelivery` / `skillIds` нет в `ThreadSpawnArgs`. AGY-16 живёт в отдельном worktree; production не переключён. Coordinator **не** вызывает spawn и не ставит execution available.

После явного live probe на isolated instance (не `~/.bb` / не порт 38886):

1. Зафиксировать, что `POST /api/v1/threads` и SDK `threads.spawn` принимают `isolatedSkillDelivery` + `skillIds` (`skill_`+64 hex) без unsafe cast.
2. Поднять `isolatedSpawnFields` и `isolationReady` только на этом доказанном core, не на установленном 0.4.87.
3. Реальный spawn-порт: host/path/model/skill/MCP **только** из `launchContractFromSnapshot`. Без fallback и без Agency `skl_*`.
4. Native MCP registry по-прежнему не covered — `mcpIds` из snapshot не подставлять в несуществующий SDK-фильтр.
5. `reconcileByLaunchId` — только если probe показал штатный lookup; не выдумывать idempotency `threads.spawn`.
6. Job.running — отдельный domain callback после bind `threadId`, не внутри SDK.
7. Register/RPC/UI не включать, пока probe + изоляция MCP не приняты отдельно.
8. **Предел durability:** полный отказ SQLite не сохранит receipt. Coordinator всё равно возвращает точный `{ launchId, threadId, spawnKind }` с `persisted: false`. Это не строка после reopen. Hint можно upsert в `agency_launch_receipt`, но ручной recovery не биндит без `verifyConfirmedThread`. Deployed SDK **не умеет** доказать launchId/thread — recovery остаётся pending/unavailable, не running.
9. `knownReceipt` не authority. Lookup должен сверить launchId/attempt и host/env/root/project/provider со **stored snapshot**. Вымышленный thread или чужая связка — reject. Не выдумывать SDK idempotency.

Документ не является разрешением на живой запуск.

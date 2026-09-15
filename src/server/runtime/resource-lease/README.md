# Блокировка рабочей папки

Внутренний SQLite-модуль для AGY-9. В запуск ещё не подключён; это не доказательство OS sandbox и не ограничение произвольного процесса на машине.

- Ключ: host + проверенный canonicalRoot. Активные родительская и вложенная папки конфликтуют. Другой host независим.
- `acquire` выполняется через BEGIN IMMEDIATE. Повтор владельца возвращает тот же claim, не продлевает его автоматически.
- `renew` и `assertCurrent` проверяют token/generation/attempt и TTL. Истечение TTL закрывает новые действия, но НЕ отдаёт папку другому писателю.
- `release` требует приватный `ResourceQuiescencePort`: подтверждение, что прежний писатель остановлен и не сможет продолжить. `idle` и таймер сами по себе недостаточны. После await снова сверяется claim.
- После освобождения новый claim имеет следующий generation и новый token. Старый claim не продлевает/не освобождает новый.

## Интеграция (не реализована этим модулем)

Владелец общих миграций добавляет `RESOURCE_LEASE_MIGRATION` в конец массива. До acquire caller проверяет ServiceContext, живой binding, snapshot и canonicalRoot на целевом host (включая aliases/symlink/case normalization); пользовательский path не право доступа. Модуль намеренно не экспортируется в RPC.

Взять claim до spawn, проверять перед отправкой и heartbeat, сохранять claim вместе с попыткой. При expiry потерянный worker не считается остановленным: остановка/сверка, без нового spawn. Release только через проверенный stop-handoff либо иной terminal proof; adapter обязан гарантировать, что resume старой попытки больше невозможен. Сам модуль не ограничивает внешние write и не отменяет thread.

Tests: `tests/resource-lease.test.ts` — файловый WAL SQLite, две connection, reopen, parent overlap, expired claim, stale fence, гонка release через await. На живом экземпляре таблица/claims не создавались.

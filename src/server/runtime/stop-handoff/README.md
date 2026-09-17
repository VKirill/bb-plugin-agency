# stop-handoff

Типизированный stop-intent + reconcile + handoff pins + **различие observed stop vs safe replacement**.

Не RPC, не UI, не `launch/`, не миграции, не `resource-lease`.

Контракт: [stop-handoff-contract.md](внутренний контракт AGY-9, хранится вне репозитория).

## API

- Фаза `confirmed` = `ObservedStopClaim`. Можно `compileHandoff`. **Не** новый writer.
- `assertCanSpawn` даёт `ok` только как `SafeReplacement` (quiescence `confirmed`).  
  `confirmed` + quiescence `unavailable` / unsupported / `still_active` → blocked.  
  Нет stop-записи → `spawn_not_authorized_by_stop_module` (это не launch gate).

## Persist

`agency_request` kind `agency.stopHandoff`.

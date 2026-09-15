# Среда сотрудника

## Границы

- `isolation.ts` на обычном host: без proven provider → `execution` unavailable.
  Это отказ, не sandbox. Изоляция **проверена только для claude-code** на
  isolated instance с GET `/api/v1/system/experimental_thread-spawn-contract`.
- `prepare-run/` — snapshot + reserve; spawn только после handshake.
- `run-store` — ContextSnapshot + RunAttempt + receipt.
- `launch/` — coordinator; `reconcile` не respawn.
- `isolated-sdk/` — verify live thread, completion hash, watch.
- `executing-activity/` — sidebar N: `threads.get` `active` + applied bind; без `listRunning`.
- `needs-input/` — typed `reportNeedsInput` / `answerNeedsInput` + official `threads.send`. Watcher сюда не пишет.
- `node_modules` host SDK 0.4.87 ≠ isolated patched tarball. Production rollout
  отдельно; этот каталог его не включает.

Подробности: `prepare-run/README.md`, `launch/README.md`, `isolated-sdk/README.md`.

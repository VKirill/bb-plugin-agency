# Среда сотрудника

## Границы

- `conveyor/` — станция закрывается приёмкой версии; ОТК и корень не ждут владельца.
- `prepare-run/` — snapshot + reserve + пакет `.agency/jobs/<key>/TASK.md`; spawn через native `threads.spawn`.
- `run-store` — ContextSnapshot + RunAttempt + receipt.
- `launch/` — coordinator; `reconcile` не respawn.
- `isolated-sdk/` — verify live thread, completion hash, watch.
- `executing-activity/` — sidebar N: `threads.get` `active` + applied bind; без `listRunning`.
- `needs-input/` — typed `reportNeedsInput` / `answerNeedsInput` + official `threads.send` в рабочий тред.
- `client-bounce/` — вопросы `waiting_input` и готовый продукт корня в чат заказчика (`originThreadId`).
- `intake/` — размер/риск → цепочка (assistant/low vs executor+review).
- `node_modules` host SDK 0.4.87 ≠ isolated patched tarball. Production rollout
  отдельно; этот каталог его не включает.

Подробности: `prepare-run/README.md`, `launch/README.md`, `isolated-sdk/README.md`.

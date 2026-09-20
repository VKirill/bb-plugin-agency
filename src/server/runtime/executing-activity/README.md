# Executing activity (sidebar badge)

Два счётчика. Бейдж в шапке = **in-progress** (список «В работе»). Честный executing не подменяется.

| RPC | Поле | Что считает |
| --- | --- | --- |
| `sidebarInProgressJobCount` | `inProgressJobCount` | Distinct `agency_job.state = 'running'`. Thread status не читает. |
| `sidebarExecutingJobCount` | `executingJobCount` | Distinct Job с bound attempt и `threads.get` `status === "active"`. |

Нет running jobs → `{ available: true, inProgressJobCount: 0 }`. UI прячет 0 и `available: false`. Текст бейджа: «В работе: N».

## Честный executing (без изменений)

`threads.get` `id`/`status` + `pluginMetadata.agencyJobId`/`agencyLaunchId`/`agencyAttemptId`. `starting`/`idle` не N. Lookup throw → `{ available: false }`. Кандидаты: Job+attempt `running`, receipt confirmed + `job_bind_state = applied`, thread/launch ids совпали.

## UI

`navPanel.experimental_sidebarAccessory`. Опрос в accessory, без `background.service`. Switch: `sidebarInProgressJobCount`.

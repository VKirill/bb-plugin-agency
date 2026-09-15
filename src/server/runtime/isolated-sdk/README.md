# isolated-sdk

Handshake: `GET /api/v1/system/experimental_thread-spawn-contract`. Env JSON не используется.

Verify: actual `threads.get` include `environment,host`. Missing host/path/project/provider → `live_binding_incomplete`. Job mismatch → reject. Snapshot только expected compare.

Completion: published = current version + verified open bytes. Accepted отдельно. Idle без hash ≠ review.
Watch (poll + `thread.idle`/`failed`): `idle` + hash текущей ArtifactVersion → `transitionJob` running→review, attempt `awaiting_review`. Job `done` + accepted current + attempt evidence → `succeeded`. Idle alone неуспех. `acceptedVerified` сейчас any-current (gap). Watch **не** ставит `waiting_input` и **не** accept. `runSucceeded` всегда false. Reload = повторный poll тех же receipt. Poll inFlight/catch — known risk, не этот freeze.

Fingerprint подтверждает contract текущего core, не изоляцию ОС.

Catalog roles: plugin settings JSON / `AGENCY_ISOLATED_CATALOG_ROLES_FILE` /
`<dataDir>/agency-isolated-catalog-roles-v1.json`. Schema `agency-isolated-catalog-roles-v1`.
Каждый prepare: exact id+source+host + package hash. Нет name fallback и нет ID в исходниках.

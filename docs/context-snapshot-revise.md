# Revise: ContextSnapshot compiler (schemaVersion 2)

Сверено 2026-09-14 с `compile.ts` / `types.ts` и контрактом
[session-context-contract.md](session-context-contract.md),
[data-model.md](data-model.md), [instruction-context.md](instruction-context.md).
Это правка чистого compiler: без persist, spawn, FS, AGY-16, register/RPC.

Цель снимка — **воспроизвести launch**, не только собрать красивый prompt.
Digest должен меняться, если меняется любой вход запуска (модель, MCP, capabilities, handoff, upstream artifact).

## Вердикт по замечаниям root

| Замечание | Контракт | Факт в compiler | Вердикт |
|---|---|---|---|
| Selected MCP нет в snapshot/digest | «выбранные MCP/skills»; snapshot хранит selected IDs/hash | `agentVersion.mcpIds` только проверяются; в snapshot нет `selectedMcps`; в prompt нет MCP; digest их не видит. Невыбранные MCP только в `exclusions` | подтверждено |
| `AgentVersion.model` не сохранён | AgentVersion: provider/**model**, role, methods | snapshot.agentVersion: id, agentId, version, providerId, policyVersionId. `model` нет ни в snapshot, ни в prompt. Две модели → один digest | подтверждено |
| Policy только id + constraints check | PolicyVersion: allowedCapabilities, cliHostConstraints, secretRefs; snapshot: **effective policy** | snapshot.policyVersion = `{ id }`. Проверка только providerIds/hostIds. capabilities и secretRefs не в snapshot и не в digest | подтверждено |
| Binding и agent — одна policy id | UI `persistCreate*` создаёт **отдельные** PolicyVersion; reuse по содержимому, не по id | `agentVersion.policyVersionId === binding.policyVersionId === policyVersion.id` иначе `policy_mismatch`. Разные id с одинаковым payload live-запуск ломают | подтверждено |
| Artifact только `job.id` | Входы — конкретные ArtifactVersion; Job имеет parent/JobDependency | `artifact.jobId !== job.id` → `artifact_job_mismatch`. Upstream/parent входы запрещены | подтверждено |
| Handoff hardcoded no prior | Уровень «Передача»: принятые результаты, вопросы, возврат, hash/version, ссылка на предыдущую попытку | `handoff` в input нет. Текст всегда «No prior RunAttempt…». Пустой и явный пакет неотличимы | подтверждено |
| Skill duplicate same id/hash, разный provenance — первый молча | «происхождение каждого уровня видно»; catalog source ≠ выбран | `indexSkills`: тот же id+hash → `continue` (первый). `name`/source не сравниваются. MCP при том же hash — last write | подтверждено |

`schemaVersion: 1` после этой волны несовместим: меняется состав digest.

## Вне scope

- Persist snapshot, RunLauncher, spawn, host I/O, изоляция AGY-16.
- Значения секретов в snapshot/prompt (только `secretRefs` имена).
- Тела skills/MCP в prompt («catalog bodies are not injected» остаётся).
- Одна общая PolicyVersion в UI/БД (это отдельная волна reuse-by-content).

## Изменения input (`CompileContextSnapshotInput`)

1. **`bindingPolicyVersion`** и **`agentPolicyVersion`**: оба полные `PolicyVersion`. Поле `policyVersion` убрать.
2. **`authorizedInputJobIds`**: `job.id` ∪ `job.parentJobId` ∪ `dependsOnJobId[]` вызывающего (caller передаёт уже проверенный список; compiler не ходит в SQLite). Пустой список сверх `job.id` допустим.
3. **`handoff`**: `null` или объект:
   `{ priorRunAttemptId, fromSnapshotDigest, acceptedArtifacts: InputArtifactRef[], openQuestions: string[], returnReason: string | null, hash }`
   `hash = sha256(canonical(handoff без поля hash))`.
4. **`catalogSkills` / `catalogMcps`**: обязательное **`source`** (строка provenance, например `plugin:agency`, `bb-user`). `name` по-прежнему не входит в digest.

## Изменения snapshot (то, что входит в digest)

`schemaVersion: 2`.

```text
binding: + bbProjectId, environmentId, policyVersionId
job: + title, briefHash, acceptanceHash   (полный brief/acceptance остаются в prompt.job)
agentVersion: + model, role, instructionsHash, skillIds, mcpIds
processVersion: + instructionsHash, acceptanceHash, reviewPolicy
policy:
  binding: { id, contentHash }
  agent: { id, contentHash }
  effective: { allowedCapabilities, cliHostConstraints, secretRefs, contentHash }
selectedSkills: как сейчас (id, hash, role)
selectedMcps: [{ id, hash }]            // NEW, сортировка по id
selectedMcpsHash
inputArtifacts: + jobId, hostId, relativePath
handoff: null | { priorRunAttemptId, fromSnapshotDigest, acceptedArtifacts, openQuestions, returnReason, hash }
```

`contentHash` политики = sha256(canonical `{ allowedCapabilities, cliHostConstraints, secretRefs }`).
Тексты brief/instructions в snapshot не дублировать целиком, если они уже в `prompt.levels` **и** их hash лежит в структурированной части. Digest считается по всему snapshot без поля `digest`, включая `prompt`.

## Правила fail-closed

| Код | Когда |
|---|---|
| `policy_content_required` | нет allowedCapabilities или нет cliHostConstraints/secretRefs массивов |
| `policy_effective_empty` | пересечение `allowedCapabilities` binding∩agent пусто (явный пустой allowlist = запретить всё — не запускать) |
| `provider_constraint_mismatch` / `host_constraint_mismatch` | provider/host не входят в **пересечение** ненулевых constraint-списков; пустой список на одном уровне = не сужает |
| `secret_ref_not_named` | не требуется на compile; значения секретов отвергать, если попали в input |
| `unknown_mcp` / `invalid_mcp_id` | как сейчас |
| `catalog_skill_provenance_conflict` | один id, один hash, **разный** `source` |
| `catalog_mcp_provenance_conflict` | то же для MCP |
| `catalog_skill_hash_mismatch` | один id, разный hash (как сейчас) |
| `artifact_job_unauthorized` | `artifact.jobId` ∉ `{ job.id } ∪ authorizedInputJobIds` (замена `artifact_job_mismatch` на «только свой job») |
| `host_mismatch` | artifact.hostId ≠ binding.hostId (как сейчас) |
| `handoff_hash_mismatch` | переданный hash не сходится |
| `handoff_required_fields` | prior attempt без digest / accepted artifact без hash |

Одинаковый id+hash+**тот же** source — идемпотентный skip, не silent first с потерей второго source.

Политики: разные id при равном `contentHash` — **успех**. В snapshot оба id и один effective. Разный content — effective = пересечение capabilities и пересечение ненулевых constraints; `secretGrants` = пересечение имён, `secretDependencies` = объединение имён. Не требовать один id. Не union-grant.

MCP: каждый `agentVersion.mcpIds` → запись в `selectedMcps` с hash из каталога; иначе `unknown_mcp`. Невыбранные — exclusions. `selectedMcps` и hash входят в digest и в `prompt.levels.agent`.

## Prompt levels (не вместо structured)

- `agent`: добавить `model=…` и блок `MCP id hash=…` или `MCP none`.
- `handoff`: если `handoff === null` — одна строка `handoff none` (явный ввод). Если объект — attempt/digest, accepted artifacts, questions, returnReason. **Не** выдумывать `handoff/` path и не писать «no prior», когда caller передал пакет.

## Тесты (минимум)

1. Одинаковый snapshot, разный `model` → разные digest; `model` есть в snapshot.agentVersion.
2. Выбранный MCP в `selectedMcps` + hash в digest; без MCP в каталоге — `unknown_mcp`.
3. Policy: snapshot.effective содержит capabilities и secretRefs; смена capability меняет digest.
4. Binding policy id ≠ agent policy id, одинаковый payload → ok.
5. Разный payload → effective ∩ capabilities; пустое пересечение → fail.
6. Artifact с `jobId = parent` при parent в `authorizedInputJobIds` → ok; чужой job → `artifact_job_unauthorized`.
7. `handoff: null` vs пакет с prior digest — разные digest; битый hash → fail.
8. Каталог: один skill id+hash, source `plugin:agency` и `bb-user` → `catalog_skill_provenance_conflict`.
9. Регрессия: текущие relation mismatch и explicit skills без инъекции каталога.

## Критерий готовности волны

`compileContextSnapshot` по фиксированному input даёт snapshot, из которого без UI можно назвать: host/root/env, job+revision, agentVersion id+**model**+provider, обе policy id + effective capabilities, selected skills **и** MCP с hash, authorized input artifacts (включая upstream), handoff или явный none. Prompt остаётся пояснением, не единственным носителем этих полей.

Реализацию держать в `src/server/runtime/context-snapshot/**` + `tests/context-snapshot.test.ts`. UI/RPC/package не трогать.

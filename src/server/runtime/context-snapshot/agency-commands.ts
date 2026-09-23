/**
 * Поверхность текущего навыка `skills/agency/SKILL.md` v0.3.0 и `docs/cli.md`.
 * Скопировано сюда, чтобы компилятор не импортировал CLI/dispatcher.
 */
export const AGENCY_SKILL_COMMANDS = [
  "bb agency help",
  "bb agency --help",
  "bb agency -h",
  "bb agency schema <operation>",
  "bb agency --schema",
  "bb agency -s",
  "bb agency call <operation> --input-json '<payload>' [--json]",
  "bb agency catalog [--json]",
  "bb agency catalog capabilities [--input-json '<payload>'] [--json]",
  "bb agency skills",
  "bb agency workspace [--binding-id <id>] [--json]",
  "bb agency policy create --input-json '<payload>' [--json]",
  "bb agency agent create|get|save",
  "bb agency department create|get|save|membership",
  "bb agency project bind|get|link-department",
  "bb agency job create|get|state|decide|submit|update|assign|transition|report-needs-input|answer-needs-input",
  "bb agency artifact create|publish|open|accept|versions",
  "bb agency status [--json]",
  "bb agency notify <project-id> <event-id> <topic> <reference> [--json]",
] as const;

export const AGENCY_SKILL_FORBIDDEN_SURFACES = [
  "spawn",
  "raw RPC",
  "setCliPolicy",
  "dispatcher internals",
  "SQLite",
] as const;

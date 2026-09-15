import { CLI_EXAMPLES, POLICY_SCHEMA_NOTES, SKILL_SCHEMA_NOTES } from "./examples";
import { CLI_OPERATION_NAMES, CLI_OPERATIONS, isCliOperation, type CliRoutedOperation } from "./operations";
import { encodeCliJson } from "./format";

export const CLI_USAGE = `bb agency help
bb agency schema <operation>
bb agency call <operation> --input-json '<payload>' [--json]
bb agency catalog [--json]
bb agency catalog capabilities [--input-json '<payload>'] [--json]
bb agency workspace [--binding-id <id>] [--json]
bb agency policy create --input-json '<payload>' [--json]
bb agency agent create|get|save ...
bb agency department create|get|save|membership ...
bb agency project bind|get|link-department ...
bb agency job create|get|update|assign|transition|attach-input|report-needs-input|answer-needs-input|attempts|comment ...
bb agency artifact create|publish|open|accept|versions ...
bb agency launch prepare|get|reconcile|cancel|interpret-completion|readiness|attempts ...
bb agency status [--json]
bb agency notify <project-id> <event-id> <topic> <reference> [--json]
bb agency event definition-save|definition-list|source-save|source-list|ingest --input-json '...' [--json]
bb agency rule save|list --input-json '...' [--json]
bb agency dispatch tick --input-json '...' [--json]
bb agency intent list|claim --input-json '...' [--json]

bb CLI run исполняется на машине плагина (server), не на клиентском host чата.
Рецепты: --input-json (source=inline). --input-file/--bytes-file читают только
локальный диск этого server-процесса и требуют --source server-fs.
canonicalRoot из payload не является правом на чтение чужого host.
Новый BB project CLI не создаёт: только bind существующего каталога.
Spawn не обещать из help: смотри bb agency launch readiness / getIsolationReadiness
этого instance (GET spawn-contract + proven provider). Произвольный RPC закрыт allowlist.
bytesBase64 и значения секретов в stdout не печатаются.
`;

export const CLI_COMMAND_SPECS = [
  { name: "help", summary: "Список команд и allowlist", usage: "bb agency help" },
  { name: "schema", summary: "Полный payload операции", usage: "bb agency schema <operation>" },
  { name: "call", summary: "Allowlisted domain operation из JSON", usage: "bb agency call <operation> --input-json '<payload>'" },
  { name: "catalog", summary: "Каталог BB и capabilities", usage: "bb agency catalog [--json]" },
  { name: "workspace", summary: "Снимок сущностей и PolicyVersion", usage: "bb agency workspace [--binding-id <id>]" },
  { name: "policy", summary: "Неизменяемые политики", usage: "bb agency policy create --input-json '<payload>'" },
  { name: "agent", summary: "Сотрудник", usage: "bb agency agent create|get|save" },
  { name: "department", summary: "Отдел и membership", usage: "bb agency department create|get|save|membership" },
  { name: "project", summary: "Привязка существующего каталога", usage: "bb agency project bind|get|link-department" },
  { name: "job", summary: "Задача", usage: "bb agency job create|get|update|assign|transition|attach-input|report-needs-input|answer-needs-input|attempts|comment" },
  { name: "artifact", summary: "Версии файлов", usage: "bb agency artifact create|publish|open|accept|versions" },
  { name: "launch", summary: "prepare/get/reconcile/cancel; готовность — launch readiness этого instance", usage: "bb agency launch prepare|get|reconcile|cancel|readiness" },
  { name: "status", summary: "runtime + requires_readiness; не grant, смотри launch readiness с jobId", usage: "bb agency status [--json]" },
  { name: "notify", summary: "Сохранить уведомление без запуска", usage: "bb agency notify <project-id> <event-id> <topic> <reference> [--json]" },
  { name: "event", summary: "Definition/source/typed ingest; не replay notify", usage: "bb agency event definition-save|definition-list|source-save|source-list|ingest" },
  { name: "rule", summary: "Версия правила", usage: "bb agency rule save|list --input-json '...' [--json]" },
  { name: "dispatch", summary: "Tick inbox→intent; live off", usage: "bb agency dispatch tick --input-json '<payload>'" },
  { name: "intent", summary: "Outbox list/claim/approve; launch unavailable", usage: "bb agency intent list|claim|approve" },
];

export function resolveSchemaTarget(token: string | undefined): CliRoutedOperation | { error: string } {
  if (!token) return { error: "schema requires an allowlisted operation" };
  if (isCliOperation(token)) return token;
  return { error: `unknown operation ${token}` };
}

const JOB_COMMENT_SCHEMA_NOTES = [
  "Мутации требуют requestId (UUID).",
  "kind всегда comment; actor и kind в JSON отклоняются.",
  "Автор сотрудник только если trusted CLI threadId = current attempt.threadId и receipt.threadId, плюс snapshot agent.",
  "Без proof — честный user/system из service context, не выдуманный сотрудник.",
  "Пишет в существующую activity историю задачи.",
  "register run(argv, ctx) передаёт cliThreadId и jobComment port; не RPC и не handlers[operation].",
];

export function schemaDocument(operation: CliRoutedOperation) {
  return {
    operation,
    summary: CLI_OPERATIONS[operation].summary,
    example: CLI_EXAMPLES[operation],
    allowlist: CLI_OPERATION_NAMES,
    notes:
      operation === "createPolicyVersion" || operation === "listWorkspace"
        ? POLICY_SCHEMA_NOTES
        : operation === "provisionAgent" || operation === "saveAgentProfile"
          ? SKILL_SCHEMA_NOTES
          : operation === "createJobComment"
            ? JOB_COMMENT_SCHEMA_NOTES
            : [
              "Мутации требуют requestId (UUID).",
              "save/update/accept/transition требуют expectedRevision.",
              "Ответ domain: { ok: true, value } | { ok: false, error }.",
              "bytesBase64 и значения секретов в stdout не печатаются.",
            ],
  };
}

export function helpText(): string {
  const ops = CLI_OPERATION_NAMES.map((name) => `  ${name}  ${CLI_OPERATIONS[name].summary}`).join("\n");
  return `${CLI_USAGE}\nAllowlist:\n${ops}\n`;
}

export function schemaText(operation: CliRoutedOperation): string {
  return encodeCliJson(schemaDocument(operation));
}

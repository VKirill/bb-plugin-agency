import { notificationSchema, type AgencyStatus } from "../../shared/schemas";
import type { Activity } from "../../shared/contracts";
import type { DomainResult } from "../../domain";
import { inputFromFlags, resolveAlias } from "./aliases";
import { cliFailure, encodeCliJson } from "./format";
import { CLI_OPERATIONS, isCliOperation, type CliOperation, type CliRoutedOperation } from "./operations";
import { parseAgencyArgv } from "./parse";
import { FILE_SOURCE_REQUIRED, loadCliPayload } from "./payload";
import { fillPublishBytesFromServerFile } from "./publish-bytes";
import { helpText, resolveSchemaTarget, schemaText } from "./schema-help";

export type AgencyCliResult = { exitCode: number; stdout: string; stderr?: string };

export type AgencyCliDeps = {
  status: () => AgencyStatus;
  notify: (input: unknown, source: "rpc" | "cli") => {
    eventId: string;
    accepted: true;
    duplicate: boolean;
    state: "pending";
    execution: "unavailable";
  };
  dispatch: (operation: CliOperation, input: unknown) => Promise<unknown>;
  /** Trusted PluginCliContext.threadId from register run(argv, ctx). Not a payload field. */
  cliThreadId?: string | null;
  /** Plugin CLI abort when the HTTP request disconnects. */
  cliSignal?: AbortSignal;
  /** Native composer choice card for waiting_input in this origin chat. */
  askOwner?: (input: {
    threadId: string | null;
    overlay?: unknown;
    signal?: AbortSignal;
  }) => Promise<AgencyCliResult>;
  /** Production: bindJobCommentHandler in register.ts. Tests may omit. */
  jobComment?: (
    input: unknown,
    proof: { threadId: string | null },
  ) => Promise<DomainResult<Activity>> | DomainResult<Activity>;
};

const WRITE_OPERATIONS = new Set<CliRoutedOperation>([
  "createPolicyVersion",
  "provisionAgent",
  "saveAgentProfile",
  "provisionDepartment",
  "saveDepartmentProfile",
  "addMembership",
  "removeMembership",
  "createProjectBinding",
  "saveSessionPolicy",
  "linkDepartment",
  "unlinkDepartment",
  "archiveProjectBinding",
  "restoreProjectBinding",
  "deleteProjectBinding",
  "setDepartmentAvailability",
  "saveWorkRules",
  "saveTemplate",
  "saveKnowledge",
  "saveIdea",
  "setIdeaStatus",
  "spawnIdeaThread",
  "saveDecisionSettings",
  "setSkillPool",
  "setKnowledgeStatus",
  "setJobGoal",
  "saveAgencyRules",
  "saveProjectRules",
  "createJob",
  "updateJob",
  "addJobDependency",
  "removeJobDependency",
  "setJobNextStep",
  "notifyOwner",
  "installStarterKit",
  "translateStarterKit",
  "archiveDepartment",
  "restoreDepartment",
  "deleteDepartment",
  "deleteAgent",
  "markOwnerMessagesRead",
  "ownerDigest",
  "transitionJob",
  "createArtifact",
  "publishArtifactVersion",
  "attachJobInput",
  "reportNeedsInput",
  "answerNeedsInput",
  "acceptArtifactVersion",
  "prepareLaunch",
  "reconcileLaunch",
  "cancelLaunch",
  "enqueueLaunch",
  "dequeueLaunch",
  "returnJobForRework",
  "recoverJob",
  "saveEventDefinition",
  "saveEventSource",
  "saveRuleVersion",
  "ingestInboxEvent",
  "dispatchTick",
  "claimActionIntent",
  "approveActionIntent",
  "completeActionIntent",
  "recordLeadDecision",
  "submitJobResult",
  "createJobComment",
]);

function mergeInput(file: Record<string, unknown>, flags: Record<string, unknown>): Record<string, unknown> {
  return { ...file, ...Object.fromEntries(Object.entries(flags).filter(([, value]) => value !== undefined)) };
}

async function runOperation(deps: AgencyCliDeps, operation: CliRoutedOperation, raw: Record<string, unknown>): Promise<AgencyCliResult> {
  const spec = CLI_OPERATIONS[operation];
  const parsed = spec.input.safeParse(raw);
  if (!parsed.success) {
    return cliFailure("invalid_command", parsed.error.message);
  }
  let result: unknown;
  try {
    if (operation === "createJobComment") {
      if (!deps.jobComment) {
        return cliFailure(
          "not_implemented",
          "createJobComment requires jobComment port (bindJobCommentHandler)",
        );
      }
      result = await deps.jobComment(parsed.data, { threadId: deps.cliThreadId ?? null });
    } else {
      result = await deps.dispatch(operation, parsed.data);
    }
  } catch (error) {
    return cliFailure("dispatch_failed", error instanceof Error ? error.message : String(error));
  }
  if (result && typeof result === "object" && "ok" in result && (result as { ok: unknown }).ok === false) {
    const error = (result as { error?: { code?: string; message?: string } }).error;
    return cliFailure(error?.code ?? "domain_error", error?.message ?? "domain failed");
  }
  return { exitCode: 0, stdout: encodeCliJson(result) };
}

export async function runAgencyCli(deps: AgencyCliDeps, argv: string[]): Promise<AgencyCliResult> {
  const parsed = parseAgencyArgv(argv);
  if ("error" in parsed) return cliFailure("invalid_command", parsed.error);
  const { tokens, flags } = parsed;
  const [command, ...rest] = tokens;

  if (!command || command === "help" || command === "--help") {
    return { exitCode: 0, stdout: helpText() };
  }
  if (command === "schema") {
    const target = resolveSchemaTarget(rest[0]);
    if (typeof target !== "string") return cliFailure("unknown_operation", target.error);
    if (rest.length > 1) return cliFailure("invalid_command", "schema takes one operation");
    return { exitCode: 0, stdout: schemaText(target) };
  }
  if (command === "status") {
    if (rest.length > 0) return cliFailure("invalid_command", "status takes no arguments");
    const value = deps.status();
    return {
      exitCode: 0,
      stdout: flags.json ? JSON.stringify(value) : `${value.reason} Уведомлений: ${value.inboxCount}.`,
    };
  }
  if (command === "notify") {
    if (rest.length !== 4) return cliFailure("invalid_command", "notify requires project-id event-id topic reference");
    const [projectId, eventId, topic, reference] = rest;
    const body = notificationSchema.safeParse({ projectId, eventId, topic, reference });
    if (!body.success) return cliFailure("invalid_command", body.error.message);
    try {
      const receipt = deps.notify(body.data, "cli");
      return {
        exitCode: 0,
        stdout: flags.json
          ? JSON.stringify(receipt)
          : `${receipt.duplicate ? "Уже сохранено" : "Сохранено"}: ${receipt.eventId}. Агент не запускается.`,
      };
    } catch (error) {
      return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error), stdout: "" };
    }
  }

  if (command === "job" && rest[0] === "ask-owner") {
    if (rest.length !== 1) return cliFailure("invalid_command", "job ask-owner takes no extra tokens");
    if (!deps.askOwner) {
      return cliFailure("not_implemented", "job ask-owner requires askOwner port");
    }
    const loaded = await loadCliPayload(flags);
    if (!loaded.ok) return cliFailure("invalid_command", loaded.message);
    return deps.askOwner({ threadId: deps.cliThreadId ?? null, overlay: loaded.value, signal: deps.cliSignal });
  }

  if (command === "call" && rest.length !== 1) {
    return cliFailure("invalid_command", "call <allowlisted-operation> --input-json '<payload>'");
  }

  const alias = resolveAlias(tokens);
  if (typeof alias !== "string") {
    if ("unsupported" in alias) return cliFailure("unsupported_command", alias.unsupported);
    const code = alias.error.startsWith("unknown") ? "unknown_command" : "invalid_command";
    return cliFailure(code, alias.error);
  }
  if (!isCliOperation(alias)) return cliFailure("unknown_command", "unknown operation");

  const loaded = await loadCliPayload(flags);
  if (!loaded.ok) return cliFailure("invalid_command", loaded.message);
  if (WRITE_OPERATIONS.has(alias) && !flags.inputJson && !flags.inputFile) {
    return cliFailure("invalid_command", `${alias} requires --input-json (or --input-file --source server-fs)`);
  }

  let raw = mergeInput(loaded.value, inputFromFlags(alias, flags));
  if (alias === "publishArtifactVersion" && flags.bytesFile) {
    if (flags.source !== "server-fs") return cliFailure("invalid_command", FILE_SOURCE_REQUIRED);
    const filled = await fillPublishBytesFromServerFile(raw, flags.bytesFile);
    if (!filled.ok) return cliFailure("invalid_command", filled.message);
    raw = filled.value;
  }

  return runOperation(deps, alias, raw);
}

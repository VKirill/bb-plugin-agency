import { isCliOperation, type CliRoutedOperation } from "./operations";
import type { CliFlags } from "./parse";

export function resolveAlias(tokens: string[]): CliRoutedOperation | { error: string } | { unsupported: string } {
  const [head, ...rest] = tokens;
  if (!head) return { error: "command required" };
  if (head === "call") {
    const operation = rest[0];
    if (!operation) return { error: "call requires an allowlisted operation" };
    if (!isCliOperation(operation)) return { error: `unknown operation ${operation}` };
    return operation;
  }

  if (head === "catalog" && rest.length === 0) return "listBbCatalog";
  if (head === "catalog" && rest[0] === "capabilities" && rest.length === 1) return "listCapabilityCatalog";
  if (head === "workspace" && rest.length === 0) return "listWorkspace";
  if (head === "policy" && rest[0] === "create" && rest.length === 1) return "createPolicyVersion";
  if (head === "agent" && rest.length === 1) {
    if (rest[0] === "create") return "provisionAgent";
    if (rest[0] === "get") return "getAgent";
    if (rest[0] === "save") return "saveAgentProfile";
  }
  if (head === "department" && rest[0] === "membership" && rest.length === 2) {
    if (rest[1] === "add") return "addMembership";
    if (rest[1] === "remove") return "removeMembership";
  }
  if (head === "department" && rest.length === 1) {
    if (rest[0] === "create") return "provisionDepartment";
    if (rest[0] === "get") return "getDepartment";
    if (rest[0] === "save") return "saveDepartmentProfile";
  }
  if (head === "project") {
    if (rest[0] === "create") return { unsupported: "creating a BB project is unsupported; bind an existing catalog" };
    if (rest[0] === "bind" && rest.length === 1) return "createProjectBinding";
    if (rest[0] === "get" && rest.length === 1) return "listWorkspace";
    if (rest[0] === "link-department" && rest.length === 1) return "linkDepartment";
  }
  if (head === "job" && rest.length === 1) {
    if (rest[0] === "create") return "createJob";
    if (rest[0] === "get") return "getJob";
    if (rest[0] === "update" || rest[0] === "assign") return "updateJob";
    if (rest[0] === "transition") return "transitionJob";
    if (rest[0] === "attach-input") return "attachJobInput";
    if (rest[0] === "report-needs-input") return "reportNeedsInput";
    if (rest[0] === "answer-needs-input") return "answerNeedsInput";
    if (rest[0] === "attempts") return "listJobAttempts";
    if (rest[0] === "comment") return "createJobComment";
  }
  if (head === "launch" && rest.length === 1) {
    if (rest[0] === "prepare") return "prepareLaunch";
    if (rest[0] === "get") return "getLaunch";
    if (rest[0] === "reconcile") return "reconcileLaunch";
    if (rest[0] === "interpret-completion") return "interpretWorkerCompletion";
    if (rest[0] === "readiness") return "getIsolationReadiness";
    if (rest[0] === "cancel") return "cancelLaunch";
    if (rest[0] === "attempts") return "listJobAttempts";
  }
  if (head === "event" && rest.length === 1) {
    if (rest[0] === "definition-save") return "saveEventDefinition";
    if (rest[0] === "definition-list") return "listEventDefinitions";
    if (rest[0] === "source-save") return "saveEventSource";
    if (rest[0] === "source-list") return "listEventSources";
    if (rest[0] === "ingest") return "ingestInboxEvent";
  }
  if (head === "rule" && rest[0] === "save" && rest.length === 1) return "saveRuleVersion";
  if (head === "rule" && rest[0] === "list" && rest.length === 1) return "listRuleVersions";
  if (head === "dispatch" && rest[0] === "tick" && rest.length === 1) return "dispatchTick";
  if (head === "intent" && rest.length === 1) {
    if (rest[0] === "list") return "listActionIntents";
    if (rest[0] === "claim") return "claimActionIntent";
    if (rest[0] === "approve") return "approveActionIntent";
    if (rest[0] === "complete") return "completeActionIntent";
  }
  if (head === "artifact" && rest.length === 1) {
    if (rest[0] === "create") return "createArtifact";
    if (rest[0] === "publish") return "publishArtifactVersion";
    if (rest[0] === "open") return "openArtifact";
    if (rest[0] === "accept") return "acceptArtifactVersion";
    if (rest[0] === "versions") return "listArtifactVersions";
  }
  return { error: `unknown command ${tokens.join(" ")}` };
}

export function inputFromFlags(operation: CliRoutedOperation, flags: CliFlags): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (flags.agentId && (operation === "getAgent" || operation === "saveAgentProfile")) input.agentId = flags.agentId;
  if (flags.departmentId && (operation === "getDepartment" || operation === "saveDepartmentProfile")) {
    input.departmentId = flags.departmentId;
  }
  if (flags.jobId) input.jobId = flags.jobId;
  if (flags.key && operation === "getJob") input.key = flags.key;
  if (flags.bindingId && (operation === "listWorkspace" || operation === "listCapabilityCatalog")) {
    input.bindingId = flags.bindingId;
  }
  if (flags.claimedBbProjectId) input.claimedBbProjectId = flags.claimedBbProjectId;
  return input;
}

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

  if (head === "context" && rest.length === 1) {
    if (rest[0] === "get") return "getWorkerContext";
    if (rest[0] === "save") return "saveWorkerContext";
  }
  if (head === "trace" && rest.length === 0) return "listTrace";
  if (head === "job" && rest[0] === "diagnose") return "getJobDiagnostics";
  if (head === "catalog" && rest.length === 0) return "listBbCatalog";
  if (head === "catalog" && rest[0] === "capabilities" && rest.length === 1) return "listCapabilityCatalog";
  if (head === "workspace" && rest.length === 0) return "listWorkspace";
  if (head === "notify-owner" && rest.length === 0) return "notifyOwner";
  if (head === "kit" && rest.length === 1) {
    if (rest[0] === "list") return "starterKit";
    if (rest[0] === "install") return "installStarterKit";
    if (rest[0] === "translate") return "translateStarterKit";
  }
  if (head === "digest" && rest.length === 0) return "ownerDigest";
  if (head === "scripts" && rest.length === 0) return "listScriptTemplates";
  if (head === "owner" && rest.length === 1) {
    if (rest[0] === "messages") return "listOwnerMessages";
    if (rest[0] === "read") return "markOwnerMessagesRead";
  }
  if (head === "usage" && rest.length === 0) return "listDashboardUsage";
  if (head === "usage" && rest.length === 1 && rest[0] === "providers") return "providerUsage";
  if (head === "rules" && rest.length === 1) {
    if (rest[0] === "get") return "getWorkRules";
    if (rest[0] === "save") return "saveWorkRules";
    if (rest[0] === "budgets") return "listBudgets";
    if (rest[0] === "agency-get") return "getAgencyRules";
    if (rest[0] === "agency-save") return "saveAgencyRules";
  }
  if (head === "knowledge" && rest.length === 1) {
    if (rest[0] === "feedback") return "recordLessonFeedback";
    if (rest[0] === "list") return "listKnowledge";
    if (rest[0] === "get") return "getKnowledge";
    if (rest[0] === "save") return "saveKnowledge";
    if (rest[0] === "status") return "setKnowledgeStatus";
  }
  if ((head === "idea" || head === "ideas") && rest.length === 1) {
    if (rest[0] === "list") return "listIdeas";
    if (rest[0] === "get") return "getIdea";
    if (rest[0] === "save") return "saveIdea";
    if (rest[0] === "status") return "setIdeaStatus";
    if (rest[0] === "thread") return "spawnIdeaThread";
  }
  if (head === "decisions" && rest.length === 1) {
    if (rest[0] === "get") return "getDecisionSettings";
    if (rest[0] === "save") return "saveDecisionSettings";
    if (rest[0] === "test") return "testDecisionModel";
    if (rest[0] === "log") return "listDecisionLog";
    if (rest[0] === "probe") return "probeDecisionPoints";
  }
  if (head === "goal" && rest.length === 1) {
    if (rest[0] === "list") return "listGoals";
    if (rest[0] === "link") return "setJobGoal";
  }
  if (head === "job" && rest.length === 1 && rest[0] === "search") return "searchJobs";
  if (head === "job" && rest.length === 1 && rest[0] === "archive") return "listArchivedJobs";
  if (head === "agent" && rest.length === 1 && rest[0] === "metrics") return "agentMetrics";
  if (head === "profile" && rest.length === 1) {
    if (rest[0] === "list") return "listWorkProfiles";
    if (rest[0] === "save") return "saveWorkProfile";
    if (rest[0] === "delete") return "deleteWorkProfile";
  }
  if (head === "passport" && rest.length === 1) {
    if (rest[0] === "show") return "getProjectPassport";
    if (rest[0] === "save") return "savePassport";
    if (rest[0] === "build") return "buildProjectPassport";
    if (rest[0] === "rollback") return "rollbackPassport";
    if (rest[0] === "settings") return "getPassportSettings";
    if (rest[0] === "settings-save") return "savePassportSettings";
  }
  if (head === "skills" && rest.length === 1) {
    if (rest[0] === "pool") return "getSkillPool";
    if (rest[0] === "pool-save") return "setSkillPool";
    if (rest[0] === "grants") return "listSkillGrants";
  }
  if (head === "skills" && rest.length === 1 && rest[0] === "pins") return "getSkillPins";
  if (head === "skills" && rest.length === 1 && rest[0] === "pin") return "pinSkills";
  if (head === "agent" && rest.length === 1 && rest[0] === "models") return "agentModels";
  if (head === "agent" && rest.length === 1 && rest[0] === "repair-models") return "repairAgentModels";
  if (head === "templates" && rest.length === 1) {
    if (rest[0] === "list") return "listTemplates";
    if (rest[0] === "save") return "saveTemplate";
  }
  if (head === "policy" && rest[0] === "create" && rest.length === 1) return "createPolicyVersion";
  if (head === "agent" && rest.length === 1) {
    if (rest[0] === "create") return "provisionAgent";
    if (rest[0] === "get") return "getAgent";
    if (rest[0] === "save") return "saveAgentProfile";
    if (rest[0] === "delete") return "deleteAgent";
  }
  if (head === "department" && rest[0] === "membership" && rest.length === 2) {
    if (rest[1] === "add") return "addMembership";
    if (rest[1] === "remove") return "removeMembership";
  }
  if (head === "department" && rest.length === 1) {
    if (rest[0] === "create") return "provisionDepartment";
    if (rest[0] === "get") return "getDepartment";
    if (rest[0] === "save") return "saveDepartmentProfile";
    if (rest[0] === "availability") return "setDepartmentAvailability";
    if (rest[0] === "archive") return "archiveDepartment";
    if (rest[0] === "restore") return "restoreDepartment";
    if (rest[0] === "delete") return "deleteDepartment";
  }
  if (head === "project") {
    if (rest[0] === "create") return { unsupported: "creating a BB project is unsupported; bind an existing catalog" };
    if (rest[0] === "bind" && rest.length === 1) return "createProjectBinding";
    if (rest[0] === "get" && rest.length === 1) return "listWorkspace";
    if (rest[0] === "link-department" && rest.length === 1) return "linkDepartment";
    if (rest[0] === "unlink-department" && rest.length === 1) return "unlinkDepartment";
    if (rest[0] === "archive" && rest.length === 1) return "archiveProjectBinding";
    if (rest[0] === "restore" && rest.length === 1) return "restoreProjectBinding";
    if (rest[0] === "delete" && rest.length === 1) return "deleteProjectBinding";
    if (rest[0] === "rules" && rest.length === 1) return "readProjectRules";
    if (rest[0] === "rules-save" && rest.length === 1) return "saveProjectRules";
    if (rest[0] === "session" && rest[1] === "get") return "getSessionPolicy";
    if (rest[0] === "session" && rest[1] === "save") return "saveSessionPolicy";
  }
  if (head === "session" && rest.length === 1) {
    if (rest[0] === "get") return "getSessionPolicy";
    if (rest[0] === "save") return "saveSessionPolicy";
  }
  if (head === "job" && rest.length === 1) {
    if (rest[0] === "create") return "createJob";
    if (rest[0] === "get") return "getJob";
    if (rest[0] === "update" || rest[0] === "assign") return "updateJob";
    if (rest[0] === "transition") return "transitionJob";
    if (rest[0] === "attach-input") return "attachJobInput";
    if (rest[0] === "depend") return "addJobDependency";
    if (rest[0] === "undepend") return "removeJobDependency";
    if (rest[0] === "next-step") return "setJobNextStep";
    if (rest[0] === "report-needs-input") return "reportNeedsInput";
    if (rest[0] === "answer-needs-input") return "answerNeedsInput";
    if (rest[0] === "stale-answer") return "staleAnswer";
    if (rest[0] === "attempts") return "listJobAttempts";
    if (rest[0] === "state") return "getLeadState";
    if (rest[0] === "decide") return "recordLeadDecision";
    if (rest[0] === "submit") return "submitJobResult";
    if (rest[0] === "comment") return "createJobComment";
    if (rest[0] === "usage") return "listDashboardUsage";
    if (rest[0] === "recover") return "recoverJob";
    if (rest[0] === "return") return "returnJobForRework";
  }
  if (head === "launch" && rest.length === 1) {
    if (rest[0] === "prepare") return "prepareLaunch";
    if (rest[0] === "get") return "getLaunch";
    if (rest[0] === "reconcile") return "reconcileLaunch";
    if (rest[0] === "interpret-completion") return "interpretWorkerCompletion";
    if (rest[0] === "readiness") return "getIsolationReadiness";
    if (rest[0] === "cancel") return "cancelLaunch";
    if (rest[0] === "attempts") return "listJobAttempts";
    if (rest[0] === "queue") return "enqueueLaunch";
    if (rest[0] === "unqueue") return "dequeueLaunch";
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

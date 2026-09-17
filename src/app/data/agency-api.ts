import type { OwnerMessageView, StarterKitViewRecord } from "../../shared/rpc-contract";
import type { AgentMetricsView, BackupFileView, DependencyLinkRecord, GoalViewRecord, JobNextStepRecord, JobSearchHitView, KnowledgeItemView, NextStepViewRecord, PluginDirectoryView, SavedViewRecord } from "../../shared/rpc-contract";
import type { RuleScheduleView, WebhookSourceView } from "../../shared/rpc-contract";
import type { AgencyRulesView, TemplateView } from "../../shared/rpc-contract";
import type { BudgetStatusView, ProviderUsageView } from "../../shared/rpc-contract";
import type { SaveWorkRulesCommand, WorkRulesView } from "../../shared/contracts/work-rules";
import type {
  AcceptArtifactVersionCommand,
  Activity,
  Agent,
  AgentVersion,
  Artifact,
  ArtifactVersion,
  CreateAgentVersionCommand,
  CreateJobCommand,
  CreateMembershipCommand,
  RemoveMembershipCommand,
  CreatePolicyVersionCommand,
  CreateProcessVersionCommand,
  CreateProjectBindingCommand,
  SaveAgentProfileCommand,
  SaveDepartmentProfileCommand,
  Department,
  Job,
  JobTransitionCommand,
  AnswerNeedsInputCommand,
  AnswerNeedsInputRecord,
  ApproveActionIntentCommand,
  ActionIntentRecord,
  CatalogRuleRecord,
  EventDefinitionRecord,
  EventSourceRecord,
  ListedActionIntent,
  ClaimActionIntentCommand,
  DispatchTickCommand,
  DispatchTickRecord,
  InboxEventRecord,
  IngestInboxEventCommand,
  NeedsInputRecord,
  SaveEventDefinitionCommand,
  SaveEventSourceCommand,
  SaveRuleVersionCommand,
  Membership,
  PolicyVersion,
  ProcessVersion,
  ProjectBinding,
  ProjectDepartment,
  UpdateAgentCommand,
  UpdateDepartmentCommand,
  UpdateJobCommand,
  UpdateProjectBindingCommand,
} from "../../shared/contracts";
import type { MutationOutcome } from "./envelope";
import type {
  CreateActivityRpc,
  CreateArtifactRpc,
  OpenArtifactResult,
  ResolveArtifactPreviewRpc,
  ResolvedArtifactPreview,
  BbCatalog,
  CapabilityCatalog,
  OpenArtifactRpc,
  ProvisionAgentInput,
  ProvisionDepartmentInput,
  PublishArtifactRpc,
} from "./store-commands";
import type { WorkspaceSnapshot } from "./snapshot";
import type { ListDashboardUsageInput, ListDashboardUsageOutput } from "../../shared/contracts/dashboard-usage";
import type { CompletionView, IsolationReadiness, JobLaunchItem, LaunchCoordinatorView, LaunchReceiptView, PrepareLaunchView } from "./launch-rpc";

export type JobDetail = {
  job: Job;
  binding: ProjectBinding;
  activity: Activity[];
  dependencies: { jobId: string; dependsOnJobId: string }[];
  /** Both directions of the dependencies, with key, title and state; absent on older servers. */
  links?: { waitsFor: DependencyLinkRecord[]; blocks: DependencyLinkRecord[] };
  nextStep?: NextStepViewRecord | null;
  artifacts: { artifact: Artifact; versions: ArtifactVersion[] }[];
  needsInput: NeedsInputRecord | null;
};

export type AgentDetail = {
  agent: Agent;
  version?: AgentVersion;
};

export type DepartmentDetail = {
  department: Department;
  process?: ProcessVersion;
  memberships: Membership[];
};

export type LoadWorkspaceResult =
  | { status: "ready"; snapshot: WorkspaceSnapshot }
  | { status: "unavailable"; message: string }
  | { status: "gated"; message: string }
  | { status: "error"; message: string };

export interface AgencyApi {
  loadWorkspace(input?: { bindingId?: string; claimedBbProjectId?: string }): Promise<LoadWorkspaceResult>;
  getJob(input: { jobId?: string; key?: string; claimedBbProjectId?: string }): Promise<MutationOutcome<JobDetail>>;
  getAgent(input: { agentId: string }): Promise<MutationOutcome<AgentDetail>>;
  getDepartment(input: { departmentId: string }): Promise<MutationOutcome<DepartmentDetail>>;
  listActivity(input: { jobId: string; claimedBbProjectId?: string }): Promise<MutationOutcome<Activity[]>>;
  listArtifactVersions(input: { artifactId: string; jobId: string; claimedBbProjectId?: string }): Promise<MutationOutcome<ArtifactVersion[]>>;
  listBbCatalog(): Promise<MutationOutcome<BbCatalog>>;
  listCapabilityCatalog(input?: { bindingId?: string; projectId?: string; environmentId?: string | null }): Promise<MutationOutcome<CapabilityCatalog>>;
  createPolicyVersion(input: CreatePolicyVersionCommand): Promise<MutationOutcome<PolicyVersion>>;
  createAgentVersion(input: CreateAgentVersionCommand): Promise<MutationOutcome<AgentVersion>>;
  createProcessVersion(input: CreateProcessVersionCommand): Promise<MutationOutcome<ProcessVersion>>;
  saveAgentProfile(input: SaveAgentProfileCommand): Promise<MutationOutcome<{ agent: Agent; version: AgentVersion }>>;
  saveDepartmentProfile(
    input: SaveDepartmentProfileCommand,
  ): Promise<MutationOutcome<{ department: Department; process: ProcessVersion; memberships: Membership[] }>>;
  provisionAgent(input: ProvisionAgentInput): Promise<MutationOutcome<{ agent: Agent; version: AgentVersion }>>;
  updateAgent(input: UpdateAgentCommand): Promise<MutationOutcome<Agent>>;
  provisionDepartment(input: ProvisionDepartmentInput): Promise<MutationOutcome<{ department: Department; process: ProcessVersion; membership: Membership }>>;
  updateDepartment(input: UpdateDepartmentCommand): Promise<MutationOutcome<Department>>;
  addMembership(input: CreateMembershipCommand): Promise<MutationOutcome<Membership>>;
  removeMembership(input: RemoveMembershipCommand): Promise<MutationOutcome<Membership>>;
  createProjectBinding(input: CreateProjectBindingCommand): Promise<MutationOutcome<ProjectBinding>>;
  updateProjectBinding(input: UpdateProjectBindingCommand & { claimedBbProjectId?: string }): Promise<MutationOutcome<ProjectBinding>>;
  linkDepartment(input: { requestId: string; bindingId: string; departmentId: string; claimedBbProjectId?: string }): Promise<MutationOutcome<ProjectDepartment>>;
  unlinkDepartment(input: { requestId: string; bindingId: string; departmentId: string }): Promise<MutationOutcome<ProjectDepartment>>;
  archiveProjectBinding(input: { requestId: string; expectedRevision: number; bindingId: string }): Promise<MutationOutcome<ProjectBinding>>;
  restoreProjectBinding(input: { requestId: string; expectedRevision: number; bindingId: string }): Promise<MutationOutcome<ProjectBinding>>;
  deleteProjectBinding(input: { requestId: string; expectedRevision: number; bindingId: string }): Promise<MutationOutcome<{ bindingId: string }>>;
  setDepartmentAvailability(input: { requestId: string; expectedRevision: number; departmentId: string; availability: "all" | "selected" }): Promise<MutationOutcome<Department>>;
  readProjectRules(input: { bindingId: string }): Promise<MutationOutcome<ProjectRulesFile>>;
  saveProjectRules(input: { requestId: string; bindingId: string; expectedHash: string | null; text: string }): Promise<MutationOutcome<{ bindingId: string; relativePath: string; hash: string; size: number }>>;
  createJob(input: CreateJobCommand & { claimedBbProjectId?: string }): Promise<MutationOutcome<Job>>;
  updateJob(input: UpdateJobCommand & { claimedBbProjectId?: string }): Promise<MutationOutcome<Job>>;
  transitionJob(input: JobTransitionCommand & { claimedBbProjectId?: string }): Promise<MutationOutcome<Job>>;
  returnJobForRework(input: { requestId: string; jobId: string; expectedRevision: number; comment: string }): Promise<MutationOutcome<Job>>;
  getWorkRules(input: { scope: string }): Promise<MutationOutcome<WorkRulesView>>;
  saveWorkRules(input: SaveWorkRulesCommand): Promise<MutationOutcome<WorkRulesView>>;
  listBudgets(): Promise<MutationOutcome<BudgetStatusView[]>>;
  providerUsage(): Promise<MutationOutcome<ProviderUsageView[]>>;
  listTemplates(): Promise<MutationOutcome<TemplateView[]>>;
  saveTemplate(input: { key: TemplateView["key"]; expectedRevision: number; text: string | null }): Promise<MutationOutcome<TemplateView>>;
  getAgencyRules(): Promise<MutationOutcome<AgencyRulesView>>;
  saveAgencyRules(input: { expectedVersion: number; text: string }): Promise<MutationOutcome<AgencyRulesView>>;
  enqueueLaunch(input: { requestId: string; jobId: string; expectedRevision: number }): Promise<MutationOutcome<{ jobId: string; position: number; requestedAt: string; waitingReason: string | null }>>;
  dequeueLaunch(input: { jobId: string }): Promise<MutationOutcome<{ removed: boolean }>>;
  saveRuleSchedule(input: RuleScheduleView): Promise<MutationOutcome<RuleScheduleView>>;
  listRuleSchedules(): Promise<MutationOutcome<RuleScheduleView[]>>;
  previewSchedule(input: { expression: string; timezone: string }): Promise<MutationOutcome<string[]>>;
  getWebhookSource(input: { sourceId: string }): Promise<MutationOutcome<WebhookSourceView>>;
  rotateWebhookSecret(input: { sourceId: string }): Promise<MutationOutcome<WebhookSourceView & { secret: string }>>;
  saveSourceTopics(input: { sourceId: string; topics: string[] }): Promise<MutationOutcome<WebhookSourceView>>;
  listBackups(): Promise<MutationOutcome<BackupFileView[]>>;
  createBackup(): Promise<MutationOutcome<BackupFileView>>;
  restoreBackup(input: { name: string }): Promise<MutationOutcome<{ restored: string; safetyBackup: BackupFileView; tables: number }>>;
  listKnowledge(): Promise<MutationOutcome<KnowledgeItemView[]>>;
  saveKnowledge(input: { id?: string; expectedRevision: number; title: string; body: string; source: string; scopeKind: KnowledgeItemView["scopeKind"]; scopeId: string | null }): Promise<MutationOutcome<KnowledgeItemView>>;
  setKnowledgeStatus(input: { id: string; expectedRevision: number; status: KnowledgeItemView["status"] }): Promise<MutationOutcome<KnowledgeItemView>>;
  listGoals(): Promise<MutationOutcome<GoalViewRecord[]>>;
  saveGoal(input: { id?: string; expectedRevision: number; title: string; description: string; status: GoalViewRecord["status"]; dueAt: string | null }): Promise<MutationOutcome<GoalViewRecord>>;
  setJobGoal(input: { jobId: string; goalId: string | null }): Promise<MutationOutcome<{ jobId: string; goalId: string | null }>>;
  setDepartmentParent(input: { departmentId: string; parentDepartmentId: string | null }): Promise<MutationOutcome<{ departmentId: string; parentDepartmentId: string | null }>>;
  agentMetrics(input: { agentId: string }): Promise<MutationOutcome<AgentMetricsView>>;
  searchJobs(input: { query: string; limit?: number }): Promise<MutationOutcome<JobSearchHitView[]>>;
  listArchivedJobs(input: { limit?: number; offset?: number }): Promise<MutationOutcome<{ total: number; jobs: Job[] }>>;
  listSavedViews(): Promise<MutationOutcome<SavedViewRecord[]>>;
  listPlugins(): Promise<MutationOutcome<PluginDirectoryView>>;
  starterKit(input: { language?: "ru" | "en" }): Promise<MutationOutcome<StarterKitViewRecord>>;
  installStarterKit(input: { keys: string[]; language?: "ru" | "en" }): Promise<MutationOutcome<{ installed: { key: string; departmentId: string; agents: number; note?: string }[]; skipped: { key: string; reason: string }[] }>>;
  translateStarterKit(input: { language?: "ru" | "en" }): Promise<MutationOutcome<{ translated: number; unchanged: number; edited: { kind: "department" | "agent"; name: string }[] }>>;
  recordLifecycle(input: { kind: "department" | "agent"; id: string }): Promise<MutationOutcome<{ deletable: boolean; reason: string | null; archivedAt: string | null }>>;
  archiveDepartment(input: { departmentId: string }): Promise<MutationOutcome<{ archivedAt: string }>>;
  restoreDepartment(input: { departmentId: string }): Promise<MutationOutcome<{ restored: true }>>;
  deleteDepartment(input: { departmentId: string }): Promise<MutationOutcome<{ deleted: true }>>;
  deleteAgent(input: { agentId: string }): Promise<MutationOutcome<{ deleted: true }>>;
  listOwnerMessages(input: { limit?: number }): Promise<MutationOutcome<{ messages: OwnerMessageView[]; unread: number }>>;
  markOwnerMessagesRead(input: { ids?: string[] }): Promise<MutationOutcome<{ marked: number }>>;
  addJobDependency(input: { requestId: string; jobId: string; dependsOnJobId: string }): Promise<MutationOutcome<{ jobId: string; dependsOnJobId: string }>>;
  removeJobDependency(input: { jobId: string; dependsOnJobId: string }): Promise<MutationOutcome<{ removed: boolean }>>;
  setJobNextStep(input: { jobId: string; step: (Omit<JobNextStepRecord, "assignment"> & { assignment?: JobNextStepRecord["assignment"] }) | null }): Promise<MutationOutcome<NextStepViewRecord | null>>;
  saveSavedView(input: { id?: string; name: string; filters: Record<string, string> }): Promise<MutationOutcome<SavedViewRecord>>;
  deleteSavedView(input: { id: string }): Promise<MutationOutcome<{ removed: boolean }>>;
  cancelLaunch(input: { requestId: string; jobId: string; attemptId: string; expectedJobRevision: number; expectedAttemptRevision: number; launchId: string; threadId: string; reason: string }): Promise<MutationOutcome<{ jobId: string; jobState: string; attemptState: string }>>;
  createActivity(input: CreateActivityRpc): Promise<MutationOutcome<Activity>>;
  createArtifact(input: CreateArtifactRpc): Promise<MutationOutcome<Artifact>>;
  publishArtifactVersion(input: PublishArtifactRpc): Promise<MutationOutcome<ArtifactVersion>>;
  acceptArtifactVersion(input: AcceptArtifactVersionCommand & { claimedBbProjectId?: string }): Promise<MutationOutcome<ArtifactVersion>>;
  openArtifact(input: OpenArtifactRpc): Promise<MutationOutcome<OpenArtifactResult>>;
  resolveArtifactPreview(input: ResolveArtifactPreviewRpc): Promise<MutationOutcome<ResolvedArtifactPreview>>;
  prepareLaunch(input: { requestId: string; jobId: string; expectedRevision: number }): Promise<MutationOutcome<PrepareLaunchView>>;
  getLaunch(input: { launchId?: string; attemptId?: string; requestId?: string }): Promise<MutationOutcome<LaunchReceiptView>>;
  reconcileLaunch(input: { requestId: string; attemptId: string; launchId: string }): Promise<MutationOutcome<LaunchCoordinatorView>>;
  interpretWorkerCompletion(input: { jobId: string; launchId?: string }): Promise<MutationOutcome<CompletionView>>;
  answerNeedsInput(input: AnswerNeedsInputCommand & { claimedBbProjectId?: string }): Promise<MutationOutcome<AnswerNeedsInputRecord>>;
  listJobAttempts(input: { jobId: string; claimedBbProjectId?: string }): Promise<MutationOutcome<JobLaunchItem[]>>;
  getIsolationReadiness(input?: { jobId?: string }): Promise<MutationOutcome<IsolationReadiness>>;
  listDashboardUsage(input?: ListDashboardUsageInput): Promise<MutationOutcome<ListDashboardUsageOutput>>;
  saveEventDefinition(input: SaveEventDefinitionCommand): Promise<MutationOutcome<{
    topic: string;
    schemaVersion: number;
    namespace: "bb" | "agency" | "integration";
    label: string;
  }>>;
  saveEventSource(input: SaveEventSourceCommand): Promise<MutationOutcome<{
    id: string;
    projectId: string;
    kind: string;
    enabled: boolean;
  }>>;
  saveRuleVersion(input: SaveRuleVersionCommand): Promise<MutationOutcome<{
    id: string;
    ruleId: string;
    version: number;
    projectId: string;
    topic: string;
    mode: SaveRuleVersionCommand["mode"];
    enabled: boolean;
  }>>;
  ingestInboxEvent(input: IngestInboxEventCommand): Promise<MutationOutcome<InboxEventRecord>>;
  dispatchTick(input: DispatchTickCommand): Promise<MutationOutcome<DispatchTickRecord>>;
  listActionIntents(input?: { projectId?: string; state?: ActionIntentRecord["state"] }): Promise<MutationOutcome<ListedActionIntent[]>>;
  listEventDefinitions(input?: { projectId?: string }): Promise<MutationOutcome<EventDefinitionRecord[]>>;
  listEventSources(input?: { projectId?: string }): Promise<MutationOutcome<EventSourceRecord[]>>;
  listRuleVersions(input?: { projectId?: string }): Promise<MutationOutcome<CatalogRuleRecord[]>>;
  claimActionIntent(input: ClaimActionIntentCommand): Promise<MutationOutcome<ActionIntentRecord>>;
  approveActionIntent(input: ApproveActionIntentCommand): Promise<MutationOutcome<ActionIntentRecord>>;
}

/** `.bb/AGENTS.md` of a project folder as read on its machine. */
export type ProjectRulesFile = {
  bindingId: string;
  relativePath: string;
  exists: boolean;
  text: string | null;
  hash: string | null;
  size: number | null;
  managedBlock: boolean;
};

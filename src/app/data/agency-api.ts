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
  createJob(input: CreateJobCommand & { claimedBbProjectId?: string }): Promise<MutationOutcome<Job>>;
  updateJob(input: UpdateJobCommand & { claimedBbProjectId?: string }): Promise<MutationOutcome<Job>>;
  transitionJob(input: JobTransitionCommand & { claimedBbProjectId?: string }): Promise<MutationOutcome<Job>>;
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

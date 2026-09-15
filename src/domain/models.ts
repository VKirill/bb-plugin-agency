export type {
  Activity,
  Agent,
  AgentVersion,
  Artifact,
  ArtifactAuthor,
  ArtifactVersion,
  Department,
  Job,
  JobDependency,
  JobState,
  Membership,
  PolicyVersion,
  ProcessVersion,
  ProjectBinding,
  ProjectDepartment,
} from "../shared/contracts";

// Scaffold types kept for isolation/dispatcher ports. They are not the stage-1 persistence model.
export interface AgentProfile {
  id: string; version: number; name: string; instructions: string;
  providerId: string; model: string;
  skillIds: readonly string[]; mcpIds: readonly string[];
}
export interface RunSnapshot {
  id: string; jobId: string; threadId: string | null;
  agent: AgentProfile; inputVersion: number;
}
export type Trigger =
  | { kind: "event"; topic: string }
  | { kind: "cron"; expression: string; timezone: string }
  | { kind: "manual" };
export interface Rule {
  id: string; projectId: string; enabled: boolean; trigger: Trigger;
  targetDepartmentId: string;
}

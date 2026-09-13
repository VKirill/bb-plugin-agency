// Target domain contracts. No persistence or execution is implied by these types.
export interface AgentProfile {
  id: string; version: number; name: string; instructions: string;
  providerId: string; model: string;
  skillIds: readonly string[]; mcpIds: readonly string[];
}
export interface Department {
  id: string; name: string; leadAgentId: string;
  memberAgentIds: readonly string[]; playbook: string;
}
export interface ProjectBinding {
  projectId: string; sectionId: string | null; hostId: string;
  workspace: string; departmentIds: readonly string[];
}
export type JobState = "backlog" | "queued" | "running" | "review" |
  "waiting_input" | "blocked" | "done" | "canceled";
export interface Job {
  id: string; projectId: string; departmentId: string;
  state: JobState; resultVersion: number;
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

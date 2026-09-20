import type { AgentProfile } from "../../domain/models";

export type IsolationAssessment = { supported: false; reason: string };
export function assessIsolation(_profile?: AgentProfile): IsolationAssessment {
  return {
    supported: false,
    reason: "BB не изолирует навыки и MCP каталога по тредам: навыки сотрудника передаются в промпте запуска.",
  };
}

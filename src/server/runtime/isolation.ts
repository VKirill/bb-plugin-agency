import type { AgentProfile } from "../../domain/models";

export type IsolationAssessment = { supported: false; reason: string };
export function assessIsolation(_profile?: AgentProfile): IsolationAssessment {
  return {
    supported: false,
    reason: "Изоляция MCP и навыков ещё не проверена. Запуск сотрудников недоступен.",
  };
}

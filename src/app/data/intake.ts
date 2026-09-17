import { tr } from "../i18n";
import type { TaskActivity } from "../prototype/data";

/** Lead's intake assessment, read from the latest comment that carries intake references. */
export type IntakeAssessment = {
  size: string;
  risk: string;
  decision: string;
  author?: string;
  at: string;
};

const RISK_LABELS: Record<string, string> = { low: "риск низкий", medium: "риск средний", high: "риск высокий" };
const DECISION_LABELS: Record<string, string> = {
  accept: "принято",
  split: "разбить на подзадачи",
  clarify: "нужны уточнения",
  return: "возврат",
};

export function latestIntake(activity: readonly TaskActivity[] | undefined): IntakeAssessment | null {
  if (!activity) return null;
  for (let index = activity.length - 1; index >= 0; index -= 1) {
    const row = activity[index]!;
    const refs = row.references ?? [];
    const pick = (type: string) => refs.find((ref) => ref.type === type)?.id;
    const size = pick("intake_size");
    const risk = pick("intake_risk");
    const decision = pick("intake_decision");
    if (size && risk && decision) return { size, risk, decision, author: row.author, at: row.at };
  }
  return null;
}

export function intakeLabel(intake: IntakeAssessment): string {
  return [
    tr("размер {size}", { size: intake.size }),
    tr(RISK_LABELS[intake.risk] ?? intake.risk),
    tr(DECISION_LABELS[intake.decision] ?? intake.decision),
  ].join(" · ");
}

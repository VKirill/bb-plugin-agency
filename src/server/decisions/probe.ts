import { askLaunchEffort, type EffortResult } from "./launch-effort";
import { askBriefingDetailed, BRIEFING_POINT } from "./briefing";
import { askHandInGate, HAND_IN_GATE_POINT, type HandInGateResult } from "./hand-in-gate";
import { askIntakeDetailed, INTAKE_POINT, type IntakeProposal } from "./intake";
import type { DecisionSettings } from "../../shared/decisions";

/**
 * Живая проверка новых точек оценщика без запуска сотрудника.
 * Учебные брифы: короткая правка (вход), мусорная vs нормальная сдача, подсказка к запуску.
 */

const INTAKE_JOB = {
  key: "probe-intake",
  title: "Цвет кнопки «Сохранить»",
  brief: "Поменять цвет основной кнопки в карточке задачи на цвет из макета. Другие экраны не трогать.",
  acceptance: "Цвет кнопки совпадает с макетом на широкой и узкой карточке.",
};

const HAND_IN_JOB = {
  key: "probe-hand-in",
  title: "Цвет кнопки «Сохранить»",
  brief: INTAKE_JOB.brief,
  acceptance: INTAKE_JOB.acceptance,
};

const BRIEFING_JOB = {
  key: "probe-briefing",
  title: "Короткий пост в канал",
  brief: "Написать пост до 500 знаков про запуск продукта. Картинку не делать.",
  acceptance: "Текст в report.md, без обложки.",
};

const JUNK_COMMENT = "типа готово, потом доделаю, тесты не гонял";
const SOLID_COMMENT =
  "Опубликована версия 1: цвет кнопки совпадает с макетом на широкой и узкой карточке. npm test зелёный. Другие экраны не менялись.";

export type DecisionProbeResult = {
  effort: EffortResult;
  intake: IntakeProposal | null;
  intakeTrace: { reason: string; answers: string; ms: number };
  junk: HandInGateResult | null;
  solid: HandInGateResult | null;
  briefing: { reason: string; answers: string; ms: number; skills: string[]; granted: string[] };
};

export async function probeDecisionPoints(
  settings: DecisionSettings,
  deps: { fetch?: typeof fetch; key?: string } = {},
): Promise<DecisionProbeResult> {
  const live: DecisionSettings = {
    ...settings,
    enabled: true,
    points: [INTAKE_POINT, HAND_IN_GATE_POINT, BRIEFING_POINT],
  };
  const asked = await askIntakeDetailed(live, INTAKE_JOB, deps);
  const junk = await askHandInGate(live, HAND_IN_JOB, JUNK_COMMENT, deps);
  const solid = await askHandInGate(live, HAND_IN_JOB, SOLID_COMMENT, deps);
  const briefing = await askBriefingDetailed(
    live,
    {
      job: BRIEFING_JOB,
      skills: [{ id: "s1", name: "ru-text", description: "русский текст без канцелярита" }],
      pool: [{ id: "p1", name: "telegram-rich-messages", description: "посты и оформление для Telegram" }],
      lessons: [],
    },
    deps,
  );
  const effort = await askLaunchEffort(live, {
    title: "Full-plan reasoning probe",
    brief: "Preserve all existing behavior and document evidence.\n".repeat(80) + "FINAL STEP: design a concurrent database migration with crash recovery, idempotency and rollback; analyze race conditions across services.",
    acceptance: "Evidence\n".repeat(80) + "Prove no data loss under concurrent writes and process crashes.",
  }, ["low", "medium", "high", "xhigh", "max"], deps);
  return {
    effort,
    intake: asked.proposal,
    intakeTrace: { reason: asked.reason, answers: asked.answers, ms: asked.ms },
    junk,
    solid,
    briefing: {
      reason: briefing.reason,
      answers: briefing.answers,
      ms: briefing.ms,
      skills: briefing.briefing?.skills.map((skill) => skill.name) ?? [],
      granted: briefing.briefing?.granted.map((row) => row.skill.name) ?? [],
    },
  };
}

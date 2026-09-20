import { agencyLanguage, type AgencyLanguage } from "../../i18n/language.js";
import type { Job } from "../../../shared/contracts";

export function jobPackRelativePath(key: string): string {
  return `.agency/jobs/${key}/TASK.md`;
}

const EMPTY_HANDOFF = /^handoff none$/i;

export function realHandoffText(text: string | null | undefined): string | null {
  const trimmed = text?.trim() ?? "";
  if (!trimmed || EMPTY_HANDOFF.test(trimmed)) return null;
  return trimmed;
}

export function formatJobPack(input: {
  job: Pick<Job, "key" | "title" | "brief" | "acceptance">;
  role: string | null;
  briefingText?: string | null;
  handoff?: string | null;
  lang?: AgencyLanguage;
}): string {
  const lang = input.lang ?? agencyLanguage();
  const handoff = realHandoffText(input.handoff);
  const briefing = input.briefingText?.trim() || null;
  if (lang === "en") {
    return [
      `# ${input.job.key}: ${input.job.title}`,
      "",
      "## What to do",
      input.job.brief.trim() || "(empty brief)",
      "",
      "## Acceptance",
      input.job.acceptance.trim() || "(empty acceptance)",
      ...(briefing ? ["", "## Briefing", briefing] : []),
      ...(handoff ? ["", "## Handoff from the previous attempt", handoff] : []),
      "",
      "## How to finish",
      `- Write the report at \`.agency/jobs/${input.job.key}/report.md\`.`,
      "- `bb agency artifact create` then `artifact publish`.",
      "- Leave a closing `bb agency job comment` and end the turn.",
      "- Do not accept your own result. The conveyor closes the station.",
      "- Owner questions (`report-needs-input`) only for missing materials: secrets, money, irreversible action.",
      "",
      "## CLI for this role",
      roleCli(input.role, "en"),
    ].join("\n");
  }
  return [
    `# ${input.job.key}: ${input.job.title}`,
    "",
    "## Что сделать",
    input.job.brief.trim() || "(пустой бриф)",
    "",
    "## Приёмка",
    input.job.acceptance.trim() || "(пустой критерий)",
    ...(briefing ? ["", "## Подсказка", briefing] : []),
    ...(handoff ? ["", "## Передача с предыдущей попытки", handoff] : []),
    "",
    "## Как сдать",
    `- Отчёт \`.agency/jobs/${input.job.key}/report.md\`.`,
    "- `bb agency artifact create`, затем `artifact publish`.",
    "- Итоговый `bb agency job comment` и конец хода.",
    "- Свой результат не принимай. Станцию закрывает конвейер.",
    "- `report-needs-input` только если не хватает сырья: секреты, деньги, необратимое действие владельца.",
    "",
    "## CLI этой роли",
    roleCli(input.role, "ru"),
  ].join("\n");
}

function roleCli(role: string | null, lang: AgencyLanguage): string {
  const common = [
    "`bb agency job comment`",
    "`bb agency artifact create`",
    "`bb agency artifact publish`",
    "`bb agency job report-needs-input`",
  ];
  if (role === "lead") {
    return [...common, "`bb agency job create`", "`bb agency job attach-input`"].join("\n");
  }
  if (role === "reviewer") {
    return lang === "en"
      ? [
          "`bb agency job comment`",
          "`bb agency artifact create`",
          "`bb agency artifact publish`",
          "First line of the report: `Verdict: accept` or `Verdict: rework`.",
        ].join("\n")
      : [
          "`bb agency job comment`",
          "`bb agency artifact create`",
          "`bb agency artifact publish`",
          "Первая строка отчёта: `Вердикт: принять` или `Вердикт: доработать`.",
        ].join("\n");
  }
  return common.join("\n");
}

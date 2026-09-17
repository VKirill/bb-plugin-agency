import { tr } from "../i18n";

/**
 * Reads a department charter written by the template in
 * skills/agency/references/job-descriptions.md: "## Назначение", "## Принимаем",
 * "## Не принимаем" and so on. Nothing is invented: a missing section is null.
 */

/** English charters use the same sections; the plugin speaks Russian and English. */
const HEADING_ALIASES: Record<string, readonly string[]> = {
  "назначение": ["purpose"],
  "принимаем": ["accepts", "we accept", "accepted work"],
  "не принимаем": ["does not accept", "we do not accept", "not accepted"],
};

export function charterSection(instructions: string | undefined, heading: string): string | null {
  if (!instructions) return null;
  const lines = instructions.split(/\r?\n/);
  const wanted = new Set([heading.toLowerCase(), ...(HEADING_ALIASES[heading.toLowerCase()] ?? [])]);
  const start = lines.findIndex((line) => /^#{1,6}\s/.test(line) && wanted.has(line.replace(/^#{1,6}\s*/, "").replace(/:\s*$/, "").trim().toLowerCase()));
  if (start < 0) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    body.push(line);
  }
  const text = body.join("\n").trim();
  return text || null;
}

/** One or two sentences for headers and cards; the full charter stays in its own block. */
export function charterPurpose(instructions: string | undefined, limit = 220): string | null {
  const purpose = charterSection(instructions, "Назначение");
  const source = purpose ?? instructions?.split(/\r?\n/).find((line) => line.trim() && !/^#{1,6}\s/.test(line)) ?? "";
  const flat = source.replace(/^[-*]\s+/gm, "").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}

/** Lines of the charter template that must be replaced with the department's own text. */
const TEMPLATE_LINES = [
  "Какой результат отдел выдаёт компании.",
  "- Тип задачи: признаки, пример.",
  "- Тип задачи → отдел «…».",
  "- Материал, доступ или решение владельца.",
  "2. Этап — роль, выход.",
  "Когда решение вне полномочий отдела.",
  "What result the department delivers to the company.",
  "- Type of job: signs, example.",
  '- Type of job → department "…".',
  "- Material, access or the owner's decision.",
  "2. Stage — role, output.",
  "When a decision is outside the department's authority.",
];

/** What stops chat routing from understanding the department: missing «Принимаем», template lines left as is. */
export function charterIssues(instructions: string | undefined): string[] {
  const issues: string[] = [];
  if (!charterSection(instructions, "Принимаем")) {
    issues.push(tr("нет раздела «## Принимаем»: агенты в чатах не поймут, какие задачи поручать отделу"));
  }
  const left = TEMPLATE_LINES.filter((line) => (instructions ?? "").split(/\r?\n/).some((row) => row.trim() === line));
  if (left.length) {
    issues.push(tr("остались строки шаблона: {lines}", { lines: left.map((line) => `«${line.replace(/^[-\d.\s]+/, "")}»`).join(", ") }));
  }
  return issues;
}

import { ok, type DomainResult } from "../../domain";
import type { SqlDatabase } from "../db/sql";
import { saveKnowledge, type KnowledgeItem } from "./store";

/**
 * Урок после приёмки: как прошла главная задача и что из этого стоит помнить отделу.
 *
 * Черновик собирает само Агентство из фактов задачи — круги доработки, замечания, сроки, —
 * и кладёт его в знания отдела **предложением**. Владелец правит формулировку и принимает;
 * принятое приходит во все следующие запуски отдела. Без этого шага отдел каждый раз начинает
 * с нуля и наступает на те же грабли.
 */

export const LESSON_AUTHOR = "agency:lesson";

type JobRow = { id: string; key: string; title: string; department_id: string; parent_job_id: string | null };

export type LessonDraft = {
  title: string;
  summary: string;
  body: string;
  source: string;
  departmentId: string;
};

function firstLine(text: string, limit = 160): string {
  const line = text.split("\n").map((row) => row.trim()).find(Boolean) ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function daysBetween(from: string, to: string): number | null {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return Math.max(1, Math.round((end - start) / 86_400_000));
}

/** Факты задачи, из которых складывается черновик: их не нужно выдумывать, они уже в базе. */
export function draftLesson(db: SqlDatabase, jobId: string, now: string): LessonDraft | null {
  const job = db
    .prepare(`SELECT id, key, title, department_id, parent_job_id FROM agency_job WHERE id = ?`)
    .get(jobId) as JobRow | undefined;
  // Урок пишется по главной задаче: подзадача — это часть одной работы, а не её итог.
  if (!job || job.parent_job_id) return null;

  const subtasks = (db.prepare(`SELECT id FROM agency_job WHERE parent_job_id = ?`).all(job.id) as { id: string }[]).map((row) => row.id);
  const tree = [job.id, ...subtasks];
  const placeholders = tree.map(() => "?").join(", ");
  const rounds = db.prepare(`SELECT COUNT(*) AS n FROM agency_rework WHERE send_state = 'confirmed' AND job_id IN (${placeholders})`).get(...tree) as { n: number };
  const remarks = (db
    .prepare(`SELECT comment FROM agency_rework WHERE send_state = 'confirmed' AND job_id IN (${placeholders}) ORDER BY created_at LIMIT 5`)
    .all(...tree) as { comment: string }[]).map((row) => firstLine(row.comment));
  const started = db.prepare(`SELECT MIN(timestamp) AS at FROM agency_activity WHERE job_id IN (${placeholders})`).get(...tree) as { at: string | null };
  const days = started.at ? daysBetween(started.at, now) : null;

  const facts = [
    `Подзадач: ${subtasks.length}.`,
    `Кругов доработки: ${rounds.n}.`,
    ...(days ? [`Заняло дней: ${days}.`] : []),
  ].join(" ");
  const body = [
    `## Как прошла задача ${job.key} «${job.title}»`,
    facts,
    ...(remarks.length ? ["", "Из-за чего возвращали:", ...remarks.map((remark) => `- ${remark}`)] : []),
    "",
    "## Что запомнить",
    rounds.n > 0
      ? "Замечания выше повторяться не должны: перед сдачей проверяйте их отдельным пунктом самопроверки."
      : "Работа прошла без доработок — опишите, что именно помогло, чтобы повторить это в следующий раз.",
    "",
    "_Черновик собран Агентством из фактов задачи. Допишите вывод своими словами и примите запись._",
  ].join("\n");

  return {
    title: `Урок из ${job.key}: ${job.title}`.slice(0, 200),
    summary:
      rounds.n > 0
        ? `${job.key}: ${rounds.n} кругов доработки, замечания — ${remarks.length ? firstLine(remarks[0]!, 80) : "в истории задачи"}.`
        : `${job.key}: принято без доработок за ${days ?? "—"} дн.`,
    body,
    source: `Задача ${job.key}, принята ${now.slice(0, 10)}`,
    departmentId: job.department_id,
  };
}

/** Один урок на задачу: повторная приёмка версии не плодит предложения. */
export function lessonExists(db: SqlDatabase, jobKey: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM agency_knowledge WHERE title LIKE ?`).get(`Урок из ${jobKey}:%`));
}

export function proposeLessonForJob(db: SqlDatabase, jobId: string, now: string): DomainResult<{ proposed: KnowledgeItem | null }> {
  const draft = draftLesson(db, jobId, now);
  if (!draft) return ok({ proposed: null });
  const key = draft.title.slice("Урок из ".length).split(":")[0] ?? "";
  if (key && lessonExists(db, key)) return ok({ proposed: null });
  const saved = saveKnowledge(
    db,
    {
      expectedRevision: 0,
      title: draft.title,
      summary: draft.summary,
      body: draft.body,
      kind: "lesson",
      importance: 60,
      writeReason: "Черновик после приёмки главной задачи: чтобы отдел не повторял те же круги.",
      source: draft.source,
      scopeKind: "department",
      scopeId: draft.departmentId,
    },
    { proposedBy: LESSON_AUTHOR },
    now,
  );
  if (!saved.ok) return saved;
  return ok({ proposed: saved.value });
}

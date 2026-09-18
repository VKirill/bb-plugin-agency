import { ok, type DomainResult } from "../../domain";
import type { SqlDatabase } from "../db/sql";
import { listKnowledge, saveKnowledge, setKnowledgeStatus, type KnowledgeItem } from "./store";

/**
 * Урок после приёмки: как прошла главная задача и что из этого стоит помнить отделу.
 *
 * Запись собирает само Агентство из фактов задачи — круги доработки, замечания, сроки. При
 * включённом правиле «Отдел учится сам» она сразу принимается в знания отдела, а владелец
 * получает сообщение с правом отменить; иначе ждёт его решения предложением.
 *
 * Чтобы память не превращалась в свалку, у неё есть рамки: бюджет записей на отдел
 * (`trimDepartmentMemory`, вытесняет сначала непрочитанное) и срок жизни авто-урока
 * (`expireLessons`). Закреплённые владельцем записи не вытесняются и не устаревают.
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
    "_Собрано Агентством из фактов задачи. Поправьте вывод своими словами или уберите запись, если она не нужна._",
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

export type LessonOptions = {
  /** Отдел учится сам: запись принимается без владельца, он получает право вето. */
  autoLearn?: boolean;
  /** Сколько принятых записей держит отдел: лишние уходят в архив, закреплённые остаются. */
  memoryLimit?: number;
  /**
   * Ответ оценщика, если владелец его включил: отказ останавливает запись, важность приходит
   * предложением. Оценщик молчит или не уверен — работаем по своим правилам, как будто его нет.
   */
  verdict?: { keep: boolean; reason: string | null; importance: number | null; duplicateOf: string | null } | null;
};

/**
 * Бюджет памяти отдела: индекс в промпте не должен расти бесконечно. Лишние записи уходят в
 * архив, начиная с самых старых и наименее важных; закреплённые владельцем остаются всегда.
 */
export function trimDepartmentMemory(db: SqlDatabase, departmentId: string, limit: number, now: string): KnowledgeItem[] {
  const accepted = listKnowledge(db, { scopeKind: "department", scopeId: departmentId, status: "accepted" });
  if (accepted.length <= limit) return [];
  // Первым уходит то, что никто ни разу не открыл: счёт обращений честнее даты записи.
  const droppable = accepted
    .filter((item) => !item.pinned)
    .sort(
      (left, right) =>
        left.readCount - right.readCount ||
        left.importance - right.importance ||
        Date.parse(left.updatedAt) - Date.parse(right.updatedAt),
    );
  const archived: KnowledgeItem[] = [];
  for (const item of droppable) {
    if (accepted.length - archived.length <= limit) break;
    const moved = setKnowledgeStatus(db, { id: item.id, expectedRevision: item.revision, status: "archived" }, now);
    if (moved.ok) archived.push(moved.value);
  }
  return archived;
}

export function proposeLessonForJob(
  db: SqlDatabase,
  jobId: string,
  now: string,
  options: LessonOptions = {},
): DomainResult<{ proposed: KnowledgeItem | null; archived?: KnowledgeItem[]; rejected?: string }> {
  const draft = draftLesson(db, jobId, now);
  if (!draft) return ok({ proposed: null });
  const key = draft.title.slice("Урок из ".length).split(":")[0] ?? "";
  if (key && lessonExists(db, key)) return ok({ proposed: null });
  // Оценщик сказал «не надо»: записи не будет, но владелец узнает причину одной строкой.
  if (options.verdict && !options.verdict.keep) return ok({ proposed: null, rejected: options.verdict.reason ?? "Оценщик не советует хранить эту запись." });
  const saved = saveKnowledge(
    db,
    {
      expectedRevision: 0,
      title: draft.title,
      summary: draft.summary,
      body: draft.body,
      kind: "lesson",
      // Вид у урока известен по построению; спорной остаётся только важность.
      importance: options.verdict?.importance ?? 60,
      writeReason: "Черновик после приёмки главной задачи: чтобы отдел не повторял те же круги.",
      source: draft.source,
      scopeKind: "department",
      scopeId: draft.departmentId,
    },
    { proposedBy: LESSON_AUTHOR },
    now,
  );
  if (!saved.ok) return saved;
  if (!options.autoLearn) return ok({ proposed: saved.value });
  // Отдел учится сам: запись принимается сразу, владелец получает сообщение с правом отменить.
  const accepted = setKnowledgeStatus(db, { id: saved.value.id, expectedRevision: saved.value.revision, status: "accepted" }, now);
  if (!accepted.ok) return ok({ proposed: saved.value });
  const archived = options.memoryLimit ? trimDepartmentMemory(db, draft.departmentId, options.memoryLimit, now) : [];
  return ok({ proposed: accepted.value, archived });
}

/**
 * Срок жизни авто-урока: через `ttlDays` запись уходит в архив, если владелец её не закрепил и не
 * поднял важность. Память отдела не копит правила, которые никто не подтвердил.
 */
export function expireLessons(db: SqlDatabase, ttlDays: number, now: string): KnowledgeItem[] {
  const edge = Date.parse(now) - ttlDays * 86_400_000;
  if (Number.isNaN(edge)) return [];
  const expired: KnowledgeItem[] = [];
  for (const item of listKnowledge(db, { status: "accepted" })) {
    if (item.kind !== "lesson" || item.pinned || item.proposedBy !== LESSON_AUTHOR) continue;
    if (Date.parse(item.updatedAt) > edge) continue;
    const moved = setKnowledgeStatus(db, { id: item.id, expectedRevision: item.revision, status: "archived" }, now);
    if (moved.ok) expired.push(moved.value);
  }
  return expired;
}

import { randomUUID } from "node:crypto";
import { fail, ok, type DomainResult } from "../../domain";
import type { SqlDatabase } from "../db/sql";

/**
 * Профиль работы проекта: как в этом проекте делают такой вид результата — голос, стиль,
 * одобренные эталоны и дополнительный критерий приёмки. Пост в Telegram, пост в Дзен и превью
 * для YouTube — три разных профиля одного проекта.
 *
 * Профиль принадлежит BB-проекту, а не папке: у проекта на двух машинах голос один.
 * Список профилей приходит в каждый запуск проекта; полный текст — в ту задачу, которой профиль
 * назначен (`workProfileKey`), чтобы владельцу не приходилось напоминать про стиль каждый раз.
 */

export const WORK_PROFILE_MIGRATION = `CREATE TABLE agency_work_profile (
    id TEXT PRIMARY KEY,
    bb_project_id TEXT NOT NULL,
    key TEXT NOT NULL,
    title TEXT NOT NULL,
    triggers TEXT NOT NULL,
    body TEXT NOT NULL,
    samples TEXT NOT NULL,
    acceptance TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(bb_project_id, key)
  )`;

/** Сколько знаков профиля доходит до промпта: остальное живёт в проекте и читается по ссылке. */
export const WORK_PROFILE_LIMIT = 4_000;

export type WorkProfileSample = { label: string; ref: string; note?: string };

export type WorkProfile = {
  id: string;
  bbProjectId: string;
  key: string;
  title: string;
  /** Слова и обороты, по которым видно, что работа этого вида: «пост в телеграм», «превью». */
  triggers: string[];
  body: string;
  samples: WorkProfileSample[];
  acceptance: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

type Row = {
  id: string;
  bb_project_id: string;
  key: string;
  title: string;
  triggers: string;
  body: string;
  samples: string;
  acceptance: string;
  revision: number;
  created_at: string;
  updated_at: string;
};

function parseList<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

const toProfile = (row: Row): WorkProfile => ({
  id: row.id,
  bbProjectId: row.bb_project_id,
  key: row.key,
  title: row.title,
  triggers: parseList<string>(row.triggers),
  body: row.body,
  samples: parseList<WorkProfileSample>(row.samples),
  acceptance: row.acceptance,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function listWorkProfiles(db: SqlDatabase, bbProjectId?: string): WorkProfile[] {
  const rows = bbProjectId
    ? (db.prepare(`SELECT * FROM agency_work_profile WHERE bb_project_id = ? ORDER BY key`).all(bbProjectId) as Row[])
    : (db.prepare(`SELECT * FROM agency_work_profile ORDER BY bb_project_id, key`).all() as Row[]);
  return rows.map(toProfile);
}

export function getWorkProfile(db: SqlDatabase, bbProjectId: string, key: string): WorkProfile | null {
  const row = db
    .prepare(`SELECT * FROM agency_work_profile WHERE bb_project_id = ? AND key = ?`)
    .get(bbProjectId, key) as Row | undefined;
  return row ? toProfile(row) : null;
}

/** `tg-post`, `yt-thumbnail`: короткий ключ, по которому профиль называют в задаче. */
export function normalizeProfileKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

export type SaveWorkProfileInput = {
  bbProjectId: string;
  key: string;
  expectedRevision: number;
  title: string;
  triggers: string[];
  body: string;
  samples: WorkProfileSample[];
  acceptance: string;
};

export function saveWorkProfile(db: SqlDatabase, input: SaveWorkProfileInput, now: string): DomainResult<WorkProfile> {
  const key = normalizeProfileKey(input.key);
  if (!key) return fail("invalid_command", "ключ профиля пустой: укажите короткое имя вида tg-post");
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title) return fail("invalid_command", "у профиля нет названия");
  if (!body) return fail("invalid_command", "у профиля нет текста: опишите голос, стиль и границы");
  const current = getWorkProfile(db, input.bbProjectId, key);
  if ((current?.revision ?? 0) !== input.expectedRevision) {
    return fail("revision_conflict", `work profile ${key} revision ${current?.revision ?? 0} != expected ${input.expectedRevision}`);
  }
  const profile: WorkProfile = {
    id: current?.id ?? randomUUID(),
    bbProjectId: input.bbProjectId,
    key,
    title,
    triggers: input.triggers.map((item) => item.trim()).filter(Boolean),
    body,
    samples: input.samples.filter((sample) => sample.label.trim() && sample.ref.trim()),
    acceptance: input.acceptance.trim(),
    revision: (current?.revision ?? 0) + 1,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO agency_work_profile (id, bb_project_id, key, title, triggers, body, samples, acceptance, revision, created_at, updated_at)
     VALUES (@id, @bbProjectId, @key, @title, @triggers, @body, @samples, @acceptance, @revision, @createdAt, @updatedAt)
     ON CONFLICT(bb_project_id, key) DO UPDATE SET
       title = @title, triggers = @triggers, body = @body, samples = @samples,
       acceptance = @acceptance, revision = @revision, updated_at = @updatedAt`,
  ).run({
    ...profile,
    triggers: JSON.stringify(profile.triggers),
    samples: JSON.stringify(profile.samples),
  });
  return ok(profile);
}

export function deleteWorkProfile(db: SqlDatabase, bbProjectId: string, key: string): DomainResult<{ removed: boolean }> {
  const profile = getWorkProfile(db, bbProjectId, normalizeProfileKey(key));
  if (!profile) return ok({ removed: false });
  db.prepare(`DELETE FROM agency_work_profile WHERE id = ?`).run(profile.id);
  return ok({ removed: true });
}

/** Одна строка на профиль для слоя проекта: по ней руководитель выбирает профиль для подзадачи. */
export function workProfileIndex(profiles: readonly WorkProfile[]): string | null {
  if (!profiles.length) return null;
  return profiles
    .map((profile) => {
      const triggers = profile.triggers.length ? ` — признаки: ${profile.triggers.join(", ")}` : "";
      return `- ${profile.key} — ${profile.title}${triggers}`;
    })
    .join("\n");
}

/** Полный профиль для слоя поручения: голос, эталоны и дополнительный критерий приёмки. */
export function workProfileBlock(profile: WorkProfile): string {
  const samples = profile.samples.length
    ? [
        "Эталоны (одобрены владельцем, держим эту планку):",
        ...profile.samples.map((sample) => `- ${sample.label}: ${sample.ref}${sample.note ? ` — ${sample.note}` : ""}`),
      ]
    : [];
  const acceptance = profile.acceptance ? ["Дополнительно к критерию приёмки задачи:", profile.acceptance] : [];
  return [`Профиль работы проекта «${profile.title}» (${profile.key}):`, profile.body, ...samples, ...acceptance]
    .join("\n")
    .slice(0, WORK_PROFILE_LIMIT);
}

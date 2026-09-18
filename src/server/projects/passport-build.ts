import { getDecisionSettings } from "../decisions/settings.js";
import { askPassportGate } from "../decisions/passport-gate.js";
import type { DecisionSettings } from "../../shared/decisions.js";
import type { PassportSettings, ProjectPassport } from "../../shared/passport.js";
import type { SqlDatabase } from "../db/sql";
import { getPassport, passportDigest, writePassport } from "./passport.js";
import { getPassportSettings } from "./passport-settings.js";
import { writePassportDraft, type PassportDraft } from "./passport-writer.js";

/**
 * Сборка паспорта проекта. Материал — то, что проект уже накопил сам: знания, профили работ,
 * цели и принятые результаты. Модель его не добывает, а сокращает, поэтому сборка ничего не
 * стоит, пока в проекте ничего не происходило.
 *
 * Порог сборки — счёт принятых задач, как у Тенцента счёт новых записей: паспорт живёт пачками,
 * а не переписывается после каждой мелочи.
 */

/** Сколько знаков материала уходит модели: дальше начинается пересказ ленты задач, а не проект. */
const MATERIAL_LIMIT = 12_000;

/**
 * Во сколько раз дольше держится редакция, которую владелец написал или вернул руками. Он правил
 * её не для того, чтобы через десяток задач модель молча переписала правку обратно.
 */
const OWNER_EDIT_FACTOR = 2;

/**
 * Пора ли пересобирать паспорт. Одно место для обходчика и для самой сборки: разойдись они —
 * обходчик звал бы модель там, где сборка всё равно откажется, и наоборот.
 */
export function passportDue(current: ProjectPassport | null, material: PassportMaterial, settings: PassportSettings): boolean {
  if (!material.text.trim()) return false;
  if (!current) return material.acceptedJobs >= 1;
  if (current.sourceDigest === material.digest) return false;
  const threshold = settings.triggerEveryN * (current.builtBy === "owner" ? OWNER_EDIT_FACTOR : 1);
  return material.acceptedJobs - current.acceptedJobs >= threshold;
}

export type PassportMaterial = {
  text: string;
  /**
   * Отпечаток берётся только с того, что проект накопил сам. Правила проекта в него не входят
   * намеренно: они лежат на машине, и её недоступность не должна выглядеть как «материал изменился».
   */
  digest: string;
  /** Задач принято всего: по разнице с прошлой сборкой видно, пора ли пересобирать. */
  acceptedJobs: number;
};

type BindingRow = { id: string; canonical_root: string; host_id: string; archived_at: string | null };

export function collectPassportMaterial(db: SqlDatabase, bbProjectId: string, projectRules?: string | null): PassportMaterial {
  const bindings = (db
    .prepare(`SELECT id, canonical_root, host_id, archived_at FROM agency_project_binding WHERE bb_project_id = ?`)
    .all(bbProjectId) as BindingRow[]).filter((row) => !row.archived_at);
  if (!bindings.length) return { text: "", digest: "", acceptedJobs: 0 };
  const ids = bindings.map((row) => row.id);
  const list = ids.map(() => "?").join(", ");
  const lines: string[] = [];

  lines.push("Папки проекта:");
  for (const binding of bindings) lines.push(`- ${binding.canonical_root} (машина ${binding.host_id})`);

  const departments = db
    .prepare(
      `SELECT d.name AS name, COUNT(*) AS jobs FROM agency_job j JOIN agency_department d ON d.id = j.department_id
       WHERE j.binding_id IN (${list}) GROUP BY d.id ORDER BY jobs DESC LIMIT 12`,
    )
    .all(...ids) as Array<{ name: string; jobs: number }>;
  if (departments.length) {
    lines.push("", "Отделы, которые здесь работают:");
    for (const row of departments) lines.push(`- ${row.name}: задач ${row.jobs}`);
  }

  const knowledge = db
    .prepare(
      `SELECT title, COALESCE(summary, '') AS summary, body, COALESCE(kind, 'fact') AS kind FROM agency_knowledge
       WHERE status = 'accepted' AND scope_kind = 'project' AND scope_id IN (${list})
       ORDER BY COALESCE(pinned, 0) DESC, COALESCE(importance, 50) DESC, updated_at DESC LIMIT 40`,
    )
    .all(...ids) as Array<{ title: string; summary: string; kind: string; body: string }>;
  if (knowledge.length) {
    lines.push("", "Знания проекта (приняты владельцем):");
    for (const row of knowledge) lines.push(`- [${row.kind}] ${row.title} — ${row.summary || row.body.slice(0, 200)}`);
  }

  const profiles = db
    .prepare(`SELECT key, title, body FROM agency_work_profile WHERE bb_project_id = ? ORDER BY key`)
    .all(bbProjectId) as Array<{ key: string; title: string; body: string }>;
  if (profiles.length) {
    lines.push("", "Профили работ проекта (как здесь делают такой результат):");
    for (const row of profiles) lines.push(`- ${row.key} — ${row.title}: ${row.body.slice(0, 300)}`);
  }

  const goals = db
    .prepare(
      `SELECT DISTINCT g.title AS title, g.description AS description, g.status AS status FROM agency_goal g
       JOIN agency_job_goal jg ON jg.goal_id = g.id JOIN agency_job j ON j.id = jg.job_id
       WHERE j.binding_id IN (${list}) AND g.status = 'active' ORDER BY g.updated_at DESC LIMIT 10`,
    )
    .all(...ids) as Array<{ title: string; description: string; status: string }>;
  if (goals.length) {
    lines.push("", "Цели проекта:");
    for (const row of goals) lines.push(`- ${row.title}: ${row.description.slice(0, 300)}`);
  }

  const accepted = db
    .prepare(
      `SELECT title, brief, acceptance FROM agency_job WHERE binding_id IN (${list}) AND state = 'done' AND parent_job_id IS NULL
       ORDER BY updated_at DESC LIMIT 20`,
    )
    .all(...ids) as Array<{ title: string; brief: string; acceptance: string }>;
  if (accepted.length) {
    // Бриф принятой задачи говорит о проекте больше названия: из него видно, чем здесь занимаются.
    lines.push("", "Что здесь уже сделали и приняли:");
    for (const row of accepted) lines.push(`- ${row.title}: ${row.brief.replace(/\s+/g, " ").slice(0, 240)} — принято по: ${row.acceptance.slice(0, 120)}`);
  }

  const acceptedJobs = (db
    .prepare(`SELECT COUNT(*) AS count FROM agency_job WHERE binding_id IN (${list}) AND state = 'done'`)
    .get(...ids) as { count: number }).count;

  const own = lines.join("\n").slice(0, MATERIAL_LIMIT);
  // Правила проекта — лучший источник ответа «что это»; в сам паспорт их переписывать нельзя,
  // они и так приходят в запуск своим слоем, поэтому в задании это сказано прямо.
  const text = projectRules?.trim()
    ? [own, "", "Правила проекта (.bb/AGENTS.md) — только чтобы понять, что это за проект. Не переписывай их в паспорт:", projectRules.trim().slice(0, 3_000)].join("\n")
    : own;
  return { text, digest: passportDigest(own), acceptedJobs };
}

function draftText(draft: PassportDraft): string {
  return [draft.header, ...draft.sections.map((section) => `${section.key}:${section.text}`)].join("\n").replace(/\s+/g, " ").trim();
}

function sameDraft(left: PassportDraft, right: PassportDraft): boolean {
  return draftText(left) === draftText(right);
}

export type PassportBuildResult =
  | { ok: true; revision: number; ms: number; reason: "built" }
  | { ok: false; reason: "disabled" | "no_key" | "no_material" | "unchanged" | "same_text" | "request_failed" | "bad_answer" | "timeout" | "refused"; detail?: string; ms: number };

export type ProjectRulesRead = {
  /** Машина ответила: файла может и не быть, это разные вещи. */
  reachable: boolean;
  text: string | null;
};

export type PassportBuildDeps = {
  /** Правила проекта с машины: они дают ответ «что это за проект». */
  readRules?: (bbProjectId: string) => Promise<ProjectRulesRead>;
  settings?: PassportSettings;
  decisions?: DecisionSettings;
  write?: typeof writePassportDraft;
  gate?: typeof askPassportGate;
  fetch?: typeof fetch;
  now?: () => Date;
};

/**
 * Собрать паспорт проекта. `manual` — кнопка владельца: она собирает даже тогда, когда материал
 * не менялся. `auto` идёт от счёта принятых задач и молчит, если собирать нечего.
 */
export async function buildPassport(
  db: SqlDatabase,
  input: { bbProjectId: string; trigger: "auto" | "manual" },
  deps: PassportBuildDeps = {},
): Promise<PassportBuildResult> {
  const started = Date.now();
  const since = () => Date.now() - started;
  const settings = deps.settings ?? getPassportSettings(db);
  if (!settings.enabled) return { ok: false, reason: "disabled", ms: 0 };
  const rules = deps.readRules ? await deps.readRules(input.bbProjectId).catch(() => ({ reachable: false, text: null })) : null;
  // Машина не ответила — прежний паспорт остаётся: переписать его без правил значит сделать хуже.
  if (rules && !rules.reachable && input.trigger === "auto" && getPassport(db, input.bbProjectId)) {
    return { ok: false, reason: "no_material", detail: "Машина проекта не ответила: правила проекта не прочитаны.", ms: since() };
  }
  const material = collectPassportMaterial(db, input.bbProjectId, rules?.text ?? null);
  if (!material.text.trim()) return { ok: false, reason: "no_material", ms: since() };
  const current = getPassport(db, input.bbProjectId);
  if (input.trigger === "auto" && current && !passportDue(current, material, settings)) {
    return { ok: false, reason: "unchanged", ms: since() };
  }
  const previous: PassportDraft | null = current ? { header: current.header, sections: current.sections } : null;
  const writer = deps.write ?? writePassportDraft;
  const outcome = await writer(settings, { material: material.text, previous }, deps.fetch ? { fetch: deps.fetch } : {});
  if (!outcome.ok) {
    return { ok: false, reason: outcome.reason === "disabled" ? "disabled" : outcome.reason, ...(outcome.detail ? { detail: outcome.detail } : {}), ms: since() };
  }
  // Совпадение с прежней редакцией: истории незачем расти от перестановки слов, а привратник
  // может быть выключен и такого дубля не остановит.
  if (previous && sameDraft(previous, outcome.draft)) return { ok: false, reason: "same_text", ms: since() };
  const gate = deps.gate ?? askPassportGate;
  const verdict = await gate(deps.decisions ?? getDecisionSettings(db), outcome.draft, previous, deps.fetch ? { fetch: deps.fetch } : {});
  if (verdict && !verdict.apply) {
    return { ok: false, reason: "refused", ...(verdict.reason ? { detail: verdict.reason } : {}), ms: since() };
  }
  const now = (deps.now?.() ?? new Date()).toISOString();
  const saved = writePassport(
    db,
    {
      bbProjectId: input.bbProjectId,
      header: outcome.draft.header,
      sections: outcome.draft.sections,
      sourceDigest: material.digest,
      acceptedJobs: material.acceptedJobs,
      builtBy: "model",
      model: outcome.model,
      note: input.trigger === "manual" ? "Сборка по кнопке" : `Сборка по счёту задач: принято ${material.acceptedJobs}`,
    },
    now,
  );
  if (!saved.ok) return { ok: false, reason: "bad_answer", detail: saved.error.message, ms: since() };
  return { ok: true, revision: saved.value.revision, ms: since(), reason: "built" };
}

/**
 * Проекты, которым пора пересобрать паспорт: принятых задач стало на `triggerEveryN` больше, чем
 * было при прошлой сборке. Проект без паспорта попадает сюда, как только у него есть материал.
 */
export function projectsDueForPassport(db: SqlDatabase, settings: PassportSettings): string[] {
  if (!settings.enabled) return [];
  const projects = (db.prepare(`SELECT DISTINCT bb_project_id FROM agency_project_binding WHERE archived_at IS NULL`).all() as Array<{ bb_project_id: string }>)
    .map((row) => row.bb_project_id);
  const due: string[] = [];
  for (const bbProjectId of projects) {
    if (passportDue(getPassport(db, bbProjectId), collectPassportMaterial(db, bbProjectId), settings)) due.push(bbProjectId);
  }
  return due;
}

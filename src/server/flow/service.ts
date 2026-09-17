import type { z } from "zod";
import { fail, ok, type DomainResult } from "../../domain";
import type { Job } from "../../shared/contracts";
import { jobNextStepSchema, type DependencyLinkRecord, type JobNextStepRecord, type NextStepViewRecord } from "../../shared/rpc-contract";
import type { SqlDatabase } from "../db/sql";

/**
 * Work that moves on without a lead in the loop:
 * - dependencies: a job waits in the launch queue until the jobs it depends on are done;
 * - next step: when a job is done, the Agency creates the follow-up job for another
 *   department next to it, attaches the accepted versions and queues it.
 */

export const NEXT_STEP_MIGRATION = `CREATE TABLE agency_job_next_step (
  job_id TEXT PRIMARY KEY,
  step_json TEXT NOT NULL,
  created_job_id TEXT,
  outcome TEXT,
  updated_at TEXT NOT NULL
)`;

export type JobNextStep = JobNextStepRecord;
export type NextStepView = NextStepViewRecord;

export type DependencyLink = DependencyLinkRecord;

function tableExists(db: SqlDatabase, name: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}

/** Both directions of a job's dependencies, with what the card needs to draw them. */
export function dependencyLinks(db: SqlDatabase, jobId: string): { waitsFor: DependencyLink[]; blocks: DependencyLink[] } {
  const read = (sql: string) =>
    (db.prepare(sql).all(jobId) as { id: string; key: string; title: string; state: string }[]).map((row) => ({
      jobId: row.id,
      key: row.key,
      title: row.title,
      state: row.state,
    }));
  return {
    waitsFor: read(
      `SELECT j.id, j.key, j.title, j.state FROM agency_job_dependency d JOIN agency_job j ON j.id = d.depends_on_job_id WHERE d.job_id = ? ORDER BY j.rowid`,
    ),
    blocks: read(`SELECT j.id, j.key, j.title, j.state FROM agency_job_dependency d JOIN agency_job j ON j.id = d.job_id WHERE d.depends_on_job_id = ? ORDER BY j.rowid`),
  };
}

/**
 * Launch gate. A job waits while a job it depends on is not done; the launch queue
 * starts it by itself afterwards. A canceled dependency will never deliver: a person decides.
 */
export function assertDependenciesDone(db: SqlDatabase, job: Pick<Job, "id">, en: boolean): DomainResult<true> {
  const open = dependencyLinks(db, job.id).waitsFor.filter((link) => link.state !== "done");
  if (!open.length) return ok(true);
  const canceled = open.filter((link) => link.state === "canceled").map((link) => link.key);
  if (canceled.length) {
    return fail(
      "dependency_canceled",
      en
        ? `A job it depends on was canceled: ${canceled.join(", ")}. Remove the dependency or give the job another input.`
        : `Задача, от которой зависит эта, отменена: ${canceled.join(", ")}. Уберите зависимость или дайте задаче другой вход.`,
    );
  }
  const keys = open.map((link) => link.key).join(", ");
  return fail(
    "dependencies_open",
    en
      ? `Waits for jobs to be done: ${keys}. Put it in the launch queue: it starts by itself when they are done.`
      : `Ждёт готовности задач: ${keys}. Поставьте её в очередь запуска: она стартует сама, когда они будут готовы.`,
  );
}

export function removeJobDependency(db: SqlDatabase, jobId: string, dependsOnJobId: string): boolean {
  return db.prepare(`DELETE FROM agency_job_dependency WHERE job_id = ? AND depends_on_job_id = ?`).run(jobId, dependsOnJobId).changes > 0;
}

export function readNextStep(db: SqlDatabase, jobId: string): NextStepView | null {
  if (!tableExists(db, "agency_job_next_step")) return null;
  const row = db.prepare(`SELECT step_json, created_job_id, outcome, updated_at FROM agency_job_next_step WHERE job_id = ?`).get(jobId) as
    | { step_json: string; created_job_id: string | null; outcome: string | null; updated_at: string }
    | undefined;
  if (!row) return null;
  const step = jobNextStepSchema.safeParse(JSON.parse(row.step_json));
  return step.success ? { step: step.data, createdJobId: row.created_job_id, outcome: row.outcome, updatedAt: row.updated_at } : null;
}

/** Sets or clears the next step of an open job. A step that already ran stays as it was. */
export function saveNextStep(db: SqlDatabase, job: Job, step: z.input<typeof jobNextStepSchema> | null, now: string, en: boolean): DomainResult<NextStepView | null> {
  const current = readNextStep(db, job.id);
  if (current?.outcome) {
    return fail("next_step_done", en ? "The next step has already run and cannot change." : "Следующий шаг уже выполнен и не меняется.");
  }
  if (job.state === "done" || job.state === "canceled") {
    return fail("job_closed", en ? "A closed job does not take a next step." : "Закрытой задаче следующий шаг не задаётся.");
  }
  if (!step) {
    db.prepare(`DELETE FROM agency_job_next_step WHERE job_id = ?`).run(job.id);
    return ok(null);
  }
  const parsed = jobNextStepSchema.safeParse(step);
  if (!parsed.success) return fail("invalid_command", parsed.error.message);
  db.prepare(
    `INSERT INTO agency_job_next_step (job_id, step_json, created_job_id, outcome, updated_at) VALUES (?, ?, NULL, NULL, ?)
     ON CONFLICT(job_id) DO UPDATE SET step_json = excluded.step_json, updated_at = excluded.updated_at`,
  ).run(job.id, JSON.stringify(parsed.data), now);
  return ok(readNextStep(db, job.id));
}

/** Accepted versions of a job, one per artifact. */
export function acceptedVersions(db: SqlDatabase, jobId: string): { artifactId: string; version: number; hash: string }[] {
  return (
    db
      .prepare(`SELECT artifact_id, version, hash FROM agency_artifact_acceptance WHERE job_id = ? ORDER BY accepted_at`)
      .all(jobId) as { artifact_id: string; version: number; hash: string }[]
  ).map((row) => ({ artifactId: row.artifact_id, version: row.version, hash: row.hash }));
}

export type NextStepPorts = {
  db: SqlDatabase;
  getJob: (jobId: string) => Job | undefined;
  createJob: (source: Job, step: JobNextStep) => DomainResult<Job>;
  /** Attaches the accepted versions of the finished job to the new one; returns how many. */
  attachAccepted: (target: Job, source: Job) => Promise<DomainResult<number>>;
  queue: (job: Job) => DomainResult<unknown>;
  comment: (job: Job, text: string) => void;
  now: () => string;
  en: () => boolean;
};

/** Creates the follow-up jobs of finished jobs. Returns the keys of the jobs created. */
export async function sweepNextSteps(ports: NextStepPorts): Promise<string[]> {
  if (!tableExists(ports.db, "agency_job_next_step")) return [];
  const rows = ports.db
    .prepare(`SELECT job_id, step_json FROM agency_job_next_step WHERE outcome IS NULL`)
    .all() as { job_id: string; step_json: string }[];
  const created: string[] = [];
  for (const row of rows) {
    const en = ports.en();
    const settle = (outcome: string, createdJobId: string | null) =>
      ports.db
        .prepare(`UPDATE agency_job_next_step SET created_job_id = ?, outcome = ?, updated_at = ? WHERE job_id = ? AND outcome IS NULL`)
        .run(createdJobId, outcome.slice(0, 500), ports.now(), row.job_id).changes > 0;
    const source = ports.getJob(row.job_id);
    if (!source) {
      settle("source_missing", null);
      continue;
    }
    if (source.state === "canceled") {
      settle("source_canceled", null);
      continue;
    }
    if (source.state !== "done") continue;
    const step = jobNextStepSchema.safeParse(JSON.parse(row.step_json));
    if (!step.success) {
      settle("invalid_step", null);
      continue;
    }
    const next = ports.createJob(source, step.data);
    if (!next.ok) {
      settle(`create_failed: ${next.error.message}`, null);
      ports.comment(source, en ? `The next step was not created: ${next.error.message}` : `Следующий шаг не создан: ${next.error.message}`);
      continue;
    }
    // Another pass may have settled it meanwhile; the job create is idempotent by request id.
    if (!settle("created", next.value.id)) continue;
    created.push(next.value.key);
    const attached = await ports.attachAccepted(next.value, source);
    const live = ports.getJob(next.value.id) ?? next.value;
    const queued = ports.queue(live);
    const inputs = attached.ok ? attached.value : 0;
    ports.comment(
      source,
      en
        ? `Next step: created ${next.value.key}${inputs ? `, accepted versions attached: ${inputs}` : ""}${queued.ok ? ", queued for launch" : ""}.`
        : `Следующий шаг: создана ${next.value.key}${inputs ? `, приложено принятых версий: ${inputs}` : ""}${queued.ok ? ", поставлена в очередь запуска" : ""}.`,
    );
    const notes = [
      en ? `Created as the next step after ${source.key} was done.` : `Создана как следующий шаг после готовности ${source.key}.`,
      ...(attached.ok ? [] : [en ? `Inputs were not attached: ${attached.error.message}` : `Входы не приложены: ${attached.error.message}`]),
      ...(queued.ok ? [] : [en ? `Not queued for launch: ${queued.error.message}` : `В очередь запуска не поставлена: ${queued.error.message}`]),
    ];
    ports.comment(live, notes.join("\n"));
  }
  return created;
}

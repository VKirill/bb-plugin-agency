import type { DomainResult } from "../../../domain";
import type { Job } from "../../../shared/contracts";
import type { SqlDatabase } from "../../db/sql";

/**
 * Nightly recheck. A department with «Перепроверять принятое за день» gets, once a
 * day after its hour, a review job per project folder: every version accepted since
 * the previous recheck is attached as input and a reviewer checks it again. The
 * owner's acceptance stays; the recheck only reports what it finds.
 */

export const NIGHTLY_RECHECK_MIGRATION = `CREATE TABLE agency_nightly_recheck (
  department_id TEXT NOT NULL,
  day TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  review_job_id TEXT,
  versions INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (department_id, day, binding_id)
)`;

/** Versions one review job takes; the rest waits for the next night. */
export const RECHECK_VERSION_LIMIT = 20;

export type AcceptedVersion = {
  jobId: string;
  key: string;
  title: string;
  bindingId: string;
  artifactId: string;
  version: number;
  hash: string;
  acceptedAt: string;
};

export type RecheckRules = { nightlyRecheck: boolean; nightlyRecheckHour: number };

export type NightlyRecheckPorts = {
  db: SqlDatabase;
  departments: () => { id: string; name: string }[];
  rules: (departmentId: string) => RecheckRules;
  createReview: (input: { departmentId: string; bindingId: string; day: string; versions: AcceptedVersion[] }) => DomainResult<Job>;
  attach: (review: Job, version: AcceptedVersion) => Promise<DomainResult<unknown>>;
  queue: (review: Job) => DomainResult<unknown>;
  comment: (job: Job, text: string) => void;
  now: () => Date;
  en: () => boolean;
};

function tableExists(db: SqlDatabase, name: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}

/** Calendar day of the BB server, YYYY-MM-DD. */
export function serverDay(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Versions of the department's jobs accepted in (from, to]; review jobs of the Agency itself are left out. */
export function acceptedBetween(db: SqlDatabase, departmentId: string, from: string, to: string): AcceptedVersion[] {
  const own = [
    ...(tableExists(db, "agency_nightly_recheck") ? ["SELECT review_job_id FROM agency_nightly_recheck WHERE review_job_id IS NOT NULL"] : []),
    ...(tableExists(db, "agency_auto_review") ? ["SELECT review_job_id FROM agency_auto_review WHERE review_job_id IS NOT NULL"] : []),
  ];
  const rows = db
    .prepare(
      `SELECT a.job_id, j.key, j.title, j.binding_id, a.artifact_id, a.version, a.hash, a.accepted_at
       FROM agency_artifact_acceptance a JOIN agency_job j ON j.id = a.job_id
       WHERE j.department_id = ? AND a.accepted_at > ? AND a.accepted_at <= ?
       ${own.length ? `AND a.job_id NOT IN (${own.join(" UNION ")})` : ""}
       ORDER BY a.accepted_at`,
    )
    .all(departmentId, from, to) as {
    job_id: string;
    key: string;
    title: string;
    binding_id: string;
    artifact_id: string;
    version: number;
    hash: string;
    accepted_at: string;
  }[];
  return rows.map((row) => ({
    jobId: row.job_id,
    key: row.key,
    title: row.title,
    bindingId: row.binding_id,
    artifactId: row.artifact_id,
    version: row.version,
    hash: row.hash,
    acceptedAt: row.accepted_at,
  }));
}

export function recheckJobText(day: string, versions: readonly AcceptedVersion[], en: boolean) {
  const list = versions.map((item) => `- ${item.key} «${item.title}» — v${item.version}, hash ${item.hash.slice(0, 12)}`).join("\n");
  if (en) {
    return {
      title: `Nightly recheck: accepted on ${day}`,
      brief: `Independent recheck of results accepted since the previous recheck. Each version is attached as input: open it by hash, do not trust working files. Check it against the acceptance criteria of its job (\`bb agency job get\`).\n${list}\nDo not fix anything: describe defects (criterion → place → how to reproduce → severity). The acceptance already given stays; the owner decides what to do with your findings.`,
      acceptance: "The recheck report is published as a version: every listed version is marked confirmed or has its defects described with criterion, place and severity.",
    };
  }
  return {
    title: `Ночная перепроверка: принятое ${day}`,
    brief: `Независимая перепроверка результатов, принятых после прошлой перепроверки. Каждая версия приложена входом: открывайте её по hash, рабочим файлам на слово не верьте. Проверяйте по критериям приёмки её задачи (\`bb agency job get\`).\n${list}\nНичего не правьте: описывайте дефекты (критерий → место → как воспроизвести → серьёзность). Приёмка остаётся в силе, решение по находкам за владельцем.`,
    acceptance: "Отчёт перепроверки опубликован версией: у каждой версии из списка — «подтверждено» или описанные дефекты с критерием, местом и серьёзностью.",
  };
}

/** Creates the recheck jobs that are due. Returns the keys of the review jobs created. */
export async function sweepNightlyRecheck(ports: NightlyRecheckPorts): Promise<string[]> {
  if (!tableExists(ports.db, "agency_nightly_recheck")) return [];
  const now = ports.now();
  const nowIso = now.toISOString();
  const day = serverDay(now);
  const created: string[] = [];
  for (const department of ports.departments()) {
    const rules = ports.rules(department.id);
    if (!rules.nightlyRecheck || now.getHours() < rules.nightlyRecheckHour) continue;
    const done = ports.db.prepare(`SELECT 1 FROM agency_nightly_recheck WHERE department_id = ? AND day = ?`).get(department.id, day);
    if (done) continue;
    const previous = ports.db
      .prepare(`SELECT MAX(window_end) AS end FROM agency_nightly_recheck WHERE department_id = ?`)
      .get(department.id) as { end: string | null };
    const from = previous.end ?? new Date(now.getTime() - 24 * 3_600_000).toISOString();
    const record = (bindingId: string, reviewJobId: string | null, versions: number, outcome: string, windowEnd = nowIso) =>
      ports.db
        .prepare(
          `INSERT OR IGNORE INTO agency_nightly_recheck (department_id, day, binding_id, review_job_id, versions, outcome, window_start, window_end, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(department.id, day, bindingId, reviewJobId, versions, outcome.slice(0, 500), from, windowEnd, nowIso);
    const accepted = acceptedBetween(ports.db, department.id, from, nowIso);
    if (!accepted.length) {
      record("", null, 0, "nothing_accepted");
      continue;
    }
    // Versions over the limit stay for the next night: the window ends at the last one taken.
    const taken = accepted.slice(0, RECHECK_VERSION_LIMIT);
    const left = accepted.length - taken.length;
    const windowEnd = left ? taken.at(-1)!.acceptedAt : nowIso;
    const byBinding = new Map<string, AcceptedVersion[]>();
    for (const item of taken) byBinding.set(item.bindingId, [...(byBinding.get(item.bindingId) ?? []), item]);
    for (const [bindingId, versions] of byBinding) {
      const review = ports.createReview({ departmentId: department.id, bindingId, day, versions });
      if (!review.ok) {
        record(bindingId, null, versions.length, `create_failed: ${review.error.message}`, windowEnd);
        continue;
      }
      record(bindingId, review.value.id, versions.length, "created", windowEnd);
      created.push(review.value.key);
      const problems: string[] = [];
      let attached = 0;
      for (const version of versions) {
        const result = await ports.attach(review.value, version);
        if (result.ok) attached += 1;
        else problems.push(`${version.key} v${version.version}: ${result.error.message}`);
      }
      const en = ports.en();
      if (!attached) {
        ports.comment(
          review.value,
          [en ? "No version could be attached; the recheck is not queued. Attach the inputs by hand or cancel the job." : "Ни одну версию не удалось приложить, перепроверка не поставлена в очередь. Приложите входы вручную или отмените задачу.", ...problems.map((line) => `- ${line}`)].join("\n"),
        );
        continue;
      }
      const queued = ports.queue(review.value);
      const notes = [
        en ? `Nightly recheck: versions attached ${attached} of ${versions.length}.` : `Ночная перепроверка: приложено версий ${attached} из ${versions.length}.`,
        ...problems.map((line) => `- ${line}`),
        ...(left ? [en ? `${left} more versions of the department wait for the next night.` : `Ещё ${left} версий отдела ждут следующей ночи.`] : []),
        ...(queued.ok ? [] : [en ? `Not queued for launch: ${queued.error.message}` : `В очередь запуска не поставлена: ${queued.error.message}`]),
      ];
      ports.comment(review.value, notes.join("\n"));
    }
  }
  return created;
}

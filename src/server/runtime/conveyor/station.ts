import { fail, ok, type DomainResult } from "../../../domain";
import type { ArtifactVersion, Job } from "../../../shared/contracts";
import type { SqlDatabase } from "../../db/sql";
import { agencyLanguage } from "../../i18n/language.js";
import type { ServiceContext } from "../../services/context.js";
import type { AutoReviewOutcome, AutoReviewPorts, HandedInVersion } from "../auto-review/service.js";
import { startAutoReview } from "../auto-review/service.js";
import { parseReviewVerdict } from "./verdict.js";

/** How long a queued QC station may sit before the conveyor closes the work. */
export const STALE_REVIEW_MS = 30 * 60 * 1000;

const CLOSED = new Set(["done", "canceled"]);

export type AcceptInput = {
  requestId: string;
  expectedRevision: number;
  jobId: string;
  artifactId: string;
  version: number;
  hash: string;
};

export type ConveyorStore = {
  getJob: (id: string) => Job | undefined;
  acceptArtifactVersion: (ctx: ServiceContext, input: AcceptInput) => DomainResult<ArtifactVersion>;
  transitionJob: (
    ctx: ServiceContext,
    input: { requestId: string; expectedRevision: number; jobId: string; to: "canceled" },
  ) => DomainResult<Job>;
};

export type ClosePorts = {
  db: SqlDatabase;
  store: ConveyorStore;
  ctx: ServiceContext;
  requestId: (seed: string) => string;
  comment: (job: Job, text: string) => boolean;
  /** The line closed a root job: the customer hears «the product is ready», once, with the result. */
  productReady?: (job: Job, result: HandedInVersion) => void;
};

export type HandInGateDecision = { action: "rework"; remark: string };

export type ConveyorPorts = ClosePorts & {
  autoReview: AutoReviewPorts;
  returnForRework?: (job: Job, comment: string) => Promise<DomainResult<Job>>;
  /** First pass on an executor hand-in. Rework only; accept never skips independent QC. */
  handInGate?: (job: Job) => Promise<HandInGateDecision | null>;
  /** Once per rework verdict. Writes a loop mark or does nothing. Fail-open. */
  classifyLoop?: (job: Job) => Promise<void>;
  now?: () => string;
  staleMs?: number;
};

export type ConveyorAdvance = "pending" | "created" | "closed" | "rework" | "idle";

export function latestHandedInVersion(db: SqlDatabase, jobId: string): HandedInVersion | null {
  const row = db
    .prepare(`SELECT artifact_id, version, hash FROM agency_artifact_version WHERE job_id = ? ORDER BY rowid DESC LIMIT 1`)
    .get(jobId) as { artifact_id: string; version: number; hash: string } | undefined;
  return row ? { artifactId: row.artifact_id, version: row.version, hash: row.hash } : null;
}

export function workJobIdForReview(db: SqlDatabase, reviewJobId: string): string | null {
  const row = db
    .prepare(`SELECT job_id FROM agency_auto_review WHERE review_job_id = ? LIMIT 1`)
    .get(reviewJobId) as { job_id: string } | undefined;
  return row?.job_id ?? null;
}

export function isAutoReviewJob(db: SqlDatabase, jobId: string): boolean {
  return Boolean(
    db.prepare(`SELECT 1 FROM agency_auto_review WHERE review_job_id = ? LIMIT 1`).get(jobId),
  );
}

function latestComment(db: SqlDatabase, jobId: string): string {
  const row = db
    .prepare(
      `SELECT comment FROM agency_activity WHERE job_id = ? AND kind = 'comment' AND comment IS NOT NULL ORDER BY rowid DESC LIMIT 1`,
    )
    .get(jobId) as { comment: string | null } | undefined;
  return row?.comment?.trim() ?? "";
}

function autoReviewJobIds(db: SqlDatabase): Set<string> {
  const rows = db
    .prepare(`SELECT review_job_id FROM agency_auto_review WHERE review_job_id IS NOT NULL`)
    .all() as Array<{ review_job_id: string }>;
  return new Set(rows.map((row) => row.review_job_id));
}

/** «The product is ready»: what the customer gets instead of an accept button on every station. */
export function productReadyMessage(
  db: SqlDatabase,
  job: Job,
  result: HandedInVersion,
): { text: string; jobId: string; dedupeKey: string } {
  const row = db
    .prepare(`SELECT relative_path FROM agency_artifact_version WHERE artifact_id = ? AND job_id = ? AND version = ?`)
    .get(result.artifactId, job.id, result.version) as { relative_path: string } | undefined;
  const file = row?.relative_path ?? "";
  const en = agencyLanguage() === "en";
  const text = en
    ? `The product is ready: ${job.key} «${job.title}».${file ? ` Result: ${file} (version ${result.version}).` : ""} Nothing to accept: the line has checked it. If it is not what you ordered, return ${job.key} with a remark.`
    : `Продукт готов: ${job.key} «${job.title}».${file ? ` Результат: ${file} (версия ${result.version}).` : ""} Принимать ничего не нужно: линия его проверила. Если это не то, что заказывали, верните ${job.key} с замечанием.`;
  // The hash keeps one message per delivered version: a reclaimed product is announced again.
  return { text, jobId: job.id, dedupeKey: `product-ready:${job.id}:${result.hash}` };
}

/** Work children (QC jobs excluded) that are still on the line. */
export function openWorkChildren(db: SqlDatabase, jobId: string): number {
  const rows = db
    .prepare(`SELECT id, state FROM agency_job WHERE parent_job_id = ?`)
    .all(jobId) as Array<{ id: string; state: string }>;
  const qc = autoReviewJobIds(db);
  return rows.filter((row) => !qc.has(row.id) && !CLOSED.has(row.state)).length;
}

/** A QC job of this station that may still hand in a verdict. */
function liveQc(ports: ClosePorts, jobId: string): Job | null {
  const claim = ports.db
    .prepare(`SELECT review_job_id FROM agency_auto_review WHERE job_id = ? AND review_job_id IS NOT NULL ORDER BY rowid DESC LIMIT 1`)
    .get(jobId) as { review_job_id: string } | undefined;
  const review = claim ? ports.store.getJob(claim.review_job_id) : undefined;
  if (!review || CLOSED.has(review.state) || review.state === "blocked") return null;
  return review;
}

/** True when the result says the job is done now; a held or skipped station is not a close. */
function closedNow(result: DomainResult<Job | null>): result is { ok: true; value: Job } {
  return result.ok && result.value?.state === "done";
}

function systemCtx(ctx: ServiceContext, bindingId: string): ServiceContext {
  return { actor: { kind: "system" }, allowedBindingIds: [bindingId], caller: undefined };
}

/**
 * Closes a station on its published version. `seed` names the reason; the request id also carries
 * the job revision, so a station that comes back (rework, reclamation) is closed again instead of
 * replaying the remembered result of the previous round.
 */
export function closeStation(ports: ClosePorts, jobId: string, seed: string): DomainResult<Job | null> {
  const job = ports.store.getJob(jobId);
  if (!job) return fail("not_found", `job ${jobId} not found`);
  if (job.state === "done") {
    discardOpenReviews(ports, jobId);
    closeParentIfChildrenDone(ports, jobId);
    return ok(job);
  }
  if (job.state !== "review") return ok(null);
  // A parent is not a product while its work children are on the line; the last child closes it.
  if (openWorkChildren(ports.db, jobId) > 0) return ok(null);
  const version = latestHandedInVersion(ports.db, jobId);
  if (!version) {
    return fail("missing_transition_guard", `review ${job.key} has no published version to accept`);
  }
  const accepted = ports.store.acceptArtifactVersion(ports.ctx, {
    requestId: ports.requestId(`${seed}:${job.id}:${job.revision}`),
    expectedRevision: job.revision,
    jobId,
    artifactId: version.artifactId,
    version: version.version,
    hash: version.hash,
  });
  if (!accepted.ok) return accepted;
  discardOpenReviews(ports, jobId);
  const closed = ports.store.getJob(jobId) ?? job;
  if (closed.state === "done" && !closed.parentJobId && !isAutoReviewJob(ports.db, closed.id)) {
    ports.productReady?.(closed, version);
  }
  closeParentIfChildrenDone(ports, jobId);
  return ok(closed);
}

/**
 * An explicit accept (CLI, RPC, the card): the job is done in the same command and the line moves on —
 * the parent closes when this was its last open work child. No second transition is asked of anyone.
 */
export function acceptOnLine<T extends AcceptInput>(ports: ClosePorts, input: T): DomainResult<ArtifactVersion> {
  const accepted = ports.store.acceptArtifactVersion(ports.ctx, input);
  if (accepted.ok) {
    discardOpenReviews(ports, input.jobId);
    closeParentIfChildrenDone(ports, input.jobId);
  }
  return accepted;
}

export function discardOpenReviews(ports: ClosePorts, workJobId: string): void {
  const rows = ports.db
    .prepare(`SELECT review_job_id FROM agency_auto_review WHERE job_id = ? AND review_job_id IS NOT NULL`)
    .all(workJobId) as Array<{ review_job_id: string }>;
  for (const row of rows) {
    const review = ports.store.getJob(row.review_job_id);
    if (!review || CLOSED.has(review.state)) continue;
    if (review.state === "review") {
      if (closedNow(closeStation(ports, review.id, "conveyor-qc-done"))) continue;
    }
    ports.store.transitionJob(systemCtx(ports.ctx, review.bindingId), {
      requestId: ports.requestId(`conveyor-qc-cancel:${review.id}`),
      expectedRevision: ports.store.getJob(review.id)?.revision ?? review.revision,
      jobId: review.id,
      to: "canceled",
    });
  }
}

export function closeParentIfChildrenDone(ports: ClosePorts, childJobId: string): DomainResult<Job | null> {
  const child = ports.store.getJob(childJobId);
  if (!child?.parentJobId) return ok(null);
  const parent = ports.store.getJob(child.parentJobId);
  if (!parent || parent.state !== "review") return ok(null);
  const siblings = ports.db
    .prepare(`SELECT id, state FROM agency_job WHERE parent_job_id = ?`)
    .all(parent.id) as Array<{ id: string; state: string }>;
  const qc = autoReviewJobIds(ports.db);
  const work = siblings.filter((row) => !qc.has(row.id));
  if (work.length === 0) return ok(null);
  if (!work.every((row) => CLOSED.has(row.state))) return ok(null);
  // The latest reviewer said rework: accepting their report is not accepting the product.
  if (latestReviewerHoldsParent(ports, parent.id)) return ok(null);
  // The parent's own QC is still reading: its verdict (or the stale sweep) closes the parent.
  if (liveQc(ports, parent.id)) return ok(null);
  return closeStation(ports, parent.id, "conveyor-parent");
}

export async function applyReviewHandIn(
  ports: ConveyorPorts,
  workJobId: string,
  reviewJobId: string,
): Promise<ConveyorAdvance> {
  const work = ports.store.getJob(workJobId);
  const review = ports.store.getJob(reviewJobId);
  if (!work || !review) return "idle";
  const verdict = parseReviewVerdict(latestComment(ports.db, reviewJobId));
  const en = agencyLanguage() === "en";
  if (review.state === "review") {
    closeStation(ports, review.id, "conveyor-qc-handin");
  }
  if (verdict === "rework") {
    const remark = latestComment(ports.db, reviewJobId) || (en ? "QC: rework." : "ОТК: доработать.");
    if (ports.returnForRework) {
      const returned = await ports.returnForRework(work, remark);
      if (returned.ok) {
        ports.comment(
          work,
          en ? `Conveyor: QC returned ${work.key} for rework.` : `Конвейер: ОТК вернуло ${work.key} на доработку.`,
        );
        return "rework";
      }
      if (returned.error.code === "loop_blocked") {
        ports.comment(
          work,
          en
            ? `Conveyor: loop mark blocked another pass on ${work.key}. Ask the owner with report-needs-input.`
            : `Конвейер: стоп круга не пустил повтор ${work.key}. Спросите владельца через report-needs-input.`,
        );
        return "rework";
      }
      ports.comment(
        work,
        en
          ? `Conveyor: QC asked for rework, but the worker thread is gone (${returned.error.message}).`
          : `Конвейер: ОТК просит доработку, но тред исполнителя уже нет (${returned.error.message}).`,
      );
    }
    return "rework";
  }
  const closed = closeStation(ports, work.id, "conveyor-qc-accept");
  if (closedNow(closed)) {
    ports.comment(
      work,
      en ? `Conveyor: QC accepted ${work.key}; the station is closed.` : `Конвейер: ОТК приняло ${work.key}, станция закрыта.`,
    );
    return "closed";
  }
  if (closed.ok && openWorkChildren(ports.db, work.id) > 0) {
    ports.comment(
      work,
      en
        ? `Conveyor: QC accepted ${work.key}; it closes with its last subtask.`
        : `Конвейер: ОТК приняло ${work.key}; задача закроется вместе с последней подзадачей.`,
    );
    return "pending";
  }
  return "idle";
}

function membershipRole(db: SqlDatabase, departmentId: string, agentId: string | null): string | null {
  if (!agentId) return null;
  const row = db
    .prepare(`SELECT role FROM agency_membership WHERE department_id = ? AND agent_id = ?`)
    .get(departmentId, agentId) as { role: string } | undefined;
  return row?.role ?? null;
}

/** The newest comment that actually carries a verdict line. Later conveyor notes do not count. */
function latestVerdictText(db: SqlDatabase, jobId: string): string {
  const rows = db
    .prepare(
      `SELECT comment FROM agency_activity WHERE job_id = ? AND kind = 'comment' AND comment IS NOT NULL ORDER BY rowid DESC`,
    )
    .all(jobId) as Array<{ comment: string }>;
  const line = /(?:вердикт|verdict)\s*[:：]?\s*(?:принять|accept|доработать|rework|return)/i;
  for (const row of rows) {
    if (line.test(row.comment)) return row.comment;
  }
  return rows[0]?.comment?.trim() ?? "";
}

function reviewerRework(ports: ClosePorts, jobId: string): boolean {
  const job = ports.store.getJob(jobId);
  if (!job || membershipRole(ports.db, job.departmentId, job.assignedAgentId) !== "reviewer") return false;
  return parseReviewVerdict(latestVerdictText(ports.db, jobId)) === "rework";
}

/** The last reviewer on the line asked for rework. Their report stays; the product stays open. */
function latestReviewerHoldsParent(ports: ClosePorts, parentId: string): boolean {
  const siblings = ports.db
    .prepare(`SELECT id FROM agency_job WHERE parent_job_id = ? ORDER BY rowid`)
    .all(parentId) as Array<{ id: string }>;
  let lastReviewerId: string | null = null;
  for (const row of siblings) {
    const job = ports.store.getJob(row.id);
    if (!job) continue;
    if (membershipRole(ports.db, job.departmentId, job.assignedAgentId) === "reviewer") lastReviewerId = job.id;
  }
  return lastReviewerId !== null && parseReviewVerdict(latestVerdictText(ports.db, lastReviewerId)) === "rework";
}

export async function advanceAfterHandIn(ports: ConveyorPorts, jobId: string): Promise<ConveyorAdvance> {
  if (reviewerRework(ports, jobId)) {
    const review = ports.store.getJob(jobId);
    if (review) await ports.classifyLoop?.(review).catch(() => undefined);
  }
  const workId = workJobIdForReview(ports.db, jobId);
  if (workId) return applyReviewHandIn(ports, workId, jobId);
  const job = ports.store.getJob(jobId);
  if (job && ports.handInGate && ports.returnForRework) {
    const gate = await ports.handInGate(job);
    if (gate?.action === "rework") {
      const returned = await ports.returnForRework(job, gate.remark);
      if (returned.ok) {
        const en = agencyLanguage() === "en";
        ports.comment(
          job,
          en
            ? "Conveyor: the decision model sent the hand-in back for rework before independent QC."
            : "Конвейер: оценщик вернул сдачу на доработку до независимой проверки.",
        );
        return "rework";
      }
    }
  }
  const outcome: AutoReviewOutcome = await startAutoReview(ports.autoReview, jobId);
  if (outcome === "created" || outcome === "pending") return outcome;
  if (job && !job.parentJobId && latestReviewerHoldsParent(ports, job.id)) {
    const en = agencyLanguage() === "en";
    ports.comment(
      job,
      en
        ? "Conveyor: the latest review asked for rework, so this hand-in does not accept the product."
        : "Конвейер: последняя проверка просит доработку, эта сдача продукт не закрывает.",
    );
    return "rework";
  }
  const closed = closeStation(ports, jobId, "conveyor-skip-qc");
  if (closed.ok && !closedNow(closed)) return openWorkChildren(ports.db, jobId) > 0 ? "pending" : "idle";
  if (closedNow(closed)) {
    const en = agencyLanguage() === "en";
    const held = reviewerRework(ports, jobId);
    ports.comment(
      closed.value,
      held
        ? en
          ? "Conveyor: this review report does not accept the product. A loop mark can refuse the next station."
          : "Конвейер: этот отчёт проверки продукт не закрывает. Стоп круга может не пустить следующую станцию."
        : outcome === "failed"
          ? en
            ? "Conveyor: automatic QC failed; the station is closed on the published version."
            : "Конвейер: автопроверка не создалась; станция закрыта по опубликованной версии."
          : en
            ? "Conveyor: QC is not required for this station; the published version is accepted."
            : "Конвейер: ОТК этой станции не нужно; опубликованная версия принята.",
    );
  }
  return closedNow(closed) ? "closed" : "idle";
}

type AutoReviewRow = {
  job_id: string;
  review_job_id: string | null;
  outcome: string;
  created_at: string;
};

export function sweepStaleReviewStations(ports: ConveyorPorts): number {
  const now = Date.parse(ports.now?.() ?? new Date().toISOString());
  const staleMs = ports.staleMs ?? STALE_REVIEW_MS;
  const jobs = ports.db
    .prepare(`SELECT id FROM agency_job WHERE state = 'review'`)
    .all() as Array<{ id: string }>;
  let closed = 0;
  const en = agencyLanguage() === "en";
  for (const row of jobs) {
    const job = ports.store.getJob(row.id);
    if (!job || job.state !== "review") continue;
    if (isAutoReviewJob(ports.db, job.id)) {
      const workId = workJobIdForReview(ports.db, job.id);
      const work = workId ? ports.store.getJob(workId) : undefined;
      if (work && CLOSED.has(work.state)) {
        if (closedNow(closeStation(ports, job.id, "conveyor-orphan-qc"))) closed += 1;
      }
      continue;
    }
    const claim = ports.db
      .prepare(`SELECT job_id, review_job_id, outcome, created_at FROM agency_auto_review WHERE job_id = ? ORDER BY rowid DESC LIMIT 1`)
      .get(job.id) as AutoReviewRow | undefined;
    if (claim?.review_job_id) {
      const review = ports.store.getJob(claim.review_job_id);
      const reviewAge = Date.parse(claim.created_at);
      const stuck =
        !review ||
        review.state === "blocked" ||
        review.state === "canceled" ||
        (!Number.isNaN(reviewAge) && now - reviewAge >= staleMs);
      if (!stuck) continue;
      // A held parent (open subtasks) is not closed and gets no comment on every sweep.
      if (closedNow(closeStation(ports, job.id, "conveyor-stale"))) {
        closed += 1;
        ports.comment(
          job,
          en
            ? `Conveyor: QC ${review?.key ?? claim.review_job_id} stalled; the work station is closed.`
            : `Конвейер: проверка ${review?.key ?? claim.review_job_id} зависла; рабочая станция закрыта.`,
        );
      }
      continue;
    }
    const handed = Date.parse(job.updatedAt);
    if (!Number.isNaN(handed) && now - handed < 120_000 && !claim) continue;
    if (closedNow(closeStation(ports, job.id, "conveyor-no-qc"))) closed += 1;
  }
  return closed;
}

export function closeBlockedReviewStation(ports: ConveyorPorts, jobId: string): DomainResult<Job | null> {
  const workId = workJobIdForReview(ports.db, jobId);
  if (!workId) return ok(null);
  const work = ports.store.getJob(workId);
  if (!work || work.state !== "review") return ok(null);
  const en = agencyLanguage() === "en";
  ports.comment(
    work,
    en
      ? "Conveyor: the QC run stopped; the work station is closed on the published version."
      : "Конвейер: запуск проверки остановился; рабочая станция закрыта по опубликованной версии.",
  );
  return closeStation(ports, work.id, "conveyor-qc-blocked");
}

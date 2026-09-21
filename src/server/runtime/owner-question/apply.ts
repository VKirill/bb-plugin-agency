import { sha256Hex } from "../context-snapshot/canonical.js";
import { uuidV5 } from "../launch/operation-ids.js";
import { answerNeedsInput } from "../needs-input/answer.js";
import { readNeedsInputRecord } from "../needs-input/report.js";
import type { IsolatedSendPort } from "../isolated-sdk/send-port.js";
import type { InternalRunStoreReads, RunStore } from "../run-store/types.js";
import type { SqlDatabase } from "../../db/sql";
import type { DomainStore } from "../../services";
import { resolveRpcAccess } from "../../api/auth.js";
import type { OwnerQuestionPayload, OwnerQuestionResponse } from "../../../shared/contracts/owner-question";
import type { NeedsInputAnswer } from "../../../shared/contracts/needs-input";

export type ApplyOwnerQuestionDeps = {
  db: SqlDatabase;
  store: DomainStore;
  reads: Pick<InternalRunStoreReads, "getAttempt" | "getLaunchReceipt" | "getSnapshot">;
  runs: Pick<RunStore, "transitionAttempt">;
  send: IsolatedSendPort;
};

export async function applyOwnerQuestionAnswers(
  deps: ApplyOwnerQuestionDeps,
  payload: OwnerQuestionPayload,
  response: OwnerQuestionResponse,
): Promise<{ applied: string[]; errors: string[] }> {
  const byWait = new Map<string, NeedsInputAnswer[]>();
  for (const item of payload.items) {
    const text = response.answers[item.id]?.trim();
    if (!text) continue;
    for (const target of item.targets) {
      const list = byWait.get(target.waitId) ?? [];
      if (!list.some((answer) => answer.questionId === target.questionId)) {
        list.push({ questionId: target.questionId, text });
      }
      byWait.set(target.waitId, list);
    }
  }

  const applied: string[] = [];
  const errors: string[] = [];
  const access = resolveRpcAccess(deps.db);
  if (!access.ok) return { applied, errors: [access.error.message] };

  for (const [waitId, answers] of byWait) {
    const sample = payload.items.flatMap((item) => item.targets).find((target) => target.waitId === waitId);
    if (!sample) continue;
    const jobId = payloadJobIdForWait(deps.db, waitId);
    if (!jobId) {
      errors.push(`${waitId}: job missing`);
      continue;
    }
    const record = readNeedsInputRecord(deps.db, jobId);
    if (!record || record.waitId !== waitId) {
      errors.push(`${waitId}: wait closed`);
      continue;
    }
    const job = deps.store.getJob(jobId);
    const department = job ? deps.store.getDepartment(job.departmentId) : undefined;
    const process = department ? deps.store.getProcessVersion(department.processVersionId) : undefined;
    const launch = deps.reads.getLaunchReceipt(access.value.ctx, record.launchId);
    if (!job || !department || !process || !launch.ok) {
      errors.push(`${waitId}: pins unavailable`);
      continue;
    }
    const result = await answerNeedsInput(
      {
        db: deps.db,
        store: deps.store,
        runs: deps.runs,
        reads: deps.reads,
        send: deps.send,
      },
      access.value.ctx,
      {
        requestId: uuidV5(waitId, "agency.ownerQuestion.answer"),
        expectedRevision: job.revision,
        jobId,
        expectedAttemptRevision: record.attemptRevision,
        attemptId: record.attemptId,
        launchId: record.launchId,
        threadId: record.threadId,
        waitId,
        answers,
        expectedProcessVersionId: department.processVersionId,
        expectedSnapshotDigest: launch.value.digest,
        expectedProcessInstructionsHash: sha256Hex(process.instructions),
        expectedProcessAcceptanceHash: sha256Hex(process.acceptance),
        expectedJobBriefHash: sha256Hex(job.brief),
        expectedJobAcceptanceHash: sha256Hex(job.acceptance),
      },
    );
    if (result.ok) applied.push(jobId);
    else errors.push(`${waitId}: ${result.error.message}`);
  }
  return { applied, errors };
}

function payloadJobIdForWait(db: SqlDatabase, waitId: string): string | null {
  const row = db
    .prepare(`SELECT job_id FROM agency_job_needs_input_wait WHERE wait_id = ?`)
    .get(waitId) as { job_id: string } | undefined;
  return row?.job_id ?? null;
}

import { randomUUID } from "node:crypto";
import type { SqlDatabase } from "../../db/sql";
import { recordTrace, traceCode } from "./store";

const OPERATIONS = new Set(["recordLessonFeedback", "recordLeadDecision", "submitJobResult", "createJob", "updateJob", "transitionJob", "createArtifact", "publishArtifactVersion", "attachJobInput", "addJobDependency", "removeJobDependency", "setJobNextStep", "reportNeedsInput", "answerNeedsInput", "acceptArtifactVersion", "prepareLaunch", "reconcileLaunch", "interpretWorkerCompletion", "cancelLaunch", "returnJobForRework", "getIsolationReadiness"]);
function obj(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }

/** Wrap existing handlers without changing arguments, results or thrown errors. No input/result bodies are recorded. */
export function traceHandlers<T extends object>(db: SqlDatabase, handlers: T): T {
  return Object.fromEntries(Object.entries(handlers).map(([step, handler]) => {
    if (!OPERATIONS.has(step) || typeof handler !== "function") return [step, handler];
    return [step, async (raw: unknown) => {
      const input = obj(raw); const read = step === "getIsolationReadiness";
      const jobId = traceCode(input.jobId) ?? traceCode(input.targetJobId) ?? traceCode(input.parentJobId);
      const requestId = read ? null : traceCode(input.requestId) ?? randomUUID();
      const facts = { expectedRevision: input.expectedRevision, version: input.version };
      const started = Date.now();
      if (!read) recordTrace(db, { jobId, step, requestId, outcome: "started", reason: "requested", facts });
      try {
        const result: unknown = await handler(raw);
        const outer = obj(result); const value = obj(outer.value); const error = obj(outer.error);
        const returnedJob = step === "createJob" ? traceCode(value.id) : null;
        const notStarted = step === "prepareLaunch" && outer.ok === true && !value.launched;
        const waiting = (read && value.launchAllowedForAssigned === false) || notStarted;
        recordTrace(db, { jobId: returnedJob ?? jobId, step, requestId,
          outcome: outer.ok === false ? "failed" : waiting ? "waiting" : "succeeded",
          reason: traceCode(error.code) ?? traceCode(value.reasonCode) ?? (waiting ? "launch_not_started" : "completed"),
          artifactHash: traceCode(value.hash) ?? traceCode(input.hash), relatedJobId: traceCode(input.sourceJobId),
          attemptId: traceCode(value.attemptId), launchId: traceCode(value.launchId), threadId: traceCode(value.threadId),
          durationMs: Date.now() - started, facts: { ...facts, afterState: value.state }, collapse: read });
        return result;
      } catch (error) {
        recordTrace(db, { jobId, step, requestId, outcome: "failed", reason: "exception", durationMs: Date.now() - started, facts });
        throw error;
      }
    }];
  })) as T;
}

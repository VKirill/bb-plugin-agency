import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { callerAttemptForThread } from "../../api/caller.js";
import type { IsolatedSendPort } from "../isolated-sdk/send-port.js";
import type { InternalRunStoreReads, RunStore } from "../run-store/types.js";
import type { SqlDatabase } from "../../db/sql";
import type { DomainStore } from "../../services";
import {
  OWNER_QUESTION_RENDERER_ID,
  ownerAskOverlayQuestionSchema,
  ownerQuestionPayloadSchema,
  ownerQuestionResponseSchema,
  type OwnerAskOverlayQuestion,
} from "../../../shared/contracts/owner-question";
import { applyOwnerQuestionAnswers } from "./apply.js";
import { buildOwnerQuestionPayload, listOpenOriginWaitsNeedingCard } from "./payload.js";

export type PresentOwnerQuestionDeps = {
  bb: BbPluginApi;
  db: SqlDatabase;
  store: DomainStore;
  reads: Pick<InternalRunStoreReads, "getAttempt" | "getLaunchReceipt" | "getSnapshot">;
  runs: Pick<RunStore, "transitionAttempt">;
  send: IsolatedSendPort;
};

export type PresentOwnerQuestionResult =
  | {
      ok: true;
      cancelled?: boolean;
      applied: string[];
      errors: string[];
      answers: Record<string, string>;
      remaining: boolean;
    }
  | { ok: false; error: string };

function overlayFromUnknown(value: unknown): OwnerAskOverlayQuestion[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const questions = (value as { questions?: unknown }).questions;
  if (!questions) return undefined;
  const parsed = ownerAskOverlayQuestionSchema.array().min(1).max(4).safeParse(questions);
  return parsed.success ? parsed.data : undefined;
}

export async function presentOwnerQuestions(
  deps: PresentOwnerQuestionDeps,
  input: { threadId: string; overlay?: unknown; signal?: AbortSignal },
): Promise<PresentOwnerQuestionResult> {
  if (callerAttemptForThread(deps.db, input.threadId)) {
    return { ok: false, error: "agency_ask_owner is for the commissioning chat. Hidden workers use report-needs-input." };
  }
  const overlay = overlayFromUnknown(input.overlay);
  const waits = listOpenOriginWaitsNeedingCard(deps.db, input.threadId);
  const payload = buildOwnerQuestionPayload(waits, overlay);
  if (!payload) return { ok: false, error: "No Agency questions are waiting in this chat." };
  const parsedPayload = ownerQuestionPayloadSchema.safeParse(payload);
  if (!parsedPayload.success) return { ok: false, error: parsedPayload.error.message };

  const keys = [...new Set(payload.jobs.map((job) => job.key))];
  const title = keys.length ? `Agency: ${keys.join(", ")}` : "Agency";
  let result;
  try {
    result = await deps.bb.ui.requestInput(
      {
        threadId: input.threadId,
        rendererId: OWNER_QUESTION_RENDERER_ID,
        title,
        payload: JSON.parse(JSON.stringify(parsedPayload.data)),
        timeoutMs: 50 * 60 * 1000,
      },
      input.signal ? { signal: input.signal } : undefined,
    );
  } catch (error) {
    return {
      ok: false,
      error: `Could not open the choice card (${error instanceof Error ? error.message : String(error)}). Only one prompt can wait at a time.`,
    };
  }
  if (result.outcome === "cancelled") {
    return { ok: true, cancelled: true, applied: [], errors: [], answers: {}, remaining: true };
  }
  const answers = ownerQuestionResponseSchema.safeParse(result.value);
  if (!answers.success) return { ok: false, error: "The choice card returned an invalid answer." };
  const applied = await applyOwnerQuestionAnswers(deps, parsedPayload.data, answers.data);
  return {
    ok: true,
    applied: applied.applied,
    errors: applied.errors,
    answers: answers.data.answers,
    remaining: listOpenOriginWaitsNeedingCard(deps.db, input.threadId).length > 0,
  };
}

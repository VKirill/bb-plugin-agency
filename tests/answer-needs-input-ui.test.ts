import { describe, expect, it, vi } from "vitest";
import type { AgencyApi, JobDetail } from "../src/app/data/agency-api";
import {
  ANSWER_INCOMPLETE_NOTICE,
  ANSWER_PIN_NOTICE,
  ANSWER_QUEUED_NOTICE,
  ANSWER_RECONCILE_NOTICE,
  ANSWER_STALE_WAIT_NOTICE,
  bindRequestToWait,
  collectAnswers,
  nextAnswerUiAction,
  readPersistedAnswerWait,
  submitAnswerNeedsInput,
  writePersistedAnswerWait,
} from "../src/app/data/answer-needs-input";
import { sha256Utf8 } from "../src/app/data/content-hash";
import type { NeedsInputRecord } from "../src/shared/contracts";

const waitA = "33333333-3333-4333-8333-333333333333";
const waitB = "44444444-4444-4444-8444-444444444444";
const requestOld = "22222222-2222-4222-8222-222222222222";

const record: NeedsInputRecord = {
  waitId: waitA,
  jobId: "job_2de115e5c5e8bd8b555a71a3",
  attemptId: "run_needsinput01",
  launchId: "11111111-1111-4111-8111-111111111111",
  threadId: "thr_needsinput01",
  requestId: requestOld,
  questions: [
    {
      id: "q1",
      text: "Первый",
      sourceRefs: [{ kind: "job_brief", id: "job_2de115e5c5e8bd8b555a71a3" }],
    },
    {
      id: "q2",
      text: "Второй",
      sourceRefs: [{ kind: "job_acceptance", id: "job_2de115e5c5e8bd8b555a71a3" }],
    },
  ],
  bodyHash: "a".repeat(64),
  jobState: "waiting_input",
  attemptState: "waiting_input",
  jobRevision: 6,
  attemptRevision: 3,
};

function apiStub(overrides: { waitId?: string } & Record<string, unknown> = {}): AgencyApi {
  const { waitId = waitA, ...rest } = overrides;
  const answer = vi.fn();
  return {
    getJob: vi.fn(async () => ({
      ok: true as const,
      value: {
        job: {
          id: record.jobId,
          revision: 6,
          departmentId: "dep_aaaaaaaaaaaaaaaaaaaaaa",
          brief: "Brief",
          acceptance: "Accept",
        },
        needsInput: { ...record, waitId },
      } as JobDetail,
    })),
    getDepartment: vi.fn(async () => ({
      ok: true as const,
      value: {
        department: { processVersionId: "prc_aaaaaaaaaaaaaaaaaaaaaa" },
        process: { instructions: "Do", acceptance: "Done" },
        memberships: [],
      },
    })),
    getLaunch: vi.fn(async () => ({
      ok: true as const,
      value: { attemptId: record.attemptId, launchId: record.launchId, digest: "b".repeat(64) },
    })),
    answerNeedsInput: answer,
    ...rest,
  } as unknown as AgencyApi;
}

describe("answerNeedsInput UI contract", () => {
  it("requires every question id and no extras", () => {
    expect(collectAnswers(record.questions, { q1: "one" })).toEqual({ ok: false, reason: ANSWER_INCOMPLETE_NOTICE });
    expect(collectAnswers(record.questions, { q1: "one", q2: "two", q3: "x" }).ok).toBe(false);
    expect(collectAnswers(record.questions, { q1: "one", q2: "two" })).toEqual({
      ok: true,
      answers: [{ questionId: "q1", text: "one" }, { questionId: "q2", text: "two" }],
    });
  });

  it("issues a new requestId when waitId changes", () => {
    const first = bindRequestToWait(null, waitA, () => "req-a");
    const same = bindRequestToWait(first, waitA, () => "req-other");
    const next = bindRequestToWait(first, waitB, () => "req-b");
    expect(same.requestId).toBe("req-a");
    expect(next).toEqual({ waitId: waitB, requestId: "req-b" });
  });

  it("treats queued and unknown as reconcile of the same request, not resend", () => {
    expect(nextAnswerUiAction({ waitId: waitA, sendState: "queued", inFlight: true })).toBe("wait");
    expect(nextAnswerUiAction({ waitId: waitA, sendState: "queued" })).toBe("reconcile");
    expect(nextAnswerUiAction({ waitId: waitA, sendState: "pending", inFlight: true })).toBe("wait");
    expect(nextAnswerUiAction({ waitId: waitA, sendState: "pending" })).toBe("reconcile");
    expect(nextAnswerUiAction({ waitId: waitA, sendState: "unknown" })).toBe("reconcile");
    expect(nextAnswerUiAction({ waitId: waitA, sendState: "needs_reconciliation" })).toBe("reconcile");
    expect(nextAnswerUiAction({ waitId: waitA })).toBe("send");
  });

  it("refuses to send when live waitId is a new cycle", async () => {
    const api = apiStub({ waitId: waitB });
    const result = await submitAnswerNeedsInput(api, {
      record,
      requestId: requestOld,
      answers: [{ questionId: "q1", text: "one" }, { questionId: "q2", text: "two" }],
    });
    expect(result).toEqual({ ok: false, reason: ANSWER_STALE_WAIT_NOTICE });
    expect(api.answerNeedsInput).not.toHaveBeenCalled();
  });

  it("pins process version, digest and content hashes on send", async () => {
    const api = apiStub();
    const answer = api.answerNeedsInput as ReturnType<typeof vi.fn>;
    answer.mockResolvedValue({
      ok: true,
      value: { sendState: "confirmed", waitId: waitA, turnActive: true },
    });
    const result = await submitAnswerNeedsInput(api, {
      record,
      requestId: "55555555-5555-4555-8555-555555555555",
      answers: [{ questionId: "q1", text: "one" }, { questionId: "q2", text: "two" }],
    });
    expect(result.ok).toBe(true);
    const command = answer.mock.calls[0][0];
    expect(command.waitId).toBe(waitA);
    expect(command.requestId).toBe("55555555-5555-4555-8555-555555555555");
    expect(command.answers.map((item: { questionId: string }) => item.questionId)).toEqual(["q1", "q2"]);
    expect(command.expectedProcessVersionId).toBe("prc_aaaaaaaaaaaaaaaaaaaaaa");
    expect(command.expectedSnapshotDigest).toBe("b".repeat(64));
    expect(command.expectedProcessInstructionsHash).toBe(await sha256Utf8("Do"));
    expect(command.expectedJobBriefHash).toBe(await sha256Utf8("Brief"));
  });

  it("does not call RPC when digest pin is missing", async () => {
    const api = apiStub({
      getLaunch: vi.fn(async () => ({
        ok: true as const,
        value: { attemptId: "run_other", launchId: record.launchId, digest: "b".repeat(64) },
      })),
    });
    const result = await submitAnswerNeedsInput(api, {
      record,
      requestId: "55555555-5555-4555-8555-555555555555",
      answers: [{ questionId: "q1", text: "one" }, { questionId: "q2", text: "two" }],
    });
    expect(result).toEqual({ ok: false, reason: ANSWER_PIN_NOTICE });
    expect(api.answerNeedsInput).not.toHaveBeenCalled();
  });

  it("maps queued and unknown notices without treating them as running", () => {
    expect(ANSWER_QUEUED_NOTICE).toMatch(/очереди/);
    expect(ANSWER_RECONCILE_NOTICE).toMatch(/сверка/);
  });

  it("keeps requestId across reload and treats unknown as reconcile not a new send id", () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => { memory.set(key, value); },
    } as Pick<Storage, "getItem" | "setItem"> as Storage;
    writePersistedAnswerWait({
      waitId: waitA,
      requestId: "55555555-5555-4555-8555-555555555555",
      texts: { q1: "one", q2: "two" },
      sendState: "unknown",
    }, storage);
    const restored = readPersistedAnswerWait(waitA, storage);
    expect(restored?.requestId).toBe("55555555-5555-4555-8555-555555555555");
    expect(nextAnswerUiAction({ waitId: waitA, sendState: restored?.sendState })).toBe("reconcile");
    const rebound = bindRequestToWait(null, waitA, () => "new-id", storage);
    expect(rebound.requestId).toBe("55555555-5555-4555-8555-555555555555");
  });

  it("queued after reload is reconcile of the stored requestId, not a new send", () => {
    expect(nextAnswerUiAction({ waitId: waitA, sendState: "queued" })).toBe("reconcile");
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => { memory.set(key, value); },
    } as Pick<Storage, "getItem" | "setItem"> as Storage;
    writePersistedAnswerWait({
      waitId: waitA,
      requestId: "55555555-5555-4555-8555-555555555555",
      texts: { q1: "one", q2: "two" },
      sendState: "queued",
    }, storage);
    const rebound = bindRequestToWait(null, waitA, () => "new-id", storage);
    expect(rebound.requestId).toBe("55555555-5555-4555-8555-555555555555");
  });
});

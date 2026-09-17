import { describe, expect, it } from "vitest";
import type { NeedsInputRecord } from "../src/shared/contracts";
import {
  NEEDS_INPUT_COMMENT_HINT,
  NEEDS_INPUT_NO_ANSWER_ACTION,
  jobDetailRefreshKey,
  needsInputSourceLabel,
  nextNeedsInputFromDetail,
  parseNeedsInputRecord,
} from "../src/app/data/needs-input";
import { nextLaunchAction, parseIsolationReadiness, parsePrepareLaunch } from "../src/app/data/launch-rpc";
import {
  PRODUCT_ASSIGNEE_REQUIRED,
  PRODUCT_HANDSHAKE_UNREADY,
  PRODUCT_LAUNCH_READY,
  PRODUCT_LAUNCH_STARTED,
  PRODUCT_LAUNCH_UNAVAILABLE,
  PRODUCT_PUBLICATION_VERIFIED,
  productInterpretNotice,
  productLaunchCopy,
  productPrepareLaunchNotice,
  technicalLaunchReason,
} from "../src/app/data/product-reasons";

const fullRecord = {
  waitId: "33333333-3333-4333-8333-333333333333",
  jobId: "job_2de115e5c5e8bd8b555a71a3",
  attemptId: "run_needsinput01",
  launchId: "11111111-1111-4111-8111-111111111111",
  threadId: "thr_needsinput01",
  requestId: "22222222-2222-4222-8222-222222222222",
  questions: [{
    id: "acceptance-conflict",
    text: "Какой acceptance выполнять?",
    sourceRefs: [
      { kind: "process_acceptance", id: "prc_457270d2215a6b9131a19455" },
      { kind: "job_acceptance", id: "job_2de115e5c5e8bd8b555a71a3" },
    ],
  }],
  bodyHash: "a".repeat(64),
  jobState: "waiting_input",
  attemptState: "waiting_input",
  jobRevision: 6,
  attemptRevision: 3,
} satisfies NeedsInputRecord;

describe("needsInput UI parse", () => {
  it("keeps every getJob.needsInput field and readable source kinds", () => {
    const parsed = parseNeedsInputRecord(fullRecord);
    expect(parsed).toEqual(fullRecord);
    expect(parsed?.bodyHash).toBe("a".repeat(64));
    expect(parsed?.jobRevision).toBe(6);
    expect(parsed?.requestId).toBe(fullRecord.requestId);
    expect(needsInputSourceLabel("process_acceptance")).toBe("Критерии процесса");
    expect(needsInputSourceLabel("job_acceptance")).toBe("Критерии задачи");
    expect(NEEDS_INPUT_COMMENT_HINT).toMatch(/не отвечает/);
    expect(NEEDS_INPUT_NO_ANSWER_ACTION).toMatch(/waitId/);
  });

  it("drops invalid or incomplete wire instead of inventing questions", () => {
    expect(parseNeedsInputRecord(null)).toBeNull();
    expect(parseNeedsInputRecord({ ...fullRecord, questions: [] })).toBeNull();
    expect(parseNeedsInputRecord({ ...fullRecord, jobState: "running" })).toBeNull();
  });

  it("clears the first-answer notice only when a new waitId arrives after confirmed null", () => {
    expect(jobDetailRefreshKey({ id: "AG-1610", recordId: "job_cc1b3e9080f8afeae6f740e9", revision: 6, state: "waiting_input" }))
      .toBe("job_cc1b3e9080f8afeae6f740e9:6:waiting_input");
    expect(nextNeedsInputFromDetail(fullRecord, null)).toEqual({ record: null, clearNotice: false });
    const second = {
      ...fullRecord,
      waitId: "60ee60fd-9919-5feb-8548-cd4c1cac152b",
      questions: [{
        id: "ASK_CYCLE_TWO",
        text: "ASK_CYCLE_TWO",
        sourceRefs: [{ kind: "job_brief", id: "job_2de115e5c5e8bd8b555a71a3" }],
      }],
    } satisfies NeedsInputRecord;
    expect(nextNeedsInputFromDetail(null, second)).toEqual({ record: second, clearNotice: true });
  });
});

describe("waiting_input launch wait", () => {
  it("does not prepare when job or durable needsInput is waiting_input", () => {
    const ready = {
      jobReady: true,
      handshakeReady: true,
      lastPrepare: null,
      hasLaunchId: true,
    };
    expect(nextLaunchAction({ ...ready, jobState: "waiting_input" })).toBe("wait");
    expect(nextLaunchAction({ ...ready, hasNeedsInput: true, jobState: "backlog" })).toBe("wait");
    expect(nextLaunchAction({ ...ready, attemptState: "waiting_input" })).toBe("wait");
    expect(nextLaunchAction({ ...ready, jobState: "waiting_input" })).not.toBe("prepare");
  });
});

describe("reasonCode-first launch copy", () => {
  it("prefers reasonCode over English technical reason", () => {
    expect(productLaunchCopy({
      reasonCode: "handshake_unready",
      reason: "GET /api/v1/system/experimental_thread-spawn-contract missing",
    })).toBe(PRODUCT_HANDSHAKE_UNREADY);
    expect(productLaunchCopy({
      reasonCode: "assignee_required",
      reason: "job.assignedAgentId is required",
    })).toBe(PRODUCT_ASSIGNEE_REQUIRED);
    expect(productLaunchCopy({
      reasonCode: "ok",
      reason: "typed runtime capability handshake is not proven; TypeScript types and instance names are not evidence",
    })).toBe(PRODUCT_LAUNCH_READY);
    expect(productLaunchCopy({
      reasonCode: "ok",
      reason: "GET /api/v1/system/experimental_thread-spawn-contract",
    })).not.toBe(PRODUCT_LAUNCH_UNAVAILABLE);
    expect(technicalLaunchReason({
      reasonCode: "handshake_unready",
      reason: "GET /api/v1/system/experimental_thread-spawn-contract missing",
    })).toBe("GET /api/v1/system/experimental_thread-spawn-contract missing");
    expect(productPrepareLaunchNotice({
      handshakeReady: true,
      launched: { kind: "running" },
      reasonCode: "ok",
      reason: "verified bind applied",
    })).toBe(PRODUCT_LAUNCH_STARTED);
    expect(productPrepareLaunchNotice({
      handshakeReady: true,
      launched: { kind: "running" },
      reasonCode: "ok",
      reason: "verified bind applied",
    })).not.toBe(PRODUCT_LAUNCH_READY);
    expect(productInterpretNotice({
      publishedVerified: true,
      mayEnterReview: true,
      runFailed: false,
      reason: "mayEnterReview=true publishedVerified=true",
    })).toBe(PRODUCT_PUBLICATION_VERIFIED);
  });

  it("keeps reasonCode on readiness and prepare parse", () => {
    const readiness = parseIsolationReadiness({
      handshakeReady: false,
      executionAvailable: false,
      isolationReady: false,
      isolatedSpawnFields: false,
      sdkTypedSpawnReady: false,
      provenIsolationProviders: ["claude-code"],
      assignedProvider: null,
      launchAllowedForAssigned: false,
      reason: "job.assignedAgentId is required",
      reasonCode: "assignee_required",
    });
    expect(readiness?.reasonCode).toBe("assignee_required");
    const prepare = parsePrepareLaunch({
      handshakeReady: false,
      snapshotId: "snp_1",
      digest: "d".repeat(64),
      attemptId: "run_1",
      launched: null,
      reason: "typed runtime capability is not proven",
      reasonCode: "handshake_unready",
    });
    expect(prepare?.reasonCode).toBe("handshake_unready");
  });
});

/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgencyApi } from "../src/app/data/agency-api";
import { ANSWER_INCOMPLETE_NOTICE, answerWaitStorageKey, writePersistedAnswerWait } from "../src/app/data/answer-needs-input";
import { NEEDS_INPUT_COMMENT_HINT } from "../src/app/data/needs-input";
import { JobNeedsInputPanel } from "../src/app/prototype/job-needs-input";
import type { NeedsInputRecord } from "../src/shared/contracts";

const record: NeedsInputRecord = {
  waitId: "33333333-3333-4333-8333-333333333333",
  jobId: "job_2de115e5c5e8bd8b555a71a3",
  attemptId: "run_needsinput01",
  launchId: "11111111-1111-4111-8111-111111111111",
  threadId: "thr_needsinput01",
  requestId: "22222222-2222-4222-8222-222222222222",
  questions: [{
    id: "acceptance-conflict",
    text: "Какой acceptance выполнять: process или job?",
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
};

describe("JobNeedsInputPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders durable questions and does not send until every id is filled", async () => {
    const notices: string[] = [];
    const answer = vi.fn();
    const api = { answerNeedsInput: answer } as unknown as AgencyApi;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(JobNeedsInputPanel, {
        record,
        api,
        notice: (text) => { notices.push(text); },
        onChanged: () => undefined,
      }) as ReactNode);
    });
    const panel = container.querySelector('[data-testid="needs-input-panel"]');
    expect(panel?.textContent).toContain("Какой acceptance выполнять");
    // The owner sees plain words, not wait and thread ids.
    expect(panel?.textContent).not.toContain(record.waitId);
    expect(panel?.textContent).toContain("чат, откуда ставили задачу");
    expect(container.querySelector('[data-testid="needs-input-comment-hint"]')?.textContent).toBe(NEEDS_INPUT_COMMENT_HINT);
    await act(async () => {
      container.querySelector('[data-testid="needs-input-send"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(answer).not.toHaveBeenCalled();
    expect(notices).toContain(ANSWER_INCOMPLETE_NOTICE);
    await act(async () => { root.unmount(); });
  });

  it("unknown after reload keeps requestId and reconciles without a new send id", async () => {
    const requestId = "55555555-5555-4555-8555-555555555555";
    writePersistedAnswerWait({
      waitId: record.waitId,
      requestId,
      texts: { "acceptance-conflict": "process" },
      sendState: "unknown",
    });
    const answer = vi.fn(async (command: { requestId: string }) => ({
      ok: true as const,
      value: { sendState: "confirmed", waitId: record.waitId, turnActive: true },
    }));
    const api = {
      answerNeedsInput: answer,
      getJob: vi.fn(async () => ({
        ok: true as const,
        value: {
          job: { id: record.jobId, revision: 6, departmentId: "dep_aaaaaaaaaaaaaaaaaaaaaa", brief: "Brief", acceptance: "Accept" },
          needsInput: record,
        },
      })),
      getDepartment: vi.fn(async () => ({
        ok: true as const,
        value: { department: { processVersionId: "prc_aaaaaaaaaaaaaaaaaaaaaa" }, process: { instructions: "Do", acceptance: "Done" }, memberships: [] },
      })),
      getLaunch: vi.fn(async () => ({
        ok: true as const,
        value: { attemptId: record.attemptId, launchId: record.launchId, digest: "b".repeat(64) },
      })),
    } as unknown as AgencyApi;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(JobNeedsInputPanel, {
        record,
        api,
        notice: () => undefined,
        onChanged: () => undefined,
      }) as ReactNode);
    });
    expect(container.querySelector('[data-testid="needs-input-send"]')).toHaveProperty("disabled", true);
    expect((container.querySelector('[data-testid="needs-input-answer-acceptance-conflict"]') as HTMLTextAreaElement).value).toBe("process");
    const reconcile = container.querySelector('[data-testid="needs-input-reconcile"]') as HTMLButtonElement;
    expect(reconcile).toBeTruthy();
    await act(async () => {
      reconcile.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(answer).toHaveBeenCalledTimes(1);
    });
    expect(answer.mock.calls[0][0].requestId).toBe(requestId);
    sessionStorage.removeItem(answerWaitStorageKey(record.waitId));
    await act(async () => { root.unmount(); });
  });
});

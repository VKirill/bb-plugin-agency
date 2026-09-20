import { describe, expect, it } from "vitest";
import { runAgencyCli } from "../src/server/cli/run";
import {
  buildOwnerQuestionPayload,
  presentOwnerQuestionsForCli,
  splitQuestionChoices,
  type OpenOriginWait,
} from "../src/server/runtime/owner-question";

const PROCESS = "prc_00000001";
const JOB_A = "job_aaaaaaaaaaaa";
const JOB_B = "job_bbbbbbbbbbbb";

function wait(partial: Partial<OpenOriginWait> & Pick<OpenOriginWait, "waitId" | "jobId" | "jobKey">): OpenOriginWait {
  return {
    title: partial.title ?? partial.jobKey,
    attemptId: "runattempt_aaaaaaaa",
    launchId: "11111111-1111-4111-8111-111111111111",
    threadId: "thr_workerhidden01",
    questions: [
      {
        id: "q1",
        text: "Какой секрет подставить?",
        sourceRefs: [
          { kind: "process_acceptance", id: PROCESS },
          { kind: "job_acceptance", id: partial.jobId },
        ],
      },
    ],
    ...partial,
  };
}

describe("splitQuestionChoices", () => {
  it("reads A/B bullets out of the question text", () => {
    const split = splitQuestionChoices(
      [
        "Вход на getbb.app (пароль сюда не пишите)",
        "• A — положить логин в Env Catalog",
        "• B — сами войти в Chrome",
        "• C — вход не давать",
      ].join("\n"),
    );
    expect(split.prompt).toContain("getbb.app");
    expect(split.options.map((item) => item.label)).toEqual(["A", "B", "C"]);
    expect(split.options[0]?.description).toContain("Env Catalog");
  });

  it("keeps explicit choices from the report payload", () => {
    const split = splitQuestionChoices("Как войти?", [
      { id: "catalog", label: "A", description: "Env Catalog" },
      { id: "chrome", label: "B", description: "Chrome на Mini" },
    ]);
    expect(split.prompt).toBe("Как войти?");
    expect(split.options).toHaveLength(2);
    expect(split.options[0]?.id).toBe("catalog");
  });
});

describe("buildOwnerQuestionPayload", () => {
  it("merges the same wording across jobs into one click row", () => {
    const payload = buildOwnerQuestionPayload([
      wait({ waitId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", jobId: JOB_A, jobKey: "AG-83" }),
      wait({ waitId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", jobId: JOB_B, jobKey: "AG-84" }),
    ]);
    expect(payload?.jobs.map((job) => job.key)).toEqual(["AG-83", "AG-84"]);
    expect(payload?.items).toHaveLength(1);
    expect(payload?.items[0]?.targets).toHaveLength(2);
    expect(payload?.items[0]?.options).toEqual([]);
  });

  it("attaches overlay options by index to every wait with the same question count", () => {
    const payload = buildOwnerQuestionPayload(
      [
        wait({ waitId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", jobId: JOB_A, jobKey: "AG-83" }),
        wait({ waitId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", jobId: JOB_B, jobKey: "AG-84" }),
      ],
      [
        {
          header: "Вход",
          question: "Вход на getbb.app (пароль сюда не пишите)",
          options: [
            { label: "A", description: "Env Catalog GETBB_LOGIN" },
            { label: "B", description: "Сами войти в Chrome на Mini" },
            { label: "C", description: "Вход не давать" },
          ],
        },
      ],
    );
    expect(payload?.items).toHaveLength(1);
    expect(payload?.items[0]?.header).toBe("Вход");
    expect(payload?.items[0]?.options).toHaveLength(3);
    expect(payload?.items[0]?.targets.map((item) => item.waitId)).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ]);
  });
});

describe("job ask-owner CLI", () => {
  it("needs the calling thread", async () => {
    const result = await runAgencyCli(
      {
        status: () => ({
          phase: "runtime",
          execution: "requires_readiness",
          reason: "ok",
          inboxCount: 0,
        }),
        notify: () => {
          throw new Error("notify unused");
        },
        dispatch: async () => ({ ok: true }),
        askOwner: (input) => presentOwnerQuestionsForCli({} as never, input),
      },
      ["job", "ask-owner"],
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("calling BB thread");
  });
});

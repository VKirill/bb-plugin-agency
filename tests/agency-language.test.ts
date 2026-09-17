import { afterEach, describe, expect, it } from "vitest";
import { agencyLanguage, languageDirective, setAgencyLanguage } from "../src/server/i18n/language";
import { completionReminderText } from "../src/server/runtime/completion-reminder/service";
import { formatParentWakeText } from "../src/server/runtime/parent-wake/service";
import { reworkText } from "../src/server/runtime/rework/service";
import { runWatchText } from "../src/server/runtime/run-watch/service";
import { buildWorkerInstructions } from "../src/server/delegation/instructions";

afterEach(() => {
  setAgencyLanguage("ru");
});

describe("agency language", () => {
  it("defaults to Russian and accepts only ru or en", () => {
    expect(agencyLanguage()).toBe("ru");
    expect(setAgencyLanguage("de")).toBe("ru");
    expect(setAgencyLanguage("en")).toBe("en");
  });

  it("switches every system message to agents to English", () => {
    setAgencyLanguage("en");
    expect(completionReminderText("AG-3", "run_1", 1)).toContain("is not handed in");
    expect(runWatchText("stalled", "AG-3")).toContain("is stalled");
    expect(reworkText("AG-3", "Fix totals.", "ab".repeat(32), "7a3f0c52-8d1e-4d8e-9a55-0f4a3a6b1c11")).toContain("returned AG-3 for rework");
    expect(formatParentWakeText({ key: "AG-4", state: "done" }, "act_1")).toContain("Subtask closed");
    // Tokens that recovery looks for stay the same in both languages.
    expect(completionReminderText("AG-3", "run_1", 1)).toContain("agency.completionReminder:run_1:1");
  });

  it("tells workers which language to write in", () => {
    setAgencyLanguage("en");
    expect(languageDirective()).toContain("in English");
    setAgencyLanguage("ru");
    expect(languageDirective()).toContain("на русском");
    const text = buildWorkerInstructions({ jobId: "job_1", jobKey: "AG-1", title: "T", departmentName: "D", isLead: false, assigneeType: "executor", members: [] });
    expect(text).toContain("## Your role: executor of AG-1");
    expect(text).toContain("in Russian.");
    setAgencyLanguage("en");
    expect(buildWorkerInstructions({ jobId: "job_1", jobKey: "AG-1", title: "T", departmentName: "D", isLead: false, assigneeType: "executor", members: [] })).toContain("in English.");
    setAgencyLanguage("ru");
  });
});

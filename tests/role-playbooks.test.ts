import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openMigratedDatabase } from "../src/server/db";
import { buildWorkerInstructions, PLAYBOOK_LIMIT, type WorkerContext } from "../src/server/delegation/instructions";
import { listTemplates, saveTemplate } from "../src/server/templates/store";
import { PLAYBOOK_KEYS, defaultTemplates } from "../src/shared/templates";

const base = {
  jobId: "job_1",
  jobKey: "AG-7",
  title: "Задача",
  departmentName: "Разработка",
  members: [] as WorkerContext["members"],
};

describe("base role instructions", () => {
  it("ships one for every role type, in both languages", () => {
    for (const language of ["ru", "en"] as const) {
      for (const key of PLAYBOOK_KEYS) {
        const text = defaultTemplates(language)[key];
        expect(text.length, `${language}/${key}`).toBeGreaterThan(400);
        expect(text).toContain("#");
      }
    }
    // The English set stays English: an agent reads its own role layer without translation noise.
    for (const key of PLAYBOOK_KEYS) expect(defaultTemplates("en")[key]).not.toMatch(/[А-Яа-яЁё]/);
  });

  it("puts the owner's text under the role section for every role type", () => {
    const playbook = "## Порядок\n1. Сначала проверить входы.";
    for (const assigneeType of ["lead", "executor", "reviewer", "assistant"] as const) {
      const text = buildWorkerInstructions({ ...base, isLead: assigneeType === "lead", assigneeType, playbook });
      expect(text, assigneeType).toContain("Сначала проверить входы");
      // The role header still comes first: the playbook adds to the role, it does not replace it.
      expect(text.indexOf("## Your role")).toBeLessThan(text.indexOf("Сначала проверить входы"));
    }
  });

  it("gives an assistant their own role, not the executor's", () => {
    const assistant = buildWorkerInstructions({ ...base, isLead: false, assigneeType: "assistant" });
    expect(assistant).toContain("## Your role: assistant");
    expect(assistant).toContain("the decisions are theirs");
    expect(assistant).not.toContain("## Your role: executor");
  });

  it("works without a playbook and caps a huge one", () => {
    const without = buildWorkerInstructions({ ...base, isLead: false, assigneeType: "executor" });
    expect(without).toContain("## Your role: executor");
    const huge = buildWorkerInstructions({ ...base, isLead: false, assigneeType: "executor", playbook: "я".repeat(PLAYBOOK_LIMIT * 2) });
    expect(huge.length).toBeLessThan(PLAYBOOK_LIMIT * 2);
  });

  it("is owner-editable and resettable like any template", () => {
    const db = openMigratedDatabase(new Database(":memory:"));
    const now = "2026-09-18T00:00:00.000Z";
    const before = listTemplates(db).find((row) => row.key === "playbookExecutor")!;
    expect(before.custom).toBe(false);
    const saved = saveTemplate(db, { key: "playbookExecutor", expectedRevision: before.revision, text: "## Свой порядок\n1. Шаг." }, now);
    expect(saved.ok && saved.value.custom).toBe(true);
    const stored = listTemplates(db).find((row) => row.key === "playbookExecutor")!;
    expect(stored.text).toContain("Свой порядок");
    const reset = saveTemplate(db, { key: "playbookExecutor", expectedRevision: stored.revision, text: null }, now);
    expect(reset.ok && reset.value.custom).toBe(false);
  });
});

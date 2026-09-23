import { describe, expect, it } from "vitest";
import { DEPARTMENT_CHARTER_TEMPLATE, jobDescriptionKind, jobDescriptionTemplate } from "../src/app/data/instruction-templates";
import { charterAccepts } from "../src/server/delegation/instructions";

describe("instruction templates", () => {
  it("gives the department charter a «Принимаем» section that routing reads", () => {
    expect(charterAccepts(DEPARTMENT_CHARTER_TEMPLATE)).toBe("Тип задачи: признаки, пример");
  });

  it("picks the job description by role and keeps the return rule for executors", () => {
    expect(jobDescriptionKind("lead")).toBe("lead");
    expect(jobDescriptionKind("Руководитель SEO")).toBe("lead");
    expect(jobDescriptionKind("reviewer")).toBe("reviewer");
    expect(jobDescriptionKind("developer")).toBe("executor");
    expect(jobDescriptionTemplate("developer")).toContain("## Не мой пул — вернуть руководителю");
    expect(jobDescriptionTemplate("lead")).toContain("Сам анализирую");
    expect(jobDescriptionTemplate("lead")).toContain("production-реализацию поручаю сотрудникам");
  });
});

import { describe, expect, it } from "vitest";
import { projectAccessAllowed } from "../src/server/api/project-access";

/**
 * Паспорт и профили работ читаются в своём проекте. Раньше проверки не было вовсе: любой тред
 * мог прочитать паспорт чужого проекта, назвав его идентификатор.
 */

const projectOfJob = (jobId: string) => (jobId === "job_own" ? "proj_own" : jobId === "job_other" ? "proj_other" : null);

describe("доступ к проекту", () => {
  it("владелец без треда видит любой проект", () => {
    expect(projectAccessAllowed(null, "proj_own", projectOfJob)).toBe(true);
    expect(projectAccessAllowed(undefined, "proj_other", projectOfJob)).toBe(true);
  });

  it("сотрудник читает свой проект и не читает чужой", () => {
    expect(projectAccessAllowed({ jobId: "job_own" }, "proj_own", projectOfJob)).toBe(true);
    expect(projectAccessAllowed({ jobId: "job_own" }, "proj_other", projectOfJob)).toBe(false);
  });

  it("задача без папки не открывает ничего", () => {
    expect(projectAccessAllowed({ jobId: "job_lost" }, "proj_own", projectOfJob)).toBe(false);
  });

  it("запрос без проекта сужается не здесь, а вызовом", () => {
    expect(projectAccessAllowed({ jobId: "job_own" }, undefined, projectOfJob)).toBe(true);
  });
});

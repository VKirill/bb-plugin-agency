import { describe, expect, it } from "vitest";
import type { DemoRun } from "../src/app/prototype/data";
import { resolveRunRoute, runsForJob, seedRuns } from "../src/app/prototype/run-links";

const fixtures: DemoRun[] = [
  { id: "RUN-204", jobId: "AG-102", title: "Подготовка оффера", agent: "Анна", providerId: "codex", result: "Передан на проверку", project: "SelfyStudio", department: "Редакция", duration: "3 мин 42 с", summary: "Оффер" },
  { id: "RUN-205", jobId: "AG-103", title: "Прототип посадочной", agent: "Илья", providerId: "codex", result: "В работе", project: "SelfyStudio", department: "Дизайн", duration: "12 мин", summary: "Прототип" },
];

describe("demo job/run links", () => {
  it("selects each fixture job's own run", () => {
    expect(runsForJob("AG-102", fixtures).map(run => run.id)).toEqual(["RUN-204"]);
    expect(runsForJob("AG-103", fixtures).map(run => run.id)).toEqual(["RUN-205"]);
    expect(resolveRunRoute("RUN-204", fixtures)).toMatchObject({ kind: "detail", run: { id: "RUN-204", jobId: "AG-102" } });
    expect(resolveRunRoute("RUN-205", fixtures)).toMatchObject({ kind: "detail", run: { id: "RUN-205", jobId: "AG-103" } });
    expect(runsForJob("AG-103", fixtures)[0]?.id).not.toBe("RUN-204");
  });

  it("keeps UI seed to AG-102 → RUN-204 only", () => {
    expect(seedRuns.map(run => ({ id: run.id, jobId: run.jobId }))).toEqual([{ id: "RUN-204", jobId: "AG-102" }]);
    expect(runsForJob("AG-103")).toEqual([]);
    expect(resolveRunRoute("RUN-205")).toEqual({ kind: "missing" });
  });

  it("treats an unknown run id as missing", () => {
    expect(resolveRunRoute("RUN-999", fixtures)).toEqual({ kind: "missing" });
    expect(resolveRunRoute(undefined, fixtures)).toEqual({ kind: "list" });
  });
});

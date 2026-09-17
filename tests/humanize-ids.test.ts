import { describe, expect, it } from "vitest";
import { humanizeIds } from "../src/app/data/humanize-ids";

describe("names instead of technical ids", () => {
  const names = {
    agents: [{ id: "agt_a50f169377d8eebd6f37a36f", name: "Руководитель разработки" }],
    departments: [{ recordId: "dep_69b7bbdbe785dac5ce4985ab", name: "Разработка" }],
    projects: [{ recordId: "bnd_90cd6d03e53b79f5bcda610a", name: "BB-сервис" }],
    jobs: [{ id: "AG-7", recordId: "job_8c82d4f87f0bca9b9a990e25" }],
  };
  it("replaces known ids with names and keys", () => {
    expect(humanizeIds("Назначить agt_a50f169377d8eebd6f37a36f в dep_69b7bbdbe785dac5ce4985ab (bnd_90cd6d03e53b79f5bcda610a), вход job_8c82d4f87f0bca9b9a990e25.", names)).toBe(
      "Назначить Руководитель разработки в отдел «Разработка» (проект «BB-сервис»), вход AG-7.",
    );
  });
  it("keeps unknown ids and ids inside inline code", () => {
    expect(humanizeIds("agt_ffffffffffffffff и `agt_a50f169377d8eebd6f37a36f`", names)).toBe("agt_ffffffffffffffff и `agt_a50f169377d8eebd6f37a36f`");
  });
});

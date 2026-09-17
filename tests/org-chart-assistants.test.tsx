/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";

// The chart draws a provider mark for every person; the catalog is BB's, not the chart's business.
vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_useProviders: () => ({ providers: [] }),
  experimental_ProviderIcon: () => null,
}));

const { OrgChart } = await import("../src/app/prototype/org-chart");
import type { Agent, Group } from "../src/app/prototype/data";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (id: string, name: string, role: string): Agent =>
  ({ id, name, role, enabled: true, selection: { providerId: "claude-code", model: "claude-sonnet-5", reasoningLevel: "medium" }, skills: [], mcps: [], department: "Разработка" }) as unknown as Agent;

const agents = [
  agent("agt_lead", "Руководитель разработки", "Оркестратор конвейера"),
  agent("agt_coder", "Кодер", "Код по контракту"),
  agent("agt_reviewer", "Проверяющий кода", "Независимая проверка"),
  agent("agt_scout", "Разведчик кода", "Разведка по коду"),
  agent("agt_shared", "Общий помощник", "Сбор материала"),
];

const department = {
  id: "dep_1",
  name: "Разработка",
  lead: "agt_lead",
  members: ["agt_lead", "agt_coder", "agt_reviewer", "agt_scout", "agt_shared"],
  memberRoles: { agt_reviewer: "reviewer", agt_scout: "assistant", agt_shared: "assistant" },
  memberHelps: { agt_scout: "agt_coder" },
} as unknown as Group;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(OrgChart, {
      group: department,
      kind: "departments",
      agents,
      departments: [department],
      openAgent: () => undefined,
      openDepartment: () => undefined,
    }));
  });
  return host;
}

describe("OrgChart with assistants", () => {
  it("hangs an assistant under the employee they help, not beside them", async () => {
    const container = await mount();
    const branch = container.querySelector('[aria-label="Помощники сотрудника Кодер"]');
    expect(branch).toBeTruthy();
    expect(branch?.textContent).toContain("Разведчик кода");
    // The row under the lead holds the employees, not the helper of one of them.
    const row = container.querySelector('[aria-label="Подчинённые сотрудники"]')!;
    const topLevel = Array.from(row.children).map((node) => node.querySelector("button")?.textContent ?? "");
    expect(topLevel.join(" ")).toContain("Кодер");
    expect(topLevel.filter((text) => text.includes("Разведчик кода"))).toHaveLength(0);
    // A helper of nobody in particular stays in the row with everyone.
    expect(topLevel.join(" ")).toContain("Общий помощник");
  });
});

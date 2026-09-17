/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_WORK_RULES } from "../src/shared/contracts/work-rules";

const calls: { method: string; input: unknown }[] = [];
let stored: Record<string, unknown> = { reworkLimit: 2 };
let revision = 1;

const view = (scope: string) => ({
  scope,
  revision,
  stored,
  effective: { ...DEFAULT_WORK_RULES, reworkLimit: 5, ...stored },
  sources: { reworkLimit: scope === "agency" ? "agency" : Object.hasOwn(stored, "reworkLimit") ? "department" : "agency" },
});

const rpc = {
  call: async (method: string, input: { scope: string; rules?: Record<string, unknown> }) => {
    calls.push({ method, input });
    if (method === "listBudgets") return { ok: true, value: [] };
    if (method === "saveWorkRules") {
      stored = input.rules ?? {};
      revision += 1;
    }
    return { ok: true, value: view(input.scope) };
  },
};

vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: () => rpc }));

const { AGENCY_RULE_GROUPS, LIMIT_RULE_GROUP, WorkRulesEditor } = await import("../src/app/prototype/work-rules");

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  calls.length = 0;
  stored = { reworkLimit: 2 };
  revision = 1;
});

async function render(scope: string, inheritable: boolean) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const notice = vi.fn();
  await act(async () => {
    root!.render(createElement(WorkRulesEditor, { scope, inheritable, notice, groups: [...AGENCY_RULE_GROUPS, LIMIT_RULE_GROUP("отдела")] }));
  });
  return notice;
}

const input = (label: string) => host!.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
const button = (text: string) => Array.from(host!.querySelectorAll("button")).find((item) => item.textContent === text) as HTMLButtonElement;

function type(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("work rules editor", () => {
  it("shows the scope's own values and saves the full stored set with its revision", async () => {
    const notice = await render("department:dep_abc123", true);
    expect(input("Кругов доработки под одной задачей").value).toBe("2");
    expect(button("Сохранить правила").disabled).toBe(true);
    await act(async () => type(input("Кругов доработки под одной задачей"), "4"));
    expect(button("Сохранить правила").disabled).toBe(false);
    await act(async () => button("Сохранить правила").click());
    const save = calls.find((call) => call.method === "saveWorkRules");
    expect(save?.input).toMatchObject({ scope: "department:dep_abc123", expectedRevision: 1, rules: { reworkLimit: 4 } });
    expect((save?.input as { rules: unknown }).rules).toEqual({ reworkLimit: 4 });
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("Правила сохранены"));
  });

  it("locks inherited fields in a department until the person takes its own value", async () => {
    stored = {};
    await render("department:dep_abc123", true);
    expect(input("Кругов доработки под одной задачей").disabled).toBe(true);
    expect(host!.textContent).toContain("общее для Агентства: 5");
    const own = host!.querySelector('[aria-label="Кругов доработки под одной задачей: своё значение"]') as HTMLButtonElement;
    await act(async () => own.click());
    expect(input("Кругов доработки под одной задачей").disabled).toBe(false);
  });

  it("treats an empty limit as no limit on this level, not as an inherited value", async () => {
    stored = { budgetMonthlyUsd: 50 };
    await render("department:dep_abc123", true);
    expect(input("Бюджет в месяц").value).toBe("50");
    await act(async () => type(input("Бюджет в месяц"), ""));
    await act(async () => button("Сохранить правила").click());
    const save = calls.find((call) => call.method === "saveWorkRules");
    expect((save?.input as { rules: unknown }).rules).toEqual({});
  });
});

/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_WORK_RULES } from "../src/shared/contracts/work-rules";

const calls: { method: string; input: unknown }[] = [];
let stored: Record<string, unknown> = {};
let revision = 1;

const view = (scope: string) => ({
  scope,
  revision,
  stored,
  effective: { ...DEFAULT_WORK_RULES, ...stored },
  sources: Object.fromEntries(Object.keys(stored).map((key) => [key, scope === "agency" ? "agency" : "department"])),
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

const { AGENCY_RULE_GROUPS, WorkRulesEditor } = await import("../src/app/prototype/work-rules");

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  calls.length = 0;
  stored = {};
  revision = 1;
});

async function render() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const notice = vi.fn();
  await act(async () => {
    root!.render(createElement(WorkRulesEditor, { scope: "agency", inheritable: false, notice, groups: AGENCY_RULE_GROUPS }));
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

const STALE_LABELS = {
  staleHoursBlocked: "Напомнить о blocked через",
  staleHoursRunning: "Напомнить о running без попытки через",
  staleRepeatHours: "Повтор напоминания через",
  staleMaxAttempts: "Напоминаний до эскалации",
} as const;

describe("work rules UI — stale sweeper thresholds", () => {
  it("shows the four stale fields next to launch monitoring with defaults 1 / 1 / 24 / 3", async () => {
    await render();
    expect(host!.textContent).toContain("Зависшие задачи");
    expect(host!.textContent).toContain("Наблюдение за запуском");
    expect(input(STALE_LABELS.staleHoursBlocked).value).toBe("1");
    expect(input(STALE_LABELS.staleHoursRunning).value).toBe("1");
    expect(input(STALE_LABELS.staleRepeatHours).value).toBe("24");
    expect(input(STALE_LABELS.staleMaxAttempts).value).toBe("3");
  });

  it("saves 0 as off and rereads the stored zeros", async () => {
    const notice = await render();
    await act(async () => type(input(STALE_LABELS.staleHoursBlocked), "0"));
    await act(async () => type(input(STALE_LABELS.staleHoursRunning), "0"));
    await act(async () => type(input(STALE_LABELS.staleRepeatHours), "0"));
    await act(async () => type(input(STALE_LABELS.staleMaxAttempts), "0"));
    await act(async () => button("Сохранить правила").click());
    const save = calls.find((call) => call.method === "saveWorkRules");
    expect(save?.input).toMatchObject({
      scope: "agency",
      expectedRevision: 1,
      rules: {
        staleHoursBlocked: 0,
        staleHoursRunning: 0,
        staleRepeatHours: 0,
        staleMaxAttempts: 0,
      },
    });
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("Правила сохранены"));
    expect(input(STALE_LABELS.staleHoursBlocked).value).toBe("0");
    expect(input(STALE_LABELS.staleHoursRunning).value).toBe("0");
    expect(input(STALE_LABELS.staleRepeatHours).value).toBe("0");
    expect(input(STALE_LABELS.staleMaxAttempts).value).toBe("0");
  });
});

/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const kit = {
  departments: [
    { key: "development", name: "Разработка", purpose: "Работающий код.", agents: [{ key: "development-lead", name: "Руководитель разработки", role: "Руководитель отдела", roleType: "lead" }], installed: { departmentId: "dep_1", language: "ru" } },
    { key: "research", name: "Исследования и аналитика", purpose: "Проверенные ответы.", agents: [{ key: "analyst", name: "Аналитик", role: "Исследования", roleType: "executor" }], installed: null },
  ],
  translatable: 0,
  edited: 0,
};
const calls: [string, unknown][] = [];
const rpc = {
  call: async (method: string, input: unknown) => {
    calls.push([method, input]);
    if (method === "starterKit") return { ok: true, value: kit };
    if (method === "installStarterKit") return { ok: true, value: { installed: [{ key: "research", departmentId: "dep_2", agents: 1 }], skipped: [] } };
    if (method === "recordLifecycle") return { ok: true, value: { deletable: false, reason: "У отдела есть история задач (2): отправьте его в архив.", archivedAt: null } };
    return { ok: true, value: null };
  },
};
vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: () => rpc }));

const { StarterKitDialog, RecordLifecyclePanel } = await import("../src/app/prototype/organization-kit");

async function mount(render: () => ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(render()));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { container, root };
}

describe("starter departments dialog", () => {
  it("loads once even when the notice callback changes, and installs the chosen departments", async () => {
    const notices: string[] = [];
    let changed = 0;
    const { root } = await mount(() => createElement(StarterKitDialog, { open: true, onOpenChange: () => undefined, notice: (text: string) => notices.push(text), onChanged: () => (changed += 1) }));
    // A parent re-render passes a new notice function: the list must stay loaded.
    await act(async () => root.render(createElement(StarterKitDialog, { open: true, onOpenChange: () => undefined, notice: (text: string) => notices.push(text), onChanged: () => (changed += 1) })));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const dialog = document.querySelector('[data-testid="starter-kit"]')!;
    expect(dialog.textContent).toContain("Исследования и аналитика");
    expect(dialog.textContent).toContain("уже есть");
    expect(calls.filter(([method]) => method === "starterKit")).toHaveLength(1);
    await act(async () => (document.querySelector('[aria-label="Исследования и аналитика"]') as HTMLElement).click());
    const add = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Добавить отмеченные · 1") as HTMLButtonElement;
    await act(async () => add.click());
    expect(calls.find(([method]) => method === "installStarterKit")?.[1]).toEqual({ keys: ["research"], language: "ru" });
    expect(notices[0]).toContain("Добавлено отделов: 1.");
    expect(changed).toBe(1);
    await act(async () => root.unmount());
  });

  it("explains why a record with history cannot be deleted and offers the archive", async () => {
    const { container, root } = await mount(() =>
      createElement(RecordLifecyclePanel, { kind: "department", id: "dep_1", name: "Разработка", archived: false, notice: () => undefined, onArchive: async () => true, onRestore: async () => true, onDeleted: () => undefined }),
    );
    expect(container.textContent).toContain("Отправить в архив");
    expect(container.textContent).toContain("У отдела есть история задач (2)");
    const remove = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Удалить") as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    await act(async () => root.unmount());
  });
});

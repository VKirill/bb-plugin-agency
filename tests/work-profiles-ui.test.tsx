/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { WorkProfileView } from "../src/shared/rpc-contract";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let saved: unknown = null;
const profile: WorkProfileView = {
  id: "wp_1",
  bbProjectId: "proj_demo",
  key: "tg-post",
  title: "Пост в Telegram",
  triggers: ["пост в телеграм", "тг"],
  body: "Голос канала: от первого лица.",
  samples: [{ label: "AG-14", ref: "job:AG-14", note: "40 000 просмотров" }],
  acceptance: "Написано голосом канала.",
  revision: 2,
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-18T10:00:00.000Z",
};

const rpc = {
  call: async (method: string, input: unknown) => {
    if (method === "saveWorkProfile") {
      saved = input;
      return { ok: true, value: profile };
    }
    if (method === "deleteWorkProfile") return { ok: true, value: { removed: true } };
    return { ok: true, value: [profile] };
  },
};

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => rpc,
  experimental_useProviders: () => ({ providers: [] }),
  experimental_ProviderIcon: () => null,
}));

const { WorkProfilesPanel } = await import("../src/app/prototype/work-profiles");

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  saved = null;
});

async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(WorkProfilesPanel, { bbProjectId: "proj_demo", notice: () => undefined }));
  });
  return host;
}

function click(node: Element | null | undefined) {
  node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function typeInto(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("WorkProfilesPanel", () => {
  it("lists the project's profiles with their signs", async () => {
    const container = await mount();
    expect(container.textContent).toContain("Пост в Telegram");
    expect(container.textContent).toContain("tg-post");
    expect(container.textContent).toContain("пост в телеграм, тг");
  });

  it("opens a profile, keeps samples as fields and shows the employee's text", async () => {
    const container = await mount();
    await act(async () => { click(container.querySelector("tbody button")); });
    expect((container.querySelector('input[aria-label="Название эталона"]') as HTMLInputElement).value).toBe("AG-14");
    // Предпросмотр — ровно тот текст, который уедет в промпт.
    const preview = container.querySelector("details")!;
    expect(preview.textContent).toContain("Профиль работы проекта «Пост в Telegram» (tg-post)");
    expect(preview.textContent).toContain("Эталоны (одобрены владельцем");
    expect(preview.textContent).toContain("Дополнительно к критерию приёмки задачи");
  });

  it("adds a sample and saves trimmed lists", async () => {
    const container = await mount();
    await act(async () => { click(container.querySelector("tbody button")); });
    const add = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === "Добавить эталон")!;
    await act(async () => { click(add); });
    const labels = container.querySelectorAll('input[aria-label="Название эталона"]');
    const refs = container.querySelectorAll('input[aria-label="Ссылка на эталон"]');
    await act(async () => { typeInto(labels[1] as HTMLInputElement, " AG-31 "); });
    await act(async () => { typeInto(refs[1] as HTMLInputElement, "job:AG-31"); });
    const save = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === "Сохранить профиль")!;
    await act(async () => { click(save); });
    expect(saved).toMatchObject({
      bbProjectId: "proj_demo",
      key: "tg-post",
      expectedRevision: 2,
      triggers: ["пост в телеграм", "тг"],
      samples: [
        { label: "AG-14", ref: "job:AG-14", note: "40 000 просмотров" },
        { label: "AG-31", ref: "job:AG-31" },
      ],
    });
  });

  it("holds the save back until the key, the name and the text are there", async () => {
    const container = await mount();
    const add = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === "Добавить профиль")!;
    await act(async () => { click(add); });
    const save = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === "Сохранить профиль")!;
    expect(save.hasAttribute("disabled")).toBe(true);
    // Пустой черновик ещё и не показывает предпросмотр: показывать нечего.
    expect(container.querySelector("details")).toBeNull();
  });
});

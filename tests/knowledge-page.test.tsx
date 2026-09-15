/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { STAGE1_UNAVAILABLE } from "../src/app/data/runtime-unavailable";
import { KnowledgePage, type Material } from "../src/app/prototype/knowledge";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  Markdown: ({ content }: { content: string }) => content,
}));

const proposal: Material = {
  id: "mat_live",
  title: "Синтетика",
  scope: "Агентство",
  source: "QA",
  body: "Текст",
  status: "proposal",
};

describe("KnowledgePage live guard", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not open create form or mutate items on live add/edit/accept", async () => {
    const notices: string[] = [];
    let items: Material[] = [proposal];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(KnowledgePage, {
        items,
        setItems: (next) => { items = next; },
        scopes: ["Агентство"],
        live: true,
        notice: (text) => { notices.push(text); },
      }) as ReactNode);
    });
    expect(container.querySelector('[data-testid="knowledge-unavailable"]')?.textContent).toBe(STAGE1_UNAVAILABLE.knowledge);
    await act(async () => {
      container.querySelector('[data-testid="knowledge-add"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="knowledge-dialog"]')).toBeNull();
    expect(notices).toContain(STAGE1_UNAVAILABLE.knowledge);
    await act(async () => {
      Array.from(container.querySelectorAll("button")).find((node) => node.textContent === "Синтетика")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector('[data-testid="knowledge-edit"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="knowledge-dialog"]')).toBeNull();
    await act(async () => {
      container.querySelector('[data-testid="knowledge-accept"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(items[0]?.status).toBe("proposal");
    expect(notices.every((text) => text === STAGE1_UNAVAILABLE.knowledge)).toBe(true);
    await act(async () => { root.unmount(); });
  });

  it("keeps demo create in memory", async () => {
    let items: Material[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(KnowledgePage, {
        items,
        setItems: (next) => { items = next; },
        scopes: ["Агентство"],
        live: false,
        notice: () => undefined,
      }) as ReactNode);
    });
    await act(async () => {
      container.querySelector('[data-testid="knowledge-add"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.body.querySelector('[data-testid="knowledge-dialog"]')).toBeTruthy();
    await act(async () => { root.unmount(); });
  });
});

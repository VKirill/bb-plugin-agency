/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ComposerSessionBanner } from "../src/app/composer-session-banner";
import type { SessionPolicyView } from "../src/shared/contracts/session-policy";

const policy: SessionPolicyView = {
  effective: "pm",
  source: "agency",
  layers: { agency: "pm", project: "inherit", binding: "inherit", thread: "inherit" },
  bbProjectId: "proj_1",
  bindingId: null,
  threadId: "thr_1",
  connected: true,
};

let currentRoot: Root | undefined;

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRealtime: () => undefined,
  useBbContext: () => ({ projectId: "proj_1", threadId: "thr_1" }),
  useComposerView: () => ({
    scope: { kind: "thread", threadId: "thr_1" },
    layout: "expanded",
    draft: { text: "", isEmpty: true, attachmentCount: 0 },
    run: { isRunning: false, isSubmitting: false },
  }),
  useRpc: () => ({
    call: async (method: string) => {
      if (method === "getSessionPolicy") return { ok: true, value: policy };
      if (method === "saveSessionPolicy") return { ok: true, value: policy };
      throw new Error(`unknown rpc method ${method}`);
    },
  }),
}));

async function mountBanner() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  currentRoot = root;
  await act(async () => {
    root.render(createElement(ComposerSessionBanner) as ReactNode);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

describe("composer session mode control", () => {
  afterEach(async () => {
    if (currentRoot) {
      await act(async () => {
        currentRoot?.unmount();
      });
      currentRoot = undefined;
    }
    document.body.innerHTML = "";
  });

  it("opens a model-picker sheet from the Agency chip so the phone composer stays expanded", async () => {
    const container = await mountBanner();
    const trigger = await vi.waitFor(() => {
      const node = container.querySelector("[data-testid='agency-session-banner']");
      if (!node) throw new Error("missing banner");
      return node as HTMLButtonElement;
    });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      trigger.click();
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const menu = await vi.waitFor(() => {
      const node = document.querySelector("[data-testid='agency-session-menu']");
      if (!node) throw new Error("missing menu");
      return node;
    });
    expect(menu.textContent).toContain("По запросу");
    expect(menu.textContent).toContain("Сам сделает");
  });
});

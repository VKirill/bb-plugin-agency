/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ComposerSessionBanner } from "../src/app/composer-session-banner";
import type { SessionPolicyView } from "../src/shared/contracts/session-policy";

const basePolicy = (): SessionPolicyView => ({
  effective: "pm",
  source: "agency",
  layers: { agency: "pm", project: "inherit", binding: "inherit", thread: "inherit" },
  pending: "inherit",
  bbProjectId: "proj_1",
  bindingId: null,
  threadId: "thr_1",
  connected: true,
});

const harness = vi.hoisted(() => {
  const policy: SessionPolicyView = {
    effective: "pm",
    source: "agency",
    layers: { agency: "pm", project: "inherit", binding: "inherit", thread: "inherit" },
    pending: "inherit",
    bbProjectId: "proj_1",
    bindingId: null,
    threadId: "thr_1",
    connected: true,
  };
  return {
    scope: { kind: "thread" as "thread" | "new-thread", threadId: "thr_1", projectId: "proj_1" },
    bb: { projectId: "proj_1" as string | null, threadId: "thr_1" as string | null },
    policy,
    saves: [] as Array<{ scope?: string; scopeId?: string; mode?: string }>,
    gets: [] as Array<{ bbProjectId?: string; threadId?: string }>,
  };
});

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRealtime: () => undefined,
  useBbContext: () => harness.bb,
  useComposerView: () => ({
    scope: harness.scope.kind === "new-thread"
      ? { kind: "new-thread" as const, projectId: harness.scope.projectId }
      : { kind: "thread" as const, threadId: harness.scope.threadId },
    layout: "expanded",
    draft: { text: "", isEmpty: true, attachmentCount: 0 },
    run: { isRunning: false, isSubmitting: false },
  }),
  useRpc: () => ({
    call: async (method: string, input: Record<string, unknown>) => {
      if (method === "getSessionPolicy") {
        harness.gets.push(input);
        return { ok: true, value: harness.policy };
      }
      if (method === "saveSessionPolicy") {
        harness.saves.push(input);
        if (input.scope === "pending" && typeof input.mode === "string") {
          harness.policy = { ...harness.policy!, pending: input.mode as SessionPolicyView["pending"] };
        }
        if (input.scope === "thread" && typeof input.mode === "string") {
          harness.policy = {
            ...harness.policy!,
            effective: input.mode as SessionPolicyView["effective"],
            source: "thread",
            layers: { ...harness.policy!.layers, thread: input.mode as SessionPolicyView["layers"]["thread"] },
          };
        }
        return { ok: true, value: { scope: input.scope, scopeId: input.scopeId, mode: input.mode } };
      }
      throw new Error(`unknown rpc method ${method}`);
    },
  }),
}));

let currentRoot: Root | undefined;

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
    harness.scope = { kind: "thread", threadId: "thr_1", projectId: "proj_1" };
    harness.bb = { projectId: "proj_1", threadId: "thr_1" };
    harness.policy = basePolicy();
    harness.saves = [];
    harness.gets = [];
    sessionStorage.clear();
  });

  it("opens a model-picker sheet from the Agency chip so the phone composer stays expanded", async () => {
    harness.policy = basePolicy();
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

  it("in a new chat does not read the previous thread and switches the chip via a pending draft", async () => {
    harness.scope = { kind: "new-thread", threadId: "thr_1", projectId: "proj_1" };
    harness.bb = { projectId: "proj_1", threadId: "thr_stale" };
    harness.policy = { ...basePolicy(), threadId: null };
    const container = await mountBanner();
    expect(harness.gets.length).toBeGreaterThan(0);
    expect(harness.gets.every((input) => input.threadId == null)).toBe(true);
    const trigger = await vi.waitFor(() => {
      const node = container.querySelector("[data-testid='agency-session-banner']");
      if (!node) throw new Error("missing banner");
      return node as HTMLButtonElement;
    });
    expect(trigger.textContent).toContain("Агентство");
    await act(async () => {
      trigger.click();
    });
    const option = await vi.waitFor(() => {
      const node = Array.from(document.querySelectorAll("[data-testid='agency-session-menu'] [role='option']")).find((item) =>
        item.textContent?.includes("Сам сделает"),
      );
      if (!node) throw new Error("missing ordinary option");
      return node as HTMLButtonElement;
    });
    await act(async () => {
      option.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.saves).toEqual([expect.objectContaining({ scope: "pending", scopeId: "proj_1", mode: "ordinary" })]);
    expect(trigger.textContent).toContain("Сам сделает");
  });

  it("does not snap the chip back to Агентство when the new chat already has a thread id", async () => {
    harness.scope = { kind: "thread", threadId: "thr_new", projectId: "proj_1" };
    harness.bb = { projectId: "proj_1", threadId: "thr_new" };
    harness.policy = {
      ...basePolicy(),
      effective: "pm",
      source: "agency",
      pending: "ordinary",
      threadId: "thr_new",
      layers: { agency: "pm", project: "inherit", binding: "inherit", thread: "inherit" },
    };
    const container = await mountBanner();
    const trigger = await vi.waitFor(() => {
      const node = container.querySelector("[data-testid='agency-session-banner']");
      if (!node) throw new Error("missing banner");
      return node as HTMLButtonElement;
    });
    expect(trigger.textContent).toContain("Сам сделает");
    expect(trigger.textContent).not.toContain("Агентство");
  });

  it("keeps Сам сделает when GET still reports the project Agency default", async () => {
    sessionStorage.setItem(
      "agency.session.pending:proj_1",
      JSON.stringify({ mode: "ordinary", at: Date.now() }),
    );
    harness.scope = { kind: "new-thread", threadId: "thr_1", projectId: "proj_1" };
    harness.bb = { projectId: "proj_1", threadId: "thr_stale" };
    harness.policy = { ...basePolicy(), threadId: null, pending: "inherit", effective: "pm", source: "project" };
    const container = await mountBanner();
    const trigger = await vi.waitFor(() => {
      const node = container.querySelector("[data-testid='agency-session-banner']");
      if (!node) throw new Error("missing banner");
      return node as HTMLButtonElement;
    });
    expect(trigger.textContent).toContain("Сам сделает");
  });

  it("pins the new-chat draft onto the thread when BB allocates an id", async () => {
    sessionStorage.setItem(
      "agency.session.pending:proj_1",
      JSON.stringify({ mode: "ordinary", at: Date.now() }),
    );
    harness.scope = { kind: "thread", threadId: "thr_new", projectId: "proj_1" };
    harness.bb = { projectId: "proj_1", threadId: "thr_new" };
    harness.policy = { ...basePolicy(), threadId: "thr_new", pending: "inherit" };
    const container = await mountBanner();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.saves.some((row) => row.scope === "thread" && row.scopeId === "thr_new" && row.mode === "ordinary")).toBe(true);
    const trigger = container.querySelector("[data-testid='agency-session-banner']") as HTMLButtonElement;
    expect(trigger.textContent).toContain("Сам сделает");
  });
});

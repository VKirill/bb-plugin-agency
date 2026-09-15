/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgencySidebarAccessory } from "../src/app/sidebar-accessory";

type CountPayload = { available: true; inProgressJobCount: number } | { available: false };

const domainHandlers = new Set<() => void>();
let rpcImpl: () => CountPayload | Promise<CountPayload> = () => ({ available: false });
let currentRoot: Root | undefined;

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRealtime: (channel: string, handler: () => void) => {
    if (channel === "domain-changed") domainHandlers.add(handler);
  },
  useRealtimeConnectionState: () => "connected" as const,
  useRpc: () => ({
    call: async (method: string) => {
      if (method === "sidebarInProgressJobCount") return rpcImpl();
      throw new Error("unknown rpc method");
    },
  }),
}));

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountAccessory() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  currentRoot = root;
  await act(async () => {
    root.render(createElement(AgencySidebarAccessory) as ReactNode);
  });
  await flush();
  return { container, root };
}

async function emitDomainChanged() {
  await act(async () => {
    for (const handler of domainHandlers) handler();
  });
  await flush();
}

describe("Agency sidebar accessory", () => {
  afterEach(async () => {
    if (currentRoot) {
      await act(async () => {
        currentRoot?.unmount();
      });
      currentRoot = undefined;
    }
    domainHandlers.clear();
    rpcImpl = () => ({ available: false });
    document.body.innerHTML = "";
  });

  it("renders a plain N with title and aria-label, then refreshes on domain-changed", async () => {
    rpcImpl = () => ({ available: true, inProgressJobCount: 2 });
    const { container } = await mountAccessory();
    await vi.waitFor(() => {
      expect(container.textContent).toBe("2");
    });
    const first = container.querySelector("span");
    expect(first?.getAttribute("aria-label")).toBe("В работе: 2");
    expect(first?.getAttribute("title")).toBe("В работе: 2");

    rpcImpl = () => ({ available: true, inProgressJobCount: 3 });
    await emitDomainChanged();
    await vi.waitFor(() => {
      expect(container.textContent).toBe("3");
    });
    const next = container.querySelector("span");
    expect(next?.getAttribute("aria-label")).toBe("В работе: 3");
    expect(next?.getAttribute("title")).toBe("В работе: 3");
  });

  it("hides zero and unavailable instead of drawing 0", async () => {
    let calls = 0;
    rpcImpl = () => {
      calls += 1;
      return { available: true, inProgressJobCount: 0 };
    };
    const { container } = await mountAccessory();
    await vi.waitFor(() => {
      expect(calls).toBeGreaterThan(0);
    });
    expect(container.textContent).toBe("");
    expect(container.textContent).not.toContain("0");

    rpcImpl = () => ({ available: true, inProgressJobCount: 1 });
    await emitDomainChanged();
    await vi.waitFor(() => {
      expect(container.textContent).toBe("1");
    });

    rpcImpl = () => ({ available: false });
    await emitDomainChanged();
    await vi.waitFor(() => {
      expect(container.textContent).toBe("");
    });
    expect(container.textContent).not.toContain("0");
  });

  it("coalesces a burst of domain-changed into a trailing count", async () => {
    let calls = 0;
    let resolveFirst: ((result: { available: true; inProgressJobCount: number }) => void) | undefined;
    const first = new Promise<{ available: true; inProgressJobCount: number }>((resolve) => {
      resolveFirst = resolve;
    });
    rpcImpl = () => {
      calls += 1;
      return calls === 1 ? first : { available: true, inProgressJobCount: 4 };
    };
    const { container } = await mountAccessory();
    await vi.waitFor(() => {
      expect(calls).toBe(1);
    });
    await emitDomainChanged();
    await emitDomainChanged();
    expect(calls).toBe(1);

    await act(async () => {
      resolveFirst?.({ available: true, inProgressJobCount: 2 });
      await first;
    });
    await vi.waitFor(() => {
      expect(calls).toBe(2);
      expect(container.textContent).toBe("4");
    });
    expect(container.querySelector("span")?.getAttribute("aria-label")).toBe("В работе: 4");
  });
});

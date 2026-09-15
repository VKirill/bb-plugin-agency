/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JobWorkTimeline } from "../src/app/prototype/job-work-timeline";

const chats: Array<Record<string, unknown>> = [];

vi.mock("@get-bb/plugin-sdk/app", () => ({
  ThreadChat: (props: Record<string, unknown>) => {
    chats.push(props);
    return createElement("div", {
      "data-testid": "thread-chat",
      "data-thread": String(props.threadId ?? ""),
    });
  },
  useBbNavigate: () => ({ toThread: () => undefined }),
}));

async function mount(threadId: string | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement(JobWorkTimeline, { threadId }) as ReactNode);
  });
  return { container, root };
}

describe("JobWorkTimeline", () => {
  afterEach(() => {
    chats.length = 0;
    document.body.innerHTML = "";
  });

  it("mounts native timeline only with confirmed ThreadChat props", async () => {
    const { container, root } = await mount("thr_run_exact01");
    expect(container.querySelector('[data-testid="job-work-timeline"]')).toBeTruthy();
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.querySelector("summary")?.textContent).toBe("Подробности работы");
    expect(container.querySelector('[data-testid="job-work-timeline-frame"]')?.className).toMatch(/h-96/);
    expect(container.querySelector('[data-testid="thread-chat"]')?.getAttribute("data-thread")).toBe("thr_run_exact01");
    expect(chats).toHaveLength(1);
    expect(Object.keys(chats[0]!).sort()).toEqual(["layout", "threadId", "variant"]);
    expect(chats[0]).toMatchObject({
      threadId: "thr_run_exact01",
      variant: "timeline",
      layout: "contained",
    });
    expect(chats[0]).not.toHaveProperty("className");
    expect(chats[0]).not.toHaveProperty("hideReasoning");
    expect(chats[0]).not.toHaveProperty("showThinking");
    expect(chats[0]).not.toHaveProperty("leadingContent");
    await act(async () => { root.unmount(); });
  });

  it("does not mount ThreadChat without a thread", async () => {
    const { container, root } = await mount(null);
    expect(container.querySelector('[data-testid="job-work-timeline"]')).toBeNull();
    expect(chats).toHaveLength(0);
    await act(async () => { root.unmount(); });
  });

  it("remounts ThreadChat when the scoped thread changes", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(JobWorkTimeline, { threadId: "thr_one" }) as ReactNode);
    });
    await act(async () => {
      root.render(createElement(JobWorkTimeline, { threadId: "thr_two" }) as ReactNode);
    });
    expect(container.querySelector('[data-testid="thread-chat"]')?.getAttribute("data-thread")).toBe("thr_two");
    expect(chats.at(-1)?.threadId).toBe("thr_two");
    await act(async () => { root.unmount(); });
  });
});

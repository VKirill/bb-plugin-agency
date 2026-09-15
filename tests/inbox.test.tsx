/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { inboxDecisionJobs, inboxNeedsDecision } from "../src/app/data/inbox";
import { asUiState } from "../src/app/data/view-models";
import { InboxPage } from "../src/app/prototype/inbox";
import type { Job } from "../src/app/prototype/data";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_useProviders: () => ({ providers: [] }),
  experimental_ProviderIcon: () => null,
}));

function job(id: string, state: Job["state"], sourceState = state): Job {
  return {
    id,
    title: id,
    state,
    sourceState,
    project: "P",
    department: "D",
    agent: "A",
    priority: "Обычный",
    due: "",
    description: "d",
    comments: [],
  };
}

const review = job("AG-1601", "review");
const waiting = job("AG-1607", "waiting_input");
const running = job("AG-1606", "running");
const done = job("AG-1600", "done");

describe("inbox decisions", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps mapped waiting_input and includes it with review/blocked", () => {
    expect(asUiState("waiting_input")).toBe("waiting_input");
    expect(inboxNeedsDecision(waiting)).toBe(true);
    expect(inboxNeedsDecision(review)).toBe(true);
    expect(inboxNeedsDecision(running)).toBe(false);
    expect(inboxDecisionJobs([review, running, waiting, done]).map((item) => item.id)).toEqual(["AG-1601", "AG-1607"]);
  });

  it("opens waiting_input card without answer/resume or invented stdout", async () => {
    const opened: string[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(InboxPage, {
        jobs: [review, running, waiting, done],
        agents: [],
        readIds: [],
        setReadIds: () => undefined,
        go: (_section, id) => { if (id) opened.push(id); },
      }) as ReactNode);
    });
    expect(container.querySelector('[data-testid="inbox-row-AG-1607"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="inbox-row-AG-1606"]')).toBeNull();
    expect(container.textContent).toContain("Ждёт ответа");
    expect(container.textContent).not.toMatch(/Отправить ответ|Повторить ту же команду|stdout|resume/i);
    await act(async () => {
      container.querySelector('[data-testid="inbox-open-AG-1607"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(opened).toEqual(["AG-1607"]);
    expect(container.querySelector('[data-testid="inbox-action-AG-1607"]')?.textContent).toContain("Открыть");
    await act(async () => { root.unmount(); });
  });
});

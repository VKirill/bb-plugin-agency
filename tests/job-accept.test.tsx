/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgencyApi } from "../src/app/data/agency-api";
import { ACCEPT_AMBIGUOUS_NOTICE, ACCEPT_STALE_SELECTION_NOTICE } from "../src/app/data/job-lifecycle";
import { JobAcceptControls } from "../src/app/prototype/job-accept";
import type { Job, TaskFile } from "../src/app/prototype/data";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_useProviders: () => ({ providers: [] }),
  experimental_ProviderIcon: () => null,
}));

const hash = "c".repeat(64);
const files: TaskFile[] = [
  { id: "art_cccccccccccccccc", name: "one.md", size: 1, content: "", kind: "text", version: 1, hash },
  { id: "art_dddddddddddddddd", name: "two.md", size: 1, content: "", kind: "text", version: 2, hash: "d".repeat(64) },
];
const job: Job = {
  id: "AG-QA",
  recordId: "job_aaaaaaaaaaaaaaaaaaaaaaaa",
  revision: 3,
  title: "Review",
  state: "review",
  project: "P",
  department: "D",
  agent: "A",
  priority: "Обычный",
  due: "",
  description: "d",
  comments: [],
};

describe("JobAcceptControls", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("refuses accept without explicit version and does not call RPC", async () => {
    const notices: string[] = [];
    const accept = vi.fn();
    const api = { acceptArtifactVersion: accept, getJob: vi.fn(), transitionJob: vi.fn() } as unknown as AgencyApi;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(JobAcceptControls, {
        job,
        files,
        api,
        demoMode: false,
        notice: (text) => { notices.push(text); },
        onAccepted: () => undefined,
      }) as ReactNode);
    });
    const button = container.querySelector('[data-testid="accept-result"]') as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(accept).not.toHaveBeenCalled();
    expect(notices).toContain(ACCEPT_AMBIGUOUS_NOTICE);
    await act(async () => { root.unmount(); });
  });

  it("resets a v1 pin when the same artifact rerenders as v2", async () => {
    const notices: string[] = [];
    const accept = vi.fn();
    const api = { acceptArtifactVersion: accept, getJob: vi.fn(), transitionJob: vi.fn() } as unknown as AgencyApi;
    const v1: TaskFile = { id: "art_cccccccccccccccc", name: "one.md", size: 1, content: "", kind: "text", version: 1, hash };
    const v2: TaskFile = { ...v1, version: 2, hash: "e".repeat(64) };
    function Harness() {
      const [current, setCurrent] = useState([v1]);
      return createElement("div", null,
        createElement(JobAcceptControls, {
          job,
          files: current,
          api,
          demoMode: false,
          notice: (text) => { notices.push(text); },
          onAccepted: () => undefined,
        }),
        createElement("button", { "data-testid": "to-v2", type: "button", onClick: () => setCurrent([v2]) }, "to-v2"),
      );
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(Harness) as ReactNode);
    });
    await act(async () => {
      container.querySelector('[data-testid="accept-opt-1"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="accept-opt-1"]')?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      container.querySelector('[data-testid="to-v2"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="accept-opt-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="accept-opt-2"]')?.getAttribute("aria-pressed")).toBe("false");
    expect(notices).toContain(ACCEPT_STALE_SELECTION_NOTICE);
    await act(async () => {
      container.querySelector('[data-testid="accept-result"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(accept).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });

  it("offers id:version:hash from mapped getJob publish, not artifact id alone", async () => {
    const { mapJobFiles } = await import("../src/app/data/view-models");
    const files = mapJobFiles({
      artifacts: [{
        artifact: { id: "art_4a88eeed059f763ca58e3097", jobId: "job_aaaaaaaaaaaaaaaaaaaaaaaa" },
        versions: [{
          artifactId: "art_4a88eeed059f763ca58e3097",
          version: 1,
          hash: "ff643aa97d3e8a1dee12d535ea5da7d3f423b9eef66657e54dac8437da95a1ac",
          relativePath: "notes/qa-release-1608.md",
          size: 1885,
        }],
      }],
    });
    const notices: string[] = [];
    const accept = vi.fn();
    const api = { acceptArtifactVersion: accept, getJob: vi.fn(), transitionJob: vi.fn() } as unknown as AgencyApi;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(JobAcceptControls, {
        job,
        files,
        api,
        demoMode: false,
        notice: (text) => { notices.push(text); },
        onAccepted: () => undefined,
      }) as ReactNode);
    });
    const option = container.querySelector('[data-testid="accept-opt-1"]');
    expect(option?.textContent).toContain("qa-release-1608.md");
    expect(option?.textContent).toContain("v1");
    expect(option?.textContent).toContain("ff643aa9");
    await act(async () => { root.unmount(); });
  });
});

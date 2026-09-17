/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Job } from "../src/app/prototype/data";
import { JobDetail } from "../src/app/prototype/job-detail";

const rpc = vi.hoisted(() => {
  const version = (id: string, path: string, hash: string) => ({ artifactId: id, jobId: "job_07a30ab4973f2ade538b302c", version: 1, hostId: "host_one", relativePath: path, mime: "text/markdown", size: 10, hash, author: { kind: "run", runId: "run_70b86aaf4917a7628927a9eb" } });
  const detail = {
    activity: [
      { id: "act_a4d46bdf37567c53c86ea3c2", jobId: "job_07a30ab4973f2ade538b302c", actor: { kind: "system" }, kind: "artifact_accepted", causationId: null, timestamp: "2026-09-17T01:55:34.595Z", references: [{ type: "artifact", id: "art_87dd9c9fc0e7a6775177d739" }] },
    ],
    dependencies: [],
    artifacts: [
      { artifact: { id: "art_9ba019bb732644dec3200580", jobId: "job_07a30ab4973f2ade538b302c" }, versions: [version("art_9ba019bb732644dec3200580", ".agency/jobs/AG-2201/report.md", "a".repeat(64))] },
      { artifact: { id: "art_87dd9c9fc0e7a6775177d739", jobId: "job_07a30ab4973f2ade538b302c" }, versions: [version("art_87dd9c9fc0e7a6775177d739", "sandbox-passport.md", "b".repeat(64))] },
    ],
    needsInput: null,
  };
  return { call: async () => ({ ok: true, value: detail }) };
});

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRealtime: () => undefined,
  useBbNavigate: () => ({ toPluginPanel: () => undefined, experimental_openFilePreview: () => false }),
  useRpc: () => rpc,
  Markdown: () => null,
  ThreadChat: () => null,
  experimental_useProviders: () => ({ providers: [] }),
  experimental_ProviderIcon: () => null,
  experimental_ProviderModelPicker: () => null,
}));

vi.mock("../src/app/prototype/document-panel", () => ({
  documentSessionId: "session",
  registerDocumentTarget: () => undefined,
  publishDocument: () => undefined,
  useDocumentVisible: () => false,
}));

const agents = [
  { id: "agt_lead0001", name: "Руководитель программистов — Fable" },
  { id: "agt_review001", name: "Проверяющий — Opus" },
] as never[];

const projects = [{ id: "bnd_one", name: "BB-сервис · plugins · MAC Mini", hostName: "MAC Mini", members: ["dep_dev"] }];
const departments = [{ id: "dep_dev", name: "Программисты", members: ["agt_lead0001", "agt_review001"], lead: "agt_lead0001" }];

function makeJob(): Job {
  return {
    id: "AG-2201",
    title: "Создать калькулятор",
    state: "done",
    project: "BB-сервис",
    department: "Программисты",
    agent: "Руководитель программистов — Fable",
    assignedAgentId: "agt_lead0001",
    reviewerAgentIds: ["agt_review001"],
    bindingId: "bnd_one",
    departmentId: "dep_dev",
    priority: "Высокий",
    due: "",
    description: "Описание",
    comments: [],
  } as Job;
}

async function renderRail() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement(JobDetail, {
      agents,
      projects,
      departments,
      job: makeJob(),
      jobs: [makeJob()],
      update: () => undefined,
      addJob: () => undefined,
      openJob: () => undefined,
      back: () => undefined,
      notice: () => undefined,
      openRun: () => undefined,
      demoMode: false,
    }) as ReactNode);
  });
  return { container, root };
}

describe("JobDetail accepted result", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("leads a closed job with the accepted file, not the first published one", async () => {
    const { container, root } = await renderRail();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const stage = container.querySelector(".mt-4.flex.flex-wrap.gap-2");
    expect(stage?.textContent).toContain("sandbox-passport.md");
    expect(stage?.textContent).not.toContain("report.md");
    await act(async () => root.unmount());
  });
});

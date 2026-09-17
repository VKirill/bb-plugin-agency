/** @vitest-environment happy-dom */
import { describe, expect, it } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Job as JobRecord } from "../src/shared/contracts";
import { EMPTY_SNAPSHOT } from "../src/app/data/snapshot";
import { useArchivedJobs } from "../src/app/prototype/use-archived-job";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const record = (id: string, key: string, parentJobId: string | null): JobRecord => ({
  id, key, parentJobId,
  bindingId: "bnd_project01", departmentId: "dep_editorial", title: `Задача ${key}`, brief: "b", acceptance: "a",
  state: "done", assignedAgentId: null, priority: "normal", dueAt: null, closedAt: "2026-07-01T00:00:00.000Z",
  revision: 1, updatedAt: "2026-07-01T00:00:00.000Z",
} as JobRecord);

describe("useArchivedJobs", () => {
  it("reads the archive once for an unknown key and maps the tree", async () => {
    const calls: number[] = [];
    const api = {
      listArchivedJobs: async ({ offset }: { offset?: number }) => {
        calls.push(offset ?? 0);
        return { ok: true as const, value: { total: 2, jobs: [record("job_root", "AG-1", null), record("job_child", "AG-2", "job_root")] } };
      },
    };
    const seen: { keys: string[]; loading: boolean }[] = [];
    function Probe({ id }: { id: string }) {
      const result = useArchivedJobs(api, EMPTY_SNAPSHOT, id, true);
      seen.push({ keys: result.jobs.map((job) => `${job.id}<${job.parentId ?? ""}`), loading: result.loading });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe, { id: "AG-2" }) as ReactNode));
    await act(async () => root.render(createElement(Probe, { id: "AG-2" }) as ReactNode));
    expect(seen[0]?.loading).toBe(true);
    expect(seen.at(-1)).toEqual({ keys: ["AG-1<", "AG-2<AG-1"], loading: false });
    await act(async () => root.render(createElement(Probe, { id: "AG-404" }) as ReactNode));
    await act(async () => root.render(createElement(Probe, { id: "AG-404" }) as ReactNode));
    expect(calls).toEqual([0, 0]);
    expect(seen.at(-1)?.loading).toBe(false);
    await act(async () => root.unmount());
  });
});

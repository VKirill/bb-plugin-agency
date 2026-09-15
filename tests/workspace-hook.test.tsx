/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgencyApi } from "../src/app/data/agency-api";
import type { RpcCaller } from "../src/app/data/rpc-agency-api";
import { useAgencyWorkspace, WORKSPACE_REALTIME_POLL_MS } from "../src/app/data/use-workspace";
import type { WorkspaceSnapshot } from "../src/app/data/snapshot";

const emptySnapshot: WorkspaceSnapshot = {
  contractVersion: "agency.domain.stage1.v1",
  isolation: { catalogSkillsIsolated: false, catalogMcpIsolated: false, execution: "unavailable", reason: "closed" },
  bindings: [],
  departments: [],
  agents: [],
  jobs: [],
  counts: {},
  memberships: [],
  agentVersions: [],
  processVersions: [],
  projectDepartments: [],
  policies: [],
};

let domainChanged: ((payload: unknown) => void) | undefined;
let connectionState: "connected" | "connecting" | "reconnecting" = "connected";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRealtime: (channel: string, handler: (payload: unknown) => void) => {
    if (channel === "domain-changed") domainChanged = handler;
  },
  useRealtimeConnectionState: () => connectionState,
}));

function emptyCatalog() {
  return {
    ok: true as const,
    value: {
      projects: [],
      environments: [],
      policies: [],
      skills: [],
      mcps: [],
      skillDiscovery: "unavailable" as const,
      mcpDiscovery: "unavailable" as const,
    },
  };
}

function stubApi(onLoad: () => void, onCatalog?: () => void): AgencyApi {
  return {
    loadWorkspace: async () => {
      onLoad();
      return { status: "ready", snapshot: emptySnapshot };
    },
    listBbCatalog: async () => {
      onCatalog?.();
      return emptyCatalog();
    },
  } as unknown as AgencyApi;
}

function Probe({
  rpc,
  api,
  onTick,
}: {
  rpc: RpcCaller;
  api?: AgencyApi;
  onTick: (value: ReturnType<typeof useAgencyWorkspace>) => void;
}) {
  onTick(useAgencyWorkspace(rpc, api));
  return null;
}

async function mountHook(rpc: RpcCaller, api?: AgencyApi) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  let latest: ReturnType<typeof useAgencyWorkspace> | undefined;
  const render = async (nextRpc: RpcCaller, nextApi?: AgencyApi) => {
    await act(async () => {
      root.render(createElement(Probe, {
        rpc: nextRpc,
        api: nextApi,
        onTick: (value) => { latest = value; },
      }) as ReactNode);
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  await render(rpc, api);
  return {
    get current() { return latest; },
    rerender: (nextRpc = rpc, nextApi = api) => render(nextRpc, nextApi),
    emitDomainChanged: async () => {
      await act(async () => {
        domainChanged?.({});
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    unmount: async () => {
      await act(async () => { root.unmount(); });
    },
  };
}

describe("workspace hook reload", () => {
  afterEach(() => {
    domainChanged = undefined;
    connectionState = "connected";
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("does not loadWorkspace again on idle rerender, but realtime still reloads", async () => {
    let loads = 0;
    let catalogs = 0;
    const call = async () => ({ ok: true, value: emptySnapshot });
    const rpc: RpcCaller = { call };
    const api = stubApi(() => { loads += 1; }, () => { catalogs += 1; });
    const hook = await mountHook(rpc, api);
    expect(loads).toBe(1);
    expect(catalogs).toBe(1);
    expect(hook.current?.status).toBe("ready");

    await hook.rerender();
    await hook.rerender(rpc, api);
    expect(loads).toBe(1);
    expect(catalogs).toBe(1);

    await hook.emitDomainChanged();
    expect(loads).toBe(2);
    expect(catalogs).toBe(1);

    await act(async () => {
      hook.current?.setMessage("prepareLaunch: ответ сервера");
    });
    expect(hook.current?.message).toBe("prepareLaunch: ответ сервера");
    await hook.emitDomainChanged();
    expect(loads).toBe(3);
    expect(catalogs).toBe(1);
    expect(hook.current?.message).toBe("prepareLaunch: ответ сервера");

    await act(async () => {
      await hook.current?.reload();
    });
    expect(loads).toBe(4);
    expect(catalogs).toBe(2);
    expect(hook.current?.message).toBe("");
    await hook.unmount();
  });

  it("keeps last snapshot and persistable when a later reload fails", async () => {
    let loads = 0;
    const jobRow = {
      id: "job_0a48edefdeb5af6fea5f349c",
      key: "AG-1608",
      bindingId: "bnd_project01",
      departmentId: "dep_editorial",
      title: "QA",
      brief: "old",
      acceptance: "old",
      state: "backlog" as const,
      parentJobId: null,
      assignedAgentId: null,
      priority: "normal" as const,
      dueAt: null,
      revision: 1,
      updatedAt: "2026-09-14T00:00:00Z",
    };
    const readySnap: WorkspaceSnapshot = {
      ...emptySnapshot,
      jobs: [jobRow],
      bindings: [{
        id: "bnd_project01",
        bbProjectId: "proj",
        bbProjectName: "P",
        environmentName: "local",
        hostName: "mini",
        environmentId: "env",
        hostId: "host",
        canonicalRoot: "/tmp",
        policyVersionId: "pol_default1",
        sectionId: null,
        revision: 1,
        updatedAt: "2026-09-14T00:00:00Z",
      }],
      departments: [{
        id: "dep_editorial",
        name: "Редакция",
        leadAgentId: "agt_b1fe6a357a7e8736a896c649",
        processVersionId: "prc_editorial",
        revision: 1,
        updatedAt: "2026-09-14T00:00:00Z",
      }],
    };
    const api = {
      loadWorkspace: async () => {
        loads += 1;
        if (loads === 1) return { status: "ready" as const, snapshot: readySnap };
        return { status: "error" as const, message: "timeout" };
      },
      listBbCatalog: async () => emptyCatalog(),
    } as unknown as AgencyApi;
    const hook = await mountHook({ call: async () => ({ ok: true, value: emptySnapshot }) }, api);
    expect(hook.current?.status).toBe("ready");
    expect(hook.current?.persistable).toBe(true);
    expect(hook.current?.jobs.some((job) => job.id === "AG-1608")).toBe(true);
    await hook.emitDomainChanged();
    expect(loads).toBe(2);
    expect(hook.current?.status).toBe("ready");
    expect(hook.current?.persistable).toBe(true);
    expect(hook.current?.jobs.some((job) => job.id === "AG-1608")).toBe(true);
    expect(hook.current?.message).toBe("timeout");
    await hook.unmount();
  });

  it("coalesces a burst of domain-changed into one trailing snapshot", async () => {
    let loads = 0;
    let resolveFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const job = {
      id: "job_0a48edefdeb5af6fea5f349c",
      key: "AG-1608",
      bindingId: "bnd_project01",
      departmentId: "dep_editorial",
      title: "QA",
      brief: "old",
      acceptance: "old",
      state: "backlog" as const,
      parentJobId: null,
      assignedAgentId: null,
      priority: "normal" as const,
      dueAt: null,
      revision: 1,
      updatedAt: "2026-09-14T00:00:00Z",
    };
    const api = {
      loadWorkspace: async () => {
        loads += 1;
        if (loads === 1) await first;
        return {
          status: "ready" as const,
          snapshot: {
            ...emptySnapshot,
            jobs: [{ ...job, state: loads === 1 ? "backlog" : "running", revision: loads }],
          },
        };
      },
      listBbCatalog: async () => emptyCatalog(),
    } as unknown as AgencyApi;
    const hook = await mountHook({ call: async () => ({ ok: true, value: emptySnapshot }) }, api);
    await vi.waitFor(() => {
      expect(loads).toBe(1);
    });
    await hook.emitDomainChanged();
    await hook.emitDomainChanged();
    expect(loads).toBe(1);

    await act(async () => {
      resolveFirst?.();
      await first;
    });
    await vi.waitFor(() => {
      expect(loads).toBe(2);
      expect(hook.current?.jobs.some((item) => item.state === "running")).toBe(true);
    });
    expect(hook.current?.jobs.some((item) => item.state === "backlog")).toBe(false);
    await hook.unmount();
  });

  it("reloads when connection returns to connected from connecting or reconnecting", async () => {
    let loads = 0;
    const rpc: RpcCaller = { call: async () => ({ ok: true, value: emptySnapshot }) };
    connectionState = "connecting";
    const hook = await mountHook(rpc, stubApi(() => { loads += 1; }));
    expect(loads).toBe(1);

    connectionState = "connected";
    await hook.rerender();
    await vi.waitFor(() => {
      expect(loads).toBe(2);
    });

    connectionState = "reconnecting";
    await hook.rerender();
    expect(loads).toBe(2);

    connectionState = "connected";
    await hook.rerender();
    await vi.waitFor(() => {
      expect(loads).toBe(3);
    });
    await hook.unmount();
  });

  it("polls workspace without listing the catalog again", async () => {
    vi.useFakeTimers();
    let loads = 0;
    let catalogs = 0;
    const rpc: RpcCaller = { call: async () => ({ ok: true, value: emptySnapshot }) };
    const hook = await mountHook(rpc, stubApi(() => { loads += 1; }, () => { catalogs += 1; }));
    expect(loads).toBe(1);
    expect(catalogs).toBe(1);
    await act(async () => {
      hook.current?.setMessage("prepareLaunch: ответ сервера");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKSPACE_REALTIME_POLL_MS);
    });
    expect(loads).toBe(2);
    expect(catalogs).toBe(1);
    expect(hook.current?.message).toBe("prepareLaunch: ответ сервера");
    await hook.unmount();
  });

  it("drops a deferred API A snapshot after switching to API B", async () => {
    let resolveA: (() => void) | undefined;
    const pendingA = new Promise<void>((resolve) => {
      resolveA = resolve;
    });
    const snap = (title: string): WorkspaceSnapshot => ({
      ...emptySnapshot,
      jobs: [{
        id: "job_0a48edefdeb5af6fea5f349c",
        key: "AG-1608",
        bindingId: "bnd_project01",
        departmentId: "dep_editorial",
        title,
        brief: "old",
        acceptance: "old",
        state: "backlog",
        parentJobId: null,
        assignedAgentId: null,
        priority: "normal",
        dueAt: null,
        revision: 1,
        updatedAt: "2026-09-14T00:00:00Z",
      }],
    });
    let catalogs = 0;
    const apiA = {
      loadWorkspace: async () => {
        await pendingA;
        return { status: "ready" as const, snapshot: snap("from-A") };
      },
      listBbCatalog: async () => {
        catalogs += 1;
        return emptyCatalog();
      },
    } as unknown as AgencyApi;
    const apiB = {
      loadWorkspace: async () => ({ status: "ready" as const, snapshot: snap("from-B") }),
      listBbCatalog: async () => {
        catalogs += 1;
        return emptyCatalog();
      },
    } as unknown as AgencyApi;
    const rpc: RpcCaller = { call: async () => ({ ok: true, value: emptySnapshot }) };
    const hook = await mountHook(rpc, apiA);
    await hook.rerender(rpc, apiB);
    await act(async () => {
      resolveA?.();
      await pendingA;
    });
    await vi.waitFor(() => {
      expect(hook.current?.jobs.some((job) => job.title === "from-B")).toBe(true);
    });
    expect(hook.current?.jobs.some((job) => job.title === "from-A")).toBe(false);
    expect(catalogs).toBeGreaterThanOrEqual(1);
    await hook.unmount();
  });

  it("keeps the previous snapshot and notice when loadWorkspace throws", async () => {
    let loads = 0;
    const readySnap: WorkspaceSnapshot = {
      ...emptySnapshot,
      jobs: [{
        id: "job_0a48edefdeb5af6fea5f349c",
        key: "AG-1608",
        bindingId: "bnd_project01",
        departmentId: "dep_editorial",
        title: "QA",
        brief: "old",
        acceptance: "old",
        state: "backlog",
        parentJobId: null,
        assignedAgentId: null,
        priority: "normal",
        dueAt: null,
        revision: 1,
        updatedAt: "2026-09-14T00:00:00Z",
      }],
    };
    const api = {
      loadWorkspace: async () => {
        loads += 1;
        if (loads === 1) return { status: "ready" as const, snapshot: readySnap };
        throw new Error("socket down");
      },
      listBbCatalog: async () => emptyCatalog(),
    } as unknown as AgencyApi;
    const hook = await mountHook({ call: async () => ({ ok: true, value: emptySnapshot }) }, api);
    expect(hook.current?.jobs.some((job) => job.id === "AG-1608")).toBe(true);
    await act(async () => {
      hook.current?.setMessage("prepareLaunch: ответ сервера");
    });
    await hook.emitDomainChanged();
    await vi.waitFor(() => {
      expect(loads).toBe(2);
    });
    expect(hook.current?.status).toBe("ready");
    expect(hook.current?.persistable).toBe(true);
    expect(hook.current?.jobs.some((job) => job.id === "AG-1608")).toBe(true);
    expect(hook.current?.message).toBe("prepareLaunch: ответ сервера");
    await hook.unmount();
  });
});
